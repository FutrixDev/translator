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
  saveSettings: document.getElementById('saveSettings'),
  testConnection: document.getElementById('testConnection'),
  resetPrompt: document.getElementById('resetPrompt'),
  toggleApiKey: document.getElementById('toggleApiKey'),
  themeToggle: document.getElementById('themeToggle'),
  statusMessage: document.getElementById('statusMessage'),
  eyeIcon: document.getElementById('eyeIcon')
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
});

// Load settings from storage
async function loadSettings() {
  try {
    const result = await chrome.storage.sync.get(defaultSettings);

    // Determine target language: use browser language if user never set it
    let targetLang = result.targetLang;
    if (!result.targetLangSetByUser || !targetLang) {
      targetLang = getBrowserLanguage();
    }

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
    elements.targetLang.value = targetLang;
    elements.enableSelection.checked = result.enableSelection;
    elements.selectionTranslationMode.value = result.selectionTranslationMode || 'inline';
    elements.selectionTranslationHotkey.value = result.selectionTranslationHotkey || DEFAULT_SELECTION_HOTKEY;
    elements.enableHoverTranslation.checked = result.enableHoverTranslation;
    elements.hoverTranslationHotkey.value = result.hoverTranslationHotkey || 'Shift';
    elements.showFloatBall.checked = result.showFloatBall;
    elements.autoDetect.checked = result.autoDetect;
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

// Save settings to storage
async function saveSettings() {
  const providerKey = elements.provider.value;
  const provider = PROVIDERS[providerKey];

  // Get endpoint: use provider's endpoint unless custom
  let apiEndpoint = elements.apiEndpoint.value.trim();
  if (providerKey !== 'custom' && provider) {
    apiEndpoint = provider.endpoint;
  }

  // Get model name from dropdown or custom input
  const modelName = getEffectiveModelName();

  const settings = {
    provider: providerKey,
    apiEndpoint: apiEndpoint,
    apiKey: elements.apiKey.value.trim(),
    modelName: modelName,
    targetLang: elements.targetLang.value,
    targetLangSetByUser: true, // Mark that user has explicitly set the language
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

  // Validation
  if (settings.enableSelection && settings.enableHoverTranslation
    && settings.selectionTranslationHotkey === settings.hoverTranslationHotkey) {
    showStatus(t('hotkeyConflict'), 'error');
    return;
  }

  if (!settings.apiEndpoint) {
    showStatus(t('pleaseEnterApiEndpoint'), 'error');
    if (providerKey === 'custom') {
      elements.apiEndpoint.focus();
    }
    return;
  }

  if (!settings.apiKey) {
    showStatus(t('pleaseEnterApiKey'), 'error');
    elements.apiKey.focus();
    return;
  }

  if (!settings.modelName) {
    showStatus(t('pleaseEnterModelName'), 'error');
    elements.modelName.focus();
    return;
  }

  try {
    await chrome.storage.sync.set(settings);
    showStatus(t('settingsSaved'), 'success');

    // Notify all tabs about settings change
    notifyContentScripts(settings);

    // Update UI language if target language changed
    applyI18n(settings.targetLang);
    applyPlatformHotkeyLabels();
  } catch (error) {
    console.error('Failed to save settings:', error);
    showStatus(t('connectionFailed'), 'error');
  }
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

  if (!apiEndpoint || !apiKey) {
    showStatus(t('pleaseConfigureApi'), 'warning');
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
function resetPrompt() {
  elements.customPrompt.value = t(DEFAULT_PROMPT_KEY);
  showStatus(t('resetToDefault'), 'success');
}

// Apply preset prompt
function applyPresetPrompt(presetName) {
  const presetKey = PROMPT_PRESETS[presetName];
  if (presetKey) {
    elements.customPrompt.value = t(presetKey);
    showStatus(t('presetApplied'), 'success');
  }
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

// Show status message
function showStatus(message, type) {
  elements.statusMessage.textContent = message;
  elements.statusMessage.className = `status-message ${type}`;
  
  if (type === 'success') {
    setTimeout(() => {
      elements.statusMessage.classList.add('hidden');
    }, 3000);
  }
}

// Setup event listeners
function setupEventListeners() {
  elements.saveSettings.addEventListener('click', saveSettings);
  elements.testConnection.addEventListener('click', testConnection);
  elements.resetPrompt.addEventListener('click', resetPrompt);
  elements.toggleApiKey.addEventListener('click', toggleApiKeyVisibility);
  elements.themeToggle.addEventListener('click', toggleTheme);

  // Provider change handler
  elements.provider.addEventListener('change', onProviderChange);

  // Model select change handler
  elements.modelSelect.addEventListener('change', onModelSelectChange);

  elements.enableSelection.addEventListener('change', syncInlineSettingState);
  elements.enableHoverTranslation.addEventListener('change', syncInlineSettingState);

  // YouTube caption sub-options (enable/disable + live style preview)
  elements.enableYoutubeCaptionTranslation.addEventListener('change', syncYoutubeSubState);
  elements.showYoutubeOriginalCaption.addEventListener('change', updateCaptionPreview);
  elements.youtubeCaptionFontColor.addEventListener('input', updateCaptionPreview);
  elements.youtubeCaptionBgColor.addEventListener('input', updateCaptionPreview);
  elements.youtubeCaptionBgOpacity.addEventListener('input', updateCaptionPreview);

  // Preset prompt buttons
  document.querySelectorAll('.btn-preset').forEach(btn => {
    btn.addEventListener('click', () => {
      const preset = btn.getAttribute('data-preset');
      applyPresetPrompt(preset);
    });
  });

  // Save on Ctrl+S / Cmd+S
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      saveSettings();
    }
  });
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
