// Blab Translation 设置页 —— AI 配置卡（P1-D 批次 D1）
//
// options.html 按顺序加载的普通脚本，和 options.js 共用同一个全局词法作用域。
//
// 这张卡编辑的是默认配置档（设计 §1 表 D1 行）：服务商、接口地址、Key、模型，
// 加上每分钟请求数、并发数、超时三格。它不再写 sync 里的四个旧键 —— 那四个键只在
// SW 的迁移里出现一次（background/ai-profiles-host.js）。
//
// 读：先问 SW 一次 AI_PROFILES_PUBLIC（这一问会触发迁移），再自己 get(null) 读整档
// （含 Key，这一页本来就能读 sync）。写：AIProfiles.request('put')，走 SW 的单写队列。
// 打开页面不写任何东西，所以从没配置过的人仍然是「没有配置档」。

// 三格限速/超时的输入框。options.html 的卡片标记不动，这三格在这里造出来，
// 插在「测试连接」那一行前面。
const AI_PROFILE_LIMIT_FIELDS = Object.freeze([
  { id: 'aiProfileRpm', field: 'rpm', label: 'aiProfileRpm', hint: 'hintAiProfileZeroUnlimited', min: 0, max: () => AIProfiles.LIMITS.rpm },
  { id: 'aiProfileConcurrency', field: 'concurrency', label: 'aiProfileConcurrency', hint: 'hintAiProfileZeroUnlimited', min: 0, max: () => AIProfiles.LIMITS.concurrency },
  { id: 'aiProfileTimeout', field: 'timeoutSec', label: 'aiProfileTimeout', hint: 'hintAiProfileTimeout', min: () => AIProfiles.LIMITS.timeoutMin, max: () => AIProfiles.LIMITS.timeoutMax },
]);

// 空着的格子取的值：限速和并发 0 是「不限」，超时是缺省的 120 秒。
const AI_PROFILE_BLANK = Object.freeze({ rpm: 0, concurrency: 0, timeoutSec: AIProfiles.DRAFT.timeoutSec });

// 表单里这些格子是「一次交互一个值」还是「每敲一下都变」：前者立刻存，后者防抖。
const AI_PROFILE_TYPED_FIELDS = ['apiEndpoint', 'apiKey', 'modelName'];

let aiProfileSaveTimer = null;
// 存盘排成一队：第一次存会新建默认档（新 id），紧跟着的第二次必须读到它，
// 否则会建出第二个档。
let aiProfileSaveQueue = Promise.resolve();

function valueOf(spec) {
  return typeof spec === 'function' ? spec() : spec;
}

function buildAiProfileLimitInputs() {
  const card = document.getElementById('apiSettingsCard');
  const actions = card.querySelector('.form-actions');
  AI_PROFILE_LIMIT_FIELDS.forEach((spec) => {
    const group = document.createElement('div');
    group.className = 'form-group';
    const label = document.createElement('label');
    label.htmlFor = spec.id;
    label.dataset.i18n = spec.label;
    label.textContent = t(spec.label);
    const input = document.createElement('input');
    input.type = 'number';
    input.id = spec.id;
    input.min = String(valueOf(spec.min));
    input.max = String(valueOf(spec.max));
    input.step = '1';
    const hint = document.createElement('span');
    hint.className = 'hint';
    hint.dataset.i18nHint = spec.hint;
    hint.textContent = t(spec.hint);
    group.append(label, input, hint);
    card.insertBefore(group, actions);
    elements[spec.id] = input;
  });
}

/** 这一页上的全部配置档（含 Key）。 */
async function readAiProfiles() {
  return AIProfiles.collection.collect(await chrome.storage.sync.get(null));
}

/** 表单现在说的默认档字段。空着的限速格取 AI_PROFILE_BLANK。 */
function aiProfileFormPatch() {
  const patch = Object.assign({}, formConnection(), { modelName: getEffectiveModelName() });
  AI_PROFILE_LIMIT_FIELDS.forEach((spec) => {
    const raw = elements[spec.id].value.trim();
    patch[spec.field] = raw === '' ? AI_PROFILE_BLANK[spec.field] : Number(raw);
  });
  return patch;
}

/** 表单描述的整档：盖在当前默认档上（没有就盖在 DRAFT 上）。测试连接也用它。 */
async function aiProfileDraft() {
  return AIProfiles.editDefault(await readAiProfiles(), aiProfileFormPatch());
}

async function loadAiProfileForm() {
  // 先问 SW：这一问会在需要时把旧四键迁成 aiProfile:legacy，之后再读存储。
  const reply = await chrome.runtime.sendMessage({ type: 'AI_PROFILES_PUBLIC' });
  if (!reply || reply.error) throw new Error(`AI_PROFILES_PUBLIC failed: ${reply && reply.error}`);
  const current = AIProfiles.defaultOf(await readAiProfiles());
  const profile = current || AIProfiles.DRAFT;

  elements.provider.value = profile.provider;
  elements.apiEndpoint.value = profile.apiEndpoint;
  elements.customEndpointGroup.style.display = profile.provider === 'custom' ? 'block' : 'none';
  updateModelDropdown(profile.provider, profile.modelName);
  elements.apiKey.value = profile.apiKey;
  syncApiKeyPlaceholder();
  AI_PROFILE_LIMIT_FIELDS.forEach((spec) => {
    const value = profile[spec.field];
    elements[spec.id].value = value === undefined ? String(AI_PROFILE_BLANK[spec.field]) : String(value);
  });

  // 引导页选了一个还存不下的服务商（LM Studio 没有默认模型）时，把它带在
  // ?provider= 上：像用户在下拉里换了服务商一样摆好表单，但不存 —— 填了模型才存。
  const asked = new URLSearchParams(location.search).get('provider');
  if (asked && Object.prototype.hasOwnProperty.call(PROVIDERS, asked) && asked !== profile.provider) {
    elements.provider.value = asked;
    onProviderChange();
  }
}

// 表单还没填完（自定义服务商没填地址、没填模型）不是错，只是还不能存；测试连接
// 那颗按钮会点名缺哪一格。填了但不合规（地址不是 http(s)、数字越界）才报错。
function aiProfileIncomplete(profile) {
  return !String(profile.apiEndpoint || '').trim() || !String(profile.modelName || '').trim();
}

async function saveAiProfile() {
  const profile = await aiProfileDraft();
  const invalid = AIProfiles.validate(profile);
  if (invalid) {
    if (aiProfileIncomplete(profile)) return;
    throw new Error(invalid);
  }
  await AIProfiles.request('put', { profile });
}

function persistAiProfile() {
  clearTimeout(aiProfileSaveTimer);
  aiProfileSaveTimer = null;
  aiProfileSaveQueue = aiProfileSaveQueue.then(saveAiProfile).catch((error) => {
    // 这一层接住错误（界面上说一句），所以在这一层记日志；不带配置档内容。
    console.error('AI profile save failed:', error);
    showStatus(t(AIProfiles.userErrorKey(error) || 'aiProfileSaveFailed'), 'error');
  });
  return aiProfileSaveQueue;
}

function scheduleAiProfileSave() {
  clearTimeout(aiProfileSaveTimer);
  aiProfileSaveTimer = setTimeout(persistAiProfile, AUTOSAVE_DEBOUNCE_MS);
}

function flushAiProfileSave() {
  if (aiProfileSaveTimer) persistAiProfile();
}

function setupAiProfileForm() {
  buildAiProfileLimitInputs();

  // 换服务商会改写地址和模型列表，所以先改表单、再存。
  elements.provider.addEventListener('change', () => {
    onProviderChange();
    persistAiProfile();
  });
  // 也是先后有序：从下拉里挑会清掉自定义模型那一格，而 getEffectiveModelName
  // 优先认那一格 —— 先存就会存下刚被换掉的名字。
  elements.modelSelect.addEventListener('change', () => {
    onModelSelectChange();
    persistAiProfile();
  });
  elements.modelName.addEventListener('input', onCustomModelInput);
  // 本机 / 局域网地址不要 Key，边敲边说。
  elements.apiEndpoint.addEventListener('input', syncApiKeyPlaceholder);

  AI_PROFILE_TYPED_FIELDS.concat(AI_PROFILE_LIMIT_FIELDS.map((spec) => spec.id)).forEach((name) => {
    elements[name].addEventListener('input', scheduleAiProfileSave);
    elements[name].addEventListener('blur', flushAiProfileSave);
  });
  // 关掉标签页或切走，不能吞掉敲了一半的 Key。
  window.addEventListener('beforeunload', flushAiProfileSave);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushAiProfileSave();
  });
}
