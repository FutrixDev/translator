// Blab Translation 设置页 —— 站点规则编辑器（自动翻译那张卡片里的「你表过态的网站」）
//
// options.html 按顺序加载的普通脚本，和 options.js 共用同一个全局词法作用域：
// renderSiteRules / setupSiteEditor 由 options.js 和 options-i18n.js 叫名字调用。
//
// 三块东西：
//
//   添加    一个框加一个 always/never，敲进来的字由 SiteRules.parseSiteInput 变成
//           键 —— 这里不自己脱协议、脱 www.，规则表的键只能有一个出处。错了就在框
//           下面说一句为什么，不弹窗。
//   你的规则 每行一个主机：always↔never 当场改、或者整条忘掉。
//   内置名单 always / captions / never 三组，只读、默认折起来；前两组每行一键写
//           一条用户规则盖过它（never 组盖不过，阶梯上它排在用户规则前面）。
//
// 写入一律走 SiteRules：开关是 setSiteAuto（写 always 时顺带打开总开关，理由在它
// 自己那里），忘掉是 writeUserRule(host, null)。两者都进服务工作者的单写者队列，
// 这一页不拼存储格式。写完不必自己重画：options.js 盯着 storage.onChanged，
// siteRules 一变就整块重读重画（规则沿父域生效，删一条会不会带走别的行，只有重
// 读才算数）。
//
// 整块在运行时画，不带 data-i18n，所以换界面语言时由 applyI18n 末尾整块重画。

const siteEditor = {
  form: document.getElementById('siteRuleAdd'),
  input: document.getElementById('siteRuleInput'),
  state: document.getElementById('siteRuleState'),
  error: document.getElementById('siteRuleError'),
  list: document.getElementById('siteRules'),
  builtin: document.getElementById('siteRulesBuiltin'),
};

function showSiteRuleError(message) {
  siteEditor.error.textContent = message;
  siteEditor.error.hidden = !message;
  siteEditor.input.setAttribute('aria-invalid', String(!!message));
}

/**
 * 一次写入。失败时在框下面说一声并把错误往上交给这一层的日志 —— 这是这条错
 * 误被接住、不再往上抛的地方。成功不画：onChanged 会来。
 */
async function writeSiteRule(host, state) {
  showSiteRuleError('');
  try {
    if (state) await SiteRules.setSiteAuto(host, state === 'always');
    else await SiteRules.writeUserRule(host, null);
  } catch (error) {
    console.error('Failed to write site rule:', host, state, error);
    showSiteRuleError(t('popupSiteRuleFailed'));
    renderSiteRules();
    return false;
  }
  return true;
}

async function onAddSiteRule(event) {
  event.preventDefault();
  const parsed = SiteRules.parseSiteInput(siteEditor.input.value);
  if (parsed.error === 'invalid') {
    showSiteRuleError(t('siteRuleInputInvalid'));
    return;
  }
  if (parsed.error === 'blocked') {
    showSiteRuleError(t('siteRuleInputBlocked').replace('{site}', parsed.host));
    return;
  }
  if (await writeSiteRule(parsed.host, siteEditor.state.value)) siteEditor.input.value = '';
}

function setupSiteEditor() {
  siteEditor.form.addEventListener('submit', onAddSiteRule);
  siteEditor.input.addEventListener('input', () => showSiteRuleError(''));
}

async function readUserSiteRules() {
  const stored = await chrome.storage.sync.get({ siteRules: {} });
  return stored.siteRules && typeof stored.siteRules === 'object' ? stored.siteRules : {};
}

/** 整块重画：你的规则 + 内置名单。内置那一块要知道哪几行已经被你的规则盖住了。 */
async function renderSiteRules() {
  let rules = {};
  try {
    rules = await readUserSiteRules();
  } catch (error) {
    console.error('Failed to read site rules:', error);
  }
  renderUserSiteRules(rules);
  renderBuiltinSites(rules);
}

function renderUserSiteRules(rules) {
  const hosts = Object.keys(rules)
    .filter((host) => rules[host] === 'always' || rules[host] === 'never')
    .sort();

  siteEditor.list.textContent = '';
  if (!hosts.length) {
    const empty = document.createElement('p');
    empty.className = 'site-rules-empty';
    empty.textContent = t('siteRulesEmpty');
    siteEditor.list.appendChild(empty);
    return;
  }
  hosts.forEach((host) => siteEditor.list.appendChild(userSiteRuleRow(host, rules[host])));
}

function siteRuleHost(host) {
  const name = document.createElement('span');
  name.className = 'site-rule-host';
  name.textContent = host;
  name.title = host;
  return name;
}

function userSiteRuleRow(host, state) {
  const row = document.createElement('div');
  row.className = 'site-rule';
  row.dataset.host = host;
  row.appendChild(siteRuleHost(host));

  // always↔never 是一个二选一，所以是一个 select：两个状态都印得出名字，键盘和
  // 读屏都认得它。改了就写，写失败由 writeSiteRule 重画回原值。
  const select = document.createElement('select');
  select.className = `site-rule-state site-rule-${state}`;
  select.setAttribute('aria-label', host);
  for (const value of ['always', 'never']) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = t(value === 'always' ? 'siteRuleAlways' : 'siteRuleNever');
    select.appendChild(option);
  }
  select.value = state;
  select.addEventListener('change', () => {
    select.disabled = true;
    writeSiteRule(host, select.value);
  });
  row.appendChild(select);

  const forget = document.createElement('button');
  forget.type = 'button';
  forget.className = 'btn btn-text site-rule-forget';
  forget.textContent = t('siteRuleForget');
  forget.addEventListener('click', () => {
    forget.disabled = true;
    writeSiteRule(host, null);
  });
  row.appendChild(forget);

  return row;
}

// 内置那三组：标题键、一键盖过去能写的规则（每个一颗按钮；空 = 盖不过）。
// 字幕站两颗：「连页面一起翻」写 always，「不翻译」写 never —— 字幕照翻不是他
// 要的，一下就停，和 always 组那颗一个写法（R33 N6）。
const OVERRIDE_NEVER = { state: 'never', key: 'siteRuleOverrideNever' };
const OVERRIDE_ALWAYS = { state: 'always', key: 'siteRuleOverrideAlways' };
const BUILTIN_GROUPS = [
  { state: 'always', titleKey: 'siteRulesBuiltinAlways', overrides: [OVERRIDE_NEVER] },
  { state: 'captions', titleKey: 'siteRulesBuiltinCaptions', overrides: [OVERRIDE_ALWAYS, OVERRIDE_NEVER] },
  { state: 'never', titleKey: 'siteRulesBuiltinNever', overrides: [], hintKey: 'siteRulesBuiltinNeverHint' },
];

function renderBuiltinSites(rules) {
  const sites = SiteRules.builtinSites();
  // 重画不该把用户展开着的那一组合上。
  const open = new Set([...siteEditor.builtin.querySelectorAll('details[open]')].map((d) => d.dataset.state));
  siteEditor.builtin.textContent = '';

  const title = document.createElement('p');
  title.className = 'site-rules-builtin-title';
  title.textContent = t('siteRulesBuiltinTitle');
  siteEditor.builtin.appendChild(title);

  for (const group of BUILTIN_GROUPS) {
    const details = document.createElement('details');
    details.className = 'site-rules-builtin-group';
    details.dataset.state = group.state;
    details.open = open.has(group.state);
    const summary = document.createElement('summary');
    summary.textContent = `${t(group.titleKey)} (${sites[group.state].length})`;
    details.appendChild(summary);
    if (group.hintKey) {
      const hint = document.createElement('p');
      hint.className = 'site-rules-empty';
      hint.textContent = t(group.hintKey);
      details.appendChild(hint);
    }
    for (const site of sites[group.state]) details.appendChild(builtinSiteRow(site, group, rules));
    siteEditor.builtin.appendChild(details);
  }
}

function builtinSiteRow(site, group, rules) {
  const row = document.createElement('div');
  row.className = 'site-rule site-rule-builtin';
  row.dataset.host = site.host;
  row.appendChild(siteRuleHost(site.host));

  // arxiv.org 只有几条路径在名单上：印出来，免得以为整个站点都算。
  if (site.patterns.some((pattern) => pattern !== site.host)) {
    const scope = document.createElement('span');
    scope.className = 'site-rule-scope';
    scope.textContent = site.patterns.join(', ');
    row.appendChild(scope);
  }

  if (!group.overrides.length || !site.writable) return row;

  // 用户已经在这个主机（或它的父域）上表过态：那条规则赢，这一行不再给按钮。
  if (SiteRules.lookupUserRule(rules, site.host)) {
    const badge = document.createElement('span');
    badge.className = 'site-rule-state';
    badge.textContent = t('siteRuleOverridden');
    row.appendChild(badge);
    return row;
  }

  const buttons = group.overrides.map(({ state, key }) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-text site-rule-override';
    button.dataset.state = state;
    button.textContent = t(key);
    button.addEventListener('click', () => {
      for (const other of buttons) other.disabled = true;
      writeSiteRule(site.host, state);
    });
    return button;
  });
  row.append(...buttons);
  return row;
}
