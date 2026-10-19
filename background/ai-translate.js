// Blab Translation background — 用用户自己的模型翻译。
//
// 这一层只管「怎么问模型、怎么读回答」。要不要问、问哪一档（有没有 Key、译成
// 哪门语言、消息里的 profileId）由 background.js 的两个 handler 答，怎么发出去
// 由 model-client.js 的 callModel 答。
//
// 五个翻译函数都收 (profile, settings)：profile 是整档（含 Key，发给谁、用哪个
// 模型），settings 只剩提示词相关的键（customPrompt）。空答案由 callModel 抛
// { empty }，这里不再拿原文当译文。
//
// 五个翻译函数都收一个可选的 addenda（语域、领域、词表、页面上下文，形状见
// shared/prompt-addenda.js，处理函数已把过关），原样交给 buildPrompt 的
// options.addenda；快速分批回落到编号法时也带着它。计字数统一走
// AutoStats.sentChars —— 源文本加上下文，语域、词表和领域不计。
//
// 内置引擎（Chrome 的 Translator API）不走这里，也走不了：它是
// [Exposed=Window, SecureContext]，service worker 里根本不存在，那一路在内容脚本
// 里跑。

import '../shared/storage-writer.js';
import '../shared/auto-stats.js';
import '../shared/batch-delimiter.js';
import '../shared/dict-entry.js';
import { languageNames } from './settings.js';
import {
  BATCH_OUTPUT_RULES,
  REGISTER_RULE,
  SINGLE_WORD_PROMPT,
  WORD_OUTPUT_RULES,
  buildPrompt,
  getFastBatchOutputRules,
} from './prompts.js';
import { countCharsSentToModel } from './api-client.js';
import { callModel } from './model-client.js';

// The template the three text paths send: the user's own prompt, or the default
// preset when there is none. Each path appends its own rules after it, so the
// prompt the settings page shows is what goes out.
function textTemplate(settings) {
  return globalThis.PromptPresets.textTemplate(settings.customPrompt);
}

// One call to this profile's model. callModel throws on an empty answer
// ({ empty }), so every path below reads a non-empty `text`. Claude ignores
// `temperature` (api-compat drops it for models that reject it).
async function ask(profile, system, user, maxTokens, temperature) {
  const { text } = await callModel(profile, { system, user, maxTokens, temperature });
  return text;
}

// Translate single text with AI
async function translateWithAI(text, targetLang, profile, settings, addenda) {
  const targetLangName = languageNames[targetLang] || targetLang;

  // The register rule follows the template, as the batch paths append their
  // format rules.
  const systemPrompt = buildPrompt(textTemplate(settings), targetLangName, {}, REGISTER_RULE, { addenda });

  return ask(profile, systemPrompt, text, 2000, 0.3);
}

// Look a word or short phrase up as a dictionary entry (no math placeholder
// rule). The answer must be the entry JSON that DictEntry.OUTPUT_RULES asks for;
// DictEntry.fromModelText validates it and throws { invalidEntry } otherwise —
// no line-guessing, no raw text passed off as a translation. The entry is bigger
// than a bare translation, hence 1500 tokens; a model that bills hidden
// reasoning tokens is raised to api-compat's REASONING_TOKEN_FLOOR (2000).
async function translateSingleWordWithAI(text, targetLang, profile, settings, addenda) {
  const targetLangName = languageNames[targetLang] || targetLang;
  // The rules come last whichever template leads, and their last line says the
  // entry format overrides the template's own reply format (D-472). Only a prompt
  // of the user's own leads here: the default text preset is a page-translation
  // template, and a lookup without one keeps the dictionary prompt.
  const template = globalThis.PromptPresets.isDefault(settings.customPrompt)
    ? SINGLE_WORD_PROMPT
    : settings.customPrompt;
  const systemPrompt = buildPrompt(template, targetLangName, {}, WORD_OUTPUT_RULES, { includeMathRule: false, addenda });

  return globalThis.DictEntry.fromModelText(await ask(profile, systemPrompt, text, 1500, 0.3));
}

// One TRANSLATE answer. Only the caller decides whether this is a dictionary
// lookup (mode 'word'); the answer is then { translation, entry }, otherwise
// { translation }. The content engine stamps `engine` on either.
async function translateTextWithMode(text, targetLang, profile, settings, forceWord = false, addenda) {
  countCharsSentToModel(globalThis.AutoStats.sentChars(text, addenda));

  if (forceWord) {
    const entry = await translateSingleWordWithAI(text, targetLang, profile, settings, addenda);
    return { translation: entry.translation, entry };
  }

  return { translation: await translateWithAI(text, targetLang, profile, settings, addenda) };
}

// Translate batch of texts with AI (numbered format)
async function translateBatchWithAI(texts, targetLang, profile, settings, addenda) {
  // 快速分批回退到这里时会再走一遍这一句 —— 那本来就是第二次真发出去的请求。
  countCharsSentToModel(globalThis.AutoStats.sentChars(texts, addenda));

  const targetLangName = languageNames[targetLang] || targetLang;

  // Create numbered list for batch translation
  const numberedTexts = texts.map((text, i) => `[${i + 1}] ${text}`).join('\n\n');

  // The template with the numbered output format enforced after it
  const systemPrompt = buildPrompt(textTemplate(settings), targetLangName, {}, BATCH_OUTPUT_RULES, { addenda });

  const content = await ask(profile, systemPrompt, numberedTexts, 4000, 0.3);
  return parseNumberedResponse(content, texts.length);
}

// Fast batch translation with the one delimiter (shared/batch-delimiter.js)
async function translateBatchFastWithAI(texts, targetLang, profile, settings, addenda) {
  countCharsSentToModel(globalThis.AutoStats.sentChars(texts, addenda));

  const delimiter = globalThis.BATCH_DELIMITER;
  const targetLangName = languageNames[targetLang] || targetLang;

  // Join texts with delimiter
  const joinedTexts = texts.join(delimiter);

  const systemPrompt = buildPrompt(textTemplate(settings), targetLangName, { delimiter }, getFastBatchOutputRules(delimiter), { addenda });

  const content = await ask(profile, systemPrompt, joinedTexts, 16000, 0.1);

  // Parse by delimiter
  const segments = content.split(delimiter).map(t => t.trim());

  // 段数必须与输入数量一致，否则按位置回填不可靠。模型偶尔会漏掉/多打一个分隔符
  // （或把相邻两段合并），此时若像以前那样 pad/truncate 到 texts.length，会把数量
  // 错误“抹平”，导致整批从出错点起往后错开一位——A 段挂上 B 段的译文。
  // 改为回退到编号法：[1][2]… 按编号精确对齐，对漏标记/乱序稳健，最坏是某段未译
  // 而非串位。仅在极少数不匹配时多发一次请求。
  if (segments.length !== texts.length) {
    console.warn(
      `Blab Translation: fast-batch delimiter split produced ${segments.length} segments ` +
      `for ${texts.length} inputs; falling back to numbered batch to avoid misaligned translations`
    );
    return translateBatchWithAI(texts, targetLang, profile, settings, addenda);
  }

  return segments;
}

// Parse numbered response from AI
function parseNumberedResponse(content, expectedCount) {
  const translations = [];

  // Build an array of split positions for each expected marker [1], [2], ...
  // Only match markers that appear at line start or after whitespace to avoid
  // false positives with citation-style references like "see [1]" inside text.
  const markerPositions = [];
  for (let i = 1; i <= expectedCount; i++) {
    // Match [i] that is either at the start of the string or preceded by a newline
    const pattern = new RegExp(`(?:^|\\n)\\s*\\[${i}\\]\\s*`, 'g');
    let m;
    while ((m = pattern.exec(content)) !== null) {
      markerPositions.push({ index: i, start: m.index, end: m.index + m[0].length });
    }
  }

  // Sort by position in the string
  markerPositions.sort((a, b) => a.start - b.start);

  // Deduplicate: keep only the first occurrence of each index
  const seen = new Set();
  const uniqueMarkers = markerPositions.filter(m => {
    if (seen.has(m.index)) return false;
    seen.add(m.index);
    return true;
  });

  // Extract text between markers
  if (uniqueMarkers.length === expectedCount) {
    for (let i = 0; i < uniqueMarkers.length; i++) {
      const textStart = uniqueMarkers[i].end;
      const textEnd = i + 1 < uniqueMarkers.length ? uniqueMarkers[i + 1].start : content.length;
      translations.push(content.slice(textStart, textEnd).trim());
    }
    return translations;
  }

  // Fallback: try the original greedy approach
  for (let i = 1; i <= expectedCount; i++) {
    const pattern = new RegExp(`\\[${i}\\]\\s*([\\s\\S]*?)(?=\\[${i + 1}\\]|$)`, 'i');
    const match = content.match(pattern);
    translations.push(match ? match[1].trim() : '');
  }

  // If parsing failed, try splitting by line
  if (translations.every(t => !t)) {
    const lines = content.split('\n').filter(line => line.trim());
    for (let i = 0; i < expectedCount; i++) {
      translations[i] = lines[i]?.replace(/^\[\d+\]\s*/, '').trim() || '';
    }
  }

  return translations;
}

export {
  parseNumberedResponse,
  translateWithAI,
  translateSingleWordWithAI,
  translateTextWithMode,
  translateBatchWithAI,
  translateBatchFastWithAI,
};
