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

  function shouldTreatAsInlineLatex(content) {
    const trimmed = content.trim();
    if (!trimmed) return false;
    if (/^\d[\d,.\s]*$/.test(trimmed)) return false;
    if (/\\/.test(trimmed)) return true;
    if (/[\^_={}|<>]/.test(trimmed)) return true;
    if (/[\p{Sm}]/u.test(trimmed)) return true;
    if (/[\p{L}]/u.test(trimmed)) return true;
    return false;
  }

  function findInlineLatexRanges(text) {
    if (!text) return [];
    const ranges = [];

    const addRange = (start, end) => {
      if (start >= 0 && end > start) {
        ranges.push({ start, end });
      }
    };

    const addMatches = (regex) => {
      regex.lastIndex = 0;
      let match;
      while ((match = regex.exec(text)) !== null) {
        addRange(match.index, match.index + match[0].length);
        if (match[0].length === 0) {
          regex.lastIndex += 1;
        }
      }
    };

    addMatches(/\\\(([\s\S]+?)\\\)/g);
    addMatches(/\\\[([\s\S]+?)\\\]/g);
    addMatches(/\$\$([\s\S]+?)\$\$/g);

    const inlineRegex = /(^|[^\\])\$([^\n$]+?)\$/g;
    inlineRegex.lastIndex = 0;
    let match;
    while ((match = inlineRegex.exec(text)) !== null) {
      const prefix = match[1] || '';
      const inner = match[2] || '';
      if (!shouldTreatAsInlineLatex(inner)) {
        if (match[0].length === 0) {
          inlineRegex.lastIndex += 1;
        }
        continue;
      }
      const start = match.index + prefix.length;
      const end = start + inner.length + 2;
      addRange(start, end);
      if (match[0].length === 0) {
        inlineRegex.lastIndex += 1;
      }
    }

    return ranges;
  }

  function resolveLatexSafeOffset(text, offset) {
    const ranges = findInlineLatexRanges(text);
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
      const placeholder = `{{${mathIndex}}}`;
      mathElements.push({ placeholder, type: 'text', text: raw });
      return placeholder;
    }

    let result = text;
    result = result.replace(/\\\(([\s\S]+?)\\\)/g, (match) => addPlaceholder(match));
    result = result.replace(/\\\[([\s\S]+?)\\\]/g, (match) => addPlaceholder(match));
    result = result.replace(/\$\$([\s\S]+?)\$\$/g, (match) => addPlaceholder(match));
    result = result.replace(/(^|[^\\])\$([^\n$]+?)\$/g, (match, prefix, inner) => {
      if (!shouldTreatAsInlineLatex(inner)) {
        return match;
      }
      const placeholder = addPlaceholder(`$${inner}$`);
      return prefix + placeholder;
    });

    return { text: result, mathElements };
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
