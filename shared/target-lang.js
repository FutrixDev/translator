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

  // 十门语言，和 content/content-bootstrap.js 的 TARGET_LANGUAGE_OPTIONS、
  // options.html 的 <select id="targetLang">、prompts 那边必须一致——
  // test/unit/target-languages.test.mjs 拿这四处互相对。
  const SUPPORTED = ['zh-CN', 'zh-TW', 'en', 'ja', 'ko', 'fr', 'de', 'es', 'pt', 'ru'];

  // 中文不列在这里：见 fromTag() 里那一段。en-GB/pt-PT 这类前缀匹配本来就对，
  // 列在这里只是省一次查找。
  const VARIANTS = {
    'en-US': 'en',
    'en-GB': 'en',
    'ja-JP': 'ja',
    'ko-KR': 'ko',
    'fr-FR': 'fr',
    'de-DE': 'de',
    'es-ES': 'es',
    'pt-BR': 'pt',
    'pt-PT': 'pt',
    'ru-RU': 'ru'
  };

  /** 把任意 BCP-47 标签收进上面那十门里；收不进就是 'en'。 */
  function fromTag(tag) {
    const raw = String(tag || '').trim();
    if (!raw) return 'en';
    if (SUPPORTED.includes(raw)) return raw;
    if (VARIANTS[raw]) return VARIANTS[raw];
    const base = raw.split('-')[0];
    // 中文的两种字形是两门语言，而写法数不完：zh-Hant、zh-HK、zh-Hant-TW、
    // zh-MO……任何一张写死的表都会漏掉几种，而漏掉的后果是把一个繁体页面译成
    // 简体 —— 正好是用户要的那一件事反着做一遍。所以这里不列表，问书写系统的
    // 那个主人。按基码前缀匹配在这一门上也答不对：zh-Hant 的基码是 zh，
    // SUPPORTED 里第一个 zh 是 zh-CN。
    if (base === 'zh') return LangTags.getScriptVariant(raw) === 'hant' ? 'zh-TW' : 'zh-CN';
    if (VARIANTS[base]) return VARIANTS[base];
    return SUPPORTED.find((lang) => lang.split('-')[0] === base) || 'en';
  }

  /** 浏览器自己说的语言，收进那十门。 */
  function browserLanguage() {
    const nav = root.navigator || {};
    return fromTag(nav.language || nav.userLanguage || 'en');
  }

  /**
   * 这份设置下，网页要译成哪门语言。
   *
   * 不归一化用户存下来的值：选择器里给的本来就是那十门之一，而归一化会把用户
   * 哪天手改进 storage 的写法悄悄换掉。只有「跟随浏览器」那一路需要映射。
   */
  function effective(settings) {
    const stored = settings && settings.targetLang;
    return stored || browserLanguage();
  }

  root.TargetLang = { SUPPORTED, fromTag, browserLanguage, effective };
})(globalThis);
