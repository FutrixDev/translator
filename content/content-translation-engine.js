// AI Translator Content Script Translation Engine
//
// 两条翻译后端，一个统一入口：
//
//   ctx.requestTranslation(message)  ——  与 chrome.runtime.sendMessage 完全同形
//
// 默认走浏览器内置的 Translator API（Chrome 138+，端上 NMT，零网络、零费用）；
// 内置这条路走不通时，再回落到 background service worker 里的自定义 AI 接口。
//
// 为什么内置引擎必须放在 content script：Translator 的 WebIDL 标注是
// [Exposed=Window, SecureContext]，MV3 的 background 是 service worker，
// 拿不到这个接口。所以整条内置链路只能在 content script 里跑，
// background 那条 AI 老路原样保留，一行没动。
(function() {
  'use strict';

  // 设置页也加载这个文件，用来查语言包状态、按钮触发首次下载（那里有真实用户手势）。
  // 设置页没有 content script 那套 ctx，所以这里自己兜一个空壳：
  // 只有 ctx.builtinTranslator 那部分会被设置页用到。
  const ctx = window.AI_TRANSLATOR_CONTENT || (window.AI_TRANSLATOR_CONTENT = {});
  const settings = ctx.settings || (ctx.settings = {});

  // ==================== 语言码 ====================

  // Translator API 认的是 BCP-47 基础码，扩展内部用的是带地区的码（zh-CN / zh-TW）。
  // 中文这一组必须显式映射：API 侧简体是 'zh'、繁体是 'zh-Hant'，直接取 split('-')[0]
  // 会把繁体也压成 'zh'，用户选了繁体却收到简体译文。
  const LANG_ALIASES = {
    'zh': 'zh',
    'zh-cn': 'zh',
    'zh-hans': 'zh',
    'zh-sg': 'zh',
    'zh-tw': 'zh-Hant',
    'zh-hk': 'zh-Hant',
    'zh-mo': 'zh-Hant',
    'zh-hant': 'zh-Hant',
    'nb': 'no',
    'nn': 'no',
    'iw': 'he',
    'in': 'id'
  };

  // Chrome 文档给出的 Translator API 支持列表。不在表里的语言直接判 unavailable，
  // 而不是等 create() 抛错——后者要等到用户点了翻译才暴露，还会白等一次往返。
  const SUPPORTED_LANGS = new Set([
    'ar', 'bn', 'bg', 'zh', 'zh-Hant', 'hr', 'cs', 'da', 'nl', 'en', 'fi', 'fr',
    'de', 'el', 'he', 'hi', 'hu', 'id', 'it', 'ja', 'kn', 'ko', 'lt', 'mr', 'no',
    'pl', 'pt', 'ro', 'ru', 'sk', 'sl', 'es', 'sv', 'ta', 'te', 'th', 'tr', 'uk',
    'vi'
  ]);

  function toApiLang(lang) {
    if (!lang) return '';
    const lower = String(lang).trim().toLowerCase();
    if (LANG_ALIASES[lower]) return LANG_ALIASES[lower];
    const base = lower.split('-')[0];
    if (LANG_ALIASES[base]) return LANG_ALIASES[base];
    return base;
  }

  // ==================== 环境探测 ====================

  // isSecureContext 这一条是真会命中的：http:// 页面上 content script 继承文档的
  // 非安全上下文，Translator 直接不存在。这类页面静默回落到 AI 接口。
  function isBuiltinSupported() {
    return typeof self !== 'undefined'
      && typeof self.Translator !== 'undefined'
      && typeof self.Translator.create === 'function'
      && self.isSecureContext === true;
  }

  function isBuiltinSelected() {
    // 设置缺失时按 builtin 处理：内置是默认引擎，只有用户显式选了 'ai' 才走自定义接口。
    return settings.translationEngine !== 'ai';
  }

  function shouldUseBuiltin() {
    return isBuiltinSelected() && isBuiltinSupported();
  }

  // ==================== 错误分级 ====================

  // 引擎级失败（整条内置链路用不了）与单条失败（这一段没译好）要分开处理：
  // 前者应当整批放弃、回落 AI；后者只能丢掉这一段，不能让一段拖垮整页。
  const ENGINE_REASONS = {
    UNSUPPORTED_ENV: 'unsupportedEnv',
    UNSUPPORTED_PAIR: 'unsupportedPair',
    NEEDS_DOWNLOAD: 'needsDownload',
    CREATE_FAILED: 'createFailed',
    // 内置 API 卡住了（见下面的看门狗）。对用户来说和“暂时用不了”是一回事，
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

  // ==================== 源语言 ====================

  // 逐块探测语言在整页翻译上代价不小：每次 detectLanguage 都是一次到浏览器进程的
  // IPC，一个两百块的页面就是两百次。整页的主语言只需要判一次，取全文样本反而比
  // 逐块判更准，所以这里缓存页面级结果。
  let pageSourceLangPromise = null;

  async function detectLanguageOf(text, requireReliable) {
    if (!chrome?.i18n?.detectLanguage) return '';
    const sample = ctx.getLanguageDetectionText
      ? ctx.getLanguageDetectionText(text)
      : String(text || '').slice(0, 400);
    if (!sample || sample.length < 8) return '';
    try {
      const result = await chrome.i18n.detectLanguage(sample);
      const top = result?.languages?.[0];
      if (!top || !top.language || top.language === 'und') return '';
      // 块级探测才要求“判得准”。页面级取样 4000 字，本来就稳，
      // 卡这道门槛只会让整页退化成没有源语言可用。
      if (requireReliable && (result.isReliable !== true || (top.percentage || 0) < 70)) {
        return '';
      }
      return top.language;
    } catch (error) {
      return '';
    }
  }

  function getPageSourceLang() {
    if (!pageSourceLangPromise) {
      pageSourceLangPromise = (async () => {
        const body = document.body ? (document.body.innerText || '') : '';
        // 样本取大一些：CLD 在几十字符上很容易判错，整页翻译一旦源语言判错，
        // 会导致整页语言对不可用而白白回落 AI。
        const lang = await detectLanguageOf(body.replace(/\s+/g, ' ').trim().slice(0, 4000));
        // 判不出来就不留缓存。预取会在 document_end 提前问一次，那时候 SPA 的正文
        // 可能还没渲染，缓存一个空结果会让之后真正的翻译也跟着没有源语言可用。
        if (!lang) pageSourceLangPromise = null;
        return lang;
      })();
    }
    return pageSourceLangPromise;
  }

  // 短文本（划词、悬停、字幕）自身的探测结果不可靠，交给页面级结果兜底。
  const SELF_DETECT_MIN_CHARS = 40;

  async function resolveSourceLang(text, hint) {
    if (hint) return toApiLang(hint);
    const pageLang = toApiLang(await getPageSourceLang());
    const trimmed = String(text || '').trim();
    if (trimmed.length >= SELF_DETECT_MIN_CHARS) {
      // 块级结果只在“判得准、且判出来的语言内置引擎确实支持”时才采信。
      // 逐块探测存在的意义是混合语言页面（英文正文里夹日文引用），那是少数派；
      // 而技术文章里满是型号名、版本号和百分数，CLD 判歪一段很常见 —— 一旦判歪，
      // 这一段就变成不支持的语言对。宁可整段按页面主语言处理，也不能被一次误判带走。
      const own = toApiLang(await detectLanguageOf(trimmed, true));
      if (own && SUPPORTED_LANGS.has(own)) return own;
    }
    return pageLang;
  }

  // ==================== 卡死看门狗 ====================

  // Translator API 的三个入口（availability / create / translate）都没有超时：
  // 出问题时它们不 reject，只是永远不 settle。而下面缓存的是 Promise，整页几十个
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
    return stallWatchdog(AVAILABILITY_TIMEOUT_MS, 'availability').guard(
      () => self.Translator.availability({ sourceLanguage: src, targetLanguage: tgt })
    );
  }

  function getTranslator(src, tgt, allowDownload, onProgress) {
    const key = instanceKey(src, tgt);
    const cached = translators.get(key);
    if (cached) return cached;

    // 有下载才有 downloadprogress 可看；语言包已就绪时 create() 只是建个会话，
    // 是本地操作，给一个固定的短上限就够。
    const watchdog = stallWatchdog(allowDownload ? DOWNLOAD_START_MS : CREATE_TIMEOUT_MS, 'create');
    const controller = typeof AbortController === 'function' ? new AbortController() : null;

    const options = { sourceLanguage: src, targetLanguage: tgt };
    if (controller) options.signal = controller.signal;
    if (allowDownload) {
      options.monitor = (monitor) => {
        monitor.addEventListener('downloadprogress', (event) => {
          // 有动静了：死线往后推，并且从这里开始用宽窗口。
          watchdog.bump(DOWNLOAD_STALL_MS);
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
        if (error instanceof TimeoutError && controller) {
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
    return stallWatchdog(TRANSLATE_TIMEOUT_MS, 'translate').guard(() => translator.translate(text));
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

    const tgt = toApiLang(targetLang);
    const src = await resolveSourceLang(source, options.sourceLang);

    if (!src || !tgt) throw new EngineUnavailableError(ENGINE_REASONS.UNSUPPORTED_PAIR);
    // 同语言不需要翻译。原样返回，与 AI 那条路“已是目标语言则原样返回”的约定一致。
    if (src === tgt) return source;
    if (!SUPPORTED_LANGS.has(src) || !SUPPORTED_LANGS.has(tgt)) {
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
        if (error instanceof TimeoutError) throw new EngineUnavailableError(ENGINE_REASONS.TIMED_OUT);
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
          throw new EngineUnavailableError(ENGINE_REASONS.NEEDS_DOWNLOAD);
        }
      }
    }

    let translator;
    try {
      translator = await getTranslator(src, tgt, needsDownload);
    } catch (error) {
      if (isActivationError(error)) {
        throw new EngineUnavailableError(ENGINE_REASONS.NEEDS_DOWNLOAD);
      }
      if (error instanceof TimeoutError) {
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
      if (error instanceof TimeoutError) {
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

  // 内置引擎顶不住时要不要回落到用户自己的接口，取决于用户到底配没配。
  // 没配 API Key 却回落过去，用户只会收到一句“请先配置 API Key”——
  // 而真正的原因是“这个语言对内置引擎不支持”或“语言包还没下”。
  let apiKeyKnown = false;
  let hasApiKey = false;

  async function refreshApiKeyPresence() {
    try {
      const result = await chrome.storage.sync.get({ apiKey: '' });
      hasApiKey = !!(result.apiKey && String(result.apiKey).trim());
    } catch (error) {
      hasApiKey = false;
    }
    apiKeyKnown = true;
    return hasApiKey;
  }

  async function canFallBackToAI() {
    if (!apiKeyKnown) await refreshApiKeyPresence();
    return hasApiKey;
  }

  if (chrome?.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, namespace) => {
      if (namespace !== 'sync') return;
      if (changes.apiKey) {
        hasApiKey = !!(changes.apiKey.newValue && String(changes.apiKey.newValue).trim());
        apiKeyKnown = true;
      }
      // 语言对可能因为设置改了目标语言而变化，页面语言缓存不受影响，
      // 但已建好的实例是按语言对缓存的，无需清理。
    });
  }

  function engineErrorMessage(reason) {
    const t = ctx.t || ((key) => key);
    switch (reason) {
      case ENGINE_REASONS.NEEDS_DOWNLOAD:
        return t('builtinNeedsDownload');
      case ENGINE_REASONS.UNSUPPORTED_PAIR:
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
      allowDownload: message.allowDownload
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
        const batchTarget = toApiLang(targetLang);
        if (!batchTarget || !SUPPORTED_LANGS.has(batchTarget)) {
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
            console.warn('AI Translator: builtin segment failed, keeping original', error);
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

  /**
   * 翻译请求统一入口，与 chrome.runtime.sendMessage 同形（同样的入参、同样的返回）。
   * 调用方不需要知道这次走的是内置还是 AI。
   */
  ctx.requestTranslation = async function(message) {
    if (isBuiltinSelected() && !isBuiltinSupported()) {
      // 选的是内置引擎，但这个环境给不了：Chrome 版本过低，或者页面是 http://
      // （content script 继承文档的非安全上下文，Translator 压根不存在）。
      // 配了自定义接口就静默顶上；没配就把真实原因说清楚，别让用户收到一句
      // 与实际问题无关的“请先配置 API Key”。
      if (!(await canFallBackToAI())) {
        return { error: engineErrorMessage(ENGINE_REASONS.UNSUPPORTED_ENV) };
      }
    } else if (shouldUseBuiltin()) {
      try {
        const result = await handleWithBuiltin(message);
        if (result) return result;
      } catch (error) {
        if (error instanceof EngineUnavailableError) {
          if (await canFallBackToAI()) {
            console.info('AI Translator: builtin unavailable (%s), falling back to AI', error.reason);
          } else {
            return { error: engineErrorMessage(error.reason) };
          }
        } else {
          console.warn('AI Translator: builtin translation failed', error);
          if (!(await canFallBackToAI())) {
            return { error: engineErrorMessage(ENGINE_REASONS.CREATE_FAILED) };
          }
        }
      }
    }
    return chrome.runtime.sendMessage(message);
  };

  // ==================== 语言包预取 ====================

  // 首次翻译要等几十 MB 的语言包，这份等待是可以挪走的：create() 只要求 user
  // activation，不要求这次 activation 是“为了翻译”产生的。所以在页面加载后先把
  // 语言对探好，再挂一个一次性监听，用户在页面上的第一次点击或按键就顺手把包拉下来。
  // 等他真的去点翻译时，包多半已经在本地了。
  //
  // 代价是：用户可能从没打算在这个页面上翻译，包却下了。只在“这个页面的语言对
  // 确实还没下载”时才做，一个语言对一辈子只有一次，权衡下来是值的。
  async function setupLanguagePackPrefetch() {
    // iframe 里的语言对和主文档一样，跟着做纯属重复。
    if (window.top !== window) return;
    if (!shouldUseBuiltin()) return;

    let src;
    let tgt;
    try {
      tgt = toApiLang(settings.targetLang);
      if (!tgt || !SUPPORTED_LANGS.has(tgt)) return;
      src = toApiLang(await getPageSourceLang());
      if (!src || !SUPPORTED_LANGS.has(src) || src === tgt) return;
      // downloadable 才需要预取；available 已就绪，downloading 说明别处已经在下了。
      const status = await probeAvailability(src, tgt);
      if (status !== 'downloadable') return;
    } catch (error) {
      return;
    }

    // 探测放在挂监听之前，是为了让手势回调里只剩一次 create()：
    // activation 是有时效的（几秒），中间夹着 IPC 会把它耗掉。
    const onGesture = () => {
      window.removeEventListener('pointerdown', onGesture, true);
      window.removeEventListener('keydown', onGesture, true);
      // 静默进行。这不是用户点出来的翻译，不该去占用进度条；失败也不弹提示，
      // 等他真的发起翻译时，那条路自己会重试并给出说明。
      getTranslator(src, tgt, true).catch((error) => {
        console.info('AI Translator: language pack prefetch failed', error);
      });
    };
    window.addEventListener('pointerdown', onGesture, true);
    window.addEventListener('keydown', onGesture, true);
  }

  // ==================== 对外接口 ====================

  ctx.setupLanguagePackPrefetch = setupLanguagePackPrefetch;

  ctx.builtinTranslator = {
    isSupported: isBuiltinSupported,
    isSelected: isBuiltinSelected,
    isActive: shouldUseBuiltin,
    toApiLang,
    translate: translateWithBuiltin,
    destroyAll,

    async availability(sourceLang, targetLang) {
      if (!isBuiltinSupported()) return 'unavailable';
      const src = toApiLang(sourceLang);
      const tgt = toApiLang(targetLang);
      if (!src || !tgt) return 'unavailable';
      if (src === tgt) return 'available';
      if (!SUPPORTED_LANGS.has(src) || !SUPPORTED_LANGS.has(tgt)) return 'unavailable';
      try {
        return await probeAvailability(src, tgt);
      } catch (error) {
        return 'unavailable';
      }
    },

    /**
     * 下载并就绪某个语言对。只应由设置页的按钮调用——那里有真实的用户手势
     * （create() 触发下载要求 user activation），也有地方把进度显示出来。
     */
    async ensureDownloaded(sourceLang, targetLang, onProgress) {
      if (!isBuiltinSupported()) {
        throw new EngineUnavailableError(ENGINE_REASONS.UNSUPPORTED_ENV);
      }
      const src = toApiLang(sourceLang);
      const tgt = toApiLang(targetLang);
      if (!src || !tgt || !SUPPORTED_LANGS.has(src) || !SUPPORTED_LANGS.has(tgt)) {
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
        if (error instanceof TimeoutError) {
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
