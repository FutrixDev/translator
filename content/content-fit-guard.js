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
// 量法（下面所有数字都是这一套，换算法就不可比了）：只数**看得见**的矩形
// （checkVisibility，含 opacity/visibility），互相包含的不算，横竖都压过 6px 才算
// 一处；页面自己本来就有的重叠在插译文**之前**先量一遍，最后相减。译文按它自己那
// 个容器算一个矩形——不能拆成里面的 <a>/<span> 叶子，否则「保留内联标记」一开，
// 被数的矩形集合就变了，开关前后的数字对不上。
//
// transformer-explainer 整页 301 块，同一套量法：
//
//   fit guard 关（今天线上的行为）  译文全留 300 条，新增重叠 17
//   fit guard 开                    留 221 条、撤 79 条，新增重叠 5
//
// 剩下那 5 处全在顶部控件栏，而且都是**横向**相撞：那些容器是 w-max，译文一挂上去
// 它就跟着变宽，相对宿主根本没溢出，被撞的是坐标定死的隔壁控件。这里的判据是相对
// 宿主的纵向溢出，够不着这一类——要接住得改成邻居碰撞检测，那是另一套机制和另一份
// 风险预算，没有塞进这次改动。
//
// 维基百科（Transformer 词条，翻头 400 块，页面自带 60 处重叠）同一套量法：
//
//   fit guard 关，标记开   译文全留 400 条，新增重叠 42
//   fit guard 开，标记开   留 395 条，新增重叠 31（超链接重建 383 条）
//   fit guard 开，标记关   留 395 条，新增重叠 32（超链接 0 条）
//
// 两处结论一致：**保留内联标记对重叠是中性的**（31 对 32、5 对 5，都在噪声里），
// fit guard 两边都在减（42→31、17→5）。维基剩下的 31 是往一篇本来就密的长文里塞
// 400 段字的固有代价，不是这两个改动引进来的。
//
// 判据是纯几何的，不看类名也不看站点：**译文的矩形跑到了紧挨着它的祖先的 padding
// box 外面**。框只要肯为它长高，译文就还在框里；跑出去了，就说明这个框的高度是外面
// 定死的，页面没打算给这行字留地方。站不住就把译文撤掉——原文一个字不动，比压上去
// 糊成一团强。
//
// 溢出之后还要再问一句这算什么，答案在这个框裁不裁剪：
//   - 会裁（hidden/clip/auto/scroll）→ 框外那截根本不画出来，压不到谁。那是
//     clip-guard 管的「看不见」或者滚动条管的事，不是这里管的「盖住」，在那儿撤译文
//     只会把它们已经处理好的情况弄砸。既然这一层就裁住了，再往上也溢不出去，所以直
//     接收工。
//   - 不裁（visible）→ 框外那截照样画出来，正压在别人身上。撤掉。
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
// 页面自己的老溢出算到译文头上。实测这一个常数就是全部代价所在，同一套代码：
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

  // rect 有没有跑到 host 的 padding box 外面。
  // 用 clientTop/clientHeight 而不是 rect.height：溢出发生在 padding box 上，
  // 而 getBoundingClientRect() 含边框。与 clip-guard 的 clipsAway 同一套量法。
  function spillsOut(host, rect) {
    const box = host.getBoundingClientRect();
    const top = box.top + host.clientTop;
    const bottom = top + host.clientHeight;
    return rect.bottom > bottom + SLACK || rect.top < top - SLACK;
  }

  /**
   * 确认页面确实给了这条译文站的地方；站不住就把它撤掉。
   * 必须在 keepTranslationVisible() 之后调用——clip guard 可能刚把某个祖先的
   * max-height 放开，那之后框才是它最终的样子。
   *
   * @param {Element} translationEl 刚插进 DOM 的译文节点
   * @returns {boolean} 译文是否留下了
   */
  ctx.keepTranslationInFlow = function(translationEl) {
    if (!translationEl || translationEl.nodeType !== Node.ELEMENT_NODE || !translationEl.isConnected) {
      return false;
    }

    keepInFlow(translationEl);

    const rect = translationEl.getBoundingClientRect();
    // 没有尺寸的译文量不出溢出（还没排版，或者本来就是空的），留着。
    if (rect.width === 0 && rect.height === 0) return true;

    let host = translationEl.parentElement;
    for (let depth = 0; depth < MAX_DEPTH && host && host !== document.body && host !== document.documentElement; depth++) {
      // 内联盒没有自己的高度（clientHeight 恒为 0），量它得到的溢出是假的
      if (host.clientHeight > 0 && spillsOut(host, rect)) {
        // 溢出了。这一下究竟是「看不见」还是「盖住别人」，取决于这个框裁不裁剪：
        //   - 会裁（hidden/clip/auto/scroll）→ 框外那截根本不显示，压不到谁。
        //     滚动条或者 clip-guard 会处理，撤译文只会把它们处理好的情况弄砸。
        //     而且既然这一层就裁住了，再往上也溢不出去，所以是 return。
        //   - 不裁（visible）→ 框外那截照样画出来，正压在别人身上。撤掉。
        if (window.getComputedStyle(host).overflowY !== 'visible') return true;
        translationEl.remove();
        if (ctx.releaseTranslationClipGuards) ctx.releaseTranslationClipGuards();
        return false;
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
