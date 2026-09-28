// Blab Translation 设置页 —— 导入 / 导出设置
//
// options.html 按顺序加载的普通脚本，和 options.js 共用同一个全局词法作用域：
// defaultSettings、collectSettings、hasHotkeyConflict、loadSettings、showStatus、
// downloadFile、unattendedAiReachable、t、currentUILang 都直接叫名字（调用都发生在点击之后）。
//
// 文件格式、键级校验和「先全校验、再按序写、第一个失败就停」的编排在
// shared/settings-transfer.js（纯函数，node 里测）；这里只有这一页的 section 表
// 和控件。

// ---------------------------------------------------------------------------
// section 表。顺序就是写入顺序。
//
// 每一行：
//   key                  文件里的顶层键
//   collect({includeApiKey})  → 这一块的值（导出）；只有 aiProfiles 看 includeApiKey
//   validate(raw)        → { value, accepted, dropped: string[] }；整块不对就抛 TransferError
//   preview(result)      → { lines: string[], warnings: string[] }（预览区的条目和警示）
//   apply(value)         写进去；失败就抛
//
// 值不一定是对象，预览也不假设它是 —— 每一行自己画自己。
//
// 「一条一个 sync 键」的集合（站点翻译规则、术语表、AI 配置档）由
// collectionSection() 包一层：集合抛的是写给自己卡片的 i18n 键，这里换成整份
// 导入的两种句式（校验时的 TransferError、写入中途的原因短语）。
// ---------------------------------------------------------------------------

function transferSchema() {
  return SettingsTransfer.settingsSchema(DefaultSettings.contentDefaults(), defaultSettings);
}

function transferEnums() {
  return SettingsTransfer.buildEnums({
    uiLanguages: UI_LANGUAGES,
    targetLangs: TargetLang.SUPPORTED,
    cloudTargets: TargetLang.CLOUD_TARGETS,
    styles: TranslationDisplay.STYLES,
    domains: PromptAddenda.DOMAINS,
  });
}

function fill(template, values) {
  return Object.entries(values).reduce((text, [name, value]) => text.split(`{${name}}`).join(String(value)), template);
}

const settingsSection = {
  key: 'settings',

  async collect() {
    const schema = transferSchema();
    const stored = await chrome.storage.sync.get(schema);
    return SettingsTransfer.pickExport(stored, schema);
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
    // 导入会打开一条原本关着的「没人点也会花到 AI」的路。三条路里哪一条都算
    // （options-auto.js 的 unattendedAiReachable），所以不借设置页那句「让自动
    // 翻译改用 AI？」：文件只改了手动引擎时，自动翻译仍是内置，那句话就不对了。
    // 点「确认导入」就算答应了，不再另弹一次确认。
    const current = collectSettings();
    if (!unattendedAiReachable(current) && unattendedAiReachable(Object.assign({}, current, value))) {
      warnings.push(t('transferUnattendedAiWarning'));
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

  // 走服务工作者的单写者队列：和 popup、设置页的站点表写的是同一张表。
  apply(value) {
    return SiteRules.importUserRules(value);
  },
};

// 集合抛出的错误键 → 报错码。表里的键卡片自己也认（CustomRules.userErrorKey），
// 这里只管它们在整份导入里怎么说。术语表的键卡片认的是 Glossary.userErrorKey。
const COLLECTION_REFUSALS = {
  aiProfileInvalid: 'sectionInvalid',
  aiProfileTooLarge: 'sectionInvalid',
  aiProfilesBudgetFull: 'sectionBudgetFull',
  aiProfileSaveFailed: 'sectionSaveFailed', // 只在写入时出现
  customRulesImportInvalid: 'sectionInvalid',
  customRuleTooLarge: 'sectionInvalid',
  customRulesBudgetFull: 'sectionBudgetFull',
  customRuleSaveFailed: 'sectionSaveFailed', // 只在写入时出现
  customRuleProfileMissing: 'sectionInvalid', // 只在写入时出现：规则指向的档不在
  glossaryImportInvalid: 'sectionInvalid',
  glossaryEntryInvalid: 'sectionInvalid',
  glossaryEntryTooLarge: 'sectionInvalid',
  glossaryBudgetFull: 'sectionBudgetFull',
  glossarySaveFailed: 'sectionSaveFailed', // 只在写入时出现
};

// 写入中途失败时，transferErrorApplyFailed 里 {message} 填的原因短语。
const TRANSFER_REASON_KEYS = {
  sectionInvalid: 'transferReasonInvalid',
  sectionBudgetFull: 'transferReasonBudgetFull',
  sectionSaveFailed: 'transferReasonSaveFailed',
};

function collectionRefusal(error) {
  const key = error && error.message;
  return Object.prototype.hasOwnProperty.call(COLLECTION_REFUSALS, key) ? COLLECTION_REFUSALS[key] : null;
}

// 包住一行的 validate 和 apply。表外的错误两处都原样往上抛（同一个对象），由
// readImportFile / confirmImport 的 catch 各记一次日志。
function collectionSection(spec) {
  return Object.assign({}, spec, {
    async validate(raw) {
      try {
        return await spec.validate(raw);
      } catch (error) {
        const code = collectionRefusal(error);
        if (code) throw new SettingsTransfer.TransferError(code, spec.key);
        throw error;
      }
    },
    async apply(value) {
      try {
        return await spec.apply(value);
      } catch (error) {
        const code = collectionRefusal(error);
        if (code) throw new Error(t(TRANSFER_REASON_KEYS[code]), { cause: error });
        throw error;
      }
    },
  });
}

// AI 配置档（设计 §2.8）。导出没勾「包含 API Key」时整档不带 apiKey 字段；导入
// 时没带 Key 的档沿用本机同 id 档的 Key（keepKeys）。旧文件 settings 里的四个旧键
// 在 readImportFile 里先经 SettingsTransfer.liftLegacyProfile 并进这一节。这里的
// 校验只为预览和「先全校验」：SW 的 import 重新校验，不信这里算的数。
const aiProfilesSection = collectionSection({
  key: 'aiProfiles',

  async collect({ includeApiKey }) {
    return (await readAiProfiles()).map((profile) => {
      const out = Object.assign({}, profile);
      if (!includeApiKey) delete out.apiKey;
      return out;
    });
  },

  async validate(raw) {
    // 空数组是一台没配过 AI 的设备导出的：合法，收下 0 档（applyAll 跳过它）。
    if (!Array.isArray(raw) || raw.length > AIProfiles.LIMITS.maxItems) {
      throw new Error('aiProfileInvalid');
    }
    const normalized = raw.map((profile) => {
      if (AIProfiles.validate(profile) || !AIProfiles.collection.validId(profile.id)) throw new Error('aiProfileInvalid');
      return AIProfiles.normalize(profile);
    });
    // 集合规则里导入改不了的两条：至多一个默认档，一个功能至多挂在一档上。
    const features = normalized.flatMap((profile) => profile.features);
    const ids = raw.map((profile) => profile.id);
    if (normalized.filter((profile) => profile.default).length > 1
      || new Set(features).size !== features.length
      || new Set(ids).size !== ids.length) {
      throw new Error('aiProfileInvalid');
    }
    const local = new Map((await readAiProfiles()).map((profile) => [profile.id, profile]));
    const replaced = ids.filter((id) => local.has(id)).length;
    // 全有或全无，没有丢掉的条目。
    return { value: raw, accepted: raw.length, dropped: [], added: raw.length - replaced, replaced, local };
  },

  async preview({ value, added, replaced, local }) {
    const warnings = [];
    for (const profile of value) {
      const mine = local.get(profile.id);
      // 换了接口地址、文件里却没带 Key：这台设备上同一档的 Key 会发到新地址去。
      if (profile.apiKey === undefined && mine && mine.apiEndpoint !== profile.apiEndpoint.trim()
        && APICompat.carriesApiKey(mine.apiKey)) {
        warnings.push(fill(t('transferEndpointKeyWarning'), { endpoint: profile.apiEndpoint }));
      }
      // 进来的这一档要 Key，文件里没有、本机同 id 的档也没有可沿用的：导入后它「未填 Key」。
      const key = profile.apiKey === undefined ? (mine ? mine.apiKey : '') : profile.apiKey;
      if (APICompat.isApiKeyMissing(Object.assign({}, profile, { apiKey: key }))) {
        warnings.push(fill(t('aiProfileKeyMissing'), { name: profile.name }));
      }
    }
    return { lines: [fill(t('transferPreviewAiProfiles'), { added, replaced })], warnings };
  },

  apply(value) {
    return AIProfiles.request('import', { profiles: value, keepKeys: true });
  },
});

// 预览、合并和额度都在卡片那一个函数里算（previewCustomRulesImport，
// options-custom-rules.js），这里不算第二遍。
const customRulesSection = collectionSection({
  key: 'customRules',

  async collect() {
    return CustomRules.toExportFile(await readCustomRules());
  },

  async validate(raw) {
    const { added, replaced, aiCount } = await previewCustomRulesImport(raw);
    // 集合的导入全有或全无，所以没有丢掉的条目。
    return { value: raw, accepted: added + replaced, dropped: [], added, replaced, aiCount };
  },

  async preview({ added, replaced, aiCount }) {
    return {
      lines: [fill(t('transferPreviewCustomRules'), { added, replaced })],
      warnings: aiCount > 0 ? [customRulesAiNote(aiCount)] : [],
    };
  },

  // 走服务工作者的单写者队列，原样传解析后的对象。
  apply(value) {
    return CustomRules.request('import', { file: value });
  },
});

// 术语表在文件里就是它的 CSV 文本（和卡片导出的那份一样），导入走同一个
// previewGlossaryImport（options-glossary.js）和同一个 SW 的 import。
const glossarySection = collectionSection({
  key: 'glossary',

  async collect() {
    return GlossaryCsv.serialize(await readGlossary());
  },

  async validate(raw) {
    if (typeof raw !== 'string') throw new Error('glossaryImportInvalid');
    const { added, replaced } = await previewGlossaryImport(raw);
    // 全有或全无，没有丢掉的条目。
    return { value: raw, accepted: added + replaced, dropped: [], added, replaced };
  },

  async preview({ added, replaced }) {
    return { lines: [fill(t('transferPreviewGlossary'), { added, replaced })], warnings: [] };
  },

  // SW 重新解析这份 CSV，不信这里算的预览。
  apply(value) {
    return Glossary.request('import', { csv: value });
  },
});

// 配置档排在站点翻译规则前面：规则可以指向文件里新带来的档，SW 写规则时要它已经在。
const TRANSFER_SECTIONS = [settingsSection, aiProfilesSection, siteRulesSection, customRulesSection, glossarySection];

// ---------------------------------------------------------------------------
// 控件
// ---------------------------------------------------------------------------

// 卡片里面的标记。options.html 只留 <section id="transferCard"> 这个挂载点（那个文件
// 要守住 1000 行），标记原样搬到这里，加载时一次填进去：下面的 transferElements 在
// 加载时就按 id 取节点，所以必须先填。文案照旧走 data-i18n，applyI18n 换界面语言时
// 和别的卡片一起改。整段是写死的常量，不拼任何数据。
const TRANSFER_CARD_MARKUP = `
  <h2 class="section-title">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
      <polyline points="7 10 12 15 17 10"/>
      <line x1="12" y1="15" x2="12" y2="3"/>
    </svg>
    <span data-i18n="transferTitle">Import / Export Settings</span>
  </h2>
  <span class="hint" data-i18n-hint="transferDesc"></span>

  <div class="transfer-actions">
    <button type="button" id="transferExport" class="btn btn-secondary btn-inline">
      <span data-i18n="transferExport">Export</span>
    </button>
    <button type="button" id="transferImport" class="btn btn-secondary btn-inline">
      <span data-i18n="transferImport">Import</span>
    </button>
    <input type="file" id="transferFile" accept=".json,application/json" hidden>
  </div>

  <label class="transfer-secret" for="transferIncludeApiKey">
    <input type="checkbox" id="transferIncludeApiKey">
    <span data-i18n="transferIncludeApiKey">Include API Key</span>
  </label>
  <span class="hint" data-i18n-hint="transferIncludeApiKeyHint"></span>

  <div id="transferError" class="transfer-error" role="alert" hidden></div>

  <div id="transferPreview" class="transfer-preview" hidden>
    <h3 class="transfer-preview-title" data-i18n="transferPreviewTitle">Review before importing</h3>
    <ul id="transferPreviewList" class="transfer-preview-list"></ul>
    <div id="transferWarnings" class="transfer-warnings"></div>
    <div class="transfer-actions">
      <button type="button" id="transferConfirm" class="btn btn-primary btn-inline">
        <span data-i18n="transferConfirm">Confirm import</span>
      </button>
      <button type="button" id="transferCancel" class="btn btn-secondary btn-inline">
        <span data-i18n="transferCancel">Cancel</span>
      </button>
    </div>
  </div>
`;

document.getElementById('transferCard').innerHTML = TRANSFER_CARD_MARKUP;

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
  aiProfiles: 'transferSectionAiProfiles',
  siteRules: 'transferSectionSiteRules',
  customRules: 'transferSectionCustomRules',
  glossary: 'transferSectionGlossary',
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
  sectionInvalid: 'transferErrorSectionInvalid',
  sectionBudgetFull: 'transferErrorSectionBudgetFull',
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
  downloadFile(JSON.stringify(file, null, 2), 'application/json', SettingsTransfer.fileName(now));
  showStatus(t('transferExported'), 'success');
}

async function readImportFile(file) {
  resetTransferUi();
  if (file.size > SettingsTransfer.MAX_FILE_BYTES) throw new SettingsTransfer.TransferError('tooLarge');
  // 旧文件的四个旧键先转成 legacy 档，并进 aiProfiles 一节（设计 §2.8）。
  const parsed = SettingsTransfer.liftLegacyProfile(SettingsTransfer.parseFile(await file.text()), AIProfiles);
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
