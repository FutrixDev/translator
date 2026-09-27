// Blab Translation background — the prompt templates and the one place a
// template turns into a system prompt.
//
// 全部集中在这里，是因为它们之间有一条约定：MATH_PLACEHOLDER_RULE 是**加在最后
// 的**，用户的自定义提示词覆盖不掉它 —— 占位符一旦被模型改写，整段公式在页面上
// 就没了。这条约定只有 buildPrompt 一个执行点，模板和执行点分在两个文件里，下一
// 个加模板的人不会知道它存在。

// 附加说明（语域）的形状和英文措辞在共享模块里，这里只拼。
import '../shared/prompt-addenda.js';

// Math placeholder rule - always appended to prompts (cannot be overridden by custom prompts)
const MATH_PLACEHOLDER_RULE = `
Placeholders such as {{1}}, {{2}} stand for formulas the page renders itself. Keep each one exactly as written, in place, with no line breaks added around it.`;

// Register rule - part of every default template, and of the format rules appended
// to a custom prompt. The model must not formalise a meme or explain a joke: casual
// text stays casual, formal text stays formal. It is appended after variable
// substitution in the custom-prompt branch, so it must not contain {placeholders}.
const REGISTER_RULE = 'Match the register of the source: casual posts stay casual, with memes and slang rendered as natural equivalents in the target language rather than formal wording or explanations; formal text stays formal';

// Single word/phrase prompt template (no math placeholder rule)
const SINGLE_WORD_PROMPT = `You are a bilingual dictionary. Translate the given word or short phrase to {targetLang}.
Return JSON only with keys "translation" and "phonetic".
- "phonetic" should be the IPA of the source word or phrase
- If phonetic is unavailable, use an empty string
- ${REGISTER_RULE}`;

const WORD_OUTPUT_RULES = `OUTPUT FORMAT:
Return JSON only with keys "translation" and "phonetic".
"phonetic" should be the IPA of the source word or phrase; if unavailable, use an empty string.`;

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

// 附加说明拼成的一块：今天只有 REGISTER 一行（这一页的体裁，只是标签，不带域名）。
// 调用方（SW 的三个处理函数）已经 validate 过；没有内容时是空串。
function composePromptAddenda(addenda) {
  if (!addenda) return '';
  const { REGISTER_SENTENCES, HEADINGS } = globalThis.PromptAddenda;
  const lines = [];
  if (addenda.register) {
    lines.push(`${HEADINGS.register} ${REGISTER_SENTENCES[addenda.register]}`);
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
