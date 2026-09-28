// Blab Translation 引擎一族：内置引擎的对外面（ctx.builtinTranslator）与 popup 的状态探测
//
// 从 content/content-translation-engine.js 原样搬出（P1-D 步骤 0.5，只位移不改行为）。
// 用到的引擎内部谓词由入口挂在架子 `ctx.engine` 上，这里调用时才取，所以装载顺序
// 不是契约；四份装载清单（manifest、设置页、引导页、单测夹具）都把它排在入口之后。
(function() {
  'use strict';

  if (globalThis.FrameEligibility && !globalThis.FrameEligibility.shouldActivate()) return;
  const ctx = window.AI_TRANSLATOR_CONTENT || (window.AI_TRANSLATOR_CONTENT = {});
  const settings = ctx.settings || (ctx.settings = {});
  const eng = (ctx.engine = ctx.engine || {});

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
      engine: eng.isBuiltinSelected(false) ? 'builtin' : 'ai',
      supported: eng.isBuiltinSupported(),
      reason: '',
      availability: 'unknown',
      lastFallback: eng.lastFallback(),
      // 「翻译此页」走 AI 时能不能发：按本页的站点规则选档（P1-D §3.5）。弹出窗口的
      // 「先去填 Key」和底栏都读它，不再自己读全局设置。
      aiReady: ctx.aiProfiles.ready('page')
    };
    if (result.engine !== 'builtin') return result;
    if (!result.supported) {
      result.reason = eng.builtinUnsupportedReason();
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
      return await eng.probeAvailability(src, tgt);
    });
    return result;
  }

  ctx.builtinTranslator = {
    isSupported: () => eng.isBuiltinSupported(),
    isSelected: (auto) => eng.isBuiltinSelected(auto),
    isActive: (auto) => eng.shouldUseBuiltin(auto),
    fallbackAllowed: () => eng.fallbackAllowed(),
    effectiveEngine: (opts) => eng.effectiveEngine(opts),
    unsupportedReason: () => eng.builtinUnsupportedReason(),
    probeStatus,
    // 这三个的主人是 content/engine/languages.js。包一层而不是直接交出函数：
    // 调用时才取架子，这一族的装载顺序就不是契约。
    toApiLang: (lang) => eng.toApiLang(lang),
    translate: (...args) => eng.translateWithBuiltin(...args),
    destroyAll: () => eng.destroyAll(),

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
      if (!eng.isBuiltinSupported()) return 'unavailable';
      const src = eng.toApiLang(sourceLang);
      const tgt = eng.toApiLang(targetLang);
      if (!src || !tgt) return 'unavailable';
      if (src === tgt) return 'available';
      if (!eng.supportsLang(src) || !eng.supportsLang(tgt)) return 'unavailable';
      try {
        return await eng.probeAvailability(src, tgt);
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
      if (!eng.isBuiltinSupported()) {
        throw new eng.EngineUnavailableError(eng.ENGINE_REASONS.UNSUPPORTED_ENV);
      }
      const src = eng.toApiLang(sourceLang);
      const tgt = eng.toApiLang(targetLang);
      if (!src || !tgt || !eng.supportsLang(src) || !eng.supportsLang(tgt)) {
        throw new eng.EngineUnavailableError(eng.ENGINE_REASONS.UNSUPPORTED_PAIR);
      }
      if (src === tgt) return 'available';
      try {
        // 这条路是设置页那颗按钮，下载可以很久，但同样不能无限期地转下去：
        // 看门狗只在下载停住不动时才收网，正常往下走的下载它一次都不会碰。
        await eng.getTranslator(src, tgt, true, onProgress);
      } catch (error) {
        if (eng.isActivationError(error)) {
          throw new eng.EngineUnavailableError(eng.ENGINE_REASONS.NEEDS_DOWNLOAD);
        }
        if (error instanceof eng.TimeoutError) {
          throw new eng.EngineUnavailableError(eng.ENGINE_REASONS.TIMED_OUT);
        }
        throw new eng.EngineUnavailableError(eng.ENGINE_REASONS.CREATE_FAILED);
      }
      return 'available';
    }
  };

  // 语言包模型常驻内存，页面走了就该放掉。
  window.addEventListener('pagehide', () => eng.destroyAll());
})();
