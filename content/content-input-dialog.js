// AI Translator Content Script Input Dialog
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
  const getTargetLangLabel = ctx.getTargetLangLabel;
  const buildTargetLangMenu = ctx.buildTargetLangMenu;
  const isExtensionContextAvailable = ctx.isExtensionContextAvailable;
  const isExtensionContextInvalidated = ctx.isExtensionContextInvalidated;

  function isInputDictionaryText(text) {
    if (!text) return false;
    const trimmed = text.trim();
    if (!trimmed) return false;
    if (/[\r\n\t]/.test(trimmed)) return false;
    if (trimmed.length > 80) return false;
    if (/[=+\-*/^<>]/.test(trimmed)) return false;
    const segments = trimmed.split(/\s+/).filter(Boolean);
    return segments.length >= 1 && segments.length <= 4;
  }

  function showInputTranslateDialog() {
    if (state.inputDialog) {
      hideInputDialog();
    }

    // Ensure theme is applied
    applyTheme(settings.theme);

    state.inputDialog = document.createElement('div');
    state.inputDialog.id = 'ai-translator-input-dialog';
    state.inputDialog.innerHTML = `
      <div class="ai-translator-input-overlay"></div>
      <div class="ai-translator-input-modal">
        <div class="ai-translator-header">
          <div class="ai-translator-header-left">
            <svg class="ai-translator-title-icon" width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M12.87 15.07l-2.54-2.51.03-.03A17.52 17.52 0 0014.07 6H17V4h-7V2H8v2H1v2h11.17C11.5 7.92 10.44 9.75 9 11.35 8.07 10.32 7.3 9.19 6.69 8h-2c.73 1.63 1.73 3.17 2.98 4.56l-5.09 5.02L4 19l5-5 3.11 3.11.76-2.04z"/>
              <path d="M18.5 10l-4.5 12h2l1.12-3h4.75L23 22h2l-4.5-12h-2zm-2.62 7l1.62-4.33L19.12 17h-3.24z"/>
            </svg>
            <span class="ai-translator-title">${t('inputTextTranslation')}</span>
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
            <button class="ai-translator-close" title="${t('close')}">×</button>
          </div>
        </div>
        <div class="ai-translator-input-body">
          <div class="ai-translator-input-section">
            <label class="ai-translator-input-label">${t('inputText')}</label>
            <textarea 
              class="ai-translator-input-textarea" 
              id="ai-translator-input-text"
              placeholder="${t('inputPlaceholder')}"
              rows="4"
            ></textarea>
          </div>
          <div class="ai-translator-input-actions">
            <button class="ai-translator-btn ai-translator-btn-primary" id="ai-translator-do-translate">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M12.87 15.07l-2.54-2.51.03-.03A17.52 17.52 0 0014.07 6H17V4h-7V2H8v2H1v2h11.17C11.5 7.92 10.44 9.75 9 11.35"/>
                <path d="M18.5 10l-4.5 12h2l1.12-3h4.75L23 22h2l-4.5-12h-2z"/>
              </svg>
              ${t('translate')}
            </button>
          </div>
          <div class="ai-translator-input-section ai-translator-result-section" id="ai-translator-result-section" style="display: none;">
            <label class="ai-translator-input-label">${t('translatedText')}</label>
            <div class="ai-translator-input-result" id="ai-translator-result-text"></div>
            <div class="ai-translator-input-meta" id="ai-translator-input-meta" hidden>
              <span class="ai-translator-input-phonetic" id="ai-translator-input-phonetic"></span>
              <button class="ai-translator-icon-btn ai-translator-input-speak" id="ai-translator-input-speak" title="${t('pronounce')}" hidden>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M4 9v6h4l5 4V5L8 9H4z"/>
                  <path d="M16 9a5 5 0 010 6"/>
                  <path d="M19 7a8 8 0 010 10"/>
                </svg>
              </button>
            </div>
            <button class="ai-translator-btn ai-translator-input-btn-copy" id="ai-translator-copy-result">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
              </svg>
              ${t('copyTranslation')}
            </button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(state.inputDialog);
    
    const textarea = state.inputDialog.querySelector('#ai-translator-input-text');
    setTimeout(() => textarea.focus(), 100);

    state.inputDialog.querySelector('.ai-translator-close').addEventListener('click', hideInputDialog);
    state.inputDialog.querySelector('.ai-translator-input-overlay').addEventListener('click', hideInputDialog);
    const speakBtn = state.inputDialog.querySelector('#ai-translator-input-speak');
    if (speakBtn) {
      speakBtn.addEventListener('click', () => {
        const sourceText = state.inputDialog?.dataset.sourceText || textarea.value.trim();
        if (!sourceText) return;
        if (ctx.speakText) {
          ctx.speakText(sourceText);
        }
      });
    }

    const translateInputText = async (targetLangOverride = '') => {
      const text = textarea.value.trim();
      if (!text) return;
      
      const resultSection = state.inputDialog.querySelector('#ai-translator-result-section');
      const resultText = state.inputDialog.querySelector('#ai-translator-result-text');
      const metaEl = state.inputDialog.querySelector('#ai-translator-input-meta');
      const phoneticEl = state.inputDialog.querySelector('#ai-translator-input-phonetic');
      const speakEl = state.inputDialog.querySelector('#ai-translator-input-speak');
      
      resultSection.style.display = 'block';
      state.inputDialog.dataset.sourceText = text;
      resultText.innerHTML = `<div class="ai-translator-input-loading"><div class="ai-translator-spinner"></div><span>${t('translating')}</span></div>`;
      if (metaEl) metaEl.hidden = true;
      if (phoneticEl) phoneticEl.textContent = '';
      if (speakEl) speakEl.hidden = true;
      
      try {
        if (!isExtensionContextAvailable()) {
          resultText.innerHTML = `<div class="ai-translator-input-error">${t('extensionContextInvalidated')}</div>`;
          return;
        }
        const targetLang = targetLangOverride || state.inputDialog.dataset.targetLang || settings.targetLang;
        const response = await chrome.runtime.sendMessage({
          type: 'TRANSLATE',
          text: text,
          targetLang: targetLang,
          mode: isInputDictionaryText(text) ? 'word' : 'text'
        });
        
        if (response.error) {
          resultText.innerHTML = `<div class="ai-translator-input-error">${escapeHtml(response.error)}</div>`;
        } else {
          resultText.textContent = response.translation;
          const isDictionary = response.isWord === true;
          if (metaEl) metaEl.hidden = !isDictionary;
          if (speakEl) speakEl.hidden = !isDictionary;
          if (phoneticEl) {
            if (isDictionary && response.phonetic) {
              phoneticEl.textContent = response.phonetic;
              phoneticEl.hidden = false;
            } else {
              phoneticEl.textContent = '';
              phoneticEl.hidden = true;
            }
          }
        }
      } catch (error) {
        const message = isExtensionContextInvalidated(error)
          ? t('extensionContextInvalidated')
          : t('translationFailed');
        resultText.innerHTML = `<div class="ai-translator-input-error">${message}</div>`;
        if (metaEl) metaEl.hidden = true;
        if (phoneticEl) phoneticEl.textContent = '';
        if (speakEl) speakEl.hidden = true;
      }
    };

    state.inputDialog.querySelector('#ai-translator-do-translate').addEventListener('click', async () => {
      await translateInputText();
    });

    state.inputDialog.querySelector('#ai-translator-copy-result').addEventListener('click', async () => {
      const resultText = state.inputDialog.querySelector('#ai-translator-result-text').textContent;
      if (resultText && !resultText.includes(t('translating'))) {
        await copyToClipboard(resultText);
        const copyBtn = state.inputDialog.querySelector('#ai-translator-copy-result');
        const originalHTML = copyBtn.innerHTML;
        copyBtn.innerHTML = `
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M20 6L9 17l-5-5"/>
          </svg>
          ${t('copied')}
        `;
        setTimeout(() => copyBtn.innerHTML = originalHTML, 1500);
      }
    });

    // Enter key to translate (Ctrl+Enter or Cmd+Enter)
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        state.inputDialog.querySelector('#ai-translator-do-translate').click();
      }
    });

    if (ctx.setupLanguageDropdown) {
      ctx.setupLanguageDropdown(state.inputDialog, getEffectiveTargetLang(), (lang) => {
        const text = textarea.value.trim();
        if (!text) return;
        translateInputText(lang);
      });
    }

    // Escape to close (capture phase to intercept before other keydown handlers)
    document.addEventListener('keydown', handleInputDialogEscape, true);

    // Prevent host-page focus traps (e.g. Jira/Atlaskit modals built on
    // focus-lock) from stealing focus out of our dialog. Such traps listen for
    // focus events bubbling to `document` and forcibly redirect focus back into
    // their own modal whenever focus lands outside it — which would silently
    // route the user's keystrokes into the host modal instead of our textarea.
    // We intercept focus events targeting our dialog in the capture phase and
    // stop them before the host page's bubble-phase listeners can react.
    document.addEventListener('focusin', blockHostFocusTrap, true);
    document.addEventListener('focusout', blockHostFocusTrap, true);
  }

  function handleInputDialogEscape(e) {
    if (e.key === 'Escape' && state.inputDialog) {
      e.stopImmediatePropagation();
      hideInputDialog();
    }
  }

  function blockHostFocusTrap(e) {
    const dialog = state.inputDialog;
    if (dialog && (e.target === dialog || dialog.contains(e.target))) {
      e.stopImmediatePropagation();
    }
  }

  function hideInputDialog() {
    if (state.inputDialog) {
      if (state.inputDialog._langOutsideHandler) {
        document.removeEventListener('mousedown', state.inputDialog._langOutsideHandler);
      }
      state.inputDialog.remove();
      state.inputDialog = null;
      document.removeEventListener('keydown', handleInputDialogEscape, true);
      document.removeEventListener('focusin', blockHostFocusTrap, true);
      document.removeEventListener('focusout', blockHostFocusTrap, true);
    }
  }

  ctx.showInputTranslateDialog = showInputTranslateDialog;
})();
