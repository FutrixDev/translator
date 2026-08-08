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
  // 挂在 <html> 上，一个属性关掉所有受管译文（浮球菜单的“隐藏译文”）
  const HIDDEN_ATTR = 'data-ai-translator-managed-hidden';
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
[${HIDDEN_ATTR}] [${BLOCK_ATTR}]::after {
  content: none !important;
}
`;

  const handles = new Map();      // 句柄元素 -> { id, block }
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
    // 站点自己用了 ::after（引号、角标、装饰线），我们的 content 会把它盖掉
    const after = window.getComputedStyle(block, '::after').content;
    if (after && after !== 'none' && after !== 'normal') return false;
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
    getHolder().appendChild(handle);
    handles.set(handle, { id, block });
    return handle;
  };

  ctx.isManagedTranslationHandle = function(el) {
    return !!el && handles.has(el);
  };

  // 释放句柄对应的那条译文。调用方在 remove() 之前调用：句柄自己 remove 掉不会
  // 让 ::after 消失，规则和原文块上的标记都得在这里收。
  ctx.releaseManagedTranslation = function(handle) {
    const entry = handles.get(handle);
    if (!entry) return false;
    handles.delete(handle);
    dropRule(entry.id);
    if (entry.block) {
      entry.block.removeAttribute(BLOCK_ATTR);
      entry.block.removeAttribute(STATE_ATTR);
    }
    handle.remove();
    return true;
  };

  ctx.hasManagedTranslations = function() {
    return handles.size > 0;
  };

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
