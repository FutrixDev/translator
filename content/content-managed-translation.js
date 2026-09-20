// 受管 DOM 容器里的译文渲染。
//
// Lexical / ProseMirror / Slate 这类富文本编辑器把自己的子树和内部 EditorState
// 对账：MutationObserver 一看见子树里出现了不是自己造的节点，就按内部状态重建这
// 段 DOM，我们插进去的译文一帧之内就没了（判定见 content-utils.js 的
// MANAGED_DOM_ROOT_SELECTOR）。已实测过的插入位置，在 Higgsfield 的只读 Lexical
// 正文 div.rde-content 上：
//
//   block.after(el)              -> 1 秒内被删
//   block.appendChild(el)        -> 被删
//   块内挂 shadow host           -> 被删
//   块上改 style / 加自定义属性  -> 存活（属性不在观察范围内）
//
// 最后一条是出路：CSS 生成内容不是 DOM 节点，MutationObserver 根本看不见它，而
// 它照样参与真实排版。所以译文改成原文块自己的 ::after —— 后面的段落被顶下去，
// 不会被盖住；页面滚动缩放都不用管，因为它本来就长在原文块上。
//
// 曾经走过一版文档级浮层（position:absolute 挂 body，按 getBoundingClientRect
// 贴着原文块）。节点确实活下来了，但浮层脱离文档流，只能盖在下一段原文上，而且
// 整页翻译会叠出几百层遮罩。生成内容没有这个问题，这版把浮层整个换掉了。
//
// 代价说明白：::after 只能放纯文本 —— 不能克隆公式元素，也不能选中复制。放不下
// 的块（有公式、站点自己占用了 ::after、块本身是 flex/grid 容器）由
// canRenderManagedTranslation() 判掉，调用方各自决定退路。
(function() {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT;
  if (!ctx) return;

  // 原文块上的标记，规则按它的取值选中：[data-ai-translator-managed="7"]::after
  const BLOCK_ATTR = 'data-ai-translator-managed';
  const STATE_ATTR = 'data-ai-translator-managed-state';
  // 挂在 <html> 上，一个属性关掉受管译文（浮球菜单的“隐藏译文”）
  const HIDDEN_ATTR = 'data-ai-translator-managed-hidden';
  // 这一条是划词 / 悬停译出来的**一次性**结果。那个开关管的是整页那一批，收不到
  // 它头上：用户刚刚指着一句话问出来的答案，不归一个管整页的开关收走。普通容器
  // 里靠 PAGE_TRANSLATION_SELECTOR 的两个 :not() 排除，这里没有节点可以选中 ——
  // 译文是原文块的 ::after，所以标记打在原文块上，由规则把它让开。
  const ONE_OFF_ATTR = 'data-ai-translator-managed-one-off';
  const STYLE_ID = 'ai-translator-managed-style';
  const HOLDER_ID = 'ai-translator-managed-handles';

  // 基础样式一次注入；每条译文再各自插一条只带 content 的规则。
  // 顺序有讲究：状态色写在基础规则后面，才压得住它的 opacity/color。
  const BASE_CSS = `
[${BLOCK_ATTR}]::after {
  display: block;
  white-space: pre-wrap;
  opacity: 0.85;
  margin-top: 0.15em;
  margin-bottom: 0.15em;
}
[${BLOCK_ATTR}][${STATE_ATTR}="loading"]::after {
  color: #7c5cff;
  font-weight: 600;
  opacity: 1;
}
[${BLOCK_ATTR}][${STATE_ATTR}="error"]::after {
  color: #d93025;
  opacity: 1;
}
[${HIDDEN_ATTR}] [${BLOCK_ATTR}]:not([${ONE_OFF_ATTR}])::after {
  content: none !important;
}
`;

  const handles = new Map();      // 句柄元素 -> { id, block }
  // 这个块此刻挂的是哪一个句柄。一个块同时只有一条译文，而换一条译文是「先画新
  // 的、再收旧的」：加载态换成结果就是这个次序。两个句柄共用同一个 id，收旧的时
  // 候不问一句「这个块现在归谁」，收掉的就是刚画上去的那一条 —— 用户看到的是
  // 「正在翻译…」闪一下，然后什么都没有。
  const currentHandle = new WeakMap(); // 原文块 -> 句柄元素
  const rulesById = new Map();    // id -> CSSStyleRule
  let nextId = 1;

  function getSheet() {
    let style = document.getElementById(STYLE_ID);
    if (!style || !style.isConnected) {
      style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = BASE_CSS;
      (document.head || document.documentElement).appendChild(style);
      // 样式表被页面自己清掉过（SPA 换页会重写 head），旧规则的引用一起作废
      rulesById.clear();
    }
    return style.sheet || null;
  }

  // 句柄放在一个 display:none 的容器里，而不是游离在文档外：调用方会用
  // isConnected 判断译文是不是被容器删掉了，游离节点会被当成“已被删”。
  function getHolder() {
    let holder = document.getElementById(HOLDER_ID);
    if (!holder || !holder.isConnected) {
      holder = document.createElement('div');
      holder.id = HOLDER_ID;
      holder.style.cssText = 'display:none !important;';
      (document.body || document.documentElement).appendChild(holder);
    }
    return holder;
  }

  // CSS 字符串字面量的转义。反斜杠和引号要转义；CSS 字符串里不允许裸换行，换行写
  // 成 \A，后面补一个空格把转义序列断开，否则紧跟的十六进制字符会被并进来。
  function cssString(text) {
    return '"' + String(text == null ? '' : text)
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\r\n?/g, '\n')
      .replace(/\n/g, '\\A ') + '"';
  }

  function dropRule(id) {
    const rule = rulesById.get(id);
    rulesById.delete(id);
    if (!rule) return;
    const sheet = rule.parentStyleSheet;
    if (!sheet) return;
    // 规则的下标会随前面的增删移动，只能现查
    const index = Array.prototype.indexOf.call(sheet.cssRules, rule);
    if (index >= 0) {
      try { sheet.deleteRule(index); } catch (error) { /* 表已失效，无所谓 */ }
    }
  }

  function putRule(sheet, id, text) {
    dropRule(id);
    try {
      const index = sheet.insertRule(
        `[${BLOCK_ATTR}="${id}"]::after{content:${cssString(text)};}`,
        sheet.cssRules.length
      );
      rulesById.set(id, sheet.cssRules[index]);
      return true;
    } catch (error) {
      // 译文里有什么把规则写坏了，宁可不渲染也不要留半条规则
      return false;
    }
  }

  // 这一块能不能用生成内容承载译文。
  ctx.canRenderManagedTranslation = function(block, options = {}) {
    if (!block || block.nodeType !== Node.ELEMENT_NODE || !block.isConnected) return false;
    // 公式要克隆 MathJax/KaTeX 的 DOM 才显示得出来，生成内容里放不进元素
    if (options.hasMath) return false;
    const style = window.getComputedStyle(block);
    // flex/grid 容器里的 ::after 是一个布局项，会跟原文并排而不是另起一行
    if (/flex|grid/.test(style.display)) return false;
    // 站点自己用了 ::after（引号、角标、装饰线），我们的 content 会把它盖掉。
    //
    // **我们自己画的那一笔不算。** 一条译文从「正在翻译…」变成正文，就是在同一个
    // 块上再画一次；把上一笔当成站点的装饰，第二笔就永远落不下去 —— 受管容器里
    // 划词会一直停在「正在翻译…」，然后退回那条插真节点的路，而那条路在 Lexical
    // 里下一帧就被编辑器撤销了，用户什么都看不到。这个块归不归我们管，
    // BLOCK_ATTR 说了算。
    if (!block.hasAttribute(BLOCK_ATTR)) {
      const after = window.getComputedStyle(block, '::after').content;
      if (after && after !== 'none' && after !== 'normal') return false;
    }
    return true;
  };

  // 画一条受管译文，返回一个句柄元素供调用方登记 / 比对 / 释放。
  //
  // 句柄不是译文本身 —— 译文是原文块上的一条 ::after 规则，没有对应节点。句柄存在
  // 只是因为现有的记账（Map、inlineTranslationSources、浮球的 querySelectorAll）
  // 都以“译文是一个元素”为前提，所以给它一个不显示的替身，带上同样的类名。
  ctx.renderManagedTranslation = function(block, text, options = {}) {
    const { kind, state, className } = options;
    if (!block || block.nodeType !== Node.ELEMENT_NODE) return null;
    const sheet = getSheet();
    if (!sheet) return null;

    // 一个块同时只有一条译文：悬停改划词、加载态换成结果，都复用同一个 id，
    // 免得规则在表里越堆越多。
    const id = block.getAttribute(BLOCK_ATTR) || String(nextId++);
    if (!putRule(sheet, id, text)) return null;

    block.setAttribute(BLOCK_ATTR, id);
    if (state) {
      block.setAttribute(STATE_ATTR, state);
    } else {
      block.removeAttribute(STATE_ATTR);
    }

    const handle = document.createElement('span');
    handle.className = ['ai-translator-inline-block', 'ai-translator-managed-handle', className]
      .filter(Boolean).join(' ');
    handle.textContent = text;

    // 一次性还是整页，判据只有一条：**句柄自己答不答得上那条选择器**。这里再按
    // kind / className 自己判一遍的话，两处迟早各答各的 —— 而这一处答错的样子是
    // 用户划完词按一下「显示原文」，那句答案连同整页译文一起没了，再划一句还是
    // 不出来（生成内容由一条文档级规则统管，新画的天然跟着）。
    const oneOff = !!ctx.PAGE_TRANSLATION_SELECTOR && !handle.matches(ctx.PAGE_TRANSLATION_SELECTOR);
    if (oneOff) block.setAttribute(ONE_OFF_ATTR, '');
    else block.removeAttribute(ONE_OFF_ATTR);

    getHolder().appendChild(handle);
    handles.set(handle, { id, block });
    currentHandle.set(block, handle);
    return handle;
  };

  ctx.isManagedTranslationHandle = function(el) {
    return !!el && handles.has(el);
  };

  // 句柄对应的原文块。句柄挂在离屏 holder 里，它自己的位置没有任何意义 —— 译文的
  // 真实几何是原文块的 ::after 撑出来的那部分。要量受管译文，量的就是这个块。
  ctx.getManagedTranslationBlock = function(el) {
    const entry = handles.get(el);
    return entry ? entry.block : null;
  };

  // 释放句柄对应的那条译文。调用方在 remove() 之前调用：句柄自己 remove 掉不会
  // 让 ::after 消失，规则和原文块上的标记都得在这里收。
  ctx.releaseManagedTranslation = function(handle) {
    const entry = handles.get(handle);
    if (!entry) return false;
    handles.delete(handle);
    // 这个块已经换了一条译文（见 currentHandle）：旧句柄只收自己，规则和块上的
    // 标记都是新那条的，动不得。
    if (entry.block && currentHandle.get(entry.block) !== handle) {
      handle.remove();
      return true;
    }
    dropRule(entry.id);
    if (entry.block) {
      currentHandle.delete(entry.block);
      entry.block.removeAttribute(BLOCK_ATTR);
      entry.block.removeAttribute(STATE_ATTR);
      entry.block.removeAttribute(ONE_OFF_ATTR);
    }
    handle.remove();
    return true;
  };

  // 原文块已经不在文档里的那些句柄，连同它们的规则一起收掉。
  //
  // 句柄挂在离屏 holder 上，holder 挂在 body 上 —— 单页应用换页换掉的是内容那
  // 段子树，holder 一动不动，于是上一页的句柄全留了下来。留着有两笔账：它们还
  // 答得上 PAGE_TRANSLATION_SELECTOR（「这一页翻过了没有」因此答错，见
  // content-page-translation.js 的 hasPageTranslations），以及样式表里那条
  // ::after 规则和 handles 里的条目再没有人会来收，一个长会话里只增不减。
  //
  // 挑换路由这个时机，是因为「上一页没了」在这一刻不含糊。读的时候顺手清不行：
  // 页面暂时把一段子树摘下来再挂回去是常事，那种块不该在一次读里被判死刑。
  function sweepOrphanedHandles() {
    for (const [handle, entry] of [...handles]) {
      if (!entry.block || entry.block.isConnected) continue;
      // 先收这一个句柄：一个块同时挂两个句柄是有的（先画新的、再收旧的），那笔
      // 账只有按句柄一个个走才算得对（见 currentHandle）。
      ctx.releaseManagedTranslation(handle);
      // 再收台账。句柄、::after 规则、块上那几个属性是一半，BlockIdentity 里那
      // 条登记和 .ai-translator-translated 是另一半 —— 两半都收，这个块才真的回
      // 到「没翻过」。单页应用把整段子树摘下来存着、回头再挂回去是常事（Turbo、
      // React Router 的缓存都这么干），而那时候发现层一看指纹没变就跳过
      // （content/page/collect.js:295）：译文早被这里收掉了，这个块从此既没有译
      // 文，也再没有任何东西会来翻它。
      //
      // 第二个句柄轮到时这一句会空跑 —— lookup 已经查不到了，直接返回 false。
      if (ctx.releaseTranslation) ctx.releaseTranslation(entry.block);
    }
  }

  ctx.sweepOrphanedManagedTranslations = sweepOrphanedHandles;

  // 谁拥有这个值，谁负责清 —— 引擎那份语言缓存也是自己订的路由过期
  // （content-translation-engine.js:192）。守卫留着：只装了整页翻译那几个模块的
  // DOM 夹具里没有这一层。
  if (globalThis.SpaNavigation) {
    globalThis.SpaNavigation.onRouteChange(sweepOrphanedHandles);
  }

  ctx.setManagedTranslationsVisible = function(visible) {
    const root = document.documentElement;
    if (!root) return;
    if (visible) {
      root.removeAttribute(HIDDEN_ATTR);
    } else {
      root.setAttribute(HIDDEN_ATTR, '');
    }
  };

  ctx.areManagedTranslationsHidden = function() {
    return !!(document.documentElement && document.documentElement.hasAttribute(HIDDEN_ATTR));
  };
})();
