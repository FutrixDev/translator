// Blab Translation 设置页入口。
//
// 这一页的设置项多到一个文件装不下，所以按「卡片」拆成了几个同级脚本
// （options-i18n / -models / -account / -pdf-tasks / -auto / -connection /
// -builtin），options.html 按顺序加载，它们和这里共用全局词法作用域。
//
// 留在这个文件里的是跨卡片的那几样：DOM 索引 elements、defaultSettings、
// 读写设置的那条通路（loadSettings / collectSettings / 自动保存 / 快捷键冲突）、
// 状态条，以及最后的事件绑定与引导。

// Default prompt template
const DEFAULT_PROMPT_KEY = 'promptStandard';
// Same value the content scripts start with — one definition, in
// shared/default-settings.js (loaded by options.html before this file).
const DEFAULT_SELECTION_HOTKEY = globalThis.DefaultSettings.DEFAULT_SELECTION_HOTKEY;

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
// DOM Elements
const elements = {
  translationEngine: document.getElementById('translationEngine'),
  engineFallback: document.getElementById('engineFallback'),
  engineFallbackGroup: document.getElementById('engineFallbackGroup'),
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
  uiLanguage: document.getElementById('uiLanguage'),
  enableSelection: document.getElementById('enableSelection'),
  selectionTranslationMode: document.getElementById('selectionTranslationMode'),
  selectionTranslationHotkey: document.getElementById('selectionTranslationHotkey'),
  enableHoverTranslation: document.getElementById('enableHoverTranslation'),
  hoverTranslationHotkey: document.getElementById('hoverTranslationHotkey'),
  showFloatBall: document.getElementById('showFloatBall'),
  skipTargetLanguageText: document.getElementById('skipTargetLanguageText'),
  showTranslationOnly: document.getElementById('showTranslationOnly'),
  // Automatic translation
  autoTranslate: document.getElementById('autoTranslate'),
  autoSubOptions: document.getElementById('autoSubOptions'),
  autoTranslateLangs: document.getElementById('autoTranslateLangs'),
  autoTranslateEngine: document.getElementById('autoTranslateEngine'),
  autoAiDailyBudget: document.getElementById('autoAiDailyBudget'),
  autoAiBudgetGroup: document.getElementById('autoAiBudgetGroup'),
  siteRules: document.getElementById('siteRules'),
  statPages: document.getElementById('statPages'),
  statCacheHit: document.getElementById('statCacheHit'),
  statChars: document.getElementById('statChars'),
  resetAutoStats: document.getElementById('resetAutoStats'),
  clearTranslationCache: document.getElementById('clearTranslationCache'),
  enableImageOcrTranslation: document.getElementById('enableImageOcrTranslation'),
  ocrEngine: document.getElementById('ocrEngine'),
  enableImageOcrHoverButton: document.getElementById('enableImageOcrHoverButton'),
  ocrSubOptions: document.getElementById('ocrSubOptions'),
  captionDisplayMode: document.getElementById('captionDisplayMode'),
  captionTranslationPosition: document.getElementById('captionTranslationPosition'),
  autoEnableCaptions: document.getElementById('autoEnableCaptions'),
  captionPlayerButton: document.getElementById('captionPlayerButton'),
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

// 「跟随浏览器」算哪门语言，唯一实现在 shared/target-lang.js。
function getBrowserLanguage() {
  return TargetLang.browserLanguage();
}


// Default settings
const defaultSettings = {
  // 默认走浏览器内置翻译（端上 NMT，零网络零费用）。下面那一整套 API 配置
  // 只在用户显式切到 'ai' 时才用得上，或者在内置引擎顶不住时充当回落。
  translationEngine: 'builtin',
  engineFallback: 'local-only',
  provider: 'openai',
  apiEndpoint: 'https://api.openai.com/v1/chat/completions',
  apiKey: '',
  modelName: 'gpt-4.1-mini',
  // 空 = 跟随浏览器语言，也**就是**「用户没选过」：下面的 collectSettings 在用户
  // 动过语言选择器之前写的一直是空串，所以非空即选过。见 shared/target-lang.js。
  targetLang: '',
  // 界面语言，与目标语言解耦：'' = 跟随浏览器。见 i18n/messages.js getUILanguage。
  uiLanguage: '',
  enableSelection: true,
  enableHoverTranslation: true,
  selectionTranslationMode: 'inline',
  selectionTranslationHotkey: DEFAULT_SELECTION_HOTKEY,
  hoverTranslationHotkey: 'Shift',
  showFloatBall: true,
  // 名字要说实话：这颗开关做的是“已经是目标语言的段落就别译了”。
  skipTargetLanguageText: true,
  // 整页翻译“仅显示译文”，默认关：默认行为保持双语对照
  showTranslationOnly: false,
  // 自动翻译。默认开，理由写在 shared/default-settings.js 的 CONTENT_DEFAULTS
  // 里——那份是内容脚本这一侧的出处，改默认值要两边一起改。siteRules 不在这里：
  // 它不经 collectSettings 那次整份写入（见下面「自动翻译」那一节）。
  autoTranslate: true,
  autoTranslateLangs: [],
  // 和 shared/default-settings.js 的 CONTENT_DEFAULTS 对齐，
  // test/unit/default-settings-agree.test.mjs 盯着这两处不许漂。
  autoTranslateEngine: 'builtin',
  autoAiDailyBudget: 200000,
  // Image OCR: on the default engine it is free and local, so on by default.
  // See the notes on defaultSettings in background/background.js.
  enableImageOcrTranslation: true,
  ocrEngine: OCRCore.DEFAULT_OCR_ENGINE,
  // The hover shortcut over large images — on by default, it is the flow's
  // front door. Matches background.js.
  enableImageOcrHoverButton: true,
  // Off by default: this is the one feature that spends money, so it is opted
  // into rather than out of. Empty comicTargetLang follows targetLang above.
  enableComicTranslation: false,
  comicTargetLang: '',
  // On by default — see the note on defaultSettings in background/background.js.
  // Empty pdfTargetLang follows targetLang.
  enablePdfTranslation: true,
  pdfTargetLang: '',
  // Kept in the read set, not on the page any more: it is what a profile from
  // before the display-type select migrates from (CaptionCore does the sum).
  // captionDisplayMode stays '' (unset) here for the same reason as in
  // content/content-bootstrap.js: a mode in the defaults would answer
  // resolveCaptionDisplay() before it could read the boolean, and the select
  // would show bilingual to a user who had turned the original line off.
  showYoutubeOriginalCaption: true,
  captionDisplayMode: '',
  captionTranslationPosition: 'below',
  captionPlayerButton: true,
  // 本轮自动化里唯一一件**改动播放器自己状态**的事，所以它单独一个开关，而且默认
  // 关着：关着的时候，字幕这一面和从前一模一样。
  autoEnableCaptions: false,
  youtubeCaptionFontColor: '#ffffff',
  youtubeCaptionBgColor: '#080808',
  youtubeCaptionBgOpacity: 82,
  customPrompt: '',
  theme: 'light'
};
// Load settings from storage
async function loadSettings() {
  try {
    const result = await chrome.storage.sync.get(defaultSettings);

    // 选择器里要显示一门具体语言（它没有「自动」这一项），所以没选过就把浏览器
    // 语言填进去显示；存回去的仍是空串，见 collectSettings。
    targetLangChosen = !!result.targetLang;
    const targetLang = TargetLang.effective(result);

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
    elements.engineFallback.value = result.engineFallback === 'allow-ai' ? 'allow-ai' : 'local-only';
    elements.targetLang.value = targetLang;
    elements.enableSelection.checked = result.enableSelection;
    elements.selectionTranslationMode.value = result.selectionTranslationMode || 'inline';
    elements.selectionTranslationHotkey.value = result.selectionTranslationHotkey || DEFAULT_SELECTION_HOTKEY;
    elements.enableHoverTranslation.checked = result.enableHoverTranslation;
    elements.hoverTranslationHotkey.value = result.hoverTranslationHotkey || 'Shift';
    elements.showFloatBall.checked = result.showFloatBall;
    elements.skipTargetLanguageText.checked = result.skipTargetLanguageText;
    elements.showTranslationOnly.checked = !!result.showTranslationOnly;
    // 默认开，所以只有存着的 false 才关得掉它。
    elements.autoTranslate.checked = result.autoTranslate !== false;
    showAutoTranslateLangs(result.autoTranslateLangs);
    elements.autoTranslateEngine.value = result.autoTranslateEngine === 'ai' ? 'ai' : 'builtin';
    elements.autoAiDailyBudget.value = String(
      Number.isFinite(result.autoAiDailyBudget) && result.autoAiDailyBudget > 0
        ? Math.floor(result.autoAiDailyBudget)
        : 0
    );
    syncAutoSubState();
    syncAutoEngineState();
    elements.enableImageOcrTranslation.checked = result.enableImageOcrTranslation !== false;
    elements.ocrEngine.value = result.ocrEngine === 'vision' ? 'vision' : OCRCore.DEFAULT_OCR_ENGINE;
    // Default-on, so only a stored false turns it off.
    elements.enableImageOcrHoverButton.checked = result.enableImageOcrHoverButton !== false;
    syncOcrSubState();
    // The switches themselves are drawn by renderAccountFeatures, which also
    // weighs whether this device has the account both features need.
    storedComicEnabled = !!result.enableComicTranslation;
    storedPdfEnabled = !!result.enablePdfTranslation;
    elements.comicTargetLang.value = result.comicTargetLang || '';
    elements.pdfTargetLang.value = result.pdfTargetLang || '';
    renderAccountFeatures();
    const captionDisplay = CaptionCore.resolveCaptionDisplay(result);
    elements.captionDisplayMode.value = captionDisplay.mode;
    elements.captionTranslationPosition.value = result.captionTranslationPosition === 'above' ? 'above' : 'below';
    elements.autoEnableCaptions.checked = !!result.autoEnableCaptions;
    elements.captionPlayerButton.checked = result.captionPlayerButton !== false;
    elements.youtubeCaptionFontColor.value = result.youtubeCaptionFontColor || '#ffffff';
    elements.youtubeCaptionBgColor.value = result.youtubeCaptionBgColor || '#080808';
    elements.youtubeCaptionBgOpacity.value = result.youtubeCaptionBgOpacity != null ? result.youtubeCaptionBgOpacity : 82;
    updateCaptionPreview();
    syncYoutubeSubState();
    elements.customPrompt.value = result.customPrompt || '';

    // Apply theme
    applyTheme(result.theme || 'light');

    // Apply i18n based on target language
    elements.uiLanguage.value = result.uiLanguage || '';
    applyI18n(result.uiLanguage);
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
//  - 语言只有在用户真的动过那颗选择器之后才写下去。选择器上显示的可能只是
//    浏览器语言的回显，把它当成用户的选择写进 storage，就等于在一次无关的
//    开关切换里，把语言永久钉死在浏览器当时碰巧是什么上。
// ---------------------------------------------------------------------------

const AUTOSAVE_DEBOUNCE_MS = 500;
let autosaveTimer = null;
// 用户这一次开着设置页期间，动过语言选择器没有。跨次打开靠 targetLang 非空还原
// （loadSettings），不另存一个布尔量——两个来源就是两个会吵架的答案。
let targetLangChosen = false;

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
    engineFallback: elements.engineFallback.value,
    provider: providerKey,
    apiEndpoint: apiEndpoint,
    apiKey: elements.apiKey.value.trim(),
    modelName: modelName,
    // 没选过就存空串：空是「跟随浏览器」的哨兵，选择器上那个值只是回显。
    targetLang: targetLangChosen ? elements.targetLang.value : '',
    uiLanguage: elements.uiLanguage.value,
    enableSelection: elements.enableSelection.checked,
    enableHoverTranslation: elements.enableHoverTranslation.checked,
    selectionTranslationMode: elements.selectionTranslationMode.value,
    selectionTranslationHotkey: elements.selectionTranslationHotkey.value,
    hoverTranslationHotkey: elements.hoverTranslationHotkey.value,
    showFloatBall: elements.showFloatBall.checked,
    skipTargetLanguageText: elements.skipTargetLanguageText.checked,
    showTranslationOnly: elements.showTranslationOnly.checked,
    autoTranslate: elements.autoTranslate.checked,
    autoTranslateLangs: collectAutoTranslateLangs(),
    autoTranslateEngine: elements.autoTranslateEngine.value === 'ai' ? 'ai' : 'builtin',
    // 空着、负数、写了字母，都是「不限」——和 AutoStats.budgetExceeded 同一个约定。
    autoAiDailyBudget: Math.max(0, Math.floor(Number(elements.autoAiDailyBudget.value) || 0)),
    enableImageOcrTranslation: elements.enableImageOcrTranslation.checked,
    ocrEngine: elements.ocrEngine.value,
    enableImageOcrHoverButton: elements.enableImageOcrHoverButton.checked,
    captionDisplayMode: elements.captionDisplayMode.value,
    captionTranslationPosition: elements.captionTranslationPosition.value,
    autoEnableCaptions: elements.autoEnableCaptions.checked,
    captionPlayerButton: elements.captionPlayerButton.checked,
    // Written alongside the new key so a profile that syncs back to an older
    // build still shows or hides the original line the way it was left here.
    showYoutubeOriginalCaption: elements.captionDisplayMode.value !== 'translation',
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
      applyI18n(settings.uiLanguage);
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

/**
 * Tell the open tabs a language pack just landed.
 *
 * A tab that opened before the pack existed is most likely parked on ERROR: the
 * automatic round runs without a user gesture, so it passes
 * `allowDownload: false` and every batch comes back `builtinNeedsDownload`. The
 * scheduler does not retry on its own — deliberately, because retrying against
 * an engine that is plainly broken is how you burn a user's quota — so without
 * this message those pages stay blank until a reload.
 *
 * The content script has the same notification for the pack it downloads
 * itself (`ctx.onLanguagePackReady`, content/content-language-pack.js); this is
 * the half that cannot reach it, because the download that just finished ran in
 * this page's context, not theirs. The receiving end ignores it unless that tab
 * is actually on the built-in engine.
 */
async function broadcastLanguagePackReady(targetLang) {
  try {
    const tabs = await chrome.tabs.query({});
    tabs.forEach(tab => {
      chrome.tabs.sendMessage(tab.id, {
        type: 'LANGUAGE_PACK_READY',
        sourceLang: BUILTIN_PROBE_SOURCE,
        targetLang
      }).catch(() => {});
    });
  } catch (error) {
    // A tab with no content script rejects; nothing here is worth reporting.
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
  'engineFallback',
  'enableSelection',
  'selectionTranslationMode',
  'selectionTranslationHotkey',
  'enableHoverTranslation',
  'hoverTranslationHotkey',
  'showFloatBall',
  'skipTargetLanguageText',
  'showTranslationOnly',
  'autoTranslate',
  'enableImageOcrTranslation',
  'ocrEngine',
  'enableImageOcrHoverButton',
  'captionDisplayMode',
  'captionTranslationPosition',
  'autoEnableCaptions',
  'captionPlayerButton'
];

// Controls that fire on every keystroke or drag frame: debounce, and flush on
// blur so leaving a field always commits it.
const DEBOUNCED_SAVE_FIELDS = [
  'autoAiDailyBudget',
  'apiEndpoint',
  'apiKey',
  'modelName',
  'customPrompt',
  'youtubeCaptionFontColor',
  'youtubeCaptionBgColor',
  'youtubeCaptionBgOpacity'
];
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

  elements.targetLang.addEventListener('change', () => {
    targetLangChosen = true;
    // 换目标语言等于换了语言对，内置引擎的状态得重查。界面语言不再跟着它走，
    // 所以这里不重跑 i18n——只有下面那颗选择器才会。
    persistSettings().then(refreshBuiltinStatus);
  });

  // The one field whose value changes what this page is written in, so it is
  // also the one that re-runs i18n.
  elements.uiLanguage.addEventListener('change', () => {
    persistSettings({ reapplyI18n: true });
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

  // 同样的道理，同样的原因，另外两块：站点审计表和本机统计都是**别处**写的。
  // 用户在另一个标签页的弹出窗口里按下「总是翻译」，或者随便翻了几页，这个开着
  // 的设置页不会自己知道；而 openOptionsPage() 是把它调到前面来，不是重新加载。
  // 于是他回到这里，看见的是一张缺了刚做的那个决定的表 —— 想把手滑按错的那一下
  // 撤回来，偏偏就差那一行。
  //
  // 这里盯 storage 而不是盯 visibilitychange：两块数据本来就住在 storage 里，
  // 盯它不要一次网络往返，而且两个窗口并排摆着的时候也跟得上。
  // 这个页面自己的写入也会回弹到这里（删规则、清统计），于是多重画一次；两个
  // 函数都是整块重读重画的，重画一次和重画两次结果一样。
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.siteRules) renderSiteRules();
    if (area === 'local' && changes.autoStats) renderAutoStats();
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

  // 总开关自己进了 IMMEDIATE_SAVE_FIELDS，这里只管把下面那块变灰。语言勾没有
  // 单独的 id，逐个挂：它们写的是同一个 autoTranslateLangs，一次点击一次写。
  elements.autoTranslate.addEventListener('change', syncAutoSubState);
  // 字幕那张卡也跟着这一个开关灰：字幕翻不翻由主开关加站点规则说了算。
  elements.autoTranslate.addEventListener('change', syncYoutubeSubState);
  autoLangChips().forEach(box => box.addEventListener('change', () => persistSettings()));
  // 这一颗有意不进 IMMEDIATE_SAVE_FIELDS：那条路线是「变了就存」，而这里可能
  // 要把值退回去（用户在二次确认里说了不）。
  elements.autoTranslateEngine.addEventListener('change', onAutoEngineChange);
  elements.resetAutoStats.addEventListener('click', resetAutoStats);
  elements.clearTranslationCache.addEventListener('click', clearTranslationCache);

  elements.captionDisplayMode.addEventListener('change', updateCaptionPreview);
  elements.captionTranslationPosition.addEventListener('change', updateCaptionPreview);
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

// 字幕的选项跟着主开关灰掉。字幕自己没有开关了：翻不翻由主开关加站点规则说了
// 算（content/content-video-captions.js 的 siteRefused），总开关关着的时候，底
// 下这些「字幕怎么画」的选项一个也轮不到。
function syncYoutubeSubState() {
  if (!elements.youtubeSubOptions) return;
  elements.youtubeSubOptions.classList.toggle('disabled', !elements.autoTranslate.checked);
}

// Same, for image OCR. There is deliberately no language picker to sync:
// recognition always runs the auto plan (see resolveOcrLanguagePlan), because
// nobody can pre-declare what language tomorrow's images will be in.
function syncOcrSubState() {
  if (!elements.ocrSubOptions) return;
  elements.ocrSubOptions.classList.toggle('disabled', !elements.enableImageOcrTranslation.checked);
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
  // The preview answers "what will I see", so it runs the same resolver the
  // player does rather than reading the two controls its own way.
  const display = CaptionCore.resolveCaptionDisplay({
    captionDisplayMode: elements.captionDisplayMode.value,
    captionTranslationPosition: elements.captionTranslationPosition.value,
  });
  const original = preview.querySelector('.caption-preview-original');
  const translated = preview.querySelector('.caption-preview-translated');
  if (original) {
    original.style.display = display.showOriginal ? '' : 'none';
    original.style.order = display.translationFirst ? '2' : '1';
  }
  if (translated) {
    translated.style.display = display.showTranslation ? '' : 'none';
    translated.style.order = display.translationFirst ? '1' : '2';
  }
  // Position only means something with two lines on screen.
  elements.captionTranslationPosition.disabled = display.mode !== 'bilingual';
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
