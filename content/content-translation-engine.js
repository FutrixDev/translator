// Blab Translation Content Script Translation Engine
//
// 两条翻译后端，一个统一入口：
//
//   ctx.requestTranslation(message)  ——  与 chrome.runtime.sendMessage 同形，响应多盖一个 engine
//
// 默认走浏览器内置的 Translator API（Chrome 138+，端上 NMT，零网络、零费用）；
// 内置这条路走不通时，再回落到 background service worker 里的自定义 AI 接口。
//
// 为什么内置引擎必须放在 content script：Translator 的 WebIDL 标注是
// [Exposed=Window, SecureContext]，MV3 的 background 是 service worker，
// 拿不到这个接口。所以整条内置链路只能在 content script 里跑，
// background 那条 AI 老路原样保留，一行没动。
//
// 引擎是一族经典脚本，共用一个架子 `ctx.engine`：
//
//   content/engine/languages.js   语言码、引擎认哪些语言、源语言探测（整页/单段/输入框）
//   content/engine/watchdog.js    进 Translator API 的每一次调用都要有的那条死线
//   这一份（入口）                选哪条后端、内置翻译本身、回落与预算闸、对外接口
//
// 跨文件的名字一律写成 `eng.foo`、调用时才取，所以这一族谁先装都行。
(function() {
  'use strict';

  // 设置页也加载这个文件，用来查语言包状态、按钮触发首次下载（那里有真实用户手势）。
  // 设置页没有 content script 那套 ctx，所以这里自己兜一个空壳：
  // 只有 ctx.builtinTranslator 那部分会被设置页用到。
  // dormant frame（见 shared/frame-eligibility.js）里连空壳也不兜：兜了，后面每个
  // 模块的 `if (!ctx) return;` 就拦不住了。设置页没有 FrameEligibility，照旧兜。
  if (globalThis.FrameEligibility && !globalThis.FrameEligibility.shouldActivate()) return;
  const ctx = window.AI_TRANSLATOR_CONTENT || (window.AI_TRANSLATOR_CONTENT = {});
  const settings = ctx.settings || (ctx.settings = {});
  const eng = (ctx.engine = ctx.engine || {});

  // ==================== 环境探测 ====================

  // isSecureContext 这一条是真会命中的：http:// 页面上 content script 继承文档的
  // 非安全上下文，Translator 直接不存在。这类页面静默回落到 AI 接口。
  function hasTranslatorApi() {
    return typeof self !== 'undefined'
      && typeof self.Translator !== 'undefined'
      && typeof self.Translator.create === 'function';
  }

  function isBuiltinSupported() {
    return hasTranslatorApi() && self.isSecureContext === true;
  }

  // 用不了内置引擎时，用户该听到的是原因，不是一句“不可用”。版本是唯一能独立
  // 知道的事实：Translator 是 SecureContext 接口，http:// 页面上它本来就不存在，
  // 光看“在不在”分不出“浏览器太旧”和“这页是 http”。
  //
  // 降级 UA 之后 userAgentData 只在安全上下文里有，所以 UA 字符串那条回落不是
  // 多余的——http:// 页面恰好只剩它。
  function chromeMajorVersion() {
    const nav = typeof navigator !== 'undefined' ? navigator : null;
    if (!nav) return 0;
    const brands = (nav.userAgentData && nav.userAgentData.brands) || [];
    for (const entry of brands) {
      // brands 里混着一条随机的 GREASE 品牌，只认这两个真名。
      if (entry && (entry.brand === 'Google Chrome' || entry.brand === 'Chromium')) {
        const major = parseInt(entry.version, 10);
        if (major > 0) return major;
      }
    }
    const match = /Chrom(?:e|ium)\/(\d+)/.exec(nav.userAgent || '');
    return match ? parseInt(match[1], 10) : 0;
  }

  function builtinUnsupportedReason() {
    return globalThis.EngineStatus.builtinUnsupportedReason({
      secureContext: typeof self !== 'undefined' && self.isSecureContext === true,
      hasTranslator: hasTranslatorApi(),
      chromeMajor: chromeMajorVersion()
    });
  }

  /**
   * 选的是内置引擎吗。`auto` 为真时问的是自动模式那一边。
   *
   * 自动模式有**自己的**引擎设置（PRD FR-9 的 `autoTranslateEngine`，默认
   * `builtin`），手动那一边选了什么与它无关。这不是一条可以省的分支：「自动翻译
   * 默认开着」能成立的全部底气就是它默认免费，而把两边合成一个问题的后果是，一
   * 个为了划词翻译把引擎切到 AI 的用户，从此每一个页面的自动翻译都被费用闸整个
   * 拦掉 —— 满屏原文，没有任何解释。
   *
   * 设置缺失时按 builtin 处理：内置是默认引擎，只有用户显式选了 'ai' 才走自定义接口。
   */
  function isBuiltinSelected(auto) {
    return (auto ? settings.autoTranslateEngine : settings.translationEngine) !== 'ai';
  }

  function shouldUseBuiltin(auto) {
    return isBuiltinSelected(auto) && isBuiltinSupported();
  }

  // ==================== 错误分级 ====================

  // 引擎级失败（整条内置链路用不了）与单条失败（这一段没译好）要分开处理：
  // 前者应当整批放弃、回落 AI；后者只能丢掉这一段，不能让一段拖垮整页。
  const ENGINE_REASONS = {
    UNSUPPORTED_ENV: 'unsupportedEnv',
    UNSUPPORTED_PAIR: 'unsupportedPair',
    NEEDS_DOWNLOAD: 'needsDownload',
    CREATE_FAILED: 'createFailed',
    // 内置 API 卡住了（见 content/engine/watchdog.js）。对用户来说和“暂时用不了”是一回事，
    // engineErrorMessage 的 default 分支就是它的文案；单独列一档是为了让日志和
    // 回落决策能把“报错了”和“没反应”分开。
    TIMED_OUT: 'timedOut'
  };

  class EngineUnavailableError extends Error {
    constructor(reason) {
      super(`builtin translator unavailable: ${reason}`);
      this.name = 'EngineUnavailableError';
      this.reason = reason;
    }
  }

  // ==================== Translator 实例 ====================

  // 缓存的是 Promise 而不是实例：整页翻译会在同一瞬间发起几十个块，
  // 缓存实例的话它们会各自 create 一遍，而 create() 是这套 API 里最贵的一步。
  const translators = new Map();

  function instanceKey(src, tgt) {
    return `${src}>${tgt}`;
  }

  // 三处都要问可用性（翻译前、预取、设置页探测），走同一个入口，
  // 免得有一处漏了超时又能一直挂着。
  function probeAvailability(src, tgt) {
    return eng.stallWatchdog(eng.TIMEOUTS.AVAILABILITY, 'availability').guard(
      () => self.Translator.availability({ sourceLanguage: src, targetLanguage: tgt })
    );
  }

  function getTranslator(src, tgt, allowDownload, onProgress) {
    const key = instanceKey(src, tgt);
    const cached = translators.get(key);
    if (cached) return cached;

    // 有下载才有 downloadprogress 可看；语言包已就绪时 create() 只是建个会话，
    // 是本地操作，给一个固定的短上限就够。
    const watchdog = eng.stallWatchdog(allowDownload ? eng.TIMEOUTS.DOWNLOAD_START : eng.TIMEOUTS.CREATE, 'create');
    const controller = typeof AbortController === 'function' ? new AbortController() : null;

    const options = { sourceLanguage: src, targetLanguage: tgt };
    if (controller) options.signal = controller.signal;
    if (allowDownload) {
      options.monitor = (monitor) => {
        monitor.addEventListener('downloadprogress', (event) => {
          // 有动静了：死线往后推，并且从这里开始用宽窗口。
          watchdog.bump(eng.TIMEOUTS.DOWNLOAD_STALL);
          const loaded = typeof event.loaded === 'number' ? event.loaded : 0;
          const handler = onProgress || ctx.onBuiltinDownloadProgress;
          if (typeof handler === 'function') handler(loaded, src, tgt);
        });
      };
    }

    const pending = watchdog.guard(() => self.Translator.create(options)).then(
      (translator) => {
        if (allowDownload) notifyDownloadEnded();
        return translator;
      },
      (error) => {
        // 失败不留缓存，否则整页翻译会一直复用同一个坏 Promise，
        // 用户改完设置重试也还是同一个错误。
        translators.delete(key);
        // 卡住的下载不会自己好，别让浏览器还挂着它。
        if (error instanceof eng.TimeoutError && controller) {
          try { controller.abort(error); } catch (abortError) { /* 已经结束了 */ }
        }
        if (allowDownload) notifyDownloadEnded();
        throw error;
      }
    );

    translators.set(key, pending);
    return pending;
  }

  // 下载这一程结束了（下完、失败、或者卡住被放弃）。进度条上这时可能正写着
  // “正在下载语言包 30%”，回落到 AI 之后那行字会一直留在那儿骗人，所以要把
  // 进度条交还给翻译进度。设置页有自己的状态行，不挂这个钩子。
  function notifyDownloadEnded() {
    if (typeof ctx.onBuiltinDownloadEnded !== 'function') return;
    try { ctx.onBuiltinDownloadEnded(); } catch (error) { /* 页面已经走了 */ }
  }

  // 卡住的会话不会自己缓过来，留在缓存里只会让后面每一段再等一次超时。
  function dropTranslator(src, tgt) {
    const key = instanceKey(src, tgt);
    const pending = translators.get(key);
    if (!pending) return;
    translators.delete(key);
    pending.then((translator) => {
      try { translator.destroy(); } catch (error) { /* 已销毁或页面正在卸载 */ }
    }, () => {});
  }

  function destroyAll() {
    translators.forEach((pending) => {
      pending.then((translator) => {
        try { translator.destroy(); } catch (error) { /* 已销毁或页面正在卸载 */ }
      }, () => {});
    });
    translators.clear();
  }

  // ==================== 数学占位符 ====================

  const PLACEHOLDER_RE = /\{\{(\d+)\}\}/g;

  function placeholderIds(text) {
    const ids = new Set();
    PLACEHOLDER_RE.lastIndex = 0;
    let match;
    while ((match = PLACEHOLDER_RE.exec(String(text || ''))) !== null) {
      ids.add(match[1]);
    }
    return ids;
  }

  // 内置的是 NMT 模型，不像 LLM 那样会遵守“把 {{1}} 原样保留”这种指令，
  // 它可能把占位符拆开、翻掉或整个吞掉。而 restoreMathElements 对缺失的占位符
  // 是静默跳过的——公式会从页面上凭空消失，且不报任何错。
  // 所以这里宁可判本段翻译失败让原文留着，也不返回一个会吞掉公式的译文。
  function keepsPlaceholders(source, translated) {
    const before = placeholderIds(source);
    if (before.size === 0) return true;
    const after = placeholderIds(translated);
    if (before.size !== after.size) return false;
    for (const id of before) {
      if (!after.has(id)) return false;
    }
    return true;
  }

  // ==================== 翻译 ====================

  const QUOTA_FALLBACK_CHARS = 1200;

  function isQuotaError(error) {
    if (!error) return false;
    if (error.name === 'QuotaExceededError') return true;
    return /quota|too (long|large)|exceed/i.test(String(error.message || ''));
  }

  function isActivationError(error) {
    if (!error) return false;
    if (error.name === 'NotAllowedError') return true;
    return /user (activation|gesture)/i.test(String(error.message || ''));
  }

  function splitForQuota(text) {
    // 复用整页翻译那套切块器：它保证不会把 {{n}} 占位符从中间切开。
    if (typeof ctx.splitTextIntoChunks === 'function') {
      const chunks = ctx.splitTextIntoChunks(text, QUOTA_FALLBACK_CHARS);
      if (chunks.length > 0) return chunks;
    }
    const chunks = [];
    for (let i = 0; i < text.length; i += QUOTA_FALLBACK_CHARS) {
      chunks.push(text.slice(i, i + QUOTA_FALLBACK_CHARS));
    }
    return chunks;
  }

  function translateOnce(translator, text) {
    return eng.stallWatchdog(eng.TIMEOUTS.TRANSLATE, 'translate').guard(() => translator.translate(text));
  }

  async function runTranslate(translator, text) {
    // 先整段送：NMT 同样吃句子边界和上下文，切得越碎译文越差，
    // 所以只有真的撞到配额上限才退化成分段。
    try {
      return await translateOnce(translator, text);
    } catch (error) {
      if (!isQuotaError(error)) throw error;
    }

    const chunks = splitForQuota(text);
    const parts = [];
    for (const chunk of chunks) {
      parts.push(await translateOnce(translator, chunk));
    }
    return parts.join('');
  }

  /**
   * 用内置引擎翻译一段文本。
   *
   * 抛 EngineUnavailableError 表示整条内置链路当前不可用（应整批放弃并回落 AI）；
   * 其它异常表示这一段没译成（只丢这一段）。
   */
  async function translateWithBuiltin(text, targetLang, options = {}) {
    if (!isBuiltinSupported()) {
      throw new EngineUnavailableError(ENGINE_REASONS.UNSUPPORTED_ENV);
    }

    const source = String(text == null ? '' : text);
    if (!source.trim()) return source;

    const tgt = eng.toApiLang(targetLang);
    const src = await eng.resolveSourceLang(source, options.sourceLang, options.standaloneText, options.pageSourceLang);

    if (!src || !tgt) throw new EngineUnavailableError(ENGINE_REASONS.UNSUPPORTED_PAIR);
    // 同语言不需要翻译。原样返回，与 AI 那条路“已是目标语言则原样返回”的约定一致。
    if (src === tgt) return source;
    if (!eng.supportsLang(src) || !eng.supportsLang(tgt)) {
      throw new EngineUnavailableError(ENGINE_REASONS.UNSUPPORTED_PAIR);
    }

    // 已经建好实例的语言对不必再问 availability：能建出来本身就说明可用。
    // 整页翻译对同一语言对会发起成百上千次调用，每次都问一遍纯属浪费往返。
    let needsDownload = false;
    if (!translators.has(instanceKey(src, tgt))) {
      let status;
      try {
        status = await probeAvailability(src, tgt);
      } catch (error) {
        // 问都问不出来，那不是这个语言对的问题：判成 UNSUPPORTED_PAIR 的话，
        // 批量里每一段都会再问一次、再等一次超时。
        if (error instanceof eng.TimeoutError) throw new EngineUnavailableError(ENGINE_REASONS.TIMED_OUT);
        throw new EngineUnavailableError(ENGINE_REASONS.UNSUPPORTED_PAIR);
      }
      if (status === 'unavailable') {
        throw new EngineUnavailableError(ENGINE_REASONS.UNSUPPORTED_PAIR);
      }

      // 语言包是几十 MB 级别的下载，且 create() 触发下载要求 user activation。
      // 悬停这种“鼠标扫过就翻”的场景不该卡在下载上，也基本不带 activation，
      // 所以只有在确有用户手势时才允许触发下载，否则报 needsDownload 走回落，
      // 由设置页那个带进度条的按钮来做正经的首次下载。
      needsDownload = status !== 'available';
      if (needsDownload) {
        const allowDownload = options.allowDownload === true
          || (options.allowDownload !== false && !!navigator.userActivation?.isActive);
        if (!allowDownload) {
          // 这一页确实要这个包、这个包确实不在本地 —— 比加载时那次探测更硬的证据，
          // 且 src/tgt 现成。挂上预取，用户下一次点击就把它取回来。
          // 不排除 iframe：iframe 里的点击落在 iframe 自己的 window 上，顶层那份
          // 监听收不到；这条路不用探测，多挂一份不花任何往返。
          if (ctx.armLanguagePackPrefetch) ctx.armLanguagePackPrefetch(src, tgt);
          throw new EngineUnavailableError(ENGINE_REASONS.NEEDS_DOWNLOAD);
        }
      }
    }

    let translator;
    try {
      translator = await getTranslator(src, tgt, needsDownload);
    } catch (error) {
      if (isActivationError(error)) {
        // 手势过期了（activation 只有几秒，前面那几次 IPC 就能耗掉）。同上：挂预取。
        if (ctx.armLanguagePackPrefetch) ctx.armLanguagePackPrefetch(src, tgt);
        throw new EngineUnavailableError(ENGINE_REASONS.NEEDS_DOWNLOAD);
      }
      if (error instanceof eng.TimeoutError) {
        throw new EngineUnavailableError(ENGINE_REASONS.TIMED_OUT);
      }
      throw new EngineUnavailableError(ENGINE_REASONS.CREATE_FAILED);
    }

    let translated;
    try {
      translated = await runTranslate(translator, source);
    } catch (error) {
      // 会话卡住是整条链路的事，不是这一段的事：扔掉它，让整批回落 AI，
      // 否则后面每一段都会在同一个坏会话上再耗一次超时。
      if (error instanceof eng.TimeoutError) {
        dropTranslator(src, tgt);
        throw new EngineUnavailableError(ENGINE_REASONS.TIMED_OUT);
      }
      throw error;
    }
    if (typeof translated !== 'string' || !translated.trim()) {
      throw new Error('builtin translator returned empty result');
    }
    if (!keepsPlaceholders(source, translated)) {
      throw new Error('builtin translator dropped math placeholders');
    }
    return translated;
  }

  // ==================== AI 回落判定 ====================

  // 内置引擎顶不住时要不要回落到用户自己的接口，取决于用户的接口配没配好。
  // 没配好却回落过去，用户只会收到一句“请先配置 API Key”——
  // 而真正的原因是“这个语言对内置引擎不支持”或“语言包还没下”。
  //
  // 「配好」不是「有 Key」：本地模型（Ollama / LM Studio、回环或局域网端点）不要
  // Key。答案只有一处，APICompat.isApiKeyMissing（shared/api-compat.js），它只看
  // 这三个键，于是这里缓存的也就是这三个键。null = 还没读过。
  const AI_CONFIG_KEYS = ['provider', 'apiEndpoint', 'apiKey'];
  let aiConfig = null;

  async function refreshAiConfig() {
    try {
      aiConfig = await chrome.storage.sync.get({ provider: '', apiEndpoint: '', apiKey: '' });
    } catch (error) {
      aiConfig = { provider: '', apiEndpoint: '', apiKey: '' };
    }
    return aiConfig;
  }

  function aiConfigured() {
    return !!aiConfig && !globalThis.APICompat.isApiKeyMissing(aiConfig);
  }

  // 选内置引擎就是选了“零费用”。内置这条路走不通时悄悄改走用户自己的接口，
  // 花的是他的钱，而他从没同意过这件事——所以回退默认关闭，开了才回退。
  async function canFallBackToAI() {
    if (settings.engineFallback !== 'allow-ai') return false;
    if (!aiConfig) await refreshAiConfig();
    return aiConfigured();
  }

  /**
   * 这一刻，一次翻译请求实际会走到哪里：`'builtin'` | `'ai'` | `'none'`。
   * `{ auto: true }` 问的是自动模式那一边（它有自己的引擎设置，见
   * isBuiltinSelected）。
   *
   * 三个谓词（isBuiltinSelected / isBuiltinSupported / canFallBackToAI）拼出来的
   * 那句话，调度层要问、而它一个都不该自己重算 —— 重算就是第二个答案，而两个
   * 答案迟早会在某个 http:// 页面上分叉。
   *
   * `'none'` 是 FR-9.1 的那一格：选了「仅本地引擎」，而这一页给不出内置引擎。
   * 对自动模式它意味着**这一页不自动翻**，不是「试试看再说」—— 试的结果是三次
   * 批次失败之后一句「翻译失败」，而真实情况是用户自己选的。
   *
   * 说的是「会走到哪」，不是「一定走到那」：判 'builtin' 之后，某一批仍可能在
   * 内置引擎上失败并按 engineFallback 回落到 AI。那一下花的钱由下面
   * requestTranslation 末尾那道预算闸把关。
   */
  async function effectiveEngine({ auto = false } = {}) {
    if (shouldUseBuiltin(auto)) return 'builtin';
    if (!isBuiltinSelected(auto)) return 'ai';
    return (await canFallBackToAI()) ? 'ai' : 'none';
  }

  /**
   * 自动模式要花钱之前的那道闸（PRD FR-9）。
   *
   * 只有零点击的请求经过这里 —— 手动翻译是用户一次一次点出来的，他知道自己
   * 在花钱。零点击的有两条路，两条都记在同一个 autoAiChars 上：
   *
   * - `message.auto`：自动整页翻译。它同时决定走哪个引擎（自动模式那一个）。
   * - `message.unattended`：视频字幕（shared/caption-core.js 的
   *   buildTranslationRequest）。它沿用手动那个引擎 —— 字幕跟着播放头走，
   *   换引擎等于换一种译法 —— 但视频一播，每一句都在花钱，没人一句一句点。
   *   只挡 auto 的时候，一部两小时的电影可以在额度用完之后照样把 AI 花下去。
   *
   * 这里**只问预算**，不再问「自动模式允不允许用 AI」。那个问题上面已经答过
   * 了，而且答得更细：自动模式选的引擎由 isBuiltinSelected(true) 决定，内置顶
   * 不住时能不能改走 AI 由 canFallBackToAI() 决定。能走到这一行的自动请求只有
   * 两种，两种都是用户点过头的 —— 他把自动模式的引擎切成了 AI（要过一道二次确
   * 认），或者他开了「本地不可用时允许用我配置的接口」。在这里再问一遍，就是
   * 同一个问题的第二个答案，而它会把后一种人的回退整个吃掉：内置引擎在 http://
   * 页面上本来就不存在，那正是回退存在的理由。
   *
   * 预算这一问，问和记是同一次操作，走服务工作者那条单写者队列 —— 一轮里八个
   * 批次同时出发，八次各读各的再各记各的，闸门等于不存在。
   *
   * 返回一句给用户看的话表示拒绝，`null` 表示放行。
   */
  async function refuseAutoAiSpend(message) {
    if (!message || !(message.auto || message.unattended)) return null;
    const t = ctx.t || ((key) => key);
    const chars = Array.isArray(message.texts)
      ? globalThis.AutoStats.textsChars(message.texts)
      : String(message.text == null ? '' : message.text).length;
    const verdict = await globalThis.AutoStats.charge(chars, settings.autoAiDailyBudget);
    return verdict.allowed ? null : t('autoBudgetSpent');
  }

  // 真的回退了就留一条痕迹，本页内存里，popup 一问就报出来。
  // 不落存储：这件事是这一页的事，页面走了它就该消失。
  let lastFallback = null;

  function noteFallback(reason) {
    lastFallback = { reason, at: Date.now() };
  }

  if (chrome?.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, namespace) => {
      if (namespace !== 'sync') return;
      // 三个键任一变了就把新值并进缓存；还没读过就不并 —— 只并进一个键会把另外
      // 两个当成空，下一次 canFallBackToAI 自己去读整份就是了。
      if (aiConfig) {
        for (const key of AI_CONFIG_KEYS) {
          if (changes[key]) aiConfig = { ...aiConfig, [key]: changes[key].newValue };
        }
      }
      // 语言对可能因为设置改了目标语言而变化，页面语言缓存不受影响，
      // 但已建好的实例是按语言对缓存的，无需清理。
    });
  }

  // targetLang 是这次请求的目标语言。语言对不行时先分清是不是目标语言本身端上译不了：
  // 是的话点名（76 门里大半只有 AI 能译），否则才是笼统的「这一对不行」（多半是源语言）。
  // 走到这里的都是不能回退 AI 的请求，所以只有 LocalOnly 那一句。
  function engineErrorMessage(reason, targetLang) {
    const t = ctx.t || ((key) => key);
    switch (reason) {
      case ENGINE_REASONS.NEEDS_DOWNLOAD:
        return t('builtinNeedsDownload');
      case ENGINE_REASONS.UNSUPPORTED_PAIR:
        if (targetLang && !eng.supportsTarget(targetLang)) {
          return t('builtinTargetUnsupportedLocalOnly')
            .replace('{lang}', ctx.languageName(targetLang, { inSentence: true }));
        }
        return t('builtinUnsupportedPair');
      case ENGINE_REASONS.UNSUPPORTED_ENV:
        return t('builtinUnsupportedEnv');
      default:
        return t('builtinUnavailable');
    }
  }

  // ==================== 统一入口 ====================

  async function handleWithBuiltin(message) {
    const targetLang = message.targetLang;
    const shared = {
      sourceLang: message.sourceLang,
      allowDownload: message.allowDownload,
      // 输入框的文本是用户自己敲的，与页面无关。见 content/engine/languages.js 的
      // resolveSourceLang。
      standaloneText: message.standaloneText === true,
      // 子 frame 经中继发来的请求自带页面语言（content/frames/child.js）。
      pageSourceLang: message.pageSourceLang
    };

    switch (message.type) {
      case 'TRANSLATE': {
        const translation = await translateWithBuiltin(message.text, targetLang, shared);
        // 内置是纯翻译模型，给不出音标，所以词典模式退化成普通翻译：
        // isWord 保持 false，调用方据此不显示音标行和发音按钮。
        return { translation, phonetic: '', isWord: false };
      }

      case 'TRANSLATE_BATCH':
      case 'TRANSLATE_BATCH_FAST': {
        const texts = Array.isArray(message.texts) ? message.texts : [];
        // 目标语言不支持是整批（乃至整页）都成立的事实，先判掉整批抛出去，
        // 别让每一段各自撞一次同一堵墙。
        if (!eng.supportsTarget(targetLang)) {
          throw new EngineUnavailableError(ENGINE_REASONS.UNSUPPORTED_PAIR);
        }
        const translations = [];
        // “丢掉这一段”只有在别的段译出来了才说得通。一段没译出来是这一段的问题，
        // 整批一段都没译出来就不是了，那是这条链路在这批文本上根本没工作。
        let attempted = 0;
        let produced = 0;
        for (const text of texts) {
          const hasContent = !!String(text == null ? '' : text).trim();
          if (hasContent) attempted += 1;
          try {
            const translated = await translateWithBuiltin(text, targetLang, shared);
            translations.push(translated);
            if (hasContent && translated) produced += 1;
          } catch (error) {
            // 环境不支持 / 语言包没下 / 实例建不出来，这些对每一段都成立，
            // 抛出去让整批回落 AI。而“语言对不支持”此时只可能来自这一段自己的
            // 源语言（目标语言上面已经验过了），那是单段的事，丢它一段就行。
            if (error instanceof EngineUnavailableError
                && error.reason !== ENGINE_REASONS.UNSUPPORTED_PAIR) {
              throw error;
            }
            console.warn('Blab Translation: builtin segment failed, keeping original', error);
            // 空串而不是原文：上层对 falsy 译文是“跳过、保留原文”，
            // 回填原文反而会被当成一条有效译文插进页面。
            translations.push('');
          }
        }
        // 一批空串在调用方眼里是“翻译成功了，只是每条都没译文”：它保留原文、
        // 不报错，也不会回落 AI——用户配了接口却什么都没发生。抛出去，让上层
        // 按引擎不可用处理（有接口就回落，没接口就把原因说清楚）。
        if (attempted > 0 && produced === 0) {
          throw new EngineUnavailableError(ENGINE_REASONS.UNSUPPORTED_PAIR);
        }
        // 逐条翻译，条数天然与输入一致——分隔符那套错位问题在这条路上不存在。
        return { translations };
      }

      default:
        return null;
    }
  }

  // 一次请求可以指名要哪个引擎（划词卡片上的「换引擎」）。只认这两个值：写错了
  // 是调用方的 bug，当成没传就会悄悄按设置走，和用户点的那颗按钮对不上。
  const PINNABLE_ENGINES = new Set(['builtin', 'ai']);

  /**
   * 这一次请求指名的引擎：'builtin' | 'ai'，没指名是 undefined。「指名」只在这一
   * 处判定，优先级（wantsBuiltin）与不回落（requestTranslation）都问它。
   */
  function pinnedEngine(message) {
    const engine = message.engine;
    if (engine !== undefined && !PINNABLE_ENGINES.has(engine)) {
      throw new Error(`requestTranslation: unknown engine ${JSON.stringify(engine)}`);
    }
    return engine;
  }

  /**
   * 这一次要不要走内置引擎。优先级：这一次请求指名的 message.engine > 站点覆盖
   * （P1-B 的 engineOverride，将来加在这里）> 设置（isBuiltinSelected）。显式的
   * 一次请求压过任何偏好。
   */
  function wantsBuiltin(message, auto) {
    const pinned = pinnedEngine(message);
    if (pinned !== undefined) return pinned === 'builtin';
    return isBuiltinSelected(auto);
  }

  /**
   * 翻译请求统一入口，与 chrome.runtime.sendMessage 同形（同样的入参、同样的返回），
   * 只多一个字段：每个响应都盖上 `engine`（'builtin' | 'ai'），说这一次是谁译的
   * （出错时说是谁没译成）。调用方不需要知道这次走的是内置还是 AI，但卡片要告诉
   * 用户。
   *
   * `message.engine` 指名了引擎就**不回落**：用户点的就是「用内置」，内置顶不住
   * 就把真实原因给他看，不能换一个引擎、花他的钱把结果递回去（engineFallback 为
   * 'allow-ai' 也一样）；指名 'ai' 就完全跳过内置那一段。指名什么都不持久化。
   */
  ctx.requestTranslation = async function(message) {
    const pinned = pinnedEngine(message);
    // 自动发来的请求问的是另一张开关（autoTranslateEngine）。同一个函数、两套
    // 选择，是因为调用方只有一个：谁也不该为了「这一次是自动的」另走一条路。
    const auto = !!message.auto;
    const builtin = wantsBuiltin(message, auto);
    // 回落只在没指名引擎时才有：指名了就是这一个引擎的答案，成败都是它的。
    const mayFallBack = async () => pinned === undefined && canFallBackToAI();
    if (builtin && !isBuiltinSupported()) {
      // 选的是内置引擎，但这个环境给不了：Chrome 版本过低，或者页面是 http://
      // （content script 继承文档的非安全上下文，Translator 压根不存在）。
      // 用户开了回退就顶上，并留痕；没开就把真实原因说清楚，别让他收到一句
      // 与实际问题无关的“请先配置 API Key”。
      if (!(await mayFallBack())) {
        return { error: engineErrorMessage(ENGINE_REASONS.UNSUPPORTED_ENV), engine: 'builtin' };
      }
      // 环境这条路能问出更细的原因（版本 / http），比笼统的 unsupportedEnv 好。
      noteFallback(builtinUnsupportedReason() || ENGINE_REASONS.UNSUPPORTED_ENV);
    } else if (builtin) {
      let result = null;
      try {
        result = await handleWithBuiltin(message);
      } catch (error) {
        const unavailable = error instanceof EngineUnavailableError;
        const reason = unavailable ? error.reason : ENGINE_REASONS.CREATE_FAILED;
        if (!unavailable) console.warn('Blab Translation: builtin translation failed', error);
        if (!(await mayFallBack())) return { error: engineErrorMessage(reason, message.targetLang), engine: 'builtin' };
        if (unavailable) console.info('Blab Translation: builtin unavailable (%s), falling back to AI', reason);
        noteFallback(reason);
      }
      if (result) return { ...result, engine: 'builtin' };
      // 走到这里而指名了内置，只可能是内置引擎不认识这种请求类型（不是 TRANSLATE /
      // 批量；那种请求一向交给 AI）——指名了内置却发来它，是调用方写错了。
      if (pinned) {
        throw new Error(`requestTranslation: the builtin engine cannot handle ${message.type}`);
      }
    }
    // 这一行是**唯一**一个「发给模型」的出口：选了 AI 走到这里，选了内置但这
    // 个环境/这门语言顶不住、而且用户开了回退，也走到这里。自动模式的预算闸
    // 因此只能装在这里 —— 装在调度层只挡得住前一半，运行中那次回落会绕过去。
    // 拒绝带上 budgetSpent：调用方要分得清「今天的额度花完了」和「这一批出错
    // 了」—— 前者要跟用户说清楚、等明天或等他调额度，后者只是过几秒再试。
    const refusal = await refuseAutoAiSpend(message);
    if (refusal) return { error: refusal, budgetSpent: true, engine: 'ai' };
    const response = await chrome.runtime.sendMessage(message);
    return response && { ...response, engine: 'ai' };
  };

  /**
   * 卡片上「换引擎」问的：译成 targetLang，两边此刻各能不能用。AI 那边先重读一次
   * 配置 —— 设置页刚填好 Key，这一页的缓存还是旧的。内置那边除了环境，还要端上
   * 有这门目标语言：问的是 eng.supportsTarget，和页内语言菜单标「仅 AI」的是同一个
   * 谓词，不然卡片会对一门「仅 AI」的语言提供「改用内置」，点了只换来一句报错。
   */
  ctx.engineChoices = async function(targetLang) {
    await refreshAiConfig();
    return {
      builtin: isBuiltinSupported() && eng.supportsTarget(targetLang),
      ai: aiConfigured(),
    };
  };

  // ==================== 对外接口 ====================

  /**
   * 「我们此刻往哪门语言译」。
   *
   * 落笔端把这个答案记进译文的身份里（shared/block-identity.js 的 lang），收集端
   * 拿它去问「挂在这一块上的译文还是这门语言的吗」。两边必须走同一个入口，否则
   * 一边记原样设置、一边记归一化后的写法，每一块都判成陈旧。
   *
   * 归一化过：zh-CN 和 zh 到了引擎那边是同一门语言，用户在设置里换个写法不该把
   * 整页重翻一遍。空（跟随浏览器语言）归一成空串。
   */
  function currentTargetLang() {
    return eng.toApiLang(settings.targetLang) || '';
  }

  ctx.currentTargetLang = currentTargetLang;

  // popup 问的是“这一页现在能不能用内置引擎”。环境那一半是同步的，永远答得出；
  // 语言对那一半要跑 IPC，给它一个预算，超了就报 'unknown'——“没查出来”和
  // “查出来是坏的”对用户是两件事，不能混成同一句话。
  function withinBudget(ms, run) {
    return Promise.race([
      Promise.resolve().then(run).catch(() => 'unknown'),
      new Promise((resolve) => setTimeout(() => resolve('unknown'), ms))
    ]);
  }

  async function probeStatus({ budgetMs = 250 } = {}) {
    const result = {
      engine: isBuiltinSelected() ? 'builtin' : 'ai',
      supported: isBuiltinSupported(),
      reason: '',
      availability: 'unknown',
      lastFallback
    };
    if (result.engine !== 'builtin') return result;
    if (!result.supported) {
      result.reason = builtinUnsupportedReason();
      return result;
    }
    // 这里问的是「这一页现在能不能用内置引擎」，要的是真会发出去的那一门语言，
    // 所以读解析后的结果而不是 settings.targetLang 的原值：空串在身份那一侧是
    // 「跟随浏览器」的哨兵（见 currentTargetLang），在这里当成它自己会让所有还
    // 没选过语言的用户看到「不可用」。
    const tgt = eng.toApiLang(TargetLang.effective(settings));
    if (!tgt || !eng.supportsLang(tgt)) {
      result.availability = 'unavailable';
      return result;
    }
    result.availability = await withinBudget(budgetMs, async () => {
      const src = eng.toApiLang(await eng.pageSourceLang());
      // 判不出页面语言不等于坏了：真翻译时会再判一次，这里只能说“不知道”。
      if (!src) return 'unknown';
      if (!eng.supportsLang(src)) return 'unavailable';
      if (src === tgt) return 'available';
      return await probeAvailability(src, tgt);
    });
    return result;
  }

  ctx.builtinTranslator = {
    isSupported: isBuiltinSupported,
    isSelected: isBuiltinSelected,
    isActive: shouldUseBuiltin,
    effectiveEngine,
    unsupportedReason: builtinUnsupportedReason,
    probeStatus,
    // 这三个的主人是 content/engine/languages.js。包一层而不是直接交出函数：
    // 调用时才取架子，这一族的装载顺序就不是契约。
    toApiLang: (lang) => eng.toApiLang(lang),
    translate: translateWithBuiltin,
    destroyAll,

    // 一门目标语言（扩展自己的码）端上有没有：页内语言菜单标「仅 AI」、设置页和
    // 引导页的语言包状态（shared/language-pack.js）问的都是这一句，主人同样是
    // content/engine/languages.js。
    supportsTarget: (lang) => eng.supportsTarget(lang),

    // 语言包那一层（content/content-language-pack.js）要问的两件事。归一化后的
    // 语言码它自己拿 toApiLang 算，这两个只答引擎知道而它不知道的：这门语言引擎
    // 认不认，以及这一页是什么语言（带缓存，换路由时自己过期）。
    supportsLang: (code) => eng.supportsLang(code),
    pageSourceLang: () => eng.pageSourceLang(),

    // 输入框芯片（content/content-input-chip.js）问的那一句：这段刚敲进去的字
    // 是什么语言。判不出来答空串 —— 它据此决定不出声。
    detectStandaloneLang: (text) => eng.detectStandaloneLang(text),

    async availability(sourceLang, targetLang) {
      if (!isBuiltinSupported()) return 'unavailable';
      const src = eng.toApiLang(sourceLang);
      const tgt = eng.toApiLang(targetLang);
      if (!src || !tgt) return 'unavailable';
      if (src === tgt) return 'available';
      if (!eng.supportsLang(src) || !eng.supportsLang(tgt)) return 'unavailable';
      try {
        return await probeAvailability(src, tgt);
      } catch (error) {
        return 'unavailable';
      }
    },

    /**
     * 下载并就绪某个语言对。只应在**真实的用户手势里**调用——create() 触发下载
     * 要求 user activation。两个调用方：设置页那颗按钮（有地方显示进度），和
     * content/content-language-pack.js 的预取（借用户在页面上的第一次点击，静默
     * 进行，不传 onProgress）。
     */
    async ensureDownloaded(sourceLang, targetLang, onProgress) {
      if (!isBuiltinSupported()) {
        throw new EngineUnavailableError(ENGINE_REASONS.UNSUPPORTED_ENV);
      }
      const src = eng.toApiLang(sourceLang);
      const tgt = eng.toApiLang(targetLang);
      if (!src || !tgt || !eng.supportsLang(src) || !eng.supportsLang(tgt)) {
        throw new EngineUnavailableError(ENGINE_REASONS.UNSUPPORTED_PAIR);
      }
      if (src === tgt) return 'available';
      try {
        // 这条路是设置页那颗按钮，下载可以很久，但同样不能无限期地转下去：
        // 看门狗只在下载停住不动时才收网，正常往下走的下载它一次都不会碰。
        await getTranslator(src, tgt, true, onProgress);
      } catch (error) {
        if (isActivationError(error)) {
          throw new EngineUnavailableError(ENGINE_REASONS.NEEDS_DOWNLOAD);
        }
        if (error instanceof eng.TimeoutError) {
          throw new EngineUnavailableError(ENGINE_REASONS.TIMED_OUT);
        }
        throw new EngineUnavailableError(ENGINE_REASONS.CREATE_FAILED);
      }
      return 'available';
    }
  };

  // 语言包模型常驻内存，页面走了就该放掉。
  window.addEventListener('pagehide', destroyAll);
})();
