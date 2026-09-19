// Blab Translation — 自动翻译的发现层：页面上哪些内容该被翻译，什么时候轮到它。
//
// 手动整页翻译只需要回答一次「现在页面上有什么」。自动翻译要回答的是一个持续
// 的问题：页面在动（无限滚动、单页路由、评论懒加载），而用户只在看其中一小块。
// 把两件事分开：
//
//   **变动** —— MutationObserver 告诉我们「这棵子树变了」。变动是突发的：一次
//   插入十条推文会派发几十条记录，逐条去收集是在同一棵子树上做几十遍无用功。
//   所以攒 400ms 再一起收，攒的是**子树根**而不是记录。
//
//   **可见** —— IntersectionObserver 告诉我们「这块进入视野附近了」。上下各一屏
//   （rootMargin 100%）：用户滚到时译文已经在那儿，而不是滚到了才开始转圈。一篇
//   五千段的长文里，永远没滚到的部分一分钱都不该花。
//
// 两个观察器串起来就是：变动 → 收集候选 → 挂到可见观察器上 → 进带 → 交给调度层。
//
// **进带时重新收集一遍。** 从发现到进入视野可能隔了很久，那期间文字可能已经换
// 了（虚拟列表把节点回收去装别的内容）。缓存发现那一刻的 block.text 就会拿旧文
// 去翻新内容。重收一次不贵：collectTranslatableBlocks 对任意元素都能当根跑
// （processElement 自己重新查所有祖先条件），而这里的根只是一个块。
//
// 这一层不判断该不该翻、不发请求、不碰状态机 —— 那些都是
// content/content-auto-translate.js 的事。它只回答「轮到谁了」。
(function () {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT;
  if (!ctx) return;

  // 攒变动的窗口。太短则一次列表插入要收集好几遍，太长则用户能看见「先出原文
  // 再出译文」的延迟。400ms 约等于一次滚动惯性停下来的时间。
  const DEBOUNCE_MS = 400;
  // 脏根攒到这么多就不再逐棵收了，直接收整个 body。一次改动整页的重排（换主题、
  // 切换列表视图）会产生成百上千条记录，逐棵子树收集比全收一遍还慢。
  const MAX_DIRTY_ROOTS = 40;
  // IntersectionObserver 持强引用，挂上去的元素不会被回收。无限滚动的页面能滚
  // 出几万个块，全挂着就是一条永不释放的引用链。所以同时观察的块有个上限 ——
  // **观察的永远是离视口最近的那一批，其余的记在一边等**。
  //
  // 两条都是踩出来的：
  //
  //   · 淘汰次序不能按「挂上的先后」。首次全量扫一篇上万块的长文时，所有元素在
  //     同一个任务里挂上去，最早的那几千个正是文档开头、用户此刻正看着的那一屏。
  //   · 淘汰不能是**丢弃**。被摘掉的块没有任何变动会把它们送回来，读者滚到那里
  //     时看到的是一片原文，而且再也不会变。所以摘下来的进 deferred，位置让出来
  //     时按远近重新挑一批观察。
  const MAX_OBSERVED = 2000;
  // 让出的位置攒够这么多才重排。重排要把所有候选量一遍几何，攒着做才摊得薄。
  const REBALANCE_SLACK = 200;
  // 重排等一等再做。IntersectionObserver 的回调要到这一帧的渲染步骤才派发，同步
  // 重排是在「谁在视口里」这个问题还没有答案的时候就动手。等过这一个窗口，进带的
  // 都已经被摘走了（见 onBand 的「进带即摘」），剩下的才真是带外的。
  const REBALANCE_DELAY_MS = DEBOUNCE_MS;
  // 上下各一屏。
  const BAND_MARGIN = '100% 0px';
  // capture: 内层滚动容器（侧栏、虚拟列表）的 scroll 不冒泡，捕获才收得到。
  const SCROLL_LISTENER = Object.freeze({ passive: true, capture: true });

  // 我们自己的界面。译文块、悬浮球、进度条、各种弹层改自己的 DOM 是常态
  // （进度条每译完一块就改一次文字），把这些当成「页面变了」会变成一个自激循环。
  //
  // 刻意不含 `.ai-translator-text-run` —— 那个 class 挂在**页面自己的**文字外面
  // （collect 把块里的直属文本节点裹起来好逐段替换）。把它算作我们的，页面之后
  // 真改了那段文字就再也看不见了。代价是每轮翻译后会多收集一遍（裹文本节点本身
  // 是一次 DOM 变动），而那一遍收不到任何新候选：已翻的被同一性守卫挡掉，翻过
  // 的被调度层的台账挡掉。多一次扫描，不会循环。
  const OWN_UI_SELECTOR = [
    '.ai-translator-popup',
    '.ai-translator-inline-block',
    '.ai-translator-hover-translation',
    '#ai-translator-progress',
    '#ai-translator-float-ball-container',
    '#ai-translator-float-menu',
    '#ai-translator-input-dialog',
    '#ai-translator-selection-btn',
    '#ai-translator-caption-overlay'
  ].join(', ');

  function ownNode(node) {
    if (!node) return false;
    const element = node.nodeType === Node.ELEMENT_NODE
      ? node
      : (node.nodeType === Node.TEXT_NODE ? node.parentElement : null);
    if (!element || typeof element.closest !== 'function') return false;
    return !!element.closest(OWN_UI_SELECTOR);
  }

  // 一条变动记录是不是我们自己弄出来的。
  //
  // 两种形态要分开看：改自己面板内部（target 就在我们的子树里），和往页面里插
  // 译文（target 是**页面的**元素，只有 addedNodes 是我们的）。后者是每插一条
  // 译文都会发生的事，漏掉它，翻译本身就会把自己再触发一遍。
  function ownMutation(record) {
    if (ownNode(record.target)) return true;
    if (record.type !== 'childList') return false;
    const { addedNodes, removedNodes } = record;
    if (addedNodes.length === 0 && removedNodes.length === 0) return false;
    for (const node of addedNodes) if (!ownNode(node)) return false;
    // 移除的节点已经脱离文档，closest 走的是它自己那棵脱落的子树 —— 我们的译文
    // 块能认出自己；页面的文本节点 parentElement 是 null，认不出，于是算真变动。
    for (const node of removedNodes) if (!ownNode(node)) return false;
    return true;
  }

  function mutationRoot(record) {
    const target = record.target;
    if (!target) return null;
    if (target.nodeType === Node.ELEMENT_NODE) return target;
    return target.parentElement || null;
  }

  /**
   * 启动发现层。
   *
   * @param {Object} options
   * @param {(blocks: Array) => void} options.onCandidates 进入视野附近的块，按进带顺序
   * @returns {{stop: Function, rescan: Function, suspend: Function, resume: Function}}
   */
  function setupAutoDiscovery({ onCandidates } = {}) {
    if (typeof onCandidates !== 'function') {
      throw new TypeError('setupAutoDiscovery needs onCandidates');
    }

    const dirtyRoots = new Set();
    // 正在观察的。
    const observed = new Set();
    // 认得、但没位置观察的。它们不会丢，只是在等一个位置。
    const deferred = new Set();
    let collapsed = false;
    let timer = null;
    let rebalanceTimer = null;
    // 各个滚动容器上一次「跨过一屏」时停在哪儿。页面本身的滚动记在 document 名下。
    // WeakMap：容器是页面自己的节点，页面把它删掉之后这里不该拦着不放。
    let scrollMarks = new WeakMap();
    let suspended = false;
    let stopped = false;

    const bandObserver = new IntersectionObserver(onBand, { rootMargin: BAND_MARGIN });
    const domObserver = new MutationObserver(onMutations);

    function onMutations(records) {
      if (stopped) return;
      let dirty = false;
      for (const record of records) {
        if (ownMutation(record)) continue;
        const root = mutationRoot(record);
        if (!root) continue;
        dirty = true;
        if (collapsed) continue;
        dirtyRoots.add(root);
        if (dirtyRoots.size > MAX_DIRTY_ROOTS) {
          collapsed = true;
          dirtyRoots.clear();
        }
      }
      if (dirty) schedule();
    }

    function schedule() {
      if (stopped || suspended || timer !== null) return;
      timer = setTimeout(flush, DEBOUNCE_MS);
    }

    function flush() {
      timer = null;
      if (stopped || suspended) return;

      const roots = collapsed ? [document.body] : [...dirtyRoots];
      dirtyRoots.clear();
      collapsed = false;
      if (roots.length === 0) return;

      // 脏根之间可能互相嵌套（父子都变了），同一个块会被收到两次。按元素去重，
      // 不按根去重：判断两个根是否嵌套要 contains()，比直接收完再去重还贵。
      const seen = new Set();
      for (const root of roots) {
        if (!root || !root.isConnected) continue;
        for (const block of collect(root)) {
          const element = block.element;
          if (!element || seen.has(element)) continue;
          seen.add(element);
          watch(element);
        }
      }
    }

    function collect(root) {
      try {
        return ctx.collectTranslatableBlocks(root) || [];
      } catch (error) {
        console.warn('Blab Translation: auto discovery collect failed', error);
        return [];
      }
    }

    function watch(element) {
      if (observed.has(element) || deferred.has(element)) return;
      // 满了就先记着。进来的顺序是文档顺序，所以首次全量扫时留下的正是开头那
      // 一批；读者要是从锚点跳进文档中段，接下来那次重排会按远近把位置换给他
      // 眼前的那些。
      if (observed.size >= MAX_OBSERVED) {
        deferred.add(element);
        scheduleRebalance();
        return;
      }
      observed.add(element);
      bandObserver.observe(element);
    }

    function unwatch(element) {
      observed.delete(element);
      bandObserver.unobserve(element);
      // 进带即摘会腾出位置。攒够一批再把 deferred 里离视口最近的换上来。
      if (deferred.size > 0 && observed.size + REBALANCE_SLACK <= MAX_OBSERVED) scheduleRebalance();
    }

    function scheduleRebalance() {
      if (stopped || rebalanceTimer !== null) return;
      rebalanceTimer = setTimeout(rebalance, REBALANCE_DELAY_MS);
    }

    // 读者一跃跳到文档另一头（锚点、「回到顶部」）时，中间那些块一个都没进带，
    // 没有位置让出来，重排也就不会被触发 —— 而他眼前的那一屏可能整片都在
    // deferred 里。这个监听补的就是这一跳。
    //
    // 只认「跳」，不认「滚」：一屏之内的滚动本来就会让块进带、把位置让出来，
    // 那条路已经会排重排了。不加这道门的话，长文里每一次连续滚动都要多量一遍
    // 全体候选的几何 —— 白做，而且正好做在读者滚得最快的时候。
    //
    // **量的是真正在滚的那个东西，不是 window。** 候选常常长在一个内部滚动容器里
    // （侧栏、面板、自己滚的信息流）：滚它一样会派发到这个捕获监听上，但
    // `window.scrollY` 一动不动，于是这道门永远关着。那种页面上超出观察上限的那
    // 一截就此卡在 deferred 里 —— 留下的块没有一个会进带，也就没有别的路会排重排。
    //
    // 门槛取这个容器自己的一屏高。记号在跨过门槛时才更新，所以连续滚动最多每滚过
    // 一屏排一次重排，和页面滚动那条路是同一个节奏。
    function scrollTargetOf(event) {
      const target = event && event.target;
      // 页面滚动的 target 是 document，有的浏览器给 documentElement —— 归一成前者，
      // 否则同一次滚动会在两个键下各记一份记号，两份都到不了门槛。
      if (!target || target === window || target === document) return document;
      if (target === document.scrollingElement || target === document.documentElement) return document;
      if (target.nodeType !== 1) return document;
      return target;
    }

    function scrollOffsetOf(target) {
      return target === document ? window.scrollY : target.scrollTop;
    }

    function scrollSpanOf(target) {
      if (target === document) return window.innerHeight || document.documentElement.clientHeight || 0;
      return target.clientHeight || 0;
    }

    function onScroll(event) {
      if (deferred.size === 0) return;
      const target = scrollTargetOf(event);
      const span = scrollSpanOf(target);
      // 一屏都量不出来（藏着的、折叠的容器），没有「跳」可言。
      if (span <= 0) return;
      const now = scrollOffsetOf(target);
      // 没见过的容器按「停在 0」算，和页面滚动那条路一样（容器本来就从 0 开始）。
      // 不能改成「第一次先记下、这一次不算」：一次跳转只派发一个 scroll 事件，
      // 那一次正好就是第一次 —— 门就永远等不到第二次来开。
      const mark = scrollMarks.get(target) || 0;
      if (Math.abs(now - mark) < span) return;
      scrollMarks.set(target, now);
      scheduleRebalance();
    }

    // 元素在视口之外多远。带内一律算 0。
    //
    // 没有布局盒子的（display:none 的折叠面板、还没打开的 tab 面板）排在最后。
    // 它们的 rect 全是 0，照上面那几条算出来是 -0 —— 和一块**正在视口里**的
    // 内容同一档。排序是稳定的，于是文档里靠前的那两千个隐藏块会把 observed
    // 的名额占满不放，真正在看的正文一直待在 deferred 里，连进带的机会都没有。
    //
    // 排到最后而不是直接剔除：它们迟早会被展开，而 MutationObserver 只看
    // childList/characterData，展开是一次属性变动，它看不见 —— 那时候唯一能把
    // 这一块捞回来的就是还挂在它身上的 IntersectionObserver。
    function distanceFromViewport(element) {
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return Infinity;
      const height = window.innerHeight || document.documentElement.clientHeight || 0;
      if (rect.top >= height) return rect.top - height;
      if (rect.bottom <= 0) return -rect.bottom;
      return 0;
    }

    function drop(set, element) {
      set.delete(element);
      if (set === observed) bandObserver.unobserve(element);
    }

    function rebalance() {
      rebalanceTimer = null;
      if (stopped) return;

      // 离开文档的直接扔 —— 观察器的强引用真正会漏的就是这一部分。
      for (const element of [...observed]) if (!element.isConnected) drop(observed, element);
      for (const element of [...deferred]) if (!element.isConnected) drop(deferred, element);
      if (deferred.size === 0 && observed.size <= MAX_OBSERVED) return;

      // getBoundingClientRect 一趟下来只强制一次重排，之后都是读缓存。只有块数
      // 超过上限的页面才走到这里，而且一个窗口最多一次、一次至少换进一批。
      const ranked = [];
      for (const element of observed) ranked.push({ element, away: distanceFromViewport(element), on: true });
      for (const element of deferred) ranked.push({ element, away: distanceFromViewport(element), on: false });
      // 相等先判掉：两个都没布局的块 away 都是 Infinity，相减是 NaN，而返回
      // NaN 的比较函数排出来的顺序是没有定义的。
      ranked.sort((a, b) => (a.away === b.away ? 0 : a.away - b.away));

      for (let i = 0; i < ranked.length; i++) {
        const keep = i < MAX_OBSERVED;
        const entry = ranked[i];
        if (keep === entry.on) continue;
        if (keep) {
          deferred.delete(entry.element);
          observed.add(entry.element);
          bandObserver.observe(entry.element);
        } else {
          observed.delete(entry.element);
          bandObserver.unobserve(entry.element);
          deferred.add(entry.element);
        }
      }
    }

    function onBand(entries) {
      if (stopped) return;
      const arrived = [];
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const element = entry.target;
        // 进带即摘：这一块的去留从此归调度层管，留着只会在滚动时反复回调。
        unwatch(element);
        if (element.isConnected) arrived.push(element);
      }
      if (arrived.length === 0) return;

      const blocks = [];
      const seen = new Set();
      for (const element of arrived) {
        for (const block of collect(element)) {
          if (!block.element || seen.has(block.element)) continue;
          seen.add(block.element);
          blocks.push(block);
        }
      }
      if (blocks.length > 0) onCandidates(blocks);
    }

    /** 立刻全页收一遍，不等防抖 —— 开页时的第一次和路由切换后都用它。 */
    function rescan() {
      if (stopped) return;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      collapsed = true;
      const wasSuspended = suspended;
      suspended = false;
      flush();
      suspended = wasSuspended;
    }

    /**
     * 暂停派发，但**不丢记录**：脏根继续攒，恢复后一起收。
     *
     * 设计文档原本写的是挂起期间丢弃记录（「这些是我们自己弄出来的」）。实际做
     * 不到：一轮插入要跑好几秒，这期间页面自己加载出来的评论也会被一并丢掉；
     * 而且 MutationObserver 是微任务派发，同步地 suspend/insert/resume 根本跨不
     * 到记录到达的那一刻。改成推迟：我们自己的插入本来就被 ownMutation 挡掉了，
     * 剩下的多收一遍也只是一次扫描。
     */
    function suspend() {
      suspended = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    }

    function resume() {
      if (!suspended) return;
      suspended = false;
      if (dirtyRoots.size > 0 || collapsed) schedule();
    }

    function stop() {
      if (stopped) return;
      stopped = true;
      domObserver.disconnect();
      bandObserver.disconnect();
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (rebalanceTimer !== null) {
        clearTimeout(rebalanceTimer);
        rebalanceTimer = null;
      }
      window.removeEventListener('scroll', onScroll, SCROLL_LISTENER);
      scrollMarks = new WeakMap();
      dirtyRoots.clear();
      observed.clear();
      deferred.clear();
    }

    window.addEventListener('scroll', onScroll, SCROLL_LISTENER);

    domObserver.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });

    return { stop, rescan, suspend, resume };
  }

  ctx.setupAutoDiscovery = setupAutoDiscovery;
})();
