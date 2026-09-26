// 站点适配：把内置规则表里那两串选择器，交到收集器手上。
//
// 规则表（shared/site-rules-builtin.js）对每条站点写了两件事，通用启发式两件都
// 猜不出来：
//
//   - `atomicBlockSelectors`——「这一块要整个翻，不许拆」。一条推文的正文是
//     `<div data-testid="tweetText">` 里一串 `<span>`，收集器的通则是「有块级可
//     翻子元素就递归下探」，于是一条推文被切成一句一请求，@提及和话题标签各自
//     成块，译文按句子插回去，读起来是碎的，钱也是按块付的。
//   - `excludeSelectors`——「这一块根本不该翻」。作者名、时间戳、票数、
//     "reply"。翻出来只是把时间线塞满没人看的译文。块本身是它、或在它里面，
//     整块不收；块里**含着**它（一行里的 <time>），它在块文本里变成元素占位符、
//     原样克隆回译文，同行内的 `translate="no"`。只管整页收集，悬停和划词不看。
//
// 这一层只管**解析和校验**，判断留在 collect.js 里。分开是因为规则表是会随版本
// 更新的数据：里面一个写错的选择器会让 `matches()` / `closest()` 当场抛，而这两
// 个调用在 processElement 的热路径上——一抛就是整页零块、静默翻不了。所以每串
// 选择器都先拿 `document.querySelector` 试一次，抛了就当这条没写过。规则表坏掉
// 的退化方向是「翻得碎」，不是「翻不了」（见 shared/site-rules.js 的 loadTable）。
(function () {
  'use strict';
  const ctx = window.AI_TRANSLATOR_CONTENT;
  if (!ctx) return;

  // 规则按 host + path 选中（内置表里就有 `arxiv.org/abs/*` 这种按路径的），所以
  // 缓存的键是这两样。单页应用换了路由，键跟着变，下一轮收集自己就重新解析了。
  let cacheKey = null;
  let cached = null;

  function usableSelector(list) {
    if (!Array.isArray(list) || list.length === 0) return '';
    const kept = [];
    for (const one of list) {
      if (typeof one !== 'string' || !one.trim()) continue;
      try {
        document.querySelector(one);
        kept.push(one);
      } catch (err) {
        // 坏选择器只丢自己那一条：同一条规则里另一串多半还是好的，把整条规则
        // 丢掉等于白白退回通用启发式。
        console.warn('Blab Translation: site rule selector rejected, skipping it', one, err);
      }
    }
    return kept.join(',');
  }

  /**
   * 当前这一页的站点适配。
   *
   * @returns {{atomic: string, exclude: string}|null} 两串已经并成一条的选择器；
   *   这一页没有规则、或者规则里两串都空/都不合法时是 null，调用方照通用启发式走。
   */
  function resolveSiteAdapter() {
    const key = `${location.hostname}\n${location.pathname}`;
    if (key === cacheKey) return cached;
    cacheKey = key;
    cached = null;

    const rules = globalThis.SiteRules;
    if (!rules || !rules.matchBuiltin) return cached;
    const rule = rules.matchBuiltin(location.hostname, location.pathname);
    if (!rule) return cached;

    const atomic = usableSelector(rule.atomicBlockSelectors);
    const exclude = usableSelector(rule.excludeSelectors);
    if (!atomic && !exclude) return cached;

    cached = { atomic, exclude };
    return cached;
  }

  ctx.resolveSiteAdapter = resolveSiteAdapter;
})();
