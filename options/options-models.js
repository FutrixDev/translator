// Blab Translation 设置页 —— 服务商与模型选择
//
// options.html 按顺序加载的普通脚本，和 options.js 共用同一个全局词法作用域：
// 这里声明的函数在 options.js 里直接叫名字就能用，反过来也一样（调用发生在
// DOMContentLoaded 之后，声明早就求值完了）。
//
// 服务商目录和每一代模型的参数规则都在 shared/api-compat.js，这里只管把它画成
// 两个控件。

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
