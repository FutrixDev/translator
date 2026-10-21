// Blab Translation — 整页翻译：收集
//
// 从 DOM 里挑出该翻的块，并把每块读成一段可以送翻的文本：数学公式换成占位符、
// 内联格式编码成 <a1>…</a1> 标记、直属文本节点各自成锚。
// 这里只读页面、不改页面（wrapDirectTextRuns 包 span、散文 <pre> 在空行处切开文本
// 节点，都是为了拿到锚点），
// 译文怎么放是 content/page/insert.js 的事。
(function() {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT;
  if (!ctx) return;

  const { constants } = ctx;
  const { MATH_CONTAINER_SELECTOR } = constants;
  // 我们自己的节点、内联格式标记的标签表、一段直属文字在哪断：都在 text-runs.js
  // （manifest 里排在这里前面），和锚点的切法、裹法写在一处。
  const SKIP_OURS = ctx.SKIP_OURS_SELECTOR;

  // 本轮收集里，受管容器内有多少块连生成内容都承不住而被放弃。翻译流程用它来
  // 区分“页面已经翻完了”和“正文没能翻”，两句提示的含义完全不同。
  let managedSkipCount = 0;

  // 组合树（content/page/shadow.js）：宿主元素的子节点包括它 shadow root 里的，
  // <slot> 按分配结果取。没有 shadow root 时原样返回 el.children / el.childNodes。
  const kids = (el) => ctx.composedChildren(el);
  const nodesOf = (el) => ctx.composedChildNodes(el);
  const closestAcross = (el, selector) => ctx.closestComposed(el, selector);

  /**
   * 块级「不翻」：适配器的 exclude 或「保留原文」命中这个元素或它的祖先（跨
   * shadow）。收块（processElement）和规则变化后的清扫（ctx.ruleForbids）共用这
   * 一个判法，哪天多一种「不翻」，两边一起变。
   *
   * @param {Element} el
   * @param {{exclude?: string, keepOriginal?: string}|null} adapter resolveSiteAdapter() 的结果
   */
  function ruleBlocksElement(el, adapter) {
    if (!adapter) return false;
    // 用户规则 exclude 命中整块：不收。用 closest 而不是 matches，因为排除的是
    // 整块，底下的子元素也在排除之列。
    if (adapter.exclude && closestAcross(el, adapter.exclude)) return true;
    // 「保留原文」（内置规则表 ∪ 用户规则）命中整块：不收。作者名、时间戳、票数、
    // "reply"，这些在形状上和正文没有区别，通用启发式挡不住；Hacker News 的
    // `.subtext` 底下还有一串 <a>，它们也一起跳过。
    return !!(adapter.keepOriginal && closestAcross(el, adapter.keepOriginal));
  }

  // options.scope：ctx.resolvePageScope() 的结果（content/page/scope.js）。不带时
  // 不做任何范围过滤——e2e 直接调这个函数的地方都是这样用的。
  // options.limit：收够这么多块就停（MutationObserver 回调里的同步装回，见 scope.js）。
  function collectTranslatableBlocks(root, options) {
    // 单块上限是分批器的口径（content/page/batch.js）：那边按它切块，
    // 这边按它决定一块算不算 oversized，两处必须是同一个数。
    const { MAX_BLOCK_CHARS } = ctx.PAGE_LIMITS;
    managedSkipCount = 0;
    const blocks = [];
    // 站点适配：内置规则表与用户站点规则并好的几串选择器（见
    // content/page/site-adapter.js）。整轮收集只解析一次——规则按 host + path +
    // 规则集版本选中，一轮里不会变。这一页没有规则时都是空串，下面所有用到它们的
    // 地方都短路掉，走的还是原来的通用启发式。
    const adapter = ctx.resolveSiteAdapter();
    const atomicSelector = (adapter && adapter.atomic) || '';
    const excludeSelector = (adapter && adapter.exclude) || '';
    const keepSelector = (adapter && adapter.keepOriginal) || '';
    // 块里的行内元素：exclude 的字拿掉，keepOriginal 的整个当占位符原样带回。
    const textOptions = { preserveMarkup: true, exclude: excludeSelector, keep: keepSelector };
    const blockTags = ['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'TD', 'TH', 'FIGCAPTION', 'BLOCKQUOTE', 'DT', 'DD'];
    // 内联可翻译元素 - 这些元素即使不是块级也应单独翻译
    const inlineTags = ['A', 'SPAN', 'LABEL', 'BUTTON'];
    // 容器元素 - 这些元素不应作为整体翻译，应递归处理子元素
    // 表格标签作为容器递归下探到单元格（TD/TH 在 blockTags 中）：很多站点（如 Hacker News）
    // 用表格做整页布局，若把 TABLE/TR 当作跳过的标签（prose-pre.js 的 SKIP_TAG_SELECTOR）会跳过全部正文，导致“0 个可译块 → 误报页面已翻译”。
    const containerTags = ['NAV', 'UL', 'OL', 'DIV', 'SECTION', 'ARTICLE', 'ASIDE', 'HEADER', 'FOOTER', 'MAIN', 'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR'];
    const scope = options && options.scope;
    const limit = options?.limit ?? Infinity;
    const scopeCut = scope && scope.skip ? (el) => ctx.pageScopeCut(el, scope) : null;
    const allowed = ctx.createTranslateJudge();

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

    // 把元素的【直属文本节点】连同夹在中间的行内元素按段裹进 <span>，给它们一个
    // 能收进 blocks、之后能挂译文的锚点——文本节点自己两样都做不到。
    // 一段从哪断（ctx.breaksInlineRun）：块级元素、容器标签、<br>、我们自己的节点。中间的
    // <i>/<a>/带样式的 <span> 不断：coqdoc 把正文写成 div.doc 的散字，段内斜体、
    // 链接都是直属子元素，碰到元素就断会把「In particular, the fundamental tools of
    // <i>inductive proof</i> are ubiquitous…」切成三块送翻，斜体自己还单成一块。
    // 裹好的那一段是个 SPAN，走内联分支，段内的元素照常编成内联标记。
    // 只裹真要翻的那几段（ctx.wrapProseRun，content/page/text-runs.js），页面 DOM
    // 就一个多余节点都不会多出来。
    function wrapDirectTextRuns(element) {
      const runs = ctx.splitRuns(nodesOf(element), (node) => (ctx.breaksInlineRun(node) ? 'break' : 'run'));
      for (const run of runs) ctx.wrapProseRun(run, element);
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

    // 获取元素的直接文本内容（不包括子元素的文本）。我们自己裹的 text-run 也算：
    // insert.js 的 textColumnOf 会把横排 flex 块的直属文本就地裹起来，译文撤掉后
    // 那个 span 还在；不认它，重翻时这块就不收了，改收那个 span，译文又挤回字旁边。
    function getDirectText(element) {
      let text = '';
      for (const child of nodesOf(element)) {
        if (child.nodeType === Node.TEXT_NODE ||
            (child.nodeType === Node.ELEMENT_NODE && child.classList.contains(ctx.TEXT_RUN_CLASS))) {
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
      if (blocks.length >= limit) return;

      const tagName = element.tagName;

      // 跳过不需要翻译的元素，连同它们的子树（散文 <pre> 除外，见 content/page/prose-pre.js）
      if (ctx.prosePre.skippedByTag(element)) return;
      if (element.isContentEditable) return;
      // 用户规则 exclude、「保留原文」（内置规则表 ∪ 用户规则）命中整块：不收（先
      // 判 exclude 再判保留原文，见 ruleBlocksElement）。排在作者声明（translate="yes"
      // 能在里面重新打开子树）之前，所以它连子树一起关掉。
      if (ruleBlocksElement(element, adapter)) return;
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
        const target = ctx.currentTargetLang();
        if (!identity.isStale(element, identity.fingerprint(readSourceText(element)), target)) return;
        ctx.releaseTranslation(element);
      }
      if (closestAcross(element, SKIP_OURS)) return;
      if (element.classList.contains('ai-translator-translated')) return;
      if (element.classList.contains('ai-translator-inline-source')) return;

      // 跳过代码块容器（codehilite / sourceCode / highlight 变体 / Prism language-*，
      // 统一在 isInsideCodeContainer（not-prose.js）里按完整 class token 匹配）
      if (ctx.isInsideCodeContainer(element)) return;

      // 跳过数学公式内部的所有元素 - 数学公式应该整体保留，不单独翻译内部元素
      if (closestAcross(element, MATH_CONTAINER_SELECTOR)) return;

      // 跳过数学公式的隐藏辅助元素（只跳过重复的隐藏版本）
      if (element.classList.contains('MJX_Assistive_MathML') ||
          element.classList.contains('katex-mathml') ||
          element.classList.contains('MathJax_Preview')) return;
      // 只写给读屏器的字（content/page/reader-hidden.js）：整棵不收。
      if (ctx.hiddenFromReaders(window.getComputedStyle(element))) return;

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

      // 走到这里的 <pre> 只会是散文 <pre>（prosePre.skippedByTag）：一段一块。
      if (tagName === 'PRE') {
        for (const paragraph of ctx.prosePre.paragraphs(element)) {
          const anchor = ctx.prosePre.anchorOf(paragraph, element);
          if (anchor) processElement(anchor);
        }
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
          // 本身就是锚点的元素不再往里裹：锚点里的字已经是一段了，再裹只会在
          // 锚点里套锚点（页面脚本往我们的锚点里塞进块级元素时就会走到这里）。
          if (!element.classList.contains(ctx.TEXT_RUN_CLASS)) wrapDirectTextRuns(element);
          for (const child of kids(element)) {
            processElement(child);
          }
          return;
        }
      }

      // 对于内联元素（如链接、按钮），如果有文本内容，单独翻译
      if (inlineTags.includes(tagName)) {
        const { text, mathElements, markupElements } = getTextWithMathPlaceholders(element, textOptions);
        // 长度阈值按剥掉占位符/内联标记后的正文算，标记本身不该把短链接顶出上限；
        // looksLikeCodeOrUrl 同样要先剥，否则 <a1></a1> 里的尖括号会把带链接
        // 的段落误判成代码。
        const plainText = globalThis.TextMarkers.strip(text).trim();
        // 纯数字、控件短标签（content/page/not-prose.js）：整块不收。要 return——
        // 落到下面的块级分支，<span>12</span> 会因为有直属文本照样被收进去。
        if (ctx.notProse(element, plainText)) return;
        if (text && plainText.length >= 2 && plainText.length <= 500) {
          // 跳过看起来像代码或主要是URL的文本
          // 这里要 trim：只含公式的元素排除占位符后会剩下空白（如 "{{1}} {{2}}"），
          // 不 trim 会被当成有正文，进而把纯公式送去翻译。
          const textWithoutMath = plainText;
          if (textWithoutMath && !ctx.looksLikeCodeOrUrl(textWithoutMath)) {
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
        let { text, mathElements, markupElements } = getTextWithMathPlaceholders(element, textOptions);
        if (text && text.length >= 2) {
          // 跳过看起来像代码或主要是URL的文本（排除数学占位符和内联标记后判断）
          const textWithoutMath = globalThis.TextMarkers.strip(text).trim();

          // 排除公式占位符后没有任何正文：整个块就是一条公式，跳过。
          // 典型是 arXiv/LaTeXML 的行间公式——公式包在 <table class="ltx_equation"> 里，
          // 遍历下探到 <td class="ltx_eqn_cell"> 时 text 只有 "{{1}}"。
          // 若不跳过，"{{1}}" 会被送去翻译，模型原样返回后再按占位符 clone 回原 <math>，
          // 结果是同一条公式在原文下方又渲染一遍（公式出现两遍）。
          // 这里 return 而不递归：块内只有公式，子元素会被 MATH_CONTAINER_SELECTOR 拦下，递归没有意义。
          if (!textWithoutMath) return;

          // 纯数字、控件短标签（content/page/not-prose.js）：整块不收。
          if (ctx.notProse(element, textWithoutMath)) return;
          if (textWithoutMath && ctx.looksLikeCodeOrUrl(textWithoutMath)) {
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
            const plain = getTextWithMathPlaceholders(element, { ...textOptions, preserveMarkup: false });
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

    const starts = scope ? ctx.pageScopeStarts(root, scope) : [root];
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
    if (ctx.MARKUP_TAGS.has(tagName)) return true;
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
  // options.exclude / options.keep：整页收块传进来的站点规则选择器（悬停、划词不带）。
  //   命中 exclude 的行内元素整个不读；命中 keep 的按 translate="no" 处理。
  function getTextWithMathPlaceholders(element, options) {
    const preserveMarkup = !!(options && options.preserveMarkup);
    const excludeSelector = (options && options.exclude) || '';
    const keepSelector = (options && options.keep) || '';
    let text = '';
    const mathElements = [];
    const markupElements = [];
    let mathIndex = 0;

    // 跳过的隐藏类名。ai-translator-failed 是失败标记（content/page/failed-blocks.js）：
    // 放在 li/td 里面时它是这一段的子节点，不跳就会把「翻译失败 · 重试」当原文送出去。
    // .sr-only 这类读屏文字不靠类名认，靠下面的 ctx.hiddenFromReaders。
    const hiddenClasses = [
      'MJX_Assistive_MathML', 'katex-mathml', 'MathJax_Preview', 'ai-translator-failed'
    ];

    // 只含空白的文本节点（用户名链接和时间之间的那一个）不直接写进 text：记下它在
    // 哪，等后面真有文字或占位符时补成一个空格。段首前面没有内容、段尾后面没有内容，
    // 两头都不会多出空格；空格前已是空白、或后面的文字自己以空白开头时也不补。
    // 补在记下的位置而不是紧挨着新内容，所以中间开出来的标记（<a2>）在空格后面。
    let hasContent = false;
    let pendingSpaceAt = -1;
    function emit(piece) {
      if (pendingSpaceAt >= 0) {
        const at = Math.min(pendingSpaceAt, text.length);
        if (!/^\s/.test(piece) && !/\s/.test(text.charAt(at - 1))) {
          text = `${text.slice(0, at)} ${text.slice(at)}`;
        }
        pendingSpaceAt = -1;
      }
      text += piece;
      hasContent = true;
    }

    function addMathPlaceholder(entry) {
      mathIndex += 1;
      const placeholder = globalThis.TextMarkers.placeholder(mathIndex);
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
      // 分进一个藏起来的 slot 里的节点没有渲染，读者看不见（见 ctx.inHiddenSlot）。
      // 下面逐节点的 display:none 判断查不到它：节点自己的 display 是正常的，藏
      // 起来的是 slot 在 shadow 树里的祖先。
      if (ctx.inHiddenSlot(node)) return;
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
            emit(content);
          } else if (content && hasContent && pendingSpaceAt < 0) {
            pendingSpaceAt = text.length;
          }
        }
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        // 跳过 script 和 style 标签
        if (node.tagName === 'SCRIPT' || node.tagName === 'STYLE') return;

        // 跳过隐藏的辅助元素
        const classList = node.classList;
        if (hiddenClasses.some(cls => classList?.contains(cls))) return;

        // 跳过 display:none，以及只给读屏器的字
        const style = window.getComputedStyle(node);
        if (style.display === 'none' || ctx.hiddenFromReaders(style)) return;

        // 跳过图标元素（图标是装饰，翻译不需要包含图标）
        if (isIconElement(node)) {
          return;
        }

        // 用户规则 exclude 命中的行内元素：不送去翻译，译文里也不出现。
        if (excludeSelector && node.matches(excludeSelector)) return;

        // 行内的 notranslate（产品名、人名），以及「保留原文」（内置规则表的时间戳、
        // 票数……与用户规则）命中的行内元素：整个元素当占位符，插入时原样克隆回去。
        // verbatim 标明它不是公式：译文照样套页面排版（见 hasRealMath）。
        if (ctx.ownTranslateDeclaration(node) === 'no' ||
            (keepSelector && node.matches(keepSelector))) {
          emit(addMathPlaceholder({ type: 'element', element: node, verbatim: true }));
          return;
        }

        // 检测是否是数学公式 - 使用锚点占位符
        // 使用 {{1}}、{{2}} 格式，LLM 熟悉模板语法，会保持原样
        if (isMathElement(node)) {
          emit(addMathPlaceholder({ type: 'element', element: node }));
          return;
        }

        // 内联格式元素：包上成对标记再递归。若递归后一个字都没添上（比如里面
        // 只有图标），把开标记回滚掉——空标记对既没意义又诱导模型幻觉。
        if (preserveMarkup && isMarkupElement(node)) {
          const index = markupElements.length + 1;
          const tag = node.tagName.toLowerCase();
          const open = globalThis.TextMarkers.openTag(tag, index);
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
            text += globalThis.TextMarkers.closeTag(tag, index);
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
          // 跳过 icon 类元素。<i> 不按标签名跳：它首先是斜体，coqdoc 的列表项以
          // <li> <i>Automated theorem provers</i> provide… 开头，跳过它量到的是斜体
          // 短语后面那个字，整块译文被推到右边一大截。字体图标的 <i> 要么带图标类名
          // （isIconElement），要么没有文字节点，下面的递归本来就量不到它。
          const tagName = child.tagName.toLowerCase();
          if (tagName === 'svg' || tagName === 'img' ||
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

  function normalizeComparableText(text) {
    if (!text) return '';
    return globalThis.TextMarkers.strip(text)
      .replace(/\s+/g, '')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .trim()
      .toLowerCase();
  }


  ctx.collectTranslatableBlocks = collectTranslatableBlocks;
  ctx.isMathElement = isMathElement;
  ctx.isIconElement = isIconElement;
  ctx.getTextWithMathPlaceholders = getTextWithMathPlaceholders;
  /**
   * 这一块里有没有真公式：占位符里有任一条不是 verbatim（translate="no" 与「保留
   * 原文」的原样元素）。插入层和悬停层只拿它决定译文的样式——有真公式时只写
   * opacity，让页面 CSS 管公式排版；只有原样元素时照常套原文的字体、字号、颜色。
   * 「有没有占位符」（选哪个内容构建器、managed 判定）仍然问 mathElements.length。
   *
   * @param {Array<{verbatim?: boolean}>|undefined} mathElements getTextWithMathPlaceholders 的结果
   */
  ctx.hasRealMath = (mathElements) => !!mathElements && mathElements.some((entry) => !entry.verbatim);
  ctx.readSourceText = readSourceText;
  ctx.getTextInset = getTextInset;
  ctx.normalizeComparableText = normalizeComparableText;
  // 收集一轮里有多少块因为受管容器承不住生成内容而被放弃。调用方要靠它区分
  // “页面已经翻完了”和“正文没能翻”，所以计数跟着收集走，读的人只读。
  ctx.getManagedSkipCount = () => managedSkipCount;

  /**
   * 站点规则现在禁不禁这一块：落在用户的 exclude，或「保留原文」（内置 ∪ 用户）
   * 里，或者在 include 范围之外。规则变化后的清扫（content/page/custom-rule.js）拿它筛已
   * 挂上的译文。
   */
  ctx.ruleForbids = function ruleForbids(el, scope) {
    if (ruleBlocksElement(el, ctx.resolveSiteAdapter())) return true;
    return ctx.outsidePageScope(el, scope);
  };
})();
