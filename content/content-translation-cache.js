// Blab Translation — 翻译请求与译文缓存之间的那一层。
//
// shared/translation-cache.js 只认「一批文本 + 一组键因子」，对 chrome.storage、
// 对当前用哪个引擎、对请求长什么样一无所知 —— 那是它能被单元测试整个跑通的原因。
// 这个文件补上另一半：现在这次请求的键因子是什么，以及未命中的部分怎么真的发出去。
//
// 单独一个文件而不是并进 content-translation-engine.js：那个文件已经 900 行，
// 而且设置页也加载它（那里没有 ctx，也没有页面翻译）。引擎负责「用哪个引擎、
// 怎么回退」，缓存负责「这次还用不用发」，是两件事。
(function () {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT;
  if (!ctx) return;

  const PROFILE_KEYS = ['apiEndpoint', 'modelName', 'customPrompt'];

  let profilePromise = null;

  /**
   * 读出影响译文内容的那几项设置。
   *
   * 刻意不写默认值：键只需要稳定且可区分，不需要认得出「这是出厂值」。
   * 在这里重述一遍 apiEndpoint/modelName 的默认值，就是把同一份常量抄到第三个
   * 地方（background.js 和 options.js 已经各有一份），而它带来的全部好处是
   * 用户手动把模型填成出厂同名值时少一次缓存失效。
   *
   * apiKey 不在这里，也不该在：它不改变译文，而键会以明文落进 storage。
   */
  function loadProfile() {
    if (!profilePromise) {
      profilePromise = chrome.storage.sync.get(PROFILE_KEYS).then((stored) => ({
        endpoint: stored.apiEndpoint || '',
        model: stored.modelName || '',
        prompt: stored.customPrompt || '',
        // 内置提示词（background.js 的 DEFAULT_BATCH_PROMPT 那一套）没有版本号，
        // 版本号就是它的版本号：改提示词必然伴随一次发版，而发版必然改这里。
        version: chrome.runtime.getManifest().version
      })).catch((error) => {
        // 读不到设置就不缓存，而不是拿一组空因子去建键：那会把不同模型、
        // 不同提示词的译文混进同一个键里。
        console.warn('Blab Translation: translation cache profile unavailable', error);
        profilePromise = null;
        return null;
      });
    }
    return profilePromise;
  }

  // ---- 本页内存缓存的代数：ctx.translationProfile ----
  //
  // 悬停（content/hover/blocks.js 的 buildCacheKey）和字幕（content/captions/
  // translate.js 的 getCueKey）各有一份内存缓存，键里只有目标语言和原文，没有
  // 模型、提示词和词表。这些变了，代数加一，两边的键前面带着代数，旧译文就再也
  // 读不到。请求在途时换了代，回来的译文存在旧键下，同样不会再被读到。
  //
  // 加代的来源：
  //   - 设置：bootstrap 的 storage 监听写完 ctx.settings 之后转来 sync 增量
  //     （onSettingsChanged）。sync 的监听只有 bootstrap 一处。
  //   - 词表：订阅 ctx.glossary，本页生效词条的签名（id 加 u）真变了才加一代。
  //   - 规则：订阅 ctx.customRules.onProfileChange（本站规则钉住的引擎或领域变了
  //     才回调）。manifest 里 content/page/custom-rule.js 因此排在这个文件之前。
  //
  // 子帧不自己加代，只跟顶层指令里的代数走（inherit，content/frames/child.js）：
  // 它的请求都在顶层执行，顶层的代数才是「这次按什么译」的那一份。
  const GENERATION_KEYS = [
    'apiEndpoint', 'modelName', 'customPrompt', 'translationEngine', 'autoTranslateEngine',
    'engineFallback', 'promptDomain', 'aiPageContext', 'provider',
  ];

  let generation = 0;
  const generationSubscribers = new Set();

  function setGeneration(next) {
    if (next === generation) return;
    generation = next;
    for (const fn of Array.from(generationSubscribers)) {
      try {
        fn(generation);
      } catch (error) {
        console.error('Blab Translation: translation profile subscriber failed', error);
      }
    }
  }

  function bump() {
    if (ctx.frameRole !== 'top') return;
    setGeneration(generation + 1);
  }

  function glossarySignature() {
    return ctx.glossary.entries()
      .map((entry) => `${entry.id}:${entry.u}`)
      .sort()
      .join(',');
  }

  let glossarySigned = glossarySignature();
  ctx.glossary.subscribe(() => {
    const next = glossarySignature();
    if (next === glossarySigned) return;
    glossarySigned = next;
    bump();
  });

  ctx.customRules.onProfileChange(bump);

  ctx.translationProfile = {
    generation: () => generation,
    subscribe(fn) {
      generationSubscribers.add(fn);
      return () => generationSubscribers.delete(fn);
    },
    onSettingsChanged(changes) {
      if (PROFILE_KEYS.some((key) => key in changes)) profilePromise = null;
      if (GENERATION_KEYS.some((key) => key in changes)) bump();
    },
    inherit(next) {
      if (!Number.isInteger(next) || next < 0) {
        throw new TypeError(`translation profile generation must be a non-negative integer, got ${next}`);
      }
      setGeneration(next);
    },
  };

  /**
   * 与 ctx.requestTranslation 同形（同样的入参、同样的返回、同样会抛的异常），
   * 只是先去缓存里看一眼。调用方不需要知道这一层存不存在。
   *
   * 和 ctx.requestTranslation 一样是两步：在发起请求的这个 frame 盖语域
   * （ctx.withPromptAddenda，按这个文档的地址），再交给 ctx.sendTranslationCached。
   * 子 frame 只覆盖第二步（交给顶层去查缓存、去发），所以语域是子文档的，
   * 词表、领域、上下文是顶层的（D-382）。
   */
  ctx.requestTranslationCached = (message) => ctx.sendTranslationCached(ctx.withPromptAddenda(message));

  /** 查缓存、发未命中的那几条：入参是已经盖好语域的请求，不再盖第二次。 */
  ctx.sendTranslationCached = async function (message) {
    const cache = globalThis.TranslationCache;
    // 只缓存快速批量这一种请求 —— 整页翻译和字幕都发它。划词、悬停、输入框是
    // 用户一次一次点出来的，量小且几乎不重复；而且 TRANSLATE 的返回是
    // {translation, phonetic, isWord}，另一种形状，给它做缓存等于在这里再养一套
    // 回写规则。
    if (!cache || message.type !== 'TRANSLATE_BATCH_FAST' || !Array.isArray(message.texts)) {
      return ctx.sendTranslation(message);
    }
    // 内置引擎（Chrome 端上的 Translator）零网络零费用，缓存它省下的是几十毫秒，
    // 花掉的是用户那 10 MB storage 配额。更要紧的是它按页面语言推断源语言，
    // 同一段英文在法语页面和英语页面上译出来可以不一样，跨页复用会串味。
    // 问的是**这一条请求**那一边的引擎：自动模式有自己的开关（PRD FR-9 的
    // autoTranslateEngine），而这一层两边的流量都经手。默认设置（手动 AI、自动
    // 内置）下不带 auto 去问，就会把端上引擎的译文一条条写进 storage —— 正是上
    // 面那段说的串味和配额；反过来则是自动那一轮整个绕过缓存，每一页重新计费。
    if (ctx.builtinTranslator && ctx.builtinTranslator.isActive(message.auto === true)) {
      return ctx.sendTranslation(message);
    }

    // 词表快照只取这一次：键里的附加说明戳和真正发出去的提示词出自同一份，
    // 请求在途时词表变了只影响下一次请求（content/engine/glossary.js 顶上）。
    const snap = await ctx.engine.glossary.current(message.targetLang);
    // message.addenda 是发起请求那一页的语域（R33 A4）：同一段文字在论坛上和在
    // 新闻站上可以译得不一样。键读它，没命中的那几条也带着它经
    // ctx.sendTranslation 送出 —— 键和请求是同一个对象，不会各算各的。
    const profile = await loadProfile();
    if (!profile) return ctx.sendTranslation(message, { glossary: snap });

    // sourceLang 只有字幕会带（轨道自己声明的那门语言），整页翻译永远是空串。
    // 它必须进键：同一句台词从英语轨和法语轨来是两件事，见 translation-cache.js
    // 顶上那张因子表。
    const factors = {
      targetLang: message.targetLang || '',
      sourceLang: message.sourceLang || '',
      ...profile,
      // 按每段文字求值（serve 里）：语域戳加上这段命中的词条、领域和上下文开关，
      // 改一条词条只有含它的文字失效。
      addenda: (text) => `${globalThis.PromptAddenda.stamp(message.addenda)}|${ctx.engine.addenda.stamp(snap, text)}`
    };

    // 未命中的那几条为什么失败，只有这一层知道；serve() 只会告诉我们「这批没成」。
    let failure = null;
    // 本机统计要的「命中率」也只有这一层数得出来：serve() 对外只有「这批的译文」，
    // 里面命中了几条不在返回值里。取数不动 serve() 的契约 —— 未命中的那几条就是
    // 它交给我们去发的那几条，剩下的都是命中。整批命中时这个回调根本不会被调用，
    // 所以初值 0 就是「一条都没未命中」。
    let missingCount = 0;
    const translations = await cache.serve(message.texts, factors, async (missing) => {
      missingCount = missing.length;
      const response = await ctx.sendTranslation({ ...message, texts: missing }, { glossary: snap });
      if (!response || response.error) {
        failure = response || { error: 'unknown' };
        return null;
      }
      return Array.isArray(response.translations) ? response.translations : null;
    });

    // 记在成败之前：命中与否是缓存这一面的事实，请求后来失败了也不改变「这几条
    // 本来就不用发」。
    globalThis.AutoStats.add({
      cacheHits: message.texts.length - missingCount,
      cacheMisses: missingCount
    });

    if (!translations) {
      // 原样把失败传回去：上层要靠 response.error 的具体内容决定是提示用户、
      // 回落逐块，还是整页中止。数量对不上（failure 为空）则交回 translations，
      // 上层的数量守卫会把它当成畸形响应处理。
      return failure || { translations: null };
    }
    return { translations };
  };
})();
