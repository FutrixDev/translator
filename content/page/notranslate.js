// Blab Translation — 整页翻译：notranslate
//
// 页面作者用 `translate="no"` 或 `notranslate` class 说「这段别翻」（产品名、
// 代码样例、人名），浏览器自带的翻译和谷歌翻译都认。这里给收集器两样东西：
//
// - `ctx.createTranslateJudge()`：一轮收集用一个判定器，`allowed(el)` 回答「这个
//   元素按作者的声明该不该翻」。规则：从元素本身往上（穿 shadow 边界），**第一
//   个**带 `translate` 属性或 `notranslate` class 的元素说了算；走到 <body> 为止，
//   <html> / <body> 上的声明不认（只认元素级声明——整页 `translate="no"` 的页面
//   多半是站点自己做了翻译开关，用户点了「翻译」就是要翻）。判定结果按元素记在
//   WeakMap 里，一条祖先链只爬一次：收集是自上而下遍历，父亲先被问到，孩子往上
//   一步就命中记忆。
// - `ctx.ownTranslateDeclaration(el)`：元素**自己**的声明，'no' / 'yes' / null。
//   行内的 no 在 getTextWithMathPlaceholders 里变成元素占位符，原样克隆回译文。
//   整页收集时，站点规则排除的元素（site-adapter.js 的 excludeSelectors）也走这条路。
//
// 同一元素上 class 与属性同时出现时 class 赢（`notranslate` 是更明确的退出信号，
// 谷歌翻译也这么处理）。属性值去空白、不区分大小写；不是 yes / no / 空串的值等于
// 没写，继续往上找（HTML 规范里无效值即「继承」）。
(function() {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT;
  if (!ctx) return;

  function isDocumentLevel(el) {
    return el === document.body || el === document.documentElement;
  }

  function ownTranslateDeclaration(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE || isDocumentLevel(el)) return null;
    if (el.classList.contains('notranslate')) return 'no';
    const value = el.getAttribute('translate');
    if (value === null) return null;
    const normalized = value.trim().toLowerCase();
    if (normalized === 'no') return 'no';
    if (normalized === 'yes' || normalized === '') return 'yes';
    return null;
  }

  function parentOf(el) {
    return ctx.composedParent(el);
  }

  function createTranslateJudge() {
    const memo = new WeakMap();
    return function allowed(element) {
      const chain = [];
      let answer = true;
      for (let el = element; el; el = parentOf(el)) {
        if (memo.has(el)) {
          answer = memo.get(el);
          break;
        }
        if (isDocumentLevel(el)) break;
        chain.push(el);
        const own = ownTranslateDeclaration(el);
        if (own) {
          answer = own === 'yes';
          break;
        }
      }
      for (const el of chain) memo.set(el, answer);
      return answer;
    };
  }

  ctx.ownTranslateDeclaration = ownTranslateDeclaration;
  ctx.createTranslateJudge = createTranslateJudge;
})();
