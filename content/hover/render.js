// Blab Translation 悬停/划选翻译 —— 译文长什么样
//
// 译文要和原文看着像一家的：字号、行高、字体、对齐都照原文块的 computed style 抄，
// 但位置类的 class 一概不抄（照抄 absolute/fixed 会把译文甩到页面另一头）。
//
// 转圈的三个点、公式占位符放回原件、以及「插在块后面还是块里面」的取舍也在这里。
(function() {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT;
  if (!ctx) return;

  const { state } = ctx;
  const t = ctx.t;
  // 这一族共用的架子，说明见 content/content-hover-translation.js 顶上。
  const hov = (ctx.hover = ctx.hover || {});

  const POSITION_CLASSES = /\b(absolute|fixed|sticky|relative|inset-\S*|top-\S*|bottom-\S*|left-\S*|right-\S*|z-\S*)\b/g;



  function buildBaseStyle(computedStyle, omitColor = false) {
    return `
      font-size: ${computedStyle.fontSize};
      font-family: ${computedStyle.fontFamily};
      font-weight: ${computedStyle.fontWeight};
      line-height: ${computedStyle.lineHeight};
      text-align: ${computedStyle.textAlign};
      ${omitColor ? '' : `color: ${computedStyle.color};`}
      letter-spacing: ${computedStyle.letterSpacing};
      opacity: 0.85;
    `;
  }

  function createLoadingDots() {
    const dots = document.createElement('span');
    dots.className = hov.INLINE_LOADING_CLASS;
    return dots;
  }

  function renderInlineLoading(block, options = {}) {
    const { kind } = options;
    const className = kind === 'hover' ? 'ai-translator-hover-translation' : 'ai-translator-selection-translation';

    // 受管容器先问一句：那里的译文是原文块的 ::after，下面这一整套建节点、抄样式、
    // 挑插入位置都用不上。动画点点也做不到生成内容上，加载态用一句静态文案。
    const managedLoading = hov.renderManaged(block, t('translating'), { kind, state: 'loading', className });
    if (managedLoading) return managedLoading;

    const isHorizontalFlex = ctx.isHorizontalFlexParent ? ctx.isHorizontalFlexParent(block) : false;
    const inlineTarget = isHorizontalFlex && ctx.getInlineTranslationTarget
      ? ctx.getInlineTranslationTarget(block)
      : block;
    const computedStyle = window.getComputedStyle(inlineTarget);

    if (isHorizontalFlex) {
      const loadingEl = document.createElement('span');
      loadingEl.className = `ai-translator-inline-block ai-translator-inline-right ${className} ${hov.INLINE_LOADING_CLASS}`;
      loadingEl.style.cssText = `
        font-size: 0.85em;
        font-family: ${computedStyle.fontFamily};
        font-weight: ${computedStyle.fontWeight};
        line-height: ${computedStyle.lineHeight};
        color: ${computedStyle.color};
        letter-spacing: ${computedStyle.letterSpacing};
        opacity: 0.7;
        display: inline;
        margin: 0;
        padding: 0;
      `;
      inlineTarget.appendChild(loadingEl);
      return loadingEl;
    }

    // 往哪儿插和整页翻译共用一套判据——表格单元格、列表项、页面自己画了框的块都只能
    // 往【内部】插，否则分别是多一列、多一条幽灵条目、译文掉到框外面。
    // 见 content-page-translation.js 的 getTranslationPlacement。
    const placement = ctx.getTranslationPlacement
      ? ctx.getTranslationPlacement(block, computedStyle)
      : { inside: false, tag: 'div' };
    const loadingEl = document.createElement(placement.inside ? placement.tag : block.tagName);
    if (block.className && !placement.inside) {
      loadingEl.className = block.className
        .replace('ai-translator-translated', '')
        .replace(POSITION_CLASSES, '')
        .trim();
    }
    loadingEl.classList.add('ai-translator-inline-block', className, hov.INLINE_LOADING_CLASS);
    loadingEl.style.cssText = buildBaseStyle(computedStyle) + `
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    `;

    if (ctx.getTextOffsetLeft) {
      const textOffset = ctx.getTextOffsetLeft(block, { fromContentBox: placement.inside });
      if (textOffset > 0) {
        loadingEl.style.setProperty('padding-left', `${textOffset}px`, 'important');
      }
    }

    if (block.hasAttribute('slot')) {
      const internalLoading = document.createElement('span');
      internalLoading.className = `ai-translator-inline-block ${className} ${hov.INLINE_LOADING_CLASS}`;
      internalLoading.style.cssText = buildBaseStyle(computedStyle) + `
        display: block;
        margin: 0;
        padding: 0;
        box-sizing: border-box;
      `;
      block.appendChild(internalLoading);
      return internalLoading;
    }

    if (placement.inside) {
      block.appendChild(loadingEl);
      return loadingEl;
    }

    block.after(loadingEl);
    return loadingEl;
  }

  function renderInlineTranslation(block, translation, mathElements = [], options = {}) {
    const { kind, isError } = options;
    const className = kind === 'hover' ? 'ai-translator-hover-translation' : 'ai-translator-selection-translation';

    // 见 renderInlineLoading：受管容器走生成内容，下面那套插节点的路都用不上。
    const managed = hov.renderManaged(block, translation, {
      kind,
      state: isError ? 'error' : null,
      className,
      hasMath: mathElements.length > 0
    });
    if (managed) return managed;

    const isHorizontalFlex = ctx.isHorizontalFlexParent ? ctx.isHorizontalFlexParent(block) : false;
    const inlineTarget = isHorizontalFlex && ctx.getInlineTranslationTarget
      ? ctx.getInlineTranslationTarget(block)
      : block;
    const computedStyle = window.getComputedStyle(inlineTarget);

    if (isHorizontalFlex) {
      const translationEl = document.createElement('span');
      translationEl.className = `ai-translator-inline-block ai-translator-inline-right ${className}`;

      if (mathElements.length && ctx.buildTranslationContentWithMath) {
        ctx.buildTranslationContentWithMath(translationEl, translation, mathElements, ' ');
      } else {
        translationEl.textContent = ` ${translation}`;
      }

      translationEl.style.cssText = `
        font-size: 0.85em;
        font-family: ${computedStyle.fontFamily};
        font-weight: ${computedStyle.fontWeight};
        line-height: ${computedStyle.lineHeight};
        ${isError ? '' : `color: ${computedStyle.color};`}
        letter-spacing: ${computedStyle.letterSpacing};
        opacity: 0.7;
        display: inline;
        margin: 0;
        padding: 0;
      `;

      if (isError) {
        translationEl.classList.add('ai-translator-error');
      }

      inlineTarget.appendChild(translationEl);
      return translationEl;
    }

    // 见 renderInlineLoading：插入位置和整页翻译共用 getTranslationPlacement
    const placement = ctx.getTranslationPlacement
      ? ctx.getTranslationPlacement(block, computedStyle)
      : { inside: false, tag: 'div' };
    const translationEl = document.createElement(placement.inside ? placement.tag : block.tagName);
    if (block.className && !placement.inside) {
      translationEl.className = block.className
        .replace('ai-translator-translated', '')
        .replace(POSITION_CLASSES, '')
        .trim();
    }
    translationEl.classList.add('ai-translator-inline-block', className);

    if (mathElements.length && ctx.buildTranslationContentWithMath) {
      ctx.buildTranslationContentWithMath(translationEl, translation, mathElements);
      translationEl.style.opacity = '0.85';
    } else {
      translationEl.textContent = translation;
      translationEl.style.cssText = buildBaseStyle(computedStyle, isError) + `
        margin: 0;
        padding: 0;
        box-sizing: border-box;
      `;
    }

    if (isError) {
      translationEl.classList.add('ai-translator-error');
    }

    if (ctx.getTextOffsetLeft) {
      const textOffset = ctx.getTextOffsetLeft(block, { fromContentBox: placement.inside });
      if (textOffset > 0) {
        translationEl.style.setProperty('padding-left', `${textOffset}px`, 'important');
      }
    }

    if (block.hasAttribute('slot')) {
      const internalTranslation = document.createElement('span');
      internalTranslation.className = `ai-translator-inline-block ${className}`;

      if (mathElements.length && ctx.buildTranslationContentWithMath) {
        ctx.buildTranslationContentWithMath(internalTranslation, translation, mathElements);
        internalTranslation.style.opacity = '0.85';
      } else {
        internalTranslation.textContent = translation;
        internalTranslation.style.cssText = buildBaseStyle(computedStyle, isError) + `
          display: block;
          margin: 0;
          padding: 0;
          box-sizing: border-box;
        `;
      }

      if (isError) {
        internalTranslation.classList.add('ai-translator-error');
      }
      block.appendChild(internalTranslation);
      return internalTranslation;
    }

    if (placement.inside) {
      block.appendChild(translationEl);
      return translationEl;
    }

    block.after(translationEl);
    return translationEl;
  }

  // 别的文件要用的，都从这张架子上取。
  Object.assign(hov, {
    buildBaseStyle, createLoadingDots, renderInlineLoading, renderInlineTranslation,
  });
})();
