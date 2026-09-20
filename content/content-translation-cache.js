// Blab Translation — 页面翻译与译文缓存之间的那一层。
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

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    if (PROFILE_KEYS.some((key) => key in changes)) profilePromise = null;
  });

  /**
   * 与 ctx.requestTranslation 同形（同样的入参、同样的返回、同样会抛的异常），
   * 只是先去缓存里看一眼。调用方不需要知道这一层存不存在。
   */
  ctx.requestTranslationCached = async function (message) {
    const cache = globalThis.TranslationCache;
    // 只缓存整页快速批量这一种请求。划词、悬停、输入框是用户一次一次点出来的，
    // 量小且几乎不重复；而且 TRANSLATE 的返回是 {translation, phonetic, isWord}，
    // 另一种形状，给它做缓存等于在这里再养一套回写规则。
    if (!cache || message.type !== 'TRANSLATE_BATCH_FAST' || !Array.isArray(message.texts)) {
      return ctx.requestTranslation(message);
    }
    // 内置引擎（Chrome 端上的 Translator）零网络零费用，缓存它省下的是几十毫秒，
    // 花掉的是用户那 10 MB storage 配额。更要紧的是它按页面语言推断源语言，
    // 同一段英文在法语页面和英语页面上译出来可以不一样，跨页复用会串味。
    if (ctx.builtinTranslator && ctx.builtinTranslator.isActive()) {
      return ctx.requestTranslation(message);
    }

    const profile = await loadProfile();
    if (!profile) return ctx.requestTranslation(message);

    const factors = { targetLang: message.targetLang || '', ...profile };

    // 未命中的那几条为什么失败，只有这一层知道；serve() 只会告诉我们「这批没成」。
    let failure = null;
    // 本机统计要的「命中率」也只有这一层数得出来：serve() 对外只有「这批的译文」，
    // 里面命中了几条不在返回值里。取数不动 serve() 的契约 —— 未命中的那几条就是
    // 它交给我们去发的那几条，剩下的都是命中。整批命中时这个回调根本不会被调用，
    // 所以初值 0 就是「一条都没未命中」。
    let missingCount = 0;
    const translations = await cache.serve(message.texts, factors, async (missing) => {
      missingCount = missing.length;
      const response = await ctx.requestTranslation({ ...message, texts: missing });
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
