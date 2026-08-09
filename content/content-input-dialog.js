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
  const speech = ctx.speech;

  // The dialog is a scratchpad: you paste something in and want it in a
  // particular language *now*. Reading the target straight off the settings
  // page made every one-off a trip through settings — and left the setting
  // changed for page and selection translation afterwards. So the dialog keeps
  // its own target, whatever was last picked in it.
  //
  // It lives in local storage, not sync: this is one device's scratchpad
  // habit, and writing it to sync would reach across and retarget the dialog
  // on every other device. Changing the target language in settings clears it
  // (see below) — an explicit choice there is the stronger signal, and a
  // dialog that ignored it would be the same complaint over again.
  const INPUT_TARGET_LANG_KEY = 'inputDialogTargetLang';
  let rememberedTargetLang = '';
  // The read below is async, and this script runs in every frame. Anything that
  // decides the target for real — a pick, or a settings change — settles the
  // value, and a read that lands afterwards must not put the old one back.
  let targetLangSettled = false;

  function loadRememberedTargetLang() {
    if (!isExtensionContextAvailable()) return;
    try {
      chrome.storage.local.get(INPUT_TARGET_LANG_KEY, (result) => {
        if (chrome.runtime.lastError || targetLangSettled) return;
        targetLangSettled = true;
        rememberedTargetLang = result?.[INPUT_TARGET_LANG_KEY] || '';
      });
    } catch (error) {
      // Extension context went away; the settings default still works.
    }
  }

  function rememberTargetLang(lang) {
    const next = lang || '';
    targetLangSettled = true;
    // Every frame on the page runs this listener, so a settings change asks all
    // of them to clear at once. Only the frame that actually holds a different
    // value needs to write, or a page full of iframes writes the same string
    // once per frame.
    if (next === rememberedTargetLang) return;
    rememberedTargetLang = next;
    if (!isExtensionContextAvailable()) return;
    try {
      chrome.storage.local.set({ [INPUT_TARGET_LANG_KEY]: rememberedTargetLang });
    } catch (error) {
      // Same as above: losing the memory is not worth failing the translation.
    }
  }

  function getInputTargetLang() {
    return rememberedTargetLang || getEffectiveTargetLang();
  }

  // What an open dialog is actually set to. The dropdown writes its pick to
  // dataset.targetLang, so that is the language the header is showing — both
  // translating and reading aloud follow what the user can see, even if a
  // settings change has since moved the default out from under the open
  // dialog. getInputTargetLang() is only reached before anything is picked.
  function getShownTargetLang() {
    return state.inputDialog?.dataset.targetLang || getInputTargetLang();
  }

  loadRememberedTargetLang();

  if (chrome?.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, namespace) => {
      if (namespace === 'sync' && changes.targetLang) {
        // Someone went and set a default explicitly. Follow it.
        rememberTargetLang('');
      } else if (namespace === 'local' && changes[INPUT_TARGET_LANG_KEY]) {
        // Another tab's dialog picked a language; keep this one in step. This
        // is the stored value arriving, so it settles the read above too.
        targetLangSettled = true;
        rememberedTargetLang = changes[INPUT_TARGET_LANG_KEY].newValue || '';
      }
    });
  }

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
      <div class="ai-translator-input-modal" role="dialog" aria-modal="true" aria-label="${t('inputTextTranslation')}">
        <div class="ai-translator-header">
          <div class="ai-translator-header-left">
            <svg class="ai-translator-title-icon" width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M12.87 15.07l-2.54-2.51.03-.03A17.52 17.52 0 0014.07 6H17V4h-7V2H8v2H1v2h11.17C11.5 7.92 10.44 9.75 9 11.35 8.07 10.32 7.3 9.19 6.69 8h-2c.73 1.63 1.73 3.17 2.98 4.56l-5.09 5.02L4 19l5-5 3.11 3.11.76-2.04z"/>
              <path d="M18.5 10l-4.5 12h2l1.12-3h4.75L23 22h2l-4.5-12h-2zm-2.62 7l1.62-4.33L19.12 17h-3.24z"/>
            </svg>
            <span class="ai-translator-title">${t('inputTextTranslation')}</span>
          </div>
          <div class="ai-translator-header-right">
            <span class="ai-translator-lang-hint">${t('translateTo')}</span>
            <div class="ai-translator-lang-dropdown">
              <button class="ai-translator-lang-trigger" type="button" title="${t('targetLanguage')}" aria-expanded="false">
                <span class="ai-translator-lang-label">${escapeHtml(getTargetLangLabel(getInputTargetLang()))}</span>
                <svg class="ai-translator-lang-caret" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M6 9l6 6 6-6"/>
                </svg>
              </button>
              <div class="ai-translator-lang-menu" hidden>
                ${buildTargetLangMenu(getInputTargetLang())}
              </div>
            </div>
            <button class="ai-translator-close" type="button" title="${t('close')}" aria-label="${t('close')}">×</button>
          </div>
        </div>
        <div class="ai-translator-input-body">
          <div class="ai-translator-input-section">
            <div class="ai-translator-label-row">
              <label class="ai-translator-label" for="ai-translator-input-text">${t('inputText')}</label>
              <div class="ai-translator-label-tools">
                <span class="ai-translator-input-phonetic" id="ai-translator-input-phonetic" hidden></span>
                <button class="ai-translator-icon-btn ai-translator-input-speak" id="ai-translator-input-speak" type="button" aria-label="${t('pronounceOriginal')}" hidden>
                  ${speech.SPEAKER_ICON}
                </button>
              </div>
            </div>
            <textarea
              class="ai-translator-input-textarea"
              id="ai-translator-input-text"
              placeholder="${t('inputPlaceholder')}"
              rows="4"
            ></textarea>
            <div class="ai-translator-input-hint">${t('translateShortcutHint')}</div>
          </div>
          <div class="ai-translator-input-section ai-translator-result-section" id="ai-translator-result-section" hidden>
            <div class="ai-translator-label-row">
              <label class="ai-translator-label">${t('translatedText')}</label>
              <div class="ai-translator-label-tools">
                <button class="ai-translator-icon-btn ai-translator-input-speak-result" id="ai-translator-input-speak-result" type="button" aria-label="${t('pronounceTranslation')}" hidden>
                  ${speech.SPEAKER_ICON}
                </button>
              </div>
            </div>
            <div class="ai-translator-input-result" id="ai-translator-result-text"></div>
          </div>
        </div>
        <div class="ai-translator-input-footer">
          <button class="ai-translator-btn ai-translator-input-btn-copy" id="ai-translator-copy-result" type="button" hidden>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
              <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
            </svg>
            ${t('copyTranslation')}
          </button>
          <button class="ai-translator-btn ai-translator-btn-primary" id="ai-translator-do-translate" type="button">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <path d="M12.87 15.07l-2.54-2.51.03-.03A17.52 17.52 0 0014.07 6H17V4h-7V2H8v2H1v2h11.17C11.5 7.92 10.44 9.75 9 11.35"/>
              <path d="M18.5 10l-4.5 12h2l1.12-3h4.75L23 22h2l-4.5-12h-2z"/>
            </svg>
            ${t('translate')}
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(state.inputDialog);

    const dialog = state.inputDialog;
    const textarea = dialog.querySelector('#ai-translator-input-text');
    const resultSection = dialog.querySelector('#ai-translator-result-section');
    const resultText = dialog.querySelector('#ai-translator-result-text');
    const phoneticEl = dialog.querySelector('#ai-translator-input-phonetic');
    const copyBtn = dialog.querySelector('#ai-translator-copy-result');
    const translateBtn = dialog.querySelector('#ai-translator-do-translate');

    setTimeout(() => textarea.focus(), 100);

    // The source button reads what is in the textarea right now, so it works
    // before a translation has been requested — the point is to hear how the
    // word you just typed is pronounced.
    const showSourceSpeak = speech.bindSpeakButton(
      dialog.querySelector('#ai-translator-input-speak'),
      () => ({ text: textarea.value })
    );
    // The translation's language is known, so it is passed explicitly rather
    // than guessed: short translations are exactly what language detection
    // gets wrong most often.
    const showResultSpeak = speech.bindSpeakButton(
      dialog.querySelector('#ai-translator-input-speak-result'),
      () => ({ text: resultText.textContent || '', lang: getShownTargetLang() })
    );

    function syncSourceSpeak() {
      showSourceSpeak(!!textarea.value.trim());
    }

    syncSourceSpeak();
    textarea.addEventListener('input', syncSourceSpeak);

    dialog.querySelector('.ai-translator-close').addEventListener('click', hideInputDialog);
    dialog.querySelector('.ai-translator-input-overlay').addEventListener('click', hideInputDialog);

    const translateInputText = async (targetLangOverride = '') => {
      const text = textarea.value.trim();
      if (!text) return;

      resultSection.hidden = false;
      dialog.dataset.sourceText = text;
      resultText.innerHTML = `<div class="ai-translator-input-loading"><div class="ai-translator-spinner"></div><span>${t('translating')}</span></div>`;
      setPhonetic('');
      showResultSpeak(false);
      copyBtn.hidden = true;

      try {
        if (!isExtensionContextAvailable()) {
          resultText.innerHTML = `<div class="ai-translator-input-error">${t('extensionContextInvalidated')}</div>`;
          return;
        }
        const targetLang = targetLangOverride || getShownTargetLang();
        const response = await ctx.requestTranslation({
          type: 'TRANSLATE',
          text: text,
          targetLang: targetLang,
          mode: isInputDictionaryText(text) ? 'word' : 'text',
          // 这段文字是用户敲进来的，跟当前页面没有任何关系。不声明的话，内置
          // 引擎会拿页面语言当源语言，于是在英文页面上输入“动画”翻成英文就变成
          // en→en，被同语言短路原样退回。
          standaloneText: true
        });

        if (response.error) {
          resultText.innerHTML = `<div class="ai-translator-input-error">${escapeHtml(response.error)}</div>`;
          return;
        }

        resultText.textContent = response.translation;
        // The phonetic belongs to the word that was typed, not to its
        // translation, so it sits beside the input — matching where the
        // selection popup puts it.
        setPhonetic(response.isWord === true ? (response.phonetic || '') : '');
        showResultSpeak(!!response.translation);
        copyBtn.hidden = !response.translation;
      } catch (error) {
        const message = isExtensionContextInvalidated(error)
          ? t('extensionContextInvalidated')
          : t('translationFailed');
        resultText.innerHTML = `<div class="ai-translator-input-error">${message}</div>`;
        setPhonetic('');
        showResultSpeak(false);
        copyBtn.hidden = true;
      }
    };

    function setPhonetic(value) {
      if (!phoneticEl) return;
      phoneticEl.textContent = value;
      phoneticEl.hidden = !value;
    }

    translateBtn.addEventListener('click', async () => {
      await translateInputText();
    });

    copyBtn.addEventListener('click', async () => {
      const text = resultText.textContent;
      if (!text || text.includes(t('translating'))) return;
      await copyToClipboard(text);
      const originalHTML = copyBtn.innerHTML;
      copyBtn.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <path d="M20 6L9 17l-5-5"/>
        </svg>
        ${t('copied')}
      `;
      setTimeout(() => copyBtn.innerHTML = originalHTML, 1500);
    });

    // Enter key to translate (Ctrl+Enter or Cmd+Enter)
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        translateBtn.click();
      }
    });

    if (ctx.setupLanguageDropdown) {
      ctx.setupLanguageDropdown(dialog, getInputTargetLang(), (lang) => {
        rememberTargetLang(lang);
        // Picking a language with the box empty is someone setting up before
        // they type, not asking for a translation.
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
      speech.stopSpeaking();
      state.inputDialog.remove();
      state.inputDialog = null;
      document.removeEventListener('keydown', handleInputDialogEscape, true);
      document.removeEventListener('focusin', blockHostFocusTrap, true);
      document.removeEventListener('focusout', blockHostFocusTrap, true);
    }
  }

  ctx.showInputTranslateDialog = showInputTranslateDialog;
})();
