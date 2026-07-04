// AI Translator Background Script
import '../i18n/messages.js';

// Update extension icon based on theme
async function updateIcon(theme) {
  const suffix = theme === 'light' ? '-light' : '';
  const iconPaths = {
    "16": `icons/icon16${suffix}.png`,
    "32": `icons/icon32${suffix}.png`,
    "48": `icons/icon48${suffix}.png`,
    "128": `icons/icon128${suffix}.png`
  };
  
  try {
    await chrome.action.setIcon({ path: iconPaths });
  } catch (error) {
    // If light icons don't exist, fall back to default icons
    if (suffix === '-light') {
      console.log('Light icons not found, using default icons');
      await chrome.action.setIcon({
        path: {
          "16": "icons/icon16.png",
          "32": "icons/icon32.png",
          "48": "icons/icon48.png",
          "128": "icons/icon128.png"
        }
      }).catch(() => {});
    }
  }
}

// Listen for storage changes to update icon
chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'sync' && changes.theme) {
    updateIcon(changes.theme.newValue);
  }
  if (namespace === 'sync' && (changes.targetLang || changes.targetLangSetByUser)) {
    refreshContextMenuTitles();
  }
});

// Initialize icon on startup
chrome.storage.sync.get({ theme: 'light' }, (result) => {
  updateIcon(result.theme);
});

// Language display names
const languageNames = {
  'zh-CN': '简体中文',
  'zh-TW': '繁体中文',
  'en': 'English',
  'ja': '日本語',
  'ko': '한국어',
  'fr': 'Français',
  'de': 'Deutsch',
  'es': 'Español',
  'ru': 'Русский'
};

// Math placeholder rule - always appended to prompts (cannot be overridden by custom prompts)
const MATH_PLACEHOLDER_RULE = `
IMPORTANT: Keep placeholders like {{1}}, {{2}} etc. exactly as they are - do not translate, modify, or add line breaks around them.`;

// Single word/phrase prompt template (no math placeholder rule)
const SINGLE_WORD_PROMPT = `You are a bilingual dictionary. Translate the given word or short phrase to {targetLang}.
Return JSON only with keys "translation" and "phonetic".
- "phonetic" should be the IPA of the source word or phrase
- If phonetic is unavailable, use an empty string`;

const WORD_OUTPUT_RULES = `OUTPUT FORMAT:
Return JSON only with keys "translation" and "phonetic".
"phonetic" should be the IPA of the source word or phrase; if unavailable, use an empty string.`;

// Default prompt template
const DEFAULT_PROMPT = `You are a professional translator. Translate the given text to {targetLang}.
Rules:
1. Provide ONLY the translation, no explanations or notes
2. Maintain the original formatting (line breaks, punctuation)
3. Keep technical terms, brand names, and proper nouns in their original form when appropriate
4. If the text is already in the target language, return it EXACTLY as is (no paraphrasing or reordering)
5. Translate naturally, not literally`;

// Default batch prompt template
const DEFAULT_BATCH_PROMPT = `You are a professional translator. Translate the given numbered texts to {targetLang}.
Rules:
1. Return translations in the SAME numbered format: [1] translation1 [2] translation2 etc.
2. Keep the numbering system exactly as given
3. Maintain original formatting within each translation
4. Keep technical terms, brand names, and proper nouns in their original form when appropriate
5. If a text is already in the target language, return it EXACTLY as is (no paraphrasing or reordering)
6. Translate naturally, not literally`;

// Batch output rules appended when using custom prompts
const BATCH_OUTPUT_RULES = `BATCH FORMAT RULES:
1. Return translations in the SAME numbered format: [1] translation1 [2] translation2 etc.
2. Keep the numbering system exactly as given
3. Output ONLY the translations, nothing else`;

// Get browser language and map to supported language
function getBrowserLanguage() {
  const browserLang = navigator.language || 'en';
  const supportedLangs = ['zh-CN', 'zh-TW', 'en', 'ja', 'ko', 'fr', 'de', 'es', 'pt', 'ru'];

  if (supportedLangs.includes(browserLang)) {
    return browserLang;
  }

  const langMap = {
    'zh': 'zh-CN',
    'zh-Hans': 'zh-CN',
    'zh-Hant': 'zh-TW',
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

  if (langMap[browserLang]) {
    return langMap[browserLang];
  }

  const prefix = browserLang.split('-')[0];
  const prefixMatch = supportedLangs.find(lang => lang.startsWith(prefix));
  if (prefixMatch) {
    return prefixMatch;
  }

  return 'en';
}

// Default settings
const defaultSettings = {
  apiEndpoint: 'https://api.openai.com/v1/chat/completions',
  apiKey: '',
  modelName: 'gpt-4.1-mini',
  targetLang: '', // Empty means use browser language
  targetLangSetByUser: false,
  customPrompt: '',
  theme: 'light'
};

const MENU_IDS = {
  translateSelection: 'translate-selection',
  translatePage: 'translate-page',
  removeInlineTranslation: 'remove-inline-translation',
};

function getContextMenuLanguage(settings) {
  const effectiveLang = getEffectiveTargetLang(settings);
  if (typeof globalThis.getUILanguage === 'function') {
    return globalThis.getUILanguage(effectiveLang);
  }
  return 'en';
}

function getContextMenuTitle(key, uiLang) {
  if (typeof globalThis.getMessage === 'function') {
    return globalThis.getMessage(key, uiLang);
  }
  return key;
}

async function refreshContextMenuTitles() {
  const settings = await chrome.storage.sync.get(defaultSettings);
  const uiLang = getContextMenuLanguage(settings);

  chrome.contextMenus.update(MENU_IDS.translateSelection, {
    title: getContextMenuTitle('contextTranslateSelection', uiLang),
  });
  chrome.contextMenus.update(MENU_IDS.translatePage, {
    title: getContextMenuTitle('contextTranslatePage', uiLang),
  });
  chrome.contextMenus.update(MENU_IDS.removeInlineTranslation, {
    title: getContextMenuTitle('contextRemoveInlineTranslation', uiLang),
  });
}

function createContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_IDS.translateSelection,
      title: 'Translate Selection',
      contexts: ['selection']
    });

    chrome.contextMenus.create({
      id: MENU_IDS.translatePage,
      title: 'Translate Page',
      contexts: ['page']
    });

    chrome.contextMenus.create({
      id: MENU_IDS.removeInlineTranslation,
      title: 'Remove Translation',
      contexts: ['all'],
      visible: false
    });

    refreshContextMenuTitles();
  });
}

// Detect if the API endpoint is Anthropic Claude API
function isClaudeAPI(endpoint) {
  if (!endpoint) return false;
  // Check for Anthropic domain or /v1/messages path
  return endpoint.includes('anthropic.com') || endpoint.includes('/v1/messages');
}

// Parse API error from response data (handles different vendor formats)
function parseAPIError(data, httpStatus) {
  // Check for error field in response body (OpenAI, OpenRouter, etc.)
  if (data?.error) {
    const error = data.error;
    // OpenAI/OpenRouter format: {"error": {"message": "...", "code": ...}}
    if (typeof error === 'object') {
      const message = error.message || error.msg || JSON.stringify(error);
      const code = error.code || error.type || httpStatus;
      return { isError: true, message, code };
    }
    // Simple string error
    if (typeof error === 'string') {
      return { isError: true, message: error, code: httpStatus };
    }
  }

  // Claude API format: {"type": "error", "error": {...}}
  if (data?.type === 'error' && data?.error) {
    const message = data.error.message || JSON.stringify(data.error);
    return { isError: true, message, code: data.error.type || httpStatus };
  }

  // Ollama format: {"error": "..."}
  if (typeof data?.error === 'string') {
    return { isError: true, message: data.error, code: httpStatus };
  }

  // No error found
  return { isError: false };
}

// Format error message for user display
function formatErrorMessage(message, code) {
  // Common error code mappings
  const errorCodeMessages = {
    401: '认证失败：请检查 API Key 是否正确',
    402: '额度不足：请检查账户余额或升级套餐',
    403: '访问被拒绝：API Key 可能没有权限',
    404: '模型不存在：请检查模型名称是否正确',
    429: '请求过于频繁：请稍后重试',
    500: '服务器错误：API 服务暂时不可用',
    502: '网关错误：API 服务暂时不可用',
    503: '服务不可用：API 服务暂时不可用'
  };

  // If code is a known HTTP status, prepend a helpful message
  const numericCode = parseInt(code);
  if (errorCodeMessages[numericCode]) {
    return `${errorCodeMessages[numericCode]}\n${message}`;
  }

  return message;
}

// Call Claude API with Anthropic-specific format
async function callClaudeAPI(endpoint, apiKey, model, systemPrompt, userContent, maxTokens = 4096) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: model,
      // Latest Claude models may spend budget on thinking; floor it so short
      // translations aren't truncated to empty (see tokenBudgetFor).
      max_tokens: tokenBudgetFor(model, maxTokens),
      system: systemPrompt,
      messages: [
        { role: 'user', content: userContent }
      ]
    })
  });

  const data = await response.json().catch(() => ({}));

  // Check HTTP status first
  if (!response.ok) {
    const errorInfo = parseAPIError(data, response.status);
    const message = errorInfo.isError
      ? formatErrorMessage(errorInfo.message, errorInfo.code)
      : `API 错误: ${response.status}`;
    throw new Error(message);
  }

  // Also check for error in response body (some APIs return 200 with error)
  const errorInfo = parseAPIError(data, response.status);
  if (errorInfo.isError) {
    throw new Error(formatErrorMessage(errorInfo.message, errorInfo.code));
  }

  // Claude response format: { content: [{ type: "text", text: "..." }] }
  return data.content?.[0]?.text?.trim() || '';
}

// Normalize a model name for capability detection (strip provider prefixes like "openai/").
function normalizeModelName(model) {
  const name = String(model || '').toLowerCase().trim();
  return name.includes('/') ? name.split('/').pop() : name;
}

// GPT-5.x and o-series reasoning models renamed `max_tokens` to `max_completion_tokens`
// and only accept the default temperature (an explicit temperature returns HTTP 400).
function isOpenAIReasoningModel(model) {
  const name = normalizeModelName(model);
  return /^gpt-5/.test(name) || /^o[1-9]/.test(name);
}

// The GPT-5 family (gpt-5, gpt-5-mini, gpt-5.4-mini, gpt-5.5, ...) accepts the
// `reasoning_effort` control; 'minimal' skips heavy chain-of-thought, keeping
// translation fast and cheap. The o-series (o1..) does NOT support 'minimal',
// so it is only sent for gpt-5*.
function isGpt5Family(model) {
  return /^gpt-5/.test(normalizeModelName(model));
}

// Newer Claude models reject `temperature`/`top_p` ("deprecated for this model"),
// including when reached through an OpenAI-compatible gateway. The native Claude
// path already omits temperature, so mirror that here for any Claude model.
function isClaudeModelName(model) {
  const name = normalizeModelName(model);
  return /claude|opus|sonnet|haiku|fable/.test(name);
}

// Reasoning (GPT-5/o-series) and modern thinking (Claude) models spend part of
// the output budget on hidden reasoning/thinking tokens. A short call such as a
// single-word lookup (budget 800) can be consumed entirely by that hidden spend,
// returning empty text with finish_reason "length". Give these models a floor so
// the visible translation always has room. The token limit is only a cap, so
// raising it never lengthens a normal translation.
const REASONING_TOKEN_FLOOR = 2000;

function tokenBudgetFor(model, maxTokens) {
  if (isOpenAIReasoningModel(model) || isClaudeModelName(model)) {
    return Math.max(maxTokens, REASONING_TOKEN_FLOOR);
  }
  return maxTokens;
}

// Build an OpenAI-compatible request body with model-aware parameters.
function buildOpenAIRequestBody(model, messages, maxTokens, temperature) {
  const body = { model, messages };
  const tokenLimit = tokenBudgetFor(model, maxTokens);

  if (isOpenAIReasoningModel(model)) {
    // GPT-5.x / o-series: new token-limit field, default temperature only.
    body.max_completion_tokens = tokenLimit;
    // Skip heavy chain-of-thought for translation (GPT-5 family only).
    if (isGpt5Family(model)) {
      body.reasoning_effort = 'minimal';
    }
  } else {
    body.max_tokens = tokenLimit;
    if (typeof temperature === 'number' && !isClaudeModelName(model)) {
      body.temperature = temperature;
    }
  }

  return body;
}

// Call OpenAI-compatible API
async function callOpenAIAPI(endpoint, apiKey, model, systemPrompt, userContent, maxTokens = 4096, temperature = 0.3) {
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent }
  ];
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify(buildOpenAIRequestBody(model, messages, maxTokens, temperature))
  });

  const data = await response.json().catch(() => ({}));

  // Check HTTP status first
  if (!response.ok) {
    const errorInfo = parseAPIError(data, response.status);
    const message = errorInfo.isError
      ? formatErrorMessage(errorInfo.message, errorInfo.code)
      : `API 错误: ${response.status}`;
    throw new Error(message);
  }

  // Also check for error in response body (some APIs like OpenRouter return 200 with error)
  const errorInfo = parseAPIError(data, response.status);
  if (errorInfo.isError) {
    throw new Error(formatErrorMessage(errorInfo.message, errorInfo.code));
  }

  // OpenAI response format: { choices: [{ message: { content: "..." } }] }
  return data.choices?.[0]?.message?.content?.trim() || '';
}

// Message listener
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'INLINE_CONTEXT_MENU_STATE':
      if (typeof message.visible === 'boolean') {
        chrome.contextMenus.update(MENU_IDS.removeInlineTranslation, {
          visible: message.visible
        }, () => {
          if (chrome.runtime.lastError) return;
          if (chrome.contextMenus.refresh) {
            chrome.contextMenus.refresh();
          }
        });
      }
      break;
    case 'TRANSLATE':
      handleTranslate(message.text, message.targetLang, message.mode)
        .then(sendResponse)
        .catch(error => sendResponse({ error: error.message }));
      return true; // Keep channel open for async response

    case 'TRANSLATE_BATCH':
      handleBatchTranslate(message.texts, message.targetLang)
        .then(sendResponse)
        .catch(error => sendResponse({ error: error.message }));
      return true;

    case 'TRANSLATE_BATCH_FAST':
      handleBatchTranslateFast(message.texts, message.targetLang, message.delimiter)
        .then(sendResponse)
        .catch(error => sendResponse({ error: error.message }));
      return true;

    case 'OPEN_OPTIONS':
      chrome.runtime.openOptionsPage();
      break;
  }
});

// Context menu for right-click translation
chrome.runtime.onInstalled.addListener(() => {
  createContextMenus();
});

chrome.runtime.onStartup.addListener(() => {
  createContextMenus();
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === MENU_IDS.translateSelection && info.selectionText) {
    try {
      const settings = await chrome.storage.sync.get(defaultSettings);
      const effectiveLang = getEffectiveTargetLang(settings);
      const result = await translateTextWithMode(info.selectionText, effectiveLang, settings);

      chrome.tabs.sendMessage(tab.id, {
        type: 'SHOW_TRANSLATION',
        text: info.selectionText,
        translation: result.translation,
        phonetic: result.phonetic || '',
        isWord: result.isWord === true
      });
    } catch (error) {
      console.error('Translation failed:', error);
    }
  } else if (info.menuItemId === MENU_IDS.translatePage) {
    chrome.tabs.sendMessage(tab.id, { type: 'TRANSLATE_PAGE' });
  } else if (info.menuItemId === MENU_IDS.removeInlineTranslation) {
    chrome.tabs.sendMessage(tab.id, { type: 'CLEAR_INLINE_TRANSLATION_CONTEXT' });
  }
});

// Build prompt with variable substitution
// Appends MATH_PLACEHOLDER_RULE unless includeMathRule is false
function buildPrompt(template, targetLangName, variables = {}, extraRules = '', options = {}) {
  const includeMathRule = options.includeMathRule !== false;
  let prompt = template.replace(/\{targetLang\}/g, targetLangName);
  for (const [key, value] of Object.entries(variables)) {
    prompt = prompt.replaceAll(`{${key}}`, value);
  }
  if (extraRules) {
    const mathRule = includeMathRule ? MATH_PLACEHOLDER_RULE : '';
    return prompt + mathRule + '\n\n' + extraRules;
  }
  return includeMathRule ? prompt + MATH_PLACEHOLDER_RULE : prompt;
}

// Get effective target language (browser language if not set by user)
function getEffectiveTargetLang(settings) {
  if (settings.targetLangSetByUser && settings.targetLang) {
    return settings.targetLang;
  }
  return getBrowserLanguage();
}

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

// Handle single text translation
async function handleTranslate(text, targetLang, mode) {
  const settings = await chrome.storage.sync.get(defaultSettings);

  if (!settings.apiKey) {
    return { error: '请先在设置中配置 API Key' };
  }

  try {
    const effectiveLang = targetLang || getEffectiveTargetLang(settings);
    const result = await translateTextWithMode(text, effectiveLang, settings, mode === 'word');
    return result;
  } catch (error) {
    console.error('Translation error:', error);
    return { error: error.message || '翻译失败，请重试' };
  }
}

// Handle batch translation
async function handleBatchTranslate(texts, targetLang) {
  const settings = await chrome.storage.sync.get(defaultSettings);

  if (!settings.apiKey) {
    return { error: '请先在设置中配置 API Key' };
  }

  try {
    const effectiveLang = targetLang || getEffectiveTargetLang(settings);
    const translations = await translateBatchWithAI(texts, effectiveLang, settings);
    return { translations };
  } catch (error) {
    console.error('Batch translation error:', error);
    return { error: error.message || '翻译失败，请重试' };
  }
}

// Handle fast batch translation with delimiter
async function handleBatchTranslateFast(texts, targetLang, delimiter = '|||') {
  const settings = await chrome.storage.sync.get(defaultSettings);

  if (!settings.apiKey) {
    return { error: '请先在设置中配置 API Key' };
  }

  try {
    const effectiveLang = targetLang || getEffectiveTargetLang(settings);
    const translations = await translateBatchFastWithAI(texts, effectiveLang, settings, delimiter);
    return { translations };
  } catch (error) {
    console.error('Fast batch translation error:', error);
    return { error: error.message || '翻译失败，请重试' };
  }
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
  if (forceWord || isSingleWordText(text)) {
    const result = await translateSingleWordWithAI(text, targetLang, settings);
    return { ...result, isWord: true };
  }

  const translation = await translateWithAI(text, targetLang, settings);
  return { translation, phonetic: '', isWord: false };
}

// Translate batch of texts with AI (numbered format)
async function translateBatchWithAI(texts, targetLang, settings) {
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

// Fast batch prompt template
const FAST_BATCH_PROMPT = `You are a professional translator. Translate multiple text segments to {targetLang}.

CRITICAL RULES:
1. Input segments are separated by "{delimiter}"
2. Output translations MUST be separated by "{delimiter}" in the EXACT same order
3. Output ONLY the translations, nothing else
4. Keep technical terms, brand names, proper nouns in original form
5. If already in target language, return EXACTLY as is (no paraphrasing or reordering)
6. MUST have exactly the same number of output segments as input

Example:
Input: Hello{delimiter}How are you{delimiter}Thank you
Output: 你好{delimiter}你好吗{delimiter}谢谢`;

// Fast batch output rules appended when using custom prompts
function getFastBatchOutputRules(delimiter) {
  return `BATCH FORMAT RULES:
1. Input segments are separated by "${delimiter}"
2. Output translations MUST be separated by "${delimiter}" in the EXACT same order
3. Output ONLY the translations, nothing else
4. MUST have exactly the same number of output segments as input`;
}

// Fast batch translation with delimiter
async function translateBatchFastWithAI(texts, targetLang, settings, delimiter = '⟪⟫⟪⟫⟪⟫') {
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
  const translations = content.split(delimiter).map(t => t.trim());

  // Ensure we have the same number of translations as inputs
  while (translations.length < texts.length) {
    translations.push('');
  }

  return translations.slice(0, texts.length);
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
