// Default prompt template
const DEFAULT_PROMPT_KEY = 'promptStandard';

function isMacPlatform() {
  const platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
  return /mac/i.test(platform);
}

function getPlatformType() {
  const platform = ((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '').toLowerCase();
  if (platform.includes('mac')) return 'mac';
  if (platform.includes('win')) return 'windows';
  if (platform.includes('linux')) return 'linux';
  return 'other';
}

const DEFAULT_SELECTION_HOTKEY = isMacPlatform() ? 'Meta' : 'Control';

// Provider configurations
// Provider catalog and every model-capability rule live in shared/api-compat.js
// (loaded by options.html before this file). Adding a model generation is a
// one-file change there.
const {
  PROVIDERS,
  DEFAULT_TEMPERATURE,
  isClaudeAPI,
  openAIHeaders,
  claudeHeaders,
  buildOpenAIRequestBody,
  buildClaudeRequestBody,
  readAPIResponse
} = globalThis.APICompat;

// Current UI language
let currentUILang = 'en';

// i18n helper
function t(key) {
  return getMessage(key, currentUILang);
}

// Apply i18n to page
function applyI18n(lang) {
  currentUILang = getUILanguage(lang);
  
  // Update all elements with data-i18n attribute
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    const text = t(key);
    if (text && text !== key) {
      el.textContent = text;
    }
  });
  
  // Update title attributes
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    const key = el.getAttribute('data-i18n-title');
    const text = t(key);
    if (text && text !== key) {
      el.title = text;
    }
  });

  // Update alt attributes
  document.querySelectorAll('[data-i18n-alt]').forEach(el => {
    const key = el.getAttribute('data-i18n-alt');
    const text = t(key);
    if (text && text !== key) {
      el.setAttribute('alt', text);
    }
  });

  // Update hint text (allow inline markup)
  document.querySelectorAll('[data-i18n-hint]').forEach(el => {
    const key = el.getAttribute('data-i18n-hint');
    const text = t(key);
    if (text && text !== key) {
      el.innerHTML = text;
    }
  });

  // Update placeholders
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const key = el.getAttribute('data-i18n-placeholder');
    const text = t(key);
    if (text && text !== key) {
      el.setAttribute('placeholder', text);
    }
  });
  
  // Update document title
  document.title = `${t('appName')} - ${t('settings')}`;

  // Last, because it builds on the labels the pass above just filled in — and
  // because what "auto" resolves to depends on the language this very call set.
  syncOcrAutoLabel();

  // Show the real extension version from the manifest instead of a hard-coded
  // string, so the settings page never drifts from the released version.
  const versionEl = document.querySelector('[data-i18n="appNameVersion"]');
  if (versionEl) {
    try {
      const version = chrome.runtime.getManifest().version;
      versionEl.textContent = `${t('appName')} v${version}`;
    } catch (e) {
      // getManifest() may be unavailable in some contexts; keep the i18n fallback.
    }
  }
}

function applyPlatformHotkeyLabels() {
  const platformType = getPlatformType();
  if (platformType === 'other') return;

  const selects = [elements.selectionTranslationHotkey, elements.hoverTranslationHotkey].filter(Boolean);
  const labelMapByPlatform = {
    mac: {
      Shift: '⇧ Shift',
      Alt: '⌥ Option',
      Control: '⌃ Control',
      Meta: '⌘ Command',
    },
    windows: {
      Meta: '⊞ Win',
    },
    linux: {
      Meta: 'Super',
    },
  };

  const labelMap = labelMapByPlatform[platformType] || null;
  if (!labelMap) return;

  selects.forEach((select) => {
    Array.from(select.options).forEach((option) => {
      const mapped = labelMap[option.value];
      if (mapped) option.textContent = mapped;
    });
  });
}

// DOM Elements
const elements = {
  translationEngine: document.getElementById('translationEngine'),
  builtinStatusGroup: document.getElementById('builtinStatusGroup'),
  builtinStatus: document.getElementById('builtinStatus'),
  downloadLanguagePack: document.getElementById('downloadLanguagePack'),
  provider: document.getElementById('provider'),
  apiEndpoint: document.getElementById('apiEndpoint'),
  customEndpointGroup: document.getElementById('customEndpointGroup'),
  apiKey: document.getElementById('apiKey'),
  modelSelect: document.getElementById('modelSelect'),
  modelName: document.getElementById('modelName'),
  targetLang: document.getElementById('targetLang'),
  enableSelection: document.getElementById('enableSelection'),
  selectionTranslationMode: document.getElementById('selectionTranslationMode'),
  selectionTranslationHotkey: document.getElementById('selectionTranslationHotkey'),
  enableHoverTranslation: document.getElementById('enableHoverTranslation'),
  hoverTranslationHotkey: document.getElementById('hoverTranslationHotkey'),
  showFloatBall: document.getElementById('showFloatBall'),
  autoDetect: document.getElementById('autoDetect'),
  showTranslationOnly: document.getElementById('showTranslationOnly'),
  enableImageOcrTranslation: document.getElementById('enableImageOcrTranslation'),
  ocrEngine: document.getElementById('ocrEngine'),
  ocrSourceLanguage: document.getElementById('ocrSourceLanguage'),
  ocrSourceLanguageGroup: document.getElementById('ocrSourceLanguageGroup'),
  ocrTranslate: document.getElementById('ocrTranslate'),
  ocrSubOptions: document.getElementById('ocrSubOptions'),
  enableYoutubeCaptionTranslation: document.getElementById('enableYoutubeCaptionTranslation'),
  showYoutubeOriginalCaption: document.getElementById('showYoutubeOriginalCaption'),
  youtubeCaptionFontColor: document.getElementById('youtubeCaptionFontColor'),
  youtubeCaptionBgColor: document.getElementById('youtubeCaptionBgColor'),
  youtubeCaptionBgOpacity: document.getElementById('youtubeCaptionBgOpacity'),
  youtubeCaptionBgOpacityValue: document.getElementById('youtubeCaptionBgOpacityValue'),
  youtubeCaptionPreview: document.getElementById('youtubeCaptionPreview'),
  youtubeSubOptions: document.getElementById('youtubeSubOptions'),
  customPrompt: document.getElementById('customPrompt'),
  testConnection: document.getElementById('testConnection'),
  resetPrompt: document.getElementById('resetPrompt'),
  toggleApiKey: document.getElementById('toggleApiKey'),
  themeToggle: document.getElementById('themeToggle'),
  statusMessage: document.getElementById('statusMessage'),
  eyeIcon: document.getElementById('eyeIcon'),
  // Account shared by comic and PDF translation
  comicAccountLoading: document.getElementById('comicAccountLoading'),
  comicSignedOut: document.getElementById('comicSignedOut'),
  comicSignedIn: document.getElementById('comicSignedIn'),
  comicEmail: document.getElementById('comicEmail'),
  comicPagesRemaining: document.getElementById('comicPagesRemaining'),
  pdfPagesRemaining: document.getElementById('pdfPagesRemaining'),
  freeQuotaReset: document.getElementById('freeQuotaReset'),
  comicSignIn: document.getElementById('comicSignIn'),
  comicSignOut: document.getElementById('comicSignOut'),
  // Comic translation
  enableComicTranslation: document.getElementById('enableComicTranslation'),
  comicTargetLang: document.getElementById('comicTargetLang'),
  // PDF translation
  enablePdfTranslation: document.getElementById('enablePdfTranslation'),
  pdfTargetLang: document.getElementById('pdfTargetLang'),
  // PDF tasks (server-backed history)
  pdfTasksCard: document.getElementById('pdfTasksCard'),
  pdfTasksLibraryLink: document.getElementById('pdfTasksLibraryLink'),
  pdfTasksRefresh: document.getElementById('pdfTasksRefresh'),
  pdfTasksState: document.getElementById('pdfTasksState'),
  pdfTasksActiveGroup: document.getElementById('pdfTasksActiveGroup'),
  pdfTasksActiveList: document.getElementById('pdfTasksActiveList'),
  pdfTasksHistoryGroup: document.getElementById('pdfTasksHistoryGroup'),
  pdfTasksHistoryList: document.getElementById('pdfTasksHistoryList')
};

// Preset prompt templates
const PROMPT_PRESETS = {
  standard: 'promptStandard',
  literal: 'promptLiteral',
  creative: 'promptCreative'
};

// Get browser language and map to supported language
function getBrowserLanguage() {
  const browserLang = navigator.language || navigator.userLanguage || 'en';
  const supportedLangs = ['zh-CN', 'zh-TW', 'en', 'ja', 'ko', 'fr', 'de', 'es', 'pt', 'ru'];

  // Exact match
  if (supportedLangs.includes(browserLang)) {
    return browserLang;
  }

  // Map common variants
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

  // Try prefix match
  const prefix = browserLang.split('-')[0];
  const prefixMatch = supportedLangs.find(lang => lang.startsWith(prefix));
  if (prefixMatch) {
    return prefixMatch;
  }

  // Default to English
  return 'en';
}

// Default settings
const defaultSettings = {
  // 默认走浏览器内置翻译（端上 NMT，零网络零费用）。下面那一整套 API 配置
  // 只在用户显式切到 'ai' 时才用得上，或者在内置引擎顶不住时充当回落。
  translationEngine: 'builtin',
  provider: 'openai',
  apiEndpoint: 'https://api.openai.com/v1/chat/completions',
  apiKey: '',
  modelName: 'gpt-4.1-mini',
  targetLang: '', // Empty means use browser language
  targetLangSetByUser: false, // Track if user ever set the language
  enableSelection: true,
  enableHoverTranslation: true,
  selectionTranslationMode: 'inline',
  selectionTranslationHotkey: DEFAULT_SELECTION_HOTKEY,
  hoverTranslationHotkey: 'Shift',
  showFloatBall: true,
  autoDetect: true,
  // 整页翻译“仅显示译文”，默认关：默认行为保持双语对照
  showTranslationOnly: false,
  // Image OCR: on the default engine it is free and local, so on by default.
  // See the notes on defaultSettings in background/background.js.
  enableImageOcrTranslation: true,
  ocrEngine: OCRCore.DEFAULT_OCR_ENGINE,
  ocrSourceLanguage: 'auto',
  ocrTranslate: true,
  // Off by default: this is the one feature that spends money, so it is opted
  // into rather than out of. Empty comicTargetLang follows targetLang above.
  enableComicTranslation: false,
  comicTargetLang: '',
  // On by default — see the note on defaultSettings in background/background.js.
  // Empty pdfTargetLang follows targetLang.
  enablePdfTranslation: true,
  pdfTargetLang: '',
  enableYoutubeCaptionTranslation: false,
  showYoutubeOriginalCaption: true,
  youtubeCaptionFontColor: '#ffffff',
  youtubeCaptionBgColor: '#080808',
  youtubeCaptionBgOpacity: 82,
  customPrompt: '',
  theme: 'light'
};

// Update model dropdown based on provider
function updateModelDropdown(providerKey, currentModel = '') {
  const provider = PROVIDERS[providerKey];
  const select = elements.modelSelect;

  // Clear existing options
  select.innerHTML = '';

  if (provider && provider.models.length > 0) {
    // Add default empty option
    const defaultOption = document.createElement('option');
    defaultOption.value = '';
    defaultOption.dataset.i18n = 'selectModelPlaceholder';
    defaultOption.textContent = t('selectModelPlaceholder');
    select.appendChild(defaultOption);

    // Add model options
    provider.models.forEach(model => {
      const option = document.createElement('option');
      option.value = model;
      option.textContent = model;
      select.appendChild(option);
    });

    // Set current model if it exists in the list
    if (currentModel && provider.models.includes(currentModel)) {
      select.value = currentModel;
      elements.modelName.value = '';
    } else if (currentModel) {
      // Model not in list, put it in custom input
      select.value = '';
      elements.modelName.value = currentModel;
    } else {
      // Use default model
      select.value = provider.defaultModel || '';
      elements.modelName.value = '';
    }
  } else {
    // No predefined models, use custom input only
    const defaultOption = document.createElement('option');
    defaultOption.value = '';
    defaultOption.dataset.i18n = 'enterModelPlaceholder';
    defaultOption.textContent = t('enterModelPlaceholder');
    select.appendChild(defaultOption);
    elements.modelName.value = currentModel;
  }
}

// Handle provider change
function onProviderChange() {
  const providerKey = elements.provider.value;
  const provider = PROVIDERS[providerKey];

  // Show/hide custom endpoint input
  if (providerKey === 'custom') {
    elements.customEndpointGroup.style.display = 'block';
  } else {
    elements.customEndpointGroup.style.display = 'none';
    // Auto-fill endpoint for known providers
    if (provider) {
      elements.apiEndpoint.value = provider.endpoint;
    }
  }

  // Update model dropdown
  updateModelDropdown(providerKey);
}

// ---------------------------------------------------------------------------
// Model: one setting, two controls
//
// The dropdown and the free-text box both write `modelName`, and the text box
// wins (getEffectiveModelName). So whenever one of them takes over, the other
// has to visibly let go — otherwise the page asserts two different models at
// once and the user has no way to tell which one is really being sent.
//
// Only the dropdown side of that was implemented. Picking "claude-opus-5" and
// then typing a model of your own stored the typed name correctly, but the
// dropdown went on displaying claude-opus-5 — so the typed name looked ignored.
// ---------------------------------------------------------------------------

// Handle model select change
function onModelSelectChange() {
  const selectedModel = elements.modelSelect.value;
  if (selectedModel) {
    // Clear custom input when selecting from dropdown
    elements.modelName.value = '';
  }
}

// The mirror image: typing overrides the list, so the list drops back to its
// placeholder. Emptying the box hands control back and leaves the dropdown to
// be chosen again — deliberately not restoring the old pick, which would
// resurrect a model the user had already replaced.
function onCustomModelInput() {
  if (elements.modelName.value.trim() && elements.modelSelect.value) {
    elements.modelSelect.value = '';
  }
}

// Get effective model name (from dropdown or custom input)
function getEffectiveModelName() {
  const selectValue = elements.modelSelect.value;
  const customValue = elements.modelName.value.trim();
  return customValue || selectValue;
}

// Detect provider from endpoint URL
function detectProviderFromEndpoint(endpoint) {
  if (!endpoint) return 'custom';

  for (const [key, provider] of Object.entries(PROVIDERS)) {
    if (key !== 'custom' && provider.endpoint && endpoint === provider.endpoint) {
      return key;
    }
  }

  // Check for partial matches
  if (endpoint.includes('openai.com')) return 'openai';
  if (endpoint.includes('anthropic.com')) return 'anthropic';
  if (endpoint.includes('generativelanguage.googleapis.com')) return 'gemini';
  if (endpoint.includes('deepseek.com')) return 'deepseek';
  if (endpoint.includes('openrouter.ai')) return 'openrouter';
  if (endpoint.includes('localhost:11434')) return 'ollama';
  if (endpoint.includes('localhost:1234')) return 'lmstudio';

  return 'custom';
}

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();
  setupEventListeners();
  // Awaited, unlike the account below: this one only reads chrome.storage in
  // the worker, and every task row rendered before it lands would be a row
  // without its link to the web library.
  await loadAccountSiteBase();
  // Not awaited: this is a network round-trip and the rest of the page must not
  // wait on the comic service being reachable. Kept as a handle instead, so the
  // one thing that genuinely needs the answer — the sign-in gate — can wait for
  // it rather than read a `comicSignedIn` that is only false because the
  // request has not landed yet.
  comicAccountReady = refreshComicAccount().catch(() => {});
});

// ---------------------------------------------------------------------------
// Account
//
// Separate from every other setting on this page: it is a server-side account,
// not something stored in chrome.storage.sync, so it loads over the network and
// its buttons act immediately instead of on Save. Comic and PDF translation
// share it — one sign-in, one monthly free allowance per feature.
// ---------------------------------------------------------------------------

function showComicState(name) {
  elements.comicAccountLoading.classList.toggle('hidden', name !== 'loading');
  elements.comicSignedOut.classList.toggle('hidden', name !== 'signedOut');
  elements.comicSignedIn.classList.toggle('hidden', name !== 'signedIn');
}

/**
 * Whether this device has an account: true, false, or null while the answer is
 * outstanding or the service could not be reached.
 *
 * Three states rather than two because the two feature switches render from it.
 * Collapsing "not answered yet" into "signed out" would flash both switches off
 * on every load for the signed-in majority; collapsing it into "signed in"
 * would show a signed-out user a switch that is about to retract. Unknown
 * renders the stored preference and corrects itself, which for a signed-out
 * device is a message round-trip — getAccount() answers `{signedIn: false}` off
 * the local token without touching the network.
 */
let comicSignedIn = null;

/** The initial account fetch, so the sign-in gate can wait on it instead of
 *  reading a `comicSignedIn` that has not been answered yet. Never rejects. */
let comicAccountReady = Promise.resolve();

/** Bumped by sign-in and sign-out, which decide this device's state outright.
 *  A read that was already on the wire when one of them happened is answering
 *  a question about the account that was; it is dropped rather than allowed to
 *  paint a signed-in panel over a sign-out the user just asked for. */
let comicAccountGeneration = 0;

/** The sign-in flow currently running, shared by both switches' gates. */
let comicSignInInFlight = null;

/**
 * The stored preference behind each account-backed switch, kept apart from what
 * the checkbox shows.
 *
 * These two are the only settings on the page whose displayed state is not
 * simply what storage says: both features run on our servers against a monthly
 * allowance, so a device with no account cannot have them on however the
 * preference arrived — and it arrives on every new install, because the
 * switches sync and the token does not.
 *
 * The preference itself is left alone rather than corrected. Writing false from
 * a signed-out device would sync back and turn the feature off on the device
 * that is still signed in, which is not what "sign out here" asked for. See
 * shared/account-gate.js, which derives the same answer for every other
 * surface.
 */
let storedComicEnabled = false;
let storedPdfEnabled = false;

/**
 * Draw the two switches from preference AND account.
 *
 * Called on load and on every account transition, so the switches can never sit
 * on for a feature this device cannot run. `comicSignedIn === null` means the
 * answer is still outstanding — see the declaration.
 */
function renderAccountFeatures() {
  const comicOn = storedComicEnabled && comicSignedIn !== false;
  const pdfOn = storedPdfEnabled && comicSignedIn !== false;
  elements.enableComicTranslation.checked = comicOn;
  elements.comicTargetLang.disabled = !comicOn;
  elements.enablePdfTranslation.checked = pdfOn;
  elements.pdfTargetLang.disabled = !pdfOn;
  syncPdfTasksVisibility(pdfOn);
}

/** Pages left this month for one operation. Older servers report only the comic
 *  allowance, at the top level and under its pre-PDF name. */
function freePagesLeft(account, operation) {
  const quota = account.freeQuotas?.[operation] ?? (operation === 'comic_page' ? account.freeQuota : null);
  return quota?.remaining ?? 0;
}

function formatResetDate(account) {
  const iso = account.freeQuotas?.comic_page?.resetsAt ?? account.freeQuota?.resetsAt;
  if (!iso) return '—';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '—';
  return at.toLocaleDateString(currentUILang, { month: 'short', day: 'numeric' });
}

// ---------------------------------------------------------------------------
// PDF tasks
//
// The account's own translation jobs, read from the server. Deliberately not
// the extension's local records: those are a device cache (20 rows, 24-hour
// TTL, gone with the browser profile) while this list answers "what have I
// translated", which spans devices and reinstalls. The service worker merges in
// the one thing the server cannot know yet — an upload still in flight from
// this device — and hands back the combined list.
//
// Polled only while something is running, and only while this page is visible.
// ---------------------------------------------------------------------------

const PDF_TASKS_POLL_MS = 5000;
const PDF_UI = globalThis.AI_TRANSLATOR_PDF_UI;
const PDF_TASK_LANG_KEYS = {
  'zh-CN': 'langZhCN', 'zh-TW': 'langZhTW', en: 'langEn', ja: 'langJa', ko: 'langKo',
  fr: 'langFr', de: 'langDe', es: 'langEs', pt: 'langPt', ru: 'langRu'
};
let pdfTasksTimer = null;
/** What the last fetch was made for. renderAccountFeatures runs on every load
 *  and every account change; only a change in either half is worth a request. */
let pdfTasksFetchedFor = null;
/**
 * Where the account lives on the web. Empty until the service worker answers,
 * which is why every link built from it is conditional: a row that renders
 * before the reply simply has no link, and the next render has one.
 */
let accountSiteBase = '';

/**
 * Ask once per page load. The origin is a constant with a storage override, so
 * it does not change under an open settings page, and re-asking on every
 * refresh would be a message per five-second poll for a value that never moves.
 */
async function loadAccountSiteBase() {
  let response;
  try {
    response = await chrome.runtime.sendMessage({ type: 'ACCOUNT_SITE_BASE' });
  } catch (error) {
    response = null;
  }
  accountSiteBase = (response && response.ok && response.data && response.data.base) || '';

  const link = elements.pdfTasksLibraryLink;
  if (!link) return;
  const href = PDF_UI.pdfLibraryUrl(accountSiteBase);
  link.href = href;
  link.hidden = !href;
}

/** Driven by renderAccountFeatures: the list follows the switch it belongs to. */
function syncPdfTasksVisibility(visible) {
  if (!elements.pdfTasksCard) return;
  elements.pdfTasksCard.hidden = !visible;
  const key = `${visible}:${comicSignedIn}`;
  if (key === pdfTasksFetchedFor) return;
  pdfTasksFetchedFor = key;
  stopPdfTasksPoll();
  // Signing in is the case this exists for: the first render can run before the
  // account has answered, and the list it drew then was a sign-in prompt.
  if (visible) refreshPdfTasks();
}

function stopPdfTasksPoll() {
  if (pdfTasksTimer) clearTimeout(pdfTasksTimer);
  pdfTasksTimer = null;
}

function schedulePdfTasksPoll(hasActive) {
  stopPdfTasksPoll();
  if (!hasActive || elements.pdfTasksCard.hidden || document.hidden) return;
  pdfTasksTimer = setTimeout(() => refreshPdfTasks({ quiet: true }), PDF_TASKS_POLL_MS);
}

async function refreshPdfTasks({ quiet = false } = {}) {
  if (!quiet) setPdfTasksMessage(t('pdfTasksLoading'));
  let response;
  try {
    response = await chrome.runtime.sendMessage({ type: 'PDF_JOBS_HISTORY' });
  } catch (error) {
    response = null;
  }

  if (!response || !response.ok) {
    // Signed out is not an error to report — it is a sign-in to offer.
    if (response && response.error && response.error.code === 'unauthorized') {
      renderPdfTasksSignedOut();
      return;
    }
    if (quiet) {
      // Leave whatever is on screen; a later poll retries.
      schedulePdfTasksPoll(true);
      return;
    }
    showPdfTaskGroups([], []);
    setPdfTasksMessage(t('pdfTasksError'));
    return;
  }

  const jobs = (response.data && response.data.jobs) || [];
  const active = jobs.filter(job => PDF_UI.isPdfJobActive(job));
  showPdfTaskGroups(active, jobs.filter(job => !PDF_UI.isPdfJobActive(job)));

  if (!jobs.length) setPdfTasksMessage(t('pdfTasksEmpty'));
  else if (response.data && response.data.stale) setPdfTasksMessage(t('pdfTasksOffline'));
  else setPdfTasksMessage('');

  schedulePdfTasksPoll(active.length > 0);
}

function setPdfTasksMessage(text, extraNode = null) {
  const box = elements.pdfTasksState;
  box.textContent = text || '';
  if (extraNode) box.appendChild(extraNode);
  box.hidden = !box.childNodes.length;
}

function renderPdfTasksSignedOut() {
  stopPdfTasksPoll();
  showPdfTaskGroups([], []);
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn btn-text';
  button.textContent = t('comicSignIn');
  button.addEventListener('click', async () => {
    // Same shared flow the switches use, so two sign-ins never race.
    if (await comicSignIn()) refreshPdfTasks();
  });
  setPdfTasksMessage(t('pdfTasksSignedOut'), button);
}

function showPdfTaskGroups(active, history) {
  renderPdfTaskList(elements.pdfTasksActiveList, active);
  renderPdfTaskList(elements.pdfTasksHistoryList, history);
  elements.pdfTasksActiveGroup.classList.toggle('hidden', !active.length);
  elements.pdfTasksHistoryGroup.classList.toggle('hidden', !history.length);
}

function renderPdfTaskList(list, jobs) {
  list.textContent = '';
  jobs.forEach(job => list.appendChild(pdfTaskRow(job)));
}

function pdfTaskRow(job) {
  const row = document.createElement('div');
  row.className = 'pdf-task';

  const name = document.createElement('div');
  name.className = 'pdf-task-name';
  name.textContent = job.fileName || t('pdfTasksUnnamed');
  name.title = name.textContent;

  const meta = document.createElement('div');
  meta.className = 'pdf-task-meta';
  meta.textContent = pdfTaskMeta(job);

  const main = document.createElement('div');
  main.className = 'pdf-task-main';
  main.appendChild(name);
  main.appendChild(meta);
  row.appendChild(main);

  if (PDF_UI.isPdfJobActive(job)) {
    const track = document.createElement('div');
    track.className = 'pdf-task-track';
    const bar = document.createElement('div');
    bar.className = 'pdf-task-bar';
    bar.style.width = `${Math.max(2, Math.min(100, Math.round(job.progress || 0)))}%`;
    track.appendChild(bar);
    main.appendChild(track);
  }

  const actions = document.createElement('div');
  actions.className = 'pdf-task-actions';

  // The web library, opened on this job. Offered for every row the server
  // knows about, not only the finished ones: the library renders the original
  // too, so it answers "what was this?" for a job that failed and "how far has
  // it got?" for one still running. `pdfLibraryUrl` returns '' for a pending
  // record, whose id names no server job yet.
  const libraryUrl = PDF_UI.pdfLibraryUrl(accountSiteBase, job.jobId);
  if (libraryUrl) {
    const view = document.createElement('a');
    view.className = 'pdf-task-view';
    view.href = libraryUrl;
    view.target = '_blank';
    view.rel = 'noopener';
    view.textContent = t('pdfTasksViewOnWeb');
    actions.appendChild(view);
  }

  if (!PDF_UI.isPdfJobActive(job) && job.status === 'succeeded' && !job.pending) {
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'btn btn-text pdf-task-open';
    open.textContent = t('pdfOpen');
    // Never the URL the list came with: presigned links expire in minutes and
    // this page can sit open for hours, so the worker re-signs at click time.
    open.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'PDF_OPEN_RESULT', jobId: job.jobId, which: 'dual' });
    });
    actions.appendChild(open);
  }

  if (actions.childNodes.length) row.appendChild(actions);

  return row;
}

/** "12 pages · Chinese · Done · Aug 6, 14:20" — whichever of those are known. */
function pdfTaskMeta(job) {
  const parts = [];
  if (job.pageCount) parts.push(t('pdfTasksPages').replace('{count}', job.pageCount));
  const langKey = PDF_TASK_LANG_KEYS[job.targetLang];
  if (langKey) parts.push(t(langKey));
  parts.push(job.status === 'failed' && job.error
    ? PDF_UI.pdfErrorMessage(job.error, t)
    : t(PDF_UI.pdfStatusKey(job)));
  if (job.createdAt) {
    const at = new Date(job.createdAt);
    if (!Number.isNaN(at.getTime())) {
      parts.push(at.toLocaleString(currentUILang, {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
      }));
    }
  }
  return parts.join(' · ');
}

/**
 * `quiet` is for refreshes the user did not ask for (see the visibilitychange
 * handler in setupEventListeners): no loading flash on the way in, and a
 * failure leaves the numbers that are already on screen rather than replacing
 * a readable panel with an error the user never provoked.
 */
async function refreshComicAccount({ force = false, quiet = false } = {}) {
  // Asked for unconditionally, unlike before: both features now require an
  // account, so the panel is the only way to get one and has to be readable
  // even with both switches off.
  const generation = comicAccountGeneration;
  if (!quiet) showComicState('loading');
  const response = await chrome.runtime.sendMessage({ type: 'COMIC_ACCOUNT', force });
  // Signed in or out while this was on the wire: the answer is about an account
  // the user has already moved on from, and every branch below would paint it.
  if (generation !== comicAccountGeneration) return;

  if (!response || !response.ok) {
    // A token that the server has since revoked comes back as unauthorized;
    // the honest answer to that is "signed out", not an error. Worth showing
    // even on a quiet pass — the panel would otherwise keep offering an
    // account that is gone.
    if (response && response.error && response.error.code === 'unauthorized') {
      comicSignedIn = false;
      renderAccountFeatures();
      showComicState('signedOut');
      return;
    }
    if (quiet) return;
    // Unreachable, not signed out. The switches keep showing the preference
    // rather than retracting on a service outage the user did not cause; the
    // gate still asks for a sign-in before either can be turned on.
    comicSignedIn = null;
    elements.comicAccountLoading.textContent = t('comicAccountError');
    showComicState('loading');
    return;
  }

  showAccount(response.data);
}

/** Put a fetched account on screen. Returns whether it is a signed-in one. */
function showAccount(account) {
  if (!account.signedIn) {
    comicSignedIn = false;
    renderAccountFeatures();
    showComicState('signedOut');
    return false;
  }

  comicSignedIn = true;
  renderAccountFeatures();
  elements.comicEmail.textContent = account.user?.email || account.user?.name || '';
  // Pages left this month, per feature: the product is free, so a balance would
  // be answering a question nobody is asking.
  elements.comicPagesRemaining.textContent = freePagesLeft(account, 'comic_page');
  elements.pdfPagesRemaining.textContent = freePagesLeft(account, 'pdf_page');
  elements.freeQuotaReset.textContent = formatResetDate(account);
  showComicState('signedIn');
  return true;
}

/**
 * Sign in, or join the sign-in already running.
 *
 * Both switches are live while signed out, so turning them on in quick
 * succession sends two gates here. Two independent flows would open two
 * authentication tabs, and the second to finish would overwrite the first: a
 * cancelled one landing after a successful one renders the signed-out panel
 * with a valid token in storage. One flow, one answer, both callers.
 */
function comicSignIn() {
  if (!comicSignInInFlight) {
    comicSignInInFlight = runComicSignIn().finally(() => { comicSignInInFlight = null; });
  }
  return comicSignInInFlight;
}

async function runComicSignIn() {
  // This decides the account outright, so any read already on the wire is stale
  // from here on — including the one this replaces.
  comicAccountGeneration += 1;
  showComicState('loading');
  elements.comicAccountLoading.textContent = t('comicSigningIn');
  const response = await chrome.runtime.sendMessage({ type: 'COMIC_SIGN_IN' });
  elements.comicAccountLoading.textContent = t('comicAccountLoading');

  if (!response || !response.ok) {
    comicSignedIn = false;
    renderAccountFeatures();
    if (response?.error?.code !== 'sign_in_cancelled') {
      showStatus(response?.error?.message || t('comicSignInFailed'), 'error');
    }
    showComicState('signedOut');
    return false;
  }
  // Rendered from what sign-in already fetched: the worker saved the token and
  // returned the account in the same call. Asking again would be a second
  // round-trip whose transient failure would read as "not signed in" — clearing
  // the checkbox and demanding an account the user just successfully created.
  return showAccount(response.data);
}

async function comicSignOut() {
  comicAccountGeneration += 1;
  await chrome.runtime.sendMessage({ type: 'COMIC_SIGN_OUT' });
  comicSignedIn = false;
  // Both switches go off with the token: neither feature can run on a device
  // with no account, so leaving one on would be a switch that promises a
  // sign-in prompt rather than a translation.
  //
  // The stored preference behind them is deliberately NOT written off. It lives
  // in sync storage while the token lives in local, so clobbering it here would
  // reach across to every other device the account is still signed in on and
  // disable the feature there — a sign-out is about this device's credential,
  // nothing more. Signing back in restores what the user had.
  renderAccountFeatures();
  showComicState('signedOut');
}

/**
 * Gate for the two Advanced Settings switches: turning one ON requires an
 * account, so an unauthenticated user gets the sign-in flow instead, and the
 * switch snaps back if they cancel or it fails.
 *
 * Turning one OFF is never gated — a user who cannot sign in must still be able
 * to put the setting back the way it was.
 */
async function requireAccountFor(checkbox) {
  if (!checkbox.checked) return true;
  // The switches are live from the first paint, while the account request is
  // still on the wire and `comicSignedIn` is merely at its initial null. A
  // click landing in that window would open an authentication tab at someone
  // who is already signed in, so wait for the answer before believing it.
  await comicAccountReady;
  if (comicSignedIn) return true;
  const signedIn = await comicSignIn();
  if (!signedIn) {
    // Back to preference-AND-account, which with no account is off. The failed
    // sign-in itself has already rendered that; this covers the checkbox the
    // user just clicked in the same pass.
    renderAccountFeatures();
    showStatus(t('accountRequired'), 'error');
  }
  return signedIn;
}

// Load settings from storage
async function loadSettings() {
  try {
    const result = await chrome.storage.sync.get(defaultSettings);

    // Determine target language: use browser language if user never set it
    let targetLang = result.targetLang;
    if (!result.targetLangSetByUser || !targetLang) {
      targetLang = getBrowserLanguage();
    }
    // Carried forward by every autosave, and only flipped by the language
    // select itself — see the autosave block.
    targetLangSetByUser = !!result.targetLangSetByUser;

    // Determine provider from saved settings or detect from endpoint
    let provider = result.provider;
    if (!provider || !PROVIDERS[provider]) {
      provider = detectProviderFromEndpoint(result.apiEndpoint);
    }

    // Set provider dropdown
    elements.provider.value = provider;

    // Set endpoint
    elements.apiEndpoint.value = result.apiEndpoint;

    // Show/hide custom endpoint group
    if (provider === 'custom') {
      elements.customEndpointGroup.style.display = 'block';
    } else {
      elements.customEndpointGroup.style.display = 'none';
    }

    // Update model dropdown and set current model
    updateModelDropdown(provider, result.modelName);

    elements.apiKey.value = result.apiKey;
    elements.translationEngine.value = result.translationEngine === 'ai' ? 'ai' : 'builtin';
    elements.targetLang.value = targetLang;
    elements.enableSelection.checked = result.enableSelection;
    elements.selectionTranslationMode.value = result.selectionTranslationMode || 'inline';
    elements.selectionTranslationHotkey.value = result.selectionTranslationHotkey || DEFAULT_SELECTION_HOTKEY;
    elements.enableHoverTranslation.checked = result.enableHoverTranslation;
    elements.hoverTranslationHotkey.value = result.hoverTranslationHotkey || 'Shift';
    elements.showFloatBall.checked = result.showFloatBall;
    elements.autoDetect.checked = result.autoDetect;
    elements.showTranslationOnly.checked = !!result.showTranslationOnly;
    elements.enableImageOcrTranslation.checked = result.enableImageOcrTranslation !== false;
    elements.ocrEngine.value = result.ocrEngine === 'vision' ? 'vision' : OCRCore.DEFAULT_OCR_ENGINE;
    renderOcrLanguages();
    elements.ocrSourceLanguage.value = result.ocrSourceLanguage || 'auto';
    elements.ocrTranslate.checked = result.ocrTranslate !== false;
    syncOcrSubState();
    // The switches themselves are drawn by renderAccountFeatures, which also
    // weighs whether this device has the account both features need.
    storedComicEnabled = !!result.enableComicTranslation;
    storedPdfEnabled = !!result.enablePdfTranslation;
    elements.comicTargetLang.value = result.comicTargetLang || '';
    elements.pdfTargetLang.value = result.pdfTargetLang || '';
    renderAccountFeatures();
    elements.enableYoutubeCaptionTranslation.checked = !!result.enableYoutubeCaptionTranslation;
    elements.showYoutubeOriginalCaption.checked = result.showYoutubeOriginalCaption !== false;
    elements.youtubeCaptionFontColor.value = result.youtubeCaptionFontColor || '#ffffff';
    elements.youtubeCaptionBgColor.value = result.youtubeCaptionBgColor || '#080808';
    elements.youtubeCaptionBgOpacity.value = result.youtubeCaptionBgOpacity != null ? result.youtubeCaptionBgOpacity : 82;
    updateCaptionPreview();
    syncYoutubeSubState();
    elements.customPrompt.value = result.customPrompt || '';

    // Apply theme
    applyTheme(result.theme || 'light');

    // Apply i18n based on target language
    applyI18n(targetLang);
    applyPlatformHotkeyLabels();

    syncInlineSettingState();
    refreshBuiltinStatus();

    lastGoodSettings = collectSettings();
    if (hasHotkeyConflict(lastGoodSettings) && resolveStoredHotkeyConflict()) {
      // Warn after the write, not before: persistSettings ends by confirming
      // the save, which would otherwise cover the warning immediately. An
      // 'error' does not auto-hide, so this way round it survives.
      await persistSettings();
      showStatus(t('hotkeyConflict'), 'error');
    }
  } catch (error) {
    console.error('Failed to load settings:', error);
    showStatus(t('connectionFailed'), 'error');
  }
}

// Apply theme
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
}

// Toggle theme
function toggleTheme() {
  const currentTheme = document.documentElement.getAttribute('data-theme') || 'light';
  const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
  applyTheme(newTheme);
  
  // Save theme preference
  chrome.storage.sync.set({ theme: newTheme });
  
  // Notify content scripts
  notifyContentScripts({ theme: newTheme });
}

// ---------------------------------------------------------------------------
// Autosave
//
// There is no Save button: every control writes itself the moment it changes.
// That removes the failure the button created — changing a setting, not
// noticing the button, and leaving with nothing written.
//
// Two things make this more than the old saveSettings() on a different event:
//
//  - It must never refuse to write. The old flow aborted the whole save when
//    the API key was blank, so under autosave anyone without a key could not
//    change ANY setting: turning the float ball off would silently do nothing.
//    Judging credentials is now Test Connection's job, and it sits with the
//    fields it judges.
//  - targetLangSetByUser only flips when the user actually touches the
//    language. It records an explicit choice, so writing it on an unrelated
//    toggle would permanently freeze the language at whatever the browser
//    happened to imply.
// ---------------------------------------------------------------------------

const AUTOSAVE_DEBOUNCE_MS = 500;
let autosaveTimer = null;
let targetLangSetByUser = false;

// Read the whole form. Cheap enough to do wholesale on every change, and
// writing every key each time keeps storage consistent with what is on screen.
function collectSettings() {
  const providerKey = elements.provider.value;
  const provider = PROVIDERS[providerKey];

  // Get endpoint: use provider's endpoint unless custom
  let apiEndpoint = elements.apiEndpoint.value.trim();
  if (providerKey !== 'custom' && provider) {
    apiEndpoint = provider.endpoint;
  }

  // Get model name from dropdown or custom input
  const modelName = getEffectiveModelName();

  return {
    translationEngine: elements.translationEngine.value,
    provider: providerKey,
    apiEndpoint: apiEndpoint,
    apiKey: elements.apiKey.value.trim(),
    modelName: modelName,
    targetLang: elements.targetLang.value,
    targetLangSetByUser: targetLangSetByUser,
    enableSelection: elements.enableSelection.checked,
    enableHoverTranslation: elements.enableHoverTranslation.checked,
    selectionTranslationMode: elements.selectionTranslationMode.value,
    selectionTranslationHotkey: elements.selectionTranslationHotkey.value,
    hoverTranslationHotkey: elements.hoverTranslationHotkey.value,
    showFloatBall: elements.showFloatBall.checked,
    autoDetect: elements.autoDetect.checked,
    showTranslationOnly: elements.showTranslationOnly.checked,
    enableImageOcrTranslation: elements.enableImageOcrTranslation.checked,
    ocrEngine: elements.ocrEngine.value,
    ocrSourceLanguage: elements.ocrSourceLanguage.value,
    ocrTranslate: elements.ocrTranslate.checked,
    enableYoutubeCaptionTranslation: elements.enableYoutubeCaptionTranslation.checked,
    showYoutubeOriginalCaption: elements.showYoutubeOriginalCaption.checked,
    youtubeCaptionFontColor: elements.youtubeCaptionFontColor.value,
    youtubeCaptionBgColor: elements.youtubeCaptionBgColor.value,
    youtubeCaptionBgOpacity: parseInt(elements.youtubeCaptionBgOpacity.value, 10),
    customPrompt: elements.customPrompt.value.trim(),
    theme: document.documentElement.getAttribute('data-theme') || 'light'
  };
}

// ---------------------------------------------------------------------------
// Hotkey conflicts
//
// A shared hotkey is not cosmetic — it breaks translation and bills the user
// for the privilege. Both content scripts register their keydown listener on
// document in the capture phase, selection first (see content-bootstrap.js), so
// one press runs both. translateSelectionInline registers the block in
// `selectionTranslations` synchronously, before it awaits the API; hover's
// handler then sees that entry, treats it as "already translated", and clears
// it — which bumps the request id. The response arrives to a stale id and is
// discarded. The request was still made and still charged.
//
// So the invariant that predates autosave has to hold: a conflicting pair is
// never persisted. What autosave changes is only what a refusal may look like.
// It cannot silently drop the write and leave the new value sitting on screen,
// because there is no Save button left to reconcile the two — the control snaps
// back to the stored value instead, and the strip says why.
// ---------------------------------------------------------------------------
const CONFLICT_FIELDS = [
  'enableSelection', 'enableHoverTranslation',
  'selectionTranslationHotkey', 'hoverTranslationHotkey'
];

let lastGoodSettings = null;

function hasHotkeyConflict(settings) {
  return settings.enableSelection
    && settings.enableHoverTranslation
    && settings.selectionTranslationHotkey === settings.hoverTranslationHotkey;
}

// Only the four fields above can create a conflict, and each of them persists
// on its own change event — so exactly one of them differs from the last good
// state, and that one is the change to undo. Reverting the whole form would
// also throw away unrelated edits made since.
function revertConflictingChange() {
  if (!lastGoodSettings) return;
  CONFLICT_FIELDS.forEach((key) => {
    const el = elements[key];
    if (el.type === 'checkbox') {
      el.checked = lastGoodSettings[key];
    } else {
      el.value = lastGoodSettings[key];
    }
  });
  syncInlineSettingState();
}

// A build of this branch shipped without the guard above, so storage may
// already hold a conflicting pair. Leaving it alone would mean the one state
// the guard exists to prevent is also the one it cannot reach — the user's next
// edit would revert to a broken baseline. Move hover to a free key on load.
function resolveStoredHotkeyConflict() {
  const taken = elements.selectionTranslationHotkey.value;
  const free = Array.from(elements.hoverTranslationHotkey.options)
    .map((option) => option.value)
    .find((value) => value !== taken);
  if (!free) return false;
  elements.hoverTranslationHotkey.value = free;
  return true;
}

async function persistSettings({ reapplyI18n = false } = {}) {
  clearTimeout(autosaveTimer);
  autosaveTimer = null;

  const settings = collectSettings();

  // Checked before the write, not after: a conflicting pair must never reach
  // storage, because the content scripts act on it the moment it is broadcast.
  if (hasHotkeyConflict(settings)) {
    revertConflictingChange();
    showStatus(t('hotkeyConflict'), 'error');
    return;
  }

  try {
    await chrome.storage.sync.set(settings);
    lastGoodSettings = settings;

    // Notify all tabs about settings change
    notifyContentScripts(settings);

    if (reapplyI18n) {
      applyI18n(settings.targetLang);
      applyPlatformHotkeyLabels();
    }

    // Deliberately silent. Autosave fires on every keystroke and every toggle,
    // so confirming each one turned the status strip into a flashing banner
    // that said nothing the user did not already know — and trained them to
    // ignore the strip, which is also where hotkey conflicts and connection
    // failures appear. Success is the expected outcome; only deviations from it
    // are worth interrupting for.
  } catch (error) {
    console.error('Failed to save settings:', error);
    showStatus(t('connectionFailed'), 'error');
  }
}

// For controls that fire continuously — typing a key, dragging the opacity
// slider — so one edit is one write rather than one write per keystroke.
function scheduleAutosave() {
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => persistSettings(), AUTOSAVE_DEBOUNCE_MS);
}

// Anything still pending when the page goes away would otherwise be lost, and
// the last thing typed is usually the API key.
function flushAutosave() {
  if (autosaveTimer) persistSettings();
}

// Notify content scripts
async function notifyContentScripts(settings) {
  try {
    const tabs = await chrome.tabs.query({});
    tabs.forEach(tab => {
      chrome.tabs.sendMessage(tab.id, {
        type: 'SETTINGS_UPDATED',
        settings
      }).catch(() => {});
    });
  } catch (error) {
    // Ignore errors
  }
}

// Endpoint/model shape helpers live in shared/api-compat.js — the same
// module the service worker uses, so the connection test below proves the
// exact request translation will make.

// Test API connection
async function testConnection() {
  const providerKey = elements.provider.value;
  const provider = PROVIDERS[providerKey];

  // Get endpoint
  let apiEndpoint = elements.apiEndpoint.value.trim();
  if (providerKey !== 'custom' && provider) {
    apiEndpoint = provider.endpoint;
  }

  const apiKey = elements.apiKey.value.trim();
  const modelName = getEffectiveModelName();

  // This button is now the only thing on the page that judges the API config,
  // so it says which field is missing instead of a blanket "configure the API".
  if (!apiEndpoint) {
    showStatus(t('pleaseEnterApiEndpoint'), 'warning');
    if (providerKey === 'custom') elements.apiEndpoint.focus();
    return;
  }
  if (!apiKey) {
    showStatus(t('pleaseEnterApiKey'), 'warning');
    elements.apiKey.focus();
    return;
  }
  if (!modelName) {
    showStatus(t('pleaseEnterModelName'), 'warning');
    elements.modelName.focus();
    return;
  }

  showStatus(t('translating'), 'warning');

  // The probe is built by the same helpers the service worker translates with,
  // so "connection successful" means the real request shape was accepted — not
  // merely that the endpoint and key exist.
  const claudeShape = isClaudeAPI(apiEndpoint);
  // 20 tokens is enough for "Hi", but reasoning/thinking models bill hidden
  // tokens against the same budget; the shared builder raises the floor for
  // those, so ask for a small budget and let it decide.
  const PROBE_TOKENS = 20;
  const headers = claudeShape ? claudeHeaders(apiKey) : openAIHeaders(apiKey);
  const body = claudeShape
    ? buildClaudeRequestBody(modelName, 'Hi', PROBE_TOKENS)
    : buildOpenAIRequestBody(modelName, [{ role: 'user', content: 'Hi' }], PROBE_TOKENS, DEFAULT_TEMPERATURE);

  try {
    const response = await fetch(apiEndpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });

    // Vendors disagree on error shape and some report failures with HTTP 200,
    // so always read the body rather than trusting response.ok alone.
    const data = await response.json().catch(() => ({}));
    const result = readAPIResponse(data, response.status, response.ok, claudeShape);
    if (result.error) {
      showStatus(`${t('connectionFailed')}: ${result.error}`, 'error');
    } else {
      showStatus(t('connectionSuccess'), 'success');
    }
  } catch (error) {
    showStatus(`${t('connectionFailed')}: ${error.message}`, 'error');
  }
}

// Reset prompt to default
async function resetPrompt() {
  elements.customPrompt.value = t(DEFAULT_PROMPT_KEY);
  await persistSettings();
  showStatus(t('resetToDefault'), 'success');
}

// Apply preset prompt
async function applyPresetPrompt(presetName) {
  const presetKey = PROMPT_PRESETS[presetName];
  if (!presetKey) return;
  elements.customPrompt.value = t(presetKey);
  // After the write, so the message the user is left with names what they did
  // rather than the generic save confirmation persistSettings would show.
  await persistSettings();
  showStatus(t('presetApplied'), 'success');
}

// Toggle API Key visibility
function toggleApiKeyVisibility() {
  const isPassword = elements.apiKey.type === 'password';
  elements.apiKey.type = isPassword ? 'text' : 'password';
  
  if (isPassword) {
    elements.eyeIcon.innerHTML = `
      <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"/>
      <line x1="1" y1="1" x2="23" y2="23"/>
    `;
  } else {
    elements.eyeIcon.innerHTML = `
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
      <circle cx="12" cy="12" r="3"/>
    `;
  }
}

// ---------------------------------------------------------------------------
// Status area
//
// The strip only ever answers a deliberate action now — a connection test, a
// sign-in, a preset, a rejected hotkey. Autosave used to write here too, on
// every keystroke, which is what made ordering between writers a problem; with
// that gone, last-one-wins is the whole rule.
// ---------------------------------------------------------------------------
let statusHideTimer = null;

// Show status message
function showStatus(message, type) {
  // Cancelling the previous hide is the point: these timers used to be left
  // running, so a message shown at t=0 would blank whatever occupied the strip
  // at t=3s — typically an error that arrived in between.
  clearTimeout(statusHideTimer);
  statusHideTimer = null;

  elements.statusMessage.textContent = message;
  elements.statusMessage.className = `status-message ${type}`;

  if (type === 'success') {
    statusHideTimer = setTimeout(() => {
      elements.statusMessage.classList.add('hidden');
    }, 3000);
  }
}

// Controls that settle on one value per interaction: write straight away.
const IMMEDIATE_SAVE_FIELDS = [
  'translationEngine',
  'enableSelection',
  'selectionTranslationMode',
  'selectionTranslationHotkey',
  'enableHoverTranslation',
  'hoverTranslationHotkey',
  'showFloatBall',
  'autoDetect',
  'showTranslationOnly',
  'enableImageOcrTranslation',
  'ocrEngine',
  'ocrSourceLanguage',
  'ocrTranslate',
  'enableYoutubeCaptionTranslation',
  'showYoutubeOriginalCaption'
];

// Controls that fire on every keystroke or drag frame: debounce, and flush on
// blur so leaving a field always commits it.
const DEBOUNCED_SAVE_FIELDS = [
  'apiEndpoint',
  'apiKey',
  'modelName',
  'customPrompt',
  'youtubeCaptionFontColor',
  'youtubeCaptionBgColor',
  'youtubeCaptionBgOpacity'
];

// ---------------------------------------------------------------------------
// 内置翻译引擎状态
//
// 语言包是按“语言对”下载的，而源语言取决于用户当时打开的是什么页面，设置页
// 无从预知。所以这里只对 en → 目标语言（现实中占绝大多数的那一对）给出状态和
// 一个下载按钮；其它语言对在整页翻译首次用到时自动下载——那条路径带着用户点击
// 产生的 user activation，正是 create() 触发下载所要求的东西。
// ---------------------------------------------------------------------------

const BUILTIN_PROBE_SOURCE = 'en';
let builtinStatusSeq = 0;

function getBuiltinEngine() {
  return window.AI_TRANSLATOR_CONTENT && window.AI_TRANSLATOR_CONTENT.builtinTranslator;
}

async function refreshBuiltinStatus() {
  const isBuiltin = elements.translationEngine.value === 'builtin';
  elements.builtinStatusGroup.hidden = !isBuiltin;
  elements.downloadLanguagePack.hidden = true;
  if (!isBuiltin) return;

  // 改目标语言和切引擎都会重进这里，而中间夹着一次 await。不按序号丢弃过期结果的话，
  // 先发起的那次探测后回来，会把状态覆盖成上一个语言的。
  const seq = ++builtinStatusSeq;
  const engine = getBuiltinEngine();

  if (!engine || !engine.isSupported()) {
    elements.builtinStatus.textContent = t('builtinUnsupportedEnv');
    return;
  }

  const targetLang = elements.targetLang.value;
  if (engine.toApiLang(targetLang) === BUILTIN_PROBE_SOURCE) {
    // 目标语言就是英语，探测 en→en 没有意义。
    elements.builtinStatus.textContent = t('builtinReady');
    return;
  }

  elements.builtinStatus.textContent = t('builtinChecking');
  const status = await engine.availability(BUILTIN_PROBE_SOURCE, targetLang);
  if (seq !== builtinStatusSeq) return;

  switch (status) {
    case 'available':
      elements.builtinStatus.textContent = t('builtinReady');
      break;
    case 'downloading':
      elements.builtinStatus.textContent = t('builtinDownloading');
      break;
    case 'downloadable':
      elements.builtinStatus.textContent = t('builtinDownloadable');
      elements.downloadLanguagePack.hidden = false;
      break;
    default:
      elements.builtinStatus.textContent = t('builtinUnsupportedPair');
  }
}

async function downloadLanguagePack() {
  const engine = getBuiltinEngine();
  if (!engine) return;

  const button = elements.downloadLanguagePack;
  const targetLang = elements.targetLang.value;
  button.disabled = true;

  try {
    // 下载必须由这次点击直接触发：create() 要求 user activation，
    // 挪到别处（比如打开设置页就自动下）会被浏览器直接拒掉。
    await engine.ensureDownloaded(BUILTIN_PROBE_SOURCE, targetLang, (loaded) => {
      const pct = Math.max(0, Math.min(100, Math.round((loaded || 0) * 100)));
      elements.builtinStatus.textContent = `${t('builtinDownloading')} ${pct}%`;
    });
    elements.builtinStatus.textContent = t('builtinReady');
    button.hidden = true;
    showStatus(t('builtinDownloadComplete'), 'success');
  } catch (error) {
    console.error('Language pack download failed:', error);
    elements.builtinStatus.textContent = t('builtinDownloadFailed');
    showStatus(t('builtinDownloadFailed'), 'error');
  } finally {
    button.disabled = false;
  }
}

// Setup event listeners
function setupEventListeners() {
  elements.translationEngine.addEventListener('change', refreshBuiltinStatus);
  elements.downloadLanguagePack.addEventListener('click', downloadLanguagePack);

  elements.testConnection.addEventListener('click', testConnection);
  elements.resetPrompt.addEventListener('click', resetPrompt);
  elements.toggleApiKey.addEventListener('click', toggleApiKeyVisibility);
  elements.themeToggle.addEventListener('click', toggleTheme);

  IMMEDIATE_SAVE_FIELDS.forEach((name) => {
    elements[name].addEventListener('change', () => persistSettings());
  });

  DEBOUNCED_SAVE_FIELDS.forEach((name) => {
    elements[name].addEventListener('input', scheduleAutosave);
    elements[name].addEventListener('blur', flushAutosave);
  });

  // The one field whose value changes what the page is written in, so it is
  // also the one that re-runs i18n.
  elements.targetLang.addEventListener('change', () => {
    targetLangSetByUser = true;
    // 换目标语言等于换了语言对，内置引擎的状态得重查；放在 persistSettings 之后
    // 是因为界面语言此时才切完，否则状态文案会停在上一种语言。
    persistSettings({ reapplyI18n: true }).then(refreshBuiltinStatus);
  });

  // Closing the tab or switching away must not eat a half-typed API key.
  window.addEventListener('beforeunload', flushAutosave);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      flushAutosave();
      stopPdfTasksPoll();
      return;
    }
    // Coming back to the front. The pages-left counters were fetched when this
    // tab loaded, and openOptionsPage() focuses an existing tab instead of
    // reloading it — so a tab left open while comic or PDF jobs spend the
    // month's allowance would keep showing the numbers it opened with, with
    // nothing to ever correct them. `force` is what makes this work: the
    // worker caches the account for 30s, and without it a refresh right after
    // a job would re-serve the pre-job numbers.
    refreshComicAccount({ force: true, quiet: true });
    // Same reasoning for the task list, and the same reason it stops polling
    // while hidden: a background tab has nobody watching it move.
    if (!elements.pdfTasksCard.hidden) refreshPdfTasks({ quiet: true });
  });

  elements.comicSignIn.addEventListener('click', comicSignIn);
  elements.comicSignOut.addEventListener('click', comicSignOut);
  elements.pdfTasksRefresh.addEventListener('click', () => refreshPdfTasks());

  // Provider change rewrites the endpoint and the model list, so the write has
  // to happen after those, not on the generic handler above.
  elements.provider.addEventListener('change', () => {
    onProviderChange();
    persistSettings();
  });

  // Also ordered: picking from the dropdown clears the custom-model input, and
  // getEffectiveModelName prefers that input — saving first would store the
  // custom name the user just replaced.
  elements.modelSelect.addEventListener('change', () => {
    onModelSelectChange();
    persistSettings();
  });

  // The write this keystroke also triggers is debounced, so the dropdown is
  // already released by the time collectSettings reads the pair — regardless of
  // which listener the browser happens to call first.
  elements.modelName.addEventListener('input', onCustomModelInput);

  elements.enableSelection.addEventListener('change', syncInlineSettingState);
  elements.enableHoverTranslation.addEventListener('change', syncInlineSettingState);

  // These two write through their own path because turning either on demands an
  // account first, which nothing else on the page does. Only the switch itself
  // carries that gate: both handlers persist the same pair of keys, so letting
  // the language select run it would make picking a language ask for sign-in —
  // and, if that were cancelled, turn the feature off.
  elements.enableComicTranslation.addEventListener('change', () => saveComicSettings({ gate: true }));
  elements.comicTargetLang.addEventListener('change', () => saveComicSettings());

  elements.enablePdfTranslation.addEventListener('change', () => savePdfSettings({ gate: true }));
  elements.pdfTargetLang.addEventListener('change', () => savePdfSettings());

  // YouTube caption sub-options (enable/disable + live style preview)
  elements.enableImageOcrTranslation.addEventListener('change', syncOcrSubState);
  elements.ocrEngine.addEventListener('change', syncOcrSubState);

  elements.enableYoutubeCaptionTranslation.addEventListener('change', syncYoutubeSubState);
  elements.showYoutubeOriginalCaption.addEventListener('change', updateCaptionPreview);
  elements.youtubeCaptionFontColor.addEventListener('input', updateCaptionPreview);
  elements.youtubeCaptionBgColor.addEventListener('input', updateCaptionPreview);
  elements.youtubeCaptionBgOpacity.addEventListener('input', updateCaptionPreview);

  // Preset prompt buttons. A programmatic value change fires no input event, so
  // these have to ask for the write themselves.
  document.querySelectorAll('.btn-preset').forEach(btn => {
    btn.addEventListener('click', () => {
      const preset = btn.getAttribute('data-preset');
      applyPresetPrompt(preset);
    });
  });

  // Ctrl+S / Cmd+S no longer has anything to save, but the reflex is strong
  // enough that swallowing it and confirming beats letting the browser open a
  // "save page as" dialog over a settings screen.
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      persistSettings();
    }
  });
}

/**
 * `gate` is set only by the switch's own change event — see setupEventListeners.
 *
 * Only a gated call moves the preference. The language select shares this
 * handler and must write the pair without touching the switch: it can be
 * reached while the account answer is still outstanding, and reading the
 * checkbox there would persist a switch that is merely mid-render.
 */
async function saveComicSettings({ gate = false } = {}) {
  if (gate) {
    // Read before the gate, not after: a successful sign-in redraws both
    // switches from the stored preference, which does not yet include the click
    // being handled here.
    const wanted = elements.enableComicTranslation.checked;
    // A refused sign-in leaves the preference exactly as it was — writing false
    // would sync across and disable the feature on a device that is signed in.
    if (!(await requireAccountFor(elements.enableComicTranslation))) return;
    storedComicEnabled = wanted;
    renderAccountFeatures();
  }
  try {
    await chrome.storage.sync.set({
      enableComicTranslation: storedComicEnabled,
      comicTargetLang: elements.comicTargetLang.value
    });
  } catch (error) {
    // Only sync-quota exhaustion can land here, and these two keys are a few
    // bytes. Log it rather than invent an error toast: reopening the page
    // re-renders from storage, so the user sees the real state either way.
    console.error('Failed to save comic settings:', error);
  }
}

/** See saveComicSettings — same contract, same reasons. */
async function savePdfSettings({ gate = false } = {}) {
  if (gate) {
    const wanted = elements.enablePdfTranslation.checked;
    if (!(await requireAccountFor(elements.enablePdfTranslation))) return;
    storedPdfEnabled = wanted;
    renderAccountFeatures();
  }
  try {
    await chrome.storage.sync.set({
      enablePdfTranslation: storedPdfEnabled,
      pdfTargetLang: elements.pdfTargetLang.value
    });
  } catch (error) {
    // See saveComicSettings: only sync-quota exhaustion can land here.
    console.error('Failed to save PDF settings:', error);
  }
}

function syncInlineSettingState() {
  const selectionEnabled = elements.enableSelection.checked;
  const hoverEnabled = elements.enableHoverTranslation.checked;

  elements.selectionTranslationMode.disabled = !selectionEnabled;
  elements.selectionTranslationHotkey.disabled = !selectionEnabled;
  elements.hoverTranslationHotkey.disabled = !hoverEnabled;
}

// Grey out the YouTube caption sub-options when the feature itself is off.
function syncYoutubeSubState() {
  if (!elements.youtubeSubOptions) return;
  elements.youtubeSubOptions.classList.toggle('disabled', !elements.enableYoutubeCaptionTranslation.checked);
}

/**
 * Fill the OCR language picker from OCRCore.OCR_LANGUAGES, below the "auto"
 * option the markup carries. A language is only offerable if its .traineddata
 * is vendored, so shared/ocr.js owns the list and this page reads it — hard-
 * coding the options here is how the two drift into disagreeing.
 *
 * The labels stay as data-i18n keys; applyI18n fills them in a moment later.
 */
function renderOcrLanguages() {
  const select = elements.ocrSourceLanguage;
  if (!select || select.dataset.populated) return;
  for (const lang of OCRCore.OCR_LANGUAGES) {
    const option = document.createElement('option');
    option.value = lang.code;
    option.dataset.i18n = lang.labelKey;
    select.appendChild(option);
  }
  select.dataset.populated = '1';
}

/**
 * Finish the "auto" label by naming the languages it resolves to right now —
 * "Auto (English + 简体中文)".
 *
 * "Auto" on its own is the one option here that does something the user cannot
 * see: the local engine must be handed a fixed language list, so auto quietly
 * means English (it turns up in screenshots, UI chrome and signage everywhere)
 * plus the one script the user reads. Someone whose images are Japanese while
 * their target language is Chinese has to be able to notice that from the
 * picker, because it is exactly the case where they should choose a language
 * themselves.
 *
 * Written after applyI18n rather than as a data-i18n key: the resolution lives
 * in shared/ocr.js and depends on the UI language, so it cannot be a string in
 * ten locale tables.
 */
function syncOcrAutoLabel() {
  const select = elements.ocrSourceLanguage;
  const option = select && select.querySelector('option[value="auto"]');
  if (!option) return;
  const names = OCRCore.resolveOcrLanguages('auto', currentUILang).split('+').map((code) => {
    const lang = OCRCore.OCR_LANGUAGES.find((entry) => entry.code === code);
    return lang ? t(lang.labelKey) : code;
  });
  option.textContent = `${t('ocrSourceLanguageAuto')} (${names.join(' + ')})`;
}

// Same, for image OCR — plus one rule of its own: the language list belongs to
// the local engine. Tesseract has to be told which languages to look for, so
// the setting exists at all; a vision model reads whatever is in the image and
// leaving the control live would promise a choice that changes nothing.
function syncOcrSubState() {
  if (!elements.ocrSubOptions) return;
  elements.ocrSubOptions.classList.toggle('disabled', !elements.enableImageOcrTranslation.checked);
  if (elements.ocrSourceLanguageGroup) {
    elements.ocrSourceLanguageGroup.hidden = elements.ocrEngine.value === 'vision';
  }
}

function capHexToRgba(hex, alpha) {
  const h = String(hex || '').replace('#', '');
  if (h.length !== 6) return `rgba(8, 8, 8, ${alpha})`;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// Live-update the caption preview from the current color/opacity controls.
function updateCaptionPreview() {
  const preview = elements.youtubeCaptionPreview;
  if (!preview) return;
  const fg = elements.youtubeCaptionFontColor.value || '#ffffff';
  const opacityPct = Math.max(0, Math.min(100, parseInt(elements.youtubeCaptionBgOpacity.value, 10) || 0));
  const bg = capHexToRgba(elements.youtubeCaptionBgColor.value || '#080808', opacityPct / 100);
  preview.style.setProperty('--cap-preview-fg', fg);
  preview.style.setProperty('--cap-preview-bg', bg);
  if (elements.youtubeCaptionBgOpacityValue) {
    elements.youtubeCaptionBgOpacityValue.textContent = `${opacityPct}%`;
  }
  const original = preview.querySelector('.caption-preview-original');
  if (original) {
    original.style.display = elements.showYoutubeOriginalCaption.checked ? '' : 'none';
  }
}
