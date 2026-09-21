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
  const SKIP_SELECTOR = '.ai-translator-popup, .ai-translator-inline-block, .ai-translator-hover-translation, .ai-translator-selection-translation, #ai-translator-float-ball, #ai-translator-float-menu, #ai-translator-progress, #ai-translator-selection-btn';
  const SKIP_TAG_SELECTOR = 'script, style, noscript, iframe, textarea, input, select, code, pre, svg, canvas, kbd, samp, var';

  const translationCache = new WeakMap();


  function resolveBlockFromTarget(target) {
    if (!target) return null;
    let el = target.nodeType === Node.ELEMENT_NODE ? target : target.parentElement;
    if (!el) return null;

    if (el.closest(SKIP_SELECTOR)) return null;
    if (el.closest(SKIP_TAG_SELECTOR)) return null;
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

  function resolveBlockFromInteractionTarget(target) {
    if (!target) return null;
    const translationEl = target.closest?.('.ai-translator-inline-block');
    if (translationEl && hov.inlineTranslationSources.has(translationEl)) {
      return hov.inlineTranslationSources.get(translationEl) || null;
    }
    return resolveBlockFromTarget(target);
  }

  function isValidBlock(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return false;
    if (element.isContentEditable) return false;
    if (element.closest(SKIP_SELECTOR)) return false;
    if (element.closest(SKIP_TAG_SELECTOR)) return false;
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

  function buildCacheKey(text, targetLang) {
    return `${targetLang || ''}::${text}`;
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
