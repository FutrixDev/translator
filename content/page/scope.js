// Blab Translation — 整页翻译：正文范围
//
// 默认（`pageTranslateScope: 'main'`）只翻正文：减掉页面**自己标明**的非正文
// ——导航、侧栏、菜单、站点页眉页脚——外加信任作者声明的 <main>。不做任何启发式
// 正文抽取（「段落密度最高的那一栏就是正文」这类）：它们在没有语义标记的页面上
// 会静默丢掉导语、评论区、第二栏，用户看到半页没翻却不知道为什么；少跳几块导航
// 的代价只是多翻几个词。所以一个既没有 <main>、也没有下面任何跳过元素的页面，
// 'main' 与 'page' 收到的块完全相同（e2e 的不变式断言守着这一条）。
//
// 这个文件只回答「从哪儿开始收、哪些子树不收」，收块本身还是 collect.js：
//   - `ctx.resolvePageScope()` → `{ mode, roots, skip, share }`
//   - `ctx.pageScopeCut(el, scope)` / `ctx.pageScopeStarts(dirty, scope)`：collect.js 的两个挂钩
//   - `ctx.collectPageBlocks(root)`：生产入口（手动翻译、发现层、A1 的子 frame 手动轮）
//   - `ctx.beginScopeRound()`：上面三个入口每轮收集前调一次（缓存规则见 resolvePageScope）
//   - `ctx.translateWholePage()`：悬浮菜单「翻译整个页面」与 Alt+W
(function() {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT;
  if (!ctx) return;

  const { state } = ctx;

  // 唯一的阈值：<main> 的文字量至少占 body 的这么多，才信它是正文的根。低于它的
  // <main> 多半是站点只把一个壳子标成了 main（首页轮播、登录框），正文在别处。
  // 调参数据见 test/e2e/page-coverage.spec.js 的阈值夹具。
  const MAIN_TEXT_SHARE = 0.3;

  const MAIN_SELECTOR = 'main, [role="main"]';
  // 出现在哪里都跳。
  const ALWAYS = 'nav, aside, menu, [role="navigation"], [role="complementary"], [role="menu"], [role="menubar"]';
  // 只在不处于正文容器里时才跳：文章自己的页眉页脚是正文。
  const CONTEXT = 'header, footer, [role="banner"], [role="contentinfo"]';
  const CONTENT = 'article, main, [role="main"], section';
  const SKIP = Object.freeze({ always: ALWAYS, context: CONTEXT, content: CONTENT });

  function closest(el, selector) {
    if (!el) return null;
    return ctx.closestComposed(el, selector);
  }

  const parentOf = (el) => ctx.composedParent(el);
  const contains = (ancestor, node) => ctx.composedContains(ancestor, node);

  /**
   * 当前有效模式，只判 mode、不找根——悬浮菜单每次打开都问一次，要便宜。
   * @returns {'main'|'page'}
   */
  function pageScopeMode() {
    // 判定顺序（P1-B 在第 2 步接入用户站点规则的 include 选择器）：
    //   1. 本页的临时覆盖（「翻译整个页面」、Alt+W）；
    //   2. 用户规则的 include 选择器：至少命中一个渲染出来的元素才算，命中零个
    //      不缓存（下一次再问），命中时范围模式记为 'include'；
    //   3. 设置是 'page'，或者命中内置规则（X、Hacker News……已经按站点调过收块）；
    //   4. 默认 'main'。
    if (state.pageScopeOverride === 'page') return 'page';
    if (ctx.settings.pageTranslateScope === 'page') return 'page';
    if (globalThis.SiteRules.matchBuiltin(location.hostname, location.pathname)) return 'page';
    return 'main';
  }

  // 可见文字量：去掉空白，也去掉 <script>/<style> 里的字（Next.js 的
  // __NEXT_DATA__ 一段 JSON 就能比正文还长）。用 textContent 而不是 innerText：
  // 后者要排版，发现层每一轮都可能问到这里。
  function compactLength(text) {
    return text ? text.replace(/\s+/g, '').length : 0;
  }

  function textLength(el) {
    let length = compactLength(el.textContent);
    for (const code of el.querySelectorAll('script, style, noscript')) {
      length -= compactLength(code.textContent);
    }
    return Math.max(0, length);
  }

  function isRendered(el) {
    return el.getClientRects().length > 0;
  }

  // 唯一的（最外层的、渲染出来的）main 且文字量够 → 它；否则 null（退回 body）。
  function findMainRoot() {
    const rendered = Array.from(document.querySelectorAll(MAIN_SELECTOR)).filter(isRendered);
    const outer = rendered.filter((el) => !rendered.some((other) => other !== el && other.contains(el)));
    if (outer.length !== 1) return { root: null, share: null };
    const bodyText = textLength(document.body);
    const share = bodyText ? textLength(outer[0]) / bodyText : 0;
    return { root: share >= MAIN_TEXT_SHARE ? outer[0] : null, share };
  }

  // 缓存。键 = URL + 设置值 + 覆盖值：换页、改设置、点整页入口都换键，不必另挂
  // 监听。不挂任何观察者，作废只有下面这几处：
  //   - 'page' 模式与认出来的 <main>：键不变、根还连着就一直有效；
  //   - 退回 body 的结果也缓存（一轮发现可能有好几个脏根，body 的字数只该数一次），
  //     但单页应用首屏往往先出一个空壳，<main> 晚一步才长出正文，所以它在每一轮
  //     收集开始时作废——发现层的 flush、手动整页翻译、子 frame 的手动轮各调一次
  //     beginScopeRound()；
  //   - invalidatePageScope() 整个丢掉（整页入口、子 frame 跟顶层换覆盖值）。
  let cache = null;

  function resolvePageScope() {
    const setting = ctx.settings.pageTranslateScope;
    const key = `${location.href}\n${setting}\n${state.pageScopeOverride || ''}`;
    if (cache && cache.key === key && cache.scope.roots.every((root) => root.isConnected)) {
      return cache.scope;
    }
    cache = null;
    const mode = pageScopeMode();
    if (mode === 'page') {
      const scope = { mode, roots: [document.body], skip: null, share: null };
      cache = { key, scope };
      return scope;
    }
    const { root, share } = findMainRoot();
    const scope = { mode, roots: [root || document.body], skip: SKIP, share };
    cache = { key, scope, fallback: !root };
    return scope;
  }

  function invalidatePageScope() {
    cache = null;
  }

  // 一轮收集开始：退回 body 的缓存作废，让晚长出正文的 <main> 有机会被认出来。
  function beginScopeRound() {
    if (cache && cache.fallback) cache = null;
  }

  function headingsIn(el) {
    const found = el.matches('h1') ? [el] : Array.from(el.querySelectorAll('h1'));
    return found.filter((h1) => !closest(h1, ALWAYS));
  }

  /**
   * collect.js 对每个元素问一次：这棵子树在范围里吗。
   * @returns {Element[]|null} null = 照常收；数组 = 这棵子树不收，只收数组里的元素
   *   （站点页眉页脚里的 h1——标题常写在页面级 <header> 里）。
   */
  function pageScopeCut(el, scope) {
    if (!scope || !scope.skip) return null;
    if (el.matches(scope.skip.always)) return [];
    // h1 自己不受这一条约束（`<h1 role="banner">` 也照收），也保证返回的数组里
    // 不会有 el 本身——否则收集器会拿它再问一遍，无限递归。
    if (el.localName !== 'h1' && el.matches(scope.skip.context) &&
        !closest(parentOf(el), scope.skip.content)) {
      return headingsIn(el);
    }
    return null;
  }

  // 脏根在范围根之内：往上看它是不是落在一块被跳过的子树里。
  function startsInside(dirty, root, scope) {
    if (dirty === root) return [dirty];
    for (let el = parentOf(dirty); el && el !== root; el = parentOf(el)) {
      if (el.matches(scope.skip.always)) return [];
      if (el.localName !== 'h1' && el.matches(scope.skip.context) &&
          !closest(parentOf(el), scope.skip.content)) {
        return headingsIn(dirty);
      }
    }
    return [dirty];
  }

  function byDocumentOrder(a, b) {
    if (a === b) return 0;
    return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  }

  /**
   * 从脏根（整页翻译时是 body，发现层是一处变动的子树）出发，实际该从哪几个元素
   * 开始收：
   *   - 脏根在范围根之内 → 它自己（跳过规则由 pageScopeCut 在遍历中套用）；
   *   - 脏根包含范围根 → 范围根，加上脏根里范围根之外的孤立 h1；
   *   - 两者无交集 → 只有脏根里的孤立 h1。
   */
  function pageScopeStarts(dirty, scope) {
    if (!scope || !scope.skip) return [dirty];
    const starts = [];
    let inside = false;
    for (const root of scope.roots) {
      if (contains(root, dirty)) {
        inside = true;
        starts.push(...startsInside(dirty, root, scope));
      } else if (contains(dirty, root)) {
        starts.push(root);
      }
    }
    if (!inside) {
      for (const h1 of headingsIn(dirty)) {
        if (!scope.roots.some((root) => contains(root, h1))) starts.push(h1);
      }
    }
    return starts.sort(byDocumentOrder);
  }

  // 生产入口：整页翻译、发现层、子 frame 的手动轮都走这里。
  // 直接调 collectTranslatableBlocks(root)（不带 scope）的行为不变：不做范围过滤。
  function collectPageBlocks(root = document.body) {
    return ctx.collectTranslatableBlocks(root, { scope: resolvePageScope() });
  }

  /**
   * 悬浮菜单「翻译整个页面」和 Alt+W。本文档存续期内改成整页范围，然后：
   *   - 本来就是整页范围（设置是 'page'，或者已经点过一次）→ 与 Alt+A 同一个动作，
   *     有可见译文就收起、没有就翻；
   *   - 本来是正文范围 → 接着翻：已翻的块收集器自己跳过，只补范围外那部分。
   * @returns {'translating'|'restored'}
   */
  function translateWholePage() {
    const wasPage = pageScopeMode() === 'page';
    state.pageScopeOverride = 'page';
    invalidatePageScope();
    if (wasPage) return ctx.togglePageTranslation();
    ctx.translatePage();
    return 'translating';
  }

  ctx.MAIN_TEXT_SHARE = MAIN_TEXT_SHARE;
  ctx.pageScopeMode = pageScopeMode;
  ctx.resolvePageScope = resolvePageScope;
  ctx.invalidatePageScope = invalidatePageScope;
  ctx.beginScopeRound = beginScopeRound;
  ctx.pageScopeCut = pageScopeCut;
  ctx.pageScopeStarts = pageScopeStarts;
  ctx.collectPageBlocks = collectPageBlocks;
  ctx.translateWholePage = translateWholePage;
})();
