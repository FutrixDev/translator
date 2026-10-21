// Blab Translation Content Script Popup
(function() {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT;
  if (!ctx) return;

  const { settings, state } = ctx;
  const t = ctx.t;
  const applyTheme = ctx.applyTheme;
  const escapeHtml = ctx.escapeHtml;
  const getEffectiveTargetLang = ctx.getEffectiveTargetLang;
  const normalizeTargetLang = ctx.normalizeTargetLang;
  const getTargetLangLabel = ctx.getTargetLangLabel;
  const buildTargetLangMenu = ctx.buildTargetLangMenu;
  const isExtensionContextAvailable = ctx.isExtensionContextAvailable;
  const speech = ctx.speech;
  const SPEAKER_ICON = speech.SPEAKER_ICON;
  const DictEntry = globalThis.DictEntry;

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
   * @param {{text: string, translation?: string, pending?: boolean}} options
   *   `pending` renders the loading state instead of a finished translation.
   */
  // `sourceLabel` overrides the "Original" heading. Image OCR uses it to say
  // which language it recognised ("Original · 日本語"); it is part of the
  // heading because the recognised language does not stop being true when the
  // user picks a different target.
  //
  // The dictionary entry (.ai-translator-dict-entry) sits under the translation
  // and is drawn only by translateText through DictEntry.render — the same
  // renderer as the input dialog's.
  function buildPopupMarkup({ text, translation = '', pending = false, sourceLabel = '' }) {
    return `
      <div class="ai-translator-header">
        <div class="ai-translator-header-left">
          ${translateIconSvg(20, 'ai-translator-title-icon')}
          <span class="ai-translator-title">${t('translate')}</span>
        </div>
        <div class="ai-translator-header-right">
          <div class="ai-translator-lang-dropdown">
            <button class="ai-translator-lang-trigger" type="button" title="${t('targetLanguage')}" aria-expanded="false">
              <span class="ai-translator-lang-label">${escapeHtml(getTargetLangLabel(getEffectiveTargetLang()))}</span>
              <svg class="ai-translator-lang-caret" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M6 9l6 6 6-6"/>
              </svg>
            </button>
            <div class="ai-translator-lang-menu" hidden></div>
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
          <div class="ai-translator-text" dir="auto">${escapeHtml(text)}</div>
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
              <div class="ai-translator-translation-text" dir="auto">${escapeHtml(translation)}</div>
              <div class="ai-translator-dict-entry" hidden></div>
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
        <button class="ai-translator-btn ai-translator-switch-engine" type="button" hidden>${ctx.engineSwitchLabel(['ai', 'builtin', 'blab'], { explain: true })}</button>
        <button class="ai-translator-btn ai-translator-add-term" type="button" hidden>${ctx.fitLabel('', [t('glossaryAdd'), t('glossaryAdded'), t('glossaryUpdated')])}</button>
        <button class="ai-translator-btn ai-translator-copy" type="button" title="${t('copyTranslation')}">${ctx.copyButtonContent(t('copy'))}</button>
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

  // The element whose text holds the selection: the nearest ancestor that is
  // not laid out inline.
  function blockOf(node) {
    let element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    while (element && element !== document.body) {
      const display = getComputedStyle(element).display;
      if (display !== 'inline' && display !== 'contents') return element;
      element = element.parentElement;
    }
    return document.body;
  }

  /**
   * The page context "explain in context with AI" sends (D-641): the sentence
   * that holds the start of the selection, cut from its block's text by
   * Intl.Segmenter, whitespace runs folded to one space. The whole sentence goes
   * in `before` (after is empty) so the model reads it as one string; a sentence
   * longer than PromptAddenda.LIMITS.before keeps the stretch centred on the
   * selection. content/engine/addenda.js strips the markers and holds the limits
   * as for every page context. No range (the context-menu card) is no sentence.
   *
   * @param {?Range} range
   * @returns {?{before: string, after: string}}
   */
  function sentenceAround(range) {
    if (!range) return null;
    const block = blockOf(range.startContainer);
    const lead = document.createRange();
    lead.selectNodeContents(block);
    const blockText = lead.toString();
    lead.setEnd(range.startContainer, range.startOffset);
    const start = lead.toString().length;
    const end = Math.min(blockText.length, start + range.toString().length);
    const segment = new Intl.Segmenter(undefined, { granularity: 'sentence' }).segment(blockText).containing(start);
    if (!segment) return null;
    const fold = (value) => value.replace(/\s+/g, ' ');
    const from = segment.index;
    const to = Math.max(from + segment.segment.length, end);
    const pre = fold(blockText.slice(from, start)).trimStart();
    const selected = fold(blockText.slice(start, end));
    const post = fold(blockText.slice(end, to)).trimEnd();
    const limit = globalThis.PromptAddenda.LIMITS.before;
    if (pre.length + selected.length + post.length <= limit) {
      return { before: pre + selected + post, after: '' };
    }
    const room = Math.max(0, limit - selected.length);
    const head = pre.slice(pre.length - Math.min(pre.length, Math.ceil(room / 2)));
    const tail = post.slice(0, room - head.length);
    return { before: (head + selected + tail).slice(0, limit), after: '' };
  }

  function showTranslationPopup(text, { range = null } = {}) {
    hideTranslationPopup();

    // Ensure theme is applied
    applyTheme(settings.theme);

    const popup = document.createElement('div');
    state.translationPopup = popup;
    popup.className = 'ai-translator-popup';
    popup.dataset.sourceText = text;
    // Read now, while the selection is the reader's and the card is not yet in
    // the page: only "explain in context with AI" sends it (translateText).
    popup._explainContext = sentenceAround(range);
    popup.innerHTML = buildPopupMarkup({ text, pending: true });
    document.body.appendChild(popup);
    keepCardPlaced(popup, anchorCard(range));

    // Event listeners
    popup.querySelector('.ai-translator-close').addEventListener('click', hideTranslationPopup);
    const copyBtn = popup.querySelector('.ai-translator-copy');
    copyBtn.addEventListener('click', () => {
      const translationText = popup.querySelector('.ai-translator-translation-text')?.textContent;
      if (translationText && !translationText.includes(t('translating'))) {
        ctx.copyWithFeedback(copyBtn, translationText);
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
  function showTranslationResult(text, translation, options = {}) {
    hideTranslationPopup();

    // Ensure theme is applied
    applyTheme(settings.theme);

    state.translationPopup = document.createElement('div');
    state.translationPopup.className = 'ai-translator-popup';
    state.translationPopup.dataset.sourceText = text;
    state.translationPopup.innerHTML = buildPopupMarkup({
      text,
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
    const copyBtn = state.translationPopup.querySelector('.ai-translator-copy');
    copyBtn.addEventListener('click', () => {
      const popup = state.translationPopup;
      if (!popup) return;
      // With the translation half hidden there is nothing else to copy, and the
      // recognised text is what the user came for. Reads the DOM rather than a
      // captured flag so it corrects itself the moment a translation arrives.
      const wanted = popup.querySelector('.ai-translator-result')?.hasAttribute('hidden')
        ? popup.dataset.sourceText
        : popup.querySelector('.ai-translator-translation-text')?.textContent;
      if (wanted && !wanted.includes(t('translating'))) {
        ctx.copyWithFeedback(copyBtn, wanted);
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
      // 现成的译文是按设置里的目标语言译的，就是 setupLanguageDropdown 刚写下的那门。
      if (translation) ctx.markLanguage(translationTextEl, state.translationPopup.dataset.targetLang);
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

    const closeMenu = () => {
      if (menu.hidden) return;
      menu.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
    };

    // 菜单只在打开时画（唯一的渲染点）：「最近使用」一组在面板开着时也会变——这里
    // 译过、别的标签译过——每次打开都按那一刻的列表和那一刻的手动引擎画。
    // 画完停在顶部，让「最近使用」一组露出来；菜单总有这一组。当前语言不一定在
    // 组里：设置里可能换了默认语。为了把全表里的选中项滚到中部而把这组推出视口，就违背了
    // 置顶的本意；当前语言已经写在触发按钮上。只动菜单自己的 scrollTop，不用
    // scrollIntoView（那会连宿主页面一起滚）。菜单节点跨次打开复用，不赌重画后滚动位置
    // 自己归零，明确写 0。
    const openMenu = () => {
      if (!menu.hidden) return;
      buildTargetLangMenu(menu, popup.dataset.targetLang);
      menu.hidden = false;
      menu.scrollTop = 0;
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

  // 卡片「译文」一格里的几块：加载态、译文、词典条目、错误。
  function cardParts(popup) {
    const q = (selector) => popup.querySelector(selector);
    return {
      loading: [q('.ai-translator-loading'), q('.ai-translator-loading-lines')].filter(Boolean),
      resultBody: q('.ai-translator-result-body'),
      text: q('.ai-translator-translation-text'),
      dict: q('.ai-translator-dict-entry'),
      error: q('.ai-translator-error'),
    };
  }

  function setCardLoading(parts, loading) {
    for (const el of parts.loading) el.style.display = loading ? 'flex' : 'none';
  }

  /**
   * 卡片出错只有这一种画法：错误写进独立的错误元素（textContent，不拼 HTML），
   * 译文清空藏起 —— 旧译文是另一次请求的结果，留着会被当成这一次的。
   */
  //
  // `action` 是 Blab 账户错误带来的入口（'subscribe' | 'signin'，D-490 N2），画在
  // 错误句下面（ctx.accountActionButton）；登录成功就重跑出错的那次请求：默认用这张
  // 卡当前的原文和语言重译，原文不在卡上的请求（识图）传自己的 `retry`。
  function showCardError(popup, message, action = null, retry = null) {
    const parts = cardParts(popup);
    setCardLoading(parts, false);
    if (parts.text) parts.text.textContent = '';
    showCardEntry(parts, null);
    if (parts.resultBody) parts.resultBody.hidden = true;
    parts.error.textContent = message;
    const entry = ctx.accountActionButton(action, {
      className: 'ai-translator-btn ai-translator-btn-primary ai-translator-account-action',
      onSignedIn: () => {
        if (state.translationPopup !== popup) return;
        if (retry) retry();
        else translateText(popup.dataset.sourceText || '', popup.dataset.targetLang || '');
      }
    });
    if (entry) {
      const row = document.createElement('div');
      row.className = 'ai-translator-account-action-row';
      row.appendChild(entry);
      parts.error.appendChild(row);
    }
    parts.error.hidden = false;
    popup._showTranslationSpeak?.(false);
  }

  // 词典条目只经共享渲染器画（与输入框同一份）；null 清空并藏起。
  // 音标是译文的，喇叭按这次请求的目标语言读译文（D-487）；单语条目（查的词本来就是
  // 目标语言，entry.monolingual）的音标是这个词自己的，喇叭读查的原文 text。读原文的
  // 是卡片自己的 .ai-translator-speak-source。
  function showCardEntry(parts, entry, targetLang, text) {
    if (parts.dict) DictEntry.render(parts.dict, entry, { targetLang, text, t, speech });
  }

  // 重译 / 换引擎 / 加入术语表：请求在路上时禁用（术语表拿的是译文，旧的不能拿去预填）。
  function setCardActionsBusy(popup, busy) {
    for (const btn of popup.querySelectorAll('.ai-translator-retranslate, .ai-translator-switch-engine, .ai-translator-add-term')) {
      btn.disabled = busy;
    }
  }

  /**
   * 一次请求结算（成功或失败）之后：重译出现；引擎标签说这次是谁译的；另一边
   * 此刻能用才给「换引擎」，按钮文字说换到哪边。「加入术语表」在 await 之前同步
   * 定下（content-add-term.js，translated = 这次出了译文）。
   *
   * 换引擎按钮在答案回来之前保持原样，答案回来一次定下藏或露。先藏再露的话，每点一次
   * 动作行就折一次行再并回来，鼠标下面换成别的按钮。文字换了宽度不变，靠的是 fitLabel。
   */
  async function settleCardActions(popup, engine, translated) {
    ctx.addTerm.settle(popup, translated);
    const retranslate = popup.querySelector('.ai-translator-retranslate');
    const switchBtn = popup.querySelector('.ai-translator-switch-engine');
    const tag = popup.querySelector('.ai-translator-engine-tag');
    retranslate.hidden = false;
    retranslate.disabled = false;
    // 标题说这次是哪个引擎译的（原来恒写「AI 翻译」，内置和 Blab 译出来也这么写）。
    // 没有引擎（扩展上下文没了、请求抛错）就回到中性的「翻译」。
    popup.querySelector('.ai-translator-title').textContent = t(engine ? CARD_TITLE[engine] : 'translate');
    ctx.showEngineTag(tag, engine);
    const requestId = popup.dataset.requestId;
    await ctx.offerEngineSwitch({
      button: switchBtn,
      engine,
      targetLang: popup.dataset.targetLang,
      feature: 'selection',
      isCurrent: () => state.translationPopup === popup && popup.dataset.requestId === requestId,
    });
  }

  // 卡片标题说这次是谁答的，每个引擎一条（Engines.ENGINES），本地词典答的是「词典」。
  // 标签与「换到…」按钮在 content-engine-choice.js。
  const CARD_TITLE = { builtin: 'translate', ai: 'aiTranslate', blab: 'engineBlab', dict: 'dictTitle' };

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
      // "Explain in context with AI" (content-engine-choice.js marks the
      // button) makes this card send its sentence until it switches again.
      popup.toggleAttribute('data-explain', switchBtn.hasAttribute('data-explain'));
      resend();
    });
  }

  async function translateText(text, targetLangOverride = '') {
    const requestId = String(++state.translationRequestId);
    const popup = state.translationPopup;
    const isCurrent = () => !!popup && state.translationPopup === popup && popup.dataset.requestId === requestId;
    try {
      const targetLang = targetLangOverride || getEffectiveTargetLang();
      if (!isExtensionContextAvailable()) {
        if (popup) {
          showCardError(popup, t('extensionContextInvalidated'));
          settleCardActions(popup, undefined, false);
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
        showCardEntry(parts, null);
        parts.error.hidden = true;
        parts.error.textContent = '';
        popup._showTranslationSpeak?.(false);
        setCardActionsBusy(popup, true);
        ctx.addTerm.collapse(popup);
      }
      // The card's pinned engine (after a switch), the answer the offline
      // dictionary gave and the request mode all come from ctx.dictRoute, the
      // input box's rule too (D-641). A card the pack answered has proven this
      // text a word (popup.dataset.provenWord), so asking a model about it
      // again is still a word lookup; other text on the same card (an OCR
      // card's recognised text) is not proven.
      const pinned = popup?.dataset.pinnedEngine;
      if (popup && popup.dataset.provenWord !== undefined && popup.dataset.provenWord !== text) {
        delete popup.dataset.provenWord;
        popup.removeAttribute('data-explain');
      }
      const provenWord = !!popup && popup.dataset.provenWord === text;
      // Recorded on dispatch, not on answer; see ctx.rememberRecentTargetLang.
      ctx.rememberRecentTargetLang(targetLang);
      const { local, request } = await ctx.dictRoute(text, targetLang, { pinned, provenWord });
      // "Explain in context with AI" always sends the sentence the selection
      // sits in, whatever aiPageContext says (D-641); content/engine/addenda.js
      // turns it into the PAGE CONTEXT addendum.
      const explain = !!popup && popup.hasAttribute('data-explain');
      const response = local || await ctx.requestTranslation({
        type: 'TRANSLATE',
        feature: 'selection',
        text: text,
        targetLang: targetLang,
        ...request,
        ...(pinned ? { engine: pinned } : {}),
        ...(explain ? { explainContext: true } : {}),
        ...(explain && popup._explainContext ? { pageContext: popup._explainContext } : {})
      });

      if (!isCurrent()) return;
      if (response.engine === DictEntry.DICT_ENGINE) popup.dataset.provenWord = text;

      if (response.error) {
        showCardError(popup, response.error, response.action || null);
      } else {
        // A model lookup or a local dictionary hit carries an entry
        // (DictEntry.entryFor); a builtin answer has none.
        const entry = DictEntry.entryFor(request.mode, response);
        const parts = cardParts(popup);
        setCardLoading(parts, false);
        if (parts.text) {
          parts.text.textContent = response.translation || '';
          // 每次结算都重写：换了语言、重译之后，lang/dir 跟着这一次的目标语言走。
          // 只标译文这一块 —— 加载态、错误和原文是别的元素，不是目标语言。
          ctx.markLanguage(parts.text, targetLang);
          parts.text.classList.remove('ai-translator-translation-flow');
          // Trigger flow animation
          void parts.text.offsetWidth;
          parts.text.classList.add('ai-translator-translation-flow');
        }
        showCardEntry(parts, entry, targetLang, text);
        popup._showTranslationSpeak?.(!!response.translation);
        if (parts.resultBody) {
          parts.resultBody.hidden = false;
          parts.resultBody.classList.remove('ai-translator-reveal');
          void parts.resultBody.offsetWidth;
          parts.resultBody.classList.add('ai-translator-reveal');
        }
      }
      settleCardActions(popup, response.engine, !response.error && !!response.translation);
    } catch (error) {
      console.error('Blab Translation: Translation failed', error);
      if (isCurrent()) {
        showCardError(popup, ctx.thrownTranslationMessage(error));
        settleCardActions(popup, undefined, false);
      }
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
})();
