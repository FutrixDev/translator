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
(function() {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT;
  if (!ctx) return;
  const core = globalThis.CaptionCore;
  if (!core) return;

  const DELIMITER = '⟪⟫⟪⟫⟪⟫';
  const RETRY_COOLDOWN_MS = 8000;

  // 一次往前译多远。从前是「整条轨道，一次译完」——一小时的讲座在观众看到第二句
  // 之前就把全片发去了云端，而其中绝大多数他不会看到（他会跳、会关、会只听开头
  // 三分钟）。按播放头往前开一扇窗，窗随播放头走：看到哪里，译到哪里往前五分钟。
  const WINDOW_MS = 5 * 60 * 1000;
  // 「只看原文」那一档：屏幕上此刻一个译文字都没在用。仍然预译，但窗小得多——
  // 押的是「他可能马上切回双语」，而不是「他会把整片看完」。
  const NATIVE_WINDOW_MS = 30 * 1000;

  const state = {
    // `enabled` is the user's switch; `active` is whether a translating
    // provider is attached. They used to be the same thing, and that is why the
    // in-player button could not exist: with the feature off nothing watched
    // the page, so there was nowhere to draw the way to turn it on. Now the
    // watcher runs regardless and only the translating half is gated.
    enabled: false,
    active: false,
    provider: null,
    overlay: null,
    block: null,
    rawCues: [],
    cues: [],
    batches: [],
    cueCache: new Map(),
    pendingKeys: new Set(),
    failedUntil: new Map(),
    trackId: '',
    trackLang: '',
    trackLabel: '',
    dismissed: false,
    translating: false,
    lastTriggerMs: 0,
    // 「原字幕此刻是开着的吗」的上一次观察，和「别再替他开了」那道闩。
    // 两者的生命周期不同，见 syncNativeCaptions() / resetForVideo()。
    sawNativeOn: false,
    autoEnableBlocked: false,
    video: null,
    lastNowMs: 0,
    controlsTimer: null,
  };

  // Storage keys still say "youtube" because they are user data: this used to
  // be a YouTube-only feature, and renaming them would silently discard every
  // existing user's caption position, size and colours.
  function getSetting(key) {
    return (ctx.settings || {})[key];
  }

  /**
   * What is on screen, from the settings alone — which line shows, in which
   * order, and whether we draw at all. shared/caption-core.js owns the rule so
   * the options preview and the in-player menu resolve it the same way.
   */
  function currentDisplay() {
    return core.resolveCaptionDisplay(ctx.settings || {});
  }

  /**
   * 我们此刻往哪门语言译，**整码**，专作缓存键用。
   *
   * 和 getTargetLangBase() 的差别正是它存在的理由：zh-CN 和 zh-TW 的基码都是
   * zh，可它们是两套字。按基码做键，观众从简体切到繁体，已经译过的那些句子的键
   * 一个不变——整段视频继续放着简体，而且因为键「对」上了，它们永远不会被重译掉。
   */
  function getTargetLangKey() {
    const target = ctx.getEffectiveTargetLang ? ctx.getEffectiveTargetLang() : '';
    return String(target || '').trim().toLowerCase();
  }

  function getTargetLangBase() {
    const target = ctx.getEffectiveTargetLang ? ctx.getEffectiveTargetLang() : '';
    return core.getLangBase(target);
  }

  /**
   * 这条轨道本来就是目标语言，不必译。
   *
   * 现算，不记。记下来的那一版是在 ingestTrack() 里写的，而它一个视频只跑一次：
   * 观众看到一半把目标语言从英文换成中文，那条英文轨道的「不必译」就冻在那里，
   * 之后每一次 handleTimeUpdate() 都在这道早退上返回，整段视频再不会开译——除非
   * 播放器恰好重新交一次轨道进来。会变的答案不留副本，和 canEnableNativeCaptions
   * 是同一条。
   */
  function sameLanguage() {
    const trackBase = core.getLangBase(state.trackLang || '');
    const targetBase = getTargetLangBase();
    return !!(trackBase && targetBase && trackBase === targetBase);
  }

  function getVideoElement() {
    if (state.provider && state.provider.getVideo) return state.provider.getVideo();
    return document.querySelector('video');
  }

  // 「拿不准」在这里读作「没开」：读不出播放器的状态就不往它身上画。
  // 三种答案的由来见 provider 的 nativeCaptionsState()。
  function isCaptionsEnabled() {
    return !!state.provider && state.provider.nativeCaptionsState() === true;
  }

  function setNativeCaptionsHidden(hidden) {
    if (state.provider && state.provider.setNativeCaptionsHidden) {
      state.provider.setNativeCaptionsHidden(hidden);
    }
  }

  // ---------------------------------------------------------------- overlay
  function ensureOverlay() {
    const container = state.provider && state.provider.getOverlayHost
      ? state.provider.getOverlayHost()
      : null;
    if (!container) return null;
    if (state.overlay && container.contains(state.overlay)) {
      return state.overlay;
    }
    const overlay = document.createElement('div');
    overlay.id = 'ai-translator-caption-overlay';
    const block = document.createElement('div');
    block.className = 'ai-translator-caption-block';
    const original = document.createElement('div');
    original.className = 'ai-translator-caption-original';
    const line = document.createElement('div');
    line.className = 'ai-translator-caption-line';
    block.appendChild(original);
    block.appendChild(line);
    overlay.appendChild(block);
    container.appendChild(overlay);
    state.overlay = overlay;
    state.block = block;
    bindCaptionInteractions(block);
    applyCaptionLayout();
    applyCaptionDisplay();
    return overlay;
  }

  // Render the block. Which lines appear is the display mode's answer; the
  // text is always set with textContent — a caption is someone else's markup.
  function setOverlayContent(original, translation) {
    if (!state.overlay) return;
    const display = currentDisplay();
    const origEl = state.overlay.querySelector('.ai-translator-caption-original');
    const transEl = state.overlay.querySelector('.ai-translator-caption-line');
    if (origEl) {
      origEl.textContent = original || '';
      origEl.style.display = (display.showOriginal && original) ? '' : 'none';
    }
    if (transEl) {
      transEl.textContent = translation || '';
      transEl.style.display = (display.showTranslation && translation) ? '' : 'none';
    }
    // The backplate is one box behind both lines, so it has to know when there
    // is nothing behind it to draw — otherwise a gap between cues leaves an
    // empty grey slab sitting on the video.
    const block = state.overlay.querySelector('.ai-translator-caption-block');
    if (block) {
      const hasText = !!((display.showOriginal && original) || (display.showTranslation && translation));
      block.classList.toggle('ai-cap-empty', !hasText);
    }
  }

  /**
   * Order the two lines and place the block where the page's own captions sit.
   *
   * The order is a CSS `order`, not a DOM move: the block is dragged and
   * resized by handles that are its children, and rebuilding it under the
   * pointer would drop the drag. Where "the bottom" is comes from the provider
   * — a player's captions sit above its control bar, and only the provider
   * knows where that bar is or whether it is showing.
   */
  function applyCaptionDisplay() {
    if (!state.overlay) return;
    const display = currentDisplay();
    const origEl = state.overlay.querySelector('.ai-translator-caption-original');
    const transEl = state.overlay.querySelector('.ai-translator-caption-line');
    if (origEl) origEl.style.order = display.translationFirst ? '2' : '1';
    if (transEl) transEl.style.order = display.translationFirst ? '1' : '2';

    const anchor = state.provider && state.provider.getCaptionAnchor
      ? state.provider.getCaptionAnchor()
      : null;
    const bottomPct = anchor && Number.isFinite(anchor.bottomPct) ? anchor.bottomPct : 6;
    const liftPx = anchor && Number.isFinite(anchor.liftPx) ? anchor.liftPx : 0;
    state.overlay.style.setProperty('--ai-caption-bottom', `${bottomPct}%`);
    state.overlay.style.setProperty('--ai-caption-lift', `${liftPx}px`);
  }

  function setOverlayVisible(visible) {
    if (!state.overlay) return;
    state.overlay.style.display = visible ? 'flex' : 'none';
  }

  function hexToRgba(hex, alpha) {
    const h = String(hex || '').replace('#', '');
    if (h.length !== 6) return `rgba(8, 8, 8, ${alpha})`;
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    if ([r, g, b].some((n) => Number.isNaN(n))) return `rgba(8, 8, 8, ${alpha})`;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  // Apply the user's caption colors to the overlay via CSS variables.
  function applyCaptionStyle() {
    if (!state.overlay) return;
    const fg = getSetting('youtubeCaptionFontColor') || '#ffffff';
    const rawOpacity = getSetting('youtubeCaptionBgOpacity');
    const opacity = rawOpacity != null ? Number(rawOpacity) : 82;
    const alpha = Math.max(0, Math.min(1, (Number.isFinite(opacity) ? opacity : 82) / 100));
    const bg = hexToRgba(getSetting('youtubeCaptionBgColor') || '#080808', alpha);
    state.overlay.style.setProperty('--ai-caption-fg', fg);
    state.overlay.style.setProperty('--ai-caption-bg', bg);
  }

  // ---- draggable + wheel-resizable caption ----
  let layoutSaveTimer = null;

  function persistCaptionLayout(debounced) {
    const write = () => {
      try {
        chrome.storage.sync.set({
          youtubeCaptionPosXPct: ctx.settings.youtubeCaptionPosXPct,
          youtubeCaptionPosYPct: ctx.settings.youtubeCaptionPosYPct,
          youtubeCaptionWidthPct: ctx.settings.youtubeCaptionWidthPct,
          youtubeCaptionScale: ctx.settings.youtubeCaptionScale,
        });
      } catch (e) { /* extension context gone */ }
    };
    if (!debounced) {
      if (layoutSaveTimer) { clearTimeout(layoutSaveTimer); layoutSaveTimer = null; }
      write();
      return;
    }
    if (layoutSaveTimer) clearTimeout(layoutSaveTimer);
    layoutSaveTimer = setTimeout(() => { layoutSaveTimer = null; write(); }, 400);
  }

  // The overlay covers the whole host, so its own box is the reference frame for
  // position, width and font size — whether the host is a site's caption layer
  // or the box we pin over a bare <video>.
  function getCaptionFrame() {
    return state.overlay;
  }

  // Apply the user's saved caption position, width and scale. Position and width
  // are percentages of the video box, so they survive resize/fullscreen; the
  // scale is a CSS variable that multiplies the font size.
  function applyCaptionLayout() {
    if (!state.overlay) return;
    const scale = Number(getSetting('youtubeCaptionScale'));
    state.overlay.style.setProperty('--ai-caption-scale', String(Number.isFinite(scale) && scale > 0 ? scale : 1));
    // 1% of the video's height, in px. Caption text is sized against the video
    // rather than the viewport alone, so a small embedded player doesn't get
    // captions scaled for a full-screen one. See content.css.
    const frameHeight = state.overlay.getBoundingClientRect().height;
    if (frameHeight > 0) {
      state.overlay.style.setProperty('--ai-caption-unit', `${frameHeight / 100}px`);
    }
    const block = state.block || state.overlay.querySelector('.ai-translator-caption-block');
    if (!block) return;
    const x = getSetting('youtubeCaptionPosXPct');
    const y = getSetting('youtubeCaptionPosYPct');
    // Untouched, the block sits where the page's own captions do (see
    // applyCaptionDisplay). A viewer who has dragged it once has said where
    // they want it, and that wins for good — including over the control bar
    // lift, which would otherwise shove their position around.
    const placed = typeof x === 'number' && typeof y === 'number';
    block.classList.toggle('ai-cap-anchored', !placed);
    if (placed) {
      block.style.left = `${x}%`;
      block.style.top = `${y}%`;
    } else {
      block.style.left = '';
      block.style.top = '';
    }
    const w = getSetting('youtubeCaptionWidthPct');
    if (typeof w === 'number') {
      block.style.width = `${w}%`;
      block.style.maxWidth = 'none';
    } else {
      block.style.width = '';
      block.style.maxWidth = '';
    }
  }

  function captionCenter(block, container) {
    const cRect = container.getBoundingClientRect();
    const bRect = block.getBoundingClientRect();
    return {
      cRect,
      cx: bRect.left + bRect.width / 2,
      cy: bRect.top + bRect.height / 2,
      halfH: Math.max(1, bRect.height / 2),
    };
  }

  // Resize the box symmetrically around its centre. Horizontal handles change the
  // width; vertical handles change the font scale; corners do both.
  function bindResizeHandle(handle, block, axes, getContainer) {
    let ctr = null;
    let startScale = 1;

    function onMove(e) {
      if (!ctr || !ctr.cRect.width || !ctr.cRect.height) return;
      e.preventDefault();
      if (axes.indexOf('x') !== -1) {
        const halfW = Math.abs(e.clientX - ctr.cx);
        let wpct = (halfW * 2 / ctr.cRect.width) * 100;
        wpct = Math.max(15, Math.min(96, wpct));
        ctx.settings.youtubeCaptionWidthPct = Math.round(wpct);
      }
      if (axes.indexOf('y') !== -1) {
        const halfH = Math.max(1, Math.abs(e.clientY - ctr.cy));
        let scale = startScale * (halfH / ctr.halfH);
        scale = Math.max(0.5, Math.min(3, scale));
        ctx.settings.youtubeCaptionScale = Math.round(scale * 100) / 100;
      }
      applyCaptionLayout();
    }

    function onUp() {
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('mouseup', onUp, true);
      persistCaptionLayout(false);
    }

    handle.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      const c = getContainer();
      if (!c) return;
      e.preventDefault();
      e.stopPropagation();
      ctr = captionCenter(block, c);
      startScale = Number(ctx.settings.youtubeCaptionScale) || 1;
      document.addEventListener('mousemove', onMove, true);
      document.addEventListener('mouseup', onUp, true);
    });
  }

  const CAPTION_HANDLES = [
    { pos: 'e', axes: 'x' },
    { pos: 'w', axes: 'x' },
    { pos: 'n', axes: 'y' },
    { pos: 's', axes: 'y' },
    { pos: 'ne', axes: 'xy', corner: true },
    { pos: 'nw', axes: 'xy', corner: true },
    { pos: 'se', axes: 'xy', corner: true },
    { pos: 'sw', axes: 'xy', corner: true },
  ];

  // Drag the body to move; drag edges/corners to resize; double-click to reset.
  function bindCaptionInteractions(block) {
    if (!block || block.__aiInteractive) return;
    block.__aiInteractive = true;

    const getContainer = getCaptionFrame;
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let startCx = 0;
    let startCy = 0;

    function onMove(e) {
      if (!dragging) return;
      const c = getContainer();
      if (!c) return;
      e.preventDefault();
      const rect = c.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      let cx = startCx + (e.clientX - startX);
      let cy = startCy + (e.clientY - startY);
      cx = Math.max(0, Math.min(rect.width, cx));
      cy = Math.max(0, Math.min(rect.height, cy));
      ctx.settings.youtubeCaptionPosXPct = (cx / rect.width) * 100;
      ctx.settings.youtubeCaptionPosYPct = (cy / rect.height) * 100;
      applyCaptionLayout();
    }

    function onUp() {
      if (!dragging) return;
      dragging = false;
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('mouseup', onUp, true);
      persistCaptionLayout(false);
    }

    // move (drag the caption body)
    block.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      const c = getContainer();
      if (!c) return;
      e.preventDefault();
      e.stopPropagation();
      dragging = true;
      const cRect = c.getBoundingClientRect();
      const bRect = block.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      startCx = (bRect.left + bRect.width / 2) - cRect.left;
      startCy = (bRect.top + bRect.height / 2) - cRect.top;
      document.addEventListener('mousemove', onMove, true);
      document.addEventListener('mouseup', onUp, true);
    });

    // resize handles (created lazily, one per edge/corner)
    for (const cfg of CAPTION_HANDLES) {
      const h = document.createElement('div');
      h.className = `ai-translator-caption-handle ai-cap-h-${cfg.pos}${cfg.corner ? ' ai-cap-corner' : ''}`;
      block.appendChild(h);
      bindResizeHandle(h, block, cfg.axes, getContainer);
    }

    // close button (top-right): dismiss captions for this video and stop translating
    const closeBtn = document.createElement('div');
    closeBtn.className = 'ai-translator-caption-close';
    closeBtn.textContent = '✕';
    closeBtn.setAttribute('role', 'button');
    const closeLabel = ctx.t ? ctx.t('closeCaption') : 'Close captions';
    closeBtn.setAttribute('aria-label', closeLabel);
    closeBtn.setAttribute('title', closeLabel);
    block.appendChild(closeBtn);
    closeBtn.addEventListener('mousedown', (e) => { e.stopPropagation(); });
    closeBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      state.dismissed = true;
      setOverlayVisible(false);
      setNativeCaptionsHidden(false);
    });

    // reset (double-click)
    block.addEventListener('dblclick', (e) => {
      e.preventDefault();
      e.stopPropagation();
      ctx.settings.youtubeCaptionPosXPct = null;
      ctx.settings.youtubeCaptionPosYPct = null;
      ctx.settings.youtubeCaptionWidthPct = null;
      ctx.settings.youtubeCaptionScale = 1;
      applyCaptionLayout();
      persistCaptionLayout(false);
    });
  }

  // ------------------------------------------------------------------- cues
  /**
   * 一句字幕在译文表里的身份。
   *
   * 键里带着目标语言，理由和带着轨道号是同一个：缓存里放的是**译文**，而同一句
   * 原文译成另一门语言是另一条内容。少了这一截，观众在看视频的中途把目标语言从
   * 中文换成日文，已经译过的那些句子的键一个不变，于是整段视频继续放着中文 ——
   * 而且因为键是对的，它们永远不会被重译掉。加上之后，换语言这件事不需要谁去清
   * 一张表：新语言天然是一套新键，旧的那一套还留在那里，换回去就是现成的。
   *
   * 用整码而不是基码，见 getTargetLangKey()：简体和繁体是同一个基码下的两套字。
   */
  function getCueKey(cue) {
    return `${getTargetLangKey()}|${state.trackId}|${cue.startMs}|${cue.text}`;
  }

  function clearTrack() {
    state.rawCues = [];
    state.cues = [];
    state.batches = [];
    state.cueCache.clear();
    state.pendingKeys.clear();
    state.failedUntil.clear();
  }

  function getActiveCue(nowMs) {
    return state.cues.find((cue) => nowMs >= cue.startMs && nowMs <= cue.endMs);
  }

  // ------------------------------------------------------------ translation
  /** 整页那一面的代次号。调度层没起来（它可以没起来）时是 0，两边都对不上就不比。 */
  function sessionVersion() {
    const auto = ctx.autoTranslate;
    if (!auto || !auto.state) return 0;
    const snap = auto.state();
    return snap && snap.sessionVersion || 0;
  }

  /**
   * translateCues 的第三种回答。
   *
   * true 这一批译好了；false 这一批没成（已经记了冷却，等下一次触发再来）；STALE
   * 这一批**过期**了——脚下的世界变了，它不作数，可这不是失败：新的那一套句子一
   * 个都还没译，而当时想去译它们的那一次调用（ingestTrack 的
   * ensureTrackTranslated(true)，或者换目标语言那一路的 handleTimeUpdate）正好撞
   * 上 state.translating 被这一批占着，什么也没做就回去了。把它当失败停下来，视
   * 频这时候要是停着，就再没有 timeupdate 来推第二次，新字幕会一直空着。
   */
  const STALE = 'stale';

  async function translateCues(cues) {
    if (sameLanguage() || !cues.length) return true;
    if (ctx.isExtensionContextAvailable && !ctx.isExtensionContextAvailable()) return false;

    // 发请求那一刻这批句子的键，和这一轮属于谁。
    //
    // 键必须在这里就取好：getCueKey() 读的是 state **此刻**的值，而 await 之下它
    // 会变——观众在播放器里换一门字幕语言（trackId 变），或者换了目标语言。回来时
    // 照当时的 state 重算一遍键，等于把上一门语言的译文写进新的那一套键里，画面上
    // 会出现上一轮译出来的句子，而且因为键是对的，它永远不会被重译掉。
    //
    // 拿旧键写回是无害的（新的那一套看不见它），拿旧键**放开** pendingKeys 则是
    // 必须的：那一套键就是当初记进去的那一套，不照它删，这几句会永远停在「正在
    // 译」上——isSegmentTranslatable() 认 pendingKeys。
    const keys = cues.map((cue) => getCueKey(cue));
    // 记「正在译」和放开它是同一件事的两头，所以两头都在这个函数里：调用方记、
    // 这里放，上面那两道 return 就是两个放不掉的口子。
    keys.forEach((key) => state.pendingKeys.add(key));
    const trackId = state.trackId;
    const version = sessionVersion();

    const texts = cues.map((cue) => cue.text);
    let response;
    let threw = false;
    try {
      response = await ctx.requestTranslation(core.buildTranslationRequest({
        texts,
        targetLang: ctx.getEffectiveTargetLang ? ctx.getEffectiveTargetLang() : '',
        trackLang: state.trackLang,
        delimiter: DELIMITER,
      }));
    } catch (error) {
      threw = true;
    }

    // 轨道或代次已经翻篇：这一批说的是另一回事了，丢掉——**不管它是成是败**。
    // 所以这一问排在看 response 之前：请求失败和世界变了是两件独立的事，一批过期
    // 的请求恰好也报了错（换目标语言时在飞的那一个多半如此），按失败处理就是记一
    // 笔谁也用不上的冷却、然后 return false 把整轮停在那里（见 STALE）。
    //
    // 丢之前要先按当初那一套键把 pendingKeys 放开。换轨道那一路 clearTrack() 确实
    // 已经连表带键清过一遍，换目标语言那一路却没有——applyCaptionSettings() 只重新
    // 渲染和重新调度，不碰这张表。不放开的话，这几句就卡在「正在译」上：既不重试
    // 也不显示，而且是**永远**，因为再没有谁会去动它们。
    if (trackId !== state.trackId || version !== sessionVersion()) {
      releaseBatch(keys);
      return STALE;
    }

    if (threw) {
      markBatchFailed(keys);
      return false;
    }

    if (!response || response.error || !Array.isArray(response.translations)) {
      markBatchFailed(keys);
      return false;
    }

    // 条数对不上就整批作废。上游两条路径今天都保证条数相等（AI 那条段数不等时自己
    // 退回编号法，内置那条逐条 push），所以这不是在修一个线上 bug——它防的是下标错
    // 位：短一条，尾部那几句会一直留在 pendingKeys 里，既不重试也不显示，而且
    // isSegmentTranslatable() 认 pendingKeys，它们从此对任何一轮都是「已经在译了」。
    if (response.translations.length !== cues.length) {
      markBatchFailed(keys);
      return false;
    }

    response.translations.forEach((translation, index) => {
      const cue = cues[index];
      if (!cue) return;
      const key = keys[index];
      state.cueCache.set(key, translation || cue.text);
      state.pendingKeys.delete(key);
      state.failedUntil.delete(key);
    });

    renderActiveCue(state.lastNowMs);
    return true;
  }

  /** 这一批没失败，只是过期了：不记冷却，只把「正在译」这个标记还回去。 */
  function releaseBatch(keys) {
    keys.forEach((key) => state.pendingKeys.delete(key));
  }

  // 键由调用方在发请求那一刻取好（见 translateCues）。
  //
  // 这里不再自己对一次 trackId：唯一的调用方在此之前已经答过「脚下的世界变了没
  // 有」，变了的那一批走的是 STALE 那条路，根本到不了这里。同一个问题留两个答案，
  // 迟早有一天它们说的不是一回事。
  function markBatchFailed(keys) {
    releaseBatch(keys);
    const retryAt = Date.now() + RETRY_COOLDOWN_MS;
    keys.forEach((key) => state.failedUntil.set(key, retryAt));
  }

  function isSegmentTranslatable(seg, wallNow) {
    const key = getCueKey(seg);
    if (state.cueCache.has(key) || state.pendingKeys.has(key)) return false;
    const retryAt = state.failedUntil.get(key);
    return !(retryAt && retryAt > wallNow);
  }

  /**
   * 这一句离播放头多远（毫秒），正在播的那一句是 0。
   *
   * 量的是**句子**，不是批次。批次只按条数和字数切（buildBatches），时间上想多长
   * 有多长：一段前面一句、一小时后一句的稀疏轨道，两句会落在同一批里，而这一批
   * 「离播放头最近的那一头」是 0 —— 按批次量距离，那一小时之外的一句就跟着进来
   * 了，窗等于没设。
   */
  function segmentDistance(seg, playheadMs) {
    if (playheadMs < seg.startMs) return seg.startMs - playheadMs;
    if (playheadMs > seg.endMs) return playheadMs - seg.endMs;
    return 0;
  }

  /**
   * 这一句在不在窗里。
   *
   * 窗是**花钱的闸**，不是「译哪一段」的规矩。所以不设窗的时候（内置引擎，而且不
   * 会回退到付费那条路）整条轨道都在窗里，播放头后面那些也算——加窗之前本来就是
   * 整条译到底，那一路一分钱不花，没有理由缩。
   *
   * 设了窗就只往前看。距离本身是对称的（seg 在播放头前后都算得出来），可拿它直接
   * 比上限，等于让播放头后面五分钟的句子和前面五分钟的句子抢同一份额度：实际宽度
   * 翻了一倍，而多出来的那一半全花在观众已经跳过去的内容上。倒回去看是另一回事
   * ——那时播放头自己就退回来了，这些句子重新排在它前面。
   */
  function withinWindow(seg, playheadMs, limitMs) {
    if (limitMs === Infinity) return true;
    if (seg.endMs < playheadMs) return false;
    return segmentDistance(seg, playheadMs) <= limitMs;
  }

  /**
   * 这一轮往前译多远（毫秒），Infinity = 不设限。
   *
   * 只有花钱的那条路需要设限。内置引擎是本机跑的，不联网、不计费，整条轨道一次
   * 译完的代价只是几十毫秒 CPU——给它设窗反而会让观众往回拖进度条时重译。
   *
   * 但**「选了内置引擎」不等于「这一批不花钱」**。isActive() 答的是「内置是选中
   * 的那个引擎，而且这个环境给得了」，它答不了「这门语言对此刻真能在本机跑」：
   * 语言包还没下到本地时 handleWithBuiltin() 抛 EngineUnavailableError，而
   * engineFallback === 'allow-ai' 的用户会把这一批原样转给他自己的接口（见
   * content-translation-engine.js 的 requestTranslation）。于是一场两小时的讲座
   * 在他看到第二句之前就整片发去了云端——正是这个窗存在的理由。
   *
   * 所以不设限的条件多一条：回退关着。那时内置跑不起来就是报错，一个字也不会发
   * 出去，Infinity 确实不花钱。反过来，回退开着而包其实就在本地，会白设一个窗，
   * 代价只是译文晚一点点到（本机译本来就快）——比前一种便宜得多。
   */
  function translationWindowMs() {
    const builtin = ctx.builtinTranslator;
    const free = builtin && builtin.isActive && builtin.isActive()
      && getSetting('engineFallback') !== 'allow-ai';
    if (free) return Infinity;
    return currentDisplay().useNative ? NATIVE_WINDOW_MS : WINDOW_MS;
  }

  // Pick the batch nearest the playhead that still has translatable segments, so
  // what the viewer is watching translates first while the rest fills in ahead
  // of him. Batches past `limitMs` from the playhead are left for later: the
  // window slides as he watches, and a seek re-centres it on the next trigger.
  function pickNextBatch(limitMs) {
    const wallNow = Date.now();
    const playhead = state.lastNowMs;
    let best = null;
    let bestDist = Infinity;
    for (const batch of state.batches) {
      // 窗按句子量，不按批次量（见 withinWindow）。一批里窗内窗外都有是常事，
      // 只把窗内那几句挑出来发；剩下的等窗滑过去再说，下一次触发自然会取到。
      let dist = Infinity;
      const todo = [];
      for (const seg of batch) {
        if (!withinWindow(seg, playhead, limitMs)) continue;
        const segDist = segmentDistance(seg, playhead);
        if (!isSegmentTranslatable(seg, wallNow)) continue;
        todo.push(seg);
        if (segDist < dist) dist = segDist;
      }
      if (!todo.length) continue;
      if (dist >= bestDist) continue;
      bestDist = dist;
      best = todo;
    }
    return best;
  }

  // Translate ahead of the playhead, nearest first. Safe to call often: it
  // no-ops while a pass runs and briefly after a failed batch, and it stops at
  // the window's edge rather than at the end of the track — handleTimeUpdate
  // calls it again as the playhead advances, which is what moves the window.
  async function ensureTrackTranslated(force) {
    if (sameLanguage() || state.dismissed || state.translating) return;
    const now = Date.now();
    if (!force && now - state.lastTriggerMs < 2000) return;
    state.lastTriggerMs = now;
    state.translating = true;
    try {
      while (state.active && !sameLanguage() && !state.dismissed) {
        // 窗每一轮现算。一轮可以跑很久，而这中间观众可以把引擎从内置换成 AI ——
        // 取一次留着用，等于拿「上一个引擎不花钱」这个结论去放行下一个引擎的批次。
        const batch = pickNextBatch(translationWindowMs());
        if (!batch || !batch.length) break;
        const result = await translateCues(batch);
        // 过期不是失败：这一批不作数，可新世界里那些句子还等着，而想去译它们的那
        // 次调用早被 state.translating 挡回去了（见 STALE）。接着往下走——下一轮
        // pickNextBatch 取的已经是新的那一套。
        if (result === STALE) continue;
        if (!result) break; // cooldown set on the batch; a later trigger resumes it
      }
    } finally {
      state.translating = false;
    }
  }

  function renderActiveCue(nowMs) {
    if (!state.overlay) return;
    const cue = getActiveCue(nowMs);
    if (!cue) {
      setOverlayContent('', '');
      return;
    }
    // Original shows immediately; the translated line fills in once it is ready.
    setOverlayContent(cue.text, state.cueCache.get(getCueKey(cue)) || '');
  }

  // --------------------------------------------------------------- playback
  function ensureVideoListener() {
    const video = getVideoElement();
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

    if (state.dismissed || sameLanguage() || !isCaptionsEnabled()) {
      setOverlayVisible(false);
      setNativeCaptionsHidden(false);
      return;
    }

    // Providers that pin their own box over the video keep it on the video here.
    if (state.provider && state.provider.syncOverlayHost) state.provider.syncOverlayHost();

    const display = currentDisplay();
    if (display.useNative) {
      // "Original only": the page draws its own captions again and we draw
      // nothing. Translation below carries on regardless, so the moment the
      // viewer picks another mode the lines are already there.
      setOverlayVisible(false);
      setNativeCaptionsHidden(false);
    } else {
      ensureOverlay();
      applyCaptionStyle();
      applyCaptionLayout();
      applyCaptionDisplay();
      setOverlayVisible(true);
      setNativeCaptionsHidden(true);
    }

    const nowMs = Math.floor((state.video?.currentTime || 0) * 1000);
    state.lastNowMs = nowMs;
    renderActiveCue(nowMs);
    ensureTrackTranslated(!!force);
  }

  // ---------------------------------------------------- provider activation
  // Videos and their tracks appear late — after a click, after an SPA route
  // change, after the player attaches a track element. Capture-phase media
  // events catch every one of those without observing the whole document.
  const MEDIA_EVENTS = ['loadedmetadata', 'loadeddata', 'canplay', 'play'];
  let watching = false;

  function onMediaEvent(event) {
    const el = event.target;
    if (!el || el.tagName !== 'VIDEO') return;
    watchTrackList(el);
    if (!state.provider) {
      tryActivate();
      syncControls();
      return;
    }
    if (state.provider.onMediaChanged) state.provider.onMediaChanged(el);
    ensureVideoListener();
    syncControls();
  }

  function onTrackListEvent() {
    if (!state.provider) {
      tryActivate();
      syncControls();
      return;
    }
    if (state.provider.onMediaChanged) state.provider.onMediaChanged();
    syncControls();
  }

  // A <track> added after load, or an in-band track the player just created,
  // shows up here — video.textTracks is the only place that change is announced.
  function watchTrackList(video) {
    if (video.__aiCaptionTrackWatch) return;
    let list;
    try { list = video.textTracks; } catch (e) { return; }
    if (!list || !list.addEventListener) return;
    video.__aiCaptionTrackWatch = true;
    list.addEventListener('addtrack', onTrackListEvent);
    list.addEventListener('removetrack', onTrackListEvent);
    // Fires when a track's mode changes — i.e. the viewer picked a subtitle
    // language in the player's own control.
    list.addEventListener('change', onTrackListEvent);
  }

  function startWatching() {
    if (watching) return;
    watching = true;
    for (const type of MEDIA_EVENTS) {
      document.addEventListener(type, onMediaEvent, true);
    }
    for (const video of document.querySelectorAll('video')) watchTrackList(video);
    syncControls();
  }

  function stopWatching() {
    if (!watching) return;
    watching = false;
    stopControlsHeartbeat();
    for (const type of MEDIA_EVENTS) {
      document.removeEventListener(type, onMediaEvent, true);
    }
    // The per-video track-list listeners stay: they are keyed off
    // __aiCaptionTrackWatch, so removing them would only mean re-adding them if
    // the feature is switched back on, and while it is off they reach
    // tryActivate() and stop at the inactive state.
  }

  function tryActivate() {
    if (!state.active || state.provider) return false;
    const provider = core.selectProvider(ctx.captionProviders || []);
    if (!provider) return false;
    state.provider = provider;
    provider.attach(engineApi);
    return true;
  }

  // ------------------------------------------------------ in-player controls
  // The button is not part of translating: it has to be there when the feature
  // is off, because turning it on is what it is for. So it is driven from the
  // page's *candidate* provider — the one that says it could supply cues here —
  // rather than from an attached one.
  const CONTROLS_HEARTBEAT_MS = 1500;

  /** The provider whose player this is, attached or not. */
  function candidateProvider() {
    return state.provider || core.selectProvider(ctx.captionProviders || []);
  }

  // --------------------------------------------- turning the page's own on
  // 「没开原字幕的视频，替我把原字幕点开」。整轮自动化里只有这一件事**改动播放器
  // 自己的状态**，所以它有自己的开关（autoEnableCaptions，默认关），而且有一道只
  // 合不开的闩：见 syncNativeCaptions()。
  //
  // 闸门用的是 siteRefused 而不是「这个站点开着自动翻」。视频站点没上过内置
  // always 名单，整页那一面在那里的结论多半是 ask，siteAuto 永远是 false——拿它
  // 当闸门，这件事在它最该发生的地方一次也不会发生。要问的是「这个站点是不是被
  // 明令拒绝的」，那句话由 shared/site-rules.js 的 REFUSALS 定义。
  function autoEnableAllowed() {
    if (!state.active || state.dismissed) return false;
    if (!getSetting('autoEnableCaptions')) return false;
    if (state.autoEnableBlocked) return false;
    // 问不到那个结论，就当是拒绝。ctx.init 里字幕这一面排在自动翻译前面（见
    // content-bootstrap.js），所以第一次同步控件时 ctx.autoTranslate 还不存在 ——
    // 写成「问不到就放行」，那一下恰好落在总开关关着、或者站点在黑名单上的页面
    // 上，而它偏偏是整轮自动化里唯一会去动播放器的动作。等一拍不要紧：心跳 1.5
    // 秒一次，那时候调度层早就建起来了。
    const auto = ctx.autoTranslate;
    if (!auto || typeof auto.state !== 'function') return false;
    let snap = null;
    try {
      snap = auto.state();
    } catch (e) {
      return false; // 同上：说不准就不动
    }
    if (!snap || snap.siteRefused) return false;
    return true;
  }

  /**
   * 每个心跳看一眼原字幕开着没有，该开就开，该收手就永远收手。
   *
   * 那道闩是这件事的全部风险所在：观众自己去播放器里把字幕关掉了，我们下一个心跳
   * 又把它点回来——1.5 秒一次，他关不掉。所以**「看见开着」之后再「看见关了」，
   * 就再不自动开第二次**，而且不问是谁开的：他本来就开着、自己关掉，和我们开的、
   * 他关掉，在他眼里是同一件事。
   *
   * sawNativeOn 按视频清（resetForVideo），autoEnableBlocked 按会话留——换一个视频
   * 不算他改了主意，YouTube 自己也是这么记 CC 偏好的。要越过这道闩只有一条路：
   * 菜单里那一项「开启原字幕」，那是他自己按的（ctx.enableNativeCaptions）。
   */
  function syncNativeCaptions() {
    const provider = state.provider;
    if (!provider || !provider.nativeCaptionsState || !provider.enableNativeCaptions) return;
    let on = null;
    try {
      on = provider.nativeCaptionsState();
    } catch (e) {
      return; // 播放器还没搭起来，这一拍什么都不知道，就什么都不做
    }
    if (on === true) {
      state.sawNativeOn = true;
      return;
    }
    // 「说不准」这一拍什么都不做。读成「关着」的代价是下面那道闩：它只要合上就是
    // 一整个会话，而那时观众什么都没做过——控制条晚一拍上来而已。读成「关着」去按
    // 也没有意义：按钮本来就还不在，按了也是按空。
    if (on !== false) return;
    if (state.sawNativeOn) {
      state.sawNativeOn = false;
      state.autoEnableBlocked = true;
      return;
    }
    if (!autoEnableAllowed()) return;
    try {
      // 按成了就**当场**记下「看见开着」。留给下一拍去记，中间这 1.5 秒里观众
      // 把它关掉，下一拍看见的是「关着，而且没落闩」—— 于是又替他开一次，这正
      // 是那道闩要防的事，只不过发生在它合上之前。
      //
      // 按了个空则什么都不记：控制条还没上来、或者这段视频根本没有字幕，都是每
      // 拍一次 querySelector 就能重新问出来的事（canEnableNativeCaptions），记
      // 下来只会让一个会变的答案冻在那里。
      if (provider.enableNativeCaptions()) state.sawNativeOn = true;
    } catch (e) { /* 播放器换了 DOM，下一拍再说 */ }
  }

  /**
   * 「开启原字幕」——菜单里那一项，观众自己按的。
   *
   * 和 syncNativeCaptions 的自动路径共用同一个 provider 方法，但越过闩、也越过
   * autoEnableCaptions 那个开关：他按了，就是他要。
   *
   * @returns {boolean} 有没有按到东西。false = 这段视频没有可开的字幕。
   */
  ctx.enableNativeCaptions = function() {
    const provider = state.provider || candidateProvider();
    if (!provider || !provider.enableNativeCaptions) return false;
    state.autoEnableBlocked = false;
    let answer = false;
    try {
      answer = provider.enableNativeCaptions();
    } catch (e) { /* 播放器换了 DOM，下一拍再说 */ }
    // 按成了就**当场**记下「看见开着」，和自动那一路一个道理，只是这里更不能省：
    // 下面紧接着就是 syncControls()，它会去问 nativeCaptionsState()，而 YouTube 的
    // enableNativeCaptions() 在 button.click() 之后直接答 true，不等 aria-pressed
    // 翻面。那一问要是恰好还读到 false，就落进自动那一路——闩刚被上一行解开、
    // autoEnableCaptions 又开着的话，它会再点一次，把观众刚要的字幕点回去。
    // 就算 aria-pressed 当场就翻了，这一行也还得在：不记的话闩永远合不上，观众在
    // 这 1.5 秒里把字幕关掉，下一拍看见的是「关着，而且没落闩」，照样替他开回来。
    //
    // 按空了则什么都不记。菜单那一行露不露，是 captionStatus() 每一拍现问
    // canEnableNativeCaptions() 问出来的：按钮 disabled 就不摆（那是 YouTube 在
    // 说这段视频没有字幕轨），按钮一旦活过来，那一行自己就回来了。
    if (answer) state.sawNativeOn = true;
    syncControls();
    return !!answer;
  };

  /** The menu's status line: which track we are on, or why there is none. */
  function captionStatus(provider) {
    // 原字幕开着没有。问的是**传进来的这个** provider，不是 isCaptionsEnabled()
    // （那读的是已接上的那个）：功能关着的时候按钮照样在（那正是它的用处），而那
    // 时 state.provider 是 null，拿它去问，一个原字幕开得好好的播放器也会被说成
    // 「还没点开」。默认当它开着——拿不准就不摆那个按钮，宁可少给一条路，不要给一
    // 条按了没反应的。
    let nativeOn = true;
    try {
      nativeOn = !provider || !provider.nativeCaptionsState
        || provider.nativeCaptionsState() !== false;
    } catch (e) { /* 播放器还没搭起来，下一拍再说 */ }

    // 原字幕是关着的。这不是「这段视频没有字幕」——那句话我们说不准——而是「原字幕
    // 还没点开」，菜单据此给的是一个按钮而不是一句死话。
    //
    // 这一问要排在轨道名前面，因为关掉它的那一下不会把上一轮留下的东西抹掉：
    // state.cues 还是满的，provider 手里可能还攥着那条轨道。屏幕上此刻一个字也没
    // 有（handleTimeUpdate 照同一个判断把浮层收了起来），这时报一句「字幕轨：
    // English」是在描述一件屏幕上不存在的事，而那个能把字幕找回来的按钮反倒被它
    // 挡住了——自动开启那一面还记着「是观众自己关的」，不会再替他点，这一行就是
    // 唯一的回头路。
    if (!nativeOn) {
      // 能不能点开，每一拍现问，从不记。按钮 disabled 是 YouTube 在说这段视频没
      // 有字幕轨，那就别摆一个按下去没反应的按钮；可它在播放器加载中也会 disabled
      // 一阵子，记下来就会把这一行藏到换视频为止，而观众再没有别的路回来。
      let canEnable = null;
      try {
        if (provider && provider.canEnableNativeCaptions) {
          canEnable = provider.canEnableNativeCaptions();
        }
      } catch (e) { /* 播放器换了 DOM，下一拍再说 */ }
      if (provider && provider.enableNativeCaptions && canEnable !== false) {
        return { kind: 'needs-native' };
      }
      return { kind: 'none' };
    }

    // 「本来就是目标语言」排在原字幕那一问**后面**。它描述的是这条轨道，而观众关
    // 掉字幕之后屏幕上没有轨道可言——报一句「已经是你要的语言」既没用，又正好把
    // 唯一那条回头路挡住了：自动开启那一面还记着「是他自己关的」，不会再替他点。
    // 和第 9 条（轨道名排在原字幕后面）是同一句话，只是往上又挪了一格。
    if (sameLanguage()) return { kind: 'same-language' };

    if (state.cues.length) return { kind: 'track', label: state.trackLabel || state.trackLang };
    let label = '';
    try {
      if (provider && provider.getTrackLabel) label = provider.getTrackLabel() || '';
    } catch (e) { /* a provider probing for DOM that is not there */ }
    if (label) return { kind: 'track', label };
    return { kind: 'none' };
  }

  /**
   * Put the button where this page's provider says it goes, or take it away.
   *
   * Cheap enough to call on a heartbeat, which is what keeps it attached to a
   * player that rebuilds its own control bar between videos.
   */
  function syncControls() {
    const controls = ctx.captionControls;
    if (!controls) return;
    // The heartbeat is what re-docks the button when the player rebuilds its
    // control bar, and a page can reach a video long after settings were
    // applied — YouTube home, then a click through to a watch page. Starting it
    // from here means every route that syncs the controls also keeps them
    // synced; stopWatching() is still the only thing that stops it.
    if (document.querySelector('video')) startControlsHeartbeat();
    // 心跳是替观众开原字幕唯一的驱动：原字幕关着的时候一条 cue 都不会来，
    // handleTimeUpdate 在 !state.cues.length 那一行就返回了，谁也不会问「要不要
    // 替他点开」。
    //
    // 它排在下面那道闸门**前面**，因为它和那个按钮是两件事：观众把播放器里的按
    // 钮藏了，说的是「别在控制条上摆你的图标」，不是「别替我开字幕」——他为后者
    // 专门开过另一个开关。搁在闸门后面，两个设置就被捆成了一个。
    syncNativeCaptions();
    if (getSetting('captionPlayerButton') === false) {
      controls.unmount();
      return;
    }
    // No provider means no subtitle track and no site we know — a bare <video>
    // in an ad or a page background, where an icon of ours would be litter.
    const provider = candidateProvider();
    if (!provider) {
      controls.unmount();
      return;
    }
    let host = null;
    let video = null;
    try {
      if (provider.getControlsHost) host = provider.getControlsHost();
    } catch (e) { /* the player's control bar is not up yet */ }
    try {
      video = provider.getVideo ? provider.getVideo() : document.querySelector('video');
    } catch (e) { /* keep null */ }
    controls.sync({ host, video, status: captionStatus(provider) });
  }

  function startControlsHeartbeat() {
    if (state.controlsTimer) return;
    state.controlsTimer = setInterval(syncControls, CONTROLS_HEARTBEAT_MS);
  }

  function stopControlsHeartbeat() {
    if (!state.controlsTimer) return;
    clearInterval(state.controlsTimer);
    state.controlsTimer = null;
  }

  // ------------------------------------------------- what providers call in
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
        clearTrack();
      }

      const merged = core.mergeRawCues(state.rawCues, cues, core.MAX_CUES);
      if (merged.added) {
        state.rawCues = merged.cues;
        state.cues = core.buildSegments(state.rawCues);
        state.batches = core.buildBatches(state.cues);
      }

      ensureVideoListener();
      handleTimeUpdate();
      syncControls();
      if (merged.added) ensureTrackTranslated(true);
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
    setNativeCaptionsHidden(false);
    clearTrack();
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
   * Watching is unconditional (see state.enabled): with the feature off the
   * engine still follows the page's videos, so the button is there to turn it
   * on. Only attaching a provider — the part that reads cues and calls the
   * translation API — is gated.
   */
  ctx.applyCaptionSettings = function() {
    state.enabled = !!getSetting('enableYoutubeCaptionTranslation');
    startWatching();
    if (state.enabled && !state.active) {
      state.active = true;
      // A provider may not be able to answer yet (no video, no track); the
      // watcher retries as the page brings one up.
      tryActivate();
    } else if (!state.enabled && state.active) {
      deactivate();
    }
    // Display type and position change what is on screen without touching the
    // pipeline: re-render the current cue rather than wait for the next frame.
    applyCaptionLayout();
    applyCaptionDisplay();
    renderActiveCue(state.lastNowMs);
    handleTimeUpdate(true);
    syncControls();
  };

  ctx.setupVideoCaptionTranslation = function() {
    ctx.applyCaptionSettings();
  };

  // Kept as the "feature off" path callers already use. It stops translating;
  // it does not stop watching, because the button has to survive it.
  ctx.stopVideoCaptionTranslation = function() {
    state.enabled = false;
    deactivate();
    syncControls();
  };
})();
