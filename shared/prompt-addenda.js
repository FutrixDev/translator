// Blab Translation — 随 AI 翻译请求带去的附加说明：语域、词表、领域、页面上下文
//
// 消息的 `addenda` 字段有四项，分两处盖：
//
//   register  这一页是什么体裁（社交帖子、论坛讨论、新闻、论文，R33 A4）。它从内置
//             站点表来（shared/site-rules-builtin.js 每条规则可选的 register 字段，
//             SiteRules.register() 读），由**发起请求的那个 frame** 的内容脚本用
//             ctx.withPromptAddenda 按那个文档的地址盖上 —— 三种翻译消息一律盖，
//             没有语域就是 `{}`；同一个请求盖第二次直接抛。子 frame 的请求经顶层
//             转发时，语域原样不动。
//   glossary  这一段文字命中的用户词条（P1-C C1）、
//   domain    有效领域（本站规则 ?? 全局设置，general 不发）、
//   context   页面上下文（标题与前后文，C3）：这三项在**执行请求的那个 frame**
//             （顶层）的引擎里组装（content/engine/addenda.js 的 compose），并进已经
//             盖好的同一个 `addenda` 对象，不覆盖 register。子 frame 的请求也在顶层
//             组装：顶层的标题、顶层站点的词表。
//
// 服务工作者的三个翻译处理函数先用 validate() 把关，再由 background/prompts.js 的
// composePromptAddenda() 拼成系统提示词里的一块。形状和上限只写在这里：内容脚本
// 按 LIMITS 截断，SW 按同一份 LIMITS 拒绝。内容脚本造不出不合法的附加说明，走到
// SW 还不合法（缺字段、多字段、不认得的语域或领域、超限）只能是缺陷，所以抛、不
// 截断、不忽略。
//
// **只送标签，不送域名。** 模型要知道的是「这是论坛上的讨论」，不是「这是
// reddit.com」—— 后者是用户在看什么，前者只是一个体裁。validate() 拒收任何多出来
// 的字段，「顺手多带一个 host」在第一次测试时就红。
//
// 给模型看的都是英文常量（语域与领域句子、块标题），不进 i18n。
//
// 缓存：同一段文字在论坛上和在新闻站上、在法律领域和在医学领域可以译得不一样，
// 所以附加说明是译文缓存的第八个键因子（shared/translation-cache.js 的 addenda）。
//
// 双模经典脚本：服务工作者 import 它，内容脚本和设置页用 <script> 装它，都从
// globalThis.PromptAddenda 取。没有依赖。
(function (root) {
  'use strict';

  // id 与给模型的英文句子一一对应。语域和领域是两张表：语域由内置站点表按地址给，
  // 领域由用户选。news 与 academic 两张表里的句子一字不差；两者 id 相同时只发领域
  // 那一行（background/prompts.js 的 composePromptAddenda，D-382）。
  const REGISTERS = Object.freeze(['social', 'forum', 'news', 'academic']);

  const REGISTER_SENTENCES = Object.freeze({
    social: 'The text is a social media post. Keep it as casual as the original: render memes, slang and in-jokes with natural equivalents in the target language, and do not make them formal or explain them.',
    forum: 'The text comes from a discussion forum. Keep the conversational tone of the original: render slang and in-jokes with natural equivalents in the target language, and keep technical terms precise.',
    news: 'The text is news reporting. Keep a neutral journalistic register and keep names, places, dates and figures exact.',
    academic: 'The text is academic writing. Keep a formal register and use the established scholarly terminology of the field.',
  });

  // general 是缺省，不发句子。
  const DOMAINS = Object.freeze([
    'general', 'tech', 'academic', 'legal', 'medical', 'finance', 'gaming', 'fiction', 'news',
  ]);

  const SENTENCES = Object.freeze({
    general: '',
    tech: 'The text comes from a technology or software context. Use the standard technical terminology of the target language.',
    academic: 'The text is academic writing. Keep a formal register and use the established scholarly terminology of the field.',
    legal: 'The text is legal writing. Translate precisely, keep the legal meaning exact, and use the standard legal terminology of the target language.',
    medical: 'The text is medical or health related. Use standard medical terminology and keep dosages, units and names exact.',
    finance: 'The text is about finance or business. Use standard financial terminology and keep figures, currencies and tickers exact.',
    gaming: 'The text is about video games. Use the terminology players of the target language actually use and keep in-game names consistent.',
    fiction: 'The text is fiction. Keep the voice, tone and style of the narrative and translate dialogue naturally.',
    news: 'The text is news reporting. Keep a neutral journalistic register and keep names, places, dates and figures exact.',
  });

  const HEADINGS = Object.freeze({
    register: 'REGISTER:',
    // 第一行写明它压过模板里「术语保留原文」那一条（prompts.js 三个模板都有）。
    glossary: 'GLOSSARY (user-defined; overrides any general rule about keeping terms in their original form):',
    domain: 'DOMAIN:',
    context: 'PAGE CONTEXT (reference only; do not translate it and do not include it in the output):',
    keep: 'keep as written',
  });

  const LIMITS = Object.freeze({ entries: 60, before: 300, after: 300, title: 200, source: 80, target: 160 });

  const TOP_FIELDS = ['register', 'glossary', 'domain', 'context'];
  const ENTRY_FIELDS = ['s', 't'];
  const CONTEXT_FIELDS = ['title', 'before', 'after'];

  function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      && Object.getPrototypeOf(value) === Object.prototype;
  }

  // 错误信息只说哪一处不合形状，不带词条和页面文字（那些是用户数据）。
  function invalid(what) {
    return new Error(`PromptAddenda: invalid addenda (${what})`);
  }

  function onlyFields(object, allowed, where) {
    for (const key of Object.keys(object)) {
      if (!allowed.includes(key)) throw invalid(`unexpected field in ${where}`);
    }
  }

  function checkString(value, max, where, { allowEmpty = false } = {}) {
    if (typeof value !== 'string') throw invalid(`${where} is not a string`);
    if (!allowEmpty && value.length === 0) throw invalid(`${where} is empty`);
    if (value.length > max) throw invalid(`${where} is longer than ${max}`);
  }

  /**
   * 把关：内容脚本给三种翻译消息一律盖 addenda（没有语域就是 `{}`，拼出来是
   * 空串），所以缺了这个字段也是缺陷，和形状不对一样抛。形状是
   * `{register?, glossary?: [{s, t?}], domain?, context?: {title?, before?, after?}}`；
   * 不认得的语域或领域、超限、多出字段都抛，不截断。`glossary: []` 形状合法，
   * 拼出来是空串（内容脚本不会这样发，这里不为它另立一条拒绝）。
   */
  function validate(addenda) {
    if (addenda === undefined) throw invalid('missing');
    if (!isPlainObject(addenda)) throw invalid('not an object');
    onlyFields(addenda, TOP_FIELDS, 'addenda');

    if (addenda.register !== undefined && !REGISTERS.includes(addenda.register)) {
      throw invalid('unknown register');
    }

    if (addenda.glossary !== undefined) {
      if (!Array.isArray(addenda.glossary)) throw invalid('glossary is not an array');
      if (addenda.glossary.length > LIMITS.entries) throw invalid(`more than ${LIMITS.entries} glossary entries`);
      for (const entry of addenda.glossary) {
        if (!isPlainObject(entry)) throw invalid('glossary entry is not an object');
        onlyFields(entry, ENTRY_FIELDS, 'glossary entry');
        checkString(entry.s, LIMITS.source, 'glossary source');
        if (entry.t !== undefined) checkString(entry.t, LIMITS.target, 'glossary target');
      }
    }

    if (addenda.domain !== undefined && !DOMAINS.includes(addenda.domain)) throw invalid('unknown domain');

    if (addenda.context !== undefined) {
      if (!isPlainObject(addenda.context)) throw invalid('context is not an object');
      onlyFields(addenda.context, CONTEXT_FIELDS, 'context');
      for (const field of CONTEXT_FIELDS) {
        if (addenda.context[field] !== undefined) {
          checkString(addenda.context[field], LIMITS[field], `context ${field}`, { allowEmpty: true });
        }
      }
    }
  }

  /** 译文缓存键里语域的那一格：没有语域就是空串。 */
  function stamp(addenda) {
    return (addenda && addenda.register) || '';
  }

  root.PromptAddenda = Object.freeze({
    REGISTERS,
    REGISTER_SENTENCES,
    DOMAINS,
    SENTENCES,
    HEADINGS,
    LIMITS,
    CONTEXT_FIELDS: Object.freeze(CONTEXT_FIELDS.slice()),
    validate,
    stamp,
  });
})(globalThis);
