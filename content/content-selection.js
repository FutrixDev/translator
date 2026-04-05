// AI Translator Content Script Selection
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
          state.lastSelectionPos = { x: e.clientX, y: e.clientY };
          state.lastSelectionElement = getSelectionElement();
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
      if (state.selectionButton || state.selectionTranslationPending) return;
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
        if (ctx.clearHoverTranslation) ctx.clearHoverTranslation();
        if (ctx.clearSelectionTranslation) ctx.clearSelectionTranslation();
        state.selectionTranslationPending = false;
        hideSelectionButton();
      }
    });
  }

  // Show small translate button near selection
  function showSelectionButton(x, y) {
    hideSelectionButton();

    state.selectionButton = document.createElement('div');
    state.selectionButton.id = 'ai-translator-selection-btn';
    state.selectionButton.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M12.87 15.07l-2.54-2.51.03-.03A17.52 17.52 0 0014.07 6H17V4h-7V2H8v2H1v2h11.17C11.5 7.92 10.44 9.75 9 11.35"/>
        <path d="M18.5 10l-4.5 12h2l1.12-3h4.75L23 22h2l-4.5-12h-2z"/>
      </svg>
      <span>${t('translate')}</span>
    `;

    // Position button above the selection
    let posX = x - 40;
    let posY = y - 45;

    // Keep within viewport
    if (posX < 10) posX = 10;
    if (posX + 80 > window.innerWidth) posX = window.innerWidth - 90;
    if (posY < 10) posY = y + 20;

    state.selectionButton.style.left = `${posX}px`;
    state.selectionButton.style.top = `${posY}px`;

    document.body.appendChild(state.selectionButton);

    // Click to translate
    state.selectionButton.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!state.lastSelectedText) return;
      if (ctx.isSelectionInlineEnabled && ctx.isSelectionInlineEnabled() && ctx.translateSelectionInline) {
        ctx.translateSelectionInline(state.lastSelectedText, state.lastSelectionElement, state.lastSelectionRange);
      } else if (ctx.showTranslationPopup) {
        ctx.showTranslationPopup(state.lastSelectedText, state.lastSelectionPos.x, state.lastSelectionPos.y);
      }
      state.lastSelectionRange = null;
      hideSelectionButton();
    });
  }

  function hideSelectionButton() {
    if (state.selectionButton) {
      state.selectionButton.remove();
      state.selectionButton = null;
    }
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
    if (!selection || selection.rangeCount === 0) return null;
    return selection.getRangeAt(0).cloneRange();
  }

  function resolveSelectionPosition(selectionRange, fallbackEvent) {
    if (selectionRange && selectionRange.getBoundingClientRect) {
      const rect = selectionRange.getBoundingClientRect();
      if (rect && (rect.width || rect.height)) {
        return { x: rect.left + rect.width / 2, y: rect.top };
      }
    }
    if (state.lastSelectionPos) return state.lastSelectionPos;
    if (fallbackEvent && typeof fallbackEvent.clientX === 'number') {
      return { x: fallbackEvent.clientX, y: fallbackEvent.clientY };
    }
    return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  }

  function handleSelectionHotkey(event) {
    if (!settings.enableSelection) return;
    if (!isSelectionHotkeyEvent(event)) return;
    if (event.repeat) return;
    if (isSelectionTriggerIgnored(event.target)) return;

    if (hasSelectionTranslationVisible()) {
      cancelSelectionTranslation();
      return;
    }

    const selectedText = getSelectedText();
    if (!selectedText || selectedText.length < 2 || selectedText.length > 5000) return;

    const selectionRange = resolveSelectionRange();
    if (!selectionRange) return;
    const anchorEl = getSelectionElement();
    const pos = resolveSelectionPosition(selectionRange, event);

    state.lastSelectedText = selectedText;
    state.lastSelectionRange = selectionRange;
    state.lastSelectionElement = anchorEl;
    state.lastSelectionPos = pos;

    if (ctx.isSelectionInlineEnabled && ctx.isSelectionInlineEnabled() && ctx.translateSelectionInline) {
      ctx.translateSelectionInline(selectedText, anchorEl, selectionRange);
    } else if (ctx.showTranslationPopup) {
      ctx.showTranslationPopup(selectedText, pos.x, pos.y);
    }
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
  ctx.showSelectionButton = showSelectionButton;
  ctx.hideSelectionButton = hideSelectionButton;
  ctx.getSelectedText = getSelectedText;
  ctx.getSelectionElement = getSelectionElement;
})();
