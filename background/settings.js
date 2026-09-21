// Blab Translation background — settings and language resolution.
//
// 这是 background/options 那一套设置的默认值。内容脚本那一套是另一张表
// （shared/default-settings.js 的 CONTENT_DEFAULTS），两张表各自回答各自那一侧
// 「没设过的时候算什么」，不是同一份东西的两个副本。
//
// defaultSettings 在模块顶层就读 globalThis.OCRCore，getUILanguage 来自
// i18n/messages.js —— 两个都得先装好，所以在这里自己 import 一遍：ESM 会去重，
// 而这样一来这个模块从哪儿被装进来都成立，不必指望入口文件的 import 顺序。
import '../shared/ocr.js';
import '../i18n/messages.js';

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
  'pt': 'Português',
  'ru': 'Русский'
};

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
  // 'builtin' = 浏览器内置的 Translator API（端上 NMT，零网络、零费用），默认引擎。
  // 'ai'      = 用户自己的 OpenAI 兼容接口，需要用户显式选择并配好 Key。
  // 真正的内置调用发生在 content script（Translator 是 [Exposed=Window]，
  // service worker 里拿不到），这里只负责存这个开关。
  translationEngine: 'builtin',
  apiEndpoint: 'https://api.openai.com/v1/chat/completions',
  apiKey: '',
  modelName: 'gpt-4.1-mini',
  targetLang: '', // Empty means use browser language
  targetLangSetByUser: false,
  // The extension's own UI language. Empty means follow the browser. Kept
  // apart from targetLang on purpose — see getUILanguage in i18n/messages.js.
  uiLanguage: '',
  // Comic translation is the one feature that spends money on a server-side
  // account, so it is opted into. Empty comicTargetLang means "follow
  // targetLang" — the page a reader wants in Japanese is not always the
  // language they read articles in.
  enableComicTranslation: false,
  comicTargetLang: '',
  // On by default, unlike comics: a PDF is the case where the extension has no
  // fallback to offer — Chrome's built-in viewer renders in a closed shadow DOM
  // that content scripts cannot reach, so a reader who never finds this toggle
  // concludes the product simply does not do PDFs. Nothing is spent until an
  // explicit click, and the first 20 pages are free.
  // Empty pdfTargetLang follows targetLang.
  enablePdfTranslation: true,
  pdfTargetLang: '',
  // Image OCR needs no account, and on the default engine no API key either,
  // so unlike comics/PDF it defaults on. The context menu entry is the only
  // surface.
  enableImageOcrTranslation: true,
  // 'local' vs 'vision'; the default is 'local'. See shared/ocr.js. This is
  // the one OCR sub-setting: no language picker (recognition always runs the
  // resolveOcrLanguagePlan auto plan — nobody can pre-declare tomorrow's
  // images) and no auto-translate switch (the popup always stops at the
  // recognised text and offers a Translate button for step 2).
  ocrEngine: globalThis.OCRCore.DEFAULT_OCR_ENGINE,
  // The hover shortcut over large images — the same whole-image flow as the
  // context menu, one hover closer. On by default: it is the flow's front
  // door, and it only appears over images big enough to plausibly hold text.
  enableImageOcrHoverButton: true,
  customPrompt: '',
  theme: 'light'
};

// Get effective target language (browser language if not set by user)
function getEffectiveTargetLang(settings) {
  if (settings.targetLangSetByUser && settings.targetLang) {
    return settings.targetLang;
  }
  return getBrowserLanguage();
}

/**
 * 界面语言 —— 菜单标题、通知、OCR 的错误文案都读它。
 *
 * 和 targetLang（用户要**译成**哪门语言）是两回事：一个中文界面的用户把网页译
 * 成英文，菜单不该跟着变成英文。
 */
export function uiLanguageOf(settings) {
  if (typeof globalThis.getUILanguage === 'function') {
    return globalThis.getUILanguage(settings.uiLanguage);
  }
  return 'en';
}

export { languageNames, getBrowserLanguage, defaultSettings, getEffectiveTargetLang };
