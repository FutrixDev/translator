// Blab Translation — 页内拾取器：给点中的元素生成一条选择器
//
// 规则会存下来长期复用，所以挑最不容易随站点构建变化的写法（设计 §0.1-14）：
//
//   稳定的 id  >  稳定的 data-*  >  标签 + 非哈希类名  >  nth-of-type 链（最多 5 层）
//
// 「唯一」只在元素自己的 root 里判（document 或 shadow root）：规则按
// queryAllDeep 在所有 root 里找，可一个 shadow root 里的元素没法用一条选择器从
// document 那边写到，root 内唯一是能做到的最好。
//
// 只写出 /^[A-Za-z_][\w-]*$/ 这样的标识符，不做 CSS 转义：带冒号、斜杠、方括号
// 的 id 和类名（Tailwind 的 md:flex、React 的 :r1:）本来就是生成的，跳过它们
// 正好。
//
// 这里只用元素的一小撮接口（tagName、id、classList、attributes、
// parentElement、children、getRootNode、querySelectorAll），单测拿假节点在 vm
// 里跑（test/unit/picker-selector.test.mjs）。
(function() {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT;
  if (!ctx) return;

  const picker = (ctx.picker = ctx.picker || {});

  const IDENT = /^[A-Za-z_][\w-]*$/;
  const MAX_CHAIN = 5;
  const MAX_CLASSES = 3;
  // data-* 的值写进引号里，只收这种字符，不用转义。
  const DATA_VALUE = /^[\w-]{1,64}$/;
  // 测试用的属性是站点作者专门写给机器找的，排在别的 data-* 前面。
  const PREFERRED_DATA = ['data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy'];

  /**
   * 构建工具生成的名字：每次构建都可能变，写进规则里下一版就不中了。
   *   - 连续 3 位以上数字（ember123、_3fX9a123、jss1234）；
   *   - emotion 的 css-1x2y3z、styled-components 的 sc-AbCdE；
   *   - CSS Modules 的 _3fX9a（下划线打头接数字）和 Button__root__1a2b3 这种
   *     双下划线后缀；
   *   - 大小写混排又带数字的（kLmN3p）；
   *   - 带冒号的（Tailwind 的变体、React 的 useId）。
   */
  function isVolatileClass(name) {
    const s = String(name || '');
    if (!s) return true;
    if (/\d{3,}/.test(s)) return true;
    if (/^css-\d/.test(s) || /^sc-/.test(s)) return true;
    if (/^_\d/.test(s)) return true;
    if (/__[A-Za-z0-9]*\d[A-Za-z0-9]*$/.test(s)) return true;
    if (/[a-z]/.test(s) && /[A-Z]/.test(s) && /\d/.test(s)) return true;
    if (s.includes(':')) return true;
    return false;
  }

  function stableName(name) {
    return IDENT.test(name) && !isVolatileClass(name);
  }

  // 我们自己挂上去的类名和属性（译文、原文包裹、主题标记）不算页面的。
  function isOurs(name) {
    return name.startsWith('ai-translator-') || name.startsWith('data-ai-translator');
  }

  function tagOf(el) {
    return String(el.tagName || '').toLowerCase();
  }

  function rootOf(el) {
    return el.getRootNode ? el.getRootNode() : null;
  }

  /** 在 el 自己的 root 里，selector 是否只中 el 一个。无效选择器算不唯一。 */
  function uniqueIn(el, selector) {
    const root = rootOf(el);
    if (!root || !root.querySelectorAll) return false;
    let hits;
    try {
      hits = root.querySelectorAll(selector);
    } catch (_) {
      return false;
    }
    return hits.length === 1 && hits[0] === el;
  }

  function idPart(el) {
    const id = el.id;
    return id && stableName(id) ? `#${id}` : '';
  }

  function dataParts(el) {
    const attrs = Array.from(el.attributes || [])
      .filter((a) => a.name.startsWith('data-') && !isOurs(a.name) && IDENT.test(a.name))
      .filter((a) => DATA_VALUE.test(a.value) && !isVolatileClass(a.value));
    const rank = (name) => {
      const at = PREFERRED_DATA.indexOf(name);
      return at === -1 ? PREFERRED_DATA.length : at;
    };
    attrs.sort((a, b) => rank(a.name) - rank(b.name) || (a.name < b.name ? -1 : 1));
    return attrs.map((a) => `${tagOf(el)}[${a.name}="${a.value}"]`);
  }

  function classPart(el) {
    const names = Array.from(el.classList || [])
      .filter((name) => !isOurs(name) && stableName(name))
      .slice(0, MAX_CLASSES);
    return names.length ? tagOf(el) + names.map((n) => `.${n}`).join('') : '';
  }

  function nthPart(el) {
    const tag = tagOf(el);
    const parent = el.parentElement;
    if (!parent) return tag;
    const same = Array.from(parent.children).filter((c) => tagOf(c) === tag);
    return same.length === 1 ? tag : `${tag}:nth-of-type(${same.indexOf(el) + 1})`;
  }

  /**
   * nth-of-type 链：从元素往上，每层一段，碰到有稳定 id 的祖先就以它作锚停下。
   * 至多 5 段；5 段还不唯一就交出这 5 段 —— 工具条上的「匹配 n 处」会照实显示，
   * 用户可以自己改或点「上一层」。
   */
  function chainFor(el) {
    const parts = [];
    let cur = el;
    while (cur && parts.length < MAX_CHAIN) {
      const anchor = parts.length ? idPart(cur) : '';
      parts.unshift(anchor || nthPart(cur));
      const selector = parts.join(' > ');
      if (anchor || uniqueIn(el, selector)) return selector;
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  }

  /** 按优先级给 el 生成一条选择器。 */
  function selectorFor(el) {
    const id = idPart(el);
    if (id && uniqueIn(el, id)) return id;
    for (const candidate of dataParts(el)) {
      if (uniqueIn(el, candidate)) return candidate;
    }
    const classed = classPart(el);
    if (classed && uniqueIn(el, classed)) return classed;
    return chainFor(el);
  }

  Object.assign(picker, { isVolatileClass, selectorFor, MAX_CHAIN });
})();
