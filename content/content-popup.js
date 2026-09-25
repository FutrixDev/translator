// Blab Translation Content Script Popup
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

  // 翻译图标：卡片标题、OCR 的「翻译」按钮和划词图标共用这一份路径。
  const TRANSLATE_ICON_PATHS = '<path d="M12.87 15.07l-2.54-2.51.03-.03A17.52 17.52 0 0014.07 6H17V4h-7V2H8v2H1v2h11.17C11.5 7.92 10.44 9.75 9 11.35 8.07 10.32 7.3 9.19 6.69 8h-2c.73 1.63 1.73 3.17 2.98 4.56l-5.09 5.02L4 19l5-5 3.11 3.11.76-2.04z"/>'
    + '<path d="M18.5 10l-4.5 12h2l1.12-3h4.75L23 22h2l-4.5-12h-2zm-2.62 7l1.62-4.33L19.12 17h-3.24z"/>';

  function translateIconSvg(size, className = '') {
    const cls = className ? ` class="${className}"` : '';
    return `<svg${cls} width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${TRANSLATE_ICON_PATHS}</svg>`;
  }

  /**
   * The popup markup, shared by the live-translation and the
   * already-translated entry points. They rendered two near-identical copies
   * of this before; every control added to one had to be remembered in the
   * other, and the pronunciation buttons would have made that four.
   *
   * @param {{text: string, phonetic?: string, translation?: string, pending?: boolean}} options
   *   `pending` renders the loading state instead of a finished translation.
   */
  // `sourceLabel` overrides the "Original" heading. Image OCR uses it to say
  // which language it recognised ("Original · 日本語"): the phonetic slot below
  // would be the obvious place, but translateText hides that on every
  // re-translation, and the recognised language does not stop being true
  // because the user picked a different target.
  function buildPopupMarkup({ text, phonetic = '', translation = '', pending = false, sourceLabel = '' }) {
    return `
      <div class="ai-translator-header">
        <div class="ai-translator-header-left">
          ${translateIconSvg(20, 'ai-translator-title-icon')}
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
            <div class="ai-translator-label">${escapeHtml(sourceLabel || t('original'))}</div>
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
            <span class="ai-translator-engine-tag" hidden></span>
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
            <div class="ai-translator-error" role="alert" hidden></div>
          </div>
        </div>
      </div>
      <div class="ai-translator-actions">
        <button class="ai-translator-btn ai-translator-btn-primary ai-translator-translate-btn" type="button" title="${t('translate')}" hidden>
          ${translateIconSvg(16)}
          ${t('translate')}
        </button>
        <button class="ai-translator-btn ai-translator-retranslate" type="button" hidden>${t('cardRetranslate')}</button>
        <button class="ai-translator-btn ai-translator-switch-engine" type="button" hidden></button>
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

  // 缩高时卡片至少留这么高：标题、原文一行、译文几行、操作行。
  const CARD_MIN_HEIGHT = 160;

  function rectOf(rect) {
    return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
  }

  function isEmptyRect(rect) {
    return !rect || (rect.left === 0 && rect.top === 0 && rect.right === 0 && rect.bottom === 0);
  }

  /**
   * 划词卡片贴着选区放。打开时存下 Range 的克隆和当时的外接矩形、末行矩形；
   * 每次重新放先用 Range 现算，Range 的节点已不在文档里（矩形全 0）就用存下的。
   * 没有 Range（悬浮球、右键菜单拿不到选区时）居中。
   */
  function anchorCard(range) {
    if (!range) return null;
    const saved = range.cloneRange();
    const rects = saved.getClientRects();
    const lastLine = rects.length ? rectOf(rects[rects.length - 1]) : null;
    const node = saved.commonAncestorContainer;
    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    return {
      range: saved,
      rect: rectOf(saved.getBoundingClientRect()),
      lastLine,
      rtl: !!element && getComputedStyle(element).direction === 'rtl',
    };
  }

  function placeCard(popup, anchor) {
    popup.style.maxHeight = '';
    const size = { width: popup.offsetWidth, height: popup.offsetHeight };
    const viewport = {
      width: document.documentElement.clientWidth || window.innerWidth,
      height: window.innerHeight,
    };
    if (!anchor) {
      popup.style.left = `${Math.max(0, (viewport.width - size.width) / 2)}px`;
      popup.style.top = `${Math.max(0, (viewport.height - size.height) / 2)}px`;
      return;
    }
    const live = rectOf(anchor.range.getBoundingClientRect());
    const place = ctx.placeBeside(size, isEmptyRect(live) ? anchor.rect : live, {
      viewport,
      prefer: 'below',
      rtl: anchor.rtl,
      minHeight: CARD_MIN_HEIGHT,
      fallback: anchor.lastLine,
    });
    popup.style.left = `${place.left}px`;
    popup.style.top = `${place.top}px`;
    if (place.maxHeight != null) popup.style.maxHeight = `${place.maxHeight}px`;
  }

  // 卡片尺寸每变一次（加载 → 结果 → 错误 → 操作行出现）就重新放，用户拖过就不再管。
  function keepCardPlaced(popup, anchor) {
    placeCard(popup, anchor);
    const observer = new ResizeObserver(() => {
      if (popup._userMoved || !popup.isConnected) return;
      placeCard(popup, anchor);
    });
    observer.observe(popup);
    popup._resizeObserver = observer;
  }

  function showTranslationPopup(text, { range = null } = {}) {
    hideTranslationPopup();

    // Ensure theme is applied
    applyTheme(settings.theme);

    const popup = document.createElement('div');
    state.translationPopup = popup;
    popup.className = 'ai-translator-popup';
    popup.dataset.sourceText = text;
    popup.innerHTML = buildPopupMarkup({ text, pending: true });
    document.body.appendChild(popup);
    keepCardPlaced(popup, anchorCard(range));

    // Event listeners
    popup.querySelector('.ai-translator-close').addEventListener('click', hideTranslationPopup);
    popup.querySelector('.ai-translator-copy').addEventListener('click', () => {
      const translationText = popup.querySelector('.ai-translator-translation-text')?.textContent;
      if (translationText && !translationText.includes(t('translating'))) {
        copyToClipboard(translationText);
        showCopyFeedback();
      }
    });
    setupPopupSpeech(popup);
    const initialLang = setupLanguageDropdown(popup, getEffectiveTargetLang(), (lang) => {
      translateText(popup.dataset.sourceText || text, lang);
    });
    wireCardActions(popup);

    // 添加拖动功能
    setupPopupDrag(popup);

    // Trigger translation
    translateText(text, initialLang);
  }

  // 显示已完成的翻译结果（用于右键菜单翻译）
  /**
   * `options.sourceLabel` renames the "Original" heading; see buildPopupMarkup.
   *
   * `options.recognizeOnly` is for image OCR with the translate step switched
   * off, where the recognised text is the whole result: the translation half is
   * hidden rather than left blank, and Copy takes the source text. It is not a
   * dead end — picking a target language from the dropdown translates, and
   * translateText brings the hidden half back.
   */
  function showTranslationResult(text, translation, phonetic = '', options = {}) {
    hideTranslationPopup();

    // Ensure theme is applied
    applyTheme(settings.theme);

    state.translationPopup = document.createElement('div');
    state.translationPopup.className = 'ai-translator-popup';
    state.translationPopup.dataset.sourceText = text;
    state.translationPopup.innerHTML = buildPopupMarkup({
      text,
      phonetic,
      translation,
      sourceLabel: options.sourceLabel || ''
    });
    if (options.recognizeOnly) {
      state.translationPopup.querySelector('.ai-translator-divider')?.setAttribute('hidden', '');
      state.translationPopup.querySelector('.ai-translator-result')?.setAttribute('hidden', '');
      // Step 2, on demand: the same translation the dropdown would run, one
      // labelled click instead of a language choice. translateText brings the
      // hidden half back and hides this button again.
      const translateBtn = state.translationPopup.querySelector('.ai-translator-translate-btn');
      if (translateBtn) {
        translateBtn.hidden = false;
        translateBtn.addEventListener('click', () => {
          const popup = state.translationPopup;
          if (!popup) return;
          translateText(popup.dataset.sourceText || text, popup.dataset.targetLang || '');
        });
      }
    }

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
      const popup = state.translationPopup;
      if (!popup) return;
      // With the translation half hidden there is nothing else to copy, and the
      // recognised text is what the user came for. Reads the DOM rather than a
      // captured flag so it corrects itself the moment a translation arrives.
      const wanted = popup.querySelector('.ai-translator-result')?.hasAttribute('hidden')
        ? popup.dataset.sourceText
        : popup.querySelector('.ai-translator-translation-text')?.textContent;
      if (wanted && !wanted.includes(t('translating'))) {
        copyToClipboard(wanted);
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

    wireCardActions(state.translationPopup);

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
      // 用户拖过的卡片不再被 ResizeObserver 挪回去。
      popup._userMoved = true;
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
      state.translationPopup._resizeObserver?.disconnect();
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

  // 卡片「译文」一格里的几块：加载态、译文、错误、音标。
  function cardParts(popup) {
    const q = (selector) => popup.querySelector(selector);
    return {
      loading: [q('.ai-translator-loading'), q('.ai-translator-loading-lines')].filter(Boolean),
      resultBody: q('.ai-translator-result-body'),
      text: q('.ai-translator-translation-text'),
      error: q('.ai-translator-error'),
      phonetic: q('.ai-translator-phonetic'),
    };
  }

  function setCardLoading(parts, loading) {
    for (const el of parts.loading) el.style.display = loading ? 'flex' : 'none';
  }

  /**
   * 卡片出错只有这一种画法：错误写进独立的错误元素（textContent，不拼 HTML），
   * 译文清空藏起 —— 旧译文是另一次请求的结果，留着会被当成这一次的。
   */
  function showCardError(popup, message) {
    const parts = cardParts(popup);
    setCardLoading(parts, false);
    if (parts.text) parts.text.textContent = '';
    if (parts.resultBody) parts.resultBody.hidden = true;
    parts.error.textContent = message;
    parts.error.hidden = false;
    popup._showTranslationSpeak?.(false);
  }

  // 重译 / 换引擎：请求在路上时禁用。
  function setCardActionsBusy(popup, busy) {
    for (const btn of popup.querySelectorAll('.ai-translator-retranslate, .ai-translator-switch-engine')) {
      btn.disabled = busy;
    }
  }

  /**
   * 一次请求结算（成功或失败）之后：重译出现；引擎标签说这次是谁译的；另一边
   * 此刻能用才给「换引擎」，按钮文字说换到哪边。
   */
  async function settleCardActions(popup, engine) {
    const retranslate = popup.querySelector('.ai-translator-retranslate');
    const switchBtn = popup.querySelector('.ai-translator-switch-engine');
    const tag = popup.querySelector('.ai-translator-engine-tag');
    retranslate.hidden = false;
    retranslate.disabled = false;
    tag.textContent = engine ? t(engine === 'builtin' ? 'cardEngineBuiltin' : 'cardEngineAi') : '';
    tag.hidden = !engine;
    switchBtn.hidden = true;
    if (!engine) return;
    const requestId = popup.dataset.requestId;
    let choices;
    try {
      choices = await ctx.engineChoices();
    } catch (error) {
      console.error('Blab Translation: reading engine choices for the card failed', error);
      return;
    }
    if (state.translationPopup !== popup || popup.dataset.requestId !== requestId) return;
    const other = engine === 'builtin' ? 'ai' : 'builtin';
    if (!choices[other]) return;
    switchBtn.dataset.engine = other;
    switchBtn.textContent = t(other === 'builtin' ? 'cardUseBuiltin' : 'cardUseAi');
    switchBtn.disabled = false;
    switchBtn.hidden = false;
  }

  // 重译用卡片当前的原文和目标语言重发；换引擎先把这张卡固定到另一边再重发。
  // 什么都不写进设置。
  function wireCardActions(popup) {
    const resend = () => {
      if (state.translationPopup !== popup) return;
      translateText(popup.dataset.sourceText || '', popup.dataset.targetLang || '');
    };
    popup.querySelector('.ai-translator-retranslate').addEventListener('click', resend);
    const switchBtn = popup.querySelector('.ai-translator-switch-engine');
    switchBtn.addEventListener('click', () => {
      popup.dataset.pinnedEngine = switchBtn.dataset.engine;
      resend();
    });
  }

  async function translateText(text, targetLangOverride = '') {
    const requestId = String(++state.translationRequestId);
    const popup = state.translationPopup;
    const isCurrent = () => !!popup && state.translationPopup === popup && popup.dataset.requestId === requestId;
    try {
      const isWord = isSingleWordText(text);
      const targetLang = targetLangOverride || getEffectiveTargetLang();
      if (!isExtensionContextAvailable()) {
        if (popup) {
          showCardError(popup, t('extensionContextInvalidated'));
          settleCardActions(popup, undefined);
        }
        return;
      }
      if (popup) {
        popup.dataset.requestId = requestId;
        popup.dataset.targetLang = targetLang;
        // A recognise-only popup (image OCR with the auto-translate step off)
        // has its translation half hidden and a Translate button in its place.
        // Getting here means something asked for a translation anyway — that
        // button, or the language dropdown — so the half comes back and the
        // button, its job done, goes away.
        popup.querySelector('.ai-translator-divider')?.removeAttribute('hidden');
        popup.querySelector('.ai-translator-result')?.removeAttribute('hidden');
        popup.querySelector('.ai-translator-translate-btn')?.setAttribute('hidden', '');
        const parts = cardParts(popup);
        setCardLoading(parts, true);
        if (parts.resultBody) parts.resultBody.hidden = true;
        if (parts.phonetic) parts.phonetic.hidden = true;
        parts.error.hidden = true;
        parts.error.textContent = '';
        popup._showTranslationSpeak?.(false);
        setCardActionsBusy(popup, true);
      }
      // 这张卡点过「换引擎」才带 engine；否则按设置走。
      const pinned = popup?.dataset.pinnedEngine;
      const response = await ctx.requestTranslation({
        type: 'TRANSLATE',
        text: text,
        targetLang: targetLang,
        mode: isWord ? 'word' : 'text',
        ...(pinned ? { engine: pinned } : {})
      });

      if (!isCurrent()) return;

      if (response.error) {
        showCardError(popup, response.error);
      } else {
        const parts = cardParts(popup);
        setCardLoading(parts, false);
        if (parts.text) {
          parts.text.textContent = response.translation || '';
          parts.text.classList.remove('ai-translator-translation-flow');
          // Trigger flow animation
          void parts.text.offsetWidth;
          parts.text.classList.add('ai-translator-translation-flow');
        }
        if (parts.phonetic) {
          parts.phonetic.textContent = response.phonetic || '';
          parts.phonetic.hidden = !response.phonetic;
        }
        popup._showTranslationSpeak?.(!!response.translation);
        if (parts.resultBody) {
          parts.resultBody.hidden = false;
          parts.resultBody.classList.remove('ai-translator-reveal');
          void parts.resultBody.offsetWidth;
          parts.resultBody.classList.add('ai-translator-reveal');
        }
      }
      settleCardActions(popup, response.engine);
    } catch (error) {
      console.error('Blab Translation: Translation failed', error);
      if (isCurrent()) {
        showCardError(popup, isExtensionContextInvalidated(error)
          ? t('extensionContextInvalidated')
          : t('translationFailed'));
        settleCardActions(popup, undefined);
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
  // For content-image-ocr.js, whose pending state has no source text yet and
  // therefore cannot go through the two entry points above.
  ctx.buildPopupMarkup = buildPopupMarkup;
  ctx.translateIconSvg = translateIconSvg;
  ctx.showCardError = showCardError;
  ctx.setupPopupDrag = setupPopupDrag;
  ctx.hideTranslationPopup = hideTranslationPopup;
  ctx.setupLanguageDropdown = setupLanguageDropdown;
  ctx.translateText = translateText;
  ctx.isSingleWordText = isSingleWordText;
})();
