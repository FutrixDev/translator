// AI Translator Content Script Popup
(function() {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT;
  if (!ctx) return;

  const { settings, state } = ctx;
  const t = ctx.t;
  const applyTheme = ctx.applyTheme;
  const escapeHtml = ctx.escapeHtml;
  const copyToClipboard = ctx.copyToClipboard;
  const getEffectiveTargetLang = ctx.getEffectiveTargetLang;
  const normalizeTargetLang = ctx.normalizeTargetLang;
  const getTargetLangLabel = ctx.getTargetLangLabel;
  const buildTargetLangMenu = ctx.buildTargetLangMenu;
  const isExtensionContextAvailable = ctx.isExtensionContextAvailable;
  const isExtensionContextInvalidated = ctx.isExtensionContextInvalidated;
  const speech = ctx.speech;
  const SPEAKER_ICON = speech.SPEAKER_ICON;

  /**
   * The popup markup, shared by the live-translation and the
   * already-translated entry points. They rendered two near-identical copies
   * of this before; every control added to one had to be remembered in the
   * other, and the pronunciation buttons would have made that four.
   *
   * @param {{text: string, phonetic?: string, translation?: string, pending?: boolean}} options
   *   `pending` renders the loading state instead of a finished translation.
   */
  function buildPopupMarkup({ text, phonetic = '', translation = '', pending = false }) {
    return `
      <div class="ai-translator-header">
        <div class="ai-translator-header-left">
          <svg class="ai-translator-title-icon" width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M12.87 15.07l-2.54-2.51.03-.03A17.52 17.52 0 0014.07 6H17V4h-7V2H8v2H1v2h11.17C11.5 7.92 10.44 9.75 9 11.35 8.07 10.32 7.3 9.19 6.69 8h-2c.73 1.63 1.73 3.17 2.98 4.56l-5.09 5.02L4 19l5-5 3.11 3.11.76-2.04z"/>
            <path d="M18.5 10l-4.5 12h2l1.12-3h4.75L23 22h2l-4.5-12h-2zm-2.62 7l1.62-4.33L19.12 17h-3.24z"/>
          </svg>
          <span class="ai-translator-title">${t('aiTranslate')}</span>
        </div>
        <div class="ai-translator-header-right">
          <div class="ai-translator-lang-dropdown">
            <button class="ai-translator-lang-trigger" type="button" title="${t('targetLanguage')}" aria-expanded="false">
              <span class="ai-translator-lang-label">${escapeHtml(getTargetLangLabel(getEffectiveTargetLang()))}</span>
              <svg class="ai-translator-lang-caret" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M6 9l6 6 6-6"/>
              </svg>
            </button>
            <div class="ai-translator-lang-menu" hidden>
              ${buildTargetLangMenu(getEffectiveTargetLang())}
            </div>
          </div>
          <button class="ai-translator-close" type="button" title="${t('close')}" aria-label="${t('close')}">×</button>
        </div>
      </div>
      <div class="ai-translator-content">
        <div class="ai-translator-source">
          <div class="ai-translator-label-row">
            <div class="ai-translator-label">${t('original')}</div>
            <div class="ai-translator-label-tools">
              <button class="ai-translator-icon-btn ai-translator-speak-source" type="button" aria-label="${t('pronounceOriginal')}">
                ${SPEAKER_ICON}
              </button>
            </div>
          </div>
          <div class="ai-translator-text">${escapeHtml(text)}</div>
          <div class="ai-translator-phonetic" ${phonetic ? '' : 'hidden'}>${escapeHtml(phonetic)}</div>
        </div>
        <div class="ai-translator-divider"></div>
        <div class="ai-translator-result">
          <div class="ai-translator-label-row">
            <div class="ai-translator-label">${t('translation')}</div>
            <div class="ai-translator-label-tools">
              <button class="ai-translator-icon-btn ai-translator-speak-translation" type="button" aria-label="${t('pronounceTranslation')}" hidden>
                ${SPEAKER_ICON}
              </button>
            </div>
          </div>
          <div class="ai-translator-translation">
            <div class="ai-translator-loading"${pending ? '' : ' style="display: none;"'}>
              <div class="ai-translator-spinner"></div>
              <span>${t('translating')}</span>
            </div>
            ${pending ? `
            <div class="ai-translator-loading-lines">
              <div class="ai-translator-loading-line"></div>
              <div class="ai-translator-loading-line short"></div>
            </div>` : ''}
            <div class="ai-translator-result-body" ${pending ? 'hidden' : ''}>
              <div class="ai-translator-translation-text">${escapeHtml(translation)}</div>
            </div>
          </div>
        </div>
      </div>
      <div class="ai-translator-actions">
        <button class="ai-translator-btn ai-translator-copy" type="button" title="${t('copyTranslation')}">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
            <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
          </svg>
          ${t('copy')}
        </button>
      </div>
    `;
  }

  /**
   * Wire the two speaker buttons. The source one is live from the moment the
   * popup opens — hearing the word is the whole reason it is there, and it does
   * not need the translation to come back first. The translation one appears
   * once there is something to read out, and speaks in the target language
   * rather than a guess made from a handful of characters.
   */
  function setupPopupSpeech(popup) {
    speech.bindSpeakButton(
      popup.querySelector('.ai-translator-speak-source'),
      () => ({ text: popup.dataset.sourceText || '' })
    );
    const showTranslationSpeak = speech.bindSpeakButton(
      popup.querySelector('.ai-translator-speak-translation'),
      () => ({
        text: popup.querySelector('.ai-translator-translation-text')?.textContent || '',
        lang: popup.dataset.targetLang || getEffectiveTargetLang(),
      })
    );
    // translateText runs outside this closure and re-queries the popup by
    // selector, so it reaches the setter through the element it already has.
    popup._showTranslationSpeak = showTranslationSpeak;
    return showTranslationSpeak;
  }

  function showTranslationPopup(text, x, y) {
    hideTranslationPopup();

    // Ensure theme is applied
    applyTheme(settings.theme);

    state.translationPopup = document.createElement('div');
    state.translationPopup.className = 'ai-translator-popup';
    state.translationPopup.dataset.sourceText = text;
    state.translationPopup.innerHTML = buildPopupMarkup({ text, pending: true });

    // Position popup
    const popupWidth = 400;
    const popupHeight = 250;
    let posX = x + 10;
    let posY = y + 10;

    // Adjust position to stay within viewport
    if (posX + popupWidth > window.innerWidth) {
      posX = window.innerWidth - popupWidth - 20;
    }
    if (posY + popupHeight > window.innerHeight) {
      posY = y - popupHeight - 10;
    }
    if (posX < 10) posX = 10;
    if (posY < 10) posY = 10;

    state.translationPopup.style.left = `${posX}px`;
    state.translationPopup.style.top = `${posY}px`;

    document.body.appendChild(state.translationPopup);

    // Event listeners
    state.translationPopup.querySelector('.ai-translator-close').addEventListener('click', hideTranslationPopup);
    state.translationPopup.querySelector('.ai-translator-copy').addEventListener('click', () => {
      const translationText = state.translationPopup.querySelector('.ai-translator-translation-text')?.textContent;
      if (translationText && !translationText.includes(t('translating'))) {
        copyToClipboard(translationText);
        showCopyFeedback();
      }
    });
    setupPopupSpeech(state.translationPopup);
    const initialLang = setupLanguageDropdown(state.translationPopup, getEffectiveTargetLang(), (lang) => {
      translateText(state.translationPopup?.dataset.sourceText || text, lang);
    });

    // 添加拖动功能
    setupPopupDrag(state.translationPopup);

    // Trigger translation
    translateText(text, initialLang);
  }

  // 显示已完成的翻译结果（用于右键菜单翻译）
  function showTranslationResult(text, translation, phonetic = '') {
    hideTranslationPopup();

    // Ensure theme is applied
    applyTheme(settings.theme);

    state.translationPopup = document.createElement('div');
    state.translationPopup.className = 'ai-translator-popup';
    state.translationPopup.dataset.sourceText = text;
    state.translationPopup.innerHTML = buildPopupMarkup({ text, phonetic, translation });

    // 居中显示弹窗
    const popupWidth = 400;
    const popupHeight = 250;
    let posX = (window.innerWidth - popupWidth) / 2;
    let posY = (window.innerHeight - popupHeight) / 2;

    state.translationPopup.style.left = `${posX}px`;
    state.translationPopup.style.top = `${posY}px`;

    document.body.appendChild(state.translationPopup);

    // Event listeners
    state.translationPopup.querySelector('.ai-translator-close').addEventListener('click', hideTranslationPopup);
    state.translationPopup.querySelector('.ai-translator-copy').addEventListener('click', () => {
      const currentTranslation = state.translationPopup?.querySelector('.ai-translator-translation-text')?.textContent;
      if (currentTranslation && !currentTranslation.includes(t('translating'))) {
        copyToClipboard(currentTranslation);
        showCopyFeedback();
      }
    });
    const showTranslationSpeak = setupPopupSpeech(state.translationPopup);
    showTranslationSpeak(!!translation);
    setupLanguageDropdown(state.translationPopup, getEffectiveTargetLang(), (lang) => {
      translateText(state.translationPopup?.dataset.sourceText || text, lang);
    });

    const resultBody = state.translationPopup.querySelector('.ai-translator-result-body');
    if (resultBody) {
      resultBody.classList.add('ai-translator-reveal');
    }
    const translationTextEl = state.translationPopup.querySelector('.ai-translator-translation-text');
    if (translationTextEl) {
      translationTextEl.classList.add('ai-translator-translation-flow');
    }

    // 添加拖动功能
    setupPopupDrag(state.translationPopup);
  }

  // 设置弹窗拖动功能
  function setupPopupDrag(popup) {
    const header = popup.querySelector('.ai-translator-header');
    if (!header) return;

    let isDragging = false;
    let startX, startY, initialX, initialY;

    // Use AbortController so all listeners can be removed on popup close
    const dragAbort = new AbortController();
    popup._dragAbortController = dragAbort;

    header.style.cursor = 'move';

    header.addEventListener('mousedown', (e) => {
      // 忽略交互元素
      if (e.target.closest('button, select, option')) return;

      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;

      const rect = popup.getBoundingClientRect();
      initialX = rect.left;
      initialY = rect.top;

      popup.style.transition = 'none';
      e.preventDefault();
    }, { signal: dragAbort.signal });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;

      const deltaX = e.clientX - startX;
      const deltaY = e.clientY - startY;

      let newX = initialX + deltaX;
      let newY = initialY + deltaY;

      // 保持在视口内
      const popupRect = popup.getBoundingClientRect();
      newX = Math.max(0, Math.min(window.innerWidth - popupRect.width, newX));
      newY = Math.max(0, Math.min(window.innerHeight - popupRect.height, newY));

      popup.style.left = `${newX}px`;
      popup.style.top = `${newY}px`;
    }, { signal: dragAbort.signal });

    document.addEventListener('mouseup', () => {
      if (isDragging) {
        isDragging = false;
        popup.style.transition = '';
      }
    }, { signal: dragAbort.signal });
  }

  function hideTranslationPopup() {
    if (state.translationPopup) {
      if (state.translationPopup._langOutsideHandler) {
        document.removeEventListener('mousedown', state.translationPopup._langOutsideHandler);
      }
      if (state.translationPopup._dragAbortController) {
        state.translationPopup._dragAbortController.abort();
      }
      speech.stopSpeaking();
      state.translationPopup.remove();
      state.translationPopup = null;
    }
  }

  function setupLanguageDropdown(popup, selectedLang, onChange) {
    const trigger = popup.querySelector('.ai-translator-lang-trigger');
    const menu = popup.querySelector('.ai-translator-lang-menu');
    const label = popup.querySelector('.ai-translator-lang-label');
    if (!trigger || !menu || !label) return selectedLang;

    const normalized = normalizeTargetLang(selectedLang);
    label.textContent = getTargetLangLabel(normalized);
    popup.dataset.targetLang = normalized;

    const items = menu.querySelectorAll('.ai-translator-lang-item');
    items.forEach((item) => {
      item.classList.toggle('is-selected', item.dataset.lang === normalized);
    });

    const closeMenu = () => {
      if (menu.hidden) return;
      menu.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
    };

    const openMenu = () => {
      if (!menu.hidden) return;
      menu.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
    };

    trigger.addEventListener('click', (event) => {
      event.stopPropagation();
      if (menu.hidden) {
        openMenu();
      } else {
        closeMenu();
      }
    });

    menu.addEventListener('click', (event) => {
      const item = event.target.closest('.ai-translator-lang-item');
      if (!item) return;
      const lang = item.dataset.lang;
      if (!lang) return;
      label.textContent = item.textContent || getTargetLangLabel(lang);
      items.forEach((btn) => {
        btn.classList.toggle('is-selected', btn.dataset.lang === lang);
      });
      popup.dataset.targetLang = lang;
      closeMenu();
      if (typeof onChange === 'function') {
        onChange(lang);
      }
    });

    const outsideHandler = (event) => {
      if (!popup.contains(event.target)) {
        closeMenu();
        return;
      }
      if (!event.target.closest('.ai-translator-lang-dropdown')) {
        closeMenu();
      }
    };

    popup._langOutsideHandler = outsideHandler;
    document.addEventListener('mousedown', outsideHandler);

    return normalized;
  }

  function isSingleWordText(text) {
    if (!text) return false;
    const trimmed = text.trim();
    if (!trimmed) return false;
    if (/[\s\r\n\t]/.test(trimmed)) return false;
    return trimmed.length <= 40;
  }

  async function translateText(text, targetLangOverride = '') {
    const requestId = String(++state.translationRequestId);
    try {
      const isWord = isSingleWordText(text);
      const targetLang = targetLangOverride || getEffectiveTargetLang();
      if (!isExtensionContextAvailable()) {
        if (state.translationPopup) {
          const resultBody = state.translationPopup.querySelector('.ai-translator-result-body');
          const loadingEl = state.translationPopup.querySelector('.ai-translator-loading');
          const loadingLines = state.translationPopup.querySelector('.ai-translator-loading-lines');
          if (loadingEl) loadingEl.style.display = 'none';
          if (loadingLines) loadingLines.style.display = 'none';
          if (resultBody) {
            resultBody.hidden = false;
            resultBody.innerHTML = `<div class="ai-translator-error">${t('extensionContextInvalidated')}</div>`;
          }
        }
        return;
      }
      if (state.translationPopup) {
        state.translationPopup.dataset.requestId = requestId;
        state.translationPopup.dataset.targetLang = targetLang;
        const loadingEl = state.translationPopup.querySelector('.ai-translator-loading');
        const loadingLines = state.translationPopup.querySelector('.ai-translator-loading-lines');
        const resultBody = state.translationPopup.querySelector('.ai-translator-result-body');
        const phoneticEl = state.translationPopup.querySelector('.ai-translator-phonetic');
        if (loadingEl) loadingEl.style.display = 'flex';
        if (loadingLines) loadingLines.style.display = 'flex';
        if (resultBody) resultBody.hidden = true;
        if (phoneticEl) phoneticEl.hidden = true;
        state.translationPopup._showTranslationSpeak?.(false);
      }
      const response = await ctx.requestTranslation({
        type: 'TRANSLATE',
        text: text,
        targetLang: targetLang,
        mode: isWord ? 'word' : 'text'
      });

      if (!state.translationPopup || state.translationPopup.dataset.requestId !== requestId) return;

      const translationTextEl = state.translationPopup.querySelector('.ai-translator-translation-text');
      const resultBody = state.translationPopup.querySelector('.ai-translator-result-body');
      const loadingEl = state.translationPopup.querySelector('.ai-translator-loading');
      const loadingLines = state.translationPopup.querySelector('.ai-translator-loading-lines');
      const phoneticEl = state.translationPopup.querySelector('.ai-translator-phonetic');
      const showTranslationSpeak = state.translationPopup._showTranslationSpeak;

      if (response.error) {
        if (loadingEl) loadingEl.style.display = 'none';
        if (loadingLines) loadingLines.style.display = 'none';
        if (resultBody) {
          resultBody.hidden = false;
          resultBody.innerHTML = `<div class="ai-translator-error">${escapeHtml(response.error)}</div>`;
        }
      } else {
        if (loadingEl) loadingEl.style.display = 'none';
        if (loadingLines) loadingLines.style.display = 'none';
        if (translationTextEl) {
          translationTextEl.textContent = response.translation || '';
          translationTextEl.classList.remove('ai-translator-translation-flow');
          // Trigger flow animation
          void translationTextEl.offsetWidth;
          translationTextEl.classList.add('ai-translator-translation-flow');
        }
        if (phoneticEl) {
          if (response.phonetic) {
            phoneticEl.textContent = response.phonetic;
            phoneticEl.hidden = false;
          } else {
            phoneticEl.hidden = true;
          }
        }
        showTranslationSpeak?.(!!response.translation);
        if (resultBody) {
          resultBody.hidden = false;
          resultBody.classList.remove('ai-translator-reveal');
          void resultBody.offsetWidth;
          resultBody.classList.add('ai-translator-reveal');
        }
      }
    } catch (error) {
      console.error('AI Translator: Translation failed', error);
      if (state.translationPopup && state.translationPopup.dataset.requestId === requestId) {
        const resultBody = state.translationPopup.querySelector('.ai-translator-result-body');
        const loadingEl = state.translationPopup.querySelector('.ai-translator-loading');
        const loadingLines = state.translationPopup.querySelector('.ai-translator-loading-lines');
        if (loadingEl) loadingEl.style.display = 'none';
        if (loadingLines) loadingLines.style.display = 'none';
        if (resultBody) {
          resultBody.hidden = false;
          const message = isExtensionContextInvalidated(error)
            ? t('extensionContextInvalidated')
            : t('translationFailed');
          resultBody.innerHTML = `<div class="ai-translator-error">${message}</div>`;
        }
      }
    }
  }

  function showCopyFeedback() {
    const copyBtn = state.translationPopup?.querySelector('.ai-translator-copy');
    if (copyBtn) {
      const originalText = copyBtn.innerHTML;
      copyBtn.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M20 6L9 17l-5-5"/>
        </svg>
        ${t('copied')}
      `;
      setTimeout(() => {
        if (copyBtn) copyBtn.innerHTML = originalText;
      }, 1500);
    }
  }

  ctx.showTranslationPopup = showTranslationPopup;
  ctx.showTranslationResult = showTranslationResult;
  ctx.hideTranslationPopup = hideTranslationPopup;
  ctx.setupLanguageDropdown = setupLanguageDropdown;
  ctx.translateText = translateText;
  ctx.isSingleWordText = isSingleWordText;
})();
