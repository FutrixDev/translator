// Blab Translation 首装引导页
//
// 只在第一次安装时由 background/install.js 打开。四块：端上翻译的语言包、
// 目标语言、翻译引擎、快捷键。每一项改动即写即存（sync.set 之后广播给已经
// 开着的标签页），所以没有「保存」按钮。
//
// 判定和下载与设置页共用 shared/language-pack.js，广播共用
// shared/tab-broadcast.js；AI 的连接表单不在这里抄一份，选了 AI 就送到设置页的
// API 卡片（options.html#apiSettingsCard）。
(function () {
  'use strict';

  const SETTINGS_URL = 'options/options.html#apiSettingsCard';

  // 命令名 → 已有的文案键。认不出的命令退回 Chrome 给的 description。
  const COMMAND_LABELS = {
    'toggle-translate-page': 'translatePage',
    'toggle-translation-only': 'showTranslationOnly',
    'translate-whole-page': 'floatMenuTranslateWholePage',
  };

  const AI_BUTTONS = {
    aiOllama: 'ollama',
    aiLmStudio: 'lmstudio',
    aiCloud: null, // 云端：provider 让用户到设置页去挑
  };

  const elements = {
    error: document.getElementById('onboardingError'),
    builtinStatus: document.getElementById('builtinStatus'),
    download: document.getElementById('downloadLanguagePack'),
    targetLang: document.getElementById('targetLang'),
    engineBuiltin: document.getElementById('engineBuiltin'),
    engineAi: document.getElementById('engineAi'),
    aiProviders: document.getElementById('aiProviders'),
    shortcutList: document.getElementById('shortcutList'),
    openSettings: document.getElementById('openSettings'),
    done: document.getElementById('done'),
  };

  let uiLang = 'en';
  const t = (key) => getMessage(key, uiLang);

  // 页面上正在用的那几个值；每次成功写入后跟着更新。
  const current = { targetLang: '', engineFallback: 'local-only' };

  function fill(template, values) {
    return Object.entries(values).reduce((text, [name, value]) => text.split(`{${name}}`).join(String(value)), template);
  }

  function applyI18n() {
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      el.textContent = t(el.getAttribute('data-i18n'));
    });
    document.title = t('onboardingPageTitle');
    document.documentElement.lang = uiLang;
  }

  function showError(error) {
    elements.error.textContent = fill(t('onboardingSaveFailed'), { message: error && error.message });
    elements.error.hidden = false;
  }

  function clearError() {
    elements.error.hidden = true;
    elements.error.textContent = '';
  }

  /**
   * 写 sync，再告诉所有标签页。只广播改动的键：内容脚本做的是
   * Object.assign(settings, message.settings)。失败向上抛，由点击处接住。
   */
  async function save(patch) {
    await chrome.storage.sync.set(patch);
    Object.assign(current, patch);
    TabBroadcast.settingsUpdated(patch);
  }

  // 点击处统一接住：打一次日志，页面上说清楚，不吞。
  function guarded(operation, action) {
    return (event) => {
      clearError();
      Promise.resolve(action(event)).catch((error) => {
        console.error(`Blab Translation onboarding: ${operation} failed`, error);
        showError(error);
      });
    };
  }

  // ---------------------------------------------------------------------------
  // 1. 端上翻译
  // ---------------------------------------------------------------------------

  let statusSeq = 0;

  function builtinEngine() {
    return window.AI_TRANSLATOR_CONTENT && window.AI_TRANSLATOR_CONTENT.builtinTranslator;
  }

  function showStatus(result) {
    elements.builtinStatus.textContent = LanguagePack.message(result, t, uiLang);
    elements.download.hidden = !result.downloadable;
  }

  async function refreshBuiltinStatus() {
    const seq = ++statusSeq;
    const engine = builtinEngine();
    const known = LanguagePack.describe(engine, current);
    if (known) {
      showStatus(known);
      return;
    }
    elements.download.hidden = true;
    elements.builtinStatus.textContent = t('builtinChecking');
    let result;
    try {
      result = await LanguagePack.probe(engine, current.targetLang);
    } catch (error) {
      console.error('Blab Translation onboarding: language pack probe failed', error);
      result = { key: 'builtinUnavailable', downloadable: false };
    }
    if (seq === statusSeq) showStatus(result);
  }

  // 必须在这次点击里直接调用：create() 要的 user activation 由这次点击产生。
  async function downloadLanguagePack() {
    const seq = ++statusSeq;
    elements.download.disabled = true;
    elements.builtinStatus.textContent = t('builtinDownloading');
    try {
      await LanguagePack.download(builtinEngine(), current.targetLang, (percent) => {
        if (seq === statusSeq) elements.builtinStatus.textContent = `${t('builtinDownloading')} ${percent}%`;
      });
    } catch (error) {
      console.error('Blab Translation onboarding: language pack download failed', error);
      if (seq === statusSeq) elements.builtinStatus.textContent = t('builtinDownloadFailed');
      return;
    } finally {
      elements.download.disabled = false;
    }
    if (seq === statusSeq) await refreshBuiltinStatus();
  }

  // ---------------------------------------------------------------------------
  // 2. 目标语言
  // ---------------------------------------------------------------------------

  function renderTargetOptions() {
    elements.targetLang.replaceChildren(...TargetLang.options(uiLang).map(({ value, label }) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      return option;
    }));
    elements.targetLang.value = current.targetLang;
  }

  async function changeTargetLang() {
    // 写的是具体的码：用户在这里明确选过了，就不再跟随浏览器。
    await save({ targetLang: elements.targetLang.value });
    await refreshBuiltinStatus();
  }

  // ---------------------------------------------------------------------------
  // 3. 翻译引擎
  // ---------------------------------------------------------------------------

  function showEngine(engine) {
    elements.engineBuiltin.checked = engine !== 'ai';
    elements.engineAi.checked = engine === 'ai';
    elements.aiProviders.hidden = engine !== 'ai';
  }

  async function chooseBuiltin() {
    showEngine('builtin');
    await save({ translationEngine: 'builtin' });
  }

  // 只是展开三个按钮；真正写 AI 要等用户选了在哪里跑。
  function chooseAi() {
    showEngine('ai');
  }

  function aiPatch(providerKey) {
    const patch = { translationEngine: 'ai' };
    if (!providerKey) return patch;
    const provider = APICompat.PROVIDERS[providerKey];
    // 和设置页换 provider 时一样：接口地址和默认模型跟着换（LM Studio 没有默认
    // 模型，写空串，设置页会让用户填）。
    return Object.assign(patch, {
      provider: providerKey,
      apiEndpoint: provider.endpoint,
      modelName: provider.defaultModel || '',
    });
  }

  async function chooseAiProvider(providerKey) {
    await save(aiPatch(providerKey));
    await chrome.tabs.create({ url: chrome.runtime.getURL(SETTINGS_URL) });
  }

  // ---------------------------------------------------------------------------
  // 4. 快捷键
  // ---------------------------------------------------------------------------

  async function renderShortcuts() {
    const commands = await chrome.commands.getAll();
    elements.shortcutList.replaceChildren(...commands
      .filter((command) => command.name && !command.name.startsWith('_'))
      .map((command) => {
        const item = document.createElement('li');
        item.className = 'shortcut';
        const label = document.createElement('span');
        label.className = 'shortcut-label';
        label.textContent = COMMAND_LABELS[command.name] ? t(COMMAND_LABELS[command.name]) : command.description;
        const keys = document.createElement(command.shortcut ? 'kbd' : 'span');
        keys.className = command.shortcut ? 'shortcut-keys' : 'shortcut-keys shortcut-unset';
        keys.textContent = command.shortcut || t('onboardingShortcutNotSet');
        item.append(label, keys);
        return item;
      }));
  }

  // ---------------------------------------------------------------------------
  // 启动
  // ---------------------------------------------------------------------------

  async function init() {
    const settings = await chrome.storage.sync.get({
      uiLanguage: '',
      theme: 'light',
      targetLang: '',
      translationEngine: 'builtin',
      engineFallback: 'local-only',
    });
    document.documentElement.setAttribute('data-theme', settings.theme || 'light');
    uiLang = getUILanguage(settings.uiLanguage);
    applyI18n();

    current.targetLang = TargetLang.effective(settings);
    current.engineFallback = settings.engineFallback;
    renderTargetOptions();
    showEngine(settings.translationEngine);

    elements.download.addEventListener('click', () => { downloadLanguagePack(); });
    elements.targetLang.addEventListener('change', guarded('save target language', changeTargetLang));
    elements.engineBuiltin.addEventListener('change', guarded('save engine', chooseBuiltin));
    elements.engineAi.addEventListener('change', chooseAi);
    for (const [id, providerKey] of Object.entries(AI_BUTTONS)) {
      document.getElementById(id).addEventListener('click', guarded('choose AI provider', () => chooseAiProvider(providerKey)));
    }
    elements.openSettings.addEventListener('click', guarded('open settings', () => chrome.runtime.openOptionsPage()));
    elements.done.addEventListener('click', () => window.close());

    await Promise.all([refreshBuiltinStatus(), renderShortcuts()]);
    document.documentElement.dataset.ready = 'true';
  }

  document.addEventListener('DOMContentLoaded', () => {
    init().catch((error) => {
      console.error('Blab Translation onboarding: init failed', error);
      showError(error);
    });
  });
})();
