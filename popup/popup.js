// DOM Elements
const elements = {
  translatePage: document.getElementById('translatePage'),
  translatePageLabel: document.getElementById('translatePageLabel'),
  translatePageShortcut: document.getElementById('translatePageShortcut'),
  translationOnlyShortcut: document.getElementById('translationOnlyShortcut'),
  toggleSiteAuto: document.getElementById('toggleSiteAuto'),
  siteAutoStatus: document.getElementById('siteAutoStatus'),
  stopSiteAuto: document.getElementById('stopSiteAuto'),
  stopSiteAutoLabel: document.getElementById('stopSiteAutoLabel'),
  togglePagePause: document.getElementById('togglePagePause'),
  pagePauseLabel: document.getElementById('pagePauseLabel'),
  openSettings: document.getElementById('openSettings'),
  comicTranslatePage: document.getElementById('comicTranslatePage'),
  comicColorizePage: document.getElementById('comicColorizePage'),
  pdfTranslateCurrent: document.getElementById('pdfTranslateCurrent'),
  pdfTranslateLocal: document.getElementById('pdfTranslateLocal'),
  pdfJobs: document.getElementById('pdfJobs'),
  statusText: document.getElementById('statusText')
};

// Default settings
//
// 只列这个面板真正读的那几个键。targetLang 曾经也在这里，写死 'zh-CN'，而面板
// 里没有一行代码读它 —— 一个从不被读、却和另外三张默认值表不一致的键，是下一个
// 人照着它改出 bug 的地方。
const defaultSettings = {
  // 这三个只为问一件事：AI 引擎要不要 Key（APICompat.isApiKeyMissing，本地模型
  // 不要）。两个字面量与 background/settings.js 一致，default-settings-agree 守。
  provider: 'openai',
  apiEndpoint: 'https://api.openai.com/v1/chat/completions',
  apiKey: '',
  translationEngine: 'builtin',
  autoTranslate: true,
  uiLanguage: '',
  theme: 'light',
  // 「显示」那一行（popup-display.js）
  showTranslationOnly: false,
  translationStyle: 'default'
};

// 内置引擎只有已注入的 content script 答得出（见 content-messaging.js 的
// PROBE_ENGINE）。这条往返要有上限：popup 是个当场要出结果的面板，宁可说
// “不知道”，也不能挂在那儿转。
const ENGINE_PROBE_TIMEOUT_MS = 300;
const PROBE_TIMED_OUT = 'timeout';

// Apply theme
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
}

// Current UI language
let currentUILang = 'en';

// i18n helper
function t(key) {
  return getMessage(key, currentUILang);
}

// Apply i18n to page
function applyI18n(lang) {
  currentUILang = getUILanguage(lang);
  
  // Update all elements with data-i18n attribute
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    const text = t(key);
    if (text && text !== key) {
      el.textContent = text;
    }
  });
}

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
  await checkStatus();
  setupEventListeners();
  refreshComicSection();
  refreshPdfSection();
});

/**
 * Show or hide the two comic entry points.
 *
 * Purely a storage read: the account, its sign-in state and the monthly
 * allowance are all reported in Settings now, so the popup no longer waits on a
 * network round-trip to draw a list of buttons. The local token is enough to
 * know whether this device has an account at all — see shared/account-gate.js.
 */
async function refreshComicSection() {
  // Off means gone, not greyed out: these rows would otherwise advertise a
  // feature with no entry point behind it.
  const { enableComicTranslation } = await AccountGate.applyAccountGate(
    await chrome.storage.sync.get({ enableComicTranslation: false })
  );
  elements.comicTranslatePage.hidden = !enableComicTranslation;
  elements.comicColorizePage.hidden = !enableComicTranslation;
}

// The context menu is the natural home for this, but comic hosts disable it
// often enough that the popup has to be able to start a page on its own. No
// srcUrl to send — the content script picks the page(s) on screen.
async function onComicPageAction(mode) {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs[0]?.id) return;
    chrome.tabs.sendMessage(tabs[0].id, {
      type: 'COMIC_TRANSLATE_PAGE',
      mode,
      pageUrl: tabs[0].url || ''
    });
    window.close();
  } catch (error) {
    console.error('Failed to start comic job:', error);
  }
}

// ---------------------------------------------------------------------------
// PDF translation — entry points and the compact task list
//
// The jobs live on the server and outlast this popup by minutes; the popup is
// only a viewport onto the records the service worker keeps in
// chrome.storage.local['pdfJobs']. While open it polls every 3 seconds so a
// running job visibly moves; the background alarm covers the rest of the time.
// ---------------------------------------------------------------------------

const PDF_UI = globalThis.AI_TRANSLATOR_PDF_UI;
// D9's charge handshake — one implementation, shared with the comic overlay,
// the upload page and the service worker (shared/comic-charge.js).
const ChargeConfirm = globalThis.ChargeConfirm;
// This surface's wording of the shared price sentence.
const PDF_CHARGE_KEYS = { required: 'pdfChargeRequired', fallback: 'pdfChargeConfirm' };
const PDF_POPUP_POLL_MS = 3000;
const PDF_LIST_LIMIT = 3;
// How long a finished job stays in this menu. The records live for a day so the
// settings page has something to show while offline, but this list is not a
// history — it is the readout for what you just started. A failure that outlasts
// the session it belongs to stops being information and becomes a thing you
// have to look at every time you open the menu, which is what a day of
// "翻译超时" was. The full account, kept as long as the server keeps it, is in
// settings; the × below is the way to drop one sooner.
const PDF_SETTLED_VISIBLE_MS = 60 * 60 * 1000;
let pdfPollTimer = null;
// A create error shown inline above the list (sign-in, an exhausted allowance,
// …). Cleared by the next successful action.
let pdfInlineError = null;
// The charge question, when the server has refused an unconfirmed create and
// named its price. One at a time, and only while it is unanswered.
let pdfInlinePrompt = null;
// The row painted on click, before the worker has written anything. It only has
// to survive the few milliseconds until the worker's own pending record lands;
// renderPdfJobs drops it the moment it sees one.
let pdfPlaceholder = null;

async function refreshPdfSection() {
  const { enablePdfTranslation } = await AccountGate.applyAccountGate(
    await chrome.storage.sync.get({ enablePdfTranslation: true })
  );
  if (!enablePdfTranslation) {
    elements.pdfTranslateCurrent.hidden = true;
    elements.pdfTranslateLocal.hidden = true;
    elements.pdfJobs.hidden = true;
    return;
  }
  elements.pdfTranslateLocal.hidden = false;

  // "Translate this PDF" only where it can mean something: the tab is a PDF.
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    elements.pdfTranslateCurrent.hidden = !(tabs[0] && PDF_UI.isLikelyPdfUrl(tabs[0].url));
  } catch (error) {
    elements.pdfTranslateCurrent.hidden = true;
  }

  await refreshPdfJobs({ refresh: false });
  schedulePdfPoll();
}

function schedulePdfPoll() {
  if (pdfPollTimer) clearTimeout(pdfPollTimer);
  pdfPollTimer = setTimeout(async () => {
    await refreshPdfJobs({ refresh: true });
    schedulePdfPoll();
  }, PDF_POPUP_POLL_MS);
}

async function listPdfRecords(refresh = false) {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'PDF_JOBS_LIST', refresh });
    if (response && response.ok) return response.data || [];
  } catch (error) {
    console.error('Failed to list PDF jobs:', error);
  }
  return [];
}

async function refreshPdfJobs({ refresh }) {
  renderPdfJobs(await listPdfRecords(refresh));
}

// The worker writes its records to storage.local; watching them is what makes
// the list move between polls — including the pending row it writes the instant
// a create starts, from the context menu as much as from here.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.pdfJobs) return;
  // Gated off on this device: refreshPdfSection has hidden the whole section
  // and rendering would put it back on screen.
  if (elements.pdfTranslateLocal.hidden) return;
  const records = Array.isArray(changes.pdfJobs.newValue) ? changes.pdfJobs.newValue : [];
  renderPdfJobs(records);
});

/**
 * Anything in flight, and anything that finished recently enough to still be
 * about what the user just did.
 *
 * `settledAt` is stamped when a job crosses into a terminal state. Records
 * written before that field existed fall back to `createdAt`, which ages them
 * out at least as fast — the point is that they go.
 */
function isPdfJobStillWorthShowing(record) {
  if (PDF_UI.isPdfJobActive(record)) return true;
  const settled = record.settledAt || record.createdAt || 0;
  return Date.now() - settled < PDF_SETTLED_VISIBLE_MS;
}

async function dismissPdfJob(jobId) {
  try {
    await chrome.runtime.sendMessage({ type: 'PDF_JOB_DISMISS', jobId });
  } catch (error) {
    console.error('Failed to dismiss PDF job:', error);
  }
}

function renderPdfJobs(records) {
  const list = elements.pdfJobs;
  list.textContent = '';

  if (pdfInlineError) list.appendChild(pdfInlineError);
  // Re-appended on every repaint, so the poll's 3-second cadence cannot wipe
  // an unanswered question off the screen.
  if (pdfInlinePrompt) list.appendChild(pdfInlinePrompt);

  // The worker's own pending record supersedes the placeholder — same row, but
  // one that outlives this popup.
  if (pdfPlaceholder && records.some(r => r.pending)) pdfPlaceholder = null;
  const fresh = records.filter(isPdfJobStillWorthShowing);
  const rows = pdfPlaceholder ? [pdfPlaceholder, ...fresh] : fresh;

  rows.slice(0, PDF_LIST_LIMIT).forEach((record) => {
    const row = document.createElement('div');
    row.className = 'pdf-job';

    const head = document.createElement('div');
    head.className = 'pdf-job-head';
    const name = document.createElement('span');
    name.className = 'pdf-job-name';
    name.textContent = record.fileName || 'PDF';
    name.title = record.fileName || '';
    const status = document.createElement('span');
    status.className = 'pdf-job-status';
    status.textContent = t(PDF_UI.pdfStatusKey(record));
    head.appendChild(name);
    head.appendChild(status);
    row.appendChild(head);

    if (PDF_UI.isPdfJobActive(record)) {
      const track = document.createElement('div');
      track.className = 'pdf-job-track';
      const bar = document.createElement('div');
      bar.className = 'pdf-job-bar';
      bar.style.width = `${Math.max(2, Math.min(100, Math.round(record.progress || 0)))}%`;
      track.appendChild(bar);
      row.appendChild(track);
    } else if (record.status === 'succeeded') {
      const open = document.createElement('button');
      open.className = 'pdf-job-open';
      open.textContent = t('pdfOpen');
      open.addEventListener('click', () => {
        // dual first; the worker falls back to mono when there is none.
        chrome.runtime.sendMessage({ type: 'PDF_OPEN_RESULT', jobId: record.jobId, which: 'dual' });
        window.close();
      });
      head.appendChild(open);
    } else if (record.error) {
      status.classList.add('is-error');
      status.textContent = PDF_UI.pdfErrorMessage(record.error, t);
    }

    // A finished row is dismissable — the placeholder has no jobId yet, and a
    // running job has abandon, not dismiss, as its way out.
    if (!PDF_UI.isPdfJobActive(record) && record.jobId) {
      const dismiss = document.createElement('button');
      dismiss.className = 'pdf-job-dismiss';
      dismiss.textContent = '×';
      dismiss.title = t('pdfDismiss');
      dismiss.setAttribute('aria-label', t('pdfDismiss'));
      dismiss.addEventListener('click', () => {
        // Repaint from what is left rather than waiting for the storage event,
        // so the row goes the moment it is clicked.
        row.remove();
        list.hidden = !list.childElementCount;
        dismissPdfJob(record.jobId);
      });
      head.appendChild(dismiss);
    }

    list.appendChild(row);
  });

  list.hidden = !list.childElementCount;
}

/**
 * Ask the user to spend credits on this PDF, in the list they started it from.
 *
 * Only ever reached from the server's 409: the monthly allowance covers a
 * document without any confirmation at all, so this appears exactly when real
 * credits are about to be spent and never for free work. It is a question, not
 * a failure, so it borrows the error row's layout and none of its red.
 *
 * Resolves true to spend, false to leave the balance alone.
 */
function promptPdfCharge(quote) {
  return new Promise((resolve) => {
    const box = document.createElement('div');
    box.className = 'pdf-job pdf-job-ask';

    const text = document.createElement('span');
    text.className = 'pdf-job-status';
    text.textContent = ChargeConfirm.chargeText(quote, t, PDF_CHARGE_KEYS);

    const answer = (approved) => {
      // The question is over, so its buttons go with it — a late click on a
      // stale Cancel must not land on a paid create that is already in flight.
      pdfInlinePrompt = null;
      box.remove();
      resolve(approved);
    };

    const approve = document.createElement('button');
    approve.className = 'pdf-job-open';
    approve.textContent = t('comicChargeApprove');
    approve.addEventListener('click', () => answer(true));

    const decline = document.createElement('button');
    decline.className = 'pdf-job-decline';
    decline.textContent = t('comicCancel');
    decline.addEventListener('click', () => answer(false));

    box.append(text, approve, decline);
    pdfInlinePrompt = box;
    refreshPdfJobs({ refresh: false });
  });
}

/**
 * Create errors the user can act on right here: a sign-in for 401. Everything
 * else — including a used-up monthly allowance, which nothing but waiting
 * fixes — becomes a plain error line.
 */
function showPdfCreateError(error) {
  const box = document.createElement('div');
  box.className = 'pdf-job pdf-job-error';
  const text = document.createElement('span');
  text.className = 'pdf-job-status is-error';
  text.textContent = PDF_UI.pdfErrorMessage(error, t);
  box.appendChild(text);

  if (error && (error.code === 'unauthorized' || error.loginRequired)) {
    const button = document.createElement('button');
    button.className = 'pdf-job-open';
    button.textContent = t('comicSignIn');
    button.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'COMIC_SIGN_IN' });
      window.close();
    });
    box.appendChild(button);
  }

  pdfInlineError = box;
  refreshPdfJobs({ refresh: false });
}

async function onPdfTranslateCurrent() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    if (!tab || !PDF_UI.isLikelyPdfUrl(tab.url)) return;

    // The background can't fetch file:// URLs — local PDFs go through the
    // upload page's file picker instead (PR #26 review).
    if (tab.url.startsWith('file:')) {
      await chrome.tabs.create({ url: chrome.runtime.getURL('pdf/upload.html') });
      window.close();
      return;
    }

    pdfInlineError = null;
    pdfInlinePrompt = null;
    const fileName = PDF_UI.pdfFileNameFromUrl(tab.url);

    // Paint before sending, not after: creating a job is a download, a
    // presign, an upload and a create — several seconds during which the user
    // would otherwise see nothing and click again. The awaited response below
    // dies with the popup, so it is never what puts the first row on screen.
    const paintUploading = async () => {
      pdfPlaceholder = {
        jobId: 'placeholder',
        fileName,
        status: 'queued',
        pending: true,
        progress: 0
      };
      setPdfBusy(true);
      renderPdfJobs(await listPdfRecords());
    };
    await paintUploading();

    // The operation id the worker minted for this URL, echoed back on a 409.
    // Sending it out again with the confirmation is what makes the paid create
    // the SAME operation rather than a second charge for one document.
    let operationId = null;
    const response = await ChargeConfirm.submitWithConfirmation({
      submit: async (confirmCharge) => {
        const reply = await chrome.runtime.sendMessage({
          type: 'PDF_CREATE_JOB',
          source: { kind: 'url', url: tab.url },
          fileName,
          pageUrl: tab.url,
          ...(operationId ? { operationId } : {}),
          // Only ever true, and only after the user has said so.
          confirmCharge: confirmCharge === true
        }) || { ok: false, error: { code: 'no_response' } };
        if (!reply.ok && reply.error && reply.error.operationId) {
          operationId = reply.error.operationId;
        }
        return reply;
      },
      confirm: async (quote) => {
        // Nothing is uploading while the question stands: the 409 reserved
        // nothing, and a progress row under a price would be a lie.
        setPdfBusy(false);
        pdfPlaceholder = null;
        const approved = await promptPdfCharge(quote);
        if (!approved) return false;
        await paintUploading();
        return true;
      }
    });
    setPdfBusy(false);
    pdfPlaceholder = null;

    // Declining is a cancel, not a failure — nothing was reserved, no job
    // exists, and there is nothing to show but the list as it was.
    if (!response.ok && response.declined) {
      await refreshPdfJobs({ refresh: false });
      return;
    }
    if (!response.ok) {
      showPdfCreateError(response.error);
      return;
    }
    await refreshPdfJobs({ refresh: false });
  } catch (error) {
    console.error('Failed to start PDF job:', error);
    setPdfBusy(false);
    pdfPlaceholder = null;
  }
}

/**
 * The button's in-flight state. Disabling alone is invisible in this popup —
 * .menu-item sets an explicit colour — so popup.css carries a :disabled rule
 * and this also swaps the label to say what is happening.
 */
function setPdfBusy(busy) {
  const button = elements.pdfTranslateCurrent;
  button.disabled = busy;
  const label = button.querySelector('[data-i18n="pdfTranslateThis"]') || button;
  label.textContent = busy ? t('pdfStatusUploading') : t('pdfTranslateThis');
}

function onPdfTranslateLocal() {
  chrome.tabs.create({ url: chrome.runtime.getURL('pdf/upload.html') });
  window.close();
}

// ---------------------------------------------------------------------------
// 这一页的三行动作
//
// 一次 AUTO_PAGE_STATE 往返带回这一页的全部事实：主机名、有没有译文、自动翻译
// 此刻停在哪个状态。三行同时从这一份快照画出来 —— 分三次问的话，用户在中间那
// 一刻点了悬浮球，popup 就会拿着三个互相矛盾的答案画出一张脸。
//
// 没有接收端的页面（chrome://、应用商店、还没注入完的标签页）拿到的是 null，
// 那时只留「翻译此页」一行：另外两行在那种页面上没有任何可做的事，摆在那儿只
// 是一个点了没反应的按钮。
// ---------------------------------------------------------------------------

// 自动翻译真的在管这一页的那几个状态 —— **只决定「暂停这一页」那一行在不在**。
//
// off / ask 不在其中：那时「暂停」无事可停。pending 也不在 —— 它看着像「正要
// 开翻」，其实不是：走到 pending 的**前提**就是第一问已经答了 ask（off 和 auto
// 都当场返回了），而第二问带上语言之后，decide() 的阶梯上剩给它的只有 off
// （同语言 / 不在语言名单里）和 ask 两条，再没有一条通往 auto。
//
// **站点那一行不看它。**「这一页此刻在不在翻」和「这个站点开着自动翻」是两句
// 话，中间隔着一次一次性的「翻译这一页」（见 siteAutoOn()）。
const AUTO_ACTIVE = new Set(['idle', 'running', 'paused', 'error']);

// 这一行该写「继续」而不是「暂停」的状态。和页面那边 resumeCurrentPage() 的门
// 是同一道（PAUSED 或 ERROR）—— 那边早就支持把出错的一页重跑，这边要是只认
// paused，按钮就印着「暂停」，点下去把 ERROR 变成 PAUSED，用户得重开 popup 再
// 点一次才轮到重试。出错的一页正是最需要一下点中的那一页。
const AUTO_RESUMABLE = new Set(['paused', 'error']);

let pageState = null;
let globalAuto = true;

async function sendToActiveTab(message) {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabId = tabs[0] && tabs[0].id;
    if (typeof tabId !== 'number') return null;
    return (await chrome.tabs.sendMessage(tabId, message)) || null;
  } catch (error) {
    // “Could not establish connection” —— 这一页没有 content script。是答案，不是故障。
    return null;
  }
}

// 命令名 → 印它键位的那块 kbd。
const SHORTCUT_KBDS = {
  'toggle-translate-page': elements.translatePageShortcut,
  'toggle-translation-only': elements.translationOnlyShortcut,
};

/**
 * 键位印的是 chrome.commands.getAll() 报的那一个，不是 manifest 里写的那一个。
 * 用户在 chrome://extensions/shortcuts 里改掉、或者和别的扩展撞了被 Chrome 收
 * 走之后，manifest 那行就成了假话；Chrome 报空字符串时这块 kbd 直接不出现。
 */
async function refreshShortcutHint() {
  let commands = [];
  try {
    commands = await chrome.commands.getAll();
  } catch (error) {
    console.warn('Blab Translation: could not read shortcuts', error);
  }
  for (const [name, kbd] of Object.entries(SHORTCUT_KBDS)) {
    const found = commands.find((command) => command.name === name);
    const shortcut = (found && found.shortcut) || '';
    kbd.textContent = shortcut;
    kbd.hidden = !shortcut;
  }
}

/**
 * 这一下按下去是不是「收起译文」。
 *
 * 按钮上那行字和那道 key 门问的是同一件事，所以只有一个出处。收起是纯 DOM，
 * 一个请求都不发；其余两种都可能开译 —— 没译文当然是译，**译文藏着那种也是**：
 * 页面那边走的是 `translatePage()`，放出旧译文的同时把这一页新长出来的块补上，
 * 那些块要花钱。
 */
function isHideAction() {
  return !!(pageState && pageState.hasTranslations && pageState.translationsVisible);
}

/**
 * 站点那一行印「开」还是「关」—— 画它的时候和点它的时候问的必须是同一句，否则
 * 用户看见「开」、点下去写的却是一条「开」的规则。所以两处共用这一个。
 *
 * 问的是**这个站点自己会不会翻这一页**。不是 siteRules 里写了什么，也不是这一
 * 页此刻在不在翻 —— 两头都会撒谎：
 *
 *   - 只看规则表：x.com 内置就是 always，表里一条没有，写「关」是撒谎；
 *   - 只看状态：用户在一个没设过规则的站点上点一次「翻译这一页」（没勾「总是」），
 *     这一页确实在翻，可站点一条规则都没落地。写「开」是撒谎，而他顺手去点那个
 *     看起来已经开着的开关，写进去的是一条**永久的 never** —— 他想开，反倒关死
 *     了。popup 问完就不再听，这个字会一直错到它关掉。
 *
 * 这句话只有页面答得了（规则表、内置名单、黑名单、总开关、他在这一页表过的态，
 * 全在它那边），所以它由 AUTO_PAGE_STATE 一起带回来，popup 只管读。
 */
function siteAutoOn() {
  return !!(pageState && pageState.auto && pageState.auto.siteAuto);
}

function renderPageRows() {
  const auto = pageState && pageState.auto;
  const status = auto ? auto.status : '';

  // ① 这个站点。「开」是什么意思见 siteAutoOn()。
  const siteRow = !!(pageState && pageState.host);
  elements.toggleSiteAuto.hidden = !siteRow;
  if (siteRow) {
    const on = siteAutoOn();
    // 黑名单这一行是死的，不是关着的。阶梯上黑名单排在所有站点规则前面，所以往
    // 规则表里写一条 always 下去，这一页照样不翻 —— 点了没反应还不是最糟的，最
    // 糟的是这一点顺手把总开关打开了，别的站点全跟着自动翻起来，而他本来只想管
    // 眼前这一个。灰掉，并且把为什么写在 title 上。
    //
    // 问的是页面单独回的那两句，不是 auto.reason：总开关关着时 reason 是
    // GLOBAL_OFF，黑名单被它整个遮住 —— 那正是这个开关最该灰着的时候。
    //
    // 「灰不灰」和「为什么灰」是两个问题，答案来自两处但同一个主人：
    // 前者是 SiteRules.siteRuleWritable()，和字幕菜单、悬浮球菜单第一项问的
    // 是同一句话；后者只有黑名单说得出一句人话。从前这里只问黑名单，于是
    // file:// 页面上这一行看起来能点 —— 按下去 setSiteAuto 抛，用户拿到的是
    // 一句「没存上」，而另外两处早就把它灰掉了。
    //
    // 缺省朝「灰掉」那边倒：扩展刚更新、这一个标签页里跑的还是旧的内容脚本时，
    // 这个字段是 undefined。灰着的行点不动，画成能点的行按下去会把总开关打开。
    const writable = !!pageState.ruleWritable;
    elements.toggleSiteAuto.disabled = !writable;
    elements.siteAutoStatus.textContent = on ? t('on') : t('off');
    elements.toggleSiteAuto.title = pageState.blocked ? t('autoReasonBlocklist') : pageState.host;
  }

  // ①b 不再自动翻译这个站点。字幕在一个没设过规则的站点上照翻（闸门问的是「没
  //    被明令拒绝」），上一行却印着「关」—— 那一行不改画法，理由见 siteAutoOn()。
  //    露不露由页面答（captionStopSite），和播放器菜单里同一行是同一个函数。
  const stopRow = !!(siteRow && pageState.captionStopSite);
  elements.stopSiteAuto.hidden = !stopRow;
  if (stopRow) {
    elements.stopSiteAutoLabel.textContent =
      t('autoStopSite').replace('{site}', SiteRules.siteLabel(pageState.host));
  }

  // ② 翻译 / 还原。藏起来的译文算有译文：再点一次该是放出来，不是重译一遍，
  //    那一遍要花的是用户自己的钱。
  const showing = isHideAction();
  elements.translatePageLabel.textContent = showing ? t('hideTranslations') : t('translateCurrentPage');

  // ③ 暂停 / 继续这一页。
  const pauseRow = AUTO_ACTIVE.has(status);
  elements.togglePagePause.hidden = !pauseRow;
  if (pauseRow) {
    elements.pagePauseLabel.textContent =
      AUTO_RESUMABLE.has(status) ? t('popupResumePage') : t('popupPausePage');
  }
}

async function refreshPageRows() {
  pageState = await sendToActiveTab({ type: 'AUTO_PAGE_STATE' });
  renderPageRows();
}

/**
 * 站点开关。开写 always、关写 never，开的时候顺带打开总开关 —— 这几条规矩和
 * 它们的理由都在 SiteRules.setSiteAuto() 里。界面上每一处写「这个站点自动翻」
 * 的地方说的都是这同一句话，所以走的都是那一份实现。
 */
async function toggleSiteAuto() {
  if (!pageState || !pageState.host) return;
  // 键盘能走到一个 disabled 的按钮上、扩展页面也能被脚本点，所以画面上灰掉之外
  // 这里再挡一道：写不进去的站点，别让这一下的副作用（开总开关）自己跑掉。
  if (!pageState.ruleWritable) return;
  const on = siteAutoOn();
  try {
    await SiteRules.setSiteAuto(pageState.host, !on);
    if (!on) globalAuto = true;
  } catch (error) {
    // 这条写入是会失败的：同步存储每项 8KB，站点规则表按域名一路长下去。
    // 失败了就得说一声——开关是个乐观控件，它已经在用户眼里动过了，而规则没
    // 写进去，页面下一次打开照旧。一行控制台日志只有我们看得见。
    console.error('Failed to write site rule:', error);
    showStatus('popupSiteRuleFailed', false);
    await refreshPageRows();
    return;
  }
  // 规则一落地，页面那边的调度层就会重判重跑（siteRules 在 RESTART_KEYS 里）。
  // 它跑完才知道新状态是什么，所以这里重新问一次页面，而不是自己猜一个画上去。
  await refreshPageRows();
}

/**
 * 「不再自动翻译 {site}」—— 只写 never，写入还是 SiteRules.setSiteAuto 那一份。
 * 失败的处理、写完重新问页面，都和上面那一行一样。
 */
async function stopSiteAuto() {
  if (!pageState || !pageState.host || !pageState.captionStopSite) return;
  try {
    await SiteRules.setSiteAuto(pageState.host, false);
  } catch (error) {
    console.error('Failed to write site rule:', error);
    showStatus('popupSiteRuleFailed', false);
  }
  await refreshPageRows();
}

async function togglePageTranslation() {
  const reply = await sendToActiveTab({ type: 'TOGGLE_PAGE_TRANSLATION' });
  if (!reply) {
    showStatus('translationFailed', false);
    return;
  }
  if (reply.action === 'translating') showStatus('translating');
  // 还原是当场就看得见的，popup 没必要再留着挡视线。
  window.close();
}

/**
 * 「暂停 / 继续这一页」。
 *
 * 这颗按钮是 popup 打开那一刻画的，而那一页还在跑。popup 问完就不再听
 * （refreshPageRows 是一问一答，没有任何东西会把新状态推过来），所以他盯着这颗
 * 按钮的这几秒里，那一轮可能已经失败了。
 *
 * 拿开着时那份快照去写的样子：他看着「暂停」点下去，送出去的是 paused:true，
 * 而这一页此刻停在 ERROR —— 从 popup 来的这一下不带 cause:'hidden'，
 * pauseCurrentPage 里那道 ERROR 守卫拦不住它（content-auto-translate.js:568），
 * 于是「出错」被改写成「已暂停」，那句「为什么停了」就此没人说得出，而那一行本
 * 来正是他重试的入口。
 *
 * 所以点下去先重新问一页。状态要是变过，这一下瞄的其实是另一颗按钮 —— 重画就
 * 够了，不替他按。标签当场从「暂停」变成「继续」，他看得见发生了什么。
 */
async function togglePagePause() {
  const drawn = pageState && pageState.auto ? pageState.auto.status : '';
  await refreshPageRows();
  const live = pageState && pageState.auto ? pageState.auto.status : '';
  if (!AUTO_ACTIVE.has(live)) return;
  if (AUTO_RESUMABLE.has(drawn) !== AUTO_RESUMABLE.has(live)) return;
  const auto = await sendToActiveTab({
    type: 'SET_AUTO_PAUSED', paused: !AUTO_RESUMABLE.has(live)
  });
  if (pageState) pageState.auto = auto;
  renderPageRows();
}

// Check API status and float ball state
async function checkStatus() {
  try {
    const settings = await chrome.storage.sync.get(defaultSettings);
    
    // Apply theme
    applyTheme(settings.theme || 'light');
    
    applyI18n(settings.uiLanguage);
    setupDisplayRow(settings);
    
    globalAuto = settings.autoTranslate !== false;
    await Promise.all([refreshPageRows(), refreshShortcutHint()]);

    await refreshEngineStatus(settings);
  } catch (error) {
    console.error('Failed to check status:', error);
  }
}

/**
 * 问当前标签页：内置引擎在你那儿能用吗。
 *
 * 三种结果，含义互不相同，绝不能揉成一个：
 *   一个 probe 对象  —— content script 如实回答了
 *   PROBE_TIMED_OUT —— 它在那儿，只是没来得及答；这不是故障的证据
 *   null            —— 这一页压根没有 content script（chrome:// 、应用商店、
 *                      未注入的标签页），那是个答案，不是一次失败
 */
async function probeActiveTabEngine() {
  let tabId;
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = tabs[0] && tabs[0].id;
  } catch (error) {
    return null;
  }
  if (!tabId) return null;

  const timeout = new Promise((resolve) => setTimeout(() => resolve(PROBE_TIMED_OUT), ENGINE_PROBE_TIMEOUT_MS));
  try {
    const reply = await Promise.race([
      chrome.tabs.sendMessage(tabId, { type: 'PROBE_ENGINE' }),
      timeout
    ]);
    return reply || null;
  } catch (error) {
    // “Could not establish connection” 之类：这一页没有接收端。
    return null;
  }
}

async function refreshEngineStatus(settings) {
  // 自定义接口那条路与页面无关，别为它多跑一次往返。
  const probe = settings.translationEngine === 'ai' ? null : await probeActiveTabEngine();
  const status = EngineStatus.describeEngineStatus(
    settings,
    probe === PROBE_TIMED_OUT ? EngineStatus.UNKNOWN_PROBE : probe
  );
  renderStatus(status);
}

function renderStatus(status) {
  const detail = status.detailKey ? t(status.detailKey) : '';
  const text = detail ? `${t(status.key)} · ${detail}` : t(status.key);
  elements.statusText.textContent = text;
  // 底栏一行放不下就截断，完整的话留在 title 里。
  elements.statusText.title = text;
  document.body.classList.toggle('status-error', !status.ok);
}

/**
 * 底栏那一行只有这一个写入口。
 *
 * 文字和那颗状态点是一对：以前 translationFailed 只改文字，点还是绿的，
 * 而 status-error 只加不减，一次失败能把它红到 popup 关掉为止。让它们分开
 * 各写各的，迟早再错一次。
 */
function showStatus(key, ok = true) {
  renderStatus({ key, detailKey: '', ok });
}

/**
 * 「翻译此页」那一行按下去之前，唯一还要拦一次的事：自定义接口没有 key。
 *
 * 内置引擎（默认）不需要 key，所以这道门只对 'ai' 开 —— 按 apiKey 一刀切会把
 * 新用户挡在主操作外面（PR #26 的评审）。过了这道门，动作本身交给页面：
 * 「有译文就收起来，没有就译」这条规则只能有一个地方说了算，那就是页面。
 *
 * 门也只对「真要开译」的那一下开。按钮上写着「收起译文」的那一下是纯 DOM，一
 * 个请求都不发，拿 key 去拦它，点下去弹出的是设置页、而译文还在原地：用内置引
 * 擎译完、事后把引擎换成自定义的人，从此连自己那一页都收不起来。反过来，译文
 * 藏着的那一下**不是**纯 DOM —— 它会顺带补上新长出来的块，那些块要花钱，门得
 * 拦得住。两边问的是同一个 isHideAction()。
 */
async function translateCurrentPage() {
  try {
    const willTranslate = !isHideAction();
    const settings = await chrome.storage.sync.get(defaultSettings);
    if (willTranslate && settings.translationEngine === 'ai' && APICompat.isApiKeyMissing(settings)) {
      showStatus('configureApiKeyFirst', false);
      chrome.runtime.openOptionsPage();
      return;
    }
    await togglePageTranslation();
  } catch (error) {
    console.error('Failed to translate page:', error);
    showStatus('translationFailed', false);
  }
}

// Open settings page
function openSettings() {
  chrome.runtime.openOptionsPage();
  window.close();
}

// Setup event listeners
function setupEventListeners() {
  elements.translatePage.addEventListener('click', translateCurrentPage);
  elements.toggleSiteAuto.addEventListener('click', toggleSiteAuto);
  elements.stopSiteAuto.addEventListener('click', stopSiteAuto);
  elements.togglePagePause.addEventListener('click', togglePagePause);
  elements.openSettings.addEventListener('click', openSettings);
  elements.comicTranslatePage.addEventListener('click', () => onComicPageAction('translate'));
  elements.comicColorizePage.addEventListener('click', () => onComicPageAction('colorize'));
  elements.pdfTranslateCurrent.addEventListener('click', onPdfTranslateCurrent);
  elements.pdfTranslateLocal.addEventListener('click', onPdfTranslateLocal);
}
