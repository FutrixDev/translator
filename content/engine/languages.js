// Blab Translation 翻译引擎 —— 语言码与源语言
//
// 引擎要回答的第一个问题不是「怎么译」，是「从哪门语言译到哪门」：扩展内部的语言码
// 怎么换成 Translator API 认的码、引擎认不认这门语言、这一页（或这一段）是什么语言。
// 这一份只管这些，译是 content-translation-engine.js 的事。
//
// 设置页也装这一族（查语言包、点下载），那里没有 content script 那套 ctx，所以和入
// 口一样自己兜一个空壳。跨文件的名字都挂在 `ctx.engine` 这个架子上、调用时才取，
// 所以这一族谁先装都行。
(function() {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT || (window.AI_TRANSLATOR_CONTENT = {});
  // 这一族共用的架子，说明见 content/content-translation-engine.js 顶上。
  const eng = (ctx.engine = ctx.engine || {});

  // 「这两门语言是同一门吗」「这段文字是简体还是繁体」的唯一出处，见
  // shared/lang-tags.js。manifest 和设置页都把它排在这个文件前面；拿不到就直接
  // 抛，别让整条内置链路在「源语言永远是个 zh」上静静地跑偏。
  const LangTags = globalThis.LangTags;
  if (!LangTags) throw new Error('content/engine/languages.js 要先装 shared/lang-tags.js');

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

  // ==================== 源语言 ====================

  // 逐块探测语言在整页翻译上代价不小：每次 detectLanguage 都是一次到浏览器进程的
  // IPC，一个两百块的页面就是两百次。整页的主语言只需要判一次，取全文样本反而比
  // 逐块判更准，所以这里缓存页面级结果。
  let pageSourceLangPromise = null;

  // CLD 在几个字符上基本是在猜，短样本直接不问。独立文本（输入框）会按字母体系
  // 放宽这个下限——一两个汉字或假名已经足够定语言，见 resolveStandaloneSourceLang。
  const DETECT_MIN_CHARS = 8;

  // requireReliable 默认关：页面级取样 4000 字，本来就稳，卡这道门槛只会让整页
  // 退化成没有源语言可用。块级和纯拉丁的独立文本才打开它。
  async function detectLanguageOf(text, { requireReliable = false, minChars = DETECT_MIN_CHARS } = {}) {
    if (!chrome?.i18n?.detectLanguage) return '';
    const sample = ctx.getLanguageDetectionText
      ? ctx.getLanguageDetectionText(text)
      : String(text || '').slice(0, 400);
    if (!sample || sample.length < minChars) return '';
    try {
      const result = await chrome.i18n.detectLanguage(sample);
      const top = result?.languages?.[0];
      if (!top || !top.language || top.language === 'und') return '';
      if (requireReliable && (result.isReliable !== true || (top.percentage || 0) < 70)) {
        return '';
      }
      // 检测器分不出简繁：繁体和简体它都答一个光秃秃的 `zh`，两边都是 100%、
      // isReliable。而内置引擎认的是 'zh'（简）和 'zh-Hant'（繁）两门语言——
      // 一整页繁体配 zh-CN 的目标，源语言压成 zh 就正好撞上 src === tgt 那一档，
      // 原样返回，整页一个字都不译。所以中文的书写系统在这里就从字里数出来：
      // 判过语言的是这一份 sample，补书写系统的也该是它。
      return LangTags.refineScript(top.language, sample);
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

  // 单页应用换页时 document 从头到尾是同一个，这个模块级缓存也就一直是上一篇文章
  // 的语言。中文页跳到英文页之后，凡是短于 SELF_DETECT_MIN_CHARS 的块都不自己探，
  // 直接拿缓存里的 zh 当源语言 —— 目标语言也是 zh，于是判成「已经是目标语言」，
  // 原样退回，一个字不译。页面上看不出任何异样，只有短句永远是英文。
  //
  // 清缓存放在引擎这一层、由它自己订路由，而不是让自动翻译那一层换页时顺手清一下：
  // 划词、悬停、字幕走的是同一个 resolveSourceLang，自动翻译关着的时候它们照样在
  // 这条路上。谁拥有这个缓存，谁负责让它过期。
  if (globalThis.SpaNavigation) {
    globalThis.SpaNavigation.onRouteChange(() => {
      pageSourceLangPromise = null;
    });
  }

  // 短文本（划词、悬停、字幕）自身的探测结果不可靠，交给页面级结果兜底。
  const SELF_DETECT_MIN_CHARS = 40;

  // SUPPORTED_LANGS 里用非拉丁字母书写的那些。判断“页面语言可不可能是这段文字的
  // 语言”只需要这一条：字母体系对不上就一定不是。
  //
  // 从 SUPPORTED_LANGS 派生，不另抄一张表：zh→Hans、bg→Cyrl 这些 Intl 自己就
  // 知道，而往 SUPPORTED_LANGS 里加语言的人不该还要记得同步第二处——漏掉一门
  // 非拉丁语言，正是下面这个 bug 原样复发。
  const NON_LATIN_LANGS = new Set([...SUPPORTED_LANGS].filter((lang) => {
    try {
      return new Intl.Locale(lang).maximize().script !== 'Latn';
    } catch (error) {
      // 认不出来就当非拉丁：这个集合只用来否决页面语言，多否决一次最多是源语言
      // 猜成 en（拉丁文本照样译得出来），少否决一次就是原文原样退回。
      return true;
    }
  }));
  // Script=Common 涵盖数字、标点、空白和 emoji，Inherited 涵盖组合用附加符号，
  // 所以 "hello 😀" 和 "café" 都仍算纯拉丁。
  const HAS_NON_LATIN_CHARS = /[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u;

  /**
   * 输入框里的文字不属于这个页面：读英文页面时想把“动画”翻成英文是常事。拿页面
   * 语言当源语言会得出 src='en'、tgt='en'，被同语言短路原样返回——用户选了目标
   * 语言、点了翻译，拿回来的还是自己输入的那行字。反过来同样成立：在中文页面上
   * 输入 "animation" 想要中文，会被判成 zh→zh 原样退回。
   *
   * 短文本上 CLD 唯一可靠的线索是字母体系。实测（headless Chrome，全部
   * isReliable=false）：动画→zh、アニメ→ja、안녕→ko、привет→ru 都对，而同样
   * 长度的拉丁字母全错——hello→sr、animation→ja、Bonjour→no、ok→pl。几十种
   * 拉丁语言在一两个词上本来就分不开。所以只在文本自身带非拉丁字符时才采信
   * “判得不准”的结果，纯拉丁文本仍旧要求 isReliable。
   */
  function hasNonLatinChars(text) {
    return HAS_NON_LATIN_CHARS.test(text);
  }

  /**
   * 「这段文字自己是什么语言」，判不出来就是空串 —— **不猜、不兜底**。
   *
   * 上面那段注释里的两档门槛（非拉丁放宽到两个字符、纯拉丁仍要求 isReliable）
   * 就是这个函数的全部内容。单独拆出来是因为有两个调用方，而它们要的东西不同：
   * 翻译那一路（resolveStandaloneSourceLang）判不出来也得给引擎一个源语言，所以
   * 它在这之后还有两级兜底；输入框那颗芯片（content/content-input-chip.js）要的
   * 恰恰是「没把握就别出声」—— 一颗因为把 "hello" 判成塞尔维亚语而冒出来的芯片
   * 比没有芯片糟。两边各写一次探测就会各有一套门槛，而门槛正是这件事的全部难点。
   */
  function detectStandaloneLang(trimmed) {
    const nonLatinText = hasNonLatinChars(trimmed);
    return detectLanguageOf(trimmed, {
      minChars: nonLatinText ? 2 : DETECT_MIN_CHARS,
      requireReliable: !nonLatinText
    });
  }

  async function resolveStandaloneSourceLang(trimmed) {
    const nonLatinText = hasNonLatinChars(trimmed);
    const detected = toApiLang(await detectStandaloneLang(trimmed));
    if (detected && SUPPORTED_LANGS.has(detected)) return detected;

    const pageLang = toApiLang(await getPageSourceLang());
    if (pageLang && NON_LATIN_LANGS.has(pageLang) === nonLatinText) return pageLang;
    // 字母体系对不上，页面语言出局。剩下的拉丁文本按英文处理：拉丁字母里英文
    // 是压倒性的多数，而这里的备选不是“更好的猜测”，是彻底放弃。非拉丁文本走
    // 到这里说明连字母体系都没给出答案，那就交给 AI，模型自己会认源语言。
    return nonLatinText ? '' : 'en';
  }

  async function resolveSourceLang(text, hint, standalone) {
    if (hint) return toApiLang(hint);
    const trimmed = String(text || '').trim();
    if (standalone) return resolveStandaloneSourceLang(trimmed);
    const pageLang = toApiLang(await getPageSourceLang());
    if (trimmed.length >= SELF_DETECT_MIN_CHARS) {
      // 块级结果只在“判得准、且判出来的语言内置引擎确实支持”时才采信。
      // 逐块探测存在的意义是混合语言页面（英文正文里夹日文引用），那是少数派；
      // 而技术文章里满是型号名、版本号和百分数，CLD 判歪一段很常见 —— 一旦判歪，
      // 这一段就变成不支持的语言对。宁可整段按页面主语言处理，也不能被一次误判带走。
      const own = toApiLang(await detectLanguageOf(trimmed, { requireReliable: true }));
      if (own && SUPPORTED_LANGS.has(own)) return own;
    }
    return pageLang;
  }

  eng.toApiLang = toApiLang;
  eng.supportsLang = (code) => SUPPORTED_LANGS.has(code);
  eng.pageSourceLang = getPageSourceLang;
  eng.detectStandaloneLang = detectStandaloneLang;
  eng.resolveSourceLang = resolveSourceLang;
})();
