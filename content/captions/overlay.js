// Blab Translation 视频字幕 —— 字幕框
//
// 钉在视频上的那个框：建出来、把两行字放进去、按设置改字号配色、记住观众拖到哪儿
// 缩到多大。这一份只管画和摆，什么时候画、画哪一句是别处决定的。
(function() {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT;
  if (!ctx) return;
  // 这一族共用的架子，说明见 content/content-video-captions.js 顶上。
  const caps = (ctx.captions = ctx.captions || {});
  const state = caps.state;
  const core = globalThis.CaptionCore;

  // Watches the overlay's own box, which is the video's. Playback already
  // re-applies the layout on every timeupdate; this is for the changes that
  // arrive with no playback behind them — a paused video going fullscreen or
  // into theater mode, a window being resized.
  let frameObserver = null;

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
    // 原文是别人的字幕，哪门语言我们不知道：让浏览器按第一个强方向字符定方向。
    original.dir = 'auto';
    const line = document.createElement('div');
    line.className = 'ai-translator-caption-line';
    block.appendChild(original);
    block.appendChild(line);
    overlay.appendChild(block);
    container.appendChild(overlay);
    state.overlay = overlay;
    state.block = block;
    bindCaptionInteractions(block);
    // Watched before it is painted: a paint that throws on a bad setting must
    // not leave behind an overlay that no longer follows its frame.
    if (frameObserver) frameObserver.disconnect();
    frameObserver = new ResizeObserver(() => {
      applyCaptionLayout();
      applyCaptionDisplay();
    });
    frameObserver.observe(overlay);
    applyCaptionStyle();
    applyCaptionLayout();
    applyCaptionDisplay();
    return overlay;
  }

  function discardOverlay() {
    if (frameObserver) {
      frameObserver.disconnect();
      frameObserver = null;
    }
    if (state.overlay) state.overlay.remove();
    state.overlay = null;
    state.block = null;
  }

  // Render the block. Which lines appear is the display mode's answer; the
  // text is always set with textContent — a caption is someone else's markup.
  function setOverlayContent(original, translation) {
    if (!state.overlay) return;
    const display = caps.currentDisplay();
    const origEl = state.overlay.querySelector('.ai-translator-caption-original');
    const transEl = state.overlay.querySelector('.ai-translator-caption-line');
    if (origEl) {
      origEl.textContent = original || '';
      origEl.style.display = (display.showOriginal && original) ? '' : 'none';
    }
    if (transEl) {
      // 译文行每次落字都按此刻的目标语言打标：观众可以在视频中途换目标语言，
      // 而缓存键里带着它，所以这一行的字总是这门语言。
      ctx.markLanguage(transEl, ctx.getEffectiveTargetLang());
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
   * pointer would drop the drag. Where "the bottom" is comes from the provider:
   * how far up the picture the line sits, and how much of the bottom edge the
   * player's control bar is covering right now (only the provider knows where
   * that bar is or whether it is showing). The stylesheet takes whichever is
   * higher, so the block moves only when the bar would actually reach it.
   */
  function applyCaptionDisplay() {
    if (!state.overlay || !state.provider) return;
    const display = caps.currentDisplay();
    const origEl = state.overlay.querySelector('.ai-translator-caption-original');
    const transEl = state.overlay.querySelector('.ai-translator-caption-line');
    if (origEl) origEl.style.order = display.translationFirst ? '2' : '1';
    if (transEl) transEl.style.order = display.translationFirst ? '1' : '2';

    const anchor = state.provider.getCaptionAnchor();
    state.overlay.style.setProperty('--ai-caption-bottom', `${anchor.bottomPct}%`);
    state.overlay.style.setProperty('--ai-caption-clear', `${anchor.clearPx}px`);
  }

  function setOverlayVisible(visible) {
    if (!state.overlay) return;
    state.overlay.style.display = visible ? 'flex' : 'none';
  }

  // The viewer's caption colours, as CSS variables. What an unset colour is
  // lives with every other default (shared/default-settings.js), and what the
  // three settings turn into lives in CaptionCore.captionPaint, which the
  // settings page's preview draws from too.
  function applyCaptionStyle() {
    if (!state.overlay) return;
    const paint = core.captionPaint({
      fontColor: caps.getSetting('youtubeCaptionFontColor'),
      bgColor: caps.getSetting('youtubeCaptionBgColor'),
      bgOpacity: caps.getSetting('youtubeCaptionBgOpacity'),
    });
    state.overlay.style.setProperty('--ai-caption-fg', paint.fg);
    state.overlay.style.setProperty('--ai-caption-bg', paint.bg);
    state.overlay.style.setProperty('--ai-caption-edge', paint.edge);
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

  // Size the text for the box the video occupies, then apply the viewer's saved
  // position, width and scale. Position and width are percentages of that box,
  // so they survive resize/fullscreen; the scale multiplies the font size, and
  // everything else in the block (padding, corners, the text's edge) is in
  // `em`, so it follows.
  function applyCaptionLayout() {
    if (!state.overlay) return;
    const scale = Number(caps.getSetting('youtubeCaptionScale'));
    state.overlay.style.setProperty('--ai-caption-scale', String(Number.isFinite(scale) && scale > 0 ? scale : 1));
    // A hidden overlay has no box; it keeps the size it had and is measured
    // again by the observer the moment it shows.
    const frame = state.overlay.getBoundingClientRect();
    if (frame.width > 0 && frame.height > 0) {
      const fontPx = core.captionFontPx(frame.width, frame.height);
      state.overlay.style.setProperty('--ai-caption-size', `${Math.round(fontPx * 100) / 100}px`);
    }
    const block = state.block || state.overlay.querySelector('.ai-translator-caption-block');
    if (!block) return;
    const x = caps.getSetting('youtubeCaptionPosXPct');
    const y = caps.getSetting('youtubeCaptionPosYPct');
    // Untouched, the block sits where the page's own captions do (see
    // applyCaptionDisplay). A viewer who has dragged it once has said where
    // they want it, and that wins for good — including over the control bar,
    // which would otherwise shove their position around.
    const placed = typeof x === 'number' && typeof y === 'number';
    block.classList.toggle('ai-cap-anchored', !placed);
    if (placed) {
      block.style.left = `${x}%`;
      block.style.top = `${y}%`;
    } else {
      block.style.left = '';
      block.style.top = '';
    }
    const w = caps.getSetting('youtubeCaptionWidthPct');
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
      // 和播放器里那个图标是同一个开关（caps.setVideoCaptionsOn），图标跟着变成「关」。
      caps.setVideoCaptionsOn(false);
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
   * 用整码而不是基码，见 getTargetLang()：简体和繁体是同一个基码下的两套字。
   */

  // 别的文件要用的，都从这张架子上取。
  Object.assign(caps, {
    applyCaptionDisplay, applyCaptionLayout, applyCaptionStyle, discardOverlay,
    ensureOverlay, setOverlayContent, setOverlayVisible,
  });
})();
