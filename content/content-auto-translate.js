// Blab Translation — 自动翻译的调度层：决定这一页翻不翻，然后把发现层送来的块
// 一轮一轮译掉。
//
// 三件事，缺一不可：
//
//   **判**  这一页该不该自己动手 —— 全交给 shared/site-rules.js 的 decide()。
//           这里只负责把事实（域名、路径、用户规则、用户是否已经表过态）凑齐了
//           递进去，一问就是终局：auto 或 off。不量页面语言 —— 谁都没替它说过
//           话的站点不翻也不问（D-351），语言不再改变任何结论。
//
//   **译**  攒一批块，调 ctx.runTranslationPass。它是手动整页翻译用的同一个函数
//           （PR-1 把进度条和「整页翻过了」那类状态搬出去之后，它就只剩翻译本身
//           了），所以这里不需要一套平行的翻译流水线。
//
//   **弃**  发出去的请求回来时，页面可能已经不是当初那一页了。每个块发请求前盖
//           一个章（shared/session-guard.js），写回前验一次。**不取消请求** ——
//           钱已经花了，取消也拿不回来；能做干净的只有「不写上去」。
//
// 它不画任何东西。状态条、状态点、悬浮球的样子都是 content/content-auto-status.js
// 的事，这一层只把 state() 摆在那里给它们读，再用 onStateChange() 在变了的时候
// 喊一声 —— 呈现层不轮询，见下面 setStatus() 的注释。
(function () {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT;
  if (!ctx) return;

  // 候选攒够这么久才开一轮。滚动时块是一个一个进带的，不攒就会变成一块一请求。
  const START_DEBOUNCE_MS = 250;
  // 手动整页翻译正在跑时的重试间隔。
  const MANUAL_RETRY_MS = 500;
  const STATUS = Object.freeze({
    OFF: 'off',         // 判过了，这一页不自动翻
    IDLE: 'idle',       // 开着，没有待译的块
    RUNNING: 'running', // 一轮正在跑
    PAUSED: 'paused',   // 用户在这一页喊停了
    ERROR: 'error'      // 一轮整体失败，这一页不再重试
  });

  // 两个**不属于 decide()** 的停翻理由（PRD FR-9 的费用闸）。
  //
  // 有意不放进 shared/site-rules.js 的 REASONS：decide() 回答的是「这个站点、
  // 这门语言，该不该自动翻」，它永远不会返回这两个。混进去只会让那张表变成一句
  // 假话 —— 那里的每一个 key 都对应阶梯上的一级，这两个对应的是阶梯之外的一道
  // 闸。呈现层照样认得它们：shared/auto-reason-keys.js 是「理由 → 人话」的
  // 那张表，它比 decide() 的阶梯宽一点。
  const COST_REASONS = Object.freeze({
    // 自动模式要用的引擎这一刻给不出译文，而用户没开回退：选的是「仅本地」，
    // 而这一页（http://、Chrome 版本太低）没有内置引擎。默认状态，所以不弹提示
    // —— 它是设定，不是意外。
    ENGINE: 'COST_ENGINE',
    // 今天的字符预算用完了。这一条要提示一次：用户上午还好好的，下午打开一个
    // 页面它不翻了，不说一声就只是「坏了」。
    BUDGET: 'COST_BUDGET'
  });

  function setupAutoTranslate() {
    if (!document.body) return null;

    const guard = globalThis.SessionGuard.create({
      readText: (element) => ctx.readSourceText(element),
      fingerprint: (text) => globalThis.BlockIdentity.fingerprint(text)
    });

    // 待译队列：元素 -> { block, source }。Map 而不是数组：同一个块可能被发现层
    // 送来两次（父子子树都变过），按元素去重，而插入顺序正好是进带顺序 ——
    // 用户先看到的先译。
    //
    // source 是**排队那一刻页面上原样文字**的指纹，用来在开跑前认出「这个节点已经
    // 被回收去装别的内容了」。不能拿 block.text 去比：那是「送去翻译的文本」，
    // 带公式占位符、内联标记，而且 trim 过（content/page/collect.js 的
    // getTextWithMathPlaceholders），和 readSourceText 读出来的根本不是一个表示法。
    const queue = new Map();
    // 本轮在途请求的章。一轮之内才有意义，下一轮重新盖。
    const tickets = new Map();
    // 已经**有结果**的块：`代次内编号:文本指纹`。发现层每次扫描都会把没翻成的块
    // （已经是中文的、判定跳过的）原样再送一遍，没有这本台账就会一遍遍重新发请求。
    // 代次一翻篇就整本作废 —— 换了目标语言之后，同样的文字要重新翻。
    const ledger = new Set();
    // 这一轮正在路上的块 → 它在台账里的那个 key。**记账要等结果**：批次失败一两次
    // 时这一轮不报错（content/page/batch.js 的 MAX_BATCH_FAILURES 是 3），可那几块
    // 一个字都没翻。先记账的话它们就此永远被当成翻过了 —— 发现层下一轮送回来，
    // takeBatch 一看台账，跳过，页面上那一片永远是原文，而且没有任何报错。
    const inflight = new Map();
    // 已经给过第二次机会的 key。失败不记台账（见上），可也不能无限重来：一个在
    // 某几块上稳定失败的接口，批次失败数够不上 MAX_BATCH_FAILURES，这一轮就不
    // 报错 —— 于是那几块被放回队列、再失败、再放回，成了一个每 250ms 一次的
    // 死循环。所以每一块只给一次重来，再失败就记进台账：这一页对它无能为力。
    const retried = new Set();

    let discovery = null;
    let status = STATUS.OFF;
    let reason = '';
    let lastError = null;
    // 用户在这一页已经表过态（点过「翻译整页」）。换路由就忘掉。
    let explicit = false;
    // 这一代是替哪个地址判的。start() 一进来就记，superseded() 发请求前拿它对。
    let decidedHref = '';
    // 「这一页先别翻了」—— popup 上按的暂停，或者把译文藏起来（两条都走
    // pauseCurrentPage）。
    //
    // 必须记成一道闩，不能只把状态改成 PAUSED：状态会被下一次 start() 覆盖，而
    // start() 是别人替他叫的 —— 另一个标签页在 popup 上点了「总是」，siteRules
    // 一落地，这一页的 onSettingsChanged 就重开一轮，他按下的暂停当场失效，页面
    // 自己又翻起来了。闩只有他自己解得开（继续 / 翻译整页），或者换一个文档。
    let pausedByUser = false;
    let startTimer = null;
    let running = false;
    // 一轮整体失败就不再自动重试。runTranslationPass 返回错误本身已经意味着它
    // 内部连续失败了三次 —— 到这一步再重试，是在一个明显坏掉的接口上继续烧钱。
    let broken = false;
    // 这一页上「给过机会还是没翻成」的块数。状态点的黄灯就是它：一轮跑完了，可
    // 页面上还剩几段是原文 —— 没有这个数，那一页看上去和「全翻完了」一模一样。
    // 代次一翻篇就归零：重开一轮时那些块会被重新收走，旧的数字说的是上一页的事。
    let gaveUp = 0;
    // 预算那句话在这个文档上说过了。**按文档记，不按代次记**：SPA 里翻一篇帖子
    // 就翻篇一次代次，跟着代次重置等于每点一下都再说一遍同一句话，而 FR-9 要的
    // 是「提示一次」。
    let budgetNoticed = false;
    // 本机统计里「这个月自动翻了几页」已经替这个 URL 记过一笔了。
    //
    // 按 URL 记，不按代次记：同一页会因为设置变动、暂停后继续重开好几轮代次，那
    // 还是同一页；而单页应用换了路由就是另一页，URL 也确实变了。第一次真的翻出
    // 东西才记 —— 判定成 off、或者一块都没送出去的那些「打开过」不算翻译过。
    let countedUrl = '';

    // ------------------------------------------------------------------ 对外

    // 上面这几个变量是这一层唯一的对外产物，而**呈现层不能靠轮询去读**：状态一秒
    // 里可能变好几次（IDLE→RUNNING→IDLE），轮询要么漏掉中间那一下，要么每
    // 200ms 醒一次、在一个早就判完的页面上白跑一整天。
    const listeners = new Set();

    function snapshot() {
      return {
        status,
        reason,
        // 「这个站点开着自动翻」是一句和 status 不同的话，见 siteAuto()。
        siteAuto: siteAuto(),
        // 「这个站点是被明令拒绝的」—— 和 siteAuto 不是一对反义词，见 siteRefused()。
        siteRefused: siteRefused(),
        error: lastError,
        sessionVersion: guard.version(),
        queued: queue.size,
        gaveUp
      };
    }

    function publish() {
      if (listeners.size === 0) return;
      const snap = snapshot();
      for (const listener of listeners) {
        // 一个画坏了的状态点不该把调度层带下水 —— 那一页会就此停止翻译，而用户
        // 看到的只是一个不动的圆点。
        try {
          listener(snap);
        } catch (error) {
          console.warn('Blab Translation: auto status listener failed', error);
        }
      }
    }

    /**
     * **status 只能从这里改。**
     *
     * 呈现层要的是「变了就告诉我」，而这一层有十个地方在改这个变量。让每个调用点
     * 自己记得广播一次，就是这个项目反复修过的那一类 bug：漏掉的那一个不报错，
     * 只是状态点停在上一态 —— 页面明明在翻，点是灰的；或者一页翻挂了，点还是绿的。
     * 所以广播不是调用点的义务，是赋值本身的一部分。
     *
     * 每次调用都广播，哪怕 status 没变：同一个 IDLE 在一轮跑完前后含义不同
     * （queued、gaveUp 都变了），去重反而会把「这一页有几段没翻成」吞掉。
     */
    function setStatus(next) {
      status = next;
      publish();
    }

    // ------------------------------------------------------------------ 判

    function resolve(options) {
      if (ctx.frameRole === 'child') return ctx.frameDecision(options);
      return globalThis.SiteRules.decide({
        host: location.hostname,
        path: location.pathname,
        userRules: ctx.settings.siteRules,
        settings: ctx.settings,
        // 默认连同用户在这一页上表过的态一起问 —— 那正是「这一页此刻该不该翻」。
        // 把那一下刨掉再问的另有其用，见 siteAuto()。
        explicit: options && options.explicit === false ? false : explicit
      });
    }

    /**
     * 「**这个站点**自己会不会翻这一页」—— 把用户在这一页上的那一下点击刨掉，
     * 重判一次。
     *
     * popup 上「自动翻译这个站点」那一行画的是这句话。用 status 画的话（idle /
     * running 就算开），用户在一个没设过规则的站点上点一次「翻译这一页」（没勾
     * 「总是」）就会看见那一行翻成「开」—— 可规则表里一条都没写，下次再来还是
     * 照样不翻；而他顺手去点那个看起来已经开着的开关，写进去的是一条**永久的
     * never**，从此这个站点再也不翻。他想开，结果关死了。
     *
     * 必须刨掉 explicit 才问得对，而不是换一组 reason 去认：decide() 的阶梯上
     * explicit 那一级排在所有站点规则之前，一旦表过态，USER_ALWAYS 和
     * BUILTIN_ALWAYS 都被它挡在后面 —— 只认那两个 reason 的话，在 x.com 上点一
     * 次「翻译这一页」，这一行反倒会从「开」翻成「关」。
     */
    function siteAuto() {
      return resolve({ explicit: false }).verdict === 'auto';
    }

    // 「这个站点不许我们自己动手」——哪几种情形算，由 SiteRules 自己说（它的
    // REFUSALS），这里只是把答案转述出去。整页之外的自动化拿它当闸门，而不是拿
    // siteAuto：两者中间隔着一大片「没人说过话」的站点（DEFAULT_OFF），理由写在
    // REFUSALS 那段注释里。
    function siteRefused() {
      return resolve({ explicit: false }).refused === true;
    }

    /**
     * 重新判这一页，从头扫一遍。
     *
     * **一进来就翻篇**：在途的那一轮跑完后会拿自己那一代的号去对，对不上就什么
     * 都不改。bump 要是留给各个调用点自己记，漏一个就是一次「旧结果覆盖新判定」
     * —— 而那条路上没有任何报错，只有页面一直空着或者语言再也探不出来。
     *
     * **「我现在想看原文」也在这里认**。ctx.state.translationsVisible 是那句话
     * 唯一的出处（悬浮球菜单里的「隐藏译文」写它，「翻译整页」把它放回来）。闩在
     * 这里而不是在各个调用点上：换路由、改设置、用户表态都会重开一轮，漏一条就
     * 是一次「菜单写着已隐藏、页面上却自己冒出译文」—— 而新插进去的译文不带
     * ai-translator-hidden，那个开关就此成了摆设。
     */
    function start(why) {
      decidedHref = location.href;
      bumpSession(why || 'start');
      stopDiscovery();
      if (ctx.state.translationsVisible === false || pausedByUser) {
        // 「我现在想看原文」「先停一下」拦住的是**开始翻**，不是**重新判**。判定
        // 还得跟上：用户在 popup 上把这个站点关掉，规则落地就会重开一轮，而这一轮
        // 要是直接停在 PAUSED，reason 和状态都还停在上一次 —— popup 照着状态画，
        // 那个开关会一直显示「开」，再点一次又写一遍 never，怎么点都关不掉。
        //
        // 判出 off 就如实说 off（这一页往后也不会自己翻了）；还该翻的照旧停着 ——
        // 停着的那一页就是暂停，这两条闩都不动。
        const held = resolve();
        reason = held.reason;
        setStatus(held.verdict === 'off' ? STATUS.OFF : STATUS.PAUSED);
        return;
      }
      broken = false;
      lastError = null;

      const verdict = resolve();
      reason = verdict.reason;
      if (verdict.verdict !== 'auto') {
        setStatus(STATUS.OFF);
        return;
      }
      setStatus(STATUS.IDLE);
      startDiscovery();
    }

    // 「在跟这一页」：IDLE 或 RUNNING。frames/top.js 的指令与站点规则流水线
    // （content/page/custom-rule.js）读的也是这一个判断。
    function isOn() {
      return status === STATUS.IDLE || status === STATUS.RUNNING;
    }

    // ------------------------------------------------------------------ 发现

    function startDiscovery() {
      if (discovery) return;
      discovery = ctx.setupAutoDiscovery({ onCandidates });
      // 头一次扫的是 document_end 时就已经在页面上的全部内容 —— 没有任何
      // MutationObserver 记录会提到它们。放到下一帧，别把首屏渲染压在后面。
      requestAnimationFrame(() => {
        if (discovery) discovery.rescan();
      });
    }

    function stopDiscovery() {
      if (!discovery) return;
      discovery.stop();
      discovery = null;
    }

    function onCandidates(blocks) {
      if (!isOn()) return;

      let added = false;
      for (const block of blocks) {
        const element = block.element;
        if (!element || !element.isConnected) continue;
        // 和 block 同一个任务里读，是一份对得上的快照。指纹走 guard.stamp ——
        // 开跑前那次比对用的是同一个入口，两边就不可能各归一化一套。
        queue.set(element, { block, source: guard.stamp(element).textFingerprint });
        added = true;
      }
      if (added) scheduleStart();
    }

    // ------------------------------------------------------------------ 译

    function scheduleStart(delay) {
      if (startTimer !== null) return;
      startTimer = setTimeout(pump, typeof delay === 'number' ? delay : START_DEBOUNCE_MS);
    }

    // 这个块此刻已经有一份「就是这段文字」的译文了。两处都要问：排队前问是为了
    // 不白花钱，写回前问是因为这期间手动整页翻译可能刚好翻到它。
    function alreadyTranslated(element, textFingerprint) {
      const identity = globalThis.BlockIdentity;
      if (!identity.lookup(element)) return false;
      // 目标语言也要带上：挂在上面那条译文要是上一门语言的，这一块就不算翻过。
      const target = ctx.currentTargetLang ? ctx.currentTargetLang() : null;
      return !identity.isStale(element, textFingerprint, target);
    }

    // 「这一块这一轮有结果了，别再送第二次」。三种结果算数：译文写回去了、模型
    // 说不用翻（两者都由 runTranslationPass 的 onSettled 报上来）、用户的语言设置
    // 把它滤掉了。失败不算 —— 那一块下一次扫描回来时还该有一次机会。
    //
    // 只认还在 inflight 里的：代次一翻篇 inflight 就清空，于是一条迟到的结果不会
    // 往新一代的台账里塞一笔（塞进去就是新一代的那一块永远不翻）。
    function commit(element) {
      const pending = inflight.get(element);
      if (!pending) return;
      inflight.delete(element);
      ledger.add(pending.key);
    }

    function acceptBlock(block) {
      const ticket = tickets.get(block.element);
      if (!ticket) return false;
      if (!guard.accept(ticket)) return false;
      return !alreadyTranslated(block.element, ticket.textFingerprint);
    }

    function takeBatch() {
      const blocks = [];
      tickets.clear();
      inflight.clear();
      for (const [element, entry] of queue) {
        if (!element.isConnected) continue;
        const ticket = guard.stamp(element);
        // 排队那一刻的原样文字和此刻的对不上 = 虚拟列表把这个节点回收给下一条
        // 内容了。entry.block 抄的还是上一条，这一轮会拿它去译、用新内容的指纹
        // 去验 —— 验得过，于是旧译文被登记成新文字的译文，**从此不会再被翻一
        // 次**。页面上看不出异样，只有内容是错的。
        //
        // 两边都是 guard.stamp 读出来的原样文字，比的是同一个表示法。
        //
        // 丢掉就行：改文字本身是一次 characterData 变动，发现层下一轮会把这个块
        // 带着新文字原样送回来。这里不记台账，那一轮才不会被当成翻过了。
        if (entry.source !== ticket.textFingerprint) continue;
        const key = `${ticket.blockId}:${ticket.textFingerprint}`;
        if (ledger.has(key)) continue;
        // 已经挂着这门语言的译文了 —— 不必再问一次台账，身份登记本身就是答案。
        if (alreadyTranslated(element, ticket.textFingerprint)) continue;
        // 挂着失败标记的块归用户了（点标记重试，content/page/failed-blocks.js）：
        // 手动那一轮失败的块滚进带里时不再自己悄悄送一次 —— 那样既多花钱，又会让
        // 标记换成自动那一轮的、重试改走自动的引擎。自动放弃的那些另有台账挡着。
        if (ctx.failedBlocks.isMarked(element)) continue;
        // 连 entry 一起留着：这一轮没走到结果的话，要拿它原样放回队列。发现层
        // 「进带即摘」，不放回就再也没有任何东西会把这一块送回来。
        inflight.set(element, { key, entry });
        tickets.set(element, ticket);
        blocks.push(entry.block);
      }
      queue.clear();
      return blocks;
    }

    /**
     * 费用闸（PRD FR-9）：这一轮该不该跑。返回停翻的理由，没有就返回 null。
     *
     * 第一问是「自动模式这一刻走哪个引擎」，而**这个问题不在这里算**：
     * effectiveEngine({ auto: true }) 是它唯一的主人，因为同一句话
     * requestTranslation 还要再问一次，两边各算各的迟早会在某个 http:// 页面上
     * 分叉成「状态说在翻、页面却一片原文」。三个答案对应三件事：
     *
     * - `'builtin'` —— 本机跑，不计费也不限量。自动翻译默认开着的全部底气就在
     *   这里，所以直接放行，一个字符都不用记。
     * - `'none'` —— FR-9.1：选了「仅本地引擎」而这一页给不出内置引擎。这一页不
     *   自动翻，安静地停（状态点上说得出理由，不弹窗）。不拦的话就是三次批次失
     *   败换一句「翻译失败」，而真实情况是用户自己的选择。
     * - `'ai'` —— 他点过头了（自动引擎切成 AI，或者开了回退），于是只剩额度这
     *   一问。
     *
     * 这是一次**预判**，不是那道闸本身。钱真花不花得出去由
     * content/content-translation-engine.js 的 refuseAutoAiSpend 在最后那次
     * sendMessage 旁边说了算 —— 那里拦得住内置引擎跑到一半回落 AI 的那一下，这里
     * 拦不住。两边问的是同一个 autoAiDailyBudget，分工不同：那边不会说话，只会
     * 拒；这里不花钱，只负责让用户看见「为什么停了」。少了这里，超预算的页面会
     * 一批批撞在那道闸上，攒够三次批次失败，最后以一句「翻译失败」收场 —— 而真
     * 实情况是额度用完了。
     */
    async function costRefusal() {
      const engine = await ctx.builtinTranslator.effectiveEngine({ auto: true, feature: 'page' });
      if (engine === 'builtin') return null;
      if (engine === 'none') return COST_REASONS.ENGINE;
      const stats = await globalThis.AutoStats.read();
      if (globalThis.AutoStats.budgetExceeded(stats, ctx.settings.autoAiDailyBudget)) {
        return COST_REASONS.BUDGET;
      }
      return null;
    }

    async function pump() {
      startTimer = null;
      if (running || broken) return;
      if (!isOn()) return;
      if (queue.size === 0) return;

      // 手动整页翻译正在跑。它有自己的进度条、自己的「整页翻过了」状态，两轮
      // 同时往页面上写只会互相打架。等它 —— 不抢、也不改它那份状态。规则变化补的
      // 那一轮（custom-rule.js）同理。
      if (ctx.state.isTranslatingPage || ctx.customRules.isCatchingUp()) {
        scheduleStart(MANUAL_RETRY_MS);
        return;
      }

      // 问在 takeBatch 之前：takeBatch 会把队列抽干、把块记进 inflight，而被费用
      // 闸拦下的这一轮根本不会跑，那些块就此无声消失 —— 用户后来把 AI 打开，页面
      // 上仍旧一片原文，没有任何东西会把它们送回来。
      const costSession = guard.version();
      const refused = await costRefusal();
      if (guard.version() !== costSession) return;
      if (refused) {
        reason = refused;
        setStatus(STATUS.OFF);
        stopDiscovery();
        // 「退回手动模式并提示一次」。引擎那一条不提示：自动模式不用 AI 是默认
        // 设定，不是意外，每开一个页面弹一次是在为一件他没做过的事道歉。
        if (refused === COST_REASONS.BUDGET && !budgetNoticed) {
          budgetNoticed = true;
          if (ctx.showAutoStatusNotice) ctx.showAutoStatusNotice(ctx.t('autoBudgetSpent'));
        }
        return;
      }

      const blocks = takeBatch();
      if (blocks.length === 0) return;

      // 这一轮属于哪一代。await 期间可能换了路由、改了设置 —— 回来时这一页已经
      // 不归我们管了，下面那几个状态赋值就都是在替新的一代乱表态。
      const session = guard.version();
      running = true;
      setStatus(STATUS.RUNNING);
      // 我们自己插译文引起的变动，发现层本来就认得出来。挂起是为了省掉插入期间
      // 那几十次「子树变了」带来的重复收集。
      const suspended = discovery;
      if (suspended) suspended.suspend();

      let error = null;
      // 这一轮真的有块拿到了结果。**由 onSettled 置起**，而不是发出去的那一刻：
      // runTranslationPass 要连错三批才报错，一张只有一两批的小页面可以整页全
      // 失败而 error 仍是 null —— 那一页一个字都没译出来，不该记成「翻了一页」。
      let translated = false;
      try {
        // 「已经是目标语言的就别翻了」是用户的设置，自动这一轮和手动那一轮认的是
        // 同一条（content/content-page-translation.js 在同一个位置调它）。不认，
        // 就是把他明确说过不必发的文字一轮一轮发出去。
        const fresh = await ctx.filterBlocksByLanguage(blocks);
        // 探语言本身就是一串 await。期间换了路由或者关掉了自动翻译，这一轮的结果
        // 一条都不会被采纳 —— 那就一条都别发，也别往（早已作废重建的）台账里记。
        if (!superseded(session)) {
          // 被语言滤掉的是**有意跳过**，和失败是两回事：这一轮不发它，下一轮也不
          // 该再发。记账。
          const keep = new Set(fresh.map((block) => block.element));
          for (const block of blocks) if (!keep.has(block.element)) commit(block.element);
        }
        if (fresh.length > 0 && !superseded(session)) {
          // 自动这一轮没有 user activation，不触发语言包下载 —— 见
          // content/page/batch.js 里 runTranslationPass 开头那段。
          //
          // isAborted 和 accept 分工不同，缺一不可：accept 拦的是「回填」，翻都
          // 翻完了才拒，钱已经花掉；isAborted 拦的是「还要不要发下一批」。跑到
          // 一半换了路由时，能省下的是池子里剩下的那几百块。
          error = await ctx.runTranslationPass(fresh, {
            accept: acceptBlock,
            // 记账等结果：accept 是「还要不要写回去」，onSettled 是「这一块有结果
            // 了」。失败的块两者都不会走到，于是留在 inflight 里，随这一轮一起
            // 丢掉 —— 下次扫描回来还有一次机会。
            onSettled: (block) => {
              translated = true;
              commit(block.element);
            },
            allowDownload: false,
            // 这一轮是自动模式发出去的。引擎层据此判 FR-9 的费用闸，本机统计
            // 也据此把「自动模式今天花掉多少字符」和手动那部分分开记。
            auto: true,
            // 每一批发出去之前都问一次 superseded()：地址可能是在这一轮跑到一半
            // 时才换的。
            isAborted: () => superseded(session),
          });
        }
      } catch (thrown) {
        console.error('Blab Translation: auto translation pass failed', thrown);
        error = (thrown && thrown.message) || String(thrown);
      } finally {
        running = false;
        tickets.clear();
        // 这一轮没走到结果的块（批次失败一两次，runTranslationPass 还没到报错的
        // 门槛）。它们既不在台账里，也不会再被送回来 —— 发现层进带时就把它们摘了，
        // 而一张静止的页面不会再有任何变动。所以这里亲自放回队列，下面那句
        // scheduleStart 会把它们带进下一轮。
        //
        // 代次一翻篇 inflight 就被清空，所以这个循环在作废的那一轮里天然是空转，
        // 不会把上一页的块塞进新一页的队列。
        const giveUp = new Map();
        for (const [element, pending] of inflight) {
          if (retried.has(pending.key)) {
            giveUp.set(element, pending.entry.block);
            continue;
          }
          retried.add(pending.key);
          if (element.isConnected) queue.set(element, pending.entry);
        }
        gaveUp += giveUp.size;
        // 第二次也失败了：这一页不再自己送它，放一个失败标记把决定交给用户
        // （content/page/failed-blocks.js）。第一次失败不放 —— 上面那一步已经把
        // 它放回队列，下一轮多半就翻成了。
        for (const [element, block] of giveUp) {
          commit(element);
          if (element.isConnected) ctx.failedBlocks.mark(block, error, { auto: true });
        }
        inflight.clear();
        // 挂起的是当时那一个。期间换了路由的话，discovery 已经指向新的一个 ——
        // 那个从没被挂起过，去 resume 它只会把它的计数弄负。
        if (suspended) suspended.resume();
      }

      // 翻篇了。这一轮的成败是上一页的事，这一页刚刚判完、状态是新定的，
      // 覆盖它会让 OFF 变回 IDLE（一个不该翻的页面自己翻起来），或者让一次旧的
      // 失败把新一页的发现层停掉。
      if (guard.version() !== session) {
        // 新的一代有自己的队要排 —— 刚才 running 挡回去的那次 pump 没有重排。
        if (queue.size > 0 && isOn()) scheduleStart();
        return;
      }

      // 数在报错之前。一轮里有几批成了、另几批崩到了 runTranslationPass 报错的
      // 门槛，页面上是真有译文摆着的 —— 而「这个月自动翻了几页」问的是「这一页
      // 翻过没有」，不是「这一轮有没有出错」。记在下面那个 return 后头，就是把
      // 一页看得见译文的页面记成零。
      if (translated && countedUrl !== location.href && ctx.frameRole !== 'child') {
        countedUrl = location.href;
        globalThis.AutoStats.add({ pages: 1 });
      }

      if (error) {
        broken = true;
        lastError = error;
        setStatus(STATUS.ERROR);
        stopDiscovery();
        console.warn('Blab Translation: auto translation stopped for this page —', error);
        return;
      }

      setStatus(STATUS.IDLE);
      if (queue.size > 0) scheduleStart();
    }

    /**
     * 「这一轮还算数吗」—— 每一批发出去之前问（R33 D-360 F1）。
     *
     * 地址先对一次：这一代是替 decidedHref 判的，页面若已经走到别的地址，就把
     * 路由信号当场补上 —— SpaNavigation.check() 走的是和 popstate / navigatesuccess /
     * 轮询同一个 announce，于是进的是同一个 onRouteChange，重新判定只有那一条路。
     * 不对的话：页面的路由器拦下 Navigation API 的 navigate 事件时，隔离世界要到
     * 下一次轮询（最慢 800ms）才听说换了页，而发现层 400ms、起跑 250ms 之后这一
     * 批就出门了 —— x.com 从首页点进私信，私信正文会按首页的判定送出去。
     *
     * 补上信号之后代次已经翻篇，照常由代次作答。
     */
    function superseded(session) {
      if (location.href !== decidedHref) globalThis.SpaNavigation.check('send');
      return guard.version() !== session;
    }

    // ------------------------------------------------------------------ 代次

    function bumpSession(why) {
      guard.bump(why);
      gaveUp = 0;
      queue.clear();
      tickets.clear();
      inflight.clear();
      retried.clear();
      ledger.clear();
    }

    /**
     * 这一页先停下。光靠 start() 那道闩不够 —— 停一下不会重开一轮，而此刻正跑
     * 着的那一轮和挂着的观察器要立刻停下。
     *
     * `cause` 说的是**谁停的**，因为解铃还须系铃人：
     *
     *   - 不带 cause（popup 上按的「暂停」）—— 这是他对这一页下的一句话，记成
     *     一道闩，只有他自己解得开。
     *   - `'hidden'`（他把译文藏了）—— **不上闩**。藏译文本身就是一道闩，
     *     start() 看的是 ctx.state.translationsVisible，这一道在译文放回来之前
     *     一直拦着。再上一道的话，放回译文时跟着解掉的就不只是自己：他在 popup
     *     上按下的暂停会被一次「显示译文」顺手洗掉，页面自己又翻起来了。
     */
    function pauseCurrentPage(cause) {
      if (status === STATUS.OFF || status === STATUS.PAUSED) return;
      // 出错停下的那一页，藏一下译文不该把它改写成「已暂停」。ERROR 是一个**结
      // 论**（broken 已经置上、发现层已经停了，这一页没有一件在跑的活可停），而
      // 看一眼原文不是对那个结论的答复。改写它要付两次账：状态点从「出错」变成
      // 「已暂停」，那句「为什么停了」就此没人说得出；而把译文放回来那一下会把它
      // 当成自己停下的那一页叫醒、重开一轮 —— 用户只是想看一眼原文，却替他把刚
      // 刚失败的那些请求又发了一遍，钱是他的。重试有专门的一句话，见
      // resumeCurrentPage。
      if (cause === 'hidden' && status === STATUS.ERROR) return;
      if (cause !== 'hidden') pausedByUser = true;
      bumpSession('paused');
      stopDiscovery();
      setStatus(STATUS.PAUSED);
    }

    /**
     * 「继续翻这一页」。
     *
     * **藏着译文的时候，继续就是把译文放回来。** 这一页会停下来只有两种可能：
     * 用户在 popup 上按了暂停，或者他把译文藏了（setTranslationsVisible(false)
     * 顺手停的）。后一种情况下 start() 里那道闩还认着「我现在想看原文」，直接
     * 重开一轮只会原地弹回 PAUSED —— popup 上那颗「继续」按下去毫无反应，而且
     * 不报错。所以先走显隐层的唯一入口把译文放回来，它回头会再叫一次这里，
     * 那时闩已经开了。
     *
     * 同样要问是谁在继续（见 pauseCurrentPage）：把译文放回来
     * （`cause === 'hidden'`）不等于撤销他在 popup 上按下的那句「这一页先别翻
     * 了」。那两句话是分开的，解闩的也只有后面那一句。
     */
    function resumeCurrentPage(cause) {
      if (status !== STATUS.PAUSED && status !== STATUS.ERROR) return;
      // 闩只有他自己解得开：popup 上的「继续」，或者「翻译整页」。显隐层越过
      // 它的话，藏一下再显示一下就把暂停洗掉了，而他从头到尾没碰过那颗按钮。
      if (cause === 'hidden') {
        if (pausedByUser) return;
        // 「显示译文」不是「重试」。出错的那一页等的是一句明确的「继续」（popup
        // 那一行、或者「翻译整页」）—— 一次看原文的往返替他说了这句话，账单上多
        // 出来的那几次请求他从头到尾没同意过，页面上也看不出任何异样。
        if (status === STATUS.ERROR) return;
      } else {
        // 放在最前面是因为藏着译文那条路要拐个弯（下面），回头还会再走一次这里
        // —— 那一次带着 'hidden'，此刻已经解开的这一道不会再被问起。
        pausedByUser = false;
      }
      if (ctx.state.translationsVisible === false && ctx.revealHiddenTranslations) {
        ctx.revealHiddenTranslations();
        // 显隐层回头会再叫一次这里（带 'hidden'），闩开了，这一轮就是在那一次接上
        // 的 —— 只有一种页面它接不上：停在 ERROR 的那一页，因为重试必须是他自己
        // 说的那一句（见上面）。而此刻说话的正是他，所以这一次不能把活全指望给
        // 那一次回调。
        if (status !== STATUS.ERROR) return;
      }
      start('resume');
    }

    /**
     * 用户在这一页点了「翻译整页」。从此这一页长出来的新内容跟着翻 —— 那是在
     * 兑现他那一次点击，不是替他做主。
     *
     * 受总开关管：设计里总开关一关，整条链路全停，这条也不能例外。而
     * decide() 里 explicit 优先于总开关是对的 —— 那是在回答「该不该翻」，
     * 这里回答的是另一个问题：「这套机器要不要转起来」。
     */
    function markPageExplicit() {
      if (!ctx.settings.autoTranslate) return;
      // 「翻译整页」是比暂停更晚、更明确的一句话，所以它解闩 —— 否则点完整页
      // 翻译，这一页新长出来的内容照旧不跟，而他刚刚要的就是翻。
      //
      // 解了闩就得重开一轮，哪怕这一页早就表过态了：那一轮正停在闩上。
      const wasHeld = pausedByUser;
      pausedByUser = false;
      if (explicit && !wasHeld) return;
      explicit = true;
      start('explicit');
    }

    function onRouteChange(change) {
      // 新的一页，用户还没表过态。
      explicit = false;
      // 闩也一样是**这一页**的：他按的那句话是「这一页先别翻了」，不是「这个站
      // 点从此别翻了」—— 那句话有另一个说法（popup 上关掉这个站点，写 never）。
      // 不解的话，SPA 里点进下一篇文章起就全是原文，而且他没有任何理由想到要去
      // 点「继续」：那颗按钮此刻指着的是他早就离开的那一页。
      pausedByUser = false;
      start(`route:${change && change.via}`);
    }

    // 这几个键一变，这一页要从头来过：代次翻篇作废在途的结果，start() 重新判、
    // 重新扫。换引擎也在其中 —— 只作废不重扫的话，那些块进带时已经被摘掉了
    // （发现层「进带即摘」），没有任何变动会把它们再送回来，页面就一直空着。
    //
    // engineFallback 是**用来救场的**：内置引擎在这台机器上用不了时，把它从
    // local-only 改成 allow-ai 正是那一页唯一的活路。密钥、地址、模型不在这里：
    // 它们住在 AI 配置档里（aiProfile:<id>，不进 ctx.settings），同一条救场路走
    // 下面的 ctx.aiProfiles.subscribe —— 一页因为密钥没填、填错、地址或模型写错
    // 而停在 ERROR 之后，用户在设置页把配置档改对，这一页要自己重来。
    //
    // 这份名单不是随手攒的，它有一条可以对照的来源：**凡是喂进「这一页翻不翻」
    // 或者「这一块翻不翻」的设置键，都得在里面**。
    //
    //   判（shared/site-rules.js 的 decide）   autoTranslate，外加入参的出处 siteRules
    //   译（content/page/batch.js）            skipTargetLanguageText，以及目标语言
    //                                          targetLang（换了语言，同样的文字要重翻）
    //   engine（哪条路、回落到哪）              translationEngine、engineFallback
    //   拿什么去调                              AI 配置档（订阅，不是设置键）
    //
    // 漏一个的后果都一样，而且都不报错：skipTargetLanguageText 从开改成关之后，
    // 之前被误判成「已经是目标语言」而跳过的那些块，key 还在台账里、元素早被
    // 发现层摘了，新设置永远轮不到它们。test/unit/auto-translate-wiring.test.mjs
    // 会去那两个文件里把实际读到的键扫出来对账。
    const RESTART_KEYS = [
      'autoTranslate', 'siteRules', 'targetLang',
      'skipTargetLanguageText',
      'translationEngine', 'engineFallback',
      // 费用闸的两个（costRefusal）。少了它们，用户在设置页把自动模式的 AI 打开、
      // 或者把预算调大之后，已经停在 OFF 上的那些页面要刷新才活得过来 —— 而他
      // 刚刚做的正是「让它们继续翻」这件事。
      'autoTranslateEngine', 'autoAiDailyBudget'
    ];

    function onSettingsChanged(changes) {
      if (!RESTART_KEYS.some((key) => key in changes)) return;
      start('settings');
    }

    globalThis.SpaNavigation.onRouteChange(onRouteChange);
    // 语言包刚装好。默认设置下这一页十有八九已经停在 ERROR 上了（自动这一轮
    // 不带 user activation，拿回的是 builtinNeedsDownload），而 start() 会把
    // broken 放掉、重新判、重新扫 —— 这是这一页唯一不用刷新就能活过来的时刻。
    ctx.onLanguagePackReady(() => start('language-pack'));
    // 本页生效的用户站点规则变了：与 RESTART_KEYS 同一条路。引擎改成内置能叫醒
    // 费用闸停下的页面；删掉一条 exclude，进带时被摘掉的块也要重扫才回得来。
    ctx.customRules.onChange(() => start('custom-rule'));
    // AI 配置档变了（任何一档，含只改了 Key 的写入：公开镜像看不见 Key，但照样
    // 通知）：与 RESTART_KEYS 同一条路，改对了 Key / 地址 / 模型的页面自己重来。
    ctx.aiProfiles.subscribe(() => start('ai-profiles'));
    start('load');

    return {
      state: snapshot,
      /**
       * 订阅状态变化，返回退订函数。
       *
       * **订阅的那一刻就先回调一次当前状态。** 呈现层是在调度层之后才装起来的
       * （content/content-bootstrap.js 的 init 就是这个顺序），那时 start('load')
       * 早已跑完 —— 只等「下一次变化」的话，一个判完就定下来不再动的页面（黑名单、
       * 内置 never）永远等不到那一次，那条说明为什么不翻的状态条根本不会出现。
       */
      onStateChange: (listener) => {
        listeners.add(listener);
        try {
          listener(snapshot());
        } catch (error) {
          console.warn('Blab Translation: auto status listener failed', error);
        }
        return () => listeners.delete(listener);
      },
      pauseCurrentPage,
      resumeCurrentPage,
      markPageExplicit,
      // 子 frame 的指令变了（content/frames/child.js）：重新判、重新扫。
      restart: start,
      isOn,
      bumpSession,
      onSettingsChanged
    };
  }

  ctx.STATUS_AUTO = STATUS;
  ctx.setupAutoTranslate = function () {
    if (ctx.autoTranslate) return ctx.autoTranslate;
    ctx.autoTranslate = setupAutoTranslate();
    return ctx.autoTranslate;
  };
})();
