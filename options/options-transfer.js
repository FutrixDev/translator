// Blab Translation 设置页 —— 导入 / 导出设置
//
// options.html 按顺序加载的普通脚本，和 options.js 共用同一个全局词法作用域：
// defaultSettings、collectSettings、hasHotkeyConflict、loadSettings、showStatus、
// unattendedAiReachable、t、currentUILang 都直接叫名字（调用都发生在点击之后）。
//
// 文件格式、键级校验和「先全校验、再按序写、第一个失败就停」的编排在
// shared/settings-transfer.js（纯函数，node 里测）；这里只有这一页的 section 表
// 和控件。

// ---------------------------------------------------------------------------
// section 表。顺序就是写入顺序。
//
// 每一行：
//   key                  文件里的顶层键
//   collect({includeApiKey})  → 这一块的值（导出）
//   validate(raw)        → { value, accepted, dropped: string[] }；整块不对就抛 TransferError
//   preview(result)      → { lines: string[], warnings: string[] }（预览区的条目和警示）
//   apply(value)         写进去；失败就抛
//
// 值不一定是对象，预览也不假设它是 —— 每一行自己画自己。
//
// 后面会加的两行（本批不实现）：
//   - P1-B `customRules`：值是 CustomRules.toExportFile() 给的对象，写入走
//     CustomRules.request('import', { file })；
//   - P1-C `glossary`：值是一段 CSV 字符串。
// ---------------------------------------------------------------------------

function transferSchema() {
  return SettingsTransfer.settingsSchema(DefaultSettings.contentDefaults(), defaultSettings);
}

function transferEnums() {
  return SettingsTransfer.buildEnums({
    providers: Object.keys(APICompat.PROVIDERS),
    uiLanguages: UI_LANGUAGES,
    targetLangs: TargetLang.SUPPORTED,
    cloudTargets: TargetLang.CLOUD_TARGETS,
    styles: TranslationDisplay.STYLES,
  });
}

function fill(template, values) {
  return Object.entries(values).reduce((text, [name, value]) => text.split(`{${name}}`).join(String(value)), template);
}

const settingsSection = {
  key: 'settings',

  async collect({ includeApiKey }) {
    const schema = transferSchema();
    const stored = await chrome.storage.sync.get(schema);
    return SettingsTransfer.pickExport(stored, schema, { includeApiKey });
  },

  validate(raw) {
    const result = SettingsTransfer.validateSettings(raw, transferSchema(), transferEnums());
    // 两颗热键撞在一起的那一对永远不落地（options.js 的 Hotkey conflicts 一节）。
    // 导入也不例外，而且不替用户挑一颗改掉：整份拒绝，说清楚为什么。
    if (hasHotkeyConflict(Object.assign(collectSettings(), result.value))) {
      throw new SettingsTransfer.TransferError('hotkeyConflict');
    }
    return result;
  },

  async preview({ value, dropped }) {
    const stored = await chrome.storage.sync.get(transferSchema());
    const changed = SettingsTransfer.changedKeys(stored, value);
    const lines = [fill(t('transferPreviewSettings'), { changed: changed.length, dropped: dropped.length })];
    if (changed.length) lines.push(fill(t('transferPreviewChangedKeys'), { keys: changed.join(', ') }));
    if (dropped.length) lines.push(fill(t('transferPreviewDroppedKeys'), { keys: dropped.join(', ') }));

    const warnings = [];
    // 导入会打开一条原本关着的「没人点也会花到 AI」的路：说的是和设置页切到 AI
    // 时同一句话。点「确认导入」就算答应了，不再另弹一次确认。
    const current = collectSettings();
    if (!unattendedAiReachable(current) && unattendedAiReachable(Object.assign({}, current, value))) {
      warnings.push(t('autoTranslateEngineAiConfirm'));
    }
    // 换了接口地址、文件里却没带 Key：已经存着的那把 Key 会发到新地址去。
    if (changed.includes('apiEndpoint') && !('apiKey' in value) && APICompat.carriesApiKey(stored.apiKey)) {
      warnings.push(fill(t('transferEndpointKeyWarning'), { endpoint: value.apiEndpoint }));
    }
    return { lines, warnings };
  },

  async apply(value) {
    await chrome.storage.sync.set(value);
    await loadSettings();
    TabBroadcast.settingsUpdated(value);
  },
};

const siteRulesSection = {
  key: 'siteRules',

  async collect() {
    const stored = await chrome.storage.sync.get({ siteRules: {} });
    return stored.siteRules;
  },

  validate(raw) {
    return SettingsTransfer.validateSiteRules(raw, SiteRules.normalizeHost);
  },

  async preview({ accepted, dropped }) {
    return {
      lines: [fill(t('transferPreviewSiteRules'), { count: accepted, dropped: dropped.length })],
      warnings: [],
    };
  },

  // 走服务工作者的单写者队列：和追问条、popup 写的是同一张表。
  apply(value) {
    return SiteRules.importUserRules(value);
  },
};

const TRANSFER_SECTIONS = [settingsSection, siteRulesSection];

// ---------------------------------------------------------------------------
// 控件
// ---------------------------------------------------------------------------

// 同步存储整个才 100KB，一份正常的导出只有几 KB。再大就不是我们的文件。
const TRANSFER_MAX_BYTES = 1024 * 1024;

const transferElements = {
  exportButton: document.getElementById('transferExport'),
  importButton: document.getElementById('transferImport'),
  file: document.getElementById('transferFile'),
  includeApiKey: document.getElementById('transferIncludeApiKey'),
  error: document.getElementById('transferError'),
  preview: document.getElementById('transferPreview'),
  previewList: document.getElementById('transferPreviewList'),
  warnings: document.getElementById('transferWarnings'),
  confirm: document.getElementById('transferConfirm'),
  cancel: document.getElementById('transferCancel'),
};

// 校验通过、等用户确认的那一份。
let pendingImport = null;

const TRANSFER_SECTION_NAMES = {
  settings: 'transferSectionSettings',
  siteRules: 'transferSectionSiteRules',
};

function sectionName(key) {
  return TRANSFER_SECTION_NAMES[key] ? t(TRANSFER_SECTION_NAMES[key]) : key;
}

const TRANSFER_ERROR_KEYS = {
  notJson: 'transferErrorNotJson',
  wrongFormat: 'transferErrorWrongFormat',
  wrongVersion: 'transferErrorWrongVersion',
  notObject: 'transferErrorNotObject',
  nothingValid: 'transferErrorNothingValid',
  hotkeyConflict: 'transferErrorHotkeyConflict',
  tooLarge: 'transferErrorTooLarge',
};

function transferErrorText(error) {
  if (error instanceof SettingsTransfer.TransferApplyError) {
    const written = error.written.map(sectionName).join(', ') || t('transferWrittenNone');
    return fill(t('transferErrorApplyFailed'), {
      failed: sectionName(error.failed),
      written,
      message: error.cause && error.cause.message,
    });
  }
  if (error instanceof SettingsTransfer.TransferError && TRANSFER_ERROR_KEYS[error.code]) {
    return fill(t(TRANSFER_ERROR_KEYS[error.code]), { section: sectionName(error.detail) });
  }
  return fill(t('transferErrorUnexpected'), { message: error && error.message });
}

function showTransferError(error) {
  transferElements.error.textContent = transferErrorText(error);
  transferElements.error.hidden = false;
}

function resetTransferUi() {
  pendingImport = null;
  transferElements.error.hidden = true;
  transferElements.error.textContent = '';
  transferElements.preview.hidden = true;
  transferElements.previewList.replaceChildren();
  transferElements.warnings.replaceChildren();
}

async function exportSettings() {
  resetTransferUi();
  const now = new Date();
  const includeApiKey = transferElements.includeApiKey.checked;
  const values = {};
  for (const section of TRANSFER_SECTIONS) values[section.key] = await section.collect({ includeApiKey });
  const file = SettingsTransfer.buildFile(values, now);
  const url = URL.createObjectURL(new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = SettingsTransfer.fileName(now);
  link.click();
  // 点击已经把下载交给浏览器了，URL 用完就收。
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showStatus(t('transferExported'), 'success');
}

async function readImportFile(file) {
  resetTransferUi();
  if (file.size > TRANSFER_MAX_BYTES) throw new SettingsTransfer.TransferError('tooLarge');
  const parsed = SettingsTransfer.parseFile(await file.text());
  const validated = await SettingsTransfer.validateAll(parsed, TRANSFER_SECTIONS);

  const items = [];
  const warnings = [];
  for (const result of validated.sections) {
    const section = TRANSFER_SECTIONS.find((candidate) => candidate.key === result.key);
    const shown = await section.preview(result);
    items.push(...shown.lines);
    warnings.push(...shown.warnings);
  }
  if (validated.unknown.length) {
    items.push(fill(t('transferPreviewUnknownSections'), { sections: validated.unknown.join(', ') }));
  }

  transferElements.previewList.replaceChildren(...items.map((text) => {
    const li = document.createElement('li');
    li.textContent = text;
    return li;
  }));
  transferElements.warnings.replaceChildren(...warnings.map((text) => {
    const p = document.createElement('p');
    p.className = 'transfer-warning';
    p.textContent = text;
    return p;
  }));
  transferElements.preview.hidden = false;
  pendingImport = validated;
}

async function confirmImport() {
  const validated = pendingImport;
  if (!validated) return;
  transferElements.confirm.disabled = true;
  try {
    await SettingsTransfer.applyAll(validated, TRANSFER_SECTIONS);
    resetTransferUi();
    showStatus(t('transferImported'), 'success');
  } catch (error) {
    console.error('Settings import failed:', error);
    transferElements.preview.hidden = true;
    pendingImport = null;
    showTransferError(error);
  } finally {
    transferElements.confirm.disabled = false;
  }
}

function setupTransfer() {
  transferElements.exportButton.addEventListener('click', () => {
    exportSettings().catch((error) => {
      console.error('Settings export failed:', error);
      showTransferError(error);
    });
  });
  transferElements.importButton.addEventListener('click', () => transferElements.file.click());
  transferElements.file.addEventListener('change', () => {
    const file = transferElements.file.files[0];
    // 清掉，同一个文件改完再选一次也会触发 change。
    transferElements.file.value = '';
    if (!file) return;
    readImportFile(file).catch((error) => {
      console.error('Settings import rejected:', error);
      showTransferError(error);
    });
  });
  transferElements.confirm.addEventListener('click', () => confirmImport());
  transferElements.cancel.addEventListener('click', () => resetTransferUi());
}
