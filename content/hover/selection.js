// Blab Translation 悬停/划选翻译 —— 划选那一路
//
// 悬停翻的是一整块，划选翻的是块里的一截。难处全在「插在哪儿」：选区可能跨节点、
// 可能半个公式、可能整块都选上了（那就退回整块那一路）。
//
// 这一份把选区收敛成一个能安全插入的位置，再把译文放进去。
(function() {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT;
  if (!ctx) return;

  const { settings, state } = ctx;
  const { MATH_CONTAINER_SELECTOR } = ctx.constants;
  const t = ctx.t;
  // 这一族共用的架子，说明见 content/content-hover-translation.js 顶上。
  const hov = (ctx.hover = ctx.hover || {});

  function resolveSelectionAnchor(anchorEl) {
    if (anchorEl && anchorEl.nodeType === Node.ELEMENT_NODE) return anchorEl;

    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return null;

    const anchorNode = selection.anchorNode || selection.focusNode || selection.getRangeAt(0).commonAncestorContainer;
    if (!anchorNode) return null;

    return anchorNode.nodeType === Node.ELEMENT_NODE ? anchorNode : anchorNode.parentElement;
  }

  function resolveSelectionRange(selectionRange) {
    if (selectionRange && selectionRange.startContainer) return selectionRange;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return null;
    return selection.getRangeAt(0);
  }

  function normalizeComparableText(text) {
    if (!text) return '';
    return text
      .replace(/\{\{\d+\}\}/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function isSelectionRangeInsideBlock(range, block) {
    if (!range || range.collapsed || !block) return false;
    return block.contains(range.startContainer) && block.contains(range.endContainer);
  }

  function isFullBlockSelection(selectionText, blockText) {
    const normalizedSelection = normalizeComparableText(selectionText);
    const normalizedBlock = normalizeComparableText(blockText);
    return normalizedSelection && normalizedSelection === normalizedBlock;
  }

  function resolveMathContainer(element) {
    if (!element) return null;
    const el = element.nodeType === Node.ELEMENT_NODE ? element : element.parentElement;
    if (!el) return null;

    let mathContainer = null;
    if (MATH_CONTAINER_SELECTOR) {
      mathContainer = el.closest(MATH_CONTAINER_SELECTOR);
      if (mathContainer) {
        let parent = mathContainer.parentElement;
        while (parent && parent.matches?.(MATH_CONTAINER_SELECTOR)) {
          mathContainer = parent;
          parent = parent.parentElement;
        }
      }
    }

    if (!mathContainer && ctx.isMathElement) {
      let current = el;
      while (current && current !== document.body && current !== document.documentElement) {
        if (ctx.isMathElement(current)) {
          mathContainer = current;
          break;
        }
        current = current.parentElement;
      }
    }

    return mathContainer;
  }

  function resolveSafeInsertionRange(range, block) {
    if (!range) return null;
    const insertionRange = range.cloneRange();
    insertionRange.collapse(false);

    const endContainer = insertionRange.endContainer;
    const endElement = endContainer.nodeType === Node.ELEMENT_NODE ? endContainer : endContainer.parentElement;
    if (!endElement) return insertionRange;

    const mathContainer = resolveMathContainer(endElement);
    if (mathContainer) {
      if (block && !block.contains(mathContainer)) return insertionRange;
      const safeRange = document.createRange();
      safeRange.setStartAfter(mathContainer);
      safeRange.collapse(true);
      return safeRange;
    }

    if (endContainer.nodeType === Node.TEXT_NODE) {
      const safeOffset = hov.resolveLatexSafeOffset(endContainer.textContent || '', insertionRange.endOffset);
      if (safeOffset !== insertionRange.endOffset) {
        insertionRange.setStart(endContainer, safeOffset);
        insertionRange.collapse(true);
      }
    }

    return insertionRange;
  }

  // options.textLang：译文的语言（请求的目标），错误提示不带 —— 它按界面语言打标。
  function renderSelectionTranslation(block, translation, mathElements, selectionRange, options = {}) {
    const { isError, selectionText, textLang } = options;
    const markLang = hov.textLangOf(options);
    const blockText = hov.getBlockText(block).text;
    const range = resolveSelectionRange(selectionRange);
    const shouldInline = selectionText && !isFullBlockSelection(selectionText, blockText);

    // 受管容器里 insertNode 插进去的节点同样会被撤销，回到 renderInlineTranslation
    // 那条路，由它渲染成原文块的 ::after。
    if (hov.shouldUseManagedRendering(block) || !shouldInline || !isSelectionRangeInsideBlock(range, block)) {
      return hov.renderInlineTranslation(block, translation, mathElements, { kind: 'selection', isError, textLang });
    }

    const translationEl = document.createElement('span');
    translationEl.className = 'ai-translator-inline-block ai-translator-selection-translation';

    const computedStyle = window.getComputedStyle(block);
    translationEl.style.cssText = hov.buildBaseStyle(computedStyle, TargetLang.direction(markLang), isError) + `
      display: inline;
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    `;
    translationEl.style.setProperty('display', 'inline', 'important');
    translationEl.style.setProperty('margin-top', '0', 'important');
    translationEl.style.setProperty('margin-bottom', '0', 'important');
    translationEl.style.setProperty('padding', '0', 'important');

    ctx.markLanguage(translationEl, markLang);
    if (isError) {
      translationEl.classList.add('ai-translator-error');
    }

    translationEl.appendChild(document.createTextNode(' ('));
    if (mathElements.length && ctx.buildTranslationContentWithMath) {
      ctx.buildTranslationContentWithMath(translationEl, translation, mathElements);
    } else {
      translationEl.appendChild(document.createTextNode(translation));
    }
    translationEl.appendChild(document.createTextNode(')'));

    try {
      const insertionRange = resolveSafeInsertionRange(range, block);
      if (!insertionRange || !block.contains(insertionRange.startContainer)) {
        return hov.renderInlineTranslation(block, translation, mathElements, { kind: 'selection', isError, textLang });
      }
      insertionRange.insertNode(translationEl);
      return translationEl;
    } catch (error) {
      return hov.renderInlineTranslation(block, translation, mathElements, { kind: 'selection', isError, textLang });
    }
  }

  function renderSelectionLoading(block, selectionRange, options = {}) {
    const { selectionText } = options;
    const blockText = hov.getBlockText(block).text;
    const range = resolveSelectionRange(selectionRange);
    const shouldInline = selectionText && !isFullBlockSelection(selectionText, blockText);

    // 受管容器里 insertNode 插进去的节点同样会被撤销，回到 renderInlineLoading
    // 那条路，由它渲染成原文块的 ::after。
    if (hov.shouldUseManagedRendering(block) || !shouldInline || !isSelectionRangeInsideBlock(range, block)) {
      return hov.renderInlineLoading(block, { kind: 'selection' });
    }

    const loadingEl = document.createElement('span');
    loadingEl.className = 'ai-translator-inline-block ai-translator-selection-translation';

    const computedStyle = window.getComputedStyle(block);
    const loadingLang = hov.textLangOf({ loading: true });
    loadingEl.style.cssText = hov.buildBaseStyle(computedStyle, TargetLang.direction(loadingLang)) + `
      display: inline;
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    `;
    loadingEl.style.setProperty('display', 'inline', 'important');
    loadingEl.style.setProperty('margin-top', '0', 'important');
    loadingEl.style.setProperty('margin-bottom', '0', 'important');
    loadingEl.style.setProperty('padding', '0', 'important');

    ctx.markLanguage(loadingEl, loadingLang);
    loadingEl.appendChild(document.createTextNode(' ('));
    const dots = hov.createLoadingDots();
    loadingEl.appendChild(dots);
    loadingEl.appendChild(document.createTextNode(')'));

    try {
      const insertionRange = resolveSafeInsertionRange(range, block);
      if (!insertionRange || !block.contains(insertionRange.startContainer)) {
        return hov.renderInlineLoading(block, { kind: 'selection' });
      }
      insertionRange.insertNode(loadingEl);
      return loadingEl;
    } catch (error) {
      return hov.renderInlineLoading(block, { kind: 'selection' });
    }
  }

  async function translateSelectionInline(text, anchorEl, selectionRange) {
    if (!text || !ctx.isSelectionInlineEnabled || !ctx.isSelectionInlineEnabled()) return;

    const anchor = resolveSelectionAnchor(anchorEl);
    const block = hov.resolveBlockFromTarget(anchor);
    if (!block) return;

    state.selectionTranslationPending = true;
    hov.clearSelectionTranslation();

    const extracted = hov.extractSelectionPlaceholders(text, selectionRange);
    const safeText = extracted.text;
    const mathElements = extracted.mathElements;

    const targetLang = ctx.getEffectiveTargetLang ? ctx.getEffectiveTargetLang() : settings.targetLang;
    const cacheKey = hov.buildCacheKey(safeText, targetLang);
    const cached = hov.getCachedTranslation(block, cacheKey);
    if (cached) {
      const render = () => renderSelectionTranslation(block, cached, mathElements, selectionRange, {
        selectionText: safeText,
        textLang: targetLang
      });
      hov.trackInlineTranslation(block, render(), 'selection', render);
      state.selectionTranslationPending = false;
      return;
    }

    const requestId = hov.bumpRequestId(hov.selectionRequestIds, block);
    const renderLoading = () => renderSelectionLoading(block, selectionRange, { selectionText: safeText });
    hov.trackInlineTranslation(block, renderLoading(), 'selection', renderLoading);
    hov.recordLoadingStart(block, 'selection');
    if (!ctx.isExtensionContextAvailable || !ctx.isExtensionContextAvailable()) {
      hov.scheduleInlineReplacement(
        block,
        'selection',
        requestId,
        () => renderSelectionTranslation(block, t('extensionContextInvalidated'), [], selectionRange, {
          isError: true,
          selectionText: safeText
        }),
        () => {
          state.selectionTranslationPending = false;
        }
      );
      return;
    }

    try {
      const response = await ctx.requestTranslation({
        type: 'TRANSLATE',
        text: safeText,
        targetLang,
        mode: 'text'
      });

      if (hov.selectionRequestIds.get(block) !== requestId) {
        state.selectionTranslationPending = false;
        return;
      }

      if (response?.error) {
        hov.scheduleInlineReplacement(
          block,
          'selection',
          requestId,
          () => renderSelectionTranslation(block, response.error, [], selectionRange, {
            isError: true,
            selectionText: safeText
          }),
          () => {
            state.selectionTranslationPending = false;
          }
        );
        return;
      }

      const translation = response?.translation || '';
      hov.setCachedTranslation(block, cacheKey, translation);
      hov.scheduleInlineReplacement(
        block,
        'selection',
        requestId,
        () => renderSelectionTranslation(block, translation, mathElements, selectionRange, {
          selectionText: safeText,
          textLang: targetLang
        }),
        () => {
          state.selectionTranslationPending = false;
        }
      );
    } catch (error) {
      if (hov.selectionRequestIds.get(block) !== requestId) {
        state.selectionTranslationPending = false;
        return;
      }
      const message = ctx.isExtensionContextInvalidated && ctx.isExtensionContextInvalidated(error)
        ? t('extensionContextInvalidated')
        : t('translationFailed');
      hov.scheduleInlineReplacement(
        block,
        'selection',
        requestId,
        () => renderSelectionTranslation(block, message, [], selectionRange, {
          isError: true,
          selectionText: safeText
        }),
        () => {
          state.selectionTranslationPending = false;
        }
      );
    }
  }

  function showInlineSelectionTranslation(text, translation, anchorEl, selectionRange) {
    if (!text || !ctx.isSelectionInlineEnabled || !ctx.isSelectionInlineEnabled()) return;

    const anchor = resolveSelectionAnchor(anchorEl);
    const block = hov.resolveBlockFromTarget(anchor);
    if (!block) return;

    const extracted = hov.extractSelectionPlaceholders(text, selectionRange);
    hov.clearSelectionTranslation();
    // 右键菜单那条路的译文由 service worker 译好推过来，消息里不带语言；它译成的就是
    // 此刻的有效目标语言，所以按同一个答案打标。
    const textLang = ctx.getEffectiveTargetLang();
    const render = () => renderSelectionTranslation(block, translation || '', extracted.mathElements, selectionRange, {
      selectionText: extracted.text || text,
      textLang
    });
    hov.trackInlineTranslation(block, render(), 'selection', render);
  }

  // 别的文件要用的，都从这张架子上取。
  Object.assign(hov, {
    resolveSelectionRange, showInlineSelectionTranslation, translateSelectionInline,
  });
})();
