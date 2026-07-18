// AI Translator YouTube Caption Translation
//
// Captions are obtained by observing the YouTube player's own /api/timedtext
// responses (relayed from the MAIN-world interceptor via window.postMessage),
// because YouTube now gates that endpoint behind a per-session Proof-of-Origin
// token that the extension cannot reproduce on its own. Captured cues are
// translated in a rolling look-ahead window and rendered as an extra line
// inside the native caption container.
(function() {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT;
  if (!ctx) return;

  const DELIMITER = '⟪⟫⟪⟫⟪⟫';
  const MAX_CUES = 20000;
  // Merge short ASR fragments into full sentences, so the model translates
  // coherent units (not word-fragments) and the reader sees a complete line
  // while it is being spoken.
  const SEG_MAX_DURATION_MS = 12000;
  const SEG_MAX_CHARS = 220;
  const SEG_GAP_MS = 1500;
  // Whole-track translation: contiguous sentences are grouped into batches (for
  // cross-sentence context) and the whole track is translated up front.
  const BATCH_MAX_ITEMS = 16;
  const BATCH_MAX_CHARS = 1600;
  const RETRY_COOLDOWN_MS = 8000;

  const state = {
    active: false,
    overlay: null,
    rawCues: [],
    cues: [],
    batches: [],
    cueCache: new Map(),
    pendingKeys: new Set(),
    failedUntil: new Map(),
    trackId: '',
    trackLang: '',
    skipTranslation: false,
    translating: false,
    lastTriggerMs: 0,
    video: null,
    lastNowMs: 0,
  };

  let messageListener = null;
  let navListener = null;

  function isYouTube() {
    return window.location.hostname.includes('youtube.com');
  }

  function isCaptionsEnabled() {
    const button = document.querySelector('.ytp-subtitles-button');
    if (button) {
      return button.getAttribute('aria-pressed') === 'true';
    }
    return !!document.querySelector('.ytp-caption-window-container');
  }

  function getVideoElement() {
    return document.querySelector('video');
  }

  function getLangBase(lang) {
    if (ctx.getLangBase) return ctx.getLangBase(lang || '');
    return String(lang || '').split('-')[0].toLowerCase();
  }

  function getTargetLangBase() {
    const target = ctx.getEffectiveTargetLang ? ctx.getEffectiveTargetLang() : '';
    return getLangBase(target);
  }

  // ---------------------------------------------------------------- overlay
  function ensureOverlay() {
    const container = document.querySelector('.ytp-caption-window-container');
    if (!container) return null;
    if (state.overlay && container.contains(state.overlay)) {
      return state.overlay;
    }
    const overlay = document.createElement('div');
    overlay.id = 'ai-translator-youtube-caption-overlay';
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
    bindCaptionInteractions(block);
    applyCaptionLayout();
    return overlay;
  }

  // Render the bilingual block: original caption on top, translated line beneath.
  // The original line is hidden when the user turns off "show original caption".
  function setOverlayContent(original, translation) {
    if (!state.overlay) return;
    const showOriginal = ctx.settings?.showYoutubeOriginalCaption !== false;
    const origEl = state.overlay.querySelector('.ai-translator-caption-original');
    const transEl = state.overlay.querySelector('.ai-translator-caption-line');
    if (origEl) {
      origEl.textContent = original || '';
      origEl.style.display = (showOriginal && original) ? '' : 'none';
    }
    if (transEl) {
      transEl.textContent = translation || '';
      transEl.style.display = translation ? '' : 'none';
    }
  }

  function setOverlayVisible(visible) {
    if (!state.overlay) return;
    state.overlay.style.display = visible ? 'flex' : 'none';
  }

  // Hide YouTube's own caption windows while our bilingual overlay is showing, so
  // the native line and our line don't stack and overlap. Scoped by a marker class
  // so native captions return to normal the moment our overlay goes inactive.
  function setNativeCaptionsHidden(hidden) {
    const container = document.querySelector('.ytp-caption-window-container');
    if (!container) return;
    container.classList.toggle('ai-translator-hide-native', !!hidden);
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
    const s = ctx.settings || {};
    const fg = s.youtubeCaptionFontColor || '#ffffff';
    const rawOpacity = s.youtubeCaptionBgOpacity != null ? Number(s.youtubeCaptionBgOpacity) : 82;
    const alpha = Math.max(0, Math.min(1, (Number.isFinite(rawOpacity) ? rawOpacity : 82) / 100));
    const bg = hexToRgba(s.youtubeCaptionBgColor || '#080808', alpha);
    state.overlay.style.setProperty('--ai-yt-caption-fg', fg);
    state.overlay.style.setProperty('--ai-yt-caption-bg', bg);
  }

  // ---- draggable + wheel-resizable caption ----
  let layoutSaveTimer = null;

  function persistCaptionLayout(debounced) {
    const write = () => {
      try {
        chrome.storage.sync.set({
          youtubeCaptionPosXPct: ctx.settings.youtubeCaptionPosXPct,
          youtubeCaptionPosYPct: ctx.settings.youtubeCaptionPosYPct,
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

  // Apply the user's saved caption position (percentage of the player, so it
  // survives resize/fullscreen) and font scale via a CSS variable.
  function applyCaptionLayout() {
    if (!state.overlay) return;
    const s = ctx.settings || {};
    const scale = Number(s.youtubeCaptionScale);
    state.overlay.style.setProperty('--ai-yt-caption-scale', String(Number.isFinite(scale) && scale > 0 ? scale : 1));
    const x = s.youtubeCaptionPosXPct;
    const y = s.youtubeCaptionPosYPct;
    if (typeof x === 'number' && typeof y === 'number') {
      state.overlay.style.left = `${x}%`;
      state.overlay.style.top = `${y}%`;
      state.overlay.style.right = 'auto';
      state.overlay.style.bottom = 'auto';
      state.overlay.style.transform = 'translate(-50%, -50%)';
    } else {
      // fall back to the default CSS position (bottom-centred)
      state.overlay.style.left = '';
      state.overlay.style.top = '';
      state.overlay.style.right = '';
      state.overlay.style.bottom = '';
      state.overlay.style.transform = '';
    }
  }

  // Drag to move, wheel to resize, double-click to reset. Bound once per block.
  function bindCaptionInteractions(block) {
    if (!block || block.__aiInteractive) return;
    block.__aiInteractive = true;

    const getContainer = () => document.querySelector('.ytp-caption-window-container');
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

    block.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || !state.overlay) return;
      const c = getContainer();
      if (!c) return;
      e.preventDefault();
      e.stopPropagation();
      dragging = true;
      const cRect = c.getBoundingClientRect();
      const oRect = state.overlay.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      startCx = (oRect.left + oRect.width / 2) - cRect.left;
      startCy = (oRect.top + oRect.height / 2) - cRect.top;
      document.addEventListener('mousemove', onMove, true);
      document.addEventListener('mouseup', onUp, true);
    });

    block.addEventListener('wheel', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const cur = Number(ctx.settings.youtubeCaptionScale) || 1;
      const next = Math.max(0.5, Math.min(3, cur + (e.deltaY < 0 ? 0.1 : -0.1)));
      ctx.settings.youtubeCaptionScale = Math.round(next * 100) / 100;
      applyCaptionLayout();
      persistCaptionLayout(true);
    }, { passive: false });

    block.addEventListener('dblclick', (e) => {
      e.preventDefault();
      e.stopPropagation();
      ctx.settings.youtubeCaptionPosXPct = null;
      ctx.settings.youtubeCaptionPosYPct = null;
      ctx.settings.youtubeCaptionScale = 1;
      applyCaptionLayout();
      persistCaptionLayout(false);
    });
  }

  // ---------------------------------------------------------------- parsers
  function parseJson3(data) {
    const events = Array.isArray(data?.events) ? data.events : [];
    const cues = [];
    for (const event of events) {
      const startMs = Number(event.tStartMs);
      const durationMs = Number(event.dDurationMs);
      if (!Number.isFinite(startMs) || !Number.isFinite(durationMs) || durationMs <= 0) continue;
      const text = (event.segs || [])
        .map((seg) => seg.utf8 || '')
        .join('')
        .replace(/\s+/g, ' ')
        .trim();
      if (!text) continue;
      cues.push({ startMs, endMs: startMs + durationMs, text });
    }
    return cues;
  }

  function parseVttTimestamp(value) {
    if (!value) return Number.NaN;
    const cleaned = value.replace(',', '.');
    const parts = cleaned.split(':');
    if (parts.length < 2) return Number.NaN;
    const secondsPart = parts.pop() || '0';
    const minutesPart = parts.pop() || '0';
    const hoursPart = parts.pop() || '0';
    const [secStr, msStr = '0'] = secondsPart.split('.');
    const hours = Number(hoursPart);
    const minutes = Number(minutesPart);
    const seconds = Number(secStr);
    const millis = Number(msStr.padEnd(3, '0').slice(0, 3));
    if (![hours, minutes, seconds, millis].every(Number.isFinite)) return Number.NaN;
    return ((hours * 3600 + minutes * 60 + seconds) * 1000) + millis;
  }

  function parseVtt(text) {
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    const cues = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i].trim();
      if (!line || line.startsWith('WEBVTT')) {
        i += 1;
        continue;
      }
      if (line.includes('-->')) {
        const parts = line.split('-->');
        const startMs = parseVttTimestamp(parts[0]?.trim() || '');
        const endMs = parseVttTimestamp((parts[1]?.trim() || '').split(' ')[0] || '');
        i += 1;
        const textLines = [];
        while (i < lines.length && lines[i].trim() !== '') {
          textLines.push(lines[i]);
          i += 1;
        }
        const cueText = textLines
          .join(' ')
          .replace(/<[^>]+>/g, '')
          .replace(/\s+/g, ' ')
          .trim();
        if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs && cueText) {
          cues.push({ startMs, endMs, text: cueText });
        }
        continue;
      }
      i += 1;
    }
    return cues;
  }

  function parseSrv3(text) {
    const doc = new DOMParser().parseFromString(text, 'text/xml');
    const nodes = Array.from(doc.getElementsByTagName('text'));
    const cues = [];
    for (const node of nodes) {
      const start = Number(node.getAttribute('start'));
      const dur = Number(node.getAttribute('dur') || node.getAttribute('d'));
      if (!Number.isFinite(start) || !Number.isFinite(dur) || dur <= 0) continue;
      const cueText = (node.textContent || '').replace(/\s+/g, ' ').trim();
      if (!cueText) continue;
      cues.push({
        startMs: Math.round(start * 1000),
        endMs: Math.round((start + dur) * 1000),
        text: cueText,
      });
    }
    return cues;
  }

  function parseCaptionPayload(text, contentType) {
    const trimmed = (text || '').trim();
    if (!trimmed) return [];
    const ct = contentType || '';
    if (ct.includes('json') || trimmed.startsWith('{')) {
      try {
        return parseJson3(JSON.parse(trimmed));
      } catch (e) { /* fall through */ }
    }
    if (trimmed.startsWith('WEBVTT') || trimmed.includes('-->')) {
      return parseVtt(trimmed);
    }
    if (trimmed.startsWith('<')) {
      return parseSrv3(trimmed);
    }
    try {
      return parseJson3(JSON.parse(trimmed));
    } catch (e) { /* give up */ }
    return [];
  }

  // ------------------------------------------------------------------- cues
  function getCueKey(cue) {
    return `${state.trackId}|${cue.startMs}|${cue.text}`;
  }

  function endsSentence(text) {
    return /[.!?。！？…؟][)"'”’\]]?\s*$/.test(text);
  }

  // Group consecutive raw cues into sentence-level segments. A new segment starts
  // at sentence-ending punctuation, a long pause, or when the merged text/span
  // grows too large.
  function buildSegments(rawCues) {
    const sorted = rawCues.slice().sort((a, b) => a.startMs - b.startMs);
    const segments = [];
    let cur = null;
    for (const cue of sorted) {
      if (!cur) {
        cur = { startMs: cue.startMs, endMs: cue.endMs, text: cue.text };
        continue;
      }
      const gap = cue.startMs - cur.endMs;
      const merged = `${cur.text} ${cue.text}`.replace(/\s+/g, ' ').trim();
      const spanTooLong = (cue.endMs - cur.startMs) > SEG_MAX_DURATION_MS;
      if (endsSentence(cur.text) || gap > SEG_GAP_MS || merged.length > SEG_MAX_CHARS || spanTooLong) {
        segments.push(cur);
        cur = { startMs: cue.startMs, endMs: cue.endMs, text: cue.text };
      } else {
        cur.text = merged;
        cur.endMs = cue.endMs;
      }
    }
    if (cur) segments.push(cur);
    return segments;
  }

  // Chunk contiguous segments into batches (bounded by item count and characters)
  // so each translation request carries neighbouring sentences for context.
  function buildBatches(segments) {
    const batches = [];
    let cur = [];
    let chars = 0;
    for (const seg of segments) {
      if (cur.length && (cur.length >= BATCH_MAX_ITEMS || chars + seg.text.length > BATCH_MAX_CHARS)) {
        batches.push(cur);
        cur = [];
        chars = 0;
      }
      cur.push(seg);
      chars += seg.text.length;
    }
    if (cur.length) batches.push(cur);
    return batches;
  }

  function ingestRawCues(newCues) {
    if (!newCues.length) return false;
    const seen = new Set(state.rawCues.map((c) => `${c.startMs}|${c.text}`));
    let added = false;
    for (const cue of newCues) {
      const key = `${cue.startMs}|${cue.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      state.rawCues.push(cue);
      added = true;
    }
    if (!added) return false;
    state.rawCues.sort((a, b) => a.startMs - b.startMs);
    if (state.rawCues.length > MAX_CUES) state.rawCues = state.rawCues.slice(-MAX_CUES);
    state.cues = buildSegments(state.rawCues);
    state.batches = buildBatches(state.cues);
    return true;
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
      response = await chrome.runtime.sendMessage({
        type: 'TRANSLATE_BATCH_FAST',
        texts,
        targetLang: ctx.getEffectiveTargetLang ? ctx.getEffectiveTargetLang() : '',
        delimiter: DELIMITER,
      });
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
    if (state.skipTranslation || state.translating) return;
    const now = Date.now();
    if (!force && now - state.lastTriggerMs < 2000) return;
    state.lastTriggerMs = now;
    state.translating = true;
    try {
      while (state.active && !state.skipTranslation) {
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

    if (state.skipTranslation || !isCaptionsEnabled()) {
      setOverlayVisible(false);
      setNativeCaptionsHidden(false);
      return;
    }

    ensureOverlay();
    applyCaptionStyle();
    applyCaptionLayout();
    setOverlayVisible(true);
    setNativeCaptionsHidden(true);

    const nowMs = Math.floor((state.video?.currentTime || 0) * 1000);
    state.lastNowMs = nowMs;
    renderActiveCue(nowMs);
    ensureTrackTranslated(false);
  }

  // ------------------------------------------------------- capture handling
  function handleCapturedTimedText(url, text, contentType) {
    let lang = '';
    try {
      lang = new URL(url, window.location.href).searchParams.get('lang') || '';
    } catch (e) { /* keep empty */ }

    const cues = parseCaptionPayload(text, contentType);
    if (!cues.length) return;

    const trackId = lang || 'track';
    if (trackId !== state.trackId) {
      // Caption language changed (or first track): start a fresh cue set.
      state.trackId = trackId;
      state.trackLang = lang;
      state.rawCues = [];
      state.cues = [];
      state.batches = [];
      state.cueCache.clear();
      state.pendingKeys.clear();
      state.failedUntil.clear();
    }
    ingestRawCues(cues);

    const targetBase = getTargetLangBase();
    const trackBase = getLangBase(lang);
    state.skipTranslation = !!(trackBase && targetBase && trackBase === targetBase);

    ensureVideoListener();
    handleTimeUpdate();
    // Translate the whole track up front (nearest-to-playhead first).
    ensureTrackTranslated(true);
  }

  function onWindowMessage(event) {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== 'ai-translator' || data.type !== 'YT_TIMEDTEXT_CAPTURED') return;
    handleCapturedTimedText(data.url || '', data.text || '', data.contentType || '');
  }

  function requestReplay() {
    window.postMessage({ source: 'ai-translator', type: 'YT_TIMEDTEXT_REPLAY' }, '*');
  }

  // -------------------------------------------------------------- lifecycle
  function resetForVideo() {
    setNativeCaptionsHidden(false);
    state.rawCues = [];
    state.cues = [];
    state.batches = [];
    state.cueCache.clear();
    state.pendingKeys.clear();
    state.failedUntil.clear();
    state.trackId = '';
    state.trackLang = '';
    state.skipTranslation = false;
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
  }

  function start() {
    if (state.active) return;
    state.active = true;
    if (!messageListener) {
      messageListener = onWindowMessage;
      window.addEventListener('message', messageListener);
    }
    // Captions may have been fetched by the player before we started listening
    // (e.g. CC on by default); ask the interceptor to replay what it buffered.
    requestReplay();
  }

  function handleNavigation() {
    if (!state.active) return;
    resetForVideo();
    // Do not replay here: the interceptor clears its buffer on navigation, and
    // the player will issue a fresh timedtext request for the new video.
  }

  ctx.setupYouTubeCaptionTranslation = function() {
    if (!isYouTube()) return;
    if (!ctx.settings?.enableYoutubeCaptionTranslation) return;
    start();
    if (!navListener) {
      navListener = handleNavigation;
      window.addEventListener('yt-navigate-finish', navListener);
    }
  };

  ctx.stopYouTubeCaptionTranslation = function() {
    if (navListener) {
      window.removeEventListener('yt-navigate-finish', navListener);
      navListener = null;
    }
    if (messageListener) {
      window.removeEventListener('message', messageListener);
      messageListener = null;
    }
    state.active = false;
    resetForVideo();
  };
})();
