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
const PROVIDERS = {
  openai: {
    name: 'OpenAI',
    endpoint: 'https://api.openai.com/v1/chat/completions',
    models: ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-5', 'gpt-5-mini', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano', 'gpt-4o', 'gpt-4o-mini', 'o3', 'o3-mini', 'o4-mini'],
    defaultModel: 'gpt-4.1-mini'
  },
  anthropic: {
    name: 'Anthropic Claude',
    endpoint: 'https://api.anthropic.com/v1/messages',
    // Native Anthropic API accepts version aliases (no date suffix); aliases
    // always resolve to the latest snapshot and avoid stale/incorrect dates.
    models: ['claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5', 'claude-fable-5', 'claude-opus-4-7', 'claude-sonnet-4-6', 'claude-opus-4-5', 'claude-sonnet-4-5', 'claude-opus-4-1'],
    defaultModel: 'claude-sonnet-5'
  },
  gemini: {
    name: 'Google Gemini',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    models: ['gemini-3.5-flash', 'gemini-3-pro', 'gemini-3-flash', 'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash'],
    defaultModel: 'gemini-3-flash'
  },
  deepseek: {
    name: 'DeepSeek',
    endpoint: 'https://api.deepseek.com/v1/chat/completions',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    defaultModel: 'deepseek-chat'
  },
  openrouter: {
    name: 'OpenRouter',
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    models: [
      // Anthropic Claude
      'anthropic/claude-opus-4.8',
      'anthropic/claude-sonnet-5',
      'anthropic/claude-opus-4.5',
      'anthropic/claude-sonnet-4.5',
      'anthropic/claude-haiku-4.5',
      'anthropic/claude-opus-4.1',
      'anthropic/claude-sonnet-4',
      'anthropic/claude-opus-4',
      // OpenAI
      'openai/gpt-5.5',
      'openai/gpt-5',
      'openai/gpt-5-mini',
      'openai/gpt-4.1',
      'openai/gpt-4.1-mini',
      'openai/gpt-4.1-nano',
      'openai/gpt-4o',
      'openai/gpt-4o-mini',
      'openai/o3',
      'openai/o3-mini',
      'openai/o4-mini',
      // Google Gemini
      'google/gemini-3.5-flash',
      'google/gemini-3-flash',
      'google/gemini-3-pro',
      'google/gemini-2.5-pro',
      'google/gemini-2.5-flash',
      // DeepSeek
      'deepseek/deepseek-chat',
      'deepseek/deepseek-reasoner'
    ],
    defaultModel: 'anthropic/claude-sonnet-5'
  },
  ollama: {
    name: 'Ollama (Local)',
    endpoint: 'http://localhost:11434/v1/chat/completions',
    models: ['llama3.3', 'qwen2.5', 'deepseek-r1', 'gemma2'],
    defaultModel: 'llama3.3'
  },
  lmstudio: {
    name: 'LM Studio (Local)',
    endpoint: 'http://localhost:1234/v1/chat/completions',
    models: [],
    defaultModel: ''
  },
  custom: {
    name: 'Custom',
    endpoint: '',
    models: [],
    defaultModel: ''
  }
};

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
  // Comic translation
  enableComicTranslation: document.getElementById('enableComicTranslation'),
  comicTargetLang: document.getElementById('comicTargetLang'),
  comicAccountLoading: document.getElementById('comicAccountLoading'),
  comicSignedOut: document.getElementById('comicSignedOut'),
  comicSignedIn: document.getElementById('comicSignedIn'),
  comicEmail: document.getElementById('comicEmail'),
  comicPagesRemaining: document.getElementById('comicPagesRemaining'),
  comicBalance: document.getElementById('comicBalance'),
  comicFreeQuota: document.getElementById('comicFreeQuota'),
  comicSignIn: document.getElementById('comicSignIn'),
  comicSignOut: document.getElementById('comicSignOut'),
  comicTopUp: document.getElementById('comicTopUp'),
  // PDF translation
  enablePdfTranslation: document.getElementById('enablePdfTranslation'),
  pdfTargetLang: document.getElementById('pdfTargetLang')
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

// Handle model select change
function onModelSelectChange() {
  const selectedModel = elements.modelSelect.value;
  if (selectedModel) {
    // Clear custom input when selecting from dropdown
    elements.modelName.value = '';
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
  // Not awaited: this is a network round-trip and the rest of the page must not
  // wait on the comic service being reachable.
  refreshComicAccount();
});

// ---------------------------------------------------------------------------
// Comic translation account
//
// Separate from every other setting on this page: it is a server-side account
// with a credit balance, not something stored in chrome.storage.sync, so it
// loads over the network and its buttons act immediately instead of on Save.
// ---------------------------------------------------------------------------

function showComicState(name) {
  elements.comicAccountLoading.classList.toggle('hidden', name !== 'loading');
  elements.comicSignedOut.classList.toggle('hidden', name !== 'signedOut');
  elements.comicSignedIn.classList.toggle('hidden', name !== 'signedIn');
}

async function refreshComicAccount({ force = false } = {}) {
  // With both features off there is nothing to act on and no reason to ask a
  // paid service about a balance the user cannot spend. Both, not just comics:
  // PDF translation spends the same account, and its card defers to this one
  // for sign-in and balance.
  const { enableComicTranslation, enablePdfTranslation } = await chrome.storage.sync.get({
    enableComicTranslation: false,
    enablePdfTranslation: true
  });
  if (!enableComicTranslation && !enablePdfTranslation) {
    showComicState(null);
    return;
  }

  showComicState('loading');
  const response = await chrome.runtime.sendMessage({ type: 'COMIC_ACCOUNT', force });

  if (!response || !response.ok) {
    // A token that the server has since revoked comes back as unauthorized;
    // the honest answer to that is "signed out", not an error.
    if (response && response.error && response.error.code === 'unauthorized') {
      showComicState('signedOut');
      return;
    }
    elements.comicAccountLoading.textContent = t('comicAccountError');
    showComicState('loading');
    return;
  }

  const account = response.data;
  if (!account.signedIn) {
    showComicState('signedOut');
    return;
  }

  elements.comicEmail.textContent = account.user?.email || account.user?.name || '';
  // Pages, not points, leads: points are an internal unit and nobody buys a
  // translation in points.
  elements.comicPagesRemaining.textContent = account.pagesRemaining ?? 0;
  elements.comicBalance.textContent = account.balancePoints ?? 0;
  elements.comicFreeQuota.textContent = account.freeQuota?.remaining ?? 0;
  showComicState('signedIn');
}

async function comicSignIn() {
  showComicState('loading');
  elements.comicAccountLoading.textContent = t('comicSigningIn');
  const response = await chrome.runtime.sendMessage({ type: 'COMIC_SIGN_IN' });
  elements.comicAccountLoading.textContent = t('comicAccountLoading');

  if (!response || !response.ok) {
    if (response?.error?.code !== 'sign_in_cancelled') {
      showStatus(response?.error?.message || t('comicSignInFailed'), 'error');
    }
    showComicState('signedOut');
    return;
  }
  await refreshComicAccount({ force: true });
}

async function comicSignOut() {
  await chrome.runtime.sendMessage({ type: 'COMIC_SIGN_OUT' });
  showComicState('signedOut');
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
    elements.enableComicTranslation.checked = !!result.enableComicTranslation;
    elements.comicTargetLang.value = result.comicTargetLang || '';
    elements.comicTargetLang.disabled = !result.enableComicTranslation;
    elements.enablePdfTranslation.checked = !!result.enablePdfTranslation;
    elements.pdfTargetLang.value = result.pdfTargetLang || '';
    elements.pdfTargetLang.disabled = !result.enablePdfTranslation;
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

  // Claimed before the write, compared after it. See the yield below.
  const seq = statusSeq;
  try {
    await chrome.storage.sync.set(settings);
    lastGoodSettings = settings;

    // Notify all tabs about settings change
    notifyContentScripts(settings);

    if (reapplyI18n) {
      applyI18n(settings.targetLang);
      applyPlatformHotkeyLabels();
    }

    if (statusSeq === seq) {
      // The save confirmation yields. It is routine reassurance, while every
      // other message on this strip answers a deliberate action — so if anyone
      // spoke while the write was in flight, leave their message alone.
      //
      // The case that forced this: clicking Test Connection blurs the field
      // being edited, so the flush lands in the middle of the probe. Whichever
      // finished last used to win, meaning a connection result could be
      // replaced by "settings saved" — the user asked a question and got an
      // unrelated answer. The write itself is unaffected either way.
      showStatus(t('settingsSaved'), 'success');
    }
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

// Detect if the API endpoint is Anthropic Claude API
function isClaudeAPI(endpoint) {
  if (!endpoint) return false;
  return endpoint.includes('anthropic.com') || endpoint.includes('/v1/messages');
}

// GPT-5.x and o-series reasoning models use `max_completion_tokens` instead of
// `max_tokens`; sending `max_tokens` to them returns HTTP 400.
function isOpenAIReasoningModel(model) {
  const name = String(model || '').toLowerCase().trim();
  const shortName = name.includes('/') ? name.split('/').pop() : name;
  return /^gpt-5/.test(shortName) || /^o[1-9]/.test(shortName);
}

// GPT-5 family accepts `reasoning_effort`; 'minimal' skips heavy reasoning so a
// probe returns text quickly. The o-series does not support 'minimal'.
function isGpt5Family(model) {
  const name = String(model || '').toLowerCase().trim();
  const shortName = name.includes('/') ? name.split('/').pop() : name;
  return /^gpt-5/.test(shortName);
}

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

  try {
    let response;

    if (isClaudeAPI(apiEndpoint)) {
      // Use Claude API format
      response = await fetch(apiEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: modelName || 'claude-sonnet-5',
          // Room for a reply even when the model spends budget on thinking.
          max_tokens: 256,
          messages: [
            { role: 'user', content: 'Hi' }
          ]
        })
      });
    } else {
      // Use OpenAI-compatible API format
      const testModel = modelName || 'gpt-4.1-mini';
      const testBody = {
        model: testModel,
        messages: [
          { role: 'user', content: 'Hi' }
        ]
      };
      // GPT-5.x / o-series reasoning models require max_completion_tokens and
      // spend part of it on hidden reasoning — give the probe room to reply.
      if (isOpenAIReasoningModel(testModel)) {
        testBody.max_completion_tokens = 256;
        if (isGpt5Family(testModel)) {
          testBody.reasoning_effort = 'minimal';
        }
      } else {
        testBody.max_tokens = 20;
      }
      response = await fetch(apiEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify(testBody)
      });
    }

    if (response.ok) {
      showStatus(t('connectionSuccess'), 'success');
    } else {
      const error = await response.json().catch(() => ({}));
      showStatus(`${t('connectionFailed')}: ${error.error?.message || response.status}`, 'error');
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
// One strip serves autosave, connection tests, sign-in and presets, so writes
// to it have to be ordered rather than last-one-wins. `statusSeq` counts them,
// which lets a slow async writer notice that someone else has since spoken and
// hold its tongue — see persistSettings.
// ---------------------------------------------------------------------------
let statusHideTimer = null;
let statusSeq = 0;

// Show status message
function showStatus(message, type) {
  // Cancelling the previous hide is the point: these timers used to be left
  // running, so a save confirmation shown at t=0 would blank whatever occupied
  // the strip at t=3s — typically a connection error that arrived in between.
  clearTimeout(statusHideTimer);
  statusHideTimer = null;
  statusSeq += 1;

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
    if (document.visibilityState === 'hidden') flushAutosave();
  });

  elements.comicSignIn.addEventListener('click', comicSignIn);
  elements.comicSignOut.addEventListener('click', comicSignOut);
  elements.comicTopUp.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'COMIC_OPEN_RECHARGE' });
    // The purchase happens in the tab that just opened; re-reading the balance
    // when the user comes back is what makes the new credits show up here.
    window.addEventListener('focus', () => refreshComicAccount({ force: true }), { once: true });
  });

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

  elements.enableSelection.addEventListener('change', syncInlineSettingState);
  elements.enableHoverTranslation.addEventListener('change', syncInlineSettingState);

  // These two write through their own path because they also refresh the
  // account panel, which nothing else on the page does.
  elements.enableComicTranslation.addEventListener('change', saveComicSettings);
  elements.comicTargetLang.addEventListener('change', saveComicSettings);

  // PDF settings share the write-on-change path for the same reason: Save is
  // gated on a BYO API key that this account-backed feature does not use.
  elements.enablePdfTranslation.addEventListener('change', savePdfSettings);
  elements.pdfTargetLang.addEventListener('change', savePdfSettings);

  // YouTube caption sub-options (enable/disable + live style preview)
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

async function saveComicSettings() {
  const enabled = elements.enableComicTranslation.checked;
  elements.comicTargetLang.disabled = !enabled;
  try {
    await chrome.storage.sync.set({
      enableComicTranslation: enabled,
      comicTargetLang: elements.comicTargetLang.value
    });
    // Switching on should reveal the account state here and now — being told to
    // reload the page to find out whether you are signed in is not an answer.
    await refreshComicAccount();
  } catch (error) {
    // Only sync-quota exhaustion can land here, and these two keys are a few
    // bytes. Log it rather than invent an error toast: reopening the page
    // re-renders from storage, so the user sees the real state either way.
    console.error('Failed to save comic settings:', error);
  }
}

async function savePdfSettings() {
  const enabled = elements.enablePdfTranslation.checked;
  elements.pdfTargetLang.disabled = !enabled;
  try {
    await chrome.storage.sync.set({
      enablePdfTranslation: enabled,
      pdfTargetLang: elements.pdfTargetLang.value
    });
    // Sign-in state lives on the shared comic card; switching PDF on should
    // surface it the same way switching comics on does.
    await refreshComicAccount();
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
