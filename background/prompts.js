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

// Math placeholder rule - always appended to prompts (cannot be overridden by custom prompts)
const MATH_PLACEHOLDER_RULE = `
Placeholders such as {{1}}, {{2}} stand for formulas the page renders itself. Keep each one exactly as written, in place, with no line breaks added around it.`;

// Register rule - part of every text path: every default text template, and the
// rules appended to a custom prompt on the single-text, numbered-batch and
// fast-batch paths. The model must not formalise a meme or explain a joke: casual
// text stays casual, formal text stays formal. Only this rule stays off the
// word/dictionary path, since a dictionary entry has no tone to match; that path
// still gets the page-kind addenda (composePromptAddenda) like every other one.
// It is appended after variable substitution in the custom-prompt branch, so it
// must not contain {placeholders}.
const REGISTER_RULE = 'Match the register of the source: casual posts stay casual, with memes and slang rendered as natural equivalents in the target language rather than formal wording or explanations; formal text stays formal';

// Dictionary lookup prompt (no math placeholder rule). Like a custom prompt, it
// is followed by WORD_OUTPUT_RULES as buildPrompt's extraRules, so every lookup
// ends in DictEntry.OUTPUT_RULES — after the addenda too — and asks for exactly
// the entry the service worker accepts (shared/dict-entry.js).
const SINGLE_WORD_PROMPT = 'You are a bilingual dictionary. Look up the given word or short phrase for a reader of {targetLang}; write translations and definitions in {targetLang}.';

const WORD_OUTPUT_RULES = globalThis.DictEntry.OUTPUT_RULES;

// Default prompt template
const DEFAULT_PROMPT = `You are a professional translator. Translate the given text to {targetLang}.
Rules:
1. Reply with the translation only, no explanations or notes
2. Maintain the original formatting (line breaks, punctuation)
3. Keep technical terms, brand names, and proper nouns in their original form when appropriate
4. If the text is already in the target language, return it unchanged (no paraphrasing or reordering)
5. Translate naturally, not literally
6. ${REGISTER_RULE}`;

// Default batch prompt template
const DEFAULT_BATCH_PROMPT = `You are a professional translator. Translate the given numbered texts to {targetLang}.
Rules:
1. Return translations in the same numbered format: [1] translation1 [2] translation2 etc.
2. Keep the numbering system exactly as given
3. Maintain original formatting within each translation
4. Keep technical terms, brand names, and proper nouns in their original form when appropriate
5. If a text is already in the target language, return it unchanged (no paraphrasing or reordering)
6. Translate naturally, not literally
7. ${REGISTER_RULE}`;

// Batch output rules appended when using custom prompts
const BATCH_OUTPUT_RULES = `BATCH FORMAT RULES:
1. Return translations in the same numbered format: [1] translation1 [2] translation2 etc.
2. Keep the numbering system exactly as given
3. Output the translations and nothing else
4. ${REGISTER_RULE}`;


// Fast batch prompt template
const FAST_BATCH_PROMPT = `You are a professional translator. Translate multiple text segments to {targetLang}.

The segments are parsed by a program, so the output format is a contract:
1. Input segments are separated by "{delimiter}"
2. Output translations separated by "{delimiter}", in the same order
3. Output the translations and nothing else
4. Keep technical terms, brand names, proper nouns in original form
5. If a segment is already in the target language, return it unchanged (no paraphrasing or reordering)
6. The number of output segments equals the number of input segments; an empty segment stays empty
7. Preserve placeholders and inline tags: keep {{1}}-style placeholders unchanged, and keep paired tags like <a1>...</a1> or <strong2>...</strong2> with the same names and numbers, wrapping the translated text they originally wrapped. Do not invent, drop, or renumber tags.
8. ${REGISTER_RULE}

Example (target language shown as Chinese):
Input: Hello{delimiter}Read <a1>the docs</a1> first{delimiter}Thank you
Output: 你好{delimiter}请先阅读<a1>文档</a1>{delimiter}谢谢`;

// Fast batch output rules appended when using custom prompts
function getFastBatchOutputRules(delimiter) {
  return `BATCH FORMAT RULES:
1. Input segments are separated by "${delimiter}"
2. Output translations separated by "${delimiter}", in the same order
3. Output the translations and nothing else
4. The number of output segments equals the number of input segments; an empty segment stays empty
5. Preserve placeholders and inline tags: keep {{1}}-style placeholders unchanged, and keep paired tags like <a1>...</a1> with the same names and numbers, wrapping the translated text they originally wrapped. Do not invent, drop, or renumber tags.
6. ${REGISTER_RULE}`;
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
  SINGLE_WORD_PROMPT,
  WORD_OUTPUT_RULES,
  DEFAULT_PROMPT,
  DEFAULT_BATCH_PROMPT,
  BATCH_OUTPUT_RULES,
  FAST_BATCH_PROMPT,
  getFastBatchOutputRules,
  REGISTER_RULE,
  composePromptAddenda,
  buildPrompt,
};
