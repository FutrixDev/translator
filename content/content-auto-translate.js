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
// 它不画任何东西。询问条、状态点、悬浮球的样子都是 PR-7 的事，这一层只把
// state() 摆在那里给它们读。
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

    // 待译队列。Map 而不是数组：同一个块可能被发现层送来两次（父子子树都变过），
    // 按元素去重，而插入顺序正好是进带顺序 —— 用户先看到的先译。
    const queue = new Map();
    // 本轮在途请求的章。一轮之内才有意义，下一轮重新盖。
    const tickets = new Map();
    // 已经动过手的块：`代次内编号:文本指纹`。发现层每次扫描都会把没翻成的块
    // （已经是中文的、判定跳过的）原样再送一遍，没有这本台账就会一遍遍重新发请求。
    // 代次一翻篇就整本作废 —— 换了目标语言之后，同样的文字要重新翻。
    const ledger = new Set();

    let discovery = null;
    let status = STATUS.OFF;
    let reason = '';
    let lastError = null;
    // 用户在这一页已经表过态（点过「翻译整页」）。换路由就忘掉。
    let explicit = false;
    let pageLang = null;
    let langResolved = false;
    let sampleText = '';
    let sampleTimer = null;
    let startTimer = null;
    let running = false;
    // 一轮整体失败就不再自动重试。runTranslationPass 返回错误本身已经意味着它
    // 内部连续失败了三次 —— 到这一步再重试，是在一个明显坏掉的接口上继续烧钱。
    let broken = false;

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

    function start() {
      stopDiscovery();
      clearSample();
      queue.clear();
      tickets.clear();
      ledger.clear();
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
        status = STATUS.OFF;
        return;
      }
      if (first.verdict === 'auto') {
        langResolved = true;
        status = STATUS.IDLE;
        startDiscovery();
        return;
      }

      status = STATUS.PENDING;
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

      let lang = null;
      try {
        // 和「这一段已经是目标语言了」用的是同一个判定和同一个阈值
        // （content/page/batch.js 的 LANGUAGE_CONFIDENCE_MIN）。
        lang = await ctx.detectReliableLanguage(text);
      } catch (error) {
        console.warn('Blab Translation: auto language detection failed', error);
      }
      if (status !== STATUS.PENDING) return;  // 期间被暂停、换了路由或改了设置

      pageLang = lang;
      const final = resolve(lang);
      reason = final.reason;

      if (final.verdict === 'auto') {
        // 第二问答不出 auto —— 所有「要翻」的理由都在第一问里定了。留着这一支
        // 是因为「该不该翻」只有 decide() 一个权威，这里不该替它推断。
        status = STATUS.IDLE;
        if (discovery) discovery.rescan();
        return;
      }
      // off 就是不翻；ask 要问用户，而问的界面还不存在（PR-7）。两者都不再需要
      // 发现层 —— 一个没人看的观察器在每个页面上白跑，是实打实的耗电。
      status = final.verdict === 'ask' ? STATUS.ASK : STATUS.OFF;
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
        queue.set(element, block);
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
      return !identity.isStale(element, textFingerprint);
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
      for (const [element, block] of queue) {
        if (!element.isConnected) continue;
        const ticket = guard.stamp(element);
        const key = `${ticket.blockId}:${ticket.textFingerprint}`;
        if (ledger.has(key)) continue;
        ledger.add(key);
        if (alreadyTranslated(element, ticket.textFingerprint)) continue;
        tickets.set(element, ticket);
        blocks.push(block);
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

      running = true;
      status = STATUS.RUNNING;
      // 我们自己插译文引起的变动，发现层本来就认得出来。挂起是为了省掉插入期间
      // 那几十次「子树变了」带来的重复收集。
      if (discovery) discovery.suspend();

      let error = null;
      try {
        // 「已经是目标语言的就别翻了」是用户的设置，自动这一轮和手动那一轮认的是
        // 同一条（content/content-page-translation.js 在同一个位置调它）。不认，
        // 就是把他明确说过不必发的文字一轮一轮发出去。被滤掉的块此刻已经记进
        // 台账，发现层下次再送来也不会重来。
        const fresh = await ctx.filterBlocksByLanguage(blocks);
        if (fresh.length > 0) error = await ctx.runTranslationPass(fresh, { accept: acceptBlock });
      } catch (thrown) {
        console.error('Blab Translation: auto translation pass failed', thrown);
        error = (thrown && thrown.message) || String(thrown);
      } finally {
        running = false;
        tickets.clear();
        if (discovery) discovery.resume();
      }

      if (error) {
        broken = true;
        lastError = error;
        status = STATUS.ERROR;
        stopDiscovery();
        console.warn('Blab Translation: auto translation stopped for this page —', error);
        return;
      }

      status = STATUS.IDLE;
      if (queue.size > 0) scheduleStart();
    }

    // ------------------------------------------------------------------ 代次

    function bumpSession(why) {
      guard.bump(why);
      queue.clear();
      tickets.clear();
      ledger.clear();
    }

    function pauseCurrentPage() {
      if (status === STATUS.OFF || status === STATUS.PAUSED) return;
      bumpSession('paused');
      stopDiscovery();
      clearSample();
      status = STATUS.PAUSED;
    }

    function resumeCurrentPage() {
      if (status !== STATUS.PAUSED && status !== STATUS.ERROR) return;
      start();
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
      if (explicit) return;
      explicit = true;
      start();
    }

    function onRouteChange(change) {
      bumpSession(`route:${change && change.via}`);
      // 新的一页，用户还没表过态。
      explicit = false;
      start();
    }

    function onSettingsChanged(changes) {
      // 目标语言或引擎变了，在途的那些译文是按旧设置要来的。
      if ('targetLang' in changes || 'translationEngine' in changes) {
        bumpSession('settings');
      }
      // 用户自己喊停的页面不该因为改了个设置就又动起来。
      if (status === STATUS.PAUSED) return;
      if ('autoTranslate' in changes || 'siteRules' in changes ||
          'autoTranslateLangs' in changes || 'targetLang' in changes) {
        start();
      }
    }

    globalThis.SpaNavigation.onRouteChange(onRouteChange);
    start();

    return {
      state: () => ({
        status,
        reason,
        pageLang,
        error: lastError,
        sessionVersion: guard.version(),
        queued: queue.size
      }),
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
