// Blab Translation 设置页 —— Blab Translation 引擎能不能选（设计 §5.4）
//
// options.html 按顺序加载的普通脚本，和 options.js 共用同一个全局词法作用域：
// 这里声明的函数在 options.js / options-account.js 里直接叫名字就能用，反过来
// 也一样（调用发生在 DOMContentLoaded 之后，声明早就求值完了）。
//
// 两个引擎下拉（翻译引擎、自动翻译引擎）各有一个 Blab 选项和它下面的一条说明。
// 能不能用只问 Engines.blabAccess(account)，账户就是账号卡片刚画的那一份
// （showAccount 记下，见 options-account.js），设置页打开时那一次是 force 拉的，
// 不吃 30 秒缓存。三种状态：
//
//   signed_out     选项禁用；说明「登录并订阅后可用」+ 登录按钮（账号卡片那条登录流程）
//   plan_required  选项禁用；说明「订阅后可用」+ 定价页链接（{apiBase}/app/pricing）
//   available      选项可选；选中时说明「文字发到 Blab 的服务器、订阅包含、每天 X、
//                  今天已用 Y」，两个数都取接口返回值
//
// 已经选了 Blab 后来不能用了（退出登录、订阅到期）：选择原样保留、不写设置，
// 说明换成警告样式，前面多一句「已选但现在用不了」，入口照旧。
//
// 账户还没答（加载中）或者没答上（网络错）：选项禁用、说明收起 —— 服务端没说
// 能用就是没说能用，和划词卡换引擎的判断（content/engine/model.js）一致。

/** The account the account card last drew, or null before one has arrived. */
let blabAccount = null;

/** Each engine select and the note under it. */
const BLAB_NOTES = [
  { select: 'translationEngine', note: 'translationEngineBlabNote' },
  { select: 'autoTranslateEngine', note: 'autoTranslateEngineBlabNote' },
];

/** Remember the account the card just drew; renderAccountFeatures() draws it. */
function rememberBlabAccount(account) {
  blabAccount = account;
}

/**
 * Where Blab Translation stands for this device, or null when nothing has been
 * answered yet. A known sign-out (`comicSignedIn === false`) outranks the last
 * account drawn: sign-out does not fetch a new one.
 */
function currentBlabAccess() {
  if (comicSignedIn === false) return Engines.BLAB_ACCESS.SIGNED_OUT;
  return blabAccount ? Engines.blabAccess(blabAccount) : null;
}

/** Draw both selects' Blab option and note. Called on every account transition
 *  and whenever either select changes. */
function renderBlabEngine() {
  const access = currentBlabAccess();
  for (const { select, note } of BLAB_NOTES) {
    const element = elements[select];
    element.querySelector('option[value="blab"]').disabled = access !== Engines.BLAB_ACCESS.AVAILABLE;
    renderBlabNote(document.getElementById(note), access, element.value === 'blab');
  }
}

function blabCount(value) {
  return Number.isFinite(value) ? value.toLocaleString(currentUILang) : '—';
}

function renderBlabNote(note, access, selected) {
  const unavailable = access === Engines.BLAB_ACCESS.SIGNED_OUT || access === Engines.BLAB_ACCESS.PLAN_REQUIRED;
  note.hidden = access === null || (access === Engines.BLAB_ACCESS.AVAILABLE && !selected);
  note.classList.toggle('blab-note-warning', unavailable && selected);
  if (note.hidden) {
    note.replaceChildren();
    return;
  }
  const parts = [];
  if (unavailable && selected) parts.push(blabNoteText(t('blabNoteSelectedUnavailable')));
  if (access === Engines.BLAB_ACCESS.AVAILABLE) {
    const usage = blabAccount.blabTranslation;
    parts.push(blabNoteText(t('blabNoteAvailable')
      .replace('{limit}', blabCount(usage.limit))
      .replace('{used}', blabCount(usage.used))));
  } else if (access === Engines.BLAB_ACCESS.SIGNED_OUT) {
    parts.push(blabNoteText(t('blabNoteSignedOut')), blabSignInButton());
  } else {
    parts.push(blabNoteText(t('blabNotePlanRequired')), blabPricingLink());
  }
  note.replaceChildren(...parts);
}

function blabNoteText(text) {
  const span = document.createElement('span');
  span.className = 'blab-note-text';
  span.textContent = text;
  return span;
}

/** The account card's own sign-in flow; a success redraws through showAccount(). */
function blabSignInButton() {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn btn-secondary blab-note-action';
  button.textContent = t('comicSignIn');
  button.addEventListener('click', () => { comicSignIn(); });
  return button;
}

function blabPricingLink() {
  const link = document.createElement('a');
  link.className = 'blab-note-action';
  link.href = `${accountSiteBase}/app/pricing`;
  link.target = '_blank';
  link.rel = 'noopener';
  link.textContent = t('blabSubscribe');
  return link;
}

function setupBlabEngine() {
  for (const { select } of BLAB_NOTES) elements[select].addEventListener('change', renderBlabEngine);
  renderBlabEngine();
}
