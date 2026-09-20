// Blab Translation — 自动翻译的调度层：决定这一页翻不翻，然后把发现层送来的块
// 一轮一轮译掉。
//
// 三件事，缺一不可：
//
//   **判**  这一页该不该自己动手 —— 全交给 shared/site-rules.js 的 decide()。
//           这里只负责把事实（域名、路径、页面语言、用户规则）凑齐了递进去。
//           分两次问：第一次不带语言，能定的就定了（黑名单、用户设的总是/永不、
//           用户已经表过态）；只有第一次答「要问」时，语言才成为一个问题 ——
//           那时候才去探一次页面语言，再问第二次。**大多数页面探都不用探。**
//
//   **译**  攒一批块，调 ctx.runTranslationPass。它是手动整页翻译用的同一个函数
//           （PR-1 把进度条和「整页翻过了」那类状态搬出去之后，它就只剩翻译本身
//           了），所以这里不需要一套平行的翻译流水线。
//
//   **弃**  发出去的请求回来时，页面可能已经不是当初那一页了。每个块发请求前盖
//           一个章（shared/session-guard.js），写回前验一次。**不取消请求** ——
//           钱已经花了，取消也拿不回来；能做干净的只有「不写上去」。
//
// 它不画任何东西。询问条、状态点、悬浮球的样子都是 content/content-auto-status.js
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
  // 探页面语言的取样：够这么多字就探，不再等。
  const SAMPLE_MIN_CHARS = 200;
  // 取样上限。getLanguageDetectionText 清洗完只取前 400 字，这里留足余量即可。
  const SAMPLE_MAX_CHARS = 1000;
  // 正文来得零零碎碎时，最多等这么久就拿手上的去探。等不到更多文字的页面
  // （一句话的错误页、还在转圈的应用）不该把整条链路卡在这里。
  const SAMPLE_WAIT_MS = 1200;

  const STATUS = Object.freeze({
    OFF: 'off',         // 判过了，这一页不自动翻
    ASK: 'ask',         // 判过了，该问用户 —— 问的界面是 PR-7
    PENDING: 'pending', // 在等正文，好探出页面语言
    IDLE: 'idle',       // 开着，没有待译的块
    RUNNING: 'running', // 一轮正在跑
    PAUSED: 'paused',   // 用户在这一页喊停了
    ERROR: 'error'      // 一轮整体失败，这一页不再重试
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
    // 「这一页先别翻了」—— popup 上按的暂停，或者把译文藏起来（两条都走
    // pauseCurrentPage）。
    //
    // 必须记成一道闩，不能只把状态改成 PAUSED：状态会被下一次 start() 覆盖，而
    // start() 是别人替他叫的 —— 另一个标签页在追问条上点了「总是」，siteRules
    // 一落地，这一页的 onSettingsChanged 就重开一轮，他按下的暂停当场失效，页面
    // 自己又翻起来了。闩只有他自己解得开（继续 / 翻译整页），或者换一个文档。
    let pausedByUser = false;
    let pageLang = null;
    let langResolved = false;
    let sampleText = '';
    let sampleTimer = null;
    let startTimer = null;
    let running = false;
    // 一轮整体失败就不再自动重试。runTranslationPass 返回错误本身已经意味着它
    // 内部连续失败了三次 —— 到这一步再重试，是在一个明显坏掉的接口上继续烧钱。
    let broken = false;
    // 这一页上「给过机会还是没翻成」的块数。状态点的黄灯就是它：一轮跑完了，可
    // 页面上还剩几段是原文 —— 没有这个数，那一页看上去和「全翻完了」一模一样。
    // 代次一翻篇就归零：重开一轮时那些块会被重新收走，旧的数字说的是上一页的事。
    let gaveUp = 0;

    // ------------------------------------------------------------------ 对外

    // 上面这几个变量是这一层唯一的对外产物，而**呈现层不能靠轮询去读**：状态一秒
    // 里可能变好几次（IDLE→RUNNING→IDLE），轮询要么漏掉中间那一下，要么每
    // 200ms 醒一次、在一个早就判完的页面上白跑一整天。
    const listeners = new Set();

    function snapshot() {
      return {
        status,
        reason,
        pageLang,
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

    function resolve(lang) {
      return globalThis.SiteRules.decide({
        host: location.hostname,
        path: location.pathname,
        pageLang: lang,
        targetLang: ctx.getEffectiveTargetLang(),
        userRules: ctx.settings.siteRules,
        settings: ctx.settings,
        explicit
      });
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
      bumpSession(why || 'start');
      stopDiscovery();
      clearSample();
      if (ctx.state.translationsVisible === false || pausedByUser) {
        // 「我现在想看原文」「先停一下」拦住的是**开始翻**，不是**重新判**。判定
        // 还得跟上：用户在 popup 上把这个站点关掉，规则落地就会重开一轮，而这一轮
        // 要是直接停在 PAUSED，reason 和状态都还停在上一次 —— popup 照着状态画，
        // 那个开关会一直显示「开」，再点一次又写一遍 never，怎么点都关不掉。
        //
        // 判出 off 就如实说 off（这一页往后也不会自己翻了）；还该翻的照旧停着 ——
        // 停着的那一页就是暂停，这两条闩都不动。
        const held = resolve(pageLang);
        reason = held.reason;
        setStatus(held.verdict === 'off' ? STATUS.OFF : STATUS.PAUSED);
        return;
      }
      broken = false;
      lastError = null;
      langResolved = false;
      pageLang = null;

      // 第一问：不带语言。decide() 的阶梯上，语言之前的每一条都在这里定下来，
      // 而语言之后的条目在 pageLang 为空时只会落到「要问」—— 所以这一问要么给
      // 出终局答案，要么明确告诉我们「语言说了算」。
      const first = resolve(null);
      reason = first.reason;

      if (first.verdict === 'off') {
        setStatus(STATUS.OFF);
        return;
      }
      if (first.verdict === 'auto') {
        langResolved = true;
        setStatus(STATUS.IDLE);
        startDiscovery();
        return;
      }

      setStatus(STATUS.PENDING);
      startDiscovery();
    }

    function clearSample() {
      sampleText = '';
      if (sampleTimer !== null) {
        clearTimeout(sampleTimer);
        sampleTimer = null;
      }
    }

    // 页面语言不另外扫一遍 DOM：发现层送来的头几块本来就是正文，而且是按阅读
    // 顺序来的。取样和翻译共用同一次收集。
    function sample(blocks) {
      for (const block of blocks) {
        if (sampleText.length >= SAMPLE_MAX_CHARS) break;
        sampleText += (sampleText ? '\n' : '') + block.text;
      }
      if (sampleText.length >= SAMPLE_MIN_CHARS) {
        detectAndResolve();
        return;
      }
      if (sampleTimer === null) sampleTimer = setTimeout(detectAndResolve, SAMPLE_WAIT_MS);
    }

    async function detectAndResolve() {
      if (status !== STATUS.PENDING || langResolved) return;
      langResolved = true;
      const text = sampleText;
      clearSample();

      // 探语言也是一次 await。期间换了路由的话，start() 把新的一页也放回了
      // PENDING —— 只看状态的话，上一页的语言会被拿来判这一页。
      const session = guard.version();
      let lang = null;
      try {
        // 和「这一段已经是目标语言了」用的是同一个判定和同一个阈值
        // （content/page/batch.js 的 LANGUAGE_CONFIDENCE_MIN）。
        lang = await ctx.detectReliableLanguage(text);
      } catch (error) {
        console.warn('Blab Translation: auto language detection failed', error);
      }
      // 期间被暂停、换了路由或改了设置。
      if (guard.version() !== session || status !== STATUS.PENDING) return;

      pageLang = lang;
      const final = resolve(lang);
      reason = final.reason;

      if (final.verdict === 'auto') {
        // 第二问答不出 auto —— 所有「要翻」的理由都在第一问里定了。留着这一支
        // 是因为「该不该翻」只有 decide() 一个权威，这里不该替它推断。
        setStatus(STATUS.IDLE);
        if (discovery) discovery.rescan();
        return;
      }
      // off 就是不翻；ask 要问用户，而问的界面还不存在（PR-7）。两者都不再需要
      // 发现层 —— 一个没人看的观察器在每个页面上白跑，是实打实的耗电。
      setStatus(final.verdict === 'ask' ? STATUS.ASK : STATUS.OFF);
      stopDiscovery();
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
      if (status === STATUS.PENDING) {
        // 语言还没判出来之前不排队：判出来多半是「这一页不翻」，排了也是白排。
        sample(blocks);
        return;
      }
      if (status !== STATUS.IDLE && status !== STATUS.RUNNING) return;

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
        // 连 entry 一起留着：这一轮没走到结果的话，要拿它原样放回队列。发现层
        // 「进带即摘」，不放回就再也没有任何东西会把这一块送回来。
        inflight.set(element, { key, entry });
        tickets.set(element, ticket);
        blocks.push(entry.block);
      }
      queue.clear();
      return blocks;
    }

    async function pump() {
      startTimer = null;
      if (running || broken) return;
      if (status !== STATUS.IDLE && status !== STATUS.RUNNING) return;
      if (queue.size === 0) return;

      // 手动整页翻译正在跑。它有自己的进度条、自己的「整页翻过了」状态，两轮
      // 同时往页面上写只会互相打架。等它 —— 不抢、也不改它那份状态。
      if (ctx.state.isTranslatingPage) {
        scheduleStart(MANUAL_RETRY_MS);
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
      try {
        // 「已经是目标语言的就别翻了」是用户的设置，自动这一轮和手动那一轮认的是
        // 同一条（content/content-page-translation.js 在同一个位置调它）。不认，
        // 就是把他明确说过不必发的文字一轮一轮发出去。
        const fresh = await ctx.filterBlocksByLanguage(blocks);
        // 探语言本身就是一串 await。期间换了路由或者关掉了自动翻译，这一轮的结果
        // 一条都不会被采纳 —— 那就一条都别发，也别往（早已作废重建的）台账里记。
        if (guard.version() === session) {
          // 被语言滤掉的是**有意跳过**，和失败是两回事：这一轮不发它，下一轮也不
          // 该再发。记账。
          const keep = new Set(fresh.map((block) => block.element));
          for (const block of blocks) if (!keep.has(block.element)) commit(block.element);
        }
        if (fresh.length > 0 && guard.version() === session) {
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
            onSettled: (block) => commit(block.element),
            allowDownload: false,
            isAborted: () => guard.version() !== session,
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
        const giveUp = [];
        for (const [element, pending] of inflight) {
          if (retried.has(pending.key)) {
            giveUp.push(element);
            continue;
          }
          retried.add(pending.key);
          if (element.isConnected) queue.set(element, pending.entry);
        }
        gaveUp += giveUp.length;
        for (const element of giveUp) commit(element);
        inflight.clear();
        // 挂起的是当时那一个。期间换了路由的话，discovery 已经指向新的一个 ——
        // 那个从没被挂起过，去 resume 它只会把它的计数弄负。
        if (suspended) suspended.resume();
      }

      // 翻篇了。这一轮的成败是上一页的事，这一页刚刚判完、状态是新定的，
      // 覆盖它会让 PENDING 变回 IDLE（语言再也探不出来），或者让一次旧的失败
      // 把新一页的发现层停掉。
      if (guard.version() !== session) {
        // 新的一代有自己的队要排 —— 刚才 running 挡回去的那次 pump 没有重排。
        if (queue.size > 0 && (status === STATUS.IDLE || status === STATUS.RUNNING)) scheduleStart();
        return;
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
      if (cause !== 'hidden') pausedByUser = true;
      bumpSession('paused');
      stopDiscovery();
      clearSample();
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
      } else {
        // 放在最前面是因为藏着译文那条路要拐个弯（下面），回头还会再走一次这里
        // —— 那一次带着 'hidden'，此刻已经解开的这一道不会再被问起。
        pausedByUser = false;
      }
      if (ctx.state.translationsVisible === false && ctx.revealHiddenTranslations) {
        ctx.revealHiddenTranslations();
        return;
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
    // 后四个是**用来救场的**：一页因为密钥没填、填错、地址或模型写错而停在 ERROR
    // 之后，用户去设置页把它改对 —— 改对了却不重来，这一页就一直停在那儿，直到
    // 他自己想起来刷新。engineFallback 同理：内置引擎在这台机器上用不了时，把它
    // 从 local-only 改成 allow-ai 正是那一页唯一的活路。
    //
    // 这份名单不是随手攒的，它有一条可以对照的来源：**凡是喂进「这一页翻不翻」
    // 或者「这一块翻不翻」的设置键，都得在里面**。
    //
    //   判（shared/site-rules.js 的 decide）   autoTranslate、autoTranslateLangs，
    //                                          外加它另外两个入参的出处 siteRules、targetLang
    //   译（content/page/batch.js）            skipTargetLanguageText
    //   engine（哪条路、回落到哪、拿什么去调）  translationEngine、engineFallback、
    //                                          apiKey、apiEndpoint、modelName
    //
    // 漏一个的后果都一样，而且都不报错：skipTargetLanguageText 从开改成关之后，
    // 之前被误判成「已经是目标语言」而跳过的那些块，key 还在台账里、元素早被
    // 发现层摘了，新设置永远轮不到它们。test/unit/auto-translate-wiring.test.mjs
    // 会去那两个文件里把实际读到的键扫出来对账。
    const RESTART_KEYS = [
      'autoTranslate', 'siteRules', 'autoTranslateLangs', 'targetLang',
      'skipTargetLanguageText',
      'translationEngine', 'apiKey', 'apiEndpoint', 'modelName', 'engineFallback'
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
    start('load');

    return {
      state: snapshot,
      /**
       * 订阅状态变化，返回退订函数。
       *
       * **订阅的那一刻就先回调一次当前状态。** 呈现层是在调度层之后才装起来的
       * （content/content-bootstrap.js 的 init 就是这个顺序），那时 start('load')
       * 早已跑完 —— 只等「下一次变化」的话，一个判完就定下来不再动的页面（黑名单、
       * 语言相同、要追问）永远等不到那一次，追问条根本不会出现。
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
