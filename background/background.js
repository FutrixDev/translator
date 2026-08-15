// AI Translator Background Script
import '../shared/api-compat.js';
import '../shared/account-gate.js';
import '../shared/ocr.js';
import '../i18n/messages.js';
import * as comicClient from './comic-client.js';
import * as pdfClient from './pdf-client.js';

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
  if (namespace === 'sync' && changes.enableComicTranslation) {
    refreshComicMenuVisibility();
  }
  if (namespace === 'sync' && changes.enablePdfTranslation) {
    refreshPdfMenuVisibility();
  }
  if (namespace === 'sync' && changes.enableImageOcrTranslation) {
    refreshOcrMenuVisibility();
  }
  // Both entries are gated on the account as well as the switch, so signing in
  // or out has to re-run the same check. Without this a sign-out leaves menu
  // entries for two features this device can no longer run.
  if (namespace === 'local' && changes[AccountGate.TOKEN_KEY]) {
    refreshComicMenuVisibility();
    refreshPdfMenuVisibility();
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
  'pt': 'Português',
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
  // 'local' vs 'vision'; the default is 'local'. See shared/ocr.js.
  ocrEngine: globalThis.OCRCore.DEFAULT_OCR_ENGINE,
  // '' / 'auto' = English plus the user's own script. See resolveOcrLanguages:
  // Tesseract needs its languages up front, so this cannot be detected.
  ocrSourceLanguage: 'auto',
  // Step 2. Off means the popup shows the recognised text alone, which is a
  // complete result — plenty of right-clicks are "what does this say", not
  // "what does this mean". On is the default because the extension is a
  // translator, and with translationEngine 'builtin' it is also free.
  ocrTranslate: true,
  customPrompt: '',
  theme: 'light'
};

const MENU_IDS = {
  translateSelection: 'translate-selection',
  translatePage: 'translate-page',
  translateComicImage: 'translate-comic-image',
  ocrTranslateImage: 'ocr-translate-image',
  colorizeComicImage: 'colorize-comic-image',
  translatePdfLink: 'translate-pdf-link',
  translatePdfPage: 'translate-pdf-page',
  translatePdfAction: 'translate-pdf-action',
  translatePdfLocalAction: 'translate-pdf-local-action',
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
  chrome.contextMenus.update(MENU_IDS.translateComicImage, {
    title: getContextMenuTitle('contextTranslateComic', uiLang),
  });
  chrome.contextMenus.update(MENU_IDS.ocrTranslateImage, {
    title: getContextMenuTitle('contextOcrImage', uiLang),
  });
  chrome.contextMenus.update(MENU_IDS.colorizeComicImage, {
    title: getContextMenuTitle('contextColorizeComic', uiLang),
  });
  chrome.contextMenus.update(MENU_IDS.translatePdfLink, {
    title: getContextMenuTitle('contextTranslatePdfLink', uiLang),
  });
  chrome.contextMenus.update(MENU_IDS.translatePdfPage, {
    title: getContextMenuTitle('contextTranslatePdfPage', uiLang),
  });
  // The toolbar-icon entries deliberately read the same as the popup's two
  // buttons — they are the same two actions, reachable without opening it.
  chrome.contextMenus.update(MENU_IDS.translatePdfAction, {
    title: getContextMenuTitle('pdfTranslateThis', uiLang),
  });
  chrome.contextMenus.update(MENU_IDS.translatePdfLocalAction, {
    title: getContextMenuTitle('pdfTranslateLocal', uiLang),
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

    // Only on images. This is the paid, account-backed path — see comic-client.js
    // — so it is deliberately a separate entry from the text menus above rather
    // than another mode of "Translate Page". Created hidden and revealed only
    // when the feature is switched on: someone who never wants to pay should
    // not have a paid action sitting in the menu of every image they right-click.
    chrome.contextMenus.create({
      id: MENU_IDS.translateComicImage,
      title: 'Translate This Comic',
      contexts: ['image'],
      visible: false
    });

    // OCR is the free sibling of the comic entry: it reads the text out of any
    // image with the user's own vision-capable model. Gated only by its
    // settings switch (no account), hidden when switched off so the image menu
    // stays as small as the user asked for.
    chrome.contextMenus.create({
      id: MENU_IDS.ocrTranslateImage,
      title: 'Extract & Translate Image Text',
      contexts: ['image'],
      visible: false
    });

    // Colorization rides the same account-backed pipeline, gated by the same
    // setting — a second product on the same image, not a second feature flag.
    chrome.contextMenus.create({
      id: MENU_IDS.colorizeComicImage,
      title: 'Colorize This Comic',
      contexts: ['image'],
      visible: false
    });

    // The PDF entries are the same account-backed, paid pattern as the comic
    // ones: created hidden, revealed only when the feature is switched on.
    // targetUrlPatterns cannot express ".pdf before the query string", so the
    // click handler re-checks with isLikelyPdfUrl before spending anything.
    chrome.contextMenus.create({
      id: MENU_IDS.translatePdfLink,
      title: 'Translate Linked PDF',
      contexts: ['link'],
      targetUrlPatterns: [
        '*://*/*.pdf', '*://*/*.pdf?*', '*://*/*.pdf#*',
        '*://*/*.PDF', '*://*/*.PDF?*',
        '*://arxiv.org/pdf/*', '*://*.arxiv.org/pdf/*'
      ],
      visible: false
    });

    chrome.contextMenus.create({
      id: MENU_IDS.translatePdfPage,
      title: 'Translate This PDF',
      contexts: ['page'],
      documentUrlPatterns: [
        '*://*/*.pdf', '*://*/*.pdf?*', '*://*/*.pdf#*',
        '*://*/*.PDF', '*://*/*.PDF?*',
        '*://arxiv.org/pdf/*', '*://*.arxiv.org/pdf/*',
        'file:///*.pdf'
      ],
      visible: false
    });

    // Chrome's built-in PDF viewer renders the document inside its own
    // extension frame, and a third-party extension's contexts:['page'] entry
    // can never match there — which is why right-clicking an open PDF offers
    // nothing, and why translatePdfPage above only ever fires on pages that
    // merely *link* like a PDF. The toolbar icon's own menu is not subject to
    // that: it is the entry point that actually works while reading a PDF.
    chrome.contextMenus.create({
      id: MENU_IDS.translatePdfAction,
      title: 'Translate This PDF',
      contexts: ['action'],
      visible: false
    });

    chrome.contextMenus.create({
      id: MENU_IDS.translatePdfLocalAction,
      title: 'Translate a Local PDF…',
      contexts: ['action'],
      visible: false
    });

    chrome.contextMenus.create({
      id: MENU_IDS.removeInlineTranslation,
      title: 'Remove Translation',
      contexts: ['all'],
      visible: false
    });

    refreshContextMenuTitles();
    refreshComicMenuVisibility();
    refreshPdfMenuVisibility();
    refreshOcrMenuVisibility();
  });
}

/**
 * Settings with the account gate applied — the only shape the rest of this
 * worker should judge the two server-backed features from. See
 * shared/account-gate.js.
 */
async function getGatedSettings() {
  return AccountGate.applyAccountGate(await chrome.storage.sync.get(defaultSettings));
}

/**
 * Show or hide the comic entry. Called on every menu rebuild and whenever the
 * setting or the account changes, so the menu never outlives the preference —
 * or the sign-in — that justified it.
 *
 * Re-read rather than handed the new value: the answer depends on the switch
 * AND the token, so a changed switch is only half of it.
 */
async function refreshComicMenuVisibility() {
  const visible = (await getGatedSettings()).enableComicTranslation;
  chrome.contextMenus.update(MENU_IDS.translateComicImage, { visible: !!visible })
    // The menu is gone during a rebuild; the rebuild itself will re-apply this.
    .catch(() => {});
  chrome.contextMenus.update(MENU_IDS.colorizeComicImage, { visible: !!visible })
    .catch(() => {});
}

/**
 * Same rebuild-and-on-change contract as the comic/PDF entries, but judged on
 * the raw switch alone: OCR runs locally or on the user's own API key, not on
 * an account allowance, so the account gate has no say here.
 */
async function refreshOcrMenuVisibility() {
  const settings = await chrome.storage.sync.get(defaultSettings);
  chrome.contextMenus.update(MENU_IDS.ocrTranslateImage, {
    visible: !!settings.enableImageOcrTranslation
  }).catch(() => {});
}

/** Same contract as refreshComicMenuVisibility, for the PDF entries. */
async function refreshPdfMenuVisibility() {
  const visible = (await getGatedSettings()).enablePdfTranslation;
  chrome.contextMenus.update(MENU_IDS.translatePdfLink, { visible: !!visible })
    .catch(() => {});
  chrome.contextMenus.update(MENU_IDS.translatePdfPage, { visible: !!visible })
    .catch(() => {});
  chrome.contextMenus.update(MENU_IDS.translatePdfAction, { visible: !!visible })
    .catch(() => {});
  chrome.contextMenus.update(MENU_IDS.translatePdfLocalAction, { visible: !!visible })
    .catch(() => {});
}

/**
 * Refuse a job for a feature whose switch is off.
 *
 * Hiding entry points only governs what gets rendered next. A surface that was
 * already open when the switch went off keeps its buttons — an upload page, the
 * popup, a comic overlay sitting on a page — and can still send a create. This
 * is the one point both features funnel through, so it is the only place the
 * answer can be relied on; without it a switched-off feature can still upload a
 * document and spend the month's allowance.
 *
 * Reads the raw switch, NOT getGatedSettings(): the account half of the gate is
 * already enforced one layer down, where apiFetch answers a create with no
 * token as `unauthorized` — and every surface turns that into a sign-in offer.
 * Answering `feature_disabled` instead would name the wrong problem and leave
 * the user nothing to do about it.
 */
async function assertFeatureEnabled(key) {
  const settings = await chrome.storage.sync.get(defaultSettings);
  if (!settings[key]) {
    throw new comicClient.ComicApiError('feature_disabled', `${key} is turned off`);
  }
}

// Every provider/model shape decision lives in shared/api-compat.js so the
// options page's connection test exercises the identical request.
const {
  isClaudeAPI,
  openAIHeaders,
  claudeHeaders,
  buildOpenAIRequestBody,
  buildClaudeRequestBody,
  readAPIResponse
} = globalThis.APICompat;

// Issue one translation request and return its text, or throw with a
// user-facing message. Both vendors are handled the same way: some APIs report
// failures with HTTP 200 and an error payload, so the body is always parsed.
async function callTranslationAPI(endpoint, headers, body, isClaudeShape) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });

  const data = await response.json().catch(() => ({}));
  const result = readAPIResponse(data, response.status, response.ok, isClaudeShape);
  if (result.error) throw new Error(result.error);
  return result.text;
}

// Call Claude API with Anthropic-specific format
async function callClaudeAPI(endpoint, apiKey, model, systemPrompt, userContent, maxTokens = 4096) {
  return callTranslationAPI(
    endpoint,
    claudeHeaders(apiKey),
    buildClaudeRequestBody(model, userContent, maxTokens, systemPrompt),
    true
  );
}

// Call OpenAI-compatible API
async function callOpenAIAPI(endpoint, apiKey, model, systemPrompt, userContent, maxTokens = 4096, temperature = globalThis.APICompat.DEFAULT_TEMPERATURE) {
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent }
  ];
  return callTranslationAPI(
    endpoint,
    openAIHeaders(apiKey),
    buildOpenAIRequestBody(model, messages, maxTokens, temperature),
    false
  );
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

    case 'OCR_IMAGE':
      handleOcrImage(message, sender)
        .then(sendResponse)
        .catch(error => sendResponse({ error: error.message }));
      return true;

    // From the offscreen document, which cannot address a tab itself.
    case 'OCR_PROGRESS':
      relayOcrProgress(message);
      break;

    // The OCR engine has been idle long enough to be worth its memory no
    // longer. Closing the document also lets this service worker go to sleep —
    // an open offscreen document keeps it alive indefinitely.
    case 'OCR_OFFSCREEN_IDLE':
      chrome.offscreen.closeDocument().catch(() => {});
      break;

    case 'OPEN_OPTIONS':
      chrome.runtime.openOptionsPage();
      break;

    // --- Comic translation (account-backed, see comic-client.js) -------------
    case 'COMIC_ACCOUNT':
      replyComic(comicClient.getAccount({ force: message.force === true }), sendResponse);
      return true;

    case 'COMIC_SIGN_IN':
      replyComic(comicClient.signIn(), sendResponse);
      return true;

    case 'COMIC_SIGN_OUT':
      replyComic(comicClient.signOut().then(() => ({ signedIn: false })), sendResponse);
      return true;

    case 'COMIC_JOB_CREATE':
      replyComic(
        assertFeatureEnabled('enableComicTranslation')
          .then(() => comicClient.createJob(message.job || {})),
        sendResponse,
      );
      return true;

    case 'COMIC_JOB_POLL':
      replyComic(comicClient.getJob(message.jobId), sendResponse);
      return true;

    case 'COMIC_JOB_ABANDON':
      replyComic(comicClient.abandonJob(message.jobId), sendResponse);
      return true;

    // --- PDF translation (account-backed, see pdf-client.js) -----------------
    case 'PDF_CREATE_JOB':
      replyComic(handlePdfCreateJob(message), sendResponse);
      return true;

    case 'PDF_JOB_GET':
      replyComic(handlePdfJobGet(message.jobId), sendResponse);
      return true;

    case 'PDF_JOB_ABANDON':
      replyComic(handlePdfJobAbandon(message.jobId), sendResponse);
      return true;

    case 'PDF_JOBS_LIST':
      // refresh:false is the popup's cheap first paint from storage; the
      // 3-second cadence passes refresh:true to actually ask the server.
      replyComic(
        message.refresh === false ? pdfClient.listJobRecords() : refreshPdfJobs(),
        sendResponse
      );
      return true;

    case 'PDF_JOBS_HISTORY':
      replyComic(handlePdfJobsHistory(), sendResponse);
      return true;

    case 'PDF_JOB_DISMISS':
      replyComic(pdfClient.dismissJobRecord(message.jobId), sendResponse);
      return true;

    case 'PDF_OPEN_RESULT':
      replyComic(handlePdfOpenResult(message.jobId, message.which), sendResponse);
      return true;

    // Where the account lives on the web, so the settings page can link a job
    // to the library that renders it. Asked for rather than duplicated: the
    // origin has a default and a storage override in comic-client.js, and a
    // second copy in the options page would be the one that goes stale.
    // Deliberately not gated on being signed in — the link is worth showing to
    // someone who is not, because following it is how they sign in.
    case 'ACCOUNT_SITE_BASE':
      replyComic(comicClient.getApiBase().then(base => ({ base })), sendResponse);
      return true;
  }
});

/**
 * Settle a comic-client promise into a plain message.
 *
 * An Error does not survive chrome.runtime messaging, and the codes matter: the
 * page decides between "sign in", "out of free pages" and "this image cannot be
 * translated" purely from `error.code`.
 */
function replyComic(promise, sendResponse) {
  promise
    .then(data => sendResponse({ ok: true, data }))
    .catch(error => {
      if (error instanceof comicClient.ComicApiError) {
        sendResponse({ ok: false, ...error.toMessage() });
      } else {
        sendResponse({ ok: false, error: { code: 'internal_error', message: error?.message || String(error) } });
      }
    });
}

// Context menu for right-click translation
chrome.runtime.onInstalled.addListener(() => {
  createContextMenus();
  // Jobs survive a browser restart; the alarm that watches them must too.
  ensurePdfPollAlarm().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  createContextMenus();
  ensurePdfPollAlarm().catch(() => {});
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === MENU_IDS.translateSelection && info.selectionText) {
    // 翻译动作交给 content script，而不是像以前那样在这里译完把结果推过去。
    // 内置引擎的 Translator 接口是 [Exposed=Window, SecureContext]，service worker
    // 里根本不存在；只有 content script 能按当前引擎设置正确分流（内置 / 自定义接口）。
    // 这里只负责把“用户点了右键翻译”这件事转达过去。
    const settings = await chrome.storage.sync.get(defaultSettings);
    chrome.tabs.sendMessage(tab.id, {
      type: 'TRANSLATE_SELECTION_TEXT',
      text: info.selectionText,
      targetLang: getEffectiveTargetLang(settings)
    });
  } else if (info.menuItemId === MENU_IDS.translatePage) {
    chrome.tabs.sendMessage(tab.id, { type: 'TRANSLATE_PAGE' });
  } else if (info.menuItemId === MENU_IDS.translateComicImage ||
             info.menuItemId === MENU_IDS.colorizeComicImage) {
    const settings = await chrome.storage.sync.get(defaultSettings);
    // Hiding the menu is what normally prevents this, but a click can race a
    // switch-off, and this one costs money — so the setting is checked here too.
    if (!settings.enableComicTranslation) return;
    // The content script owns the whole job from here: it finds the <img>,
    // shows progress, and drives the poll loop. Polling from the page rather
    // than the worker is not a style choice — a service worker is torn down
    // after ~30s idle, and a page redraw routinely runs longer than that.
    chrome.tabs.sendMessage(tab.id, {
      type: 'COMIC_TRANSLATE_IMAGE',
      mode: info.menuItemId === MENU_IDS.colorizeComicImage ? 'colorize' : 'translate',
      srcUrl: info.srcUrl,
      pageUrl: info.pageUrl || (tab && tab.url) || '',
      targetLang: settings.comicTargetLang || getEffectiveTargetLang(settings)
    });
  } else if (info.menuItemId === MENU_IDS.ocrTranslateImage) {
    const settings = await chrome.storage.sync.get(defaultSettings);
    if (!settings.enableImageOcrTranslation) return;
    // The content script owns the UI (popup, progress, errors) and step 2, the
    // optional translation. It asks back via OCR_IMAGE for step 1, which must
    // run here: the page's CSP can block a content-script fetch, the API
    // endpoint is cross-origin to every page, and the local engine lives in an
    // offscreen document only this context can open.
    chrome.tabs.sendMessage(tab.id, {
      type: 'OCR_TRANSLATE_IMAGE',
      srcUrl: info.srcUrl,
      targetLang: getEffectiveTargetLang(settings),
      translate: settings.ocrTranslate !== false
    });
  } else if (info.menuItemId === MENU_IDS.translatePdfLocalAction) {
    chrome.tabs.create({ url: chrome.runtime.getURL('pdf/upload.html') });
  } else if (info.menuItemId === MENU_IDS.translatePdfLink ||
             info.menuItemId === MENU_IDS.translatePdfPage ||
             info.menuItemId === MENU_IDS.translatePdfAction) {
    const settings = await chrome.storage.sync.get(defaultSettings);
    // Same racing-click guard as the comic entries: this costs money.
    if (!settings.enablePdfTranslation) return;
    const url = info.menuItemId === MENU_IDS.translatePdfLink
      ? info.linkUrl
      : (info.pageUrl || (tab && tab.url) || '');
    if (!isLikelyPdfUrl(url)) {
      // The toolbar entry is always there, whatever the tab is showing, so it
      // is the one click that can legitimately land on a non-PDF — and it has
      // to say so rather than do nothing.
      if (info.menuItemId === MENU_IDS.translatePdfAction) notifyPdfNotAPdf();
      return;
    }
    // file:// can't be fetched from the worker — hand local PDFs to the
    // upload page's file picker instead (PR #26 review).
    if (url.startsWith('file:')) {
      chrome.tabs.create({ url: chrome.runtime.getURL('pdf/upload.html') });
      return;
    }
    // Unlike comics there is no content-script UI to hand off to — the Chrome
    // PDF viewer admits no content scripts — so the worker owns the job and
    // reports through notifications and the popup's task list.
    const fileName = pdfFileNameFromUrl(url);
    // Resolved here rather than inside the create so a second click on the same
    // PDF can be recognised as one: the id is per-URL and stable.
    const operationId = await pdfClient.getOrCreateUrlOperationId(url);
    const records = await pdfClient.listJobRecords();
    const running = records.find(r => r.operationId === operationId &&
      (r.status === 'queued' || r.status === 'running'));
    if (running) {
      notifyPdfRunning(running.fileName || fileName);
      return;
    }
    // Before the await, not after: the whole point is that the click stops
    // looking like it did nothing.
    notifyPdfStarted(fileName);
    try {
      const job = await handlePdfCreateJob({
        source: { kind: 'url', url },
        operationId,
        fileName,
        pageUrl: info.pageUrl || ''
      });
      // A create can resolve to a job that is already over — the idempotent
      // adopt of an earlier attempt that died. No poll transition will ever
      // fire for it, so without this the user saw "started" and then nothing.
      // (handlePdfCreateJob has already released the operation id, so the
      // "try again" in the failure copy is true.)
      if (job && (job.status === 'failed' || job.status === 'abandoned')) {
        notifyPdfError(job.error || { code: job.status });
      }
    } catch (error) {
      notifyPdfError(error);
    }
  } else if (info.menuItemId === MENU_IDS.removeInlineTranslation) {
    chrome.tabs.sendMessage(tab.id, { type: 'CLEAR_INLINE_TRANSLATION_CONTEXT' });
  }
});

// ---------------------------------------------------------------------------
// PDF translation jobs (account-backed, see pdf-client.js)
//
// A PDF job runs for minutes — far past the service worker's ~30s idle
// teardown — so nothing here holds a poll loop open. Instead: the popup and
// the upload page poll fast while they are open, and a 1-minute chrome.alarm
// covers the stretches when no UI is looking, firing a notification when a job
// crosses into a terminal state.
// ---------------------------------------------------------------------------

const PDF_POLL_ALARM = 'pdf-job-poll';

function isLikelyPdfUrl(url) {
  if (!url) return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!/^(https?|file):$/.test(parsed.protocol)) return false;
  if (/\.pdf$/i.test(parsed.pathname)) return true;
  // arXiv serves PDFs from extensionless /pdf/<id> paths.
  if (/(^|\.)arxiv\.org$/i.test(parsed.hostname) && /^\/pdf\//.test(parsed.pathname)) return true;
  return false;
}

function pdfFileNameFromUrl(url) {
  try {
    const parsed = new URL(url);
    const segment = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() || '');
    if (segment) return /\.pdf$/i.test(segment) ? segment : `${segment}.pdf`;
  } catch {
    // Fall through to the generic name.
  }
  return 'document.pdf';
}

/** Base64 → ArrayBuffer, chunk-free: atob handles the whole string at once. */
function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function ensurePdfPollAlarm() {
  if (await pdfClient.hasActiveJobs()) {
    // periodInMinutes only: no immediate fire, the caller just polled.
    chrome.alarms.create(PDF_POLL_ALARM, { periodInMinutes: 1 });
  } else {
    chrome.alarms.clear(PDF_POLL_ALARM);
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== PDF_POLL_ALARM) return;
  refreshPdfJobs().catch(error => console.error('PDF poll failed:', error));
});

/** Refresh every active record; notify for jobs that just finished. */
async function refreshPdfJobs() {
  const { records, transitions } = await pdfClient.refreshJobRecords();
  for (const record of transitions) {
    notifyPdfTerminal(record);
  }
  await ensurePdfPollAlarm();
  return records;
}

async function pdfNotificationLang() {
  const settings = await chrome.storage.sync.get(defaultSettings);
  return getContextMenuLanguage(settings);
}

function pdfMessage(key, uiLang) {
  if (typeof globalThis.getMessage === 'function') {
    return globalThis.getMessage(key, uiLang);
  }
  return key;
}

async function notifyPdfTerminal(record) {
  const uiLang = await pdfNotificationLang();
  const succeeded = record.status === 'succeeded';
  const titleKey = succeeded ? 'pdfNotifyDoneTitle' : 'pdfNotifyFailTitle';
  const body = succeeded
    ? pdfMessage('pdfNotifyDoneBody', uiLang)
    : pdfClient.pdfErrorMessage(record.error, key => pdfMessage(key, uiLang));
  const fileName = record.fileName ? `${record.fileName}\n` : '';
  chrome.notifications.create(`pdf-job-${record.jobId}`, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: pdfMessage(titleKey, uiLang),
    message: `${fileName}${body}`
  }, () => {
    if (chrome.runtime.lastError) {
      console.warn('PDF notification failed:', chrome.runtime.lastError.message);
    }
  });
}

/**
 * "It started." Only the context-menu entries need this — they have no UI of
 * their own, and without it a click on a menu item is indistinguishable from a
 * click that did nothing, which is exactly what makes people click again.
 */
async function notifyPdfStarted(fileName) {
  const uiLang = await pdfNotificationLang();
  chrome.notifications.create({
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: pdfMessage('pdfNotifyStartTitle', uiLang),
    message: `${fileName ? `${fileName}\n` : ''}${pdfMessage('pdfNotifyStartBody', uiLang)}`
  }, () => {
    if (chrome.runtime.lastError) {
      console.warn('PDF notification failed:', chrome.runtime.lastError.message);
    }
  });
}

/** The toolbar entry clicked while the tab is not showing a PDF. */
async function notifyPdfNotAPdf() {
  const uiLang = await pdfNotificationLang();
  chrome.notifications.create({
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: pdfMessage('pdfNotifyNotPdfTitle', uiLang),
    message: pdfMessage('pdfNotifyNotPdfBody', uiLang)
  }, () => {
    if (chrome.runtime.lastError) {
      console.warn('PDF notification failed:', chrome.runtime.lastError.message);
    }
  });
}

/** A repeat click on a PDF that is already in flight. */
async function notifyPdfRunning(fileName) {
  const uiLang = await pdfNotificationLang();
  chrome.notifications.create({
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: pdfMessage('pdfNotifyRunningTitle', uiLang),
    message: `${fileName ? `${fileName}\n` : ''}${pdfMessage('pdfNotifyStartBody', uiLang)}`
  }, () => {
    if (chrome.runtime.lastError) {
      console.warn('PDF notification failed:', chrome.runtime.lastError.message);
    }
  });
}

async function notifyPdfError(error) {
  const uiLang = await pdfNotificationLang();
  // Either the error itself or the {error: {...}} messaging envelope.
  const inner = error && error.error && error.error.code ? error.error : error;
  chrome.notifications.create({
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: pdfMessage('pdfNotifyFailTitle', uiLang),
    message: pdfClient.pdfErrorMessage(inner, key => pdfMessage(key, uiLang))
  }, () => {
    if (chrome.runtime.lastError) {
      console.warn('PDF notification failed:', chrome.runtime.lastError.message);
    }
  });
}

/**
 * The single entry point every PDF surface funnels into: popup button, context
 * menus, and the upload page all end up here.
 *
 * `source` is either `{kind: 'url', url}` — the worker fetches it, carrying
 * the user's cookies — or `{kind: 'bytes', bytesBase64}` from the upload page
 * (base64 because an ArrayBuffer does not survive runtime messaging).
 */
async function handlePdfCreateJob(message) {
  await assertFeatureEnabled('enablePdfTranslation');
  const settings = await chrome.storage.sync.get(defaultSettings);
  const source = message.source || {};

  const isBytes = source.kind === 'bytes' && !!source.bytesBase64;
  const isUrl = source.kind === 'url' && !!source.url;
  if (!isBytes && !isUrl) {
    throw new comicClient.ComicApiError('invalid_pdf', 'No PDF source was provided');
  }

  let operationId = message.operationId;
  if (!operationId && isUrl) {
    // Minted-and-persisted BEFORE the fetch: a retry after a lost response
    // must replay the same operationId or the server would charge the same
    // PDF twice (PR #26 review).
    operationId = await pdfClient.getOrCreateUrlOperationId(source.url);
  }
  if (!operationId) operationId = crypto.randomUUID();

  const fileName = message.fileName ||
    (isUrl ? pdfFileNameFromUrl(source.url) : 'document.pdf');

  // The click's receipt, written before any network work. Download + presign +
  // PUT + create is several seconds of silence, and every surface reads only
  // these records — without a row here the user sees nothing at all and clicks
  // again. It is also what carries a failure back to a popup that has since
  // closed: the awaited sendMessage promise dies with the popup, this does not.
  const pendingId = pdfClient.pendingJobId(operationId);
  await pdfClient.saveJobRecord({
    jobId: pendingId,
    operationId,
    fileName,
    status: 'queued',
    stage: 'uploading',
    progress: 0,
    results: null,
    error: null,
    pending: true,
    createdAt: Date.now()
  });

  let job;
  try {
    const bytes = isBytes
      ? base64ToArrayBuffer(source.bytesBase64)
      : await pdfClient.fetchPdfFromUrl(source.url);

    job = await pdfClient.createPdfJob({
      operationId,
      bytes,
      fileName,
      targetLang: message.targetLang || settings.pdfTargetLang || getEffectiveTargetLang(settings)
    });
  } catch (error) {
    const code = (error && error.code) || 'engine_error';
    // A 409 of this family means the cached operation id names work that
    // already settled — a failed-then-deleted job, a finalized billing row, or
    // a job with different settings (the target language changed). Replaying
    // it can never succeed, so drop the URL binding: the NEXT click mints a
    // fresh id and actually runs. Everything else (network, auth, quota)
    // keeps the binding — those retries must stay idempotent.
    if (code === 'operation_already_finished' || code === 'output_conflict' || code === 'job_conflict') {
      await pdfClient.releaseUrlOperationId(operationId);
    }
    await pdfClient.saveJobRecord({
      jobId: pendingId,
      status: 'failed',
      stage: null,
      error: {
        code,
        message: (error && error.message) || '',
        // too_many_pages carries the server's actual cap; keep it on the
        // record so the popup can render the honest number, not a stale one.
        ...(error && error.details && error.details.maxPages
          ? { maxPages: error.details.maxPages }
          : {})
      },
      settledAt: Date.now()
    });
    throw error;
  }

  // `error` too: a job can come back already terminal (a dispatch failure, or
  // an idempotent re-post of a finished operation), and it will never get an
  // alarm poll to fill that in later.
  await pdfClient.replaceJobRecord(pendingId, {
    jobId: job.jobId,
    operationId: job.operationId,
    fileName,
    status: job.status,
    progress: job.progress || 0,
    stage: job.stage || null,
    pageCount: job.pageCount,
    results: job.results || null,
    error: job.error || null,
    // Already over on arrival: no alarm poll will ever run for it, so this is
    // the only place its finish time can be stamped.
    ...(job.status === 'queued' || job.status === 'running' ? {} : { settledAt: Date.now() })
  });
  if (job.status === 'failed' || job.status === 'abandoned') {
    // Terminal on arrival: either the dispatch just failed, or the create
    // adopted a job that had already died. Both burn the operation id — the
    // server adopts by (user, operationId) regardless of status, so replaying
    // it would return this same dead job for the binding's whole 24h TTL.
    // Released here, the next click starts a genuinely new attempt.
    await pdfClient.releaseUrlOperationId(operationId);
  }
  await ensurePdfPollAlarm();
  return { ...job, fileName };
}

/**
 * The settings page's task list: the account's own history, from the server.
 *
 * Server-authoritative on purpose. The local records are a device's cache — 20
 * rows, a 24-hour TTL, gone with the profile — while "my translations" means
 * everything this account ever ran, from any device. The only rows added on top
 * are the ones the server cannot know about: a create still uploading from
 * here, or one that failed before it ever reached the server. Both carry a
 * synthetic `local:` id, which is exactly how they are recognised.
 *
 * Names are backfilled from the local record when the server has none, so jobs
 * created before the file_name column existed still read as something.
 */
async function handlePdfJobsHistory() {
  const records = await pdfClient.listJobRecords();

  let jobs;
  try {
    jobs = await pdfClient.listPdfJobs();
  } catch (error) {
    // A signed-out account has nothing to show and a sign-in to offer, so that
    // one propagates. Anything else — offline, service down — still has this
    // device's cache, which beats an empty page.
    if (error instanceof comicClient.ComicApiError && error.code === 'unauthorized') throw error;
    return { jobs: records, stale: true };
  }

  const byId = new Map(records.map(r => [r.jobId, r]));
  const merged = jobs.map(job => ({
    ...job,
    fileName: job.fileName || byId.get(job.jobId)?.fileName || ''
  }));
  const local = records.filter(r => pdfClient.isPendingInFlight(r));

  return {
    jobs: [...local, ...merged].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)),
    stale: false
  };
}

/** Poll one job and keep the local record in step with what came back. */
async function handlePdfJobGet(jobId) {
  const view = await pdfClient.getPdfJob(jobId);
  await pdfClient.saveJobRecord({
    jobId: view.jobId,
    status: view.status,
    progress: view.progress,
    stage: view.stage || null,
    pageCount: view.pageCount,
    results: view.results || null,
    error: view.error || null
  });
  await ensurePdfPollAlarm();
  return view;
}

async function handlePdfJobAbandon(jobId) {
  const view = await pdfClient.abandonPdfJob(jobId);
  await pdfClient.saveJobRecord({
    jobId: view.jobId,
    status: view.status,
    error: view.error || null
  });
  await ensurePdfPollAlarm();
  return view;
}

/**
 * Open a finished PDF in a new tab. Always via a fresh poll: the presigned
 * URL a record might hold is minutes old and probably expired.
 */
async function handlePdfOpenResult(jobId, which) {
  const view = await pdfClient.getPdfJob(jobId);
  // Refresh the local record only when there already is one. The settings page
  // lists the whole account, so this can be a job another device started, and
  // minting a record for it would push it to the top of this device's list as
  // if it had just run here.
  const records = await pdfClient.listJobRecords();
  if (records.some(r => r.jobId === view.jobId)) {
    await pdfClient.saveJobRecord({
      jobId: view.jobId,
      status: view.status,
      progress: view.progress,
      stage: view.stage || null,
      pageCount: view.pageCount,
      results: view.results || null,
      error: view.error || null
    });
    await ensurePdfPollAlarm();
  }
  const results = view.results || {};
  const url = which === 'mono'
    ? (results.monoUrl || results.dualUrl)
    : (results.dualUrl || results.monoUrl);
  if (!url) {
    throw new comicClient.ComicApiError('result_unavailable', 'The translated PDF is not available', 404);
  }
  await chrome.tabs.create({ url });
  return { opened: true };
}

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

// ---------------------------------------------------------------------------
// Image OCR, step 1: recognition. Two engines — Tesseract in the offscreen
// document (free, offline, the default) and the user's own vision model — and
// this half owns the parts neither a content script nor an offscreen document
// can do: fetching the image and reaching a cross-origin API.
//
// Step 2, the optional translation, is not here. It runs in the content script
// on the recognised text through the ordinary translation path.
//
// The pure parts — the language catalog, the script heuristic, the prompt,
// response parsing, encoding limits — live in shared/ocr.js.
// ---------------------------------------------------------------------------

/** ArrayBuffer → base64, chunked so a multi-megabyte image cannot blow the
 *  argument-count limit of String.fromCharCode.apply. */
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Fetch the image and get it into a shape both engines accept.
 *
 * Fetched from the worker, not the page: host_permissions cover <all_urls>, the
 * request carries the user's cookies (hotlink-guarded CDNs), and a page CSP
 * cannot block it. Bytes already in an accepted format under the size cap pass
 * through untouched; anything else (SVG, BMP, oversized) is decoded and
 * re-encoded via OffscreenCanvas, downscaled to OCR_MAX_DIMENSION.
 *
 * The limits are the vision APIs', and the local engine inherits them rather
 * than getting its own pass: Tesseract has no size cap of its own, but it is
 * also slow enough on a 6000px scan that the downscale is a favour.
 */
async function fetchImageForOcr(srcUrl, uiLang) {
  const { canSendImageDirectly, OCR_MAX_BYTES, OCR_MAX_DIMENSION } = globalThis.OCRCore;

  let response;
  try {
    response = await fetch(srcUrl);
  } catch {
    throw new Error(getMessage('ocrImageLoadFailed', uiLang));
  }
  if (!response.ok) {
    throw new Error(getMessage('ocrImageLoadFailed', uiLang));
  }
  const blob = await response.blob();

  if (canSendImageDirectly(blob.type, blob.size)) {
    return { base64: arrayBufferToBase64(await blob.arrayBuffer()), mediaType: blob.type };
  }

  let bitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    // SVG being the common case: workers cannot rasterize it.
    throw new Error(getMessage('ocrImageUnsupported', uiLang));
  }
  const scale = Math.min(1, OCR_MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  // PNG keeps text edges crisp; fall back to JPEG only when the PNG is still
  // over the cap (photographs, mostly — where JPEG is the right encoding).
  let out = await canvas.convertToBlob({ type: 'image/png' });
  if (out.size > OCR_MAX_BYTES) {
    out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
  }
  return { base64: arrayBufferToBase64(await out.arrayBuffer()), mediaType: out.type };
}

// --- The offscreen document ------------------------------------------------

// Tesseract spawns a Web Worker and instantiates WebAssembly; a service worker
// may do neither. The offscreen document is the only context in an extension
// that can, so the local engine lives there and this half just drives it.
const OFFSCREEN_PATH = 'offscreen/offscreen.html';
let offscreenCreating = null;

async function hasOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)]
  });
  return contexts.length > 0;
}

/**
 * There may be exactly one offscreen document per extension, and creating a
 * second throws. Two right-clicks in quick succession both land here before
 * either has finished creating, so the in-flight promise is shared.
 */
async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) return;
  if (offscreenCreating) {
    await offscreenCreating;
    return;
  }
  offscreenCreating = chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ['WORKERS'],
    justification: 'Run the local OCR engine, which needs a Web Worker and WebAssembly.'
  });
  try {
    await offscreenCreating;
  } catch (error) {
    // Lost the race against another caller that created it first — which is
    // the outcome we wanted anyway.
    if (!(await hasOffscreenDocument())) throw error;
  } finally {
    offscreenCreating = null;
  }
}

// Which tab asked for each in-flight recognition, so the offscreen document's
// progress can reach the popup that is waiting for it. The offscreen document
// has no idea a tab exists; it only knows the request id it was given.
const ocrProgressTabs = new Map();

function relayOcrProgress(message) {
  const tabId = ocrProgressTabs.get(message.requestId);
  if (tabId === undefined) return;
  chrome.tabs.sendMessage(tabId, {
    type: 'OCR_PROGRESS',
    requestId: message.requestId,
    stage: message.stage,
    progress: message.progress
  }).catch(() => {});
}

// --- Recognition -----------------------------------------------------------

/** Recognise with the local engine. Free, offline, no API key. */
async function recognizeLocally({ srcUrl, requestId, tabId }, settings, uiLang) {
  await ensureOffscreenDocument();
  const { base64, mediaType } = await fetchImageForOcr(srcUrl, uiLang);
  const languages = globalThis.OCRCore.resolveOcrLanguages(settings.ocrSourceLanguage, uiLang);

  if (tabId !== undefined) ocrProgressTabs.set(requestId, tabId);
  let result;
  try {
    result = await chrome.runtime.sendMessage({
      target: 'ocr-offscreen',
      type: 'OCR_OFFSCREEN_RECOGNIZE',
      requestId,
      languages,
      dataUrl: `data:${mediaType};base64,${base64}`
    });
  } finally {
    ocrProgressTabs.delete(requestId);
  }

  if (!result || result.error) {
    console.error('OCR: local engine failed:', result && result.error);
    throw new Error(getMessage('ocrEngineFailed', uiLang));
  }
  // Tesseract cannot report a language — it was told which ones to look for.
  // The answer comes from the codepoints that came out, with the language list
  // as the only thing that can tell Simplified from Traditional Han.
  return {
    text: result.text,
    language: globalThis.OCRCore.detectScriptLanguage(result.text, languages)
  };
}

/** Recognise with the user's own vision model. */
async function recognizeWithVision({ srcUrl }, settings, uiLang) {
  if (!settings.apiKey) {
    throw new Error(getMessage('configureApiKeyFirst', uiLang));
  }
  const { base64, mediaType } = await fetchImageForOcr(srcUrl, uiLang);
  const systemPrompt = globalThis.OCRCore.OCR_SYSTEM_PROMPT;
  const instruction = globalThis.OCRCore.OCR_USER_INSTRUCTION;

  let content;
  if (isClaudeAPI(settings.apiEndpoint)) {
    content = await callClaudeAPI(
      settings.apiEndpoint,
      settings.apiKey,
      settings.modelName,
      systemPrompt,
      globalThis.APICompat.buildClaudeVisionUserContent(instruction, mediaType, base64),
      4000
    );
  } else {
    content = await callOpenAIAPI(
      settings.apiEndpoint,
      settings.apiKey,
      settings.modelName,
      systemPrompt,
      globalThis.APICompat.buildOpenAIVisionUserContent(instruction, mediaType, base64),
      4000,
      globalThis.APICompat.DEFAULT_TEMPERATURE
    );
  }

  const parsed = globalThis.OCRCore.parseOcrResponse(content);
  // null means the reply was JSON that broke (token cap, mangled quoting);
  // an error beats presenting the raw blob as recognised text.
  if (!parsed) throw new Error(getMessage('translationFailed', uiLang));
  return {
    text: globalThis.OCRCore.normalizeRecognizedText(parsed.text),
    // The model's own answer when it gave one — it read the image, which beats
    // counting codepoints. Falling back keeps a model that skipped the key from
    // costing the popup its language line.
    language: parsed.language || globalThis.OCRCore.detectScriptLanguage(parsed.text, '')
  };
}

/**
 * Step 1 only: get the text out of the image. Returns {text, language} or
 * {error} — the same envelope shape the TRANSLATE handlers use.
 *
 * Translation is step 2 and does not happen here. The content script runs it
 * on the returned text through ctx.requestTranslation(), which already picks
 * between Chrome's built-in Translator and the user's API and already knows
 * how to explain itself when neither can serve the pair.
 */
async function handleOcrImage(message, sender) {
  const settings = await chrome.storage.sync.get(defaultSettings);
  const uiLang = getContextMenuLanguage(settings);
  const request = {
    srcUrl: message.srcUrl,
    requestId: message.requestId || `ocr-${Date.now()}`,
    tabId: sender && sender.tab ? sender.tab.id : undefined
  };

  try {
    return settings.ocrEngine === 'vision'
      ? await recognizeWithVision(request, settings, uiLang)
      : await recognizeLocally(request, settings, uiLang);
  } catch (error) {
    console.error('OCR error:', error);
    return { error: error.message || getMessage('translationFailed', uiLang) };
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
7. Preserve placeholders and inline tags EXACTLY: keep {{1}}-style placeholders unchanged, and keep paired tags like <a1>...</a1> or <strong2>...</strong2> with the same names and numbers, wrapping the translated text they originally wrapped. Never invent, drop, or renumber tags.

Example:
Input: Hello{delimiter}Read <a1>the docs</a1> first{delimiter}Thank you
Output: 你好{delimiter}请先阅读<a1>文档</a1>{delimiter}谢谢`;

// Fast batch output rules appended when using custom prompts
function getFastBatchOutputRules(delimiter) {
  return `BATCH FORMAT RULES:
1. Input segments are separated by "${delimiter}"
2. Output translations MUST be separated by "${delimiter}" in the EXACT same order
3. Output ONLY the translations, nothing else
4. MUST have exactly the same number of output segments as input
5. Preserve placeholders and inline tags EXACTLY: keep {{1}}-style placeholders unchanged, and keep paired tags like <a1>...</a1> with the same names and numbers, wrapping the translated text they originally wrapped. Never invent, drop, or renumber tags.`;
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
  const segments = content.split(delimiter).map(t => t.trim());

  // 段数必须与输入数量一致，否则按位置回填不可靠。模型偶尔会漏掉/多打一个分隔符
  // （或把相邻两段合并），此时若像以前那样 pad/truncate 到 texts.length，会把数量
  // 错误“抹平”，导致整批从出错点起往后错开一位——A 段挂上 B 段的译文。
  // 改为回退到编号法：[1][2]… 按编号精确对齐，对漏标记/乱序稳健，最坏是某段未译
  // 而非串位。仅在极少数不匹配时多发一次请求。
  if (segments.length !== texts.length) {
    console.warn(
      `AI Translator: fast-batch delimiter split produced ${segments.length} segments ` +
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
