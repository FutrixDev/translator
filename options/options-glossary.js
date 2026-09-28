// Blab Translation 设置页 —— 术语表卡片（设计 §4.1）
//
// options.html 按顺序加载的普通脚本，和 options.js 共用一个全局词法作用域：
// t、fill、showStatus、downloadFile、currentUILang、kib 都直接叫名字（调用都发生在
// DOMContentLoaded 之后）。
//
// 读：storage.sync.get(null) 交给 Glossary.collect，此后跟着 storage.onChanged 用
// Glossary.applyChanges 增量更新。写：一律 Glossary.request(...)，走服务工作者的
// 单写者队列，这一页不直接写 storage。校验只在 Glossary.validateEntry（SW 那一侧）
// 一处；这里只把它抛的键摆到表单下面。CSV 的格式、导入合并和额度都在
// GlossaryCsv（shared/glossary-csv.js）。

// 卡片当前的词条（带 id），读回来之前是 null。
let glossaryEntries = null;
let glossaryReadSeq = 0;
// 搜索框里的字，只在页面上筛，不读存储。
let glossaryQuery = '';
// 正在编辑的那一条：{ id（新建为 null）, node, fields, error, save }。
let glossaryEditor = null;
// 选好、预览过、等用户点「导入」的 CSV 原文。
let pendingGlossaryImport = null;

// 卡片里面的标记。options.html 只留 <section id="glossaryCard"> 这个挂载点（那个
// 文件要守住 1000 行），加载时一次填进去：下面的 glossaryElements 在加载时就按 id
// 取节点，所以必须先填。文案走 data-i18n，applyI18n 换界面语言时和别的卡片一起
// 改。整段是写死的常量，不拼任何数据。
const GLOSSARY_CARD_MARKUP = `
  <h2 class="section-title">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M4 19.5A2.5 2.5 0 016.5 17H20"/>
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z"/>
      <line x1="9" y1="7" x2="16" y2="7"/>
      <line x1="9" y1="11" x2="14" y2="11"/>
    </svg>
    <span data-i18n="glossaryTitle">Glossary</span>
  </h2>
  <span class="hint" data-i18n-hint="glossaryDesc"></span>
  <p class="glossary-usage" id="glossaryUsage"></p>

  <div class="transfer-actions glossary-toolbar">
    <input type="search" id="glossarySearch" class="glossary-search" data-i18n-placeholder="glossarySearch">
    <button type="button" id="glossaryAdd" class="btn btn-primary btn-inline">
      <span data-i18n="glossaryAddEntry">Add entry</span>
    </button>
    <button type="button" id="glossaryImport" class="btn btn-secondary btn-inline">
      <span data-i18n="glossaryImportCsv">Import CSV</span>
    </button>
    <button type="button" id="glossaryExport" class="btn btn-secondary btn-inline">
      <span data-i18n="glossaryExportCsv">Export CSV</span>
    </button>
    <input type="file" id="glossaryFile" accept=".csv,text/csv" hidden>
  </div>

  <div id="glossaryError" class="transfer-error" role="alert" hidden></div>
  <div id="glossaryPreview" class="transfer-preview" hidden>
    <p id="glossaryPreviewText" class="glossary-preview-text"></p>
    <div class="transfer-actions">
      <button type="button" id="glossaryImportConfirm" class="btn btn-primary btn-inline">
        <span data-i18n="glossaryImportConfirm">Import</span>
      </button>
      <button type="button" id="glossaryImportCancel" class="btn btn-secondary btn-inline">
        <span data-i18n="glossaryCancel">Cancel</span>
      </button>
    </div>
  </div>
  <div class="glossary-list" id="glossaryList"></div>
`;

document.getElementById('glossaryCard').innerHTML = GLOSSARY_CARD_MARKUP;

const glossaryElements = {
  usage: document.getElementById('glossaryUsage'),
  search: document.getElementById('glossarySearch'),
  add: document.getElementById('glossaryAdd'),
  importButton: document.getElementById('glossaryImport'),
  exportButton: document.getElementById('glossaryExport'),
  file: document.getElementById('glossaryFile'),
  error: document.getElementById('glossaryError'),
  preview: document.getElementById('glossaryPreview'),
  previewText: document.getElementById('glossaryPreviewText'),
  confirm: document.getElementById('glossaryImportConfirm'),
  cancel: document.getElementById('glossaryImportCancel'),
  list: document.getElementById('glossaryList'),
};

// ---------------------------------------------------------------------------
// 共用给整份导入导出的两个函数（options-transfer.js 的 glossary 一行）
// ---------------------------------------------------------------------------

async function readGlossary() {
  return Glossary.collect(await chrome.storage.sync.get(null));
}

/**
 * 一份 CSV 并进当前词条会怎样：{added, replaced}，或抛 glossaryImportInvalid
 * （带 row）/ glossaryEntryTooLarge / glossaryBudgetFull。卡片的导入和整份导入的
 * 术语表小节都只问它。当前词条现读存储，不用卡片手里那份：整份导入可能在卡片
 * 读回来之前就点了。
 */
async function previewGlossaryImport(text) {
  return GlossaryCsv.previewImport(await readGlossary(), text);
}

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

// 集合的错误键原样查文案；表外的错误在这一层被接住，在这一层记一条（不带词条
// 内容）。glossaryImportInvalid 的行号只有本页的解析知道 —— SW 回话只带键名；
// 预览过了、SW 却说文件坏了，是两边解析不一致的缺陷，按保存失败说并记下来。
function glossaryErrorText(error, operation) {
  const key = Glossary.userErrorKey(error);
  if (key === 'glossaryImportInvalid') {
    if (Number.isInteger(error.row)) return fill(t(key), { row: error.row });
    console.error(`Blab Translation: glossary ${operation} was refused after its preview passed`, error);
    return t('glossarySaveFailed');
  }
  if (key) return t(key);
  console.error(`Blab Translation: glossary ${operation} failed`, error);
  return t('glossarySaveFailed');
}

function showGlossaryError(error, operation) {
  glossaryElements.error.textContent = glossaryErrorText(error, operation);
  glossaryElements.error.hidden = false;
}

function hideGlossaryError() {
  glossaryElements.error.hidden = true;
  glossaryElements.error.textContent = '';
}

// ---------------------------------------------------------------------------
// 列表
// ---------------------------------------------------------------------------

async function loadGlossary() {
  const seq = ++glossaryReadSeq;
  let entries;
  try {
    entries = await readGlossary();
  } catch (error) {
    console.error('Blab Translation: failed to read the glossary', error);
    return;
  }
  // 两次读交错回来时，只认后发的那一次。
  if (seq !== glossaryReadSeq) return;
  glossaryEntries = entries;
  drawGlossary();
}

function glossaryMatches(entry, query) {
  if (!query) return true;
  return [entry.s, entry.t, entry.h].some((field) => field && field.toLowerCase().includes(query));
}

/**
 * 按 glossaryEntries 重画用量和列表。开着的表单原样挂回去（它在编辑的那一行被
 * 它顶替；那一条在别处被删了，或被搜索筛掉了，表单就排到最前面）。
 */
function drawGlossary() {
  if (!glossaryEntries) return;
  const { bytes, count } = Glossary.usage(glossaryEntries);
  const limits = Glossary.LIMITS;
  glossaryElements.usage.textContent = fill(t('glossaryUsage'), {
    used: kib(bytes), total: kib(limits.totalBytes), count, max: limits.maxItems,
  });

  const collator = new Intl.Collator(currentUILang, { sensitivity: 'base' });
  const query = glossaryQuery.trim().toLowerCase();
  const shown = glossaryEntries
    .filter((entry) => glossaryMatches(entry, query))
    .sort((a, b) => collator.compare(a.s, b.s) || collator.compare(a.h || '', b.h || '') || collator.compare(a.l, b.l));
  const nodes = shown.map((entry) => (
    glossaryEditor && glossaryEditor.id === entry.id ? glossaryEditor.node : glossaryRow(entry)
  ));
  if (glossaryEditor && !nodes.includes(glossaryEditor.node)) nodes.unshift(glossaryEditor.node);
  if (!glossaryEntries.length && !glossaryEditor) {
    const empty = document.createElement('p');
    empty.className = 'glossary-empty';
    empty.textContent = t('glossaryEmpty');
    nodes.push(empty);
  }
  glossaryElements.list.replaceChildren(...nodes);
}

function glossaryChip(text) {
  const chip = document.createElement('span');
  chip.className = 'glossary-chip';
  chip.textContent = text;
  return chip;
}

function glossaryRow(entry) {
  const row = document.createElement('div');
  row.className = 'glossary-entry';
  row.dataset.entryId = entry.id;

  const terms = document.createElement('span');
  terms.className = 'glossary-terms';
  const source = document.createElement('span');
  source.className = 'glossary-source';
  source.textContent = entry.s;
  const target = document.createElement('span');
  target.className = entry.t ? 'glossary-target' : 'glossary-target glossary-keep';
  target.textContent = entry.t || t('glossaryKeepSource');
  terms.append(source, ' → ', target);
  row.appendChild(terms);

  const chips = document.createElement('span');
  chips.className = 'glossary-chips';
  if (entry.c) chips.appendChild(glossaryChip(t('glossaryCaseSensitive')));
  if (entry.h) chips.appendChild(glossaryChip(entry.h));
  if (entry.l !== Glossary.ANY_LANG) chips.appendChild(glossaryChip(TargetLang.nameOf(entry.l, currentUILang)));
  row.appendChild(chips);

  const edit = document.createElement('button');
  edit.type = 'button';
  edit.className = 'btn btn-text glossary-edit';
  edit.textContent = t('glossaryEdit');
  edit.addEventListener('click', () => openGlossaryEditor(entry));

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'btn btn-text glossary-delete';
  remove.textContent = t('glossaryDelete');
  remove.addEventListener('click', () => removeGlossaryEntry(entry, remove));

  const actions = document.createElement('span');
  actions.className = 'glossary-actions';
  actions.append(edit, remove);
  row.appendChild(actions);
  return row;
}

// 不弹确认（设计 §4.1）：删错了重新加一条就是。列表跟着 storage.onChanged 更新。
async function removeGlossaryEntry(entry, button) {
  button.disabled = true;
  hideGlossaryError();
  try {
    await Glossary.request('remove', { ids: [entry.id] });
  } catch (error) {
    showGlossaryError(error, 'remove');
    button.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// 表单（添加与编辑共用）
// ---------------------------------------------------------------------------

function glossaryField(form, { key, label, control }) {
  const group = document.createElement('div');
  group.className = 'form-group glossary-field';
  const caption = document.createElement('label');
  caption.htmlFor = `glossary-${key}`;
  caption.textContent = t(label);
  control.id = `glossary-${key}`;
  group.append(caption, control);
  form.appendChild(group);
  return control;
}

function glossaryTextInput(value, placeholder) {
  const input = document.createElement('input');
  input.type = 'text';
  input.spellcheck = false;
  input.value = value || '';
  if (placeholder) input.placeholder = t(placeholder);
  return input;
}

function glossaryLangSelect(value) {
  const select = document.createElement('select');
  select.appendChild(new Option(t('glossaryTargetLangAll'), Glossary.ANY_LANG));
  for (const { value: code, label } of TargetLang.options(currentUILang)) select.appendChild(new Option(label, code));
  select.value = value || Glossary.ANY_LANG;
  return select;
}

function openGlossaryEditor(entry) {
  hideGlossaryError();
  const source = entry || {};
  const node = document.createElement('div');
  node.className = 'glossary-editor';

  const fields = {
    source: glossaryField(node, { key: 'source', label: 'glossarySource', control: glossaryTextInput(source.s) }),
    target: glossaryField(node, {
      key: 'target', label: 'glossaryTarget', control: glossaryTextInput(source.t, 'glossaryKeepSource'),
    }),
    site: glossaryField(node, { key: 'site', label: 'glossarySite', control: glossaryTextInput(source.h, 'glossarySiteAll') }),
    // 标签借用翻译设置那张卡片的「目标语言」；下拉首项是「所有目标语言」。
    lang: glossaryField(node, { key: 'lang', label: 'targetLanguage', control: glossaryLangSelect(source.l) }),
  };

  const caseLabel = document.createElement('label');
  caseLabel.className = 'transfer-secret glossary-case';
  const caseBox = document.createElement('input');
  caseBox.type = 'checkbox';
  caseBox.id = 'glossary-case';
  caseLabel.append(caseBox, t('glossaryCaseSensitive'));
  node.insertBefore(caseLabel, fields.site.parentNode);
  fields.caseSensitive = caseBox;

  // 编辑时照条目原样；添加时原文含大写字母就默认勾上，用户自己点过以后不再跟着变。
  if (entry) {
    caseBox.checked = Boolean(entry.c);
  } else {
    let touched = false;
    caseBox.addEventListener('change', () => { touched = true; });
    fields.source.addEventListener('input', () => {
      if (!touched) caseBox.checked = Glossary.caseSensitiveByDefault(fields.source.value);
    });
  }
  // 站点失焦时规范化后回填，存进去的就是看到的。规范化后什么都不剩的（'...'）
  // 不回填成空：空站点等于「所有网站」，那会把用户写了的站点悄悄放宽。原样留着，
  // 保存时由 validateEntry（和 CSV 导入同一条规则）拒成 glossaryEntryInvalid。
  fields.site.addEventListener('blur', () => {
    const value = fields.site.value.trim();
    const host = SiteRules.normalizeHost(value);
    if (host) fields.site.value = host;
  });

  const error = document.createElement('div');
  error.className = 'transfer-error glossary-form-error';
  error.setAttribute('role', 'alert');
  error.hidden = true;
  node.appendChild(error);

  const actions = document.createElement('div');
  actions.className = 'transfer-actions';
  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'btn btn-primary btn-inline glossary-save';
  save.textContent = t('glossarySave');
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn btn-secondary btn-inline glossary-cancel';
  cancel.textContent = t('glossaryCancel');
  actions.append(save, cancel);
  node.appendChild(actions);

  const editor = { id: entry ? entry.id : null, node, fields, error, save };
  save.addEventListener('click', () => saveGlossaryEntry(editor));
  cancel.addEventListener('click', () => closeGlossaryEditor());

  glossaryEditor = editor;
  drawGlossary();
  fields.source.focus();
}

function closeGlossaryEditor() {
  glossaryEditor = null;
  drawGlossary();
}

/**
 * 表单 → 写入载荷。只列这几个字段（编辑时再加 id）：u 从不由页面给，SW 写入时
 * 取这一刻（O-1）。空的译文、站点由 validateEntry 当作「没写」。
 */
function readGlossaryEditor(editor) {
  const { fields } = editor;
  const entry = {
    s: fields.source.value,
    t: fields.target.value,
    c: fields.caseSensitive.checked ? 1 : 0,
    h: fields.site.value.trim(),
    l: fields.lang.value,
  };
  if (editor.id) entry.id = editor.id;
  return entry;
}

async function saveGlossaryEntry(editor) {
  editor.error.hidden = true;
  editor.save.disabled = true;
  try {
    await Glossary.request('put', { entry: readGlossaryEditor(editor) });
  } catch (error) {
    editor.error.textContent = glossaryErrorText(error, 'save');
    editor.error.hidden = false;
    editor.save.disabled = false;
    return;
  }
  if (glossaryEditor === editor) closeGlossaryEditor();
  showStatus(t('settingsSaved'), 'success');
}

// ---------------------------------------------------------------------------
// 导出 / 导入
// ---------------------------------------------------------------------------

async function exportGlossary() {
  downloadFile(GlossaryCsv.serialize(await readGlossary()), 'text/csv;charset=utf-8', GlossaryCsv.fileName());
}

function resetGlossaryImport() {
  pendingGlossaryImport = null;
  glossaryElements.preview.hidden = true;
  glossaryElements.previewText.textContent = '';
}

async function readGlossaryImportFile(file) {
  resetGlossaryImport();
  hideGlossaryError();
  // 上限和整份导入是同一个数（SettingsTransfer.MAX_FILE_BYTES）。这么大的文件
  // 远远装不进 32 KiB 的同步空间，不读内容，直接按超额说。
  if (file.size > SettingsTransfer.MAX_FILE_BYTES) throw new Error('glossaryBudgetFull');
  const text = await file.text();
  const { added, replaced } = await previewGlossaryImport(text);
  glossaryElements.previewText.textContent = fill(t('glossaryImportPreview'), { added, replaced });
  glossaryElements.preview.hidden = false;
  pendingGlossaryImport = text;
}

async function confirmGlossaryImport() {
  const csv = pendingGlossaryImport;
  if (csv === null) return;
  glossaryElements.confirm.disabled = true;
  try {
    await Glossary.request('import', { csv });
    resetGlossaryImport();
    showStatus(t('settingsSaved'), 'success');
  } catch (error) {
    resetGlossaryImport();
    showGlossaryError(error, 'import');
  } finally {
    glossaryElements.confirm.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// 接线
// ---------------------------------------------------------------------------

// 不等第一次读回来：loadGlossary 自己接住读失败，页面其余部分不用等它。
function setupGlossary() {
  glossaryElements.add.addEventListener('click', () => openGlossaryEditor(null));
  glossaryElements.search.addEventListener('input', () => {
    glossaryQuery = glossaryElements.search.value;
    drawGlossary();
  });
  glossaryElements.exportButton.addEventListener('click', () => {
    exportGlossary().catch((error) => showGlossaryError(error, 'export'));
  });
  glossaryElements.importButton.addEventListener('click', () => glossaryElements.file.click());
  glossaryElements.file.addEventListener('change', () => {
    const file = glossaryElements.file.files[0];
    // 清掉，同一个文件改完再选一次也会触发 change。
    glossaryElements.file.value = '';
    if (!file) return;
    readGlossaryImportFile(file).catch((error) => showGlossaryError(error, 'import preview'));
  });
  glossaryElements.confirm.addEventListener('click', () => confirmGlossaryImport());
  glossaryElements.cancel.addEventListener('click', () => resetGlossaryImport());

  // 这一页自己的写入、别的标签页、划词卡片、另一台设备同步下来的变化都从这里
  // 进来。第一次读回来之前到的变化，交给再读一次（读到的已经包含它）。
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' || !Object.keys(changes).some((key) => key.startsWith(Glossary.KEY_PREFIX))) return;
    if (!glossaryEntries) {
      loadGlossary();
      return;
    }
    glossaryEntries = Glossary.applyChanges(glossaryEntries, changes, null);
    drawGlossary();
  });
  loadGlossary();
}
