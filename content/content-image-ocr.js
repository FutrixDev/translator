// AI Translator Content Script — image OCR translation UI
//
// The context menu's "Extract & Translate Image Text" lands here. This module
// only owns the popup lifecycle; the fetch, the vision call and the parsing
// all happen in the service worker (OCR_IMAGE), because a page CSP can block a
// content-script fetch and the API endpoint is cross-origin everywhere.
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
   * Run one OCR translation: pending popup up front (reading the image takes
   * seconds — a silent right-click reads as a broken one), then the finished
   * result through the standard popup so copy/speech/target-language all work.
   */
  async function startImageOcrTranslation({ srcUrl, targetLang }) {
    if (!srcUrl) return;

    ctx.hideTranslationPopup();
    ctx.applyTheme(settings.theme);

    const popup = document.createElement('div');
    popup.className = 'ai-translator-popup';
    popup.dataset.sourceText = '';
    // The "source" slot shows what is being worked on while there is no text
    // yet: the extraction notice.
    popup.innerHTML = ctx.buildPopupMarkup({ text: t('ocrExtracting'), pending: true });
    popup.style.left = `${Math.max(10, (window.innerWidth - 400) / 2)}px`;
    popup.style.top = `${Math.max(10, (window.innerHeight - 250) / 2)}px`;
    state.translationPopup = popup;
    document.body.appendChild(popup);
    popup.querySelector('.ai-translator-close').addEventListener('click', ctx.hideTranslationPopup);
    ctx.setupPopupDrag(popup);

    let response;
    try {
      response = await chrome.runtime.sendMessage({ type: 'OCR_IMAGE', srcUrl, targetLang });
    } catch (error) {
      response = {
        error: ctx.isExtensionContextInvalidated(error)
          ? t('extensionContextInvalidated')
          : t('translationFailed')
      };
    }

    // Closed, or replaced by a newer popup, while the OCR ran.
    if (state.translationPopup !== popup) return;

    if (!response || response.error) {
      renderOcrFailure(popup, response?.error || t('translationFailed'));
      return;
    }
    if (!response.text && !response.translation) {
      renderOcrFailure(popup, t('ocrNoTextDetected'));
      return;
    }

    const detectedLabel = response.languageName || response.language;
    const langLine = detectedLabel ? `${t('ocrDetectedLanguage')}: ${detectedLabel}` : '';
    // The standard finished-result popup: copy, both speak buttons, drag, and
    // the target-language dropdown (which re-translates the now-plain text
    // through the normal engine) all come wired.
    ctx.showTranslationResult(response.text, response.translation, langLine);

    // A JSON reply with text but no translation (it happens): fall back to the
    // ordinary text-translation path on the extracted text.
    if (response.text && !response.translation && ctx.translateText) {
      ctx.translateText(response.text, targetLang);
    }
  }

  ctx.startImageOcrTranslation = startImageOcrTranslation;
})();
