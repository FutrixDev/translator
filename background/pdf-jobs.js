// Blab Translation background — document translation jobs.
//
// 接上 pdf-client.js（账号、领票、建作业、轮询）和 pdf-notify.js（通知），这里是
// 把它们串起来的那一层：领票、建作业、确认超页、结果怎么打开、右键菜单的 URL 路径。
// 名字还叫 pdf-*：消息名与存储键是已经交出去的契约，格式由 shared/doc-jobs.js 说了算。

import '../shared/comic-charge.js';
import '../shared/pdf-url.js';
import * as comicClient from './comic-client.js';
import * as pdfClient from './pdf-client.js';
import { defaultSettings, getEffectiveTargetLang } from './settings.js';
import { assertFeatureEnabled } from './feature-gate.js';
import {
  clearPdfConfirmNotification,
  jobIdFromNotificationId,
  logIfFailed,
  notifyPdfConfirm,
  notifyPdfError,
  notifyPdfNotAPdf,
  notifyPdfRunning,
  notifyPdfStarted,
  notifyPdfTerminal,
  pdfMessage,
  pdfNotificationLang,
} from './pdf-notify.js';

const ChargeConfirm = globalThis.ChargeConfirm;
// pdf-client.js imports shared/doc-jobs.js, and imports are evaluated before
// this body runs, so the shelf is there by now.
const DocJobs = globalThis.DocJobs;
// 「这是不是一份 PDF」「它叫什么名字」的唯一实现，见 shared/pdf-url.js。
// 从这里再导出去，是因为右键菜单那一层本来就从这个模块要它们。
const { isLikelyPdfUrl, pdfFileNameFromUrl } = globalThis.PdfUrl;
const { ComicApiError } = comicClient;

// ---------------------------------------------------------------------------
// Document translation jobs (account-backed, see pdf-client.js)
//
// A job runs for minutes — far past the service worker's ~30s idle teardown —
// so nothing here holds a poll loop open. Instead: the popup and the upload
// page poll fast while they are open, and a 1-minute chrome.alarm covers the
// stretches when no UI is looking, firing a notification when a job crosses
// into a state someone has to hear about.
// ---------------------------------------------------------------------------

const PDF_POLL_ALARM = 'pdf-job-poll';

async function ensurePdfPollAlarm() {
  if (await pdfClient.hasActiveJobs()) {
    // periodInMinutes only: no immediate fire, the caller just polled.
    chrome.alarms.create(PDF_POLL_ALARM, { periodInMinutes: 1 });
  } else {
    chrome.alarms.clear(PDF_POLL_ALARM);
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== PDF_POLL_ALARM) return;
  refreshPdfJobs().catch(error => console.error('PDF poll failed:', error));
});

/**
 * Refresh every unsettled record and tell the user what changed.
 *
 * The ONLY place a job's own progress turns into a notification. Every handler
 * a page calls answers a page someone is looking at, and a notification there
 * would announce what the page already shows.
 */
async function refreshPdfJobs() {
  const { records, changes } = await pdfClient.refreshJobRecords();
  for (const change of changes) {
    if (change.leftAwaiting) clearPdfConfirmNotification(change.record.jobId);
    if (change.transition === 'settled') notifyPdfTerminal(change.record);
    else if (change.transition === 'awaiting') notifyPdfConfirm(change.record);
  }
  await ensurePdfPollAlarm();
  return records;
}

// A notification about one job opens that job. Registered at the top level so
// a click that wakes a torn-down worker still finds its listener.
chrome.notifications.onClicked.addListener((notificationId) => {
  const jobId = jobIdFromNotificationId(notificationId);
  if (!jobId) return;
  const clear = () => chrome.notifications.clear(notificationId, logIfFailed);
  // A receipt names no server job: there is nothing to open.
  if (pdfClient.isPendingRecord({ jobId })) {
    clear();
    return;
  }
  openPdfJob(jobId)
    .catch(error => console.warn(`[pdf] opening job ${jobId} from its notification failed:`,
      error?.code || error?.message || error))
    .finally(clear);
});

// ---------------------------------------------------------------------------
// The URL path's charge confirmation
//
// Every other PDF surface asks the question on the surface the user is looking
// at — the upload page in its job card, the popup in its task list. The entries
// that come through startPdfUrlTranslation() have no such surface in common: a
// right-click on a link and the toolbar button can fire from any page at all,
// and that page has no job card to put the question in. (Not for want of a
// content script on the PDF itself — Chrome's viewer does run one, which is
// what content/content-pdf-prompt.js draws its offer bar on. The click simply
// is not tied to any one document.) So this path asks in the one place all of
// its entries already speak: a notification, with the answer as its buttons.
//
// That makes the answer arrive out-of-band, minutes later, quite possibly after
// this worker has been torn down and restarted — which is why the round trip is
// written out here instead of going through ChargeConfirm.submitWithConfirmation
// like the page surfaces do. That helper awaits an answer inside one call, and
// a promise held open across a service-worker teardown is exactly the thing
// MV3 will not keep. The parts that are actual policy — is this a confirmation
// request, what does the quote say, how is the price worded — still come from
// the shared module; only the ordering is different, because the ordering here
// spans two events.
//
// The notification id carries the operation id, and pdfUrlOps still maps that
// back to the URL, so the handshake keeps no state of its own: nothing to
// expire, nothing to leak, and a restarted worker picks it up unchanged.
// ---------------------------------------------------------------------------

const PDF_CHARGE_NOTIFICATION_PREFIX = 'pdf-charge-';

// The PDF wording of the shared price sentence. A comic page and a document
// are priced differently and read differently; the two-numbers-or-neither rule
// they share lives in shared/comic-charge.js.
const PDF_CHARGE_KEYS = { required: 'pdfChargeRequired', fallback: 'pdfChargeConfirm' };

/**
 * Create a URL job from the context menu, asking about the price if the server
 * says there is one.
 *
 * `confirmCharge` is true only on the second pass — the one the notification's
 * own button starts.
 */
async function runPdfUrlJob({ url, operationId, fileName, pageUrl, confirmCharge = false }) {
  try {
    const job = await handlePdfCreateJob({
      source: { kind: 'url', url },
      operationId,
      fileName,
      pageUrl: pageUrl || '',
      confirmCharge
    });
    // A create can resolve to a job that is already over — the idempotent
    // adopt of an earlier attempt that died. No poll transition will ever
    // fire for it, so without this the user saw "started" and then nothing.
    // (handlePdfCreateJob has already released the operation id, so the
    // "try again" in the failure copy is true.)
    if (job && (job.status === 'failed' || job.status === 'abandoned')) {
      notifyPdfError(job.error || { code: job.status });
    } else if (job && DocJobs.isAwaitingStatus(job.status)) {
      // Adopted an earlier attempt that is waiting on the user. The record is
      // already awaiting, so no poll will see it arrive there: ask now.
      notifyPdfConfirm(job);
    }
  } catch (error) {
    if (ChargeConfirm.isConfirmRequired(error)) {
      // Nothing was reserved and no job was created, so there is nothing to
      // report as a failure — only a question to put to the user.
      // The quote reader takes the flat messaging shape every other surface
      // sees; here the error is still a ComicApiError, which keeps the body's
      // extra fields under `details`.
      await askPdfCharge(operationId, fileName,
        ChargeConfirm.readQuote({ code: error.code, ...(error.details || {}) }));
      return;
    }
    notifyPdfError(error);
  }
}

/**
 * 「把这个网址上的 PDF 译了」的唯一入口。
 *
 * 三个地方按下这句话：右键菜单的链接条目、页面条目、工具栏条目
 * （background/context-menus.js），以及 PDF 文档上那条提示条点下的「翻译」
 * （content/content-pdf-prompt.js → PDF_TRANSLATE_URL）。它们看见的是同一套
 * 拦路检查——开关、是不是 PDF、file:// 改走上传页、同一份文档已经在跑——所以检查
 * 写在这里一份，而不是在每个入口各写一遍：少写一条的那个入口会重复扣一次额度。
 *
 * `notifyNotAPdf` 只有工具栏那一个条目是 true：它在任何标签页上都在，是唯一一个
 * 可能正当地落在非 PDF 上的点击，得说一声而不是默不作声。其余入口都是先看见了
 * PDF 才出现的，那里弹一条通知只会是噪音。
 */
async function startPdfUrlTranslation({ url, pageUrl = '', notifyNotAPdf = false }) {
  const settings = await chrome.storage.sync.get(defaultSettings);
  // Same racing-click guard as the comic entries: this costs money.
  if (!settings.enablePdfTranslation) return { started: false, reason: 'disabled' };
  if (!isLikelyPdfUrl(url)) {
    if (notifyNotAPdf) notifyPdfNotAPdf();
    return { started: false, reason: 'not_a_pdf' };
  }
  // file:// can't be fetched from the worker — hand local PDFs to the
  // upload page's file picker instead (PR #26 review).
  if (url.startsWith('file:')) {
    chrome.tabs.create({ url: chrome.runtime.getURL('pdf/upload.html') });
    return { started: false, reason: 'local_file' };
  }
  const fileName = pdfFileNameFromUrl(url);
  // Resolved here rather than inside the create so a second click on the same
  // PDF can be recognised as one: the id is per-URL and stable.
  const operationId = await pdfClient.getOrCreateUrlOperationId(url);
  const records = await pdfClient.listJobRecords();
  const existing = records.find(r => r.operationId === operationId && DocJobs.isUnsettledStatus(r.status));
  if (existing) {
    // Waiting on the user is not "still running": the click is answered by
    // putting the question back in front of them.
    if (DocJobs.isAwaitingStatus(existing.status)) {
      notifyPdfConfirm(existing);
      return { started: false, reason: 'awaiting_confirm' };
    }
    notifyPdfRunning(existing.fileName || fileName);
    return { started: false, reason: 'already_running' };
  }
  // Before the await, not after: the whole point is that the click stops
  // looking like it did nothing.
  notifyPdfStarted(fileName);
  await runPdfUrlJob({ url, operationId, fileName, pageUrl });
  return { started: true };
}

/** "This costs N credits — spend them?", as a notification with two buttons. */
async function askPdfCharge(operationId, fileName, quote) {
  const uiLang = await pdfNotificationLang();
  const t = key => pdfMessage(key, uiLang);
  chrome.notifications.create(`${PDF_CHARGE_NOTIFICATION_PREFIX}${operationId}`, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: t('pdfNotifyChargeTitle'),
    message: `${fileName ? `${fileName}\n` : ''}${ChargeConfirm.chargeText(quote, t, PDF_CHARGE_KEYS)}`,
    buttons: [{ title: t('comicChargeApprove') }, { title: t('comicCancel') }],
    // The question stays until it is answered. A price that scrolled away after
    // a few seconds would leave a click looking like it silently did nothing.
    requireInteraction: true
  }, logIfFailed);
}

chrome.notifications.onButtonClicked.addListener(async (notificationId, buttonIndex) => {
  if (!notificationId.startsWith(PDF_CHARGE_NOTIFICATION_PREFIX)) return;
  chrome.notifications.clear(notificationId);
  // Button 1 is Cancel, and declining is a cancel rather than a failure: the
  // 409 reserved nothing, no job exists, no record was kept. Saying nothing
  // back is the whole of it. (Dismissing the notification says the same.)
  if (buttonIndex !== 0) return;

  const operationId = notificationId.slice(PDF_CHARGE_NOTIFICATION_PREFIX.length);
  const url = await pdfClient.findUrlForOperationId(operationId);
  // The binding aged out (24h) while the notification sat there. There is no
  // longer anything to translate, and re-deriving a URL from an id is not
  // possible — the next click starts a fresh operation anyway.
  if (!url) return;

  const fileName = pdfFileNameFromUrl(url);
  notifyPdfStarted(fileName);
  await runPdfUrlJob({ url, operationId, fileName, confirmCharge: true });
});

// ---------------------------------------------------------------------------
// Upload and create
// ---------------------------------------------------------------------------

function invalidSource(message) {
  return new ComicApiError('invalid_pdf', message, 400);
}

/**
 * PDF_UPLOAD_TICKET: the upload page asks where to PUT the file.
 *
 * The page PUTs the File itself (IRON RULE: the bytes never pass through the
 * Worker, and a 50 MiB file does not fit through runtime messaging either).
 * Only a granted ticket writes the receipt: a refusal has nothing to show.
 */
async function handlePdfUploadTicket(message) {
  await assertFeatureEnabled('enablePdfTranslation');
  const { operationId, byteSize, sourceFormat, fileName } = message;
  if (!DocJobs.isDocumentFormat(sourceFormat)) {
    throw new ComicApiError('unsupported_format', 'This file type is not supported', 400,
      typeof sourceFormat === 'string' && sourceFormat ? { format: sourceFormat } : {});
  }
  if (!Number.isInteger(byteSize) || byteSize <= 0 || !operationId) {
    throw invalidSource('An upload needs an operation id and a positive byte size');
  }
  const ticket = await pdfClient.requestUploadTicket({ operationId, byteSize, sourceFormat });
  const receipt = pdfClient.receiptRecord({ operationId, fileName, sourceFormat });
  await pdfClient.saveJobRecord(receipt);
  return { ...ticket, pendingJobId: receipt.jobId };
}

/**
 * The single entry point every create funnels into: the upload page after its
 * PUT, and the URL path (context menus, toolbar, the PDF offer bar).
 *
 * `source` is `{kind: 'uploaded', sourceKey, sourceFormat}` — the page already
 * PUT the file to the ticket's URL — or `{kind: 'url', url}`, where the worker
 * fetches the PDF (carrying the user's cookies), takes a ticket and PUTs it
 * itself. Either way the create names a storage key, never bytes.
 */
async function handlePdfCreateJob(message) {
  await assertFeatureEnabled('enablePdfTranslation');
  const settings = await chrome.storage.sync.get(defaultSettings);
  const source = message.source || {};

  const isUploaded = source.kind === 'uploaded' && !!source.sourceKey &&
    DocJobs.isDocumentFormat(source.sourceFormat);
  const isUrl = source.kind === 'url' && !!source.url;
  if (!isUploaded && !isUrl) throw invalidSource('No document source was provided');

  let operationId = message.operationId;
  if (!operationId && isUrl) {
    // Minted-and-persisted BEFORE the fetch: a retry after a lost response
    // must replay the same operationId or the server would charge the same
    // PDF twice (PR #26 review).
    operationId = await pdfClient.getOrCreateUrlOperationId(source.url);
  }
  // An uploaded source's key belongs to the operation that took the ticket;
  // a create under any other id would be refused as missing_source.
  if (!operationId) throw invalidSource('A create needs the operation id its upload was made under');

  const sourceFormat = isUploaded ? source.sourceFormat : 'pdf';
  const fileName = message.fileName || (isUrl ? pdfFileNameFromUrl(source.url) : '');

  // The click's receipt, written (or reset) before any network work. For the
  // URL path it is the only row there is during download + ticket + PUT; for
  // an upload it restarts the stale clock at the create and clears a failed
  // row an earlier create left. Every surface reads only these records, and
  // they carry a failure back to a popup that has since closed: the awaited
  // sendMessage promise dies with the popup, this does not.
  const receipt = pdfClient.receiptRecord({ operationId, fileName, sourceFormat });
  const pendingId = receipt.jobId;
  await pdfClient.saveJobRecord(receipt);

  let job;
  try {
    let upload = source;
    if (isUrl) {
      const bytes = await pdfClient.fetchPdfFromUrl(source.url);
      upload = await pdfClient.requestUploadTicket({ operationId, byteSize: bytes.byteLength, sourceFormat });
      await pdfClient.putSource(upload.uploadUrl, bytes, sourceFormat, operationId);
    }
    job = await pdfClient.createJobFromUpload({
      operationId,
      sourceKey: upload.sourceKey,
      sourceFormat,
      fileName: receipt.fileName,
      targetLang: message.targetLang || settings.pdfTargetLang || getEffectiveTargetLang(settings),
      // Only ever true, and only because a surface asked the user first. The
      // worker never decides this on anyone's behalf.
      confirmCharge: message.confirmCharge === true,
      // Only the page measures (shared/doc-measure.js); a URL job is a PDF.
      declaredUnits: isUploaded ? message.declaredUnits : undefined
    });
  } catch (error) {
    const code = (error && error.code) || 'engine_error';
    if (ChargeConfirm.isConfirmRequired({ code })) {
      // Not a failure: the server refused with a question, reserved nothing and
      // created no job. Drop the receipt rather than settle it — a red row
      // saying the translation failed, for a price nobody has been shown yet,
      // is worse than no row, and the confirmed retry replays this same
      // operation id and writes the receipt again. The id is deliberately NOT
      // released: it is the only thing making that retry the same operation.
      await pdfClient.dismissJobRecord(pendingId);
      // Echoed so the caller's retry is provably the same operation rather than
      // one that merely resolves to the same id again (the popup, for one, does
      // not mint its own — see the URL binding above).
      error.details = { ...(error.details || {}), operationId };
      throw error;
    }
    // A 409 of this family means the cached operation id names work that
    // already settled — a failed-then-deleted job, a finalized billing row, or
    // a job with different settings (the target language changed). Replaying
    // it can never succeed, so drop the URL binding: the NEXT click mints a
    // fresh id and actually runs. Everything else (network, auth, quota)
    // keeps the binding — those retries must stay idempotent. (An uploaded
    // source's id has no binding; releasing it is a no-op.)
    if (code === 'operation_already_finished' || code === 'output_conflict' || code === 'job_conflict') {
      await pdfClient.releaseUrlOperationId(operationId);
    }
    await pdfClient.saveJobRecord({
      jobId: pendingId,
      status: 'failed',
      stage: null,
      // The facts the copy interpolates (maxPages, maxBytes, format, …) stay
      // on the record so every surface renders the honest number.
      error: pdfClient.errorRecordFrom(error)
    });
    throw error;
  }

  // The record takes the view's own fields (error and confirm too): a job can
  // come back already terminal — a dispatch failure, or an idempotent re-post
  // of a finished operation — or already awaiting, and it will never get an
  // alarm poll to fill that in later. settledAt follows the status inside
  // replaceJobRecord: terminal only, never for awaiting_confirm.
  await pdfClient.replaceJobRecord(pendingId, {
    jobId: job.jobId,
    operationId: job.operationId,
    fileName: receipt.fileName,
    sourceFormat,
    ...pdfClient.recordFieldsFromView(job)
  });
  if (job.status === 'failed' || job.status === 'abandoned') {
    // Terminal on arrival: either the dispatch just failed, or the create
    // adopted a job that had already died. Both burn the operation id — the
    // server adopts by (user, operationId) regardless of status, so replaying
    // it would return this same dead job for the binding's whole 24h TTL.
    // Released here, the next click starts a genuinely new attempt.
    await pdfClient.releaseUrlOperationId(operationId);
  }
  await ensurePdfPollAlarm();
  return { ...job, fileName: receipt.fileName, sourceFormat };
}

// ---------------------------------------------------------------------------
// One job: history, get, confirm, abandon, open
// ---------------------------------------------------------------------------

/**
 * The settings page's task list: the account's own history, from the server.
 *
 * Server-authoritative on purpose. The local records are a device's cache — 20
 * rows, a TTL, gone with the profile — while "my translations" means
 * everything this account ever ran, from any device. The only rows added on top
 * are the ones the server cannot know about: a create still uploading from
 * here, or one that failed before it ever reached the server. Both carry a
 * synthetic `local:` id, which is exactly how they are recognised.
 *
 * Names are backfilled from the local record when the server has none, so jobs
 * created before the file_name column existed still read as something.
 */
async function handlePdfJobsHistory() {
  const records = await pdfClient.listJobRecords();

  let jobs;
  try {
    jobs = await pdfClient.listPdfJobs();
  } catch (error) {
    // A signed-out account has nothing to show and a sign-in to offer, so that
    // one propagates. Anything else — offline, service down — still has this
    // device's cache, which beats an empty page.
    if (error instanceof comicClient.ComicApiError && error.code === 'unauthorized') throw error;
    return { jobs: records, stale: true };
  }

  const byId = new Map(records.map(r => [r.jobId, r]));
  const merged = jobs.map(job => ({
    ...job,
    fileName: job.fileName || byId.get(job.jobId)?.fileName || ''
  }));
  const local = records.filter(r => pdfClient.isPendingInFlight(r));

  return {
    jobs: [...local, ...merged].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)),
    stale: false
  };
}

/**
 * A job's format and name. The server's view carries no format (saas backlog
 * §11.3), so this device's record is asked first and the view's own file name
 * second; with neither, DocJobs.jobFormat floors at pdf.
 */
function jobFacts(record, view) {
  const fileName = record?.fileName || view?.fileName || '';
  return {
    fileName,
    sourceFormat: DocJobs.jobFormat({ sourceFormat: record?.sourceFormat, fileName })
  };
}

/**
 * Fold a view a page just fetched into this device's record — only if there is
 * one (never mint a record: the settings page lists the whole account, and a
 * row for another device's job would jump to the top of this device's list).
 * Returns the record after the fold, or null.
 */
async function foldPageView(jobId, view) {
  const change = await pdfClient.updateRecordFromView(jobId, view);
  // The question the confirm notification asked is answered or moot.
  if (change?.leftAwaiting) clearPdfConfirmNotification(jobId);
  await ensurePdfPollAlarm();
  return change ? change.record : null;
}

/** Poll one job for a page. Never creates a record (defect 4). */
async function handlePdfJobGet(jobId) {
  const view = await pdfClient.getPdfJob(jobId);
  const record = await foldPageView(jobId, view);
  return { ...view, ...jobFacts(record, view) };
}

/**
 * The user agreed to pay for what the document turned out to be. The job goes
 * back in the queue, so the fold re-arms the alarm, and the notification that
 * asked is withdrawn whatever the fold saw.
 */
async function handlePdfJobConfirm(jobId) {
  const view = await pdfClient.confirmPdfJob(jobId);
  const record = await foldPageView(jobId, view);
  clearPdfConfirmNotification(jobId);
  return { ...view, ...jobFacts(record, view) };
}

async function handlePdfJobAbandon(jobId) {
  const view = await pdfClient.abandonPdfJob(jobId);
  const record = await foldPageView(jobId, view);
  clearPdfConfirmNotification(jobId);
  return { ...view, ...jobFacts(record, view) };
}

/**
 * PDF_OPEN_JOB: open a job from a list row or a notification.
 *
 * A finished PDF opens its file (Chrome shows it); everything else opens the
 * job page, which can save a file, ask for a confirmation or say what went
 * wrong. Always via a fresh poll: a presigned URL a record might hold is
 * minutes old and probably expired. If that poll fails the job page is still
 * the right place — it polls again and shows the error in context.
 */
async function openPdfJob(jobId, which) {
  if (!jobId || pdfClient.isPendingRecord({ jobId })) {
    throw new ComicApiError('result_unavailable', 'This job has not reached the service yet', 404);
  }
  const records = await pdfClient.listJobRecords();
  let record = records.find(r => r.jobId === jobId) || null;
  let target = { kind: 'page' };
  try {
    const view = await pdfClient.getPdfJob(jobId);
    record = (await foldPageView(jobId, view)) || record;
    const { sourceFormat } = jobFacts(record, view);
    target = DocJobs.openTargetFor({ status: view.status, format: sourceFormat, results: view.results }, which);
  } catch (error) {
    console.warn(`[pdf] refreshing job ${jobId} before opening it failed; opening its page:`,
      error?.code || error?.message || error);
  }
  const url = target.kind === 'result' ? target.url : chrome.runtime.getURL(DocJobs.jobPagePath(jobId));
  await chrome.tabs.create({ url });
  return { opened: target.kind };
}

export {
  isLikelyPdfUrl,
  pdfFileNameFromUrl,
  ensurePdfPollAlarm,
  refreshPdfJobs,
  runPdfUrlJob,
  startPdfUrlTranslation,
  handlePdfUploadTicket,
  handlePdfCreateJob,
  handlePdfJobsHistory,
  handlePdfJobGet,
  handlePdfJobConfirm,
  handlePdfJobAbandon,
  openPdfJob,
};
