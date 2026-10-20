// Blab Translation — 整页翻译：散文 <pre>
//
// 老式博客和邮件列表存档会把整篇文章放进一个 <pre>，靠 white-space: pre-wrap
// 折行，段与段之间隔一个空行。antirez.com 整站都是这样：
// <article class="comment"><span class="info">…</span><pre>正文…</pre></article>。
// PRE 在收集器的 skipTags 里，这样的页面以前一段正文都收不到，送去翻的只有标题、
// 「3905 days ago」和页脚。
//
// 和代码块的分界有两条。一是代码要保住每一行原来的排法，所以几乎不开自动折行。
// 二是代码会带收集器 skipTags 里的标签（<code>/<kbd>/<samp>…）。两条都不沾，才算
// 散文；每一段另外还要再过一次收集器自己的代码 / 网址 / 非正文判定，那一步和
// 裹锚点都在 collect.js，这里只切段。
// white-space: pre（不折行）的纯文本不收：译文会继承不折行，成了一条横穿页面的长行。
//
// content/page/collect.js 在两处问这里：skipTags 命中时问 isProse（散文 <pre>
// 和它的段落照收），收到 <pre> 本身时用 paragraphs 把它切成段。content/page/insert.js
// 问 isParagraph：一段的译文放在这段下面。
(function() {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT;
  if (!ctx) return;

  const PROSE_WHITE_SPACE = new Set(['pre-wrap', 'pre-line', 'break-spaces']);

  // skipSelector 是收集器的 skipTags：<pre> 里装着其中之一（<code>/<kbd>…），或者
  // 自己落在其中之一里，就是代码。
  // 只读编辑器（CodeMirror 等，MANAGED_DOM_ROOT_SELECTOR）里的 <pre> 是编辑器自己的
  // 行，不是文章：切段要搬动它的文本节点，编辑器会当成被改坏了重画。
  function isProse(el, skipSelector) {
    if (el.tagName !== 'PRE') return false;
    if (ctx.isInsideManagedDomRoot && ctx.isInsideManagedDomRoot(el)) return false;
    if (el.querySelector(skipSelector)) return false;
    const parent = ctx.composedParent(el);
    if (parent && ctx.closestComposed(parent, skipSelector)) return false;
    return PROSE_WHITE_SPACE.has(window.getComputedStyle(el).whiteSpace);
  }

  // 散文 <pre> 的段界是空行，不是元素。所以先在空行那里把文本节点切开，再把
  // 两道空行之间的那一串节点（文字，加上夹在中间的 <a>/<b>）当成一段，由
  // collect.js 整串裹成一个锚点 span：一段就是一块。
  // wrapDirectTextRuns 的切法用不了：它碰到元素就断开，段中间一个链接就把一段
  // 切成三块，链接自己还会被当成独立的一块送去翻。
  // 上一轮裹好的段落（TEXT_RUN_CLASS）原样算一段，而且要先认：翻过的段落带着
  // .ai-translator-translated，得交回收集器去做陈旧 / 换目标语言的判定。我们
  // 插进来的译文和界面算段界。
  const PARAGRAPH_BREAK = /\n\s*\n/;

  function splitAtParagraphBreaks(node) {
    let rest = node;
    for (;;) {
      const match = PARAGRAPH_BREAK.exec(rest.data);
      if (!match) return;
      const gap = match.index ? rest.splitText(match.index) : rest;
      if (match[0].length >= gap.data.length) return;
      rest = gap.splitText(match[0].length);
    }
  }

  function isParagraphBreak(node) {
    return node.nodeType === Node.TEXT_NODE && !node.data.trim() && PARAGRAPH_BREAK.test(node.data);
  }

  // @returns {Array<Node[] | Element>} 按页面顺序的段：还没裹的一串节点，或者
  //   上一轮已经裹好的锚点 span。
  function paragraphs(pre) {
    for (const node of Array.from(pre.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE) splitAtParagraphBreaks(node);
    }
    const found = [];
    let run = [];
    const flush = () => {
      if (run.length) found.push(run);
      run = [];
    };
    for (const node of Array.from(pre.childNodes)) {
      const element = node.nodeType === Node.ELEMENT_NODE ? node : null;
      if (element && element.classList.contains(ctx.TEXT_RUN_CLASS)) {
        flush();
        found.push(element);
      } else if (isParagraphBreak(node) || (element && element.matches(ctx.constants.OWN_NODES_SELECTOR))) {
        flush();
      } else {
        run.push(node);
      }
    }
    flush();
    return found;
  }

  // 散文 <pre> 的一段（paragraphs 交给 collect.js 裹好的锚点）。锚点是内联 span，
  // 但读者眼里它是一段：insert.js 据此把译文当块放在它后面，而不是挂在它右边。
  function isParagraph(element) {
    return element.classList.contains(ctx.TEXT_RUN_CLASS)
      && !!element.parentElement && element.parentElement.tagName === 'PRE';
  }

  ctx.prosePre = { isProse, paragraphs, isParagraph };
})();
