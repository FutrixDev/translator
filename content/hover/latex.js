// Blab Translation 悬停/划选翻译 —— 公式先抠出来
//
// 正文里夹着 $...$、\(...\)、KaTeX/MathJax 渲染出来的节点。整段丢给模型，公式会被
// 当成普通英文改写掉，回来就不是那道式子了。
//
// 所以译之前先把公式换成占位符，把原件留在一边，译完再放回去。这一份只管「认出来、
// 换掉、记住原件」，放回去是 render 那一份的事。
(function() {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT;
  if (!ctx) return;

  const { MATH_CONTAINER_SELECTOR } = ctx.constants;
  // 这一族共用的架子，说明见 content/content-hover-translation.js 顶上。
  const hov = (ctx.hover = ctx.hover || {});

  // 认 LaTeX 的分隔符规则只写在 content/page/not-prose.js，整页收集用的是同一份。
  function resolveLatexSafeOffset(text, offset) {
    const ranges = ctx.inlineLatexRanges(text);
    for (const range of ranges) {
      if (offset > range.start && offset < range.end) {
        return Math.min(range.end, text.length);
      }
    }
    return offset;
  }

  function extractLatexPlaceholders(text, startIndex = 0) {
    if (!text) return { text: '', mathElements: [] };

    const mathElements = [];
    let mathIndex = startIndex;

    function addPlaceholder(raw) {
      mathIndex += 1;
      const placeholder = globalThis.TextMarkers.placeholder(mathIndex);
      mathElements.push({ placeholder, type: 'text', text: raw });
      return placeholder;
    }

    return { text: ctx.replaceInlineLatex(text, addPlaceholder), mathElements };
  }

  function extractSelectionPlaceholders(selectionText, selectionRange) {
    const range = hov.resolveSelectionRange(selectionRange);
    let baseText = selectionText || '';
    let mathElements = [];

    if (range && ctx.getTextWithMathPlaceholders) {
      const fragment = range.cloneContents();
      const container = document.createElement('span');
      container.appendChild(fragment);

      if (MATH_CONTAINER_SELECTOR) {
        container.querySelectorAll(MATH_CONTAINER_SELECTOR).forEach((node) => {
          const id = node.getAttribute?.('id');
          if (!id) return;
          const original = document.getElementById(id);
          if (original && original !== node && original.matches?.(MATH_CONTAINER_SELECTOR)) {
            node.replaceWith(original.cloneNode(true));
          }
        });
      }

      const extracted = ctx.getTextWithMathPlaceholders(container);
      if (extracted?.text) {
        baseText = extracted.text;
        mathElements = Array.isArray(extracted.mathElements) ? extracted.mathElements : [];
      }
    }

    const extractedLatex = extractLatexPlaceholders(baseText, mathElements.length);
    return {
      text: extractedLatex.text,
      mathElements: mathElements.concat(extractedLatex.mathElements)
    };
  }

  // 别的文件要用的，都从这张架子上取。
  Object.assign(hov, {
    extractSelectionPlaceholders, resolveLatexSafeOffset,
  });
})();
