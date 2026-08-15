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

  /** Run one image through step 1, then step 2 when it is wanted. */
  async function startImageOcrTranslation({ srcUrl, targetLang, translate }) {
    if (!srcUrl) return;

    const popup = openPendingPopup();
    const requestId = `ocr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    activeRequest = { requestId, popup };

    let response;
    try {
      response = await chrome.runtime.sendMessage({ type: 'OCR_IMAGE', srcUrl, requestId });
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
