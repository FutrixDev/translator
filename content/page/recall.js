// Blab Translation — 整页翻译：装回
//
// 同样的文字换了新节点，把上次的译文放回去。单页应用切路由时常把左栏整片重建：
// 文字一个字没变，节点全是新的，节点身份查不到，于是同样几行再翻一遍（内置引擎
// 不走 storage 缓存，每次都真发），翻回来之前那几行先闪一下原文。页内记忆
// （shared/block-identity.js 的 remember；唯一写入点是 insert.js 的
// insertTranslationBlock）按 (目标语言, 原文) 记着上次落笔的译文，装回拿它放回去。
//
//   - `ctx.recallTranslations(roots)`：一批新长出来的子树，在 MutationObserver 回调
//     里 —— 绘制之前 —— 同步装回。观察器归 content-auto-translate.js 管（跟着自动
//     翻译的判定活），这里不挂任何观察者；
//   - `ctx.recallTranslation(block)`：一块，发现层进带时逐块问的那一句。
//
// 落笔走 batch.js 的 landTranslation：和第一次落笔同一条插入路径，节点身份照登记
// （之后的 collect 就把它当「翻过了」跳过，不进候选、不发请求、不碰调度层的台账）、
// 隐藏译文 / 仅显示译文跟着当前状态、shadow root 里的样式照补。范围规则也照常：
// 块是 scope.js 的 collectPageBlocks 收的。
(function() {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT;
  if (!ctx) return;

  // 同步装回的硬上限：回调里每多做一点，那一帧就晚画一点。两道闸：最多看 40 个
  // 根、收 200 块（收集按 limit 提前停、逐块数，不把几千块的新子树整片走一遍）；
  // 视口外的最多装回 RESTORE 块。装回一块要走插入路径的版式读取，2000 块的文档上
  // 约 0.5 ms 一块，200 块就是 100 ms 的一帧；16 块把最坏一次压在一帧之内（性能
  // 用例在 test/e2e/auto-translate-rerender.spec.js）。
  // 和视口相交的命中不受这道预算：看得见的那几块少装一块就是闪一帧原文，正是装回
  // 要消掉的东西；一屏装得下的块数本身有限（扫描闸 200 块封顶）。菜单、标签栏这类
  // 整片重建的通常就几块到十几块，一次装完。视口外超出的留给发现层进带时逐块再问
  // （content-auto-discover.js 的 onBand），仍然不重发，只是可能闪一帧。
  const RECALL_ROOT_BUDGET = 40;
  const RECALL_SCAN_BUDGET = 200;
  const RECALL_RESTORE_BUDGET = 16;

  // 一块记得什么：命中返回那一条，没命中（或这会儿不该装）返回 null。只查，不
  // 动 DOM。语言戳用 passTarget 的 stamp：记进记忆的就是它（currentTargetLang，
  // 空串＝跟随浏览器）。
  //
  // 「这块该不该译」由两道判定把关，装回不另写一套：
  //   · 收集端那一串（范围、规则、代码、纯数字……）：块本来就是 collectPageBlocks
  //     收上来的，没过的根本到不了这里；
  //   · 跳过目标语言：那道检测在 batch.js（isTargetLanguageText，异步、要等语言
  //     检测），绘制前同步装回等不了它。所以只装落笔时已经过了这道检测的条目
  //     （targetLangChecked）；现在开着、当初没过的，返回 null 交给批量那条路，
  //     由那道检测本身来判 —— 是目标语言就不译，不是就照常请求。
  // 原文比的是 block.text：收集端 getTextWithMathPlaceholders 产出、请求体里发的
  // 就是它，落笔时记下的也是它。跳过目标语言这道检查交给 recall 先过，过了才挪
  // LRU。
  function rememberedFor(block, target) {
    return globalThis.BlockIdentity.recall(target.stamp, block.text, usableNow);
  }

  function usableNow(entry) {
    return ctx.settings.skipTargetLanguageText !== true || entry.targetLangChecked;
  }

  // 「一条都没记过」的那道闸只写这一处：绝大多数页面的头几秒、以及从不翻的页面，
  // 装回这一步必须是零成本。两个入口都先过它，发现层不另问。
  function remembersNothing() {
    return globalThis.BlockIdentity.memorySize() === 0;
  }

  // 一块：命中就装回并返回 true。
  function recallTranslation(block) {
    if (remembersNothing()) return false;
    const target = ctx.passTarget();
    const entry = rememberedFor(block, target);
    if (entry === null) return false;
    ctx.landTranslation(block, entry.translation, target);
    return true;
  }

  // 和视口相交。只用来排装回的先后，不判可见性：零尺寸的（display:none 里的、还没
  // 撑开的）不算在视口里。距离的算术是 focus-order.js 的 viewportGap；装回横向也量
  // （横向滚动的标签栏，视口外那几项排后面）。
  function intersectsViewport(element) {
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const view = { top: 0, bottom: window.innerHeight, left: 0, right: window.innerWidth };
    return ctx.viewportGap(rect, view) === 0;
  }

  // 命中比预算多时：和视口相交的全装，视口外的按 DOM 顺序补到预算为止 —— 一共装
  // max(预算, 视口内块数) 块。按 DOM 顺序直接截前 16 块的话，一个滚到底的 30 项
  // 菜单整片重建，装回的是视口外的头 16 项，看得见的那几项要等发现层进带 —— 正是
  // 这一步要消掉的那一下闪。位置先一次读完再插：插一块就让版式作废，读插交错是
  // 每块一次强制版式。命中不超过预算时全装，先后不影响这一帧画出来的东西，就不读
  // 位置。
  function restoreOrder(hits) {
    if (hits.length <= RECALL_RESTORE_BUDGET) return hits;
    const inView = hits.map((hit) => intersectsViewport(hit.block.element));
    const visible = hits.filter((_, i) => inView[i]);
    const rest = hits.filter((_, i) => !inView[i]);
    return visible.concat(rest.slice(0, Math.max(0, RECALL_RESTORE_BUDGET - visible.length)));
  }

  // 一批新长出来的子树。一条都没记过的页面在这里直接返回、不收块。
  // @returns {number} 装回了几块
  function recallTranslations(roots) {
    if (remembersNothing()) return 0;
    const target = ctx.passTarget();
    const hits = [];
    let scanned = 0;
    scan: for (const root of roots.slice(0, RECALL_ROOT_BUDGET)) {
      if (!root.isConnected) continue;
      for (const block of ctx.collectPageBlocks(root, { limit: RECALL_SCAN_BUDGET - scanned })) {
        if (scanned >= RECALL_SCAN_BUDGET) break scan;
        scanned++;
        const entry = rememberedFor(block, target);
        if (entry !== null) hits.push({ block, entry });
      }
    }
    const chosen = restoreOrder(hits);
    for (const { block, entry } of chosen) ctx.landTranslation(block, entry.translation, target);
    return chosen.length;
  }

  ctx.recallTranslation = recallTranslation;
  ctx.recallTranslations = recallTranslations;
})();
