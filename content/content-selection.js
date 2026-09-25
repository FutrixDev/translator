// Blab Translation Content Script Selection
(function() {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT;
  if (!ctx) return;

  const { settings, state } = ctx;
  const t = ctx.t;
  const HOTKEYS = new Set(['Shift', 'Alt', 'Control', 'Meta']);
  const SKIP_SELECTOR = '.ai-translator-popup, .ai-translator-inline-block, .ai-translator-hover-translation, .ai-translator-selection-translation, #ai-translator-float-ball, #ai-translator-float-menu, #ai-translator-progress, #ai-translator-selection-btn';

  function setupSelectionListener() {
    let selectionTimeout = null;

    document.addEventListener('mouseup', (e) => {
      if (!settings.enableSelection) return;

      // Ignore if clicking inside our elements
      if (state.translationPopup && state.translationPopup.contains(e.target)) return;
      if (state.floatBall && state.floatBall.contains(e.target)) return;
      if (state.floatMenu && state.floatMenu.contains(e.target)) return;
      if (state.selectionButton && state.selectionButton.contains(e.target)) return;

      // Clear any existing timeout
      if (selectionTimeout) {
        clearTimeout(selectionTimeout);
      }

      // Delay to allow selection to complete
      selectionTimeout = setTimeout(() => {
        const selectedText = getSelectedText();
        if (selectedText && selectedText.length >= 2 && selectedText.length <= 5000) {
          // Track selection for hotkey/context menu translation
          const selection = window.getSelection();
          state.lastSelectionRange = selection && selection.rangeCount > 0
            ? selection.getRangeAt(0).cloneRange()
            : null;
          state.lastSelectedText = selectedText;
          state.lastSelectionElement = getSelectionElement();
          if (triggerAllows('icon') && !isSelectionTriggerIgnored(e.target)
            && !isSelectionTriggerIgnored(state.lastSelectionElement)) {
            showSelectionIcon(selection, { x: e.clientX, y: e.clientY });
          } else {
            hideSelectionButton();
          }
        } else {
          state.lastSelectionElement = null;
          state.lastSelectionRange = null;
          state.lastSelectedText = '';
          hideSelectionButton();
        }
      }, 100);
    });

    // Hide selection button on click outside (but not the popup)
    document.addEventListener('mousedown', (e) => {
      if (state.selectionButton && !state.selectionButton.contains(e.target)) {
        hideSelectionButton();
        state.lastSelectionRange = null;
      }
    });

    // Clear inline selection translation when selection is cleared
    document.addEventListener('selectionchange', () => {
      if (!settings.enableSelection) return;
      const selectedText = getSelectedText();
      if (selectedText) return;
      // 图标的 mousedown 不丢选区，所以选区清空时图标也该走了，这里不再替它挡。
      if (state.selectionTranslationPending) return;
      // Don't clear state while a context menu is likely open (right-click translation in progress)
      // The context menu handler in background.js needs lastSelectionElement to show inline translation
      if (document.visibilityState === 'visible' && document.hasFocus && !document.hasFocus()) return;
      state.lastSelectionElement = null;
      state.lastSelectionRange = null;
      state.lastSelectedText = '';
      hideSelectionButton();
    });

    document.addEventListener('keydown', handleSelectionHotkey, true);

    // Hide popup on Escape key
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (ctx.hideTranslationPopup) ctx.hideTranslationPopup();
        if (ctx.hideFloatMenu) ctx.hideFloatMenu();
        if (ctx.hideSourcePeek) ctx.hideSourcePeek();
        if (ctx.clearHoverTranslation) ctx.clearHoverTranslation();
        if (ctx.clearSelectionTranslation) ctx.clearSelectionTranslation();
        state.selectionTranslationPending = false;
        hideSelectionButton();
      }
    });
  }

  // 划词图标：mouseup 结算后贴着选区末行出一颗 28×28 的圆钮，点了开卡片（卡片是
  // 四个操作所在的地方；段落下方模式没有它们，所以图标不跟显示方式走）。
  const ICON_SIZE = 28;

  function triggerAllows(kind) {
    if (!settings.enableSelection) return false;
    const trigger = settings.selectionTrigger;
    return trigger === kind || trigger === 'both';
  }

  function isBackwardSelection(selection) {
    const { anchorNode, focusNode } = selection;
    if (anchorNode === focusNode) return selection.focusOffset < selection.anchorOffset;
    return !!(anchorNode.compareDocumentPosition(focusNode) & Node.DOCUMENT_POSITION_PRECEDING);
  }

  // 末行：鼠标松开那一端所在的行。焦点处折叠 Range 的矩形给出是哪一行；再取选区在
  // 这一行上的那段矩形，图标的水平范围才是选中的字，而不是一个零宽的插入点。
  function selectionLineRect(selection, range, point) {
    const caret = document.createRange();
    caret.setStart(selection.focusNode, selection.focusOffset);
    caret.collapse(true);
    const caretRect = caret.getBoundingClientRect();
    const y = caretRect.height ? caretRect.top + caretRect.height / 2 : point.y;
    const rects = Array.from(range.getClientRects()).filter((r) => r.width && r.height);
    let best = null;
    let bestScore = Infinity;
    for (const r of rects) {
      const off = y < r.top ? r.top - y : (y > r.bottom ? y - r.bottom : 0);
      const score = off * 1e6 + r.height;
      if (score < bestScore) { best = r; bestScore = score; }
    }
    return best || { left: point.x, right: point.x, top: point.y - 1, bottom: point.y + 1 };
  }

  function onIconViewportChange() {
    hideSelectionButton();
  }

  function showSelectionIcon(selection, point) {
    hideSelectionButton();
    if (!selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    const line = selectionLineRect(selection, range, point);
    const whole = range.getBoundingClientRect();
    // 反向拖出来的多行选区，末行是第一行：放上方才不盖住选区。
    const prefer = isBackwardSelection(selection) && whole.bottom - line.bottom > 1 ? 'above' : 'below';
    const x = Math.min(Math.max(point.x, line.left), line.right) - ICON_SIZE / 2;
    const viewport = { width: document.documentElement.clientWidth || window.innerWidth, height: window.innerHeight };
    const pos = ctx.placeBeside({ width: ICON_SIZE, height: ICON_SIZE }, line, { viewport, prefer, x });

    const root = document.createElement('div');
    root.id = 'ai-translator-selection-btn';
    const label = ctx.escapeHtml(t('selectionIconLabel'));
    root.innerHTML = `<button type="button" class="ai-translator-selection-icon" aria-label="${label}" title="${label}">${ctx.translateIconSvg(16)}</button>`;
    root.style.left = `${pos.left}px`;
    root.style.top = `${pos.top}px`;
    // 点图标不能把选区点没了：按下时就拦住，焦点和选区都留在页面上。
    root.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    root.addEventListener('click', (e) => {
      e.stopPropagation();
      const text = state.lastSelectedText;
      const selectionRange = state.lastSelectionRange;
      hideSelectionButton();
      if (!text) return;
      ctx.showTranslationPopup(text, { range: selectionRange });
    });
    document.body.appendChild(root);
    state.selectionButton = root;
    window.addEventListener('scroll', onIconViewportChange, { capture: true, passive: true });
    window.addEventListener('resize', onIconViewportChange, { passive: true });
  }

  function hideSelectionButton() {
    window.removeEventListener('scroll', onIconViewportChange, { capture: true });
    window.removeEventListener('resize', onIconViewportChange);
    if (state.selectionButton) {
      state.selectionButton.remove();
      state.selectionButton = null;
    }
  }

  // 设置变了（关了划词、只留修饰键）就收起已经出着的图标。
  function syncSelectionIcon() {
    if (!triggerAllows('icon')) hideSelectionButton();
  }

  // 选区翻译只有这一条路：按显示方式分派到段落下方或卡片。修饰键、悬浮球、
  // 右键菜单都走这里；图标不走（它总是开卡片）。
  function translateSelection(text, { range = null, element = null } = {}) {
    hideSelectionButton();
    if (ctx.isSelectionInlineEnabled()) {
      ctx.translateSelectionInline(text, element, range);
      return;
    }
    ctx.showTranslationPopup(text, { range });
  }

  function getSelectionHotkey() {
    const hotkey = settings.selectionTranslationHotkey || 'Control';
    return HOTKEYS.has(hotkey) ? hotkey : 'Control';
  }

  function isSelectionHotkeyEvent(event) {
    return event.key === getSelectionHotkey();
  }

  function isEditableTarget(target) {
    if (!target) return false;
    const el = target.nodeType === Node.ELEMENT_NODE ? target : target.parentElement;
    if (!el) return false;
    if (el.isContentEditable) return true;
    if (el.closest?.('input, textarea, select, option')) return true;
    if (el.closest?.('[contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]')) return true;
    return false;
  }

  function isSelectionTriggerIgnored(target) {
    if (!target) return false;
    const el = target.nodeType === Node.ELEMENT_NODE ? target : target.parentElement;
    if (!el) return false;
    if (el.closest?.(SKIP_SELECTOR)) return true;
    return isEditableTarget(el);
  }

  function hasSelectionTranslationVisible() {
    if (ctx.hasSelectionTranslation && ctx.hasSelectionTranslation()) return true;
    if (state.translationPopup) return true;
    return !!document.querySelector('.ai-translator-selection-translation');
  }

  function cancelSelectionTranslation() {
    if (ctx.clearSelectionTranslation) ctx.clearSelectionTranslation();
    if (ctx.hideTranslationPopup) ctx.hideTranslationPopup();
    state.selectionTranslationPending = false;
  }

  function resolveSelectionRange() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
    return selection.getRangeAt(0).cloneRange();
  }

  // 页面上此刻的选区（修饰键与右键菜单同用这一个解析）。
  function currentSelectionTarget() {
    return { range: resolveSelectionRange(), element: getSelectionElement() };
  }

  function handleSelectionHotkey(event) {
    if (!triggerAllows('modifier')) return;
    if (!isSelectionHotkeyEvent(event)) return;
    if (event.repeat) return;
    if (isSelectionTriggerIgnored(event.target)) return;

    // 快捷键是单独一个修饰键，和 Alt+A 这类命令键位的第一下分不开：等确定用户
    // 只按了它再译（见 content-utils.js 的 armModifierTap）。划词是「点一下」的
    // 手势，所以不开 hold —— 松开才算数，按住多久都不动手。用户按着 Ctrl 伸手
    // 去够 C 的那半秒，不该变成一次翻译。
    ctx.armModifierTap(event.key, runSelectionHotkey);
  }

  function runSelectionHotkey() {
    if (hasSelectionTranslationVisible()) {
      cancelSelectionTranslation();
      return;
    }

    const selectedText = getSelectedText();
    if (!selectedText || selectedText.length < 2 || selectedText.length > 5000) return;

    const { range, element } = currentSelectionTarget();
    if (!range) return;

    state.lastSelectedText = selectedText;
    state.lastSelectionRange = range;
    state.lastSelectionElement = element;
    translateSelection(selectedText, { range, element });
  }

  function getSelectedText() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return '';
    return selection.toString().trim();
  }

  function getSelectionElement() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return null;
    const anchorNode = selection.anchorNode || selection.focusNode;
    if (!anchorNode) return null;
    return anchorNode.nodeType === Node.ELEMENT_NODE ? anchorNode : anchorNode.parentElement;
  }

  ctx.setupSelectionListener = setupSelectionListener;
  ctx.hideSelectionButton = hideSelectionButton;
  ctx.syncSelectionIcon = syncSelectionIcon;
  ctx.translateSelection = translateSelection;
  ctx.currentSelectionTarget = currentSelectionTarget;
  ctx.getSelectedText = getSelectedText;
  ctx.getSelectionElement = getSelectionElement;
})();
