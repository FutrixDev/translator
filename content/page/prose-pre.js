// Blab Translation — 整页翻译与悬停：散文 <pre>
//
// 老式博客和邮件列表存档会把整篇文章放进一个 <pre>，靠 white-space: pre-wrap
// 折行，段与段之间隔一个空行。antirez.com 整站都是这样：
// <article class="comment"><span class="info">…</span><pre>正文…</pre></article>。
// PRE 在不翻的标签里（SKIP_TAG_SELECTOR），这样的页面以前一段正文都收不到，送去翻的
// 只有标题、「3905 days ago」和页脚；按住悬停键指着正文，也什么都不翻。
//
// 和代码块的分界有两条。一是代码要保住每一行原来的排法，所以几乎不开自动折行。
// 二是代码会带不翻的标签（<code>/<kbd>/<samp>…），或者落在语法高亮之类的代码块
// 容器里（not-prose.js 的 isInsideCodeContainer）。都不沾，才算散文；每一段裹成
// 锚点之前另外还要再过一次代码 / 网址 / 非正文判定（collect.js 的 wrapIfProse）。
// 可编辑的 <pre> 不算：切段要搬动文本节点，那是用户正在写的字。
// white-space: pre（不折行）的纯文本不收：译文会继承不折行，成了一条横穿页面的长行。
//
// 整页收集（content/page/collect.js）和悬停（content/hover/blocks.js）都问这里：
// skippedByTag 说一个元素是不是落在代码里（散文 <pre> 和它的段落不算）。收集器收到
// <pre> 本身时用 paragraphs 把它切成段；悬停用 paragraphOf 取指针底下那一段。
// content/page/insert.js 问 isParagraph：一段的译文放在这段下面。
(function() {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT;
  if (!ctx) return;

  const PROSE_WHITE_SPACE = new Set(['pre-wrap', 'pre-line', 'break-spaces']);

  // 不翻的标签，整棵子树一起跳过：脚本、表单控件、画布，以及代码（PRE 在这里）。
  const SKIP_TAG_SELECTOR = 'script, style, noscript, iframe, textarea, input, select, code, pre, svg, canvas, kbd, samp, var';

  // <pre> 里装着上面的标签之一（<code>/<kbd>…），或者自己落在其中之一里，就是代码。
  // 只读编辑器（CodeMirror 等，MANAGED_DOM_ROOT_SELECTOR）里的 <pre> 是编辑器自己的
  // 行，不是文章：切段要搬动它的文本节点，编辑器会当成被改坏了重画。可编辑的
  // <pre>（WordPress 的预格式块、富文本编辑器）也一样不能动。
  function isProse(el) {
    if (el.tagName !== 'PRE') return false;
    if (el.isContentEditable) return false;
    if (ctx.isInsideManagedDomRoot && ctx.isInsideManagedDomRoot(el)) return false;
    if (ctx.isInsideCodeContainer(el)) return false;
    if (el.querySelector(SKIP_TAG_SELECTOR)) return false;
    const parent = ctx.composedParent(el);
    if (parent && ctx.closestComposed(parent, SKIP_TAG_SELECTOR)) return false;
    return PROSE_WHITE_SPACE.has(window.getComputedStyle(el).whiteSpace);
  }

  // 不翻的标签管的是整棵子树。散文 <pre> 例外，它自己和裹给它的段落照收。段落
  // 里面的 <a>/<b> 不单独算一块：它们是那一段的内联内容，跟着那一段走。
  function skippedByTag(element) {
    const hit = ctx.closestComposed(element, SKIP_TAG_SELECTOR);
    if (!hit) return false;
    const ownParagraph = hit === element || isParagraph(element);
    return !(ownParagraph && isProse(hit));
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

  // at（落在 <pre> 里的一个活的 Range）所在的那一段，没裹过的就地裹成锚点。切段会
  // 拆文本节点，活的 Range 跟着拆开的那一半走，所以位置要用 Range 给，不能给节点。
  // 空行、我们插进来的译文不属于任何一段，给 null。没裹过的段落和整页收集一样先过
  // collect.js 的 wrapIfProse：只是个网址、像代码的那段不裹，也给 null。
  // 位置正好在一段的第一个字前面时，切开之后它留在前一道空行的末尾（splitText 只
  // 搬走切点后面的位置），算下一段的。
  function paragraphOf(pre, at) {
    const found = paragraphs(pre);
    let child = at.startContainer === pre ? pre.childNodes[at.startOffset] : at.startContainer;
    if (child === at.startContainer && isParagraphBreak(child) && at.startOffset === child.data.length) {
      child = child.nextSibling;
    }
    while (child && child.parentNode !== pre) child = child.parentNode;
    if (!child) return null;
    const paragraph = found.find((each) => each === child || (Array.isArray(each) && each.includes(child)));
    if (!paragraph) return null;
    return Array.isArray(paragraph) ? ctx.wrapIfProse(paragraph, pre) : paragraph;
  }

  // 散文 <pre> 的一段（paragraphs 交给 collect.js 裹好的锚点）。锚点是内联 span，
  // 但读者眼里它是一段：insert.js 据此把译文当块放在它后面，而不是挂在它右边。
  function isParagraph(element) {
    return element.classList.contains(ctx.TEXT_RUN_CLASS)
      && !!element.parentElement && element.parentElement.tagName === 'PRE';
  }

  ctx.prosePre = { isProse, skippedByTag, paragraphs, paragraphOf, isParagraph };
})();
