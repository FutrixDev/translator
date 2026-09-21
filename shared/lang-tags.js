// Blab Translation —— 语言标签的一个主人。
//
// 「这两门语言是同一门吗」在这个扩展里被问了四次，从四个完全不同的地方：字幕
// 引擎问声道语言和目标语言，整页翻译问某一段正文和目标语言，自动翻译的决策层
// 问页面语言和目标语言，界面层问该把哪个选项标成选中。四处各写一遍的结果不是
// 「四份一样的代码」，是**同一对语言在不同地方得到不同答案**——而这种不一致
// 只会以「有时候翻、有时候不翻」的形式被用户看见，没有报错，没有日志。
//
// 所以这里是那一问的唯一出处。它是纯函数，没有 DOM、没有 chrome.*，node --test
// 里直接跑。
//
// 装载顺序：凡是装了 shared/caption-core.js 或 shared/site-rules.js 的地方，这
// 个文件都要排在它们前面——两者都在加载时就把函数取走。
// test/unit/site-rules.test.mjs 的「装载清单」那条守着这一点。
(function (root) {
  'use strict';

  /** 'zh-Hant-TW' -> 'zh'。空串表示「这不是一个语言标签」。 */
  function getLangBase(lang) {
    if (!lang) return '';
    return String(lang).split('-')[0].toLowerCase();
  }

  // 中文按地区分简繁的那些子标签。标签本身很少直接带书写系统：YouTube 发
  // `zh-Hans`/`zh-Hant`，而野生的 <track> 和 <html lang> 写 `zh-CN`/`zh-TW`
  // 的多得多。
  const ZH_HANT_SUBTAGS = new Set(['hant', 'tw', 'hk', 'mo']);
  const ZH_HANS_SUBTAGS = new Set(['hans', 'cn', 'sg', 'my']);

  /**
   * 这个中文标签写的是哪套字 —— 'hans'、'hant'，或者 '' 表示「这个标签没说」，
   * 后者也包含所有非中文的语言。
   */
  function getScriptVariant(lang) {
    const parts = String(lang || '').toLowerCase().split('-').filter(Boolean);
    if (parts[0] !== 'zh') return '';
    for (let i = 1; i < parts.length; i += 1) {
      if (ZH_HANT_SUBTAGS.has(parts[i])) return 'hant';
      if (ZH_HANS_SUBTAGS.has(parts[i])) return 'hans';
    }
    return '';
  }

  /**
   * 这两个标签是同一门语言、且是同一套字吗？
   *
   * 光比基码回答不了这一问。`zh-CN` 和 `zh-TW` 都归约成 `zh`，而它们是两套字：
   * 一份繁体的原文配简体的目标，正是用户要转换的那一件事，按基码判会答「本来
   * 就是你的语言」，于是一个字也不翻。别的语言上基码就是全部答案——`en-GB` 对
   * `en` 是同一门英语，为它花钱翻一遍才是 bug。
   *
   * 没说自己是哪套字的那一边算「同语言」，因为 `zh` 对 `zh-CN` 是真的不知道，
   * 而这一问是一道**花钱的闸**：猜「不同」是替用户买一次多半什么也没变的翻译，
   * 猜「相同」不会拿走他已有的东西。
   */
  function isSameLanguage(a, b) {
    const baseA = getLangBase(a);
    const baseB = getLangBase(b);
    if (!baseA || !baseB || baseA !== baseB) return false;
    const scriptA = getScriptVariant(a);
    const scriptB = getScriptVariant(b);
    if (!scriptA || !scriptB) return true;
    return scriptA === scriptB;
  }

  root.LangTags = {
    getLangBase,
    getScriptVariant,
    isSameLanguage,
  };
})(globalThis);
