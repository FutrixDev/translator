// Blab Translation — 整页翻译与悬停：文字段锚点
//
// 文本节点自己收不进 blocks，也挂不了译文。收集端给它们找锚点的办法只有一个：
// 把相邻的一串节点（文字，加上夹在中间的 <a>/<i>）整串搬进一个 span。这里管
// 这件事的全部：锚点的类名、裹法、按断点切段，一段直属文字在哪断，以及一段够不够格
// 裹成锚点。
//
// 切段（splitRuns）三处用：collect.js 的 wrapDirectTextRuns（一个元素的直属文字，
// 断点是 breaksInlineRun）、散文 <pre> 的段落（prose-pre.js，只在空行处断），以及
// insert.js 的 textColumnOf（横排 flex 里那段字）。前两处裹之前过 wrapProseRun 的
// 正文判定；textColumnOf 裹的是已经收进来的块里那一列原文，走 wrapLayoutColumn，
// 不过判定。裹法只有 wrapTextRun 一处，不往外给。
(function() {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT;
  if (!ctx) return;

  const TEXT_RUN_CLASS = 'ai-translator-text-run';

  // 内联格式标记：整页翻译提取文本时，把 <a>/<strong>/<em> 等内联格式元素编码成
  // 成对的 <a1>…</a1> 标记随正文一起送翻，译文再按标记克隆原元素重建（见 insert.js
  // 的 buildTranslationContent），从而保留超链接（href）和内联样式（class/style）。
  // 收集端（collect.js 的 isMarkupElement）按这张表编标记，下面的 RUN_TAGS 以它为底。
  //
  // **两个引擎都生成标记。** 这里曾经只在 AI 引擎下生成，理由是“内置 NMT 没有
  // 原样保留标记的承诺”——那是假设，实测不成立。拿 Chrome 内置 Translator 跑
  // en→zh-Hans / zh-Hant / ja，每句连翻三遍结果一致：
  //
  //   12 句 × 3 语言里，标记原样往返的 8 成以上；zh-Hans 的两处缺陷是
  //   `<a1>` 被大写成 `<A1>`（闭标记仍是小写），一处是 `</strong2>` 整个丢失。
  //
  // 所以标记是能用的，只是要求解析端宽容：markerRe 大小写不敏感、容空白（见
  // buildTranslationContent），丢了闭标记就在结尾自动闭合。默认引擎正是内置
  // NMT，之前的开关等于让绝大多数用户的译文一个超链接都留不下。
  //
  // 标记和占位符的语法（生成、剥离）在 shared/text-markers.js。
  const MARKUP_TAGS = new Set([
    'A', 'STRONG', 'B', 'EM', 'I', 'U', 'S', 'SUP', 'SUB', 'MARK', 'SMALL',
    'ABBR', 'DEL', 'INS', 'Q', 'CITE', 'DFN', 'CODE', 'KBD', 'SAMP', 'VAR'
  ]);

  // 我们的界面根，加上挂在页面块上的译文标记。收集端（collect.js）也拿它跳过我们自己的节点。
  const SKIP_OURS = `${ctx.constants.OWN_UI_SELECTOR}, .ai-translator-translated, .ai-translator-inline-source, .ai-translator-inline-block`;

  // 能并进一段直属文字的元素：只有短语级的排版标签（内联标记那一串，加上 <span>
  // 之类没有自己内容模型的）。列表、段落、导航、表格这些容器标签哪怕被页面写成
  // display: inline 也断——一段要整串搬进一个 span，搬进去的 <ul>/<p> 会被 collect.js
  // 的递归再当容器下探，锚点里又裹锚点，没有尽头。
  // 能并进来的判据是「搬了不丢状态」：<img>/<picture>/<svg> 是无状态的图，搬进
  // span 不重新加载，和它们在一个 <p> 里随段落翻译时一样，所以并进来；<iframe>
  // 搬一次就重新加载、<video>/<audio> 回到开头、<object>/<embed> 重建、表单控件
  // （<input>/<select>/<textarea>/<button>）丢掉焦点、选区和输入法状态，<canvas>
  // 不在此列也是同理（它的画面是脚本画的）：这些不在名单里，一律断开。
  const RUN_TAGS = new Set([
    ...MARKUP_TAGS, 'SPAN', 'FONT', 'BDI', 'BDO', 'TIME', 'DATA', 'WBR',
    'RUBY', 'RT', 'RP', 'IMG', 'PICTURE', 'SOURCE'
  ]);
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const runsThrough = (el) => el.namespaceURI === SVG_NS || RUN_TAGS.has(el.tagName);

  // 一段直属文字在这个节点处断开吗（collect.js 的 wrapDirectTextRuns 按它切段）。
  // 并进来的只有文字、注释和短语级元素（RUN_TAGS）：computed display 是 inline，
  // 子树里也全是短语级元素、没有别的显示方式（行内公式整个算，里面的排版是公式自己
  // 的事；<svg> 里面是图自己的事）。块级元素、容器标签、<br>、有状态的替换元素、
  // shadow 宿主 / 自定义元素、上一轮裹好的锚点（它是 collect.js 的 kids() 里的一项，
  // collect.js 的递归自己会收）、我们插进去的译文和界面都断。
  // 标签判定在前、computed style 在后：一个元素按标签就断的，不去算它的样式。
  function breaksInlineRun(node) {
    if (node.nodeType === Node.TEXT_NODE || node.nodeType === Node.COMMENT_NODE) return false;
    if (node.nodeType !== Node.ELEMENT_NODE) return true;
    if (node.matches(SKIP_OURS) || node.matches(ctx.constants.OWN_NODES_SELECTOR)) return true;
    if (node.classList.contains(TEXT_RUN_CLASS)) return true;
    if (ctx.isMathElement(node)) return window.getComputedStyle(node).display !== 'inline';
    if (!runsThrough(node) || ctx.isShadowContainer(node)) return true;
    if (window.getComputedStyle(node).display !== 'inline') return true;
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT, {
      // <svg> 自己要看（页面可能把它写成 display: block），它里面的图元不看。
      acceptNode: (el) => (el.parentElement?.namespaceURI === SVG_NS
        ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    for (let inner = walker.nextNode(); inner; inner = walker.nextNode()) {
      if (!runsThrough(inner)) return true;
      const display = window.getComputedStyle(inner).display;
      if (display !== 'inline' && display !== 'none') return true;
    }
    return false;
  }

  // 把一串相邻节点裹进一个锚点 span，裹法只有这一处。不往外给：外面只经
  // wrapProseRun（过正文判定）或 wrapLayoutColumn（明说不过）裹。
  function wrapTextRun(nodes) {
    const wrap = document.createElement('span');
    wrap.className = TEXT_RUN_CLASS;
    nodes[0].parentNode.insertBefore(wrap, nodes[0]);
    for (const node of nodes) wrap.appendChild(node);
    return wrap;
  }

  // 按页面顺序把一串兄弟节点切成段。kind(node) 说这个节点并进当前这段（'run'）、
  // 在这里断开（'break'），还是断开之后自己单算一项（'anchor'：上一轮裹好的锚点，
  // 原样交回去）。一段要整串搬进一个 span（wrapTextRun），所以父节点换了也断开：
  // 组合子节点（ctx.composedChildNodes）会跨 shadow root 与 light 树。
  // @returns {Array<Node[] | Node>}
  function splitRuns(nodes, kind) {
    const found = [];
    let run = [];
    const flush = () => {
      if (run.length) found.push(run);
      run = [];
    };
    for (const node of nodes) {
      const verdict = kind(node);
      if (verdict === 'run') {
        if (run.length && run[0].parentNode !== node.parentNode) flush();
        run.push(node);
        continue;
      }
      flush();
      if (verdict === 'anchor') found.push(node);
    }
    flush();
    return found;
  }

  const LETTER = /\p{L}/gu;
  const isBlank = (node) => node.nodeType === Node.COMMENT_NODE || !node.textContent.trim();

  /**
   * 一段能不能裹成锚点，能就裹，只此一个判法。
   *
   * 1. 段头段尾没有字的节点（空白、coqdoc 标题前面那个空的 <a id="lab3">）留在段外：
   *    搬进锚点没有用，空锚点还会被当成段里的一个链接编进标记。
   * 2. ownLetters（默认开）：段里【页面自己的散字】不到两个字母就不裹——链接之间
   *    只隔着「 | 」「, 」，那是一排链接，各个链接按元素自己收。散文 <pre> 的段落
   *    关掉这一条：<pre> 里的元素从不单独成块（prose-pre.js 的 skippedByTag），
   *    整段只有一个 <b>Chapter 1</b> 也是一段正文，不裹它就没人收了。
   * 3. 太短、像代码、就是个 URL、不是正文（not-prose.js）的原样留着。
   *
   * 悬停取散文 <pre> 的一段也走这里（prosePre.paragraphOf）：裹好的锚点下一轮整页
   * 收集会原样收下，不再过这几条判定，所以没过判定的段落谁都不能裹。
   *
   * @param {Node[]} run splitRuns 切出来的一段
   * @param {Element} element 这一段的父元素（问 notProse 用）
   * @param {{ownLetters?: boolean}} [options]
   * @returns {HTMLSpanElement|null} 裹好的 span，没裹就是 null
   */
  function wrapProseRun(run, element, { ownLetters = true } = {}) {
    let start = 0;
    let end = run.length;
    while (start < end && isBlank(run[start])) start++;
    while (end > start && isBlank(run[end - 1])) end--;
    const nodes = run.slice(start, end);
    if (!nodes.length) return null;
    if (ownLetters) {
      const own = nodes.filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.data).join('');
      if ((own.match(LETTER) || []).length < 2) return null;
    }
    const text = nodes.filter((node) => node.nodeType !== Node.COMMENT_NODE)
      .map((node) => node.textContent).join('').trim();
    if (text.length < 2) return null;
    if (ctx.looksLikeCodeOrUrl(text) || ctx.notProse(element, text)) return null;
    return wrapTextRun(nodes);
  }

  /**
   * 横排 flex 容器里装着原文的那一列直属文字，裹成一个子项（insert.js 的
   * textColumnOf），好让译文落在它下面。
   *
   * **不过 wrapProseRun 的任何一条判定**：这一列是已经收进来、正要放译文的那一块
   * 自己的原文，够不够格翻在收集时判过了；这里裹只是为了排版，节点原样整串搬进去，
   * 段头段尾的空白、注释也一起。
   *
   * @param {Node[]} nodes splitRuns 切出来的一段
   * @returns {HTMLSpanElement}
   */
  function wrapLayoutColumn(nodes) {
    return wrapTextRun(nodes);
  }

  ctx.TEXT_RUN_CLASS = TEXT_RUN_CLASS;
  ctx.MARKUP_TAGS = MARKUP_TAGS;
  ctx.SKIP_OURS_SELECTOR = SKIP_OURS;
  ctx.breaksInlineRun = breaksInlineRun;
  ctx.splitRuns = splitRuns;
  ctx.wrapProseRun = wrapProseRun;
  ctx.wrapLayoutColumn = wrapLayoutColumn;
})();
