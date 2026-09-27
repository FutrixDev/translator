// Blab Translation — 随 AI 翻译请求带去的附加说明（R33 A4：语域）
//
// 今天只有一项：register —— 这一页是什么体裁（社交帖子、论坛讨论、新闻、论文）。
// 它从内置站点表来（shared/site-rules-builtin.js 每条规则可选的 register 字段，
// SiteRules.register() 读），由发起请求的那个 frame 的内容脚本用
// ctx.withPromptAddenda 挂上消息的 `addenda` 字段（一律挂，没有语域就是 `{}`；
// 子 frame 的请求经顶层转发时原样不动）；服务工作者的三个翻译处理函数先用 validate() 把关，再由
// background/prompts.js 的 composePromptAddenda() 拼成系统提示词里的一句话。
//
// **只送标签，不送域名。** 模型要知道的是「这是论坛上的讨论」，不是「这是
// reddit.com」—— 后者是用户在看什么，前者只是一个体裁。validate() 拒收任何多出来
// 的字段，「顺手多带一个 host」在第一次测试时就红。内容脚本造不出不合法的附加
// 说明，走到 SW 还不合法只能是缺陷，所以抛、不截断、不忽略。
//
// 给模型看的都是英文常量，不进 i18n。
//
// 缓存：同一段文字在论坛上和在新闻站上可以译得不一样，所以附加说明是译文缓存的
// 第八个键因子（shared/translation-cache.js 的 addenda），键里放 stamp()，不放对象。
//
// 双模经典脚本：服务工作者 import 它，内容脚本和设置页用 <script> 装它，都从
// globalThis.PromptAddenda 取。没有依赖。
(function (root) {
  'use strict';

  // id 与给模型的英文句子一一对应。
  const REGISTERS = Object.freeze(['social', 'forum', 'news', 'academic']);

  const REGISTER_SENTENCES = Object.freeze({
    social: 'The text is a social media post. Keep it as casual as the original: render memes, slang and in-jokes with natural equivalents in the target language, and do not make them formal or explain them.',
    forum: 'The text comes from a discussion forum. Keep the conversational tone of the original: render slang and in-jokes with natural equivalents in the target language, and keep technical terms precise.',
    news: 'The text is news reporting. Keep a neutral journalistic register and keep names, places, dates and figures exact.',
    academic: 'The text is academic writing. Keep a formal register and use the established scholarly terminology of the field.',
  });

  const HEADINGS = Object.freeze({
    register: 'REGISTER:',
  });

  const TOP_FIELDS = ['register'];

  function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      && Object.getPrototypeOf(value) === Object.prototype;
  }

  // 错误信息只说哪一处不合形状。
  function invalid(what) {
    return new Error(`PromptAddenda: invalid addenda (${what})`);
  }

  /**
   * 把关：内容脚本给三种翻译消息一律盖 addenda（没有语域就是 `{}`，拼出来是
   * 空串），所以缺了这个字段也是缺陷，和形状不对一样抛。形状是 `{register?}`，
   * register 是 REGISTERS 之一；多出字段或未知语域都抛。
   */
  function validate(addenda) {
    if (addenda === undefined) throw invalid('missing');
    if (!isPlainObject(addenda)) throw invalid('not an object');
    for (const key of Object.keys(addenda)) {
      if (!TOP_FIELDS.includes(key)) throw invalid('unexpected field in addenda');
    }
    if (addenda.register !== undefined && !REGISTERS.includes(addenda.register)) {
      throw invalid('unknown register');
    }
  }

  /** 译文缓存键里的那一格：决定「这段怎么译」的部分，没有附加说明就是空串。 */
  function stamp(addenda) {
    return (addenda && addenda.register) || '';
  }

  root.PromptAddenda = Object.freeze({
    REGISTERS,
    REGISTER_SENTENCES,
    HEADINGS,
    validate,
    stamp,
  });
})(globalThis);
