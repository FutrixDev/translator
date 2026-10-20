// Blab Translation — 整页翻译：不是正文的字
//
// 收集器按标签收块：<span>、<button>、<td> 里有字就收。Reddit / X 的信息流里，这样
// 收进来的有两类不是给人读的正文（D-429）：
//
// - **只有数字和符号**：投票数「12」、比分「24」、规则序号「1」、「94.2%」。译出来还
//   是那几个数字，排在原文旁边就是同一个数写两遍。以前只在 <td>/<th> 上跳过，现在
//   对每一块都跳过——哪个标签装着，都不是要译的字。
// - **控件上的短标签**：「Share」「Join」「Follow」「Best」。它们排在一行 flex 里，
//   译文挂在右边，把整行挤歪；读者本来就认得这些按钮。认法是元素落在一个控件里
//   （<button> 或按钮 / 标签页 / 菜单项 / 选项 / 开关这几种 role），而那个控件自己
//   **看得见的**字很短：不过 30 个字符、不过 3 个词、没有句末标点。问控件整体而不是
//   这个元素，是因为整张卡片也会写成 role=button——卡片里的正文不能跟着按钮一起跳过。
//   控件里有标题、段落、列表项，它就是一张卡片，不是按钮：卡片里一句三个词的标题
//   照样要译。
//   中日韩文不用空格分词，两个字算一个词：「分享」「查看全部评论」是标签，一句
//   二十个字的标题不是。
//   <svg> 里的 <title>/<desc> 不画出来，不算看得见的字。
//   「看得见」要剔掉读屏说明：Reddit 的 <button>Share<faceplate-screen-reader-content>
//   Share this post with other people</…></button>，按 textContent 数就是 7 个词，
//   标签照样被译（判定同 content/page/reader-hidden.js）。
//
// 链接（<a>、role=link）不算控件：帖子标题、正文里的链接都是要读的字。
// collect.js 收块的两条路（内联标签、块级标签）都问这一处；命中就整块不收，不再往
// 下落到另一条路。
//
// 另外两样也不是给人读的字，同样住在这里：
//
// - **代码和网址**（looksLikeCodeOrUrl）：按字面认，一段字像代码、或者主要是网址。
// - **代码块容器**（isInsideCodeContainer）：按 class 认，语法高亮、LaTeXML 清单。
//
// 整页收集（collect.js）和悬停取散文 <pre> 的一段（prose-pre.js）问的是同一处：悬停
// 裹好的锚点下一轮整页收集会原样收下，两边的判定不能分叉。
(function() {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT;
  if (!ctx) return;

  const CONTROL = 'button,[role=button],[role=tab],[role=menuitem],[role=menuitemradio],' +
    '[role=menuitemcheckbox],[role=option],[role=switch]';
  const LABEL_MAX_CHARS = 30;
  const LABEL_MAX_WORDS = 3;
  const CJK = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/g;
  // 装着这些的控件是一张卡片。
  const PROSE_TAGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'P', 'LI', 'BLOCKQUOTE']);
  // 句末标点后面跟空白或到头才算：「v1.2」里的点不是句号。
  const SENTENCE_END = /[.!?。！？](\s|$)/;

  // 至少一个数字，其余全是数字、空白和常见数值符号：0.83、94.2%、±0.02、1,234、24–17。
  // 要求有数字，免得「N/A」「—」这类被当成数字。
  function isNumericOrSymbolOnly(text) {
    const t = (text || '').trim();
    if (!/\d/.test(t)) return false;
    return /^[\d\s.,%±+\-*/()<>=:~×·°∓‰$€£¥–—]+$/.test(t);
  }

  // 控件上眼睛看得见的字（组合树，跳过 display:none、读屏说明、<svg> 和藏起来的
  // slot）；控件是一张卡片时答 null。超过上限就不必再读了：结论已经是「不是短标签」。
  function visibleLabel(control) {
    if (PROSE_TAGS.has(control.tagName)) return null;
    let text = '';
    let card = false;
    const walk = (el) => {
      for (const node of ctx.composedChildNodes(el)) {
        if (card || text.length > LABEL_MAX_CHARS * 2) return;
        if (ctx.inHiddenSlot(node)) continue;
        if (node.nodeType === Node.TEXT_NODE) {
          text += node.textContent;
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          if (node.tagName === 'SCRIPT' || node.tagName === 'STYLE') continue;
          if (node.tagName.toLowerCase() === 'svg') continue;
          if (PROSE_TAGS.has(node.tagName)) { card = true; return; }
          const style = window.getComputedStyle(node);
          if (style.display === 'none' || ctx.hiddenFromReaders(style)) continue;
          text += ' ';
          walk(node);
        }
      }
    };
    walk(control);
    return card ? null : text.replace(/\s+/g, ' ').trim();
  }

  // 空格分出的词，加上中日韩文的字数折半。
  function wordCount(text) {
    const cjk = (text.match(CJK) || []).length;
    const spaced = text.replace(CJK, ' ').split(' ').filter(Boolean).length;
    return spaced + Math.ceil(cjk / 2);
  }

  function isShortLabel(text) {
    return text !== null &&
      text.length <= LABEL_MAX_CHARS &&
      wordCount(text) <= LABEL_MAX_WORDS &&
      !SENTENCE_END.test(text);
  }

  // element：要收的块；plainText：它要送去翻译的字（已剥掉占位符和标记）。
  function notProse(element, plainText) {
    if (isNumericOrSymbolOnly(plainText)) return true;
    const control = ctx.closestComposed(element, CONTROL);
    return !!control && isShortLabel(visibleLabel(control));
  }

  // 用于检测代码/脚本内容的模式
  const codePatterns = [
    /^[\s\S]*<script[\s>]/i,       // 包含 <script 标签
    /^[\s\S]*<\/script>/i,         // 包含 </script> 标签
    /^[\s\S]*<noscript[\s>]/i,     // 包含 <noscript 标签
    /function\s*\([^)]*\)\s*\{/,   // JavaScript 函数定义
    /var\s+\w+\s*=/,               // var 声明
    /const\s+\w+\s*=/,             // const 声明
    /let\s+\w+\s*=/,               // let 声明
    /document\.(getElementById|querySelector|createElement)/, // DOM 操作
    /^\s*(import|export)\s+/m,     // ES6 模块
    /^\s*def\s+\w+\s*\(/m,         // Python 函数
    /^\s*class\s+\w+[\s:(]/m,      // 类定义
    /^\s*@\w+\s*$/m,               // 装饰器
    /^\s*#\s*(include|define|ifdef)/m, // C/C++ 预处理
    /\{\s*"[^"]+"\s*:\s*/,         // JSON 对象
    /^\s*```/m,                     // Markdown 代码块标记
    /self\.\w+\s*=/,               // Python self
    /super\(\)/,                   // super 调用
    /nn\.Module/,                  // PyTorch
    /torch\.\w+/,                  // PyTorch
    /np\.\w+/,                     // NumPy
  ];

  // 检查文本是否看起来像代码
  function looksLikeCode(text) {
    // 如果包含大量特殊字符，可能是代码
    const specialCharRatio = (text.match(/[{}()\[\];=<>]/g) || []).length / text.length;
    if (specialCharRatio > 0.1) return true;

    // 检查代码模式
    for (const pattern of codePatterns) {
      if (pattern.test(text)) return true;
    }

    return false;
  }

  // 检查文本是否主要是URL（不需要翻译）
  function isMainlyUrl(text) {
    // URL正则模式
    const urlPattern = /https?:\/\/[^\s]+/gi;
    const urls = text.match(urlPattern) || [];
    if (urls.length === 0) return false;

    // 计算URL占文本的比例
    const urlLength = urls.reduce((sum, url) => sum + url.length, 0);
    const textWithoutUrls = text.replace(urlPattern, '').trim();

    // 如果移除URL后剩余文本很短（少于10个字符或只有标签如 "DOI:", "URL:" 等）
    // 则认为主要是URL
    if (textWithoutUrls.length < 10) return true;

    // 如果URL占总文本长度的70%以上，认为主要是URL
    if (urlLength / text.length > 0.7) return true;

    return false;
  }

  function looksLikeCodeOrUrl(text) {
    return looksLikeCode(text) || isMainlyUrl(text);
  }

  // 代码块容器的 class 检测。全部按【完整 class token】匹配，绝不用 [class*=] 子串匹配：
  //
  // - highlight / highlighter 及其 - 连接的变体（highlight、highlight-source-js、
  //   highlighter-rouge、js-highlight）。营销站常用 highlights/highlighted 命名普通
  //   内容区块——如 retellai.com 用 <section class="c-home-highlights-accordion-2"> 包住
  //   整篇博客正文，子串命中会把整篇正文当成代码块跳过，整页翻译对正文完全不生效。
  //
  // - Prism 的 language-<lang>。这条尤其危险：原来写成 [class*="language-"]，而
  //   Wikipedia 的 Vector 2022 皮肤在 <html> 上挂了 vector-feature-language-in-header-enabled，
  //   子串命中的是 <html>，于是 processElement(document.body) 第一步就 return，
  //   整页一个块都收不到 → 误报“页面已翻译”，全文翻译对所有维基页面彻底失效。
  //   只按 token 前缀匹配仍然不够：language-switcher / language-list / language-item
  //   是多语言站导航的常见命名。所以还要求这个祖先真的装着代码（自身是 <pre>/<code>
  //   或子孙里有），语言切换器不可能满足。
  //
  // - LaTeXML 的 ltx_listing / ltx_lstlisting / ltx_listingline / ltx_verbatim
  //   （arXiv HTML 版与 ar5iv 论文的代码清单）。这条必须单列，上面两条都够不着它：
  //   LaTeXML 把语种写成 ltx_lst_language_Python，是【下划线】，language- 匹配不到；
  //   而清单里根本没有 <pre>/<code>——结构是
  //   <div class="ltx_listing"><div class="ltx_listingline"><span class="ltx_text …">，
  //   于是每个 <span> 都作为内联可译元素被单独送去翻译（实测泄漏 qa / dspy / Predict /
  //   "question->answer" / # Out: Prediction(...)）。looksLikeCode() 也接不住：
  //   拆到单个 span 之后碎片里一个特殊字符都没有。
  const highlightClassTokenRe = /(^|-)highlight(er)?(-|$)/;
  const CODE_CONTAINER_CLASSES = new Set([
    'codehilite', 'sourceCode', 'code-block',
    'ltx_listing', 'ltx_lstlisting', 'ltx_listingline', 'ltx_verbatim',
  ]);
  function holdsCode(el) {
    const tagName = el.tagName;
    return tagName === 'PRE' || tagName === 'CODE' || !!el.querySelector('pre, code');
  }
  function isInsideCodeContainer(element) {
    for (let el = element; el; el = ctx.composedParent(el)) {
      const classList = el.classList;
      if (!classList) continue;
      for (const cls of classList) {
        if (highlightClassTokenRe.test(cls)) return true;
        if (CODE_CONTAINER_CLASSES.has(cls)) return true;
        if (cls.startsWith('language-') && holdsCode(el)) return true;
      }
    }
    return false;
  }

  ctx.notProse = notProse;
  ctx.looksLikeCodeOrUrl = looksLikeCodeOrUrl;
  ctx.isInsideCodeContainer = isInsideCodeContainer;
})();
