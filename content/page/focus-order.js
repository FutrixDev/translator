// Blab Translation — 整页翻译：先翻哪一块（焦点优先，设计 §3）
//
// 拉取器 createBatchFeeder 在每一次拉取那一刻按视口、滚动方向、焦点、指针排剩下
// 的块，装出下一批；drainFeeder 是拉取式并发池，空出一个位就拉一次。手动那一轮
// （content/page/batch.js 的 runTranslationPass）和自动调度层每轮挑块
// （content/content-auto-translate.js 的 takeBatch）用的都是这一个拉取器。
//
// 装批也在这里：拉取器按调用方给的形状装下一批，一段占多少 token 由这里的
// estimateTokens 估（整页翻译的 token 估算只此一份）。
//
// 视口信号（viewSignals）是模块级的：加载时挂上 scroll / pointermove / resize 监听，
// 另由 runTranslationPass 在每批译文交付后取样一次（sampleView）。
// 只认 ctx.focusOrder 这一个出口；批的形状（每批几段、字数与 token 上限）和引擎
// 知识归调用方。
(function() {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT;
  if (!ctx) return;

  // ------------------------------------------------ 焦点优先（设计 §3）
  //
  // 先翻哪一块是拉取那一刻现算的，不是开跑时排一次就定死：用户在一轮中途滚到
  // 哪儿、点进哪一段，下一批就先翻那儿。已经发出去的请求不取消（没有取消接口，
  // 取消了钱也照花），重排只管下一次拉取。

  // 近档（设计 §3.1 的 near）：离视口不超过这么多屏。一批只装同一档的块 —— 近处
  // 那批不被远处的块凑满，首屏的请求小、回得快。
  const NEAR_SCREENS = 1.2;
  // 「输入框旁」的段落：焦点在可编辑元素上、又不在任何块里时，纵向离它不超过这么
  // 多屏的最近一块算焦点块（设计 §3.1，D-551）。
  const BESIDE_SCREENS = 0.5;
  const FORM_CONTROL_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);
  // 块多到这个数时，一次排序连用 RESORT_EVERY 次拉取（设计 §3.2：内置引擎一块
  // 一批，每拉一次就全量排序是 O(n² log n)）。
  const RESORT_ABOVE = 4000;
  const RESORT_EVERY = 8;
  // 一段在批量请求里的分隔与编号开销（token）。
  const ITEM_TOKEN_OVERHEAD = 6;

  function estimateTokens(text) {
    if (!text) return 0;
    const cjkMatches = text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu);
    const cjkCount = cjkMatches ? cjkMatches.length : 0;
    const nonCjkCount = Math.max(0, text.length - cjkCount);
    return Math.ceil(cjkCount * 1.1 + nonCjkCount / 4);
  }

  // 评分要的页面信号：滚动方向、指针视口纵坐标、读者移动代次，passive、只记数。
  // 读者滚动、resize 让几何作废（moveEpoch，D-553）；翻译自己插译文不作废，仍按
  // 开跑那一屏排。视口上方插译文时滚动锚定把 scrollY 同向挪、不超过页面长高的量：
  // 不是读者在滚，不改方向、不作废，记进 anchorShift，评分把视口挪回量时的坐标系。
  const viewSignals = { scrollDir: 0, lastScrollY: 0, lastScrollHeight: 0, pointerClientY: null, moveEpoch: 0, anchorShift: 0 };

  // 从上次取样到此刻 scrollY、scrollHeight 各变了多少，归给锚定或读者。两处取样：
  // scroll 事件，和每批译文交付之后（sampleView 由 runTranslationPass 的
  // flushProgress 调）。只在 scroll 里取样的话，插在视口及下方的译文让页面变高却
  // 不发 scroll，dh 就是读者上次滚动以来的全部增高，读者一次不超过它的跳转（目录
  // 锚点、页内查找、End 键）会被当成锚定，不作废（D-554 T1）。先读 scrollHeight：
  // 它强制布局，锚定对 scrollY 的修正在布局里做完，随后读到的 scrollY 已经含它。
  function sampleView() {
    const height = document.documentElement.scrollHeight;
    const y = window.scrollY;
    const dy = y - viewSignals.lastScrollY;
    const dh = height - viewSignals.lastScrollHeight;
    const anchored = dy !== 0 && Math.sign(dy) === Math.sign(dh) && Math.abs(dy) <= Math.abs(dh);
    if (anchored) viewSignals.anchorShift += dy;
    else if (dy !== 0) {
      viewSignals.scrollDir = Math.sign(dy);
      viewSignals.moveEpoch += 1;
    }
    viewSignals.lastScrollY = y;
    viewSignals.lastScrollHeight = height;
  }

  function installViewSignals() {
    viewSignals.lastScrollY = window.scrollY;
    viewSignals.lastScrollHeight = document.documentElement.scrollHeight;
    window.addEventListener('scroll', sampleView, { passive: true });
    // 存视口坐标，读的时候再加上那一刻的 scrollY：指针不动、页面滚了，它指着的
    // 文档位置跟着变。
    window.addEventListener('pointermove', (event) => {
      viewSignals.pointerClientY = event.clientY;
    }, { passive: true });
    window.addEventListener('resize', () => {
      viewSignals.moveEpoch += 1;
    }, { passive: true });
  }

  // 此刻的视口，减去量几何之后的锚定位移。focusBlock 由拉取器按 findFocusBlock 填。
  function readView(shift) {
    const scrollY = window.scrollY - shift;
    return {
      scrollY,
      height: window.innerHeight,
      scrollDir: viewSignals.scrollDir,
      pointerDocY: viewSignals.pointerClientY === null ? null : viewSignals.pointerClientY + scrollY,
      focusBlock: null
    };
  }

  // 有没有布局盒：display:none、已经摘下的元素 rect 全 0。
  function hasLayoutBox(rect) {
    return rect.width !== 0 || rect.height !== 0;
  }

  // 两段纵向区间 { top, bottom } 之间的空隙，相交为 0。
  function intervalGap(a, b) {
    return Math.max(0, a.top - b.bottom, b.top - a.bottom);
  }

  // 块的文档纵向区间。没有布局盒的记 hidden。
  function measureBlock(block, scrollY) {
    const rect = block.element.getBoundingClientRect();
    if (!hasLayoutBox(rect)) return { hidden: true, top: 0, bottom: 0 };
    return { hidden: false, top: rect.top + scrollY, bottom: rect.bottom + scrollY };
  }

  // 块离视口几屏（相交为 0），在视口下方还是上方。
  function viewportGap(box, view) {
    const viewport = { top: view.scrollY, bottom: view.scrollY + view.height };
    return { screens: intervalGap(box, viewport) / view.height, below: box.top >= viewport.bottom };
  }

  function isFormControl(element) {
    return !!element && (FORM_CONTROL_TAGS.has(element.tagName) || element.isContentEditable === true);
  }

  /**
   * 焦点块（设计 §3.1，D-551），至多一个：
   *   1. activeElement（不是 body/html）或选区锚点落在某块里 → 那一块；
   *   2. 否则 activeElement 是表单控件/可编辑元素时，纵向离它最近、且不超过
   *      BESIDE_SCREENS 屏的候选块（「输入框旁」）；同距取文档序靠前的。
   * elementBlock 是元素 → 块；candidates 是还没发出去的块（文档顺序），boxes 是它们的几何。
   */
  function findFocusBlock(elementBlock, candidates, boxes, view) {
    const active = document.activeElement;
    const activeOnPage = active && active !== document.body && active !== document.documentElement ? active : null;
    const selection = document.getSelection();
    for (const start of [activeOnPage, selection && selection.anchorNode]) {
      for (let node = start; node; node = node.parentNode) {
        const block = elementBlock.get(node);
        if (block) return block;
      }
    }
    if (!isFormControl(activeOnPage)) return null;
    const rect = activeOnPage.getBoundingClientRect();
    if (!hasLayoutBox(rect)) return null;
    const control = { top: rect.top + view.scrollY, bottom: rect.bottom + view.scrollY };
    let best = null;
    let bestGap = BESIDE_SCREENS * view.height;
    for (const block of candidates) {
      const box = boxes.get(block);
      if (box.hidden) continue;
      const gap = intervalGap(box, control);
      if (best === null ? gap <= bestGap : gap < bestGap) {
        best = block;
        bestGap = gap;
      }
    }
    return best;
  }

  // 档位（设计 §3.1/§3.2）：焦点块、近档（离视口不超过 NEAR_SCREENS 屏）、远档、
  // 没有布局盒。先判没有布局盒：焦点落在一个没有布局盒的块里，它也排最后。
  const TIER = Object.freeze({ FOCUS: 0, NEAR: 1, FAR: 2, HIDDEN: 3 });

  function tierOf(block, box, view) {
    if (box.hidden) return TIER.HIDDEN;
    if (block === view.focusBlock) return TIER.FOCUS;
    return viewportGap(box, view).screens <= NEAR_SCREENS ? TIER.NEAR : TIER.FAR;
  }

  // 一批只装同一档：焦点块和近档同属一档 —— 焦点块钉在第一批，第一批就是视口
  // 那一档，而不是它所在的远处那一档（设计 §3.2）。
  function isNear(block, box, view) {
    return tierOf(block, box, view) <= TIER.NEAR;
  }

  /**
   * 设计 §3.1 的评分，近档内的次序，越小越先翻：
   *
   *   离视口的屏数 × 方向（朝滚动方向 0.8，背向 1.2）− 指针同屏 0.5。
   *
   * 手动那一轮和自动调度层每轮挑块都经 createBatchFeeder 用它；发现层
   * （content/content-auto-discover.js）的排序另有 distanceFromViewport，归批 C。
   * box 是 measureBlock 量出的区间，view 是 readView 的快照。
   */
  function scoreBlockForViewport(box, view) {
    const { screens, below } = viewportGap(box, view);
    const towards = below ? view.scrollDir >= 0 : view.scrollDir < 0;
    let score = screens * (towards ? 0.8 : 1.2);
    if (view.pointerDocY !== null && Math.abs(box.top - view.pointerDocY) < view.height) score -= 0.5;
    return score;
  }

  /**
   * 拉取器（设计 §3.2）。每次 next() 按此刻的视口排剩下的块，从最先的那块起装
   * 一批：shape 是 { perBatch, maxChars, maxTokens }，由调用方按引擎给（数值见
   * ctx.pagePass.batchShape，batch.js）；超大块单独成批（processOversizedBlock 再切）；档位
   * （isNear）和这一批第一块不同的跳过、留给下一拉，不截断这一批（D-551）。批内按
   * 文档顺序，给 neighbourContext 取前后文。
   *
   * 次序是 [档位, 近档的 §3.1 评分, 文档顺序] 逐项比较：焦点块第一，近档按分，
   * 远档按文档顺序（设计 §3.1：远档按分排会从视口往两头交替外扩，Blink 每帧
   * PrePaint/Paint 翻倍，D-553），没有布局盒的最后。几何开跑时量
   * 一次，读者滚动或 resize 后下一次重排前重量剩下的块；锚定位移只挪视口不重量。
   * 块多于 RESORT_ABOVE 时每 RESORT_EVERY 次拉取重排一次；焦点块换了随时重排。
   * 没有剩下的块时返回 null。
   */
  function createBatchFeeder(blocks, { perBatch, maxChars, maxTokens }) {
    const docIndex = new Map(blocks.map((block, index) => [block, index]));
    const elementBlock = new Map(blocks.map((block) => [block.element, block]));
    const remaining = new Set(blocks);
    let boxes = null;
    let measuredEpoch = -1;
    let measuredShift = 0;
    let order = null;
    let orderedFocus = null;
    let pullsSinceSort = 0;

    const measure = () => {
      // 量之前先取样：开跑前页面自己长高（没有 scroll）也不会被记到读者头上。
      sampleView();
      boxes = new Map();
      for (const block of remaining) boxes.set(block, measureBlock(block, window.scrollY));
      measuredEpoch = viewSignals.moveEpoch;
      measuredShift = viewSignals.anchorShift;
    };

    const rank = (view) => {
      const keyed = [...remaining].map((block) => {
        const box = boxes.get(block);
        const tier = tierOf(block, box, view);
        return [tier, tier === TIER.NEAR ? scoreBlockForViewport(box, view) : 0, docIndex.get(block), block];
      });
      keyed.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2]));
      order = keyed.map((entry) => entry[3]);
      orderedFocus = view.focusBlock;
      pullsSinceSort = 0;
    };

    function next() {
      if (remaining.size === 0) return null;
      const resortDue = !order || remaining.size <= RESORT_ABOVE || pullsSinceSort >= RESORT_EVERY;
      if (!boxes || (resortDue && measuredEpoch !== viewSignals.moveEpoch)) measure();
      const view = readView(viewSignals.anchorShift - measuredShift);
      const focus = findFocusBlock(elementBlock, remaining, boxes, view);
      view.focusBlock = focus && remaining.has(focus) ? focus : null;
      if (resortDue || view.focusBlock !== orderedFocus) rank(view);
      pullsSinceSort += 1;

      const batch = [];
      let chars = 0;
      let tokens = 0;
      let near = false;
      for (const block of order) {
        if (!remaining.has(block)) continue;
        if (block.oversized) {
          if (batch.length === 0) batch.push(block);
          break;
        }
        if (batch.length >= perBatch) break;
        const blockNear = isNear(block, boxes.get(block), view);
        if (batch.length > 0 && blockNear !== near) continue;
        const textLen = block.text.length;
        const tokenEstimate = estimateTokens(block.text) + ITEM_TOKEN_OVERHEAD;
        if (batch.length > 0 && (chars + textLen > maxChars || tokens + tokenEstimate > maxTokens)) break;
        if (batch.length === 0) near = blockNear;
        batch.push(block);
        chars += textLen;
        tokens += tokenEstimate;
      }
      for (const block of batch) remaining.delete(block);
      return batch.sort((a, b) => docIndex.get(a) - docIndex.get(b));
    }

    return { next };
  }

  // 拉取式并发池，页面翻译唯一的一个：空出一个并发位就 feeder.next() 拉下一项
  // 交给 processor，拉到假值收工，stopped() 为真就不再拉。拉取器给的是一批块，
  // 评分发生在拉取那一刻；batch.js 的语言预检给的是 { block, index }。
  //
  // 拉取或处理抛错：第一个错误一出，所有并发位都不再拉下一项（手上那一项照常收
  // 完），全部收场之后把这第一个错误抛出去。只停抛错的那一位的话，其余几位会接着
  // 拉、接着发请求，把整队拉完才报错。
  async function drainFeeder(feeder, processor, { concurrency, stopped = () => false }) {
    let failed = false;
    let firstError = null;
    const worker = async () => {
      while (!failed && !stopped()) {
        try {
          const item = feeder.next();
          if (!item) return;
          await processor(item);
        } catch (error) {
          if (!failed) {
            failed = true;
            firstError = error;
          }
          return;
        }
      }
    };
    await Promise.allSettled(Array.from({ length: concurrency }, worker));
    if (failed) throw firstError;
  }

  ctx.focusOrder = Object.freeze({ createBatchFeeder, drainFeeder, sampleView });

  // 视口信号在模块加载时就开始记（D-551 第 4 项）：第一轮开跑前的滚动方向、指针
  // 位置也要算数。
  installViewSignals();
})();
