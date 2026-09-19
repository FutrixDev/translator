// Blab Translation — 整页翻译：落笔
//
// 把一段译文变成页面上的一个块：按标记重建内联元素和公式，选插入位置，
// 处理表格/flex/网格这些容不下第二行的排版。
// 收集端的编码规则见 content/page/collect.js，两边共用 <a1>…</a1> 这套标记。
(function() {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT;
  if (!ctx) return;


  // 由本块**真正生成过**的标签名与编号拼出的正则，用来清掉解析后仍留在译文里的
  // 标记残骸（模型把 <a1>/<strong2> 串成了 <strong1> 这种，配不上任何一对，
  // 重建时只能原样跳过）。
  // 只认自己用过的标签名和编号，是为了不动页面正文：讲 HTML 的页面正文里就写着
  // <b2> 这类字样，我们没生成过 b 标记时它一个字都不该被删。
  function markupDebrisRe(markupElements) {
    if (!markupElements || markupElements.length === 0) return null;
    const tags = [...new Set(markupElements.map((mk) => mk.tag))].join('|');
    const nums = [...new Set(markupElements.map((mk) => String(mk.index)))].join('|');
    return new RegExp(`<\\s*/?\\s*(?:${tags})\\s*(?:${nums})\\s*>`, 'gi');
  }

  function getInlineTranslationTarget(element) {
    if (!element || element.tagName !== 'LI') return element;

    const children = Array.from(element.children).filter((child) => {
      if (ctx.isMathElement(child) || ctx.isIconElement(child)) return false;
      return true;
    });

    if (children.length !== 1) return element;

    const child = children[0];
    const inlineTranslationTags = new Set(['A', 'SPAN', 'LABEL', 'BUTTON']);
    if (!inlineTranslationTags.has(child.tagName)) return element;

    const text = child.textContent ? child.textContent.trim() : '';
    if (text.length < 2) return element;

    return child;
  }

  // 把一段可能含 {{n}} 数学占位符的文本追加进容器。
  // 建立 占位符编号 -> 数学条目 的映射，按“译文中实际出现的顺序”还原。
  // 不能依赖 mathElements 的原始下标顺序：翻译（尤其中英语序差异）经常调换公式
  // 前后位置，例如 “each m KV entries in C^a and C^b” → “C^a 和 C^b 中的每 m 个……”，
  // 会把 {{3}} {{4}} 排到 {{2}} 之前。旧实现按原始顺序逐个 indexOf 并截断剩余文本，
  // 一旦顺序被调换，靠前编号的占位符就会把靠后编号的占位符连同其间文本一起吞掉，
  // 导致后者以字面 {{n}} 残留、且对应公式被丢弃（arxiv 页 C^a/C^b 显示为 {{3}}{{4}}）。
  function appendTextWithMath(container, text, mathByNumber) {
    if (!text) return;

    const placeholderRe = /\{\{(\d+)\}\}/g;
    let lastIndex = 0;
    let match;
    while ((match = placeholderRe.exec(text)) !== null) {
      const math = mathByNumber.get(match[1]);
      // 未知编号（模型幻觉出的占位符）：保留为普通文本，随后随 textBefore 一并插入
      if (!math) continue;

      // 添加占位符前的文本
      const textBefore = text.slice(lastIndex, match.index);
      if (textBefore) {
        container.appendChild(document.createTextNode(textBefore));
      }

      // 还原原始数学元素或 LaTeX 文本（每次出现都独立 clone，兼容重复占位符）
      if (math.type === 'text') {
        container.appendChild(document.createTextNode(math.text));
      } else if (math.element) {
        container.appendChild(math.element.cloneNode(true));
      }

      lastIndex = placeholderRe.lastIndex;
    }

    // 添加最后剩余的文本
    const tail = text.slice(lastIndex);
    if (tail) {
      container.appendChild(document.createTextNode(tail));
    }
  }

  // 用 DOM 操作构建译文内容：还原数学公式占位符 {{n}}，并按内联格式标记
  // <a1>…</a1> 克隆原元素重建超链接/内联样式。
  // 不使用 innerHTML：数学元素直接 cloneNode，标记元素浅 clone 后以 DOM API
  // 组装，译文文本一律走 createTextNode，模型输出里的任何 HTML 都不会被解析。
  function buildTranslationContent(container, translatedText, block, prefix = '') {
    const mathElements = (block && block.mathElements) || [];
    const markupElements = (block && block.markupElements) || [];

    // 清理 LLM 可能添加的换行
    let text = translatedText.replace(/\s*\n\s*/g, ' ');

    // 添加前缀（如空格）
    if (prefix) {
      text = prefix + text;
    }

    const mathByNumber = new Map();
    for (const math of mathElements) {
      const m = /^\{\{(\d+)\}\}$/.exec(math.placeholder);
      if (m) mathByNumber.set(m[1], math);
    }

    if (markupElements.length === 0) {
      appendTextWithMath(container, text, mathByNumber);
      return;
    }

    const markupByNumber = new Map();
    for (const mk of markupElements) {
      markupByNumber.set(String(mk.index), mk);
    }

    // 栈式重建：开标记 → 浅 clone 原元素（保留 href/class/style，去掉 id 和
    // on* 属性）并下钻；闭标记 → 弹回。对模型输出保持防御：编号或标签名对不上
    // 的标记当普通文本原样保留；错序的闭标记只弹到对应层；缺失的闭标记到结尾
    // 自动闭合。最坏情况（标记全被模型丢掉）退化为纯文本译文，即今天的行为。
    //
    // 大小写不敏感 + 容空白，是内置 NMT 逼出来的：实测 en→zh-Hans 会把开标记
    // 大写成 `<A1>`（闭标记仍是 `</a1>`）。按小写严格匹配的话，这条链接不但重
    // 建不出来，`<A1>` 四个字符还会原样显示给读者。见 MARKUP_MARKER_RE 处。
    const markerRe = /<\s*(\/?)\s*([a-z]+)\s*(\d+)\s*>/gi;
    // 解析完仍留在正文里的标记残骸（配不上任何一对，上面 continue 掉的那些）不
    // 能直接给读者看，落笔前清掉。只认本块生成过的标签名和编号，见 markupDebrisRe。
    const debrisRe = markupDebrisRe(markupElements);
    const emit = (node, chunk) => {
      appendTextWithMath(node, debrisRe ? chunk.replace(debrisRe, '') : chunk, mathByNumber);
    };
    const stack = [{ node: container, index: null }];
    let lastIndex = 0;
    let match;
    while ((match = markerRe.exec(text)) !== null) {
      const closing = match[1] === '/';
      const entry = markupByNumber.get(match[3]);
      if (!entry || entry.tag !== match[2].toLowerCase()) continue;

      emit(stack[stack.length - 1].node, text.slice(lastIndex, match.index));
      lastIndex = markerRe.lastIndex;

      if (!closing) {
        const el = entry.element.cloneNode(false);
        el.removeAttribute('id');
        for (const attr of Array.from(el.attributes)) {
          if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
        }
        stack[stack.length - 1].node.appendChild(el);
        stack.push({ node: el, index: entry.index });
      } else {
        // findLastIndex：模型把同一编号的开标记重复输出时，闭标记只弹最内层
        const pos = stack.findLastIndex((frame) => frame.index === entry.index);
        if (pos > 0) stack.length = pos;
      }
    }
    emit(stack[stack.length - 1].node, text.slice(lastIndex));
  }

  // 向后兼容的旧签名（悬停/划词翻译仍按 mathElements 数组调用）
  function buildTranslationContentWithMath(container, translatedText, mathElements, prefix = '') {
    buildTranslationContent(container, translatedText, { mathElements }, prefix);
  }

  // 译文插进 DOM 不等于看得见：折叠容器（overflow:hidden + max-height）会把它整条
  // 裁掉。见 content-clip-guard.js。
  function keepTranslationVisible(anchor) {
    if (ctx.keepTranslationVisible) ctx.keepTranslationVisible(anchor);
  }

  // 译文放进 DOM 之后要做的三件事，顺序是有讲究的：
  //   1. 把裁剪它的祖先放开（clip guard）——框可能因此长高，第 2 步要量的是放开
  //      之后的样子；
  //   2. 确认页面真给了它地方站（fit guard，见 content-fit-guard.js）。站不住就
  //      撤掉译文，返回 false；
  //   3. 这时候才轮到“仅显示译文”去藏原文。顺序反了会出现最糟的结果——原文被藏
  //      起来，译文又被撤走，那一块彻底空白。
  //
  // 下面每一处把译文放进 DOM 的分支后面都要跟一次，clip-guard.test.mjs 会数：
  // 插入点比检查点多，就是漏了一处。
  // @param {Element} element 原文块。译文节点自己不认识它 —— 兄弟、块内、slot 内、
  //   flex 内联四种形态里，从译文往回找原文各有各的走法，所以由插入方传进来。
  // @param {number} sourceWidthBefore 插译文之前原文块的宽度。fit guard 的横向判据
  //   要「页面原本给这一块多少地方」，插完就量不到了，只能在插之前记下来传进去。
  function finishTranslationInsert(element, translationEl, sourceWidthBefore, lang) {
    registerTranslation(element, translationEl, false, lang);
    keepTranslationVisible(translationEl);
    // 「仅显示译文」开着时先藏原文再交给 fit guard：框里只剩译文一个人，量出来的
    // 才是它真实的处境。反过来先量就会按「原文 + 译文」的高度白撤一批译文。
    if (ctx.isTranslationOnlyActive()) ctx.hideSourceForTranslation(translationEl);
    if (ctx.keepTranslationInFlow &&
        !ctx.keepTranslationInFlow(translationEl, sourceWidthBefore)) return false;
    return true;
  }

  // ---- 译文往哪儿插 --------------------------------------------------------
  // 默认插在原文块【后面】当兄弟。三类块不能这么插，共同点是：原文块不只是一段
  // 文字，它还是页面结构、或页面画的那个框的一部分，而兄弟节点分不到那份东西。
  //
  //   - 表格单元格：兄弟 <td> 会给整行多加一列，撑破网格。
  //   - 列表项：兄弟 <li> 是一条幽灵条目——列表长度、li:nth-child、屏读的
  //     「第几项，共几项」全都多算一条。而要压掉它多出来的那个圆点只能上
  //     display:block，那又把译文从条目自己的缩进里拽出去：issue #71 里译文跑到
  //     整个列表的左外侧，既没有圆点也不跟原条目对齐。
  //   - 自己画了框的块（有背景色或背景图，如 alignment.anthropic.com 的
  //     .code-box）：兄弟落在框外面。抄一份页面类名也救不回来——
  //     .ai-translator-inline-block 的 reset 会把 background/border/padding 全抹掉，
  //     结果就是灰框外面挂着一段裸译文，正是 issue #71 的「翻译的内容不在框内」。
  //
  // 插到内部这三件事就都自然成立：页面结构没变，缩进和框都是继承来的。
  const INSIDE_ONLY_TAGS = new Set(['TD', 'TH', 'LI']);
  // 内容模型只收内联内容的元素：往里插 <div> 是非法嵌套，改用 <span>，块级排版由
  // .ai-translator-inline-block 自带的 display:block 提供。
  const PHRASING_CONTENT_TAGS = new Set(
    ['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'DT', 'LABEL', 'A', 'SPAN', 'BUTTON']);
  // 只有普通块级流才往里插。flex/grid 容器里多一个子节点就是多一个 flex item，
  // 横排时会挤在原文右边——那种块宁可让译文留在外面。
  const IN_FLOW_DISPLAYS = new Set(['block', 'flow-root', 'list-item', 'table-cell']);

  // 元素自己画了一个看得见的框？只认背景（背景色/背景图）：这是「读者眼里这是一个
  // 框」的强信号。单边框线不算——维基百科那种 border-bottom 的标题只是根分隔线，
  // 把译文塞进标题里反而会让分隔线跑到译文下面。
  function paintsOwnBox(computedStyle) {
    const image = computedStyle.backgroundImage;
    if (image && image !== 'none') return true;
    const color = computedStyle.backgroundColor;
    if (!color || color === 'transparent') return false;
    const parsed = color.match(/rgba?\(([^)]+)\)/);
    if (!parsed) return true; // 认不出的颜色语法（color(display-p3 …) 等）：作者设过就算
    const parts = parsed[1].split(',').map((part) => parseFloat(part));
    const alpha = parts.length > 3 ? parts[3] : 1;
    return alpha > 0.02;
  }

  // @returns {{inside: boolean, tag: string}} inside=true 时 tag 是要新建的标签名
  function getTranslationPlacement(element, computedStyle) {
    const style = computedStyle || window.getComputedStyle(element);
    const inside = INSIDE_ONLY_TAGS.has(element.tagName)
      || (paintsOwnBox(style) && IN_FLOW_DISPLAYS.has(style.display));
    return {
      inside,
      tag: PHRASING_CONTENT_TAGS.has(element.tagName) ? 'span' : 'div'
    };
  }

  // ---- 译文的身份与撤除 ----------------------------------------------------
  // 「这个元素翻过了」以前只靠 `.ai-translator-translated` 记，那是**节点身份**；
  // 虚拟列表回收节点之后它就在说谎。真正的判据是内容指纹，见 shared/block-identity.js。
  // 那个模块只回答「是不是同一段内容」，摘节点的事留在这里：插入有五种形态，
  // 只有这个文件知道自己插的是哪一种。

  // lang：这段译文**是译成哪门语言的**，由发起这一轮的人一路带进来。
  //
  // 不在这里现问设置。译文是一次请求的结果，而那次请求是更早的时候按**当时的**
  // 目标语言发出去的，这中间用户完全可能改过。现问就会把旧语言的译文盖上新语言
  // 的戳，下一轮收集端一看「语言没变」直接跳过 —— 那一块永远停在旧语言上，页面
  // 上还看不出任何异样。一轮翻译只认一门语言，那一门在 page/batch.js 的
  // runTranslationPass 开跑时就定死了。
  //
  // 没人说就登记成 null：BlockIdentity 把 null 读作「没说」，陈旧判定于是不问语言
  // 这一维 —— 正是「不知道」该有的样子（见 shared/block-identity.js 的 register）。
  function registerTranslation(element, translationEl, managed, lang) {
    globalThis.BlockIdentity.register(element, {
      // 指纹在这里算而不是让收集端算好带过来：算法只有一个入口，收集端和落笔端
      // 就不可能各归一化一套。译文节点这时已经在 DOM 里了，readSourceText 认得出
      // 它是我们自己的，不会把它算进原文。
      fingerprint: globalThis.BlockIdentity.fingerprint(ctx.readSourceText(element)),
      translationEl: translationEl || null,
      managed: !!managed,
      lang
    });
  }

  // 节点被回收去装别的内容了：把上一条译文整条摘掉，让这一块重新变回「没翻过」。
  // 摘的东西比一个 remove() 多：
  //   · 为它让出位置而藏起来的原文要放回去，否则新内容连原文都不显示（撤译文
  //     那条路——content-fit-guard.js 的 yieldOrDrop——也是这么成对做的）；
  //   · `.ai-translator-translated` 必须摘，它是发现层 closest() 串里的一员，
  //     留着的话放开的块下一轮照样被跳过，等于没放开。
  // @returns {boolean} 这个元素上本来有没有译文
  function releaseTranslation(element) {
    const entry = globalThis.BlockIdentity.lookup(element);
    if (!entry) return false;
    globalThis.BlockIdentity.forget(element);
    if (entry.translationEl) {
      if (entry.managed) {
        // 两条都按仓库里既有的写法留守卫（content-fit-guard.js:265、
        // content-hover-translation.js:89）：这两个模块在 manifest 里排在前面，
        // 真实页面上一定在，而只装整页翻译那几个模块的 DOM 夹具里不一定。
        if (ctx.releaseManagedTranslation) ctx.releaseManagedTranslation(entry.translationEl);
      } else {
        if (ctx.releaseSourceForTranslation) ctx.releaseSourceForTranslation(entry.translationEl);
        entry.translationEl.remove();
      }
    }
    element.classList.remove('ai-translator-translated');
    return true;
  }

  // 插入翻译块
  // lang：见 registerTranslation —— 这一轮译成的是哪门语言，由调用方带进来；
  // 不带就是「没说」，这一块的身份里不记语言。
  function insertTranslationBlock(block, translation, { lang = null } = {}) {
    const element = block.element;
    if (!element || !element.parentNode) return;

    // 检查是否已经翻译过，防止重复
    if (element.classList.contains('ai-translator-translated')) return;
    if (element.classList.contains('ai-translator-inline-source')) return;

    // 标记为已翻译
    element.classList.add('ai-translator-translated');

    const hasMathElements = block.mathElements && block.mathElements.length > 0;
    const hasMarkupElements = block.markupElements && block.markupElements.length > 0;
    const hasRichContent = hasMathElements || hasMarkupElements;

    // 受管容器（只读的 Lexical / ProseMirror 等）会删掉插进子树的译文节点，这里
    // 把译文画成原文块自己的 ::after —— 生成内容不是节点，编辑器看不见它，而且它
    // 占真实排版空间，后面的段落被顶下去而不是被盖住。见 content-managed-translation.js。
    // 收集阶段已经用同一条判据筛过一遍，画不出来的块根本不会走到这里。
    if (ctx.isInsideManagedDomRoot && ctx.isInsideManagedDomRoot(element) &&
        ctx.canRenderManagedTranslation &&
        ctx.canRenderManagedTranslation(element, { hasMath: hasMathElements })) {
      // ::after 的 content 只能是纯文本，内联格式标记在这里还原不了，剥掉了事。
      // 用 markupDebrisRe 而不是笼统的 MARKUP_MARKER_RE：只剥本块真生成过的标签
      // 名+编号，正文本来就含 <b2> 这类字样的页面（HTML 教程等）不会被误删。
      const managedDebrisRe = markupDebrisRe(block.markupElements);
      const handle = ctx.renderManagedTranslation(
        element,
        managedDebrisRe ? translation.replace(managedDebrisRe, '') : translation,
        {}
      );
      // 这条没有可插的节点，所以也走不到 finishTranslationInsert，身份得自己登记。
      registerTranslation(element, handle, true, lang);
      // ::after 把原文块撑高，撑出去的那部分同样可能被折叠祖先裁掉，量原文块
      keepTranslationVisible(element);
      return;
    }

    // 页面原本给这一块多少横向空间。插完就问不到了（收缩包裹的框会被译文自己撑宽），
    // fit guard 的横向判据要的就是这个数，所以在动 DOM 之前量。
    const sourceWidthBefore = element.getBoundingClientRect().width;

    // 检测是否在水平布局中
    const isHorizontalFlex = ctx.isHorizontalFlexParent(element);
    const inlineTarget = isHorizontalFlex ? getInlineTranslationTarget(element) : element;

    // 复制所有关键样式，包括颜色
    const computedStyle = window.getComputedStyle(inlineTarget);
    const baseStyle = `
      font-size: ${computedStyle.fontSize};
      font-family: ${computedStyle.fontFamily};
      font-weight: ${computedStyle.fontWeight};
      line-height: ${computedStyle.lineHeight};
      text-align: ${computedStyle.textAlign};
      color: ${computedStyle.color};
      letter-spacing: ${computedStyle.letterSpacing};
      opacity: 0.85;
    `;

    if (isHorizontalFlex) {
      // 对于水平 flex 布局（如顶部导航），将翻译插入到元素内部
      // 翻译显示在原文右侧（inline），保持菜单栏高度不变
      const translationEl = document.createElement('span');
      translationEl.className = 'ai-translator-inline-block ai-translator-inline-right';

      if (hasRichContent) {
        // 使用 DOM 操作构建内容，不用 innerHTML
        buildTranslationContent(translationEl, translation, block, ' ');
      } else {
        translationEl.textContent = ' ' + translation;
      }

      translationEl.style.cssText = `
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

      // 将翻译作为子元素追加到原元素内部（显示在原文右侧）
      inlineTarget.appendChild(translationEl);
      finishTranslationInsert(element, translationEl, sourceWidthBefore, lang);
    } else {
      // 对于非水平 flex 布局（如侧边栏），默认插入为同级元素；
      // 哪些块只能往内部插、插什么标签，见 getTranslationPlacement
      const placement = getTranslationPlacement(element, computedStyle);
      const translationEl = document.createElement(placement.inside ? placement.tag : element.tagName);

      // 复制原始元素的类名，保留页面的 CSS 样式（如 ltx_p 用于 MathML 内联显示）
      // 然后添加我们的标记类
      // 需要移除位置相关的类，避免破坏布局（如 absolute, fixed, inset-* 等）
      // 往内部插时不复制：单元格专属样式（列宽/对齐）会带歪译文块，而页面画的那个框
      // 会在框里再画一个一模一样的框——内部译文要的样式本来就是继承来的
      if (element.className && !placement.inside) {
        const positionClasses = /\b(absolute|fixed|sticky|relative|inset-\S*|top-\S*|bottom-\S*|left-\S*|right-\S*|z-\S*)\b/g;
        translationEl.className = element.className
          .replace('ai-translator-translated', '')
          .replace(positionClasses, '')
          .trim();
      }
      translationEl.classList.add('ai-translator-inline-block');

      if (hasRichContent) {
        // 使用 DOM 操作构建内容，不用 innerHTML
        buildTranslationContent(translationEl, translation, block);
      } else {
        translationEl.textContent = translation;
      }
      if (hasMathElements) {
        // 有数学公式时，尽量少设置内联样式，让页面 CSS 控制布局
        // 只设置 opacity 来区分译文
        translationEl.style.opacity = '0.85';
      } else {
        // 无数学公式时，设置完整样式（含只带内联标记的富文本块——克隆出来的
        // 链接/强调元素自带类名，页面 CSS 会在 baseStyle 之上继续生效）。
        // 注意：不要在这里设置水平 margin。有些页面通过在原元素上设置
        // `margin-left/right: auto` 让每个块居中（例如 Anthropic 文章的
        // `.prose > *`），一旦强制 `margin: 0` 就会把译文钉在容器左侧，而原文
        // 仍然居中，导致译文错位到左边。上下间距由 `.ai-translator-inline-block`
        // 类（带 !important）控制。
        translationEl.style.cssText = baseStyle + `
          padding: 0;
          box-sizing: border-box;
        `;
      }

      // 兄弟译文和原文之间的距离，从来不是 `.ai-translator-inline-block` 那条
      // 0.15em 说了算：相邻外边距会合并，合并值是 max(正) + min(负)，原文的
      // margin-bottom 站在同一道缝里，两边谁大谁赢。
      //   · 原文 margin-bottom 为负时（alignment.anthropic.com 的
      //     `.code-box p { margin: -12px 0 }` 拿来抵消 <br>），页面把两个块吸到
      //     一起，译文直接叠在原文上；
      //   · 原文 margin-bottom 为正时（claude.com 正文是 31.43px，段间 16px），
      //     页面把译文推开到离原文 31px、离下一段 16px 的地方——译文离下一段
      //     比离自己的原文还近，读起来像是下一段的译文。
      // 两种都是同一道算术题：想要间距 g，就令译文 margin-top = -原文 mb + g。
      // 合并时得 mb + (-mb + g) = g；flex/grid 里兄弟外边距不合并，直接相加也是
      // g。所以不必判断在不在合并语境里，一个式子两头都成立。
      // 再把原文的下外边距让给译文（负外边距除外，那是页面用来吸下一个块的，
      // 照抄会把下一段拽到译文身上），「原文 + 译文」这一对就正好占住原文原来
      // 的位置，页面自己的段落节奏不受影响。
      if (!placement.inside) {
        const sourceMarginBottom = parseFloat(computedStyle.marginBottom) || 0;
        const gap = (parseFloat(computedStyle.fontSize) || 16) * 0.15;
        // 补偿量交给 CSS 而不是直接写死 margin-top：原文被藏起来时（仅显示译文 /
        // fit guard 让位）这份补偿必须失效，那件事只有 CSS 看得见。
        translationEl.style.setProperty(
          '--ai-translator-pair-margin-top', `${Math.round(-sourceMarginBottom + gap)}px`);
        translationEl.style.setProperty(
          'margin-bottom', `${Math.round(Math.max(sourceMarginBottom, gap))}px`, 'important');
      }

      // 计算原文文本相对于元素的偏移量（跳过 icon 等前置元素）
      const textOffset = ctx.getTextOffsetLeft(element, { fromContentBox: placement.inside });

      // 使用 setProperty 设置 padding-left，加 !important 防止被页面 CSS 覆盖
      if (textOffset > 0) {
        translationEl.style.setProperty('padding-left', `${textOffset}px`, 'important');
      }

      // 检查元素是否有 slot 属性（Web Components 的内容分发机制）
      // 如果有 slot 属性，在元素旁边插入兄弟元素会破坏 Shadow DOM 的结构
      // 应该将翻译追加到元素内部
      const hasSlotAttr = element.hasAttribute('slot');
      if (hasSlotAttr) {
        // 对于有 slot 属性的元素，将翻译作为子元素追加到内部
        // 使用 span 而不是复制标签名，避免嵌套问题（如 a > a）
        const internalTranslation = document.createElement('span');
        internalTranslation.className = 'ai-translator-inline-block';
        if (hasRichContent) {
          buildTranslationContent(internalTranslation, translation, block);
        } else {
          internalTranslation.textContent = translation;
        }
        internalTranslation.style.cssText = baseStyle + `
          display: block;
          margin: 0;
          padding: 0;
          box-sizing: border-box;
        `;
        element.appendChild(internalTranslation);
        finishTranslationInsert(element, internalTranslation, sourceWidthBefore, lang);
      } else if (placement.inside) {
        // 译文作为块级子节点追加到原文块【内部】，显示在原内容下方。
        // 用 <div>/<span>（而非复制标签名）避免 td 内嵌 td、li 内嵌 li 这类非法结构。
        element.appendChild(translationEl);
        finishTranslationInsert(element, translationEl, sourceWidthBefore, lang);
      } else {
        // 插入到原元素后面
        element.after(translationEl);
        finishTranslationInsert(element, translationEl, sourceWidthBefore, lang);
      }
    }
  }


  ctx.buildTranslationContent = buildTranslationContent;
  ctx.buildTranslationContentWithMath = buildTranslationContentWithMath;
  ctx.getInlineTranslationTarget = getInlineTranslationTarget;
  ctx.getTranslationPlacement = getTranslationPlacement;
  ctx.insertTranslationBlock = insertTranslationBlock;
  ctx.releaseTranslation = releaseTranslation;
})();
