// Blab Translation 悬停/划选翻译 —— 翻哪一块
//
// 鼠标底下是一个文本节点、一个 <span>、一颗公式，要译的却是它所在的那一段。这一份
// 负责从任意一个目标往上走到「一块正文」，再判断这块值不值得翻（有没有字、是不是
// 代码/输入框/我们自己插的译文），并按块记住译过的结果。
//
// 缓存挂在块元素自己身上（WeakMap），块从 DOM 里走了，缓存跟着走。
(function() {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT;
  if (!ctx) return;

  const { MATH_CONTAINER_SELECTOR } = ctx.constants;
  // 这一族共用的架子，说明见 content/content-hover-translation.js 顶上。
  const hov = (ctx.hover = ctx.hover || {});

  const BLOCK_TAGS = new Set([
    'P', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'BLOCKQUOTE', 'FIGCAPTION', 'DT', 'DD'
  ]);
  const SKIP_SELECTOR = ctx.constants.OWN_NODES_SELECTOR;

  const translationCache = new WeakMap();


  // 划选、右键问的是这一个：不改页面，散文 <pre> 里只认已经裹好的段落。
  function resolveBlockFromTarget(target) {
    return resolveBlock(target, null);
  }

  // 悬停（划过、单按热键）问的是这一个。point 是指针此刻的视口坐标，没有就是 null。
  function resolveBlockFromInteractionTarget(target, point) {
    if (!target) return null;
    const translationEl = target.closest?.('.ai-translator-inline-block');
    if (translationEl && hov.inlineTranslationSources.has(translationEl)) {
      return hov.inlineTranslationSources.get(translationEl) || null;
    }
    return resolveBlock(target, point);
  }

  // 散文 <pre>（content/page/prose-pre.js）的一段是两道空行之间的文字，没有自己的
  // 元素：指针落在直属文字上时目标是 <pre> 本身，只有坐标说得出是哪一段。只有带
  // 坐标的悬停会把一段就地裹成锚点；用户正在这个 <pre> 里划选时也不裹——裹段要
  // 搬动文本节点，选区会跟着塌掉。
  function resolveBlock(target, point) {
    if (!target) return null;
    let el = target.nodeType === Node.ELEMENT_NODE ? target : target.parentElement;
    if (!el) return null;

    if (el.closest(SKIP_SELECTOR)) return null;
    const pre = el.closest('pre');
    if (pre && ctx.prosePre.isProse(pre)) {
      const paragraph = point && !selectingIn(pre) ? proseParagraphAt(pre, target, point) : wrappedParagraphOf(el);
      return paragraph && isValidBlock(paragraph) ? paragraph : null;
    }
    if (ctx.prosePre.skippedByTag(el)) return null;
    if (MATH_CONTAINER_SELECTOR && el.closest(MATH_CONTAINER_SELECTOR)) return null;

    while (el && el !== document.body && el !== document.documentElement) {
      if (BLOCK_TAGS.has(el.tagName)) {
        if (!isValidBlock(el)) return null;
        return el;
      }
      el = el.parentElement;
    }

    return null;
  }

  function selectingIn(pre) {
    const selection = document.getSelection();
    return !!selection && !selection.isCollapsed
      && (pre.contains(selection.anchorNode) || pre.contains(selection.focusNode));
  }

  function wrappedParagraphOf(el) {
    const anchor = el.closest(`.${ctx.TEXT_RUN_CLASS}`);
    return anchor && ctx.prosePre.isParagraph(anchor) ? anchor : null;
  }

  function proseParagraphAt(pre, target, point) {
    const at = document.createRange();
    if (target === pre) {
      const caret = document.caretPositionFromPoint(point.x, point.y);
      if (!caret || !pre.contains(caret.offsetNode)) return null;
      at.setStart(caret.offsetNode, caret.offset);
    } else {
      at.setStart(target, 0);
    }
    return ctx.prosePre.paragraphOf(pre, at);
  }

  function isValidBlock(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return false;
    if (element.isContentEditable) return false;
    if (element.closest(SKIP_SELECTOR)) return false;
    if (ctx.prosePre.skippedByTag(element)) return false;
    if (MATH_CONTAINER_SELECTOR && element.closest(MATH_CONTAINER_SELECTOR)) return false;
    if (element.classList.contains('ai-translator-translated')) return false;
    if (ctx.isMathElement && ctx.isMathElement(element)) return false;
    return true;
  }

  function getBlockText(element) {
    if (ctx.getTextWithMathPlaceholders) {
      return ctx.getTextWithMathPlaceholders(element);
    }
    return { text: element.textContent?.trim() || '', mathElements: [] };
  }

  // 代数在前（ctx.translationProfile）：模型、提示词、词表变了，旧译文就读不到。
  function buildCacheKey(text, targetLang) {
    return `${ctx.translationProfile.generation()}::${targetLang || ''}::${text}`;
  }

  function getCachedTranslation(block, cacheKey) {
    const entry = translationCache.get(block);
    if (!entry) return '';
    return entry.get(cacheKey) || '';
  }

  function setCachedTranslation(block, cacheKey, translation) {
    let entry = translationCache.get(block);
    if (!entry) {
      entry = new Map();
      translationCache.set(block, entry);
    }
    entry.set(cacheKey, translation);
  }

  // 别的文件要用的，都从这张架子上取。
  Object.assign(hov, {
    buildCacheKey, getBlockText, getCachedTranslation, resolveBlockFromInteractionTarget,
    resolveBlockFromTarget, setCachedTranslation,
  });
})();
