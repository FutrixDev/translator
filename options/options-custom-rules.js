// Blab Translation 设置页 —— 站点翻译规则卡片（设计 §4）
//
// options.html 按顺序加载的普通脚本，和 options.js 共用一个全局词法作用域：
// t、fill、showStatus、currentUILang、syncAutoEngineState、confirmUnattendedAiSpend
// 都直接叫名字（调用都发生在 DOMContentLoaded 之后）。
//
// 读：storage.sync.get(null) 交给 CustomRules.collect —— 集合没有索引键，键名
// 前缀就是目录。写：一律 CustomRules.request(...)，走服务工作者的单写者队列，
// 这一页不直接写 storage。校验只在 CustomRules.validateRule 一处；这里只把它抛
// 的键摆到对应字段下面。

// 卡片当前的规则。顶层就是数组：loadSettings 里那次 syncAutoEngineState() 跑在
// setupCustomRules() 之前，那一刻答「没有规则」；读回来以后每次重绘都再问一次。
let customRulesList = [];
let customRulesLoaded = false;
let customRulesReadSeq = 0;
// 正在编辑的那一条：{ id（新建为 null）, node, fields, general, save }。
let customRuleEditor = null;
// 选好、预览过、等用户点「导入」的文件（已解析的对象）。
let pendingRulesImport = null;

const customRuleElements = {
  add: document.getElementById('customRulesAdd'),
  exportButton: document.getElementById('customRulesExport'),
  importButton: document.getElementById('customRulesImport'),
  file: document.getElementById('customRulesFile'),
  usage: document.getElementById('customRulesUsage'),
  error: document.getElementById('customRulesError'),
  preview: document.getElementById('customRulesPreview'),
  previewText: document.getElementById('customRulesPreviewText'),
  previewWarnings: document.getElementById('customRulesPreviewWarnings'),
  confirm: document.getElementById('customRulesImportConfirm'),
  cancel: document.getElementById('customRulesImportCancel'),
  list: document.getElementById('customRulesList'),
};

// 规则每个字段叫什么只有这一张表：编辑器的字段标签和列表里的小标签都读它，
// 两处叫法就分不开（N-12）。列表按这里的顺序画。
const CUSTOM_RULE_FIELD_LABELS = [
  ['include', 'customRuleInclude'],
  ['exclude', 'customRuleExclude'],
  ['keepOriginal', 'customRuleKeepOriginal'],
  ['css', 'customRuleCss'],
  ['engine', 'customRuleEngine'],
];
const fieldLabel = (field) => CUSTOM_RULE_FIELD_LABELS.find(([name]) => name === field)[1];

// ---------------------------------------------------------------------------
// 共用给整份导入导出的三个函数（options-transfer.js 的 customRules 一行）
// ---------------------------------------------------------------------------

async function readCustomRules() {
  return CustomRules.collect(await chrome.storage.sync.get(null));
}

// 选择器语法只有有 DOM 的地方查得了；SW 那一侧只查形状和长度。
function selectorParses(selector) {
  try {
    document.querySelector(selector);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * 一份导入文件（已解析的对象）并进当前规则会怎样：{added, replaced, aiCount}，
 * 或抛集合的错误键（customRulesImportInvalid / customRuleTooLarge /
 * customRulesBudgetFull）。卡片的导入和整份导入的规则小节都只问它（D-306）。
 *
 * 额度按合并后的结果查，就在 mergeImport 里面（CustomRules.assertFits），这里不
 * 再查第二遍。当前规则现读存储，不用卡片手里那份：整份导入可能在卡片读回来
 * 之前就点了。选择器语法在这里查、SW 写入时不查，所以预览只会比写入严。
 */
async function previewCustomRulesImport(file) {
  const existing = await readCustomRules();
  const { added, replaced, aiCount } = CustomRules.mergeImport(existing, file, { checkSelector: selectorParses });
  return { added, replaced, aiCount };
}

/**
 * 导入预览里的 AI 提示；卡片和整份导入同一句、同一个 K。K 为 1 时用单数那句
 * （仓里没有复数规则的先例，就是两个键）。
 */
function customRulesAiNote(count) {
  return fill(t(count === 1 ? 'customRulesImportAiNoteOne' : 'customRulesImportAiNote'), { count });
}

/** 有没有哪条规则把引擎钉在 AI 上 —— 每日额度那一格灰不灰的第四条路。 */
function customRulesUseAi() {
  return customRulesList.some((rule) => rule.engine === 'ai');
}

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

// 集合的错误键原样查文案；表外的错误在这一层被接住，在这一层记一条。
function customRuleErrorText(error, operation) {
  const key = CustomRules.userErrorKey(error);
  if (key) return t(key);
  console.error(`Blab Translation: site translation rule ${operation} failed`, error);
  return t('customRuleSaveFailed');
}

function showCustomRulesError(error, operation) {
  customRuleElements.error.textContent = customRuleErrorText(error, operation);
  customRuleElements.error.hidden = false;
}

function hideCustomRulesError() {
  customRuleElements.error.hidden = true;
  customRuleElements.error.textContent = '';
}

// ---------------------------------------------------------------------------
// 列表
// ---------------------------------------------------------------------------

async function renderCustomRules() {
  const seq = ++customRulesReadSeq;
  let rules;
  try {
    rules = await readCustomRules();
  } catch (error) {
    console.error('Blab Translation: failed to read site translation rules', error);
    return;
  }
  // 两次读交错回来时，只认后发的那一次。
  if (seq !== customRulesReadSeq) return;
  customRulesList = rules.sort(CustomRules.compareRules);
  customRulesLoaded = true;
  drawCustomRules();
  syncAutoEngineState();
}

function kib(bytes) {
  return (bytes / 1024).toLocaleString(currentUILang, { maximumFractionDigits: 1 });
}

/**
 * 按 customRulesList 重画列表和用量表。开着的编辑器原样挂回去（它在编辑的那一
 * 行被它顶替；那一条在别处被删了，编辑器就排到最前面，保存会按原 id 再建出来）。
 */
function drawCustomRules() {
  if (!customRulesLoaded) return;
  const { bytes, count } = CustomRules.usage(customRulesList);
  const limits = CustomRules.LIMITS;
  customRuleElements.usage.textContent = fill(t('customRulesUsage'), {
    used: kib(bytes), total: kib(limits.totalBytes), count, max: limits.maxRules,
  });

  const nodes = customRulesList.map((rule) => (
    customRuleEditor && customRuleEditor.id === rule.id ? customRuleEditor.node : customRuleRow(rule)
  ));
  if (customRuleEditor && !nodes.includes(customRuleEditor.node)) nodes.unshift(customRuleEditor.node);
  if (!nodes.length) {
    const empty = document.createElement('p');
    empty.className = 'custom-rules-empty';
    empty.textContent = t('customRulesEmpty');
    nodes.push(empty);
  }
  customRuleElements.list.replaceChildren(...nodes);
}

function customRuleRow(rule) {
  const row = document.createElement('div');
  row.className = 'custom-rule';
  row.dataset.ruleId = rule.id;

  const match = document.createElement('span');
  match.className = 'custom-rule-match';
  match.textContent = rule.match.length > 1 ? `${rule.match[0]} +${rule.match.length - 1}` : rule.match[0];
  match.title = rule.match.join('\n');
  row.appendChild(match);

  const chips = document.createElement('span');
  chips.className = 'custom-rule-chips';
  for (const [field, key] of CUSTOM_RULE_FIELD_LABELS) {
    if (!rule[field]) continue;
    const chip = document.createElement('span');
    chip.className = 'custom-rule-chip';
    chip.textContent = t(key);
    chips.appendChild(chip);
  }
  row.appendChild(chips);

  const edit = document.createElement('button');
  edit.type = 'button';
  edit.className = 'btn btn-text custom-rule-edit';
  edit.textContent = t('customRuleEdit');
  edit.addEventListener('click', () => openCustomRuleEditor(rule));
  row.appendChild(edit);

  row.appendChild(customRuleDeleteButton(rule));
  return row;
}

// 删除分两步：第一下只把按钮变成「确认删除」，焦点一离开就变回去。
function customRuleDeleteButton(rule) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn btn-text custom-rule-delete';
  const disarm = () => {
    delete button.dataset.armed;
    button.textContent = t('customRuleDelete');
  };
  disarm();
  button.addEventListener('blur', disarm);
  button.addEventListener('click', async () => {
    if (!button.dataset.armed) {
      button.dataset.armed = 'true';
      button.textContent = t('customRuleDeleteConfirm');
      return;
    }
    button.disabled = true;
    hideCustomRulesError();
    try {
      await CustomRules.request('remove', { id: rule.id });
    } catch (error) {
      showCustomRulesError(error, 'remove');
      button.disabled = false;
      disarm();
      return;
    }
    renderCustomRules();
  });
  return button;
}

// ---------------------------------------------------------------------------
// 编辑器
// ---------------------------------------------------------------------------

function editorField(form, { key, label, hint, value, mono }) {
  const group = document.createElement('div');
  group.className = 'form-group custom-rule-field';
  const id = `customRule-${key}`;
  const caption = document.createElement('label');
  caption.htmlFor = id;
  caption.textContent = t(label);
  group.appendChild(caption);

  const input = document.createElement('textarea');
  input.id = id;
  input.dataset.field = key;
  input.rows = 2;
  input.spellcheck = false;
  if (mono) input.classList.add('custom-rule-css');
  input.value = value;
  group.appendChild(input);

  if (hint) {
    const note = document.createElement('span');
    note.className = 'hint';
    note.textContent = t(hint);
    group.appendChild(note);
  }
  const error = document.createElement('span');
  error.className = 'custom-rule-field-error';
  error.hidden = true;
  group.appendChild(error);

  form.appendChild(group);
  return { input, error };
}

function engineField(form, value) {
  const group = document.createElement('div');
  group.className = 'form-group custom-rule-field';
  const caption = document.createElement('label');
  caption.htmlFor = 'customRule-engine';
  caption.textContent = t(fieldLabel('engine'));
  group.appendChild(caption);

  const select = document.createElement('select');
  select.id = 'customRule-engine';
  for (const [option, key] of [['', 'customRuleEngineFollow'], ['builtin', 'autoTranslateEngineBuiltin'],
    ['ai', 'autoTranslateEngineAi']]) {
    select.appendChild(new Option(t(key), option));
  }
  select.value = value || '';
  // 从非 AI 改成 AI 要过和自动引擎同一道确认；说了不，退回改之前的那个值。
  let previous = select.value;
  select.addEventListener('change', () => {
    if (select.value === 'ai' && previous !== 'ai' && !confirmUnattendedAiSpend('customRuleEngineAiConfirm')) {
      select.value = previous;
      return;
    }
    previous = select.value;
  });
  group.appendChild(select);
  form.appendChild(group);
  return select;
}

function openCustomRuleEditor(rule) {
  hideCustomRulesError();
  const source = rule || {};
  const lines = (list) => (list || []).join('\n');

  const node = document.createElement('div');
  node.className = 'custom-rule-editor';
  const fields = {
    match: editorField(node, { key: 'match', label: 'customRuleMatch', value: lines(source.match) }),
    include: editorField(node, {
      key: 'include', label: fieldLabel('include'), hint: 'customRuleIncludeHint', value: lines(source.include),
    }),
    exclude: editorField(node, {
      key: 'exclude', label: fieldLabel('exclude'), hint: 'pickerExcludeTip', value: lines(source.exclude),
    }),
    keepOriginal: editorField(node, {
      key: 'keepOriginal', label: fieldLabel('keepOriginal'), hint: 'pickerKeepOriginalTip',
      value: lines(source.keepOriginal),
    }),
    css: editorField(node, {
      key: 'css', label: fieldLabel('css'), hint: 'customRuleCssHint', value: source.css || '', mono: true,
    }),
  };
  const engine = engineField(node, source.engine);

  // CSS 边写边查，查法只有 CustomRules.sanitizeCss 一处。
  fields.css.input.addEventListener('input', () => {
    try {
      CustomRules.sanitizeCss(fields.css.input.value);
      setFieldError(fields.css, '');
    } catch (error) {
      setFieldError(fields.css, t(error.message));
    }
  });

  const general = document.createElement('div');
  general.className = 'transfer-error custom-rule-general-error';
  general.setAttribute('role', 'alert');
  general.hidden = true;
  node.appendChild(general);

  const actions = document.createElement('div');
  actions.className = 'transfer-actions';
  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'btn btn-primary btn-inline custom-rule-save';
  save.textContent = t('customRuleSave');
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn btn-secondary btn-inline custom-rule-cancel';
  cancel.textContent = t('customRuleCancel');
  actions.append(save, cancel);
  node.appendChild(actions);

  const editor = { id: rule ? rule.id : null, node, fields, engine, general, save };
  save.addEventListener('click', () => saveCustomRule(editor));
  cancel.addEventListener('click', () => closeCustomRuleEditor());

  customRuleEditor = editor;
  drawCustomRules();
  fields.match.input.focus();
}

function closeCustomRuleEditor() {
  customRuleEditor = null;
  drawCustomRules();
}

function setFieldError(field, text) {
  field.error.textContent = text;
  field.error.hidden = !text;
}

function editorLines(field) {
  return field.input.value.split('\n').map((line) => line.trim()).filter(Boolean);
}

function readEditor(editor) {
  const draft = { match: editorLines(editor.fields.match), css: editor.fields.css.input.value };
  for (const field of CustomRules.SELECTOR_FIELDS) draft[field] = editorLines(editor.fields[field]);
  if (editor.engine.value) draft.engine = editor.engine.value;
  return draft;
}

/**
 * validateRule 抛的 customRuleSelectorInvalid 不说是哪一条：用同一个 checkSelector
 * 和同一张 LIMITS 把它找出来，文案挂在那个字段下面。条数超了就指第一条多出来的。
 */
function selectorErrorPlace(editor) {
  const limits = CustomRules.LIMITS;
  for (const field of CustomRules.SELECTOR_FIELDS) {
    const lines = editorLines(editor.fields[field]);
    const bad = lines.find((line) => line.length > limits.maxSelectorLength || !selectorParses(line));
    if (bad !== undefined) return { field, selector: bad };
    if (lines.length > limits.maxSelectors) return { field, selector: lines[limits.maxSelectors] };
  }
  return { field: null, selector: '' };
}

const CUSTOM_RULE_ERROR_FIELDS = { customRuleMatchInvalid: 'match', customRuleCssUnsafe: 'css' };

function showEditorError(editor, error) {
  const key = CustomRules.userErrorKey(error);
  if (key === 'customRuleSelectorInvalid') {
    const place = selectorErrorPlace(editor);
    const text = fill(t(key), { selector: place.selector });
    if (place.field) setFieldError(editor.fields[place.field], text);
    else showEditorGeneral(editor, text);
    return;
  }
  const field = key && CUSTOM_RULE_ERROR_FIELDS[key];
  if (field) setFieldError(editor.fields[field], t(key));
  else showEditorGeneral(editor, customRuleErrorText(error, 'save'));
}

function showEditorGeneral(editor, text) {
  editor.general.textContent = text;
  editor.general.hidden = false;
}

async function saveCustomRule(editor) {
  for (const field of Object.values(editor.fields)) setFieldError(field, '');
  editor.general.hidden = true;

  let rule;
  try {
    rule = CustomRules.validateRule(readEditor(editor), { checkSelector: selectorParses });
  } catch (error) {
    showEditorError(editor, error);
    return;
  }
  if (editor.id) rule.id = editor.id;

  editor.save.disabled = true;
  try {
    await CustomRules.request('put', { rule });
  } catch (error) {
    showEditorError(editor, error);
    editor.save.disabled = false;
    return;
  }
  if (customRuleEditor === editor) customRuleEditor = null;
  showStatus(t('settingsSaved'), 'success');
  renderCustomRules();
}

// ---------------------------------------------------------------------------
// 导出 / 导入
// ---------------------------------------------------------------------------

function exportCustomRules() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const file = CustomRules.toExportFile(customRulesList);
  const url = URL.createObjectURL(new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `blab-site-rules-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function resetRulesImport() {
  pendingRulesImport = null;
  customRuleElements.preview.hidden = true;
  customRuleElements.previewText.textContent = '';
  customRuleElements.previewWarnings.replaceChildren();
}

async function readRulesImportFile(file) {
  resetRulesImport();
  hideCustomRulesError();
  // 上限和整份导入是同一个数（SettingsTransfer.MAX_FILE_BYTES），超了不读内容。
  if (file.size > SettingsTransfer.MAX_FILE_BYTES) throw new Error('customRulesImportInvalid');
  let parsed;
  try {
    parsed = JSON.parse(await file.text());
  } catch (cause) {
    throw new Error('customRulesImportInvalid', { cause });
  }
  const { added, replaced, aiCount } = await previewCustomRulesImport(parsed);
  customRuleElements.previewText.textContent = fill(t('customRulesImportPreview'), { added, replaced });
  if (aiCount > 0) {
    const note = document.createElement('p');
    note.className = 'transfer-warning';
    note.textContent = customRulesAiNote(aiCount);
    customRuleElements.previewWarnings.appendChild(note);
  }
  customRuleElements.preview.hidden = false;
  pendingRulesImport = parsed;
}

async function confirmRulesImport() {
  const file = pendingRulesImport;
  if (!file) return;
  customRuleElements.confirm.disabled = true;
  try {
    await CustomRules.request('import', { file });
    resetRulesImport();
    showStatus(t('settingsSaved'), 'success');
    renderCustomRules();
  } catch (error) {
    resetRulesImport();
    showCustomRulesError(error, 'import');
  } finally {
    customRuleElements.confirm.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// 接线
// ---------------------------------------------------------------------------

// 不等第一次读回来：renderCustomRules 自己接住读失败，页面其余部分不用等它。
function setupCustomRules() {
  customRuleElements.add.addEventListener('click', () => openCustomRuleEditor(null));
  customRuleElements.exportButton.addEventListener('click', () => exportCustomRules());
  customRuleElements.importButton.addEventListener('click', () => customRuleElements.file.click());
  customRuleElements.file.addEventListener('change', () => {
    const file = customRuleElements.file.files[0];
    // 清掉，同一个文件改完再选一次也会触发 change。
    customRuleElements.file.value = '';
    if (!file) return;
    readRulesImportFile(file).catch((error) => showCustomRulesError(error, 'import preview'));
  });
  customRuleElements.confirm.addEventListener('click', () => confirmRulesImport());
  customRuleElements.cancel.addEventListener('click', () => resetRulesImport());

  // 别的标签页、拾取器、另一台设备同步下来的变化都从这里进来；这一页自己的
  // 写入也会回弹一次，整块重读重画，多画一次结果一样。options.js 那个监听只管
  // siteRules / autoStats，键不相交。
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && Object.keys(changes).some((key) => key.startsWith(CustomRules.KEY_PREFIX))) {
      renderCustomRules();
    }
  });
  renderCustomRules();
}
