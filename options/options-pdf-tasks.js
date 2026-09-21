// Blab Translation 设置页 —— PDF 任务列表
//
// options.html 按顺序加载的普通脚本，和 options.js 共用同一个全局词法作用域：
// 这里声明的函数在 options.js 里直接叫名字就能用，反过来也一样（调用发生在
// DOMContentLoaded 之后，声明早就求值完了）。

// ---------------------------------------------------------------------------
// PDF tasks
//
// The account's own translation jobs, read from the server. Deliberately not
// the extension's local records: those are a device cache (20 rows, 24-hour
// TTL, gone with the browser profile) while this list answers "what have I
// translated", which spans devices and reinstalls. The service worker merges in
// the one thing the server cannot know yet — an upload still in flight from
// this device — and hands back the combined list.
//
// Polled only while something is running, and only while this page is visible.
// ---------------------------------------------------------------------------

const PDF_TASKS_POLL_MS = 5000;
const PDF_UI = globalThis.AI_TRANSLATOR_PDF_UI;
const PDF_TASK_LANG_KEYS = {
  'zh-CN': 'langZhCN', 'zh-TW': 'langZhTW', en: 'langEn', ja: 'langJa', ko: 'langKo',
  fr: 'langFr', de: 'langDe', es: 'langEs', pt: 'langPt', ru: 'langRu'
};
let pdfTasksTimer = null;
/** What the last fetch was made for. renderAccountFeatures runs on every load
 *  and every account change; only a change in either half is worth a request. */
let pdfTasksFetchedFor = null;
/**
 * Where the account lives on the web. Empty until the service worker answers,
 * which is why every link built from it is conditional: a row that renders
 * before the reply simply has no link, and the next render has one.
 */
let accountSiteBase = '';

/**
 * Ask once per page load. The origin is a constant with a storage override, so
 * it does not change under an open settings page, and re-asking on every
 * refresh would be a message per five-second poll for a value that never moves.
 */
async function loadAccountSiteBase() {
  let response;
  try {
    response = await chrome.runtime.sendMessage({ type: 'ACCOUNT_SITE_BASE' });
  } catch (error) {
    response = null;
  }
  accountSiteBase = (response && response.ok && response.data && response.data.base) || '';

  const link = elements.pdfTasksLibraryLink;
  if (!link) return;
  const href = PDF_UI.pdfLibraryUrl(accountSiteBase);
  link.href = href;
  link.hidden = !href;
}

/** Driven by renderAccountFeatures: the list follows the switch it belongs to. */
function syncPdfTasksVisibility(visible) {
  if (!elements.pdfTasksCard) return;
  elements.pdfTasksCard.hidden = !visible;
  const key = `${visible}:${comicSignedIn}`;
  if (key === pdfTasksFetchedFor) return;
  pdfTasksFetchedFor = key;
  stopPdfTasksPoll();
  // Signing in is the case this exists for: the first render can run before the
  // account has answered, and the list it drew then was a sign-in prompt.
  if (visible) refreshPdfTasks();
}

function stopPdfTasksPoll() {
  if (pdfTasksTimer) clearTimeout(pdfTasksTimer);
  pdfTasksTimer = null;
}

function schedulePdfTasksPoll(hasActive) {
  stopPdfTasksPoll();
  if (!hasActive || elements.pdfTasksCard.hidden || document.hidden) return;
  pdfTasksTimer = setTimeout(() => refreshPdfTasks({ quiet: true }), PDF_TASKS_POLL_MS);
}

async function refreshPdfTasks({ quiet = false } = {}) {
  if (!quiet) setPdfTasksMessage(t('pdfTasksLoading'));
  let response;
  try {
    response = await chrome.runtime.sendMessage({ type: 'PDF_JOBS_HISTORY' });
  } catch (error) {
    response = null;
  }

  if (!response || !response.ok) {
    // Signed out is not an error to report — it is a sign-in to offer.
    if (response && response.error && response.error.code === 'unauthorized') {
      renderPdfTasksSignedOut();
      return;
    }
    if (quiet) {
      // Leave whatever is on screen; a later poll retries.
      schedulePdfTasksPoll(true);
      return;
    }
    showPdfTaskGroups([], []);
    setPdfTasksMessage(t('pdfTasksError'));
    return;
  }

  const jobs = (response.data && response.data.jobs) || [];
  const active = jobs.filter(job => PDF_UI.isPdfJobActive(job));
  showPdfTaskGroups(active, jobs.filter(job => !PDF_UI.isPdfJobActive(job)));

  if (!jobs.length) setPdfTasksMessage(t('pdfTasksEmpty'));
  else if (response.data && response.data.stale) setPdfTasksMessage(t('pdfTasksOffline'));
  else setPdfTasksMessage('');

  schedulePdfTasksPoll(active.length > 0);
}

function setPdfTasksMessage(text, extraNode = null) {
  const box = elements.pdfTasksState;
  box.textContent = text || '';
  if (extraNode) box.appendChild(extraNode);
  box.hidden = !box.childNodes.length;
}

function renderPdfTasksSignedOut() {
  stopPdfTasksPoll();
  showPdfTaskGroups([], []);
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn btn-text';
  button.textContent = t('comicSignIn');
  button.addEventListener('click', async () => {
    // Same shared flow the switches use, so two sign-ins never race.
    if (await comicSignIn()) refreshPdfTasks();
  });
  setPdfTasksMessage(t('pdfTasksSignedOut'), button);
}

function showPdfTaskGroups(active, history) {
  renderPdfTaskList(elements.pdfTasksActiveList, active);
  renderPdfTaskList(elements.pdfTasksHistoryList, history);
  elements.pdfTasksActiveGroup.classList.toggle('hidden', !active.length);
  elements.pdfTasksHistoryGroup.classList.toggle('hidden', !history.length);
}

function renderPdfTaskList(list, jobs) {
  list.textContent = '';
  jobs.forEach(job => list.appendChild(pdfTaskRow(job)));
}

function pdfTaskRow(job) {
  const row = document.createElement('div');
  row.className = 'pdf-task';

  const name = document.createElement('div');
  name.className = 'pdf-task-name';
  name.textContent = job.fileName || t('pdfTasksUnnamed');
  name.title = name.textContent;

  const meta = document.createElement('div');
  meta.className = 'pdf-task-meta';
  meta.textContent = pdfTaskMeta(job);

  const main = document.createElement('div');
  main.className = 'pdf-task-main';
  main.appendChild(name);
  main.appendChild(meta);
  row.appendChild(main);

  if (PDF_UI.isPdfJobActive(job)) {
    const track = document.createElement('div');
    track.className = 'pdf-task-track';
    const bar = document.createElement('div');
    bar.className = 'pdf-task-bar';
    bar.style.width = `${Math.max(2, Math.min(100, Math.round(job.progress || 0)))}%`;
    track.appendChild(bar);
    main.appendChild(track);
  }

  const actions = document.createElement('div');
  actions.className = 'pdf-task-actions';

  // The web library, opened on this job. Offered for every row the server
  // knows about, not only the finished ones: the library renders the original
  // too, so it answers "what was this?" for a job that failed and "how far has
  // it got?" for one still running. `pdfLibraryUrl` returns '' for a pending
  // record, whose id names no server job yet.
  const libraryUrl = PDF_UI.pdfLibraryUrl(accountSiteBase, job.jobId);
  if (libraryUrl) {
    const view = document.createElement('a');
    view.className = 'pdf-task-view';
    view.href = libraryUrl;
    view.target = '_blank';
    view.rel = 'noopener';
    view.textContent = t('pdfTasksViewOnWeb');
    actions.appendChild(view);
  }

  if (!PDF_UI.isPdfJobActive(job) && job.status === 'succeeded' && !job.pending) {
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'btn btn-text pdf-task-open';
    open.textContent = t('pdfOpen');
    // Never the URL the list came with: presigned links expire in minutes and
    // this page can sit open for hours, so the worker re-signs at click time.
    open.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'PDF_OPEN_RESULT', jobId: job.jobId, which: 'dual' });
    });
    actions.appendChild(open);
  }

  if (actions.childNodes.length) row.appendChild(actions);

  return row;
}

/** "12 pages · Chinese · Done · Aug 6, 14:20" — whichever of those are known. */
function pdfTaskMeta(job) {
  const parts = [];
  if (job.pageCount) parts.push(t('pdfTasksPages').replace('{count}', job.pageCount));
  const langKey = PDF_TASK_LANG_KEYS[job.targetLang];
  if (langKey) parts.push(t(langKey));
  parts.push(job.status === 'failed' && job.error
    ? PDF_UI.pdfErrorMessage(job.error, t)
    : t(PDF_UI.pdfStatusKey(job)));
  if (job.createdAt) {
    const at = new Date(job.createdAt);
    if (!Number.isNaN(at.getTime())) {
      parts.push(at.toLocaleString(currentUILang, {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
      }));
    }
  }
  return parts.join(' · ');
}
