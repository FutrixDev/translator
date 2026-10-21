// Blab Translation background — the prompt templates and the one place a
// template turns into a system prompt.
//
// 全部集中在这里，是因为它们之间有一条约定：MATH_PLACEHOLDER_RULE 是**加在最后
// 的**，用户的自定义提示词覆盖不掉它 —— 占位符一旦被模型改写，整段公式在页面上
// 就没了。这条约定只有 buildPrompt 一个执行点，模板和执行点分在两个文件里，下一
// 个加模板的人不会知道它存在。

// 附加说明（语域、词表、领域、页面上下文）的形状、上限和英文措辞在共享模块里，这里只拼。
import '../shared/prompt-addenda.js';
// 词典条目（单词/短语查词）的形状与输出规则只写在共享模块里：校验器认的字段就是
// 提示词要的字段（shared/dict-entry.js 的 FIELDS）。
import '../shared/dict-entry.js';
// 文本三条路径的模板（用户的提示词，或没有时的默认预设）只写在共享模块里：设置页
// 框里显示的就是这里发出去的。
import '../shared/prompt-presets.js';

// Math placeholder rule - always appended to prompts (cannot be overridden by custom prompts)
const MATH_PLACEHOLDER_RULE = `
Placeholders such as {{1}}, {{2}} stand for formulas the page renders itself. Keep each one exactly as written, in place, with no line breaks added around it.`;

// Register rule - part of every text path: the rules appended to the template on
// the single-text, numbered-batch and fast-batch paths. The model must not formalise a meme or explain a joke: casual
// text stays casual, formal text stays formal. Only this rule stays off the
// word/dictionary path, since a dictionary entry has no tone to match; that path
// still gets the page-kind addenda (composePromptAddenda) like every other one.
// It is appended after variable substitution in the custom-prompt branch, so it
// must not contain {placeholders}.
const REGISTER_RULE = 'Match the register of the source: casual posts stay casual, with memes and slang rendered as natural equivalents in the target language rather than formal wording or explanations; formal text stays formal';

// Dictionary lookup prompts (no math placeholder rule), one per WORD_LANGS
// value: what the content side could prove about the word's language
// (content/content-dict-lookup.js). Like a custom prompt, each is followed by
// its mode's DictEntry.RULES as buildPrompt's extraRules, so every lookup ends
// in those rules — after the addenda too — and asks for exactly the entry the
// service worker accepts (shared/dict-entry.js).
//   other    the word is in another language: a bilingual dictionary.
//   target   the word is already in the target language: a monolingual one.
//   unknown  nobody could tell (a short Latin word): the model decides, and
//            says which it wrote in "monolingual".
const { WORD_LANGS, RULES } = globalThis.DictEntry;
const WORD_PROMPTS = Object.freeze({
  [WORD_LANGS.OTHER]: 'You are a bilingual dictionary. Look up the given word or short phrase for a reader of {targetLang}; write translations and definitions in {targetLang}.',
  [WORD_LANGS.TARGET]: 'You are a monolingual {targetLang} dictionary. Look up the given {targetLang} word or short phrase for a reader of {targetLang}; write its gloss, definitions and examples in {targetLang}, without translating it.',
  [WORD_LANGS.UNKNOWN]: 'You are a dictionary for a reader of {targetLang}. The given word or short phrase may already be a word of {targetLang}, or a word of another language. If it is a word of {targetLang}, look it up as a monolingual {targetLang} dictionary does, without translating it; otherwise look it up as a bilingual dictionary does and translate it into {targetLang}. Write definitions in {targetLang}, and say in "monolingual" which entry you wrote.',
});

// Keyed by the request's `wordLang`, the keys of DictEntry.RULES; built from
// RULES so a mode with rules but no prompt (or the reverse) throws here, at
// load. DictEntry.fromModelText reads the same key to stamp
// `entry.monolingual` (fixed when the language was proven, the model's own
// answer when it was unknown).
const WORD_MODES = Object.freeze(Object.fromEntries(Object.entries(RULES).map(([wordLang, rules]) => {
  const prompt = WORD_PROMPTS[wordLang];
  if (!prompt) throw new Error(`word lookup: no prompt for wordLang ${wordLang}`);
  return [wordLang, Object.freeze({ prompt, rules })];
})));

// The text paths (single, numbered batch, fast batch) send one template — the
// user's prompt, or PromptPresets' default when there is none
// (PromptPresets.textTemplate) — followed by that path's rules below. So the
// prompt the settings page shows is the prompt that goes out, and each path
// carries REGISTER_RULE exactly once, in its rules.
// Batch output rules appended to the template on the numbered-batch path
const BATCH_OUTPUT_RULES = `BATCH FORMAT RULES:
1. Return translations in the same numbered format: [1] translation1 [2] translation2 etc.
2. Keep the numbering system exactly as given
3. Output the translations and nothing else
4. ${REGISTER_RULE}`;


// Fast batch output rules appended to the template on the fast-batch path. The
// segments are parsed by a program, so this is a contract; the example shows it.
function getFastBatchOutputRules(delimiter) {
  return `BATCH FORMAT RULES:
1. Input segments are separated by "${delimiter}"
2. Output translations separated by "${delimiter}", in the same order
3. Output the translations and nothing else
4. The number of output segments equals the number of input segments; an empty segment stays empty
5. Preserve placeholders and inline tags: keep {{1}}-style placeholders unchanged, and keep paired tags like <a1>...</a1> with the same names and numbers, wrapping the translated text they originally wrapped. Do not invent, drop, or renumber tags.
6. ${REGISTER_RULE}

Example (target language shown as Chinese):
Input: Hello${delimiter}Read <a1>the docs</a1> first${delimiter}Thank you
Output: 你好${delimiter}请先阅读<a1>文档</a1>${delimiter}谢谢`;
}

// 附加说明拼成的一块：REGISTER / DOMAIN / GLOSSARY / PAGE CONTEXT，各有内容才写。
// 顺序（D-382）：语域和领域说的都是「这是什么样的文字」，相邻放；词表是落笔时逐条
// 查的对照；页面上下文放最后，离模板最远、紧挨数学规则之前，不会被当成要译的正文。
// 语域和有效领域是同一个 id（news、academic 两边都有）时只写 DOMAIN 那一行：同一件
// 事说两遍，领域那句更具体。general 没有句子，不写 DOMAIN。
// 用户和页面来的字符串一律经 JSON.stringify —— 引号和换行都带反斜杠，块里就不会出现
// 「segments are separated by "」这句话（mock 服务器和模型都靠它认分隔符）。
// 调用方（SW 的三个处理函数）已经 validate 过；没有内容时是空串。
function composePromptAddenda(addenda) {
  if (!addenda) return '';
  const { REGISTER_SENTENCES, SENTENCES, HEADINGS } = globalThis.PromptAddenda;
  const lines = [];
  const domain = addenda.domain && SENTENCES[addenda.domain] ? addenda.domain : null;
  if (addenda.register && addenda.register !== domain) {
    lines.push(`${HEADINGS.register} ${REGISTER_SENTENCES[addenda.register]}`);
  }
  if (domain) {
    lines.push(`${HEADINGS.domain} ${SENTENCES[domain]}`);
  }
  if (addenda.glossary && addenda.glossary.length > 0) {
    lines.push(HEADINGS.glossary);
    for (const entry of addenda.glossary) {
      const target = entry.t === undefined ? HEADINGS.keep : JSON.stringify(entry.t);
      lines.push(`- ${JSON.stringify(entry.s)} → ${target}`);
    }
  }
  if (addenda.context) {
    const context = {};
    for (const field of globalThis.PromptAddenda.CONTEXT_FIELDS) {
      if (addenda.context[field]) context[field] = addenda.context[field];
    }
    if (Object.keys(context).length > 0) {
      lines.push(HEADINGS.context, JSON.stringify(context));
    }
  }
  return lines.join('\n');
}

// Build prompt with variable substitution
// 顺序：模板 → 附加说明块 → MATH_PLACEHOLDER_RULE → extraRules。附加说明块在
// options.addenda 里，两个 return 分支共用一处拼接，单词翻译那条分支也带；它在
// 变量替换之后才拼上，不经过 {var} 替换。
// Appends MATH_PLACEHOLDER_RULE unless includeMathRule is false
function buildPrompt(template, targetLangName, variables = {}, extraRules = '', options = {}) {
  const includeMathRule = options.includeMathRule !== false;
  let prompt = template.replace(/\{targetLang\}/g, targetLangName);
  for (const [key, value] of Object.entries(variables)) {
    prompt = prompt.replaceAll(`{${key}}`, value);
  }
  const block = composePromptAddenda(options.addenda);
  const head = prompt + (block ? '\n\n' + block : '') + (includeMathRule ? MATH_PLACEHOLDER_RULE : '');
  return extraRules ? head + '\n\n' + extraRules : head;
}

export {
  MATH_PLACEHOLDER_RULE,
  WORD_MODES,
  BATCH_OUTPUT_RULES,
  getFastBatchOutputRules,
  REGISTER_RULE,
  composePromptAddenda,
  buildPrompt,
};
