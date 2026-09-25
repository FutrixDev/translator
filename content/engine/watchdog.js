// Blab Translation 翻译引擎 —— 卡死看门狗
//
// 进浏览器内置 Translator API 的每一次调用都要有上限，这一份就是那个上限：几档
// 超时和一个会被「还在动」往后推的死线。它不认识 Translator，只认识 Promise，所
// 以和引擎的其余部分分开放。
(function() {
  'use strict';

  // dormant frame（见 shared/frame-eligibility.js）里连空壳也不兜：兜了，后面每个
  // 模块的 `if (!ctx) return;` 就拦不住了。设置页没有 FrameEligibility，照旧兜。
  if (globalThis.FrameEligibility && !globalThis.FrameEligibility.shouldActivate()) return;
  const ctx = window.AI_TRANSLATOR_CONTENT || (window.AI_TRANSLATOR_CONTENT = {});
  // 这一族共用的架子，说明见 content/content-translation-engine.js 顶上。
  const eng = (ctx.engine = ctx.engine || {});

  // ==================== 卡死看门狗 ====================

  // Translator API 的三个入口（availability / create / translate）都没有超时：
  // 出问题时它们不 reject，只是永远不 settle。而引擎缓存的是 Promise，整页几十个
  // 块会一起 await 同一个不会 settle 的 create()——进度条停在 0%、不报错，也永远
  // 走不到回落 AI 那一步。回落逻辑一直是好的，缺的是有人先认输。
  //
  // 所以规则是：进内置 API 的每一次调用都必须有上限。这个边界到 Translator 为止，
  // 再往外（chrome.i18n.detectLanguage 之类）不在此列。
  //
  // 但 create() 不能简单地设一个总时长上限：首次下载语言包是几十 MB，慢网上花几
  // 分钟属于正常，一刀切只会砍掉一个本来能成的功能。所以下载这条路不看总时长，
  // 只看“还动不动”——每个 downloadprogress 事件把死线往后推。设置页那个用户手点
  // 的下载按钮因此不受影响：只要还在下，死线就一直在往后走；而它真卡住时，按钮
  // 也不会再一直转下去。
  //
  // “还没开始”和“下得慢”是两回事，窗口也分两档。实测（headless Chrome，
  // en→zh，availability 返回 downloadable）：卡住的 create() 一个
  // downloadprogress 都不发，一个事件都等不到。所以第一个事件之前给的是短窗口
  // ——真的开始下了，浏览器很快就会报第一次进度；等不到就是根本没动起来。
  // 一旦有了第一个事件，窗口放宽到一分钟：慢链路上两次进度之间安静一阵是正常的。
  const AVAILABILITY_TIMEOUT_MS = 15000;
  const CREATE_TIMEOUT_MS = 20000;
  const DOWNLOAD_START_MS = 30000;
  const DOWNLOAD_STALL_MS = 60000;
  // translate() 是端上推理，不走网络，一段正常一两秒。但整页翻译有 12 路并发压在
  // 同一个模型上，排队会把单次观察到的耗时放大好几倍，所以这条线要留得很宽：
  // 它的作用是给“永远不返回”封顶，不是给延迟设指标。
  const TRANSLATE_TIMEOUT_MS = 120000;

  class TimeoutError extends Error {
    constructor(what) {
      super(`builtin translator ${what} timed out`);
      this.name = 'TimeoutError';
    }
  }

  /**
   * 给一个可能永远不 settle 的 Promise 加一条死线。
   * bump() 把死线整体往后推，用来表达“只要还在动就继续等”；
   * 带上 nextMs 则同时换掉之后的窗口（第一次进度之后要放宽，见上）。
   */
  function stallWatchdog(ms, what) {
    let timer = null;
    let stopped = false;
    let onStall;
    const stalled = new Promise((resolve, reject) => {
      onStall = () => reject(new TimeoutError(what));
    });

    function bump(nextMs) {
      if (stopped) return;
      if (typeof nextMs === 'number') ms = nextMs;
      clearTimeout(timer);
      timer = setTimeout(onStall, ms);
    }

    function stop() {
      stopped = true;
      clearTimeout(timer);
    }

    bump();
    return {
      bump,
      /**
       * race 会给 call 挂上处理函数，所以输的那一路之后再 reject 也只是被丢掉，
       * 不会变成 unhandled rejection。call 用函数传进来，是为了让同步抛出的异常
       * 也落进这条链，而不是绕过看门狗直接炸给调用方。
       */
      guard(call) {
        const promise = new Promise((resolve) => resolve(call()));
        return Promise.race([promise, stalled]).then(
          (value) => { stop(); return value; },
          (error) => { stop(); throw error; }
        );
      }
    };
  }

  eng.TIMEOUTS = {
    AVAILABILITY: AVAILABILITY_TIMEOUT_MS,
    CREATE: CREATE_TIMEOUT_MS,
    DOWNLOAD_START: DOWNLOAD_START_MS,
    DOWNLOAD_STALL: DOWNLOAD_STALL_MS,
    TRANSLATE: TRANSLATE_TIMEOUT_MS
  };
  eng.TimeoutError = TimeoutError;
  eng.stallWatchdog = stallWatchdog;
})();
