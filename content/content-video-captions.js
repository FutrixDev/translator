// Blab Translation — video subtitle translation.
//
// This is the site-independent engine. A caption *provider*
// (content/content-caption-providers.js) says whether it can supply cues on
// this page and hands them over; from there everything is the same everywhere:
// cues are merged into sentence-level segments, the whole track is translated
// nearest-to-playhead first, and the result is drawn as a bilingual line in a
// draggable, resizable overlay pinned over the video.
//
// The pure half of that — parsing, cue conversion, segmentation, batching,
// provider picking — lives in shared/caption-core.js so a provider and a unit
// test can both reach it.
//
// 这个引擎横跨五个文件：共用状态（content/captions/state.js）、字幕框（overlay.js）、
// 按播放头往前译（translate.js）、什么时候接管（activation.js），以及这里的心跳——
// 每一拍把「现在该显示什么」算出来，加上对外的三个入口和拆除。五份各自把要给别人用
// 的名字 Object.assign 到同一张架子 `ctx.captions` 上，取值发生在调用时；带 caps.
// 前缀的名字就是住在别处的。唯一认顺序的是 state.js，它必须排在最前（见那份顶上）。
(function() {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT;
  if (!ctx) return;
  const core = globalThis.CaptionCore;
  if (!core) return;
  // 这一族共用的架子（说明见本文件顶上）。
  const caps = (ctx.captions = ctx.captions || {});
  const state = caps.state;

  function ensureVideoListener() {
    const video = caps.getVideoElement();
    if (!video || video === state.video) return;
    if (state.video) state.video.removeEventListener('timeupdate', onVideoTimeUpdate);
    state.video = video;
    video.addEventListener('timeupdate', onVideoTimeUpdate);
  }

  // 事件对象不能当 force 用：addEventListener 传进来的那个 Event 一概是真的。
  function onVideoTimeUpdate() {
    handleTimeUpdate();
  }

  /**
   * @param {boolean} [force] 越过 ensureTrackTranslated 的 2 秒节流。设置改动走
   *   这一路：视频停着的时候没有 timeupdate 来推第二次，被节流挡掉就是不开译。
   */
  async function handleTimeUpdate(force) {
    if (!state.active || !state.cues.length) return;

    if (state.dismissed || caps.sameLanguage() || !caps.isCaptionsEnabled()) {
      caps.setOverlayVisible(false);
      caps.setNativeCaptionsHidden(false);
      return;
    }

    // Providers that pin their own box over the video keep it on the video here.
    if (state.provider && state.provider.syncOverlayHost) state.provider.syncOverlayHost();

    const display = caps.currentDisplay();
    if (display.useNative) {
      // "Original only": the page draws its own captions again and we draw
      // nothing. Translation below carries on regardless, so the moment the
      // viewer picks another mode the lines are already there.
      caps.setOverlayVisible(false);
      caps.setNativeCaptionsHidden(false);
    } else {
      caps.ensureOverlay();
      caps.applyCaptionStyle();
      caps.applyCaptionLayout();
      caps.applyCaptionDisplay();
      caps.setOverlayVisible(true);
      caps.setNativeCaptionsHidden(true);
    }

    const nowMs = Math.floor((state.video?.currentTime || 0) * 1000);
    state.lastNowMs = nowMs;
    caps.renderActiveCue(nowMs);
    caps.ensureTrackTranslated(!!force);
  }

  // ---------------------------------------------------- provider activation
  // Videos and their tracks appear late — after a click, after an SPA route
  // change, after the player attaches a track element. Capture-phase media
  // events catch every one of those without observing the whole document.

  const engineApi = {
    /**
     * Hand over a track's cues. Providers re-offer the whole track rather than
     * a delta; a different trackId means the caption language changed, which
     * starts a fresh cue set.
     */
    ingestTrack(track) {
      if (!state.active || !track) return;
      const cues = Array.isArray(track.cues) ? track.cues : [];
      if (!cues.length) return;
      const trackId = track.trackId || 'track';
      if (trackId !== state.trackId) {
        state.trackId = trackId;
        state.trackLang = track.lang || '';
        state.trackLabel = track.label || track.lang || '';
        caps.clearTrack();
      }

      const merged = core.mergeRawCues(state.rawCues, cues, core.MAX_CUES);
      if (merged.added) {
        state.rawCues = merged.cues;
        state.cues = core.buildSegments(state.rawCues);
        state.batches = core.buildBatches(state.cues);
      }

      ensureVideoListener();
      handleTimeUpdate();
      caps.syncControls();
      if (merged.added) caps.ensureTrackTranslated(true);
    },

    /** Same page, different video (an SPA route change). */
    reset() {
      resetForVideo();
    },

    isActive() {
      return state.active;
    },
  };

  // -------------------------------------------------------------- lifecycle
  function resetForVideo() {
    caps.setNativeCaptionsHidden(false);
    caps.clearTrack();
    state.trackId = '';
    state.trackLang = '';
    state.trackLabel = '';
    state.dismissed = false;
    state.translating = false;
    // 换一个视频＝重新观察一次。播放器在 SPA 跳转中会把整个字幕层拆掉重建，
    // 不清的话那一瞬的「不见了」会被读成「他关掉了」，闩就白落了。
    // autoEnableBlocked 刻意不清：那是他的意思，整个会话都算数。
    state.sawNativeOn = false;
    state.lastTriggerMs = 0;
    state.lastNowMs = 0;
    if (state.video) {
      state.video.removeEventListener('timeupdate', onVideoTimeUpdate);
      state.video = null;
    }
    if (state.overlay) {
      state.overlay.remove();
      state.overlay = null;
    }
    state.block = null;
  }

  /** Stop translating and give the page back everything we took from it. */
  function deactivate() {
    if (state.provider) {
      if (state.provider.detach) state.provider.detach();
      state.provider = null;
    }
    state.active = false;
    resetForVideo();
  }

  /**
   * The one entry point for "the settings changed" — the storage listener, the
   * popup's message, the in-player menu and startup all land here.
   *
   * Watching is unconditional (see state.enabled): with the gate shut the
   * engine still follows the page's videos, so the button is there to open it.
   * Only attaching a provider — the part that reads cues and calls the
   * translation API — is gated.
   */
  ctx.applyCaptionSettings = function() {
    state.enabled = !caps.siteRefused();
    state.siteAuto = caps.siteAuto();
    caps.startWatching();
    if (state.enabled && !state.active) {
      state.active = true;
      // A provider may not be able to answer yet (no video, no track); the
      // watcher retries as the page brings one up.
      caps.tryActivate();
    } else if (!state.enabled && state.active) {
      deactivate();
    }
    // Display type and position change what is on screen without touching the
    // pipeline: re-render the current cue rather than wait for the next frame.
    caps.applyCaptionLayout();
    caps.applyCaptionDisplay();
    caps.renderActiveCue(state.lastNowMs);
    handleTimeUpdate(true);
    caps.syncControls();
    // 最后一步：这时候 state.enabled 已经是对的，订阅那一下的立即回调就不会再
    // 多走一轮。
    caps.subscribeToGate();
  };

  ctx.setupVideoCaptionTranslation = function() {
    ctx.applyCaptionSettings();
  };

  // 别的文件要用的，都从这张架子上取。
  Object.assign(caps, {
    engineApi, ensureVideoListener,
  });
})();
