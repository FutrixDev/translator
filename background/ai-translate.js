// Blab Translation background — 用用户自己的模型翻译。
//
// 这一层只管「怎么问模型、怎么读回答」。要不要问（有没有 Key、译成哪门语言）由
// background.js 的三个 handler 答，怎么发出去由 api-client.js 答。
//
// 内置引擎（Chrome 的 Translator API）不走这里，也走不了：它是
// [Exposed=Window, SecureContext]，service worker 里根本不存在，那一路在内容脚本
// 里跑。

import '../shared/auto-stats.js';
import { languageNames } from './settings.js';
import {
  BATCH_OUTPUT_RULES,
  DEFAULT_BATCH_PROMPT,
  DEFAULT_PROMPT,
  FAST_BATCH_PROMPT,
  SINGLE_WORD_PROMPT,
  WORD_OUTPUT_RULES,
  buildPrompt,
  getFastBatchOutputRules,
} from './prompts.js';
import {
  callClaudeAPI,
  callOpenAIAPI,
  countCharsSentToModel,
  isClaudeAPI,
} from './api-client.js';

function isSingleWordText(text) {
  if (!text) return false;
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (/[\s\r\n\t]/.test(trimmed)) return false;
  return trimmed.length <= 40;
}

function parseWordTranslation(content) {
  const trimmed = (content || '').trim();
  if (!trimmed) {
    return { translation: '', phonetic: '' };
  }

  let candidate = trimmed;
  if (!candidate.startsWith('{')) {
    const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      candidate = jsonMatch[0];
    }
  }

  if (candidate.startsWith('{')) {
    try {
      const parsed = JSON.parse(candidate);
      return {
        translation: typeof parsed.translation === 'string' ? parsed.translation.trim() : trimmed,
        phonetic: typeof parsed.phonetic === 'string' ? parsed.phonetic.trim() : ''
      };
    } catch (error) {
      // Fall through to heuristic parsing
    }
  }

  const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  let translation = '';
  let phonetic = '';

  for (const line of lines) {
    if (!phonetic && /(phonetic|ipa)/i.test(line)) {
      phonetic = line.replace(/^(phonetic|ipa)\s*[:：]\s*/i, '').trim();
      continue;
    }
    if (!phonetic && /^[/\[].+[/\]]$/.test(line)) {
      phonetic = line;
      continue;
    }
    if (!translation) {
      translation = line;
    }
  }

  if (!translation) {
    translation = trimmed;
  }

  return { translation, phonetic };
}

// Translate single text with AI
async function translateWithAI(text, targetLang, settings) {
  const targetLangName = languageNames[targetLang] || targetLang;

  // Use custom prompt if provided, otherwise use default
  const promptTemplate = settings.customPrompt || DEFAULT_PROMPT;
  const systemPrompt = buildPrompt(promptTemplate, targetLangName);

  // Auto-detect API type and call appropriate function
  if (isClaudeAPI(settings.apiEndpoint)) {
    const result = await callClaudeAPI(
      settings.apiEndpoint,
      settings.apiKey,
      settings.modelName,
      systemPrompt,
      text,
      2000
    );
    return result || text;
  } else {
    const result = await callOpenAIAPI(
      settings.apiEndpoint,
      settings.apiKey,
      settings.modelName,
      systemPrompt,
      text,
      2000,
      0.3
    );
    return result || text;
  }
}

// Translate single word with IPA (no math placeholder rule)
async function translateSingleWordWithAI(text, targetLang, settings) {
  const targetLangName = languageNames[targetLang] || targetLang;
  const hasCustomPrompt = settings.customPrompt && settings.customPrompt.trim();
  const systemPrompt = hasCustomPrompt
    ? buildPrompt(settings.customPrompt, targetLangName, {}, WORD_OUTPUT_RULES, { includeMathRule: false })
    : buildPrompt(SINGLE_WORD_PROMPT, targetLangName, {}, '', { includeMathRule: false });

  let content;
  if (isClaudeAPI(settings.apiEndpoint)) {
    content = await callClaudeAPI(
      settings.apiEndpoint,
      settings.apiKey,
      settings.modelName,
      systemPrompt,
      text,
      800
    );
  } else {
    content = await callOpenAIAPI(
      settings.apiEndpoint,
      settings.apiKey,
      settings.modelName,
      systemPrompt,
      text,
      800,
      0.3
    );
  }

  const parsed = parseWordTranslation(content);
  if (!parsed.translation) {
    parsed.translation = text.trim();
  }
  return parsed;
}

async function translateTextWithMode(text, targetLang, settings, forceWord = false) {
  countCharsSentToModel(typeof text === 'string' ? text.length : 0);

  if (forceWord || isSingleWordText(text)) {
    const result = await translateSingleWordWithAI(text, targetLang, settings);
    return { ...result, isWord: true };
  }

  const translation = await translateWithAI(text, targetLang, settings);
  return { translation, phonetic: '', isWord: false };
}

// Translate batch of texts with AI (numbered format)
async function translateBatchWithAI(texts, targetLang, settings) {
  // 快速分批回退到这里时会再走一遍这一句 —— 那本来就是第二次真发出去的请求。
  countCharsSentToModel(globalThis.AutoStats.textsChars(texts));

  const targetLangName = languageNames[targetLang] || targetLang;

  // Create numbered list for batch translation
  const numberedTexts = texts.map((text, i) => `[${i + 1}] ${text}`).join('\n\n');

  // For batch translation, apply custom prompt with enforced output format
  const hasCustomPrompt = settings.customPrompt && settings.customPrompt.trim();
  const systemPrompt = hasCustomPrompt
    ? buildPrompt(settings.customPrompt, targetLangName, {}, BATCH_OUTPUT_RULES)
    : buildPrompt(DEFAULT_BATCH_PROMPT, targetLangName);

  // Auto-detect API type and call appropriate function
  let content;
  if (isClaudeAPI(settings.apiEndpoint)) {
    content = await callClaudeAPI(
      settings.apiEndpoint,
      settings.apiKey,
      settings.modelName,
      systemPrompt,
      numberedTexts,
      4000
    );
  } else {
    content = await callOpenAIAPI(
      settings.apiEndpoint,
      settings.apiKey,
      settings.modelName,
      systemPrompt,
      numberedTexts,
      4000,
      0.3
    );
  }

  // Parse numbered response
  const translations = parseNumberedResponse(content, texts.length);
  return translations;
}

// Fast batch translation with delimiter
async function translateBatchFastWithAI(texts, targetLang, settings, delimiter = '⟪⟫⟪⟫⟪⟫') {
  countCharsSentToModel(globalThis.AutoStats.textsChars(texts));

  const targetLangName = languageNames[targetLang] || targetLang;

  // Join texts with delimiter
  const joinedTexts = texts.join(delimiter);

  const hasCustomPrompt = settings.customPrompt && settings.customPrompt.trim();
  const systemPrompt = hasCustomPrompt
    ? buildPrompt(settings.customPrompt, targetLangName, { delimiter }, getFastBatchOutputRules(delimiter))
    : buildPrompt(FAST_BATCH_PROMPT, targetLangName, { delimiter });

  // Auto-detect API type and call appropriate function
  let content;
  if (isClaudeAPI(settings.apiEndpoint)) {
    content = await callClaudeAPI(
      settings.apiEndpoint,
      settings.apiKey,
      settings.modelName,
      systemPrompt,
      joinedTexts,
      16000
    );
  } else {
    content = await callOpenAIAPI(
      settings.apiEndpoint,
      settings.apiKey,
      settings.modelName,
      systemPrompt,
      joinedTexts,
      16000,
      0.1
    );
  }

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
    return translateBatchWithAI(texts, targetLang, settings);
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
  isSingleWordText,
  parseWordTranslation,
  parseNumberedResponse,
  translateWithAI,
  translateSingleWordWithAI,
  translateTextWithMode,
  translateBatchWithAI,
  translateBatchFastWithAI,
};
