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
//   - `ctx.outsidePageScope(el, scope)`：只翻用户规则 include 的区域时，el 在不在区域外
//   - `ctx.collectPageBlocks(root)`：生产入口（手动翻译、发现层、A1 的子 frame 手动轮）
//   - `ctx.beginScopeRound()`：上面三个入口每轮收集前调一次（缓存规则见 resolvePageScope）
//   - `ctx.recallTranslations(roots)` / `ctx.recallTranslation(block)`：发现层把页内记忆
//     里的译文装回重建出来的节点（见下文「装回」）
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

  function isRendered(el) {
    return el.getClientRects().length > 0;
  }

  // 用户规则的 include 选择器；没有规则、没有 include、选择器全不可用都是 null。
  function includeSelector() {
    const rule = ctx.customRules.current();
    if (!rule || !rule.include.length) return null;
    return ctx.usableSelector(rule.include, 'user') || null;
  }

  // 有没有至少一个渲染出来的命中：遇到第一个就答，不找根。悬浮菜单每次打开、等
  // include 的页面每次取缓存都问它。
  function hasIncludeHit() {
    const selector = includeSelector();
    return Boolean(selector) && ctx.queryAllDeep(selector).some(isRendered);
  }

  // include 选择器命中的、渲染出来的元素里最外层的那些（祖先也是命中的去掉）。
  // 每个命中沿 composedParent 往上走（跨 shadow root 走到宿主），碰到别的命中就是
  // 内层：O(命中数 × 深度)，不依赖 queryAllDeep 的返回顺序。零命中是空数组。
  function includeRoots() {
    const selector = includeSelector();
    if (!selector) return [];
    const hits = ctx.queryAllDeep(selector).filter(isRendered);
    const hitSet = new Set(hits);
    return hits.filter((el) => {
      for (let up = parentOf(el); up; up = parentOf(up)) {
        if (hitSet.has(up)) return false;
      }
      return true;
    });
  }

  // include 之外的那两档：设置是 'page' 就整页，否则 'main'。内置站点不例外
  // （D-429）：它们曾被强制整页，Reddit 的规则侧栏、X 的导航都被逐条翻译，
  // 而这些站的正文都在 <main> 里；main 内部的侧栏由内置 keepOriginal 挡掉。
  function fallbackMode() {
    return ctx.settings.pageTranslateScope === 'page' ? 'page' : 'main';
  }

  /**
   * 当前有效模式，只判 mode、不找根——悬浮菜单每次打开都问一次，要便宜。
   * @returns {'main'|'page'|'include'}
   */
  function pageScopeMode() {
    // 判定顺序：
    //   1. 本页的临时覆盖（「翻译整个页面」、Alt+W）；
    //   2. 用户规则的 include 选择器：至少命中一个渲染出来的元素才算，命中零个
    //      不缓存（下一次再问），命中时范围模式记为 'include'；
    //   3. 设置是 'page'；
    //   4. 默认 'main'。
    if (state.pageScopeOverride === 'page') return 'page';
    if (hasIncludeHit()) return 'include';
    return fallbackMode();
  }

  // 可见文字量：去掉空白，也去掉 <script>/<style> 里的字（Next.js 的
  // __NEXT_DATA__ 一段 JSON 就能比正文还长）。用 textContent 而不是 innerText：
  // 后者要排版，发现层每一轮都可能问到这里。
  function compactLength(text) {
    return text ? text.replace(/\s+/g, '').length : 0;
  }

  // 也扣掉我们自己插进页面的节点（译文块、悬浮球、进度条……）。不扣的话占比跟着
  // 翻译进度走：正文翻完多出一份译文，单页应用切路由时左栏又连同它的译文一起被
  // 重建掉，<main> 的占比就被我们自己推过门槛，范围翻到 <main>，左栏从此再也不翻。
  // 范围是页面的属性，翻译前后必须答同一句。
  //
  // 清单用 ctx.constants.OWN_NODES_SELECTOR，不用 collect.js 的 SKIP_OURS：后者还
  // 含 `.ai-translator-translated` / `.ai-translator-inline-source`，那是挂在**页面
  // 自己的原文块**上的标记，扣掉它们等于翻完一块就把那块原文从占比里拿走。
  // 嵌套的只扣最外层：querySelectorAll 按文档顺序给，祖先总排在子孙前面。
  function textLength(el) {
    let length = compactLength(el.textContent);
    for (const code of el.querySelectorAll('script, style, noscript')) {
      length -= compactLength(code.textContent);
    }
    let counted = null;
    for (const own of el.querySelectorAll(ctx.constants.OWN_NODES_SELECTOR)) {
      if (counted && counted.contains(own)) continue;
      counted = own;
      length -= compactLength(own.textContent);
    }
    return Math.max(0, length);
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

  // 缓存。键 = URL + 设置值 + 覆盖值 + 用户规则集版本：换页、改设置、点整页入口、
  // 改规则都换键，不必另挂监听。不挂任何观察者，作废只有下面这几处：
  //   - 'page' 模式与认出来的 <main>：键不变、根还连着就一直有效；
  //   - 退回 body 的结果也缓存（一轮发现可能有好几个脏根，body 的字数只该数一次），
  //     但单页应用首屏往往先出一个空壳，<main> 晚一步才长出正文，所以它在每一轮
  //     收集开始时作废——发现层的 flush、手动整页翻译、子 frame 的手动轮各调一次
  //     beginScopeRound()；
  //   - include 模式：命中的根都还连着就有效；零命中不是一个结果：规则写了 include
  //     却一个也没命中时，退下去的那个答案照样缓存，但每次取用前再问一次 include
  //     （awaitsInclude），晚长出来的区域下一次就能认出来；
  //   - invalidatePageScope() 整个丢掉（整页入口、子 frame 跟顶层换覆盖值）。
  let cache = null;

  // 最近一次真正算出（不走缓存）的范围，是不是规则写了 include、区域还没出现时退
  // 下去的。它不跟缓存走：invalidatePageScope() 和缓存作废都不清它。退下去那几轮
  // 把区域外的块也翻了；区域长出来、范围第一次切到 include 时，这是「范围在轮次中
  // 途变了」，与规则变化走同一条路：ctx.customRules.rescope()（§3.4、§3.6）——当场
  // 清扫；有轮次在跑就记下，收尾时再扫；自动路径随后重启，在路上、在排队的退下去
  // 那一轮的块都作废。几种情况：
  //   - 'page' 覆盖清掉后切到 include：覆盖是用户点「翻译整个页面」要的，那时
  //     awaitsInclude 为假，这个变量也就是 false，不走 rescope()；
  //   - 规则变更新加 include 并当场命中：recompute() 自己走 rescope()，旧规则没有
  //     include，这个变量是 false，这里不再走；
  //   - 规则变化的清扫里触发的解析恰好碰上晚到：rescope() 嵌套一次，多扫一遍（清扫
  //     幂等），补翻与订阅者只排一次。
  let fellBack = false;

  function resolvePageScope() {
    const setting = ctx.settings.pageTranslateScope;
    const version = ctx.customRules.version;
    const key = `${location.href}\n${setting}\n${state.pageScopeOverride || ''}\n${version}`;
    if (cache && cache.key === key && cache.scope.roots.every((root) => root.isConnected) &&
        !(cache.awaitsInclude && hasIncludeHit())) {
      return cache.scope;
    }
    cache = null;
    const rule = ctx.customRules.current();
    const awaitsInclude = state.pageScopeOverride !== 'page' && Boolean(rule && rule.include.length);
    if (awaitsInclude) {
      const roots = includeRoots();
      if (roots.length) {
        const scope = { mode: 'include', roots, skip: null, share: null };
        cache = { key, scope };
        if (fellBack) {
          // 先写缓存、清 fellBack，再调 rescope()：它里面再解析范围，拿到的就是这个
          // include，不会再进这条分支。
          fellBack = false;
          ctx.customRules.rescope();
        }
        return scope;
      }
    }
    fellBack = awaitsInclude;
    // include 上面刚问过（零命中），或者这一页根本不看 include：不再查一遍。
    const mode = state.pageScopeOverride === 'page' ? 'page' : fallbackMode();
    if (mode === 'page') {
      const scope = { mode, roots: [document.body], skip: null, share: null };
      cache = { key, scope, awaitsInclude };
      return scope;
    }
    const { root, share } = findMainRoot();
    const scope = { mode, roots: [root || document.body], skip: SKIP, share };
    cache = { key, scope, fallback: !root, awaitsInclude };
    return scope;
  }

  function invalidatePageScope() {
    cache = null;
  }

  // 一轮收集开始：退回 body 的缓存作废，让晚长出正文的 <main> 有机会被认出来；
  // 用户规则的 CSS 也在这时重新挂一次（有的页面会整体重写 adoptedStyleSheets）。
  function beginScopeRound() {
    if (cache && cache.fallback) cache = null;
    ctx.customRules.beginRound();
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
    if (scope && scope.mode === 'include') return includeStarts(dirty, scope);
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

  // include 模式：脏根在某个区域里 → 它自己；脏根包含若干区域 → 这些区域；
  // 不相交 → 什么也不收。不做 'main' 模式那套孤儿 h1。
  function includeStarts(dirty, scope) {
    if (scope.roots.some((root) => contains(root, dirty))) return [dirty];
    return scope.roots.filter((root) => contains(dirty, root)).sort(byDocumentOrder);
  }

  /**
   * el 在不在范围之外：只有 include 模式下可能为真（其余模式的跳过规则在遍历里
   * 由 pageScopeCut 套用，已挂上的译文不会因此被收回）。
   */
  function outsidePageScope(el, scope) {
    if (!scope || scope.mode !== 'include') return false;
    return !scope.roots.some((root) => contains(root, el));
  }

  // 生产入口：整页翻译、发现层、子 frame 的手动轮都走这里。
  // 直接调 collectTranslatableBlocks(root)（不带 scope）的行为不变：不做范围过滤。
  // limit：收够这么多块就停，给 MutationObserver 回调里的同步装回用。
  function collectPageBlocks(root = document.body, { limit } = {}) {
    return ctx.collectTranslatableBlocks(root, { scope: resolvePageScope(), limit });
  }

  // ---- 装回：同样的文字换了新节点，把上次的译文放回去 ------------------------
  //
  // 单页应用切路由时常把左栏整片重建：文字一个字没变，节点全是新的，节点身份查
  // 不到，于是同样几行再翻一遍（内置引擎不走 storage 缓存，每次都真发），翻回来
  // 之前那几行先闪一下原文。页内记忆（BlockIdentity.remember，唯一写入点是
  // insert.js 的 registerTranslation）按 (目标语言, 指纹) 记着上次落笔的译文，
  // 发现层在 MutationObserver 回调里 —— 绘制之前 —— 拿它装回去。
  //
  // 走的是和第一次落笔同一条插入路径：节点身份照登记（之后的 collect 就把它当
  // 「翻过了」跳过，不进候选、不发请求、不碰调度层的台账）、隐藏译文 / 仅显示
  // 译文跟着当前状态、shadow root 里的样式照补。范围规则也照常：块是
  // collectPageBlocks 收的。

  // 同步装回的硬上限（D-543 第 6 点）：回调里每多做一点，那一帧就晚画一点。
  // 两道闸：最多看 40 个根、收 200 块（收集按 limit 提前停，不把几千块的新子
  // 树整片走一遍）；最多装回 RESTORE 块。装回一块要走插入路径的版式读取，
  // 2000 块的文档上约 0.5 ms 一块，200 块就是 100 ms 的一帧 —— 实测见
  // docs/delivery/evidence/ext-opt/c/perf.txt，16 块把最坏一次压在 16 ms 内。
  // 菜单、标签栏这类整片重建的通常就几块到十几块，一次装完。超出的留给发现层
  // 进带时逐块再问（content-auto-discover.js 的 onBand），仍然不重发，只是可
  // 能闪一帧。
  const RECALL_ROOT_BUDGET = 40;
  const RECALL_SCAN_BUDGET = 200;
  const RECALL_RESTORE_BUDGET = 16;

  // 一块记得什么：命中返回那一条，没命中（或这会儿不该装）返回 null。只查，不
  // 动 DOM。语言戳和 batch.js 的 passTarget 同一对：记进身份的是
  // currentTargetLang（空串＝跟随浏览器），打进 lang/dir 的是实际那门。
  //
  // 「这块该不该译」由两道判定把关，装回不另写一套（D-547 N3）：
  //   · 收集端那一串（范围、规则、代码、纯数字……）：块本来就是 collectPageBlocks
  //     收上来的，没过的根本到不了这里；
  //   · 跳过目标语言：那道检测在 batch.js（isTargetLanguageText，异步、要等语言
  //     检测），绘制前同步装回等不了它。所以只装落笔时已经过了这道检测的条目
  //     （targetLangChecked）；现在开着、当初没过的，返回 null 交给批量那条路，
  //     由那道检测本身来判 —— 是目标语言就不译，不是就照常请求。
  // 原文比的是 block.text：收集端 getTextWithMathPlaceholders 产出、请求体里发的
  // 就是它，落笔时记下的也是它（insert.js 的 registerTranslation）。
  function rememberedFor(block, lang) {
    const identity = globalThis.BlockIdentity;
    const entry = identity.recall(identity.fingerprint(ctx.readSourceText(block.element)), lang, block.text);
    if (entry === null) return null;
    if (ctx.settings.skipTargetLanguageText === true && !entry.targetLangChecked) return null;
    return entry;
  }

  // 装回一块：走和第一次落笔同一条插入路径。
  function restoreRemembered(block, entry, lang) {
    ctx.insertTranslationBlock(block, entry.translation, { lang, textLang: ctx.getEffectiveTargetLang() });
    ctx.afterInsertTranslation(block);
  }

  // 一块：命中就装回并返回 true（发现层进带时逐块问的那一句）。
  function recallTranslation(block) {
    const lang = ctx.currentTargetLang();
    const entry = rememberedFor(block, lang);
    if (entry === null) return false;
    restoreRemembered(block, entry, lang);
    return true;
  }

  // 和视口相交（D-548 偏差 h）。只用来排装回的先后，不判可见性：零尺寸的
  // （display:none 里的、还没撑开的）不算在视口里。
  function intersectsViewport(element) {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0
      && rect.bottom > 0 && rect.right > 0
      && rect.top < window.innerHeight && rect.left < window.innerWidth;
  }

  // 命中比预算多时，先装和视口相交的，再按 DOM 顺序装其余的（D-548 偏差 h）。
  // 按 DOM 顺序直接截前 16 块的话，一个滚到底的 30 项菜单整片重建，装回的是
  // 视口外的头 16 项，看得见的那几项要等发现层进带 —— 正是这一步要消掉的那一
  // 下闪。位置先一次读完再插：插一块就让版式作废，读插交错是每块一次强制
  // 版式。命中不超过预算时全装，先后不影响这一帧画出来的东西，就不读位置。
  function restoreOrder(hits) {
    if (hits.length <= RECALL_RESTORE_BUDGET) return hits;
    const inView = hits.map((hit) => intersectsViewport(hit.block.element));
    const first = hits.filter((_, i) => inView[i]);
    const rest = hits.filter((_, i) => !inView[i]);
    return first.concat(rest).slice(0, RECALL_RESTORE_BUDGET);
  }

  // 一批新长出来的子树。一条都没记过的页面在这里直接返回、不收块：绝大多数页面
  // 的头几秒、以及从不翻的页面，这一步必须是零成本。
  // @returns {number} 装回了几块
  function recallTranslations(roots) {
    if (globalThis.BlockIdentity.memorySize() === 0) return 0;
    const lang = ctx.currentTargetLang();
    const hits = [];
    let scanned = 0;
    for (const root of roots.slice(0, RECALL_ROOT_BUDGET)) {
      if (!root.isConnected) continue;
      const blocks = collectPageBlocks(root, { limit: RECALL_SCAN_BUDGET - scanned });
      scanned += blocks.length;
      for (const block of blocks) {
        const entry = rememberedFor(block, lang);
        if (entry !== null) hits.push({ block, entry });
      }
      if (scanned >= RECALL_SCAN_BUDGET) break;
    }
    const chosen = restoreOrder(hits);
    for (const { block, entry } of chosen) restoreRemembered(block, entry, lang);
    return chosen.length;
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
  ctx.outsidePageScope = outsidePageScope;
  ctx.collectPageBlocks = collectPageBlocks;
  ctx.recallTranslation = recallTranslation;
  ctx.recallTranslations = recallTranslations;
  ctx.translateWholePage = translateWholePage;
})();
