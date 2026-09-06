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
    skipTranslation: false,
    dismissed: false,
    translating: false,
    lastTriggerMs: 0,
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

  function getTargetLangBase() {
    const target = ctx.getEffectiveTargetLang ? ctx.getEffectiveTargetLang() : '';
    return core.getLangBase(target);
  }

  function getVideoElement() {
    if (state.provider && state.provider.getVideo) return state.provider.getVideo();
    return document.querySelector('video');
  }

  function isCaptionsEnabled() {
    return !!state.provider && state.provider.isCaptionsEnabled();
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
  function getCueKey(cue) {
    return `${state.trackId}|${cue.startMs}|${cue.text}`;
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
  async function translateCues(cues) {
    if (state.skipTranslation || !cues.length) return true;
    if (ctx.isExtensionContextAvailable && !ctx.isExtensionContextAvailable()) return false;

    const texts = cues.map((cue) => cue.text);
    let response;
    try {
      response = await ctx.requestTranslation(core.buildTranslationRequest({
        texts,
        targetLang: ctx.getEffectiveTargetLang ? ctx.getEffectiveTargetLang() : '',
        trackLang: state.trackLang,
        delimiter: DELIMITER,
      }));
    } catch (error) {
      markBatchFailed(cues);
      return false;
    }

    if (!response || response.error || !Array.isArray(response.translations)) {
      markBatchFailed(cues);
      return false;
    }

    response.translations.forEach((translation, index) => {
      const cue = cues[index];
      if (!cue) return;
      const key = getCueKey(cue);
      state.cueCache.set(key, translation || cue.text);
      state.pendingKeys.delete(key);
      state.failedUntil.delete(key);
    });

    renderActiveCue(state.lastNowMs);
    return true;
  }

  function markBatchFailed(cues) {
    const retryAt = Date.now() + RETRY_COOLDOWN_MS;
    cues.forEach((cue) => {
      const key = getCueKey(cue);
      state.pendingKeys.delete(key);
      state.failedUntil.set(key, retryAt);
    });
  }

  function isSegmentTranslatable(seg, wallNow) {
    const key = getCueKey(seg);
    if (state.cueCache.has(key) || state.pendingKeys.has(key)) return false;
    const retryAt = state.failedUntil.get(key);
    return !(retryAt && retryAt > wallNow);
  }

  function batchDistance(batch, playheadMs) {
    const start = batch[0].startMs;
    const end = batch[batch.length - 1].endMs;
    if (playheadMs < start) return start - playheadMs;
    if (playheadMs > end) return playheadMs - end;
    return 0;
  }

  // Pick the batch nearest the playhead that still has translatable segments, so
  // what the viewer is watching translates first while the whole track fills in.
  function pickNextBatch() {
    const wallNow = Date.now();
    const playhead = state.lastNowMs;
    let best = null;
    let bestDist = Infinity;
    for (const batch of state.batches) {
      const todo = batch.filter((seg) => isSegmentTranslatable(seg, wallNow));
      if (!todo.length) continue;
      const dist = batchDistance(batch, playhead);
      if (dist < bestDist) {
        bestDist = dist;
        best = todo;
      }
    }
    return best;
  }

  // Translate the entire track up front, nearest-to-playhead first. Safe to call
  // often: it no-ops while a pass runs and briefly after a failed batch.
  async function ensureTrackTranslated(force) {
    if (state.skipTranslation || state.dismissed || state.translating) return;
    const now = Date.now();
    if (!force && now - state.lastTriggerMs < 2000) return;
    state.lastTriggerMs = now;
    state.translating = true;
    try {
      while (state.active && !state.skipTranslation && !state.dismissed) {
        const batch = pickNextBatch();
        if (!batch || !batch.length) break;
        batch.forEach((seg) => state.pendingKeys.add(getCueKey(seg)));
        const ok = await translateCues(batch);
        if (!ok) break; // cooldown set on the batch; a later trigger resumes it
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
    if (state.video) state.video.removeEventListener('timeupdate', handleTimeUpdate);
    state.video = video;
    video.addEventListener('timeupdate', handleTimeUpdate);
  }

  async function handleTimeUpdate() {
    if (!state.active || !state.cues.length) return;

    if (state.dismissed || state.skipTranslation || !isCaptionsEnabled()) {
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
    ensureTrackTranslated(false);
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

  /** The menu's status line: which track we are on, or why there is none. */
  function captionStatus(provider) {
    if (state.skipTranslation) return { kind: 'same-language' };
    if (state.cues.length) return { kind: 'track', label: state.trackLabel || state.trackLang };
    let label = '';
    try {
      if (provider && provider.getTrackLabel) label = provider.getTrackLabel() || '';
    } catch (e) { /* a provider probing for DOM that is not there */ }
    return label ? { kind: 'track', label } : { kind: 'none' };
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

      const trackBase = core.getLangBase(track.lang || '');
      const targetBase = getTargetLangBase();
      state.skipTranslation = !!(trackBase && targetBase && trackBase === targetBase);

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
    state.skipTranslation = false;
    state.dismissed = false;
    state.translating = false;
    state.lastTriggerMs = 0;
    state.lastNowMs = 0;
    if (state.video) {
      state.video.removeEventListener('timeupdate', handleTimeUpdate);
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
    handleTimeUpdate();
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
