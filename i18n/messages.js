// Blab Translation i18n Messages
// Supports multiple languages based on user's target language setting
//
// 这里只剩「怎么取一条文案」和「界面语言算哪一门」。十门语言的字符串表在
// i18n/lang/<tag>.js，一门一个文件，各自把自己那一格挂进下面这张注册表 —— 四千行
// 挤在一个文件里的时候，改一句日文和改一句俄文落在同一份 diff 上。
//
// 注册表是谁先到谁建：这个文件和那十个文件在任何一份装载清单里都没有先后之分，
// 读它发生在 getMessage() 被调用的时候，那时该装的早装完了。
const I18N_MESSAGES = (globalThis.I18N_MESSAGES = globalThis.I18N_MESSAGES || {});

// Get message by key and language
function getMessage(key, lang = 'en') {
  // Try exact match first
  if (I18N_MESSAGES[lang] && I18N_MESSAGES[lang][key]) {
    return I18N_MESSAGES[lang][key];
  }
  
  // Try language prefix (e.g., 'zh' for 'zh-CN')
  const langPrefix = lang.split('-')[0];
  if (I18N_MESSAGES[langPrefix] && I18N_MESSAGES[langPrefix][key]) {
    return I18N_MESSAGES[langPrefix][key];
  }
  
  // Fallback to English
  if (I18N_MESSAGES['en'] && I18N_MESSAGES['en'][key]) {
    return I18N_MESSAGES['en'][key];
  }
  
  // Return key if not found
  return key;
}

// The languages this file actually carries a full string table for.
const UI_LANGUAGES = ['en', 'zh-CN', 'zh-TW', 'ja', 'ko', 'fr', 'de', 'es', 'pt', 'ru'];

// Region-tagged tags the browser really reports, mapped onto the table above.
// Chinese is the one that cannot be resolved by stripping the region: zh-HK and
// zh-MO are traditional, zh-SG is simplified, so 'zh-HK'.split('-')[0] would
// hand a Hong Kong reader a simplified UI.
const UI_LANGUAGE_ALIASES = {
  'zh': 'zh-CN',
  'zh-cn': 'zh-CN',
  'zh-hans': 'zh-CN',
  'zh-sg': 'zh-CN',
  'zh-tw': 'zh-TW',
  'zh-hk': 'zh-TW',
  'zh-mo': 'zh-TW',
  'zh-hant': 'zh-TW',
};

function normalizeUILanguage(tag) {
  if (!tag) return '';
  const lower = String(tag).trim().toLowerCase();
  if (!lower) return '';
  if (UI_LANGUAGE_ALIASES[lower]) return UI_LANGUAGE_ALIASES[lower];
  const base = lower.split('-')[0];
  if (UI_LANGUAGE_ALIASES[base]) return UI_LANGUAGE_ALIASES[base];
  const match = UI_LANGUAGES.find(lang => lang.toLowerCase() === lower || lang.toLowerCase() === base);
  return match || '';
}

function browserUILanguage() {
  try {
    if (typeof chrome !== 'undefined' && chrome.i18n && chrome.i18n.getUILanguage) {
      return chrome.i18n.getUILanguage();
    }
  } catch (error) {
    // A torn-down extension context. Fall through to navigator/English.
  }
  return (typeof navigator !== 'undefined' && navigator.language) || '';
}

/**
 * Which language to draw the extension's own UI in.
 *
 * This used to be derived from the *target* language, so choosing to translate
 * into Japanese also turned the settings page Japanese — two unrelated choices
 * wired to one control, and no way to have an English UI while translating into
 * Japanese. The target language no longer has any say. `explicitUiLang` is the
 * user's `uiLanguage` setting; empty means "follow the browser", which is what
 * every other extension does and what a fresh install gets.
 */
function getUILanguage(explicitUiLang) {
  return normalizeUILanguage(explicitUiLang)
    || normalizeUILanguage(browserUILanguage())
    || 'en';
}

// Node 这一侧没有装载清单可倚 —— 单测 import 这个文件、e2e spec require 它，两种
// 写法在这个包里都落到 CommonJS，谁都不会顺带把十张表带进来。所以这里自己拉一遍。
// 浏览器里这一段不跑：service worker 按 ESM 装，页面按经典脚本装，两边都没有 require。
if (typeof module !== 'undefined' && module.exports && typeof require === 'function') {
  for (const lang of UI_LANGUAGES) require(`./lang/${lang}.js`);
}

// Export for use in other scripts
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { I18N_MESSAGES, UI_LANGUAGES, getMessage, getUILanguage };
}

if (typeof globalThis !== 'undefined') {
  globalThis.I18N_MESSAGES = I18N_MESSAGES;
  globalThis.getMessage = getMessage;
  globalThis.UI_LANGUAGES = UI_LANGUAGES;
  globalThis.getUILanguage = getUILanguage;
}
