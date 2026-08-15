// AI Translator Content Script — image OCR
//
// The context menu's image entry lands here. The feature is two
// separable steps and this module is where they are sequenced:
//
//   1. RECOGNISE — the service worker (OCR_IMAGE) does it, because it owns the
//      image fetch (a page CSP can block a content-script one) and the
//      offscreen document the local engine runs in. Returns {text, language}.
//   2. TRANSLATE — optional, and done right here through ctx.translateText, the
//      same path selection translation uses: Chrome's built-in Translator
//      first, the user's own API as fallback. Nothing about the text being
//      recognised rather than selected changes what translating it means.
//
// Step 1 alone is a finished result — "what does this sign say" is a whole
// question — so recognise-only gets a real terminal popup, not an empty one.
//
// Either menu entry can also ask for PART of the image, and the picker for that
// lives here too, ahead of step 1: only the page can answer "which rectangle",
// because only the page has the image on screen. What it sends on is fractions
// of the image, never pixels — see shared/ocr.js.
(function() {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT;
  if (!ctx) return;

  const { settings, state } = ctx;
  const t = ctx.t;

  function renderOcrFailure(popup, message) {
    const loadingEl = popup.querySelector('.ai-translator-loading');
    const loadingLines = popup.querySelector('.ai-translator-loading-lines');
    const resultBody = popup.querySelector('.ai-translator-result-body');
    if (loadingEl) loadingEl.style.display = 'none';
    if (loadingLines) loadingLines.style.display = 'none';
    if (resultBody) {
      resultBody.hidden = false;
      resultBody.innerHTML = `<div class="ai-translator-error">${ctx.escapeHtml(message)}</div>`;
    }
  }

  /**
   * The source heading for the finished popup: "Original · 日本語" when the
   * language is known, plain "Original" when it is not. An unrecognised code is
   * shown raw rather than dropped — "Original · pt" still tells the user
   * something true.
   */
  function sourceLabelFor(language) {
    if (!language) return '';
    const key = window.OCRCore.detectedLanguageLabelKey(language);
    return `${t('original')} · ${key ? t(key) : language}`;
  }

  /**
   * The pending popup shown while step 1 runs. Local OCR takes a second or two
   * on a cold engine and a vision call takes several, and a right-click that
   * does nothing visible reads as a broken one.
   */
  function openPendingPopup() {
    ctx.hideTranslationPopup();
    ctx.applyTheme(settings.theme);

    const popup = document.createElement('div');
    popup.className = 'ai-translator-popup';
    popup.dataset.sourceText = '';
    // The "source" slot carries the progress notice while there is no text yet.
    popup.innerHTML = ctx.buildPopupMarkup({ text: t('ocrExtracting'), pending: true });
    // The standard markup ships controls this popup cannot serve: there is no
    // source text to speak or copy yet, and the language dropdown would
    // re-translate an empty string. Success rebuilds the popup fully wired via
    // showTranslationResult; until then (and on failure, where this popup
    // stays) only close and drag are live, so the rest must not render.
    for (const selector of ['.ai-translator-lang-dropdown', '.ai-translator-speak-source', '.ai-translator-actions']) {
      const el = popup.querySelector(selector);
      if (el) el.style.display = 'none';
    }
    popup.style.left = `${Math.max(10, (window.innerWidth - 400) / 2)}px`;
    popup.style.top = `${Math.max(10, (window.innerHeight - 250) / 2)}px`;
    state.translationPopup = popup;
    document.body.appendChild(popup);
    popup.querySelector('.ai-translator-close').addEventListener('click', ctx.hideTranslationPopup);
    ctx.setupPopupDrag(popup);
    return popup;
  }

  // The local engine reports how far along it is, relayed by the service worker
  // (the offscreen document cannot address a tab). Only the pending popup for
  // this very request may show it — a stale relay must not overwrite a popup
  // the user has since opened for something else.
  let activeRequest = null;

  function onOcrProgress(message) {
    if (!activeRequest || message.requestId !== activeRequest.requestId) return;
    if (state.translationPopup !== activeRequest.popup) return;
    const label = activeRequest.popup.querySelector('.ai-translator-loading span');
    if (!label) return;
    const percent = Math.round(Math.max(0, Math.min(1, message.progress || 0)) * 100);
    label.textContent = message.stage === 'recognizing'
      ? `${t('ocrRecognizing')} ${percent}%`
      : t('ocrLoadingEngine');
  }

  // --- The area picker -------------------------------------------------------

  const REGION_ROOT_ID = 'ai-translator-ocr-region';

  // A drag shorter than this on either edge is a click that slipped rather than
  // a selection, so the picker stays open instead of recognising a stray pixel.
  const MIN_REGION_PX = 12;

  const matchesSrc = (img, srcUrl) => ctx.imageMatchesSrc(img, srcUrl);
  const renderedArea = (img) => ctx.renderedArea(img);

  /**
   * The <img> the menu click was about. The right-click point is the answer
   * whenever it agrees with `info.srcUrl`; a page that shows one src in a dozen
   * places gives srcUrl no way to tell them apart, and the point does.
   */
  function findImage(srcUrl) {
    const clicked = ctx.getLastContextImage();
    if (clicked && (!srcUrl || matchesSrc(clicked, srcUrl))) return clicked;
    const candidates = Array.from(document.images).filter((img) => matchesSrc(img, srcUrl));
    if (!candidates.length) return clicked;
    // The big one: a src reused across a page is the article image plus its own
    // thumbnails, and the user is pointing at the readable one.
    return candidates.reduce((best, img) => (renderedArea(img) > renderedArea(best) ? img : best));
  }

  const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

  /**
   * Where this image's pixels are on screen right now, and which part of them
   * the element actually shows.
   *
   * Everything the picker does is expressed against this and it is recomputed
   * on every frame that matters, so scrolling mid-drag moves the box with the
   * image instead of dragging a rectangle off it.
   */
  function imageGeometry(img) {
    const rect = img.getBoundingClientRect();
    const style = getComputedStyle(img);
    const px = (value) => parseFloat(value) || 0;
    // Measured from the content box: border and padding on an <img> are rare,
    // but where they exist they shift every coordinate below.
    const contentLeft = rect.left + px(style.borderLeftWidth) + px(style.paddingLeft);
    const contentTop = rect.top + px(style.borderTopWidth) + px(style.paddingTop);
    const contentWidth = Math.max(0, rect.width
      - px(style.borderLeftWidth) - px(style.borderRightWidth)
      - px(style.paddingLeft) - px(style.paddingRight));
    const contentHeight = Math.max(0, rect.height
      - px(style.borderTopWidth) - px(style.borderBottomWidth)
      - px(style.paddingTop) - px(style.paddingBottom));

    const painted = window.OCRCore.paintedImageBox({
      boxWidth: contentWidth,
      boxHeight: contentHeight,
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight,
      objectFit: style.objectFit
    });

    return {
      left: contentLeft + painted.left,
      top: contentTop + painted.top,
      width: painted.width,
      height: painted.height,
      // The window the element cuts out of the painted image, in fractions of
      // it. `object-fit: cover` paints past the element's edges, and a
      // selection cannot include pixels the page is not showing.
      bounds: {
        minX: painted.width > 0 ? clamp(-painted.left / painted.width, 0, 1) : 0,
        maxX: painted.width > 0 ? clamp((contentWidth - painted.left) / painted.width, 0, 1) : 1,
        minY: painted.height > 0 ? clamp(-painted.top / painted.height, 0, 1) : 0,
        maxY: painted.height > 0 ? clamp((contentHeight - painted.top) / painted.height, 0, 1) : 1
      }
    };
  }

  /** A point on screen → a point in the image, as fractions of the image. */
  function fractionAt(geom, clientX, clientY) {
    return {
      x: geom.width > 0 ? clamp((clientX - geom.left) / geom.width, geom.bounds.minX, geom.bounds.maxX) : 0,
      y: geom.height > 0 ? clamp((clientY - geom.top) / geom.height, geom.bounds.minY, geom.bounds.maxY) : 0
    };
  }

  /** Two corners in image fractions → the rectangle between them. */
  function rectBetween(start, end) {
    return {
      x: Math.min(start.x, end.x),
      y: Math.min(start.y, end.y),
      width: Math.abs(end.x - start.x),
      height: Math.abs(end.y - start.y)
    };
  }

  /**
   * Let the user draw a rectangle over `img`. Resolves with a crop in image
   * fractions, or null if they backed out — which is a real answer, not a
   * failure: nothing should be recognised in that case.
   */
  function pickImageRegion(img) {
    return new Promise((resolve) => {
      const rect = img.getBoundingClientRect();
      // Nothing to aim at if the image is off screen — the menu click may have
      // been followed by a scroll, and a lazy-loaded page moves under itself.
      if (rect.bottom < 0 || rect.top > window.innerHeight ||
          rect.right < 0 || rect.left > window.innerWidth) {
        img.scrollIntoView({ block: 'center', inline: 'center' });
      }

      const root = document.createElement('div');
      root.id = REGION_ROOT_ID;
      const box = document.createElement('div');
      box.className = 'ai-translator-ocr-region-box';
      const hint = document.createElement('div');
      hint.className = 'ai-translator-ocr-region-hint';
      hint.textContent = t('ocrRegionHint');
      root.appendChild(box);
      root.appendChild(hint);
      document.body.appendChild(root);

      // Fractions of the image, not pixels on screen: the page can scroll, the
      // element can be resized by a layout, and the selection still means the
      // same part of the picture.
      let selection = null;
      let dragStart = null;

      function render() {
        const geom = imageGeometry(img);
        const area = selection || {
          x: geom.bounds.minX,
          y: geom.bounds.minY,
          width: geom.bounds.maxX - geom.bounds.minX,
          height: geom.bounds.maxY - geom.bounds.minY
        };
        box.style.left = `${geom.left + area.x * geom.width}px`;
        box.style.top = `${geom.top + area.y * geom.height}px`;
        box.style.width = `${Math.max(0, area.width * geom.width)}px`;
        box.style.height = `${Math.max(0, area.height * geom.height)}px`;
        // Before the first drag the highlight is the whole image: it says what
        // is about to be read, and what the rectangle has to stay inside.
        box.classList.toggle('ai-translator-ocr-region-drawn', !!selection);
      }

      function finish(crop) {
        root.remove();
        document.removeEventListener('keydown', onKeyDown, true);
        window.removeEventListener('scroll', render, true);
        window.removeEventListener('resize', render);
        resolve(crop);
      }

      function onKeyDown(event) {
        if (event.key !== 'Escape') return;
        // Swallowed, or the page's own Escape handler acts on a keypress the
        // user aimed at us.
        event.preventDefault();
        event.stopPropagation();
        finish(null);
      }

      root.addEventListener('pointerdown', (event) => {
        // Anything but a plain left-press cancels: a right-click here is
        // someone reaching for the context menu again.
        if (event.button !== 0) {
          finish(null);
          return;
        }
        event.preventDefault();
        if (!img.isConnected) {
          finish(null);
          return;
        }
        dragStart = fractionAt(imageGeometry(img), event.clientX, event.clientY);
        selection = { ...dragStart, width: 0, height: 0 };
        root.setPointerCapture(event.pointerId);
        render();
      });

      root.addEventListener('pointermove', (event) => {
        if (!dragStart) return;
        selection = rectBetween(dragStart, fractionAt(imageGeometry(img), event.clientX, event.clientY));
        render();
      });

      root.addEventListener('pointerup', (event) => {
        if (!dragStart) return;
        const geom = imageGeometry(img);
        selection = rectBetween(dragStart, fractionAt(geom, event.clientX, event.clientY));
        dragStart = null;
        // Too small to be meant: keep the picker up rather than punishing a
        // slipped click with a recognition of four pixels.
        if (selection.width * geom.width < MIN_REGION_PX ||
            selection.height * geom.height < MIN_REGION_PX) {
          selection = null;
          render();
          return;
        }
        finish(selection);
      });

      // The menu that got us here is closed by now; this is the user asking for
      // it again, which is a cancel.
      root.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        finish(null);
      });

      document.addEventListener('keydown', onKeyDown, true);
      window.addEventListener('scroll', render, true);
      window.addEventListener('resize', render);
      render();
    });
  }

  /** Run one image through step 1, then step 2 when it is wanted. */
  async function startImageOcrTranslation({ srcUrl, targetLang, translate, selectRegion }) {
    if (!srcUrl) return;

    let crop = null;
    if (selectRegion) {
      const img = findImage(srcUrl);
      if (img) {
        crop = await pickImageRegion(img);
        // Backed out of the picker. The whole image is not what was asked for,
        // so nothing runs.
        if (!crop) return;
      }
      // No element to draw on — the menu fires on images this side cannot find
      // (inside a closed shadow root, or replaced since the click). Reading the
      // whole image is the honest fallback; it is the other menu entry.
    }

    const popup = openPendingPopup();
    const requestId = `ocr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    activeRequest = { requestId, popup };

    let response;
    try {
      response = await chrome.runtime.sendMessage({ type: 'OCR_IMAGE', srcUrl, crop, requestId });
    } catch (error) {
      response = {
        error: ctx.isExtensionContextInvalidated(error)
          ? t('extensionContextInvalidated')
          : t('translationFailed')
      };
    } finally {
      if (activeRequest && activeRequest.requestId === requestId) activeRequest = null;
    }

    // Closed, or replaced by a newer popup, while the OCR ran.
    if (state.translationPopup !== popup) return;

    if (!response || response.error) {
      renderOcrFailure(popup, response?.error || t('translationFailed'));
      return;
    }
    const text = response.text || '';
    if (!text) {
      renderOcrFailure(popup, t('ocrNoTextDetected'));
      return;
    }

    // Both codes through the extension's one language table, so 'zh-Hans' from
    // the script heuristic and a target of 'zh-CN' are recognised as the same
    // language instead of costing a translation of Chinese into Chinese.
    const toApiLang = ctx.builtinTranslator?.toApiLang || ((lang) => lang);
    const wanted = window.OCRCore.shouldTranslate({
      enabled: translate !== false,
      text,
      sourceLanguage: toApiLang(response.language),
      targetLanguage: toApiLang(targetLang || ctx.getEffectiveTargetLang())
    });

    ctx.showTranslationResult(text, '', '', {
      sourceLabel: sourceLabelFor(response.language),
      recognizeOnly: !wanted
    });

    // translateText owns the pending state, the request-staleness guard and
    // every way this can fail, so step 2 is one call.
    if (wanted) ctx.translateText(text, targetLang);
  }

  ctx.startImageOcrTranslation = startImageOcrTranslation;
  ctx.handleOcrProgress = onOcrProgress;
})();
