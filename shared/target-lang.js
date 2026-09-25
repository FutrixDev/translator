// 「我们把网页译成哪门语言」—— 只有这一个答案。
//
// 这张表曾经有三份：background/settings.js、options/options.js 各抄了一份
// getBrowserLanguage()，content/content-language.js 又写了第三种（直接返回
// navigator.language，不做映射）。三份实现只要有一处和别处不一样，用户就会看到
// 两个界面对同一件事各说各话——而它真的漂过：worker 侧要 targetLangSetByUser
// 为真才认存下来的语言，内容脚本侧只看 targetLang 非空，于是全新安装的法语用户
// 右键菜单写着「译成 Français」，整页翻译却按内容脚本默认的 zh-CN 走。
//
// 规则一句话：**存了就用存的，没存就跟浏览器**。
//
// 「没存」现在就是 targetLang 为空串，不再需要另一个布尔量去记「用户到底选过
// 没有」：设置页在用户真正动过语言选择器之前写的就是空串（见 options.js 的
// collectSettings），所以非空即用户选过。曾经的 targetLangSetByUser 是因为两张
// 默认值表里 targetLang 有个非空默认值，空不能当哨兵用才补出来的——默认值一改
// 成空，它就只是第二个会和第一个吵架的答案。
//
// 空串在**译文身份**里是另一回事，不要混：ctx.currentTargetLang() 有意保留空串
// 当「跟随浏览器」的哨兵（见 content/page/batch.js 的 passTarget），登记端和比对
// 端同读同写。这里解析出来的具体语言是发给引擎的那一门。
(function (root) {
  'use strict';

  // 简繁的判定只有一个主人。装它的四张单子（manifest、options.html、
  // background/settings.js、两个测试夹具）都把 lang-tags.js 排在前面；漏了就在
  // 这里响，而不是在某个繁体用户的页面上悄悄译成简体。
  const LangTags = root.LangTags;
  if (!LangTags) throw new Error('target-lang.js 要先装 shared/lang-tags.js');

  // 全扩展唯一的目标语言清单：Chrome 自己的界面语言（build/config/locales.gni
  // 的 82 个 locale），把同一门语言的地区变体并成一门（en-GB/en-US、es/es-419、
  // fr/fr-CA、pt-BR/pt-PT、sr/sr-Latn、zh-HK→zh-TW）、nb 改叫 no，共 76 门。
  // 端上 Translator 能译的 39 门（content/engine/languages.js 的 SUPPORTED_LANGS）
  // 全在里面，其余 37 门只有 AI 引擎能译。顺序无意义：展示时按界面语言排序。
  //
  // 以后要加一门，只改这一行 —— 名字、本名和方向都由 Intl 现算，
  // test/unit/target-languages.test.mjs 会自动把新的一门也查一遍。
  const SUPPORTED = [
    'af', 'am', 'ar', 'as', 'az', 'be', 'bg', 'bn', 'bs', 'ca', 'cs', 'cy', 'da',
    'de', 'el', 'en', 'es', 'et', 'eu', 'fa', 'fi', 'fil', 'fr', 'gl', 'gu', 'he',
    'hi', 'hr', 'hu', 'hy', 'id', 'is', 'it', 'ja', 'ka', 'kk', 'km', 'kn', 'ko',
    'ky', 'lo', 'lt', 'lv', 'mk', 'ml', 'mn', 'mr', 'ms', 'my', 'ne', 'nl', 'no',
    'or', 'pa', 'pl', 'pt', 'ro', 'ru', 'si', 'sk', 'sl', 'sq', 'sr', 'sv', 'sw',
    'ta', 'te', 'th', 'tr', 'uk', 'ur', 'uz', 'vi', 'zh-CN', 'zh-TW', 'zu'
  ];

  // 漫画、PDF 的云端选择器仍然只给这十门（「跟随」照旧透传页面目标语言，
  // 云端能不能处理由云端回答，扩展里不做「收成最近一门」的兜底）。
  const CLOUD_TARGETS = ['zh-CN', 'zh-TW', 'en', 'ja', 'ko', 'fr', 'de', 'es', 'pt', 'ru'];

  // zh-CN / zh-TW 是已发布客户端存下的值，不能改名；查名字、查书写系统时借
  // zh-Hans / zh-Hant 的口，得到「简体中文 / 繁體中文」这一对，而不是
  // 「中文（中国）/ 中文（台湾）」。只有这两个键，没有反查。
  const DISPLAY_TAG = { 'zh-CN': 'zh-Hans', 'zh-TW': 'zh-Hant' };

  // 一个像样的语言标签的前缀：主语言 2–3 个字母，可选 4 字母书写系统，可选地区
  // （2 个字母或 3 位数字）。后面的变体和扩展一概不看 —— 只把这段前缀交给 Intl，
  // 残缺的扩展（'en-US-u-'）就不会让 getCanonicalLocales 抛错。
  const TAG_PREFIX = /^([a-z]{2,3})(?:-([a-z]{4}))?(?:-([a-z]{2}|\d{3}))?(?=-|$)/i;

  function tagPrefix(tag) {
    const match = TAG_PREFIX.exec(String(tag == null ? '' : tag).trim());
    return match ? match[0] : '';
  }

  /** 把任意 BCP-47 标签收进 SUPPORTED 里的一门；收不进就是 'en'。 */
  function fromTag(tag) {
    const prefix = tagPrefix(tag);
    if (!prefix) return 'en';
    // 规范化顺带处理旧码（tl→fil、iw→he、in→id、sh→sr-Latn、mo→ro）和大小写。
    const canonical = Intl.getCanonicalLocales(prefix)[0];
    if (SUPPORTED.includes(canonical)) return canonical;
    const base = canonical.split('-')[0];
    // 中文的两种字形是两门语言，而写法数不完：zh-Hant、zh-HK、zh-Hant-TW、
    // zh-MO……任何一张写死的表都会漏掉几种，而漏掉的后果是把一个繁体页面译成
    // 简体 —— 正好是用户要的那一件事反着做一遍。所以这里不列表，问书写系统的
    // 那个主人。按基码匹配在这一门上也答不对：zh-Hant 的基码是 zh，而 SUPPORTED
    // 里没有光秃秃的 zh。
    if (base === 'zh') return LangTags.getScriptVariant(canonical) === 'hant' ? 'zh-TW' : 'zh-CN';
    // 书面挪威语的两种写法都收进 no，与 content/engine/languages.js 的别名一致；
    // getCanonicalLocales 不做这一步。
    if (base === 'nb' || base === 'nn') return 'no';
    if (SUPPORTED.includes(base)) return base;
    return 'en';
  }

  /** 浏览器自己说的语言，收进 SUPPORTED。 */
  function browserLanguage() {
    const nav = root.navigator || {};
    return fromTag(nav.language || nav.userLanguage || 'en');
  }

  /**
   * 这份设置下，网页要译成哪门语言。
   *
   * 不归一化用户存下来的值：选择器里给的本来就是 SUPPORTED 之一，而归一化会把
   * 用户哪天手改进 storage 的写法悄悄换掉。只有「跟随浏览器」那一路需要映射。
   */
  function effective(settings) {
    const stored = settings && settings.targetLang;
    return stored || browserLanguage();
  }

  // ==================== 名字 ====================

  const namers = new Map();
  function namer(uiLang) {
    if (!namers.has(uiLang)) {
      namers.set(uiLang, new Intl.DisplayNames([uiLang], { type: 'language', fallback: 'none' }));
    }
    return namers.get(uiLang);
  }

  // 首字母大写只在有大小写的书写系统里做。格鲁吉亚文（Geor）不在里面：它的
  // 「大写」是另一套 Mtavruli 字母，ქართული 不该变成那样。
  const CASED = new Set(['Latn', 'Cyrl', 'Grek', 'Armn']);

  function menuForm(name, uiLang) {
    const script = new Intl.Locale(uiLang).maximize().script;
    // 只动全小写的名字：isiZulu 这种内部带大写的本名是它自己的写法。
    if (!CASED.has(script) || name !== name.toLocaleLowerCase(uiLang)) return name;
    const first = String.fromCodePoint(name.codePointAt(0));
    return first.toLocaleUpperCase(uiLang) + name.slice(first.length);
  }

  /**
   * 一门语言在 uiLang 这门界面语言里叫什么。
   *
   * 两种形态：默认是**菜单形**（选择器、菜单、标签里独立出现，全小写的名字首字母
   * 大写：fr 下 persan → Persan）；inSentence 为真时是**句中形**，即 Intl 原样，
   * 用来填进句子里的 {lang}（fr：« en persan »）。
   *
   * 接受任何合法标签，不限于 SUPPORTED —— OCR 探测到的 zh-Hans、zh 也直接交给它。
   * 认不出的码原样返回，至少还看得见。
   */
  function nameOf(code, uiLang, { inSentence = false } = {}) {
    if (!code) return '';
    const prefix = tagPrefix(code);
    if (!prefix) return String(code);
    const name = namer(uiLang).of(DISPLAY_TAG[code] || prefix);
    if (!name) return String(code);
    return inSentence ? name : menuForm(name, uiLang);
  }

  /** 这门语言用它自己写的名字（菜单形）：'zh-TW' → 繁體中文，'zu' → isiZulu。 */
  function autonym(code) {
    return nameOf(code, DISPLAY_TAG[code] || code);
  }

  /**
   * 提示词里的语言名：英文名，再加本名作佐证 —— 'Japanese (日本語)'。
   * 两者相同时只写一次：'English'。zh-CN 这种码本身有歧义，不能只给码。
   */
  function promptName(code) {
    const english = nameOf(code, 'en', { inSentence: true });
    const own = autonym(code);
    return english === own ? english : `${english} (${own})`;
  }

  // 从右往左写的书写系统。76 门里落在这里的是 ar fa he ur。
  const RTL_SCRIPTS = new Set(['Arab', 'Hebr', 'Thaa', 'Syrc', 'Nkoo', 'Adlm', 'Rohg']);

  /** 'rtl' | 'ltr'。不合法或空串答 'ltr'，与 HTML 的缺省一致。 */
  function direction(code) {
    const prefix = tagPrefix(DISPLAY_TAG[code] || code);
    if (!prefix) return 'ltr';
    return RTL_SCRIPTS.has(new Intl.Locale(prefix).maximize().script) ? 'rtl' : 'ltr';
  }

  /** 选择器的数据：[{ value, label }]，label 为菜单形，按界面语言的排序规则排。 */
  function options(uiLang, codes = SUPPORTED) {
    const collator = new Intl.Collator(uiLang);
    return codes
      .map((code) => ({ value: code, label: nameOf(code, uiLang) }))
      .sort((a, b) => collator.compare(a.label, b.label));
  }

  root.TargetLang = {
    SUPPORTED,
    CLOUD_TARGETS,
    fromTag,
    browserLanguage,
    effective,
    nameOf,
    autonym,
    promptName,
    direction,
    options
  };
})(globalThis);
