// 译文插进去了，可页面没给它地方站。
//
// content-clip-guard.js 管的是这件事的一半：祖先 `overflow:hidden`，译文落在可视
// 框外面被裁掉——用户什么都看不见。这里管另一半，也是更难看的一半：那个框同样不
// 让内容把自己撑高，但 `overflow` 是 `visible`，于是译文不会消失，它溢出来盖在别
// 的东西上。
//
// poloclub 的 Transformer Explainer 是一整页这样的框。它是坐标驱动的可视化：每个
// token 标签都住在一个由图形布局定死高度的格子里，
//
//   .cell            clientHeight 1.7px，里面装着 12px 的绝对定位标签
//   .textbook-tooltip clientHeight 5px，scrollHeight 11px
//   .type-btn        clientHeight 17px，加一行译文后 scrollHeight 41px
//
// 这些格子不会为多出来的一行长高，相邻格子只隔十来像素，译文于是直接压在下一行
// 原文上。
//
// ---------------------------------------------------------------------------
// 一、装不下的时候做什么：**先让原文，让不动才撤**
//
// 「这个框装不下原文和译文」不等于「这个框装不下译文」。它装得下其中一个——原文
// 本来就在里面待着。撤掉译文，用户在这一块什么都没得到；让出原文，用户读到的正是
// 他要的那一行。所以顺序是：先请原文让位（content-page-translation.js 的
// hideCrowdedSource），重新量一次，还是站不住才撤译文。
//
// 让原文只走「加一个类名」那条路（safeOnly）。「仅显示译文」模式还有一条把原文子
// 节点包进 wrap 的路，那条会搬页面自己的节点，框架重渲染时可能出问题——那个模式默
// 认关、由用户显式打开，风险是他选的；这里是默认行为，不能把同样的风险变成所有人
// 的默认。包不进去就撤译文，那条路一个页面节点都不动。
//
// ---------------------------------------------------------------------------
// 二、量谁：**量「原文 + 译文」这一对的并集**
//
// 只量译文自己的矩形会漏掉一整类：框不长高，但它把**原文**从另一头顶出去。
// transformer-explainer 顶部那个 .title 是 `display:flex; justify-content:end`、
// 高 80px 写死，内容贴着底边排——插一行译文，译文稳稳待在框底，被顶出框顶的是原文
// 「Multi-head Self Attention」，往上跑 28px 撞进上一行的「Transformer Block 1」。
// 译文相对宿主一点没溢出，只量译文永远量不到。这个框现在要装下的是两个人，就得按
// 两个人量。
//
// 译文插在原文**里面**（水平 flex / 表格单元格 / slot）时，原文的矩形已经含着译文，
// 并集就是原文自己——正好是该量的那个。
//
// ---------------------------------------------------------------------------
// 三、还有一种框：**原文块自己的盒子就装不下自己的字**
//
// 顶栏的 Temperature / Sampling / Probabilities 是三个 clientHeight 为 0 的 div，
// 字画在盒子外面。盒子没有高度，挨着它摆的任何东西都落在同一个 y 上——译文「温度」
// 直接盖在「Temperature」身上，糊成「温度perature」。这跟溢出宿主是两码事：宿主
// 好好的，是原文块自己在撒谎。判据 `scrollHeight > clientHeight`（在原文块上量，
// 译文不是它的子节点时才作数）——它自己的字都超出了自己的盒子，那么以这个盒子为
// 参照放译文必然重叠。
//
// ---------------------------------------------------------------------------
// 四、横向：**这一块比页面原本给它的地方宽了**
//
// 上面三条都是纵向的。剩下一类是横着的：右侧那一列
// 「11 more identical Transformer Blocks」的容器是 width 收缩包裹的，英文在 112px
// 里排成三行，中文一行排下来把整个容器撑到 147px，右边缘直接顶进隔壁「概率」那一
// 列。译文相对自己的宿主一点没溢出——宿主自己变宽了，所以前三条一条都够不着。
//
// **变宽本身不是问题**：正常流里的收缩包裹框（表格单元格、按钮、inline-block）变宽，
// 邻居会被推开，页面重新排一遍就好了。出了流的框（position:absolute/fixed）不会——
// 它是按坐标摆的，长出来的那一截推不开谁，只能盖上去。判据就是这两个条件的合取：
// 原文块比插译文之前宽了，且两层之内有出了流的祖先。
//
// 「插译文之前有多宽」量不出来，只能记：insertTranslationBlock 在插之前现场量一次
// 原文块的宽度，作为第二个参数传进来。不传就跳过这条（悬停/划词那条路不走这里）。
//
// 量的是**原文块自己**，不是「原文 + 译文」的并集——这一条跟第二节相反，那里的理由
// 在这里不成立。并集会把另一码事算进来：译文继承了原文的 `position:absolute`，刚被
// keepInFlow 按回 static，于是从一个 206px 的「跳到主要内容」摊成整行 1585px，并集
// 一下子宽了 1482px。可框一点没变宽，谁也没挤到，撤它纯属白撤（Anthropic 那篇的两
// 条跳转链接就是这么被误伤的）。收缩包裹的框被译文撑开时，里面的原文块会跟着变宽
// ——那才是「页面给的地方不够了」。
//
// 收场跟前三条不同：**直接撤，不先让原文**。前三条让原文有用，是因为框里挤的是两个
// 人；这里把框撑宽的正是译文自己，原文让开框还是那么宽。夹 max-width 让它折回列里
// 也试过，不行：这一块的 white-space 是 pre，字根本不换行，夹完盒子是窄了，字照样
// 画在外面——几何上「修好了」，看上去一模一样。
//
// ---------------------------------------------------------------------------
// 量法（下面所有数字都是这一套，换算法就不可比了）：只数**看得见**的矩形
// （checkVisibility，含 opacity/visibility），互相包含的不算，横竖都压过 6px 才算
// 一处；页面自己本来就有的重叠在插译文**之前**先量一遍，最后相减。译文按它自己那
// 个容器算一个矩形——不能拆成里面的 <a>/<span> 叶子，否则「保留内联标记」一开，
// 被数的矩形集合就变了，开关前后的数字对不上。另外两条修正，都是为了别把页面本来
// 的样子算成我们的账：
//   - 逐层与裁剪祖先的 padding box 求交，交空的不算——轮播里 20 张幻灯片全在 DOM
//     里、checkVisibility 全说可见，其实被 overflow:hidden 的轨道裁在框外。
//   - 相交区中心做命中测试，往上找第一个不透明背景：它同时罩着两者才算真糊了。
//     那张卡片是一块不透明浮层，它盖住下面的概率列表是页面自己的设计。
//
// 三个页面，同一套量法，同一轮跑出来的（off = 这个文件不存在时的行为；旧 = 只量译
// 文矩形、溢出就撤、不让原文；新 = 上面四条）。transformer-explainer 自己是动态的，
// 每次跑块数在 299–301 之间，「留下/让/撤」三列的绝对数跟着浮动几个，最右那列稳定：
//
//   页面                块数   策略   译文留下   让原文   撤掉   新增重叠
//   transformer-expl.    301   off      301        0        0       5
//                              旧       216        0       85       2
//                              新       225       17       76       0
//   Anthropic 长文       155   off      155        0        0       6
//                              旧       153        0        2       1
//                              新       155        3        0       1
//   维基百科(翻头 400)  ~3000  off      400        0        0      17
//                              旧       393        0        7       1
//                              新       393        1        7       1
//
// 新判据在三个页面上都不比旧的差，代价花在该花的地方：transformer 这种坐标画出来的
// 页面上新增重叠归零（旧判据剩 2 处），Anthropic 这种正常长文上一条译文都不用撤
// （旧判据撤 2 条）。维基百科两者打平——「让原文」只发生 1 次、撤 7 条，也就是说这
// 条默认行为不会在普通文章上乱动原文，这正是要守住的边界。
//
// 还有一个数字不在表里，但它是这次改动的由头：transformer 那张
// 「Transformer 是现代 AI 的核心架构」卡片，旧判据把整段正文的译文撤掉了、只剩标题
// （cardKept: false），新判据留下了。撤译文当成第一手段的代价就长这样——量出来是
// 「新增重叠 2」，看上去是一整张卡片没翻译。
//
// 这三页跑的都是同一个量法，但页面自己会变：维基百科这一轮的 baseline 是 561（上一
// 轮某次是 53，条目折叠状态不同），所以只有同一轮之间的数才可比，换一天重测要三种
// 策略一起重跑。
//
// ---------------------------------------------------------------------------
// 判据是纯几何的，不看类名也不看站点。溢出之后还要再问一句这算什么，答案在这个框
// 裁不裁剪：
//   - 会裁（hidden/clip/auto/scroll）→ 框外那截根本不画出来，压不到谁。那是
//     clip-guard 管的「看不见」或者滚动条管的事，不是这里管的「盖住」，在那儿撤译文
//     只会把它们已经处理好的情况弄砸。既然这一层就裁住了，再往上也溢不出去，所以直
//     接收工。
//   - 不裁（visible）→ 框外那截照样画出来，正压在别人身上。让原文，让不动就撤。
// 反过来，**装得下译文的裁剪框在这里没有任何特权**：它裁不掉任何东西，谁也没保护，
// 只是自己变大了去挤别人。transformer-explainer 的 span.label.float 就是这样一个
// 框——39px 高、绝对定位、稳稳装下译文，然后整个盖在隔壁的 2px 格子上。所以顺序是
// 先量溢出、再看 overflow，不能一见 hidden 就放行。
//
// 还有一条：祖先是 display:inline 时它压根没有自己的高度盒（clientHeight 恒为
// 0），量它只会得到假的溢出，跳过。
//
// **只看紧挨着的两层**（MAX_DEPTH）。约束一行字的框总是贴着它的——格子、单元格、
// 按钮；再往上是页面骨架，那些框的高度不是冲着这行字来的，它们自己的内容本来就可能
// 溢出（维基百科的 .mw-collapsible 侧栏、footer、tbody 都是），拿几何判据去量只会把
// 页面自己的老溢出算到译文头上。实测这一个常数就是全部代价所在，同一套代码（这张表
// 是另一轮跑的，维基百科当时的条目折叠状态跟上表不同——只跟它自己这四行比）：
//
//   MAX_DEPTH  transformer 新增重叠   维基百科撤掉的译文
//     1              24                   5 / 1383
//     2               3                  10 / 1383
//     3               2                  33 / 1383
//     5               3                 148 / 1383
//
// 顺带修掉一个同源的老问题：insertTranslationBlock 会把原文块的 class 复制到译文
// 块上（为了继承页面 CSS，比如 arXiv 的 ltx_p），而 class 上挂着的可能正是页面自
// 己的 `position:absolute` 和坐标。那边靠一条正则去掉 Tailwind 里字面叫
// `absolute`/`inset-*` 的类名，但站点自己写的类名（Svelte 的 .guide-text）它认不
// 出来，译文于是继承了原文的绝对坐标，一字不差地压在原文上。类名匹配是猜，这里改
// 成看计算样式：真的出了流，就按回 static。
(function() {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT;
  if (!ctx) return;

  // 只看紧挨着的两层——为什么是 2，见文件头的表。
  const MAX_DEPTH = 2;
  // 布局取整会差个零点几像素，别为此撤译文
  const SLACK = 2;

  // 译文继承了页面的绝对定位 → 按回正常流。改的是译文自己的内联样式，
  // 页面的规则一个都没动。
  function keepInFlow(el) {
    const position = window.getComputedStyle(el).position;
    if (position === 'absolute' || position === 'fixed' || position === 'sticky') {
      el.style.setProperty('position', 'static', 'important');
    }
  }

  // 这条译文配对的原文块。译文要么是它的下一个兄弟（常规段落），要么插在它
  // 里面（水平 flex / 表格单元格 / slot）。
  function pairedSource(translationEl) {
    const prev = translationEl.previousElementSibling;
    if (prev && prev.classList && prev.classList.contains('ai-translator-translated')) return prev;
    const parent = translationEl.parentElement;
    return parent ? parent.closest('.ai-translator-translated') : null;
  }

  // 「原文 + 译文」这一对占的范围——为什么不能只量译文，见文件头第二节。
  function unionRect(translationEl) {
    const rect = translationEl.getBoundingClientRect();
    const source = pairedSource(translationEl);
    if (!source) return rect;
    const sourceRect = source.getBoundingClientRect();
    // 原文已经让出去了（display:none），这一对现在只剩译文
    if (sourceRect.width === 0 && sourceRect.height === 0) return rect;
    // 译文插在原文里面：原文的矩形已经含着译文
    if (source.contains(translationEl)) return sourceRect;
    return {
      top: Math.min(rect.top, sourceRect.top),
      bottom: Math.max(rect.bottom, sourceRect.bottom),
    };
  }

  // 祖先里有没有出了流的框。出了流 = 按坐标摆的：它长宽了推不开谁，只能盖上去。
  // 正常流里的收缩包裹框（表格单元格、按钮、inline-block）变宽是无害的，邻居会让开。
  function hasOutOfFlowAncestor(el) {
    let n = el.parentElement;
    for (let depth = 0; depth < MAX_DEPTH && n && n !== document.body && n !== document.documentElement; depth++) {
      const position = window.getComputedStyle(n).position;
      if (position === 'absolute' || position === 'fixed') return true;
      n = n.parentElement;
    }
    return false;
  }

  // rect 有没有跑到 host 的 padding box 外面。
  // 用 clientTop/clientHeight 而不是 rect.height：溢出发生在 padding box 上，
  // 而 getBoundingClientRect() 含边框。与 clip-guard 的 clipsAway 同一套量法。
  function spillsOut(host, rect) {
    const box = host.getBoundingClientRect();
    const top = box.top + host.clientTop;
    const bottom = top + host.clientHeight;
    return rect.bottom > bottom + SLACK || rect.top < top - SLACK;
  }

  // 撤掉这条译文。撤之前一定要把原文放回去——不管是刚才为这条译文让的，还是
  // 「仅显示译文」模式藏的。译文没了还藏着原文，那一块两种语言都没有，比重叠糟得多。
  function dropTranslation(translationEl) {
    if (ctx.releaseSourceForTranslation) ctx.releaseSourceForTranslation(translationEl);
    translationEl.remove();
    if (ctx.releaseTranslationClipGuards) ctx.releaseTranslationClipGuards();
    return false;
  }

  // 站不住的收场：先请原文让位，重新量一次还站不住才撤。
  function yieldOrDrop(translationEl, stillSpills) {
    if (ctx.hideCrowdedSource && ctx.hideCrowdedSource(translationEl) && !stillSpills()) return true;
    return dropTranslation(translationEl);
  }

  /**
   * 确认页面确实给了这条译文站的地方；站不住就先让原文，让不动才把译文撤掉。
   * 必须在 keepTranslationVisible() 之后调用——clip guard 可能刚把某个祖先的
   * max-height 放开，那之后框才是它最终的样子。
   *
   * @param {Element} translationEl 刚插进 DOM 的译文节点
   * @param {number} [sourceWidthBefore] 插译文之前原文块的宽度，插入方现场量的
   *   （见文件头第四节）。不传就跳过横向那条判据。
   * @returns {boolean} 译文是否留下了
   */
  ctx.keepTranslationInFlow = function(translationEl, sourceWidthBefore) {
    if (!translationEl || translationEl.nodeType !== Node.ELEMENT_NODE || !translationEl.isConnected) {
      return false;
    }

    keepInFlow(translationEl);

    const rect = translationEl.getBoundingClientRect();
    // 没有尺寸的译文量不出溢出（还没排版，或者本来就是空的），留着。
    if (rect.width === 0 && rect.height === 0) return true;

    // 原文块自己的盒子就装不下自己的字（见文件头第三节）。这跟溢出宿主无关，
    // 是原文块的几何在撒谎，以它为参照摆任何东西都会落在那些字上面。
    // 译文是它的子节点时 scrollHeight 把译文也算进去了，那一路量不出这件事，跳过。
    const source = pairedSource(translationEl);
    if (source && !source.contains(translationEl) && source.textContent.trim() &&
        source.scrollHeight > source.clientHeight + SLACK) {
      // 这里没有「让了还是不行」的可能：压的就是原文那几个字，原文让开就没了。
      return yieldOrDrop(translationEl, () => false);
    }

    // 横向：这一块比页面原本给它的地方**宽**了（见文件头第四节）。
    // 量的是原文块自己的宽度，不是这一对的并集：收缩包裹的框被译文撑开，里面的
    // 原文块跟着变宽，这就是「页面给的地方不够了」的信号。并集会把另一码事算进来
    // ——译文继承了原文的 absolute，刚被 keepInFlow 按回 static，于是从一个 206px
    // 的跳转链接摊成整行 1585px。框一点没变宽，谁也没挤到。
    if (sourceWidthBefore > 0 && source && hasOutOfFlowAncestor(translationEl) &&
        source.getBoundingClientRect().width > sourceWidthBefore + SLACK) {
      // 这里没有「先让原文」那一步：把框撑宽的正是译文，原文让开框还是那么宽。
      return dropTranslation(translationEl);
    }

    let host = translationEl.parentElement;
    for (let depth = 0; depth < MAX_DEPTH && host && host !== document.body && host !== document.documentElement; depth++) {
      // 内联盒没有自己的高度（clientHeight 恒为 0），量它得到的溢出是假的
      if (host.clientHeight > 0 && spillsOut(host, unionRect(translationEl))) {
        // 溢出了。这一下究竟是「看不见」还是「盖住别人」，取决于这个框裁不裁剪：
        //   - 会裁（hidden/clip/auto/scroll）→ 框外那截根本不显示，压不到谁。
        //     滚动条或者 clip-guard 会处理，撤译文只会把它们处理好的情况弄砸。
        //     而且既然这一层就裁住了，再往上也溢不出去，所以是 return。
        //   - 不裁（visible）→ 框外那截照样画出来，正压在别人身上。
        if (window.getComputedStyle(host).overflowY !== 'visible') return true;
        const constrainingHost = host;
        return yieldOrDrop(translationEl,
          () => spillsOut(constrainingHost, unionRect(translationEl)));
      }
      // 装得下 → 这一层不是约束，接着往上。注意会裁剪的框在这里没有特权：一个装得
      // 下译文的 overflow:hidden 框裁不掉任何东西，它谁也没保护，只是自己去挤别人
      // （transformer-explainer 的 span.label.float 就是——39px 高、绝对定位，稳稳
      // 装下译文，然后整个盖在隔壁的 2px 格子上）。
      host = host.parentElement;
    }

    return true;
  };
})();
