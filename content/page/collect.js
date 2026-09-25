// Blab Translation — 整页翻译：收集
//
// 从 DOM 里挑出该翻的块，并把每块读成一段可以送翻的文本：数学公式换成占位符、
// 内联格式编码成 <a1>…</a1> 标记、直属文本节点各自成锚。
// 这里只读页面、不改页面（wrapDirectTextRuns 包 span 是为了拿到锚点），
// 译文怎么放是 content/page/insert.js 的事。
(function() {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT;
  if (!ctx) return;

  const { constants } = ctx;
  const { MATH_CONTAINER_SELECTOR } = constants;
  // 内联格式标记：整页翻译提取文本时，把 <a>/<strong>/<em> 等内联格式元素编码成
  // 成对的 <a1>…</a1> 标记随正文一起送翻，译文再按标记克隆原元素重建（见
  // buildTranslationContent），从而保留超链接（href）和内联样式（class/style）。
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
  // 大小写不敏感同样适用于这条正则：译文里的标记可能是 <A1>。
  const MARKUP_MARKER_RE = /<\/?[a-z]+\d+>/gi;
  // 直属文本节点的锚点类名，见 wrapDirectTextRuns
  const TEXT_RUN_CLASS = 'ai-translator-text-run';

  const MARKUP_TAGS = new Set([
    'A', 'STRONG', 'B', 'EM', 'I', 'U', 'S', 'SUP', 'SUB', 'MARK', 'SMALL',
    'ABBR', 'DEL', 'INS', 'Q', 'CITE', 'DFN', 'CODE', 'KBD', 'SAMP', 'VAR'
  ]);

  // looksLikeCode/isMainlyUrl/长度阈值这类“对正文的判断”都要先剥掉占位符和
  // 内联标记再做，否则 <a1></a1> 里的尖括号会把带链接的段落误判成代码。
  function stripPlaceholders(text) {
    if (!text) return '';
    return text.replace(/\{\{\d+\}\}/g, '').replace(MARKUP_MARKER_RE, '');
  }

  // 本轮收集里，受管容器内有多少块连生成内容都承不住而被放弃。翻译流程用它来
  // 区分“页面已经翻完了”和“正文没能翻”，两句提示的含义完全不同。
  let managedSkipCount = 0;

  // 组合树（content/page/shadow.js）：宿主元素的子节点包括它 shadow root 里的，
  // <slot> 按分配结果取。没有 shadow root 时原样返回 el.children / el.childNodes。
  const kids = (el) => ctx.composedChildren(el);
  const nodesOf = (el) => ctx.composedChildNodes(el);
  const closestAcross = (el, selector) => ctx.closestComposed(el, selector);

  // options.scope：ctx.resolvePageScope() 的结果（content/page/scope.js）。不带时
  // 不做任何范围过滤——e2e 直接调这个函数的地方都是这样用的。
  function collectTranslatableBlocks(root, options) {
    // 单块上限是分批器的口径（content/page/batch.js）：那边按它切块，
    // 这边按它决定一块算不算 oversized，两处必须是同一个数。
    const { MAX_BLOCK_CHARS } = ctx.PAGE_LIMITS;
    managedSkipCount = 0;
    const blocks = [];
    // 站点适配：内置规则表里那两串选择器（见 content/page/site-adapter.js）。整轮
    // 收集只解析一次——规则按 host + path 选中，一轮里不会变。这一页没有规则时两
    // 串都是空串，下面所有用到它们的地方都短路掉，走的还是原来的通用启发式。
    const adapter = ctx.resolveSiteAdapter ? ctx.resolveSiteAdapter() : null;
    const atomicSelector = (adapter && adapter.atomic) || '';
    const excludeSelector = (adapter && adapter.exclude) || '';
    const blockTags = ['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'TD', 'TH', 'FIGCAPTION', 'BLOCKQUOTE', 'DT', 'DD'];
    // 内联可翻译元素 - 这些元素即使不是块级也应单独翻译
    const inlineTags = ['A', 'SPAN', 'LABEL', 'BUTTON'];
    const skipTags = ['SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'TEXTAREA', 'INPUT', 'SELECT', 'CODE', 'PRE', 'SVG', 'CANVAS', 'KBD', 'SAMP', 'VAR'];
    // 容器元素 - 这些元素不应作为整体翻译，应递归处理子元素
    // 表格标签作为容器递归下探到单元格（TD/TH 在 blockTags 中）：很多站点（如 Hacker News）
    // 用表格做整页布局，若把 TABLE/TR 当作 skipTags 会跳过全部正文，导致“0 个可译块 → 误报页面已翻译”。
    const containerTags = ['NAV', 'UL', 'OL', 'DIV', 'SECTION', 'ARTICLE', 'ASIDE', 'HEADER', 'FOOTER', 'MAIN', 'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR'];
    const scope = options && options.scope;
    const scopeCut = scope && scope.skip ? (el) => ctx.pageScopeCut(el, scope) : null;
    const allowed = ctx.createTranslateJudge();
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

    // 检查文本是否只由数字与常见数值符号组成（数据表单元格常见，如 0.83、94.2%、±0.02、1,234）。
    // 这类单元格翻译无意义，还会给结果表添噪，直接跳过。要求至少含一个数字，
    // 以免误伤 "N/A"、"Method" 等含字母的表头/文本单元格。
    function isNumericOrSymbolOnly(text) {
      const t = (text || '').trim();
      if (!t) return false;
      if (!/\d/.test(t)) return false;
      return /^[\d\s.,%±+\-*/()<>=:~×·°∓‰$€£¥–—]+$/.test(t);
    }

    // 检查元素是否有可翻译的子元素（用于判断是否应该递归而非整体翻译）
    function hasTranslatableChildren(element) {
      for (const child of kids(element)) {
        // 跳过数学公式元素 - 数学公式应该作为整体保留，不应该导致父元素被拆分
        if (isMathElement(child)) {
          continue;
        }
        // 跳过图标元素
        if (isIconElement(child)) {
          continue;
        }
        const childTag = child.tagName;
        // 如果子元素是块级或内联可翻译元素，且有文本内容
        if ((blockTags.includes(childTag) || inlineTags.includes(childTag)) &&
            child.textContent.trim().length >= 2) {
          return true;
        }
        // 递归检查
        if (hasTranslatableChildren(child)) {
          return true;
        }
      }
      return false;
    }

    // 把元素的【直属文本节点】按连续段裹进 <span>，给它们一个能收进 blocks、
    // 之后能挂译文的锚点——文本节点自己两样都做不到。
    // 只裹真要翻的那几段（太短、像代码、就是个 URL、纯数字的都不裹），页面 DOM
    // 就一个多余节点都不会多出来；<br>/<span> 这些元素天然把文本分段，分开裹，
    // 原来的换行结构就还在。
    function wrapDirectTextRuns(element) {
      const runs = [];
      let current = null;
      for (const node of nodesOf(element)) {
        if (node.nodeType === Node.TEXT_NODE) {
          // 组合子节点跨了 shadow root 与 light 树：父亲换了就是另一段
          if (!current || current[0].parentNode !== node.parentNode) {
            current = [];
            runs.push(current);
          }
          current.push(node);
          continue;
        }
        current = null;
      }
      for (const run of runs) {
        const text = run.map((node) => node.textContent).join('').trim();
        if (text.length < 2) continue;
        if (looksLikeCode(text) || isMainlyUrl(text) || isNumericOrSymbolOnly(text)) continue;
        const wrap = document.createElement('span');
        wrap.className = TEXT_RUN_CLASS;
        run[0].parentNode.insertBefore(wrap, run[0]);
        for (const node of run) wrap.appendChild(node);
      }
    }

    // 检查元素是否有多个可翻译的直接子元素（用于判断是否应该递归而非整体翻译）
    // 这对于导航菜单等结构很重要，避免将整个菜单作为一个块翻译
    function hasMultipleTranslatableDirectChildren(element) {
      let count = 0;
      for (const child of kids(element)) {
        const childTag = child.tagName;
        // 如果子元素是块级或内联可翻译元素，且有文本内容
        if ((blockTags.includes(childTag) || inlineTags.includes(childTag)) &&
            child.textContent.trim().length >= 2) {
          count++;
          if (count >= 2) return true;
        }
      }
      return false;
    }

    // 获取元素的直接文本内容（不包括子元素的文本）
    function getDirectText(element) {
      let text = '';
      for (const child of nodesOf(element)) {
        if (child.nodeType === Node.TEXT_NODE) {
          const content = child.textContent.trim();
          if (content) {
            text += content + ' ';
          }
        }
      }
      return text.trim();
    }

    function processElement(element) {
      if (!element || element.nodeType !== Node.ELEMENT_NODE) return;

      const tagName = element.tagName;

      // 跳过不需要翻译的元素
      if (skipTags.includes(tagName)) return;
      if (element.isContentEditable) return;
      // 站点规则说这一块不必翻：作者名、时间戳、票数、"reply"。这些在形状上和正文
      // 没有区别，通用启发式挡不住。用 closest 而不是 matches，因为排除的是整块——
      // Hacker News 的 `.subtext` 底下还有一串 <a>，它们也在排除之列。
      if (excludeSelector && closestAcross(element, excludeSelector)) return;
      // 受管容器（只读的 Lexical / ProseMirror 等）会把插进去的译文节点撤销掉，
      // 那里的译文只能画成原文块自己的 ::after（见 content-managed-translation.js）。
      // 生成内容承不住的块——有公式、站点自己占用了 ::after、块本身是 flex/grid
      // 容器——翻出来也显示不了，这里就不收：省一次 API 调用的钱。
      if (ctx.isInsideManagedDomRoot && ctx.isInsideManagedDomRoot(element)) {
        const hasMath = !!(MATH_CONTAINER_SELECTOR && element.querySelector(MATH_CONTAINER_SELECTOR));
        if (!(ctx.canRenderManagedTranslation && ctx.canRenderManagedTranslation(element, { hasMath }))) {
          managedSkipCount++;
          return;
        }
      }
      // 节点身份 vs 内容身份。`.ai-translator-translated` 只说「这个**节点**翻过
      // 了」，而 X / Reddit 是虚拟列表：滚动时同一个节点被回收去装下一条推文，
      // class 还在，文字已经换了。只认 class 的话新内容永远被静默跳过。
      // 必须排在下面那条 closest() 前面 —— 它的选择器串里就有
      // `.ai-translator-translated`，而 closest() 从元素自己开始找，先跑就把回收
      // 的块一并挡掉了，陈旧判定再也没机会发生。
      // 整棵子树的文本读一遍不便宜，所以只对**登记过的**元素读：代价跟着已翻块
      // 数走，不跟着页面 DOM 大小走。
      const identity = globalThis.BlockIdentity;
      if (identity.lookup(element)) {
        // 第三个参数是目标语言：内容没变但语言换了的块也要放开重翻，否则改完
        // 目标语言的页面是花的 —— 先前那批留着旧语言，而且没有任何东西会再动它们。
        const target = ctx.currentTargetLang ? ctx.currentTargetLang() : null;
        if (!identity.isStale(element, identity.fingerprint(readSourceText(element)), target)) return;
        ctx.releaseTranslation(element);
      }
      if (closestAcross(element, '.ai-translator-popup, .ai-translator-translated, .ai-translator-inline-source, .ai-translator-inline-block, #ai-translator-float-ball, #ai-translator-float-menu, #ai-translator-progress, #ai-translator-selection-btn, #ai-translator-source-peek')) return;
      if (element.classList.contains('ai-translator-translated')) return;
      if (element.classList.contains('ai-translator-inline-source')) return;

      // 跳过被 skipTags 包含的元素
      if (closestAcross(element, skipTags.map(t => t.toLowerCase()).join(','))) return;

      // 跳过代码块容器（codehilite / sourceCode / highlight 变体 / Prism language-*，
      // 统一在 isInsideCodeContainer 里按完整 class token 匹配）
      if (isInsideCodeContainer(element)) return;

      // 跳过数学公式内部的所有元素 - 数学公式应该整体保留，不单独翻译内部元素
      if (closestAcross(element, MATH_CONTAINER_SELECTOR)) return;

      // 跳过数学公式的隐藏辅助元素（只跳过重复的隐藏版本）
      if (element.classList.contains('MJX_Assistive_MathML') ||
          element.classList.contains('katex-mathml') ||
          element.classList.contains('sr-only') ||
          element.classList.contains('visually-hidden') ||
          element.classList.contains('MathJax_Preview')) return;

      // 跳过 Web Components 的覆盖层 slot 元素
      // 这些元素通常是 absolute 定位覆盖整个区域用于点击跳转
      // 例如 Reddit 的 slot="full-post-link" 元素
      if (element.hasAttribute('slot')) {
        const classList = element.classList;
        // 检测是否是覆盖层元素（absolute 定位 + inset-0 或类似的全覆盖类）
        if ((classList.contains('absolute') || classList.contains('fixed')) &&
            (classList.contains('inset-0') ||
             (classList.contains('top-0') && classList.contains('left-0') &&
              classList.contains('right-0') && classList.contains('bottom-0')))) {
          return; // 跳过覆盖层元素
        }
      }

      // 正文范围（'main' 模式）：导航、侧栏、站点页眉页脚整棵不收，只收里面的 h1。
      const keep = scopeCut && scopeCut(element);
      if (keep) {
        for (const heading of keep) processElement(heading);
        return;
      }
      // 作者说了别翻（translate="no" / .notranslate）：这一块不收，往下找被
      // translate="yes" 重新打开的子树。
      if (!allowed(element)) {
        for (const child of kids(element)) processElement(child);
        return;
      }

      // 检查是否有直接文本内容
      const directText = getDirectText(element);
      const hasDirectText = directText.length >= 2;

      // 站点规则说这一块要整个翻。一条推文的正文是 `<div data-testid="tweetText">`
      // 里一串 <span>，下面那条通则会按「有可翻子元素就下探」把它拆成一句一请求，
      // 译文一句一句插回去。原子块跳过下探这一步，直接走块级分支整块翻——注意它
      // 同时也绕开了 `blockTags.includes(tagName) || hasDirectText` 那道门，推文正文
      // 是个 <div>，文字全在子 <span> 里，两个条件都不成立。
      const atomic = !!(atomicSelector && element.matches(atomicSelector));

      // 对于任何有可翻译子元素的元素，检查是否应该递归处理而非整体翻译
      // 这确保导航菜单等嵌套结构的每个项被单独翻译
      // 注意：只有当子元素是【块级元素】时才递归，内联元素（如 <a>、<span>）应该包含在整体翻译中
      if (!atomic && hasTranslatableChildren(element)) {
        let shouldRecurse = false;
        for (const child of kids(element)) {
          // 跳过数学公式和图标
          if (isMathElement(child) || isIconElement(child)) {
            continue;
          }
          const childTag = child.tagName;
          // 只有当直接子元素是【块级】可翻译元素时才递归
          // 内联元素（如 a, span）应该作为父元素内容的一部分整体翻译
          if (blockTags.includes(childTag) && child.textContent.trim().length >= 2) {
            shouldRecurse = true;
            break;
          }
          // 情况2：直接子元素是容器元素（如 div, ul）且包含可翻译内容
          // shadow 宿主和自定义元素也按容器处理（content/page/shadow.js）
          if ((containerTags.includes(childTag) || ctx.isShadowContainer(child)) &&
              hasTranslatableChildren(child)) {
            shouldRecurse = true;
            break;
          }
        }

        // 如果满足递归条件，递归处理子元素而不是整体翻译
        if (shouldRecurse) {
          // 递归只走 element.children，而【直属文本节点】不在里面。不先把它们裹起来，
          // 一个块级子元素就足以让本元素自己的正文整段消失——
          // alignment.anthropic.com 的对话框正是这个形状：
          //   <div class="code-box"><span>Human:</span> Write a one-stanza poem…<p>…</p></div>
          // 里面的 <p> 让这里递归，于是 "Write a one-stanza poem…" 一次都没被送去
          // 翻译，页面上只剩 <span>Human:</span> 的译文孤零零挂在原文右边。
          // 同一个坑在超长块那条路上已经栽过一次，见 MAX_BLOCK_CHARS 附近的注释。
          wrapDirectTextRuns(element);
          for (const child of kids(element)) {
            processElement(child);
          }
          return;
        }
      }

      // 对于内联元素（如链接、按钮），如果有文本内容，单独翻译
      if (inlineTags.includes(tagName)) {
        const { text, mathElements, markupElements } = getTextWithMathPlaceholders(element, { preserveMarkup: true });
        // 长度阈值按剥掉占位符/内联标记后的正文算，标记本身不该把短链接顶出上限
        const plainText = stripPlaceholders(text).trim();
        if (text && plainText.length >= 2 && plainText.length <= 500) {
          // 跳过看起来像代码或主要是URL的文本
          // 这里要 trim：只含公式的元素排除占位符后会剩下空白（如 "{{1}} {{2}}"），
          // 不 trim 会被当成有正文，进而把纯公式送去翻译。
          const textWithoutMath = plainText;
          if (textWithoutMath && !looksLikeCode(textWithoutMath) && !isMainlyUrl(textWithoutMath)) {
            blocks.push({
              element: element,
              text: text,
              tagName: tagName,
              mathElements: mathElements,
              markupElements: markupElements
            });
            return;
          }
        }
      }

      // 对于块级元素
      if (atomic || blockTags.includes(tagName) || hasDirectText) {
        let { text, mathElements, markupElements } = getTextWithMathPlaceholders(element, { preserveMarkup: true });
        if (text && text.length >= 2) {
          // 跳过看起来像代码或主要是URL的文本（排除数学占位符和内联标记后判断）
          const textWithoutMath = stripPlaceholders(text).trim();

          // 排除公式占位符后没有任何正文：整个块就是一条公式，跳过。
          // 典型是 arXiv/LaTeXML 的行间公式——公式包在 <table class="ltx_equation"> 里，
          // 遍历下探到 <td class="ltx_eqn_cell"> 时 text 只有 "{{1}}"。
          // 若不跳过，"{{1}}" 会被送去翻译，模型原样返回后再按占位符 clone 回原 <math>，
          // 结果是同一条公式在原文下方又渲染一遍（公式出现两遍）。
          // 这里 return 而不递归：块内只有公式，子元素会被 MATH_CONTAINER_SELECTOR 拦下，递归没有意义。
          if (!textWithoutMath) return;

          // 数据表单元格若只是数字/符号（如 0.83、94.2%），跳过：翻译无意义且会给结果表加噪
          if ((tagName === 'TD' || tagName === 'TH') && isNumericOrSymbolOnly(textWithoutMath)) {
            return;
          }
          if (textWithoutMath && (looksLikeCode(textWithoutMath) || isMainlyUrl(textWithoutMath))) {
            // 递归处理子元素，可能有非代码/非URL的部分
            for (const child of kids(element)) {
              processElement(child);
            }
            return;
          }

          // 超长块（如把整段正文塞进一个 <li>、用 <br><br> 分段的“超大列表项”）：
          // 标记 oversized，稍后按标点分块翻译。
          // 不能像以前那样在超限时回退去递归子元素——正文位于本元素的【直属文本节点】里，
          // 递归只遍历子【元素】会把正文整段丢弃，只剩标题/链接被翻译。
          // 超长块回退成纯文本提取：splitTextIntoChunks 只认得 {{n}} 占位符，
          // 会把成对的内联标记从中间切开、拆进不同请求，重建必然错乱。
          if (text.length > MAX_BLOCK_CHARS && markupElements && markupElements.length > 0) {
            const plain = getTextWithMathPlaceholders(element);
            text = plain.text;
            mathElements = plain.mathElements;
            markupElements = [];
          }
          const block = {
            element: element,
            text: text,
            tagName: tagName,
            mathElements: mathElements, // 保存公式信息
            markupElements: markupElements
          };
          if (text.length > MAX_BLOCK_CHARS) {
            block.oversized = true;
          }
          blocks.push(block);
          return; // 不再递归处理子元素
        }
      }

      // 递归处理子元素
      for (const child of kids(element)) {
        processElement(child);
      }
    }

    const starts = scopeCut ? ctx.pageScopeStarts(root, scope) : [root];
    for (const start of starts) processElement(start);
    return blocks;
  }

  // 获取清理后的数学公式 HTML（移除辅助元素，保留视觉渲染）
  function getCleanMathHtml(node) {
    // 克隆节点以避免修改原始 DOM
    const clone = node.cloneNode(true);

    // 需要移除的辅助元素选择器
    const assistiveSelectors = [
      '.MJX_Assistive_MathML',      // MathJax 3 辅助 MathML
      '.mjx-assistive-mml',          // MathJax 3 辅助 MathML (小写)
      '.katex-mathml',               // KaTeX 辅助 MathML
      '.katex-html[aria-hidden]',    // KaTeX 隐藏的 HTML
      '.sr-only',                    // 屏幕阅读器专用
      '.visually-hidden',            // 视觉隐藏
      '.MathJax_Preview',            // MathJax 预览
      'annotation',                  // MathML annotation (文本注释)
      'annotation-xml',              // MathML annotation-xml (XML 注释，arXiv 常用)
      'semantics > mrow:not(:first-child)', // MathML semantics 中的额外内容
    ];

    // 移除所有辅助元素
    assistiveSelectors.forEach(selector => {
      try {
        clone.querySelectorAll(selector).forEach(el => el.remove());
      } catch (e) {
        // 忽略无效选择器
      }
    });

    // 移除 aria-hidden="true" 但保留可见内容的元素
    // 注意：不移除整个元素，只移除 aria-hidden 属性下的某些特定子元素

    // 确保数学公式保持内联显示
    // 使用 !important 覆盖页面 CSS（如 MathJax 默认的 display: block）
    clone.style.setProperty('display', 'inline', 'important');
    clone.style.setProperty('vertical-align', 'baseline', 'important');

    return clone.outerHTML;
  }

  // 检测元素是否是数学公式或其内部元素
  function isMathElement(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;

    // 检查标签名 - 顶层数学容器
    const mathContainerTags = ['MATH', 'MJX-CONTAINER', 'MJX-MATH'];
    if (mathContainerTags.includes(el.tagName)) return true;

    // 检查 MathML 子元素标签 - 这些标签只会出现在数学公式内部
    const mathMLChildTags = [
      'MI', 'MN', 'MO', 'MS', 'MTEXT', 'MSPACE',
      'MSUB', 'MSUP', 'MSUBSUP', 'MUNDER', 'MOVER', 'MUNDEROVER',
      'MFRAC', 'MROOT', 'MSQRT', 'MROW', 'MFENCED', 'MTABLE',
      'MTR', 'MTD', 'MALIGNGROUP', 'MALIGNMARK', 'MSTYLE',
      'MERROR', 'MPADDED', 'MPHANTOM', 'MGLYPH', 'MACTION',
      'SEMANTICS', 'ANNOTATION', 'ANNOTATION-XML'
    ];
    if (mathMLChildTags.includes(el.tagName)) return true;

    // 检查常见的数学公式类名
    const mathClasses = [
      'MathJax', 'MathJax_Display', 'MathJax_Preview',
      'mjx-math', 'mjx-chtml', 'mjx-container',
      'katex', 'katex-display',
      'math', 'equation'
    ];
    if (mathClasses.some(cls => el.classList?.contains(cls))) return true;

    // 检查 data 属性
    if (el.hasAttribute?.('data-mathml') || el.hasAttribute?.('data-latex')) return true;

    // 检查是否在数学容器内部（通过 closest 查找祖先）
    if (closestAcross(el, MATH_CONTAINER_SELECTOR)) return true;

    return false;
  }

  // 检测元素是否是图标元素（图标跳过，不翻译也不保留占位符）
  function isIconElement(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;

    // SVG 图标
    if (el.tagName === 'SVG' || el.tagName === 'svg') return true;

    // Font Awesome 和其他图标库
    const classList = el.classList;
    if (classList) {
      const iconClasses = ['fa', 'fas', 'far', 'fal', 'fad', 'fab', 'fa-solid', 'fa-regular',
        'fa-light', 'fa-duotone', 'fa-brands', 'fa-icon', 'icon', 'iconfont', 'material-icons',
        'glyphicon', 'bi', 'feather', 'lucide'];
      if (iconClasses.some(cls => classList.contains(cls))) return true;
      // 检查是否包含 fa- 开头的类
      if (Array.from(classList).some(cls => cls.startsWith('fa-'))) return true;
    }

    return false;
  }

  // 判断一个节点是否值得作为内联格式标记保留：语义/格式标签整表收，SPAN 只收
  // 带 class 或 style 的——裸 span 没有样式可保，编码它只会给模型添乱。
  function isMarkupElement(node) {
    const tagName = node.tagName;
    if (MARKUP_TAGS.has(tagName)) return true;
    if (tagName === 'SPAN') {
      return !!(node.getAttribute('class') || node.getAttribute('style'));
    }
    return false;
  }

  // 获取元素内容，用占位符替换数学公式（图标直接跳过）
  // 返回 { text, mathElements, markupElements }：
  // - mathElements 保存 DOM 引用或 LaTeX 文本，用于后续还原
  // - markupElements 仅在 options.preserveMarkup 时非空，保存内联格式元素的引用，
  //   文本里对应成对的 <a1>…</a1> 标记（标签名小写 + 序号，序号即数组下标 + 1）
  function getTextWithMathPlaceholders(element, options) {
    const preserveMarkup = !!(options && options.preserveMarkup);
    let text = '';
    const mathElements = [];
    const markupElements = [];
    let mathIndex = 0;

    // 跳过的隐藏类名
    const hiddenClasses = [
      'MJX_Assistive_MathML', 'katex-mathml', 'sr-only',
      'visually-hidden', 'MathJax_Preview'
    ];

    function addMathPlaceholder(entry) {
      mathIndex += 1;
      const placeholder = `{{${mathIndex}}}`;
      mathElements.push({ placeholder, ...entry });
      return placeholder;
    }

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

    function replaceInlineLatex(content) {
      let result = content;
      result = result.replace(/\\\(([\s\S]+?)\\\)/g, (match) => {
        return addMathPlaceholder({ type: 'text', text: match });
      });
      result = result.replace(/\\\[([\s\S]+?)\\\]/g, (match) => {
        return addMathPlaceholder({ type: 'text', text: match });
      });
      result = result.replace(/\$\$([\s\S]+?)\$\$/g, (match) => {
        return addMathPlaceholder({ type: 'text', text: match });
      });
      result = result.replace(/(^|[^\\])\$([^\n$]+?)\$/g, (match, prefix, inner) => {
        if (!shouldTreatAsInlineLatex(inner)) {
          return match;
        }
        const placeholder = addMathPlaceholder({ type: 'text', text: `$${inner}$` });
        return prefix + placeholder;
      });
      return result;
    }

    function processNode(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        let content = node.textContent;
        if (content) {
          // 过滤掉 CSS 样式文本（如 .fa-secondary{opacity:.4}）
          content = content.replace(/\.[\w-]+\s*\{[^}]*\}/g, '');
          // 过滤掉 CSS 选择器残留
          content = content.replace(/\.fa-[\w-]+/g, '');
          // 保护纯文本中的 LaTeX 表达式
          content = replaceInlineLatex(content);
          // 将换行符和多余空白规范化为单个空格
          // HTML 源码中的换行符仅用于可读性，不应影响翻译格式
          content = content.replace(/\s+/g, ' ');
          if (content.trim()) {
            text += content;
          }
        }
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        // 跳过 script 和 style 标签
        if (node.tagName === 'SCRIPT' || node.tagName === 'STYLE') return;

        // 跳过隐藏的辅助元素
        const classList = node.classList;
        if (hiddenClasses.some(cls => classList?.contains(cls))) return;

        // 跳过 display:none
        const style = window.getComputedStyle(node);
        if (style.display === 'none') return;

        // 跳过图标元素（图标是装饰，翻译不需要包含图标）
        if (isIconElement(node)) {
          return;
        }

        // 行内的 notranslate（产品名、人名）：整个元素当占位符，插入时原样克隆回去
        if (ctx.ownTranslateDeclaration(node) === 'no') {
          text += addMathPlaceholder({ type: 'element', element: node });
          return;
        }

        // 检测是否是数学公式 - 使用锚点占位符
        // 使用 {{1}}、{{2}} 格式，LLM 熟悉模板语法，会保持原样
        if (isMathElement(node)) {
          const placeholder = addMathPlaceholder({ type: 'element', element: node });
          text += placeholder;
          return;
        }

        // 内联格式元素：包上成对标记再递归。若递归后一个字都没添上（比如里面
        // 只有图标），把开标记回滚掉——空标记对既没意义又诱导模型幻觉。
        if (preserveMarkup && isMarkupElement(node)) {
          const index = markupElements.length + 1;
          const tag = node.tagName.toLowerCase();
          const open = `<${tag}${index}>`;
          const before = text.length;
          text += open;
          markupElements.push({ index, tag, element: node });
          for (const child of nodesOf(node)) {
            processNode(child);
          }
          if (text.length === before + open.length) {
            text = text.slice(0, before);
            markupElements.pop();
          } else {
            text += `</${tag}${index}>`;
          }
          return;
        }

        // 递归处理子节点
        for (const child of nodesOf(node)) {
          processNode(child);
        }
      }
    }

    for (const child of nodesOf(element)) {
      processNode(child);
    }

    return { text: text.trim(), mathElements, markupElements };
  }

  // 获取元素的直接文本内容（向后兼容）
  function getDirectTextContent(element) {
    const { text } = getTextWithMathPlaceholders(element);
    return text;
  }

  // 这个块「属于页面自己」的那段文字 —— 跳过我们插进去的译文节点。
  //
  // 身份指纹（shared/block-identity.js）两头都走它：落笔时登记一次，之后每一轮
  // 发现再问一次。两头必须是同一个读法，否则每个块都会被判成「内容变了」，翻完
  // 立刻重翻。
  //
  // 不能用 getDirectText：它只读直接子文本节点，而 X 的 [data-testid="tweetText"]
  // 把正文分装在一串 <span> 里，读出来是空字符串 —— 整列推文的指纹全都一样，回收
  // 一次也认不出来。
  // 也不能用 getTextWithMathPlaceholders：那边要的是「送去翻译的文本」，带公式占位
  // 符和内联标记；这边要的是「页面上这段字变了没有」，越素越好。
  // 只跳 `.ai-translator-inline-block` —— 悬停/划词译文也带这个类，所以一并跳掉。
  // 另外两个看起来像「我们的」类名都**不能**跳：
  //   · `.ai-translator-inline-source` 打在**页面自己的块**上（悬停译过的那块），
  //     跳掉就是把真正的正文从指纹里抹去：这段字变了看不出来，而悬停标记被摘掉
  //     时指纹反倒凭空一变，白翻一遍；
  //   · `.ai-translator-text-run` 是 wrapDirectTextRuns 包出来的锚点 span，
  //     里面装的就是原文。
  const OWN_TRANSLATION_CLASS = 'ai-translator-inline-block';
  function readSourceText(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return '';
    let text = '';
    for (const node of nodesOf(element)) {
      if (node.nodeType === Node.TEXT_NODE) {
        text += node.textContent;
      } else if (node.nodeType === Node.ELEMENT_NODE &&
                 !node.classList.contains(OWN_TRANSLATION_CLASS)) {
        text += readSourceText(node);
      }
    }
    return text;
  }

  // 原文第一个文本相对于元素左边的偏移（跳过 icon/svg 等前置元素），用来让译文和
  // 原文的文字左对齐。
  // @param {{fromContentBox?: boolean}} options 译文插到元素【内部】时传 true：
  //   元素那圈 padding/border 译文已经继承了，再按外边框算一次就是双份缩进
  //   （.code-box 的 16px padding 会变成 32px）。
  //
  // 起点是元素的【第一个片段】，不是包围盒。内联原文折成几行时，包围盒的左边是后面
  // 几行的行首，而第一行是从行中间、接在别人的字后面开始的：reddit 信息流摘要把每个
  // <p> 都压成 display:inline，拿包围盒量出来的「缩进」就是第一行前面那截别人的字
  // （实测 152px / 194px），整块译文被推到右边。块级元素只有一个片段，和包围盒相同；
  // 没有盒子（display:contents、没挂上文档）就没有片段，也就没有缩进。
  function getTextInset(element, options) {
    const elementRect = element.getClientRects()[0];
    if (!elementRect || elementRect.width === 0) return 0;
    // 量的是原文的起始边：RTL 原文的文字从右边起，缩进就是文字右边离盒子右边多远。
    const style = window.getComputedStyle(element);
    const rtl = style.direction === 'rtl';
    let originLeft = elementRect.left;
    let originRight = elementRect.right;
    if (options && options.fromContentBox) {
      originLeft += (parseFloat(style.borderLeftWidth) || 0) + (parseFloat(style.paddingLeft) || 0);
      originRight -= (parseFloat(style.borderRightWidth) || 0) + (parseFloat(style.paddingRight) || 0);
    }

    // 递归查找第一个文本节点的位置
    function findFirstTextRect(node) {
      for (const child of nodesOf(node)) {
        if (child.nodeType === Node.TEXT_NODE && child.textContent.trim()) {
          // 使用 Range 获取文本节点的位置
          const range = document.createRange();
          range.selectNodeContents(child);
          const rects = range.getClientRects();
          if (rects.length > 0) {
            return rects[0];
          }
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          // 跳过 icon 类元素
          const tagName = child.tagName.toLowerCase();
          if (tagName === 'svg' || tagName === 'img' || tagName === 'i' ||
              tagName === 'icon' || child.classList.contains('icon') ||
              isIconElement(child)) {
            continue;
          }
          // 递归搜索子元素
          const result = findFirstTextRect(child);
          if (result) return result;
        }
      }
      return null;
    }

    const textRect = findFirstTextRect(element);
    if (textRect) {
      return Math.max(0, rtl ? originRight - textRect.right : textRect.left - originLeft);
    }

    return 0;
  }

  // 检测父元素是否是水平布局（flex 或内联水平排列）
  function isHorizontalFlexParent(element) {
    const parent = element.parentElement;
    if (!parent) return false;

    const parentStyle = window.getComputedStyle(parent);
    const parentDisplay = parentStyle.display;
    const flexDirection = parentStyle.flexDirection;

    // 检查是否是水平 flex 布局（flex-direction: row 或 row-reverse）
    if ((parentDisplay === 'flex' || parentDisplay === 'inline-flex') &&
        (flexDirection === 'row' || flexDirection === 'row-reverse' || flexDirection === '')) {
      return true;
    }

    const inlineLayoutTags = new Set(['LI', 'A', 'SPAN', 'LABEL', 'BUTTON']);
    if (!inlineLayoutTags.has(element.tagName)) return false;

    const elementStyle = window.getComputedStyle(element);
    const elementDisplay = elementStyle.display;

    const floatValue = elementStyle.cssFloat || elementStyle.getPropertyValue('float');
    if (floatValue && floatValue !== 'none') {
      return true;
    }

    if (elementDisplay === 'inline' || elementDisplay === 'inline-block' || elementDisplay === 'inline-flex') {
      return true;
    }

    return false;
  }

  function normalizeComparableText(text) {
    if (!text) return '';
    return text
      .replace(/\{\{\d+\}\}/g, '')
      .replace(MARKUP_MARKER_RE, '')
      .replace(/\s+/g, '')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .trim()
      .toLowerCase();
  }


  // 内联格式标记的唯一定义，content-language.js 剥标记时复用
  ctx.MARKUP_MARKER_RE = MARKUP_MARKER_RE;
  ctx.TEXT_RUN_CLASS = TEXT_RUN_CLASS;
  ctx.collectTranslatableBlocks = collectTranslatableBlocks;
  ctx.isMathElement = isMathElement;
  ctx.isIconElement = isIconElement;
  ctx.isHorizontalFlexParent = isHorizontalFlexParent;
  ctx.getTextWithMathPlaceholders = getTextWithMathPlaceholders;
  ctx.readSourceText = readSourceText;
  ctx.getTextInset = getTextInset;
  ctx.normalizeComparableText = normalizeComparableText;
  // 收集一轮里有多少块因为受管容器承不住生成内容而被放弃。调用方要靠它区分
  // “页面已经翻完了”和“正文没能翻”，所以计数跟着收集走，读的人只读。
  ctx.getManagedSkipCount = () => managedSkipCount;
})();
