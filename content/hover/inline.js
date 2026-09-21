// Blab Translation 悬停/划选翻译 —— 行内译文的台账
//
// 一块正文同时最多有两份译文：悬停一份、划选一份。这一份记着它们分别是谁、哪一次
// 请求还算数、转圈是什么时候开始转的，以及怎么把一份译文干净地收回去。
//
// 两件容易忘的事在这里守着：
//   · 受管容器（Lexical / ProseMirror）会把插进去的节点撤销掉，所以译文改用原文块
//     自己的 ::after 画——生成内容不是 DOM 节点，编辑器的观察器看不见它。
//   · 请求是异步的，回来时用户可能早就指到别处了。每块记一个自增的请求号，回来时
//     号对不上就整份丢掉。
(function() {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT;
  if (!ctx) return;

  // 这一族共用的架子，说明见 content/content-hover-translation.js 顶上。
  const hov = (ctx.hover = ctx.hover || {});

  const INLINE_SOURCE_CLASS = 'ai-translator-inline-source';
  const INLINE_LOADING_CLASS = 'ai-translator-inline-loading';
  const hoverTranslations = new Map();
  const selectionTranslations = new Map();
  const inlineTranslationSources = new WeakMap();
  const hoverRequestIds = new Map();
  const selectionRequestIds = new Map();
  const hoverLoadingStarts = new Map();
  const selectionLoadingStarts = new Map();
  const MIN_LOADING_MS = 120;
  let lastContextBlock = null;


  function markInlineSource(block, kind) {
    if (!block) return;
    block.classList.add(INLINE_SOURCE_CLASS);
    if (kind === 'hover') {
      block.dataset.aiTranslatorInlineHover = '1';
    } else if (kind === 'selection') {
      block.dataset.aiTranslatorInlineSelection = '1';
    }
  }

  function unmarkInlineSource(block, kind) {
    if (!block) return;
    if (kind === 'hover') {
      delete block.dataset.aiTranslatorInlineHover;
    } else if (kind === 'selection') {
      delete block.dataset.aiTranslatorInlineSelection;
    }
    if (!block.dataset.aiTranslatorInlineHover && !block.dataset.aiTranslatorInlineSelection) {
      block.classList.remove(INLINE_SOURCE_CLASS);
    }
  }

  // ==================== 受管容器：生成内容渲染 ====================
  //
  // Lexical / ProseMirror 这类编辑器会撤销子树里的外来节点（见 content-utils.js
  // 里 MANAGED_DOM_ROOT_SELECTOR 的说明）。往这种块下面 after() 一个译文，下一帧
  // 就没了，用户什么都看不到。
  //
  // 这类块的译文改成原文块自己的 ::after —— 生成内容不是 DOM 节点，编辑器的
  // MutationObserver 看不见它，同时它又占真实排版空间，会把后面的段落顶下去。
  // 具体实现和取舍在 content-managed-translation.js。
  const hostileNodes = new WeakSet(); // 运行时发现的“插进去会被删”的位置

  function shouldUseManagedRendering(block) {
    if (!block) return false;
    if (ctx.isInsideManagedDomRoot && ctx.isInsideManagedDomRoot(block)) return true;
    // 名单之外的框架靠 verifyInlineSurvival 现场发现，记在 hostileNodes 里。
    // 两个位置都要问：译文可能是 after() 到块的兄弟位（父级是 block.parentElement），
    // 也可能是 appendChild / range.insertNode 到块里面（父级是块或块的后代）。
    return hostileNodes.has(block) || !!(block.parentElement && hostileNodes.has(block.parentElement));
  }

  // 受管容器里的一次渲染尝试。放不下就返回 null，由调用方继续走原来的插入路径 ——
  // 那条路在 Lexical 里会被删掉，但在其它框架上未必，总好过什么都不画。
  function renderManaged(block, text, options) {
    if (!shouldUseManagedRendering(block)) return null;
    if (!ctx.canRenderManagedTranslation || !ctx.renderManagedTranslation) return null;
    if (!ctx.canRenderManagedTranslation(block, { hasMath: !!(options && options.hasMath) })) return null;
    return ctx.renderManagedTranslation(block, text, options);
  }

  function releaseManaged(el) {
    if (!el || !ctx.releaseManagedTranslation) return;
    ctx.releaseManagedTranslation(el);
  }

  // 译文进了 DOM 不等于看得见：它可能落在某个 overflow:hidden 祖先的可视区外面。
  // 见 content-clip-guard.js（受管句柄由它自己换算成原文块）。
  function keepVisible(translationEl) {
    if (ctx.keepTranslationVisible) ctx.keepTranslationVisible(translationEl);
  }

  function releaseClipGuards() {
    if (ctx.releaseTranslationClipGuards) ctx.releaseTranslationClipGuards();
  }

  // 名单覆盖不到的框架同样会吃节点。插完之后隔两帧回看一眼：节点没了而原文块还在，
  // 就把这个插入父级记为 hostile，并重画一次 —— 那时 shouldUseManagedRendering 已
  // 经认得它，会走生成内容。少了这一步，未知框架上的表现依旧是“第一次悬停什么都
  // 没有，之后再悬停也不再重试”。
  function verifyInlineSurvival(block, translationEl, kind, redraw) {
    if (!redraw || !translationEl) return;
    if (ctx.isManagedTranslationHandle && ctx.isManagedTranslationHandle(translationEl)) return;
    const map = kind === 'hover' ? hoverTranslations : selectionTranslations;
    const parent = translationEl.parentElement;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (translationEl.isConnected) return;
      if (!block.isConnected || map.get(block) !== translationEl) return;
      // 记块本身：这一块下次直接走浮层。也记插入父级：同一个容器里的其它块可以
      // 不用再各自撞一次墙。
      hostileNodes.add(block);
      if (parent) hostileNodes.add(parent);
      map.delete(block);
      inlineTranslationSources.delete(translationEl);
      const replacement = redraw();
      if (replacement) trackInlineTranslation(block, replacement, kind);
    }));
  }

  function trackInlineTranslation(block, translationEl, kind, redraw) {
    if (!block || !translationEl) return;
    const map = kind === 'hover' ? hoverTranslations : selectionTranslations;
    const existing = map.get(block);
    if (existing && existing !== translationEl) {
      inlineTranslationSources.delete(existing);
      releaseManaged(existing);
      existing.remove();
      releaseClipGuards();
    }
    map.set(block, translationEl);
    inlineTranslationSources.set(translationEl, block);
    markInlineSource(block, kind);
    keepVisible(translationEl);
    verifyInlineSurvival(block, translationEl, kind, redraw);
  }

  function bumpRequestId(map, block) {
    const next = (map.get(block) || 0) + 1;
    map.set(block, next);
    return next;
  }

  function getLoadingMap(kind) {
    return kind === 'hover' ? hoverLoadingStarts : selectionLoadingStarts;
  }

  function recordLoadingStart(block, kind) {
    if (!block) return;
    const map = getLoadingMap(kind);
    map.set(block, Date.now());
  }

  function clearLoadingStart(block, kind) {
    if (!block) return;
    const map = getLoadingMap(kind);
    map.delete(block);
  }

  function scheduleInlineReplacement(block, kind, requestId, renderFn, onComplete) {
    const requestMap = kind === 'hover' ? hoverRequestIds : selectionRequestIds;
    const loadingMap = getLoadingMap(kind);
    const startedAt = loadingMap.get(block);
    const elapsed = startedAt ? Date.now() - startedAt : 0;
    const delay = startedAt ? Math.max(0, MIN_LOADING_MS - elapsed) : 0;

    const applyReplacement = () => {
      if (requestMap.get(block) !== requestId) return;
      loadingMap.delete(block);
      const translationEl = renderFn();
      // renderFn 本身就是这条译文的重画函数：被受管容器删掉时用它原样再画一次，
      // 那时 shouldUseManagedRendering 已经认得这个父级，会自动走生成内容。
      trackInlineTranslation(block, translationEl, kind, renderFn);
      if (onComplete) onComplete();
    };

    if (delay > 0) {
      setTimeout(applyReplacement, delay);
    } else {
      applyReplacement();
    }
  }

  function removeInlineTranslation(block, kind) {
    const map = kind === 'hover' ? hoverTranslations : selectionTranslations;
    if (!block || !map.has(block)) return;
    bumpRequestId(kind === 'hover' ? hoverRequestIds : selectionRequestIds, block);
    clearLoadingStart(block, kind);
    const translationEl = map.get(block);
    if (translationEl) {
      inlineTranslationSources.delete(translationEl);
      releaseManaged(translationEl);
      translationEl.remove();
      releaseClipGuards();
    }
    map.delete(block);
    unmarkInlineSource(block, kind);
  }

  function clearInlineTranslations(map, kind) {
    const blocks = Array.from(map.keys());
    blocks.forEach((block) => removeInlineTranslation(block, kind));
  }

  function clearInlineTranslationsForBlock(block) {
    removeInlineTranslation(block, 'hover');
    removeInlineTranslation(block, 'selection');
  }

  function hasInlineTranslation(block) {
    return hoverTranslations.has(block) || selectionTranslations.has(block);
  }

  function updateInlineContextMenu(visible) {
    if (!ctx.isExtensionContextAvailable || !ctx.isExtensionContextAvailable()) return;
    try {
      chrome.runtime.sendMessage({
        type: 'INLINE_CONTEXT_MENU_STATE',
        visible: !!visible
      });
    } catch (error) {
      // Ignore context menu sync errors
    }
  }

  function setInlineTranslationContext(block) {
    lastContextBlock = block || null;
    updateInlineContextMenu(!!lastContextBlock);
  }

  function clearInlineTranslationContext() {
    if (!lastContextBlock) return;
    clearInlineTranslationsForBlock(lastContextBlock);
    lastContextBlock = null;
    updateInlineContextMenu(false);
  }

  // 别的文件要用的，都从这张架子上取。
  Object.assign(hov, {
    INLINE_LOADING_CLASS, bumpRequestId, clearInlineTranslationContext, clearInlineTranslations,
    clearInlineTranslationsForBlock, hasInlineTranslation, hoverRequestIds, hoverTranslations,
    inlineTranslationSources, recordLoadingStart, renderManaged, scheduleInlineReplacement,
    selectionRequestIds, selectionTranslations, setInlineTranslationContext,
    shouldUseManagedRendering, trackInlineTranslation,
  });
})();
