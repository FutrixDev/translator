// Blab Translation 设置页 —— 连接测试与提示词
//
// options.html 按顺序加载的普通脚本，和 options.js 共用同一个全局词法作用域：
// 这里声明的函数在 options.js 里直接叫名字就能用，反过来也一样（调用发生在
// DOMContentLoaded 之后，声明早就求值完了）。
//
// 测试按钮发的请求和翻译真正会发的请求出自同一个 shared/api-compat.js 构造器 ——
// 测通了就是真通了。

// Endpoint/model shape helpers live in shared/api-compat.js — the same
// module the service worker uses, so the connection test below proves the
// exact request translation will make.

// The connection the form describes: a preset's own endpoint unless the preset
// is "custom", whatever the hidden endpoint box still holds. Saving and the
// connection test both read it here, so they cannot judge two different URLs.
function formConnection() {
  const provider = elements.provider.value;
  const preset = PROVIDERS[provider];
  const apiEndpoint = provider !== 'custom' && preset
    ? preset.endpoint
    : elements.apiEndpoint.value.trim();
  return { provider, apiEndpoint, apiKey: elements.apiKey.value.trim() };
}

// The key box says "optional" where no key is needed: a local model server
// (the Ollama / LM Studio presets, or a loopback / LAN endpoint). The rule is
// APICompat.requiresApiKey, the same one translation is refused by. Writing the
// data attribute too keeps the right text when the UI language is re-applied.
function syncApiKeyPlaceholder() {
  const key = globalThis.APICompat.requiresApiKey(formConnection())
    ? 'placeholderApiKey'
    : 'placeholderApiKeyOptional';
  elements.apiKey.setAttribute('data-i18n-placeholder', key);
  elements.apiKey.setAttribute('placeholder', t(key));
}

// Test API connection
async function testConnection() {
  const connection = formConnection();
  const { provider: providerKey, apiEndpoint, apiKey } = connection;
  const modelName = getEffectiveModelName();

  // This button is now the only thing on the page that judges the API config,
  // so it says which field is missing instead of a blanket "configure the API".
  if (!apiEndpoint) {
    showStatus(t('pleaseEnterApiEndpoint'), 'warning');
    if (providerKey === 'custom') elements.apiEndpoint.focus();
    return;
  }
  // A local model server needs no key; everything else still does.
  if (globalThis.APICompat.isApiKeyMissing(connection)) {
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
    if (result.failure) {
      showConnectionFailure({ ...result.failure, endpoint: apiEndpoint }, providerKey);
    } else {
      showStatus(t('connectionSuccess'), 'success');
    }
  } catch (_) {
    // fetch rejects only when no answer came back at all (server down, DNS).
    showConnectionFailure({ network: true, endpoint: apiEndpoint }, providerKey);
  }
}

// Same wording the service worker gives a failed translation, in this page's
// language, through the one describer in shared/api-compat.js.
function showConnectionFailure(failure, provider) {
  const text = globalThis.APICompat.describeAPIFailure(failure, t, { provider });
  showStatus(`${t('connectionFailed')}: ${text}`, 'error');
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
