// Blab Translation background — PDF 翻译任务。
//
// 接上 pdf-client.js（账号、上传、轮询）和 pdf-notify.js（通知），这里是把它们
// 串起来的那一层：右键点下去到底创不创任务、要不要先问价、结果怎么打开。

import '../shared/comic-charge.js';
import * as comicClient from './comic-client.js';
import * as pdfClient from './pdf-client.js';
import { defaultSettings, getEffectiveTargetLang } from './settings.js';
import { assertFeatureEnabled } from './feature-gate.js';
import {
  notifyPdfError,
  notifyPdfStarted,
  notifyPdfTerminal,
  pdfMessage,
  pdfNotificationLang,
} from './pdf-notify.js';

const ChargeConfirm = globalThis.ChargeConfirm;

// ---------------------------------------------------------------------------
// PDF translation jobs (account-backed, see pdf-client.js)
//
// A PDF job runs for minutes — far past the service worker's ~30s idle
// teardown — so nothing here holds a poll loop open. Instead: the popup and
// the upload page poll fast while they are open, and a 1-minute chrome.alarm
// covers the stretches when no UI is looking, firing a notification when a job
// crosses into a terminal state.
// ---------------------------------------------------------------------------

const PDF_POLL_ALARM = 'pdf-job-poll';

function isLikelyPdfUrl(url) {
  if (!url) return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!/^(https?|file):$/.test(parsed.protocol)) return false;
  if (/\.pdf$/i.test(parsed.pathname)) return true;
  // arXiv serves PDFs from extensionless /pdf/<id> paths.
  if (/(^|\.)arxiv\.org$/i.test(parsed.hostname) && /^\/pdf\//.test(parsed.pathname)) return true;
  return false;
}

function pdfFileNameFromUrl(url) {
  try {
    const parsed = new URL(url);
    const segment = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() || '');
    if (segment) return /\.pdf$/i.test(segment) ? segment : `${segment}.pdf`;
  } catch {
    // Fall through to the generic name.
  }
  return 'document.pdf';
}

/** Base64 → ArrayBuffer, chunk-free: atob handles the whole string at once. */
function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

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

/** Refresh every active record; notify for jobs that just finished. */
async function refreshPdfJobs() {
  const { records, transitions } = await pdfClient.refreshJobRecords();
  for (const record of transitions) {
    notifyPdfTerminal(record);
  }
  await ensurePdfPollAlarm();
  return records;
}

// ---------------------------------------------------------------------------
// The context menu's charge confirmation
//
// Every other PDF surface asks the question on the surface the user is looking
// at — the upload page in its job card, the popup in its task list. The context
// menu has no surface at all (Chrome's PDF viewer admits no content script), so
// it asks in the one place it already speaks: a notification, with the answer
// as its buttons.
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
  }, () => {
    if (chrome.runtime.lastError) {
      console.warn('PDF notification failed:', chrome.runtime.lastError.message);
    }
  });
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

/**
 * The single entry point every PDF surface funnels into: popup button, context
 * menus, and the upload page all end up here.
 *
 * `source` is either `{kind: 'url', url}` — the worker fetches it, carrying
 * the user's cookies — or `{kind: 'bytes', bytesBase64}` from the upload page
 * (base64 because an ArrayBuffer does not survive runtime messaging).
 */
async function handlePdfCreateJob(message) {
  await assertFeatureEnabled('enablePdfTranslation');
  const settings = await chrome.storage.sync.get(defaultSettings);
  const source = message.source || {};

  const isBytes = source.kind === 'bytes' && !!source.bytesBase64;
  const isUrl = source.kind === 'url' && !!source.url;
  if (!isBytes && !isUrl) {
    throw new comicClient.ComicApiError('invalid_pdf', 'No PDF source was provided');
  }

  let operationId = message.operationId;
  if (!operationId && isUrl) {
    // Minted-and-persisted BEFORE the fetch: a retry after a lost response
    // must replay the same operationId or the server would charge the same
    // PDF twice (PR #26 review).
    operationId = await pdfClient.getOrCreateUrlOperationId(source.url);
  }
  if (!operationId) operationId = crypto.randomUUID();

  const fileName = message.fileName ||
    (isUrl ? pdfFileNameFromUrl(source.url) : 'document.pdf');

  // The click's receipt, written before any network work. Download + presign +
  // PUT + create is several seconds of silence, and every surface reads only
  // these records — without a row here the user sees nothing at all and clicks
  // again. It is also what carries a failure back to a popup that has since
  // closed: the awaited sendMessage promise dies with the popup, this does not.
  const pendingId = pdfClient.pendingJobId(operationId);
  await pdfClient.saveJobRecord({
    jobId: pendingId,
    operationId,
    fileName,
    status: 'queued',
    stage: 'uploading',
    progress: 0,
    results: null,
    error: null,
    pending: true,
    createdAt: Date.now()
  });

  let job;
  try {
    const bytes = isBytes
      ? base64ToArrayBuffer(source.bytesBase64)
      : await pdfClient.fetchPdfFromUrl(source.url);

    job = await pdfClient.createPdfJob({
      operationId,
      bytes,
      fileName,
      targetLang: message.targetLang || settings.pdfTargetLang || getEffectiveTargetLang(settings),
      // Only ever true, and only because a surface asked the user first. The
      // worker never decides this on anyone's behalf.
      confirmCharge: message.confirmCharge === true
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
    // keeps the binding — those retries must stay idempotent.
    if (code === 'operation_already_finished' || code === 'output_conflict' || code === 'job_conflict') {
      await pdfClient.releaseUrlOperationId(operationId);
    }
    await pdfClient.saveJobRecord({
      jobId: pendingId,
      status: 'failed',
      stage: null,
      error: {
        code,
        message: (error && error.message) || '',
        // too_many_pages carries the server's actual cap; keep it on the
        // record so the popup can render the honest number, not a stale one.
        ...(error && error.details && error.details.maxPages
          ? { maxPages: error.details.maxPages }
          : {})
      },
      settledAt: Date.now()
    });
    throw error;
  }

  // `error` too: a job can come back already terminal (a dispatch failure, or
  // an idempotent re-post of a finished operation), and it will never get an
  // alarm poll to fill that in later.
  await pdfClient.replaceJobRecord(pendingId, {
    jobId: job.jobId,
    operationId: job.operationId,
    fileName,
    status: job.status,
    progress: job.progress || 0,
    stage: job.stage || null,
    pageCount: job.pageCount,
    results: job.results || null,
    error: job.error || null,
    // Already over on arrival: no alarm poll will ever run for it, so this is
    // the only place its finish time can be stamped.
    ...(job.status === 'queued' || job.status === 'running' ? {} : { settledAt: Date.now() })
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
  return { ...job, fileName };
}

/**
 * The settings page's task list: the account's own history, from the server.
 *
 * Server-authoritative on purpose. The local records are a device's cache — 20
 * rows, a 24-hour TTL, gone with the profile — while "my translations" means
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

/** Poll one job and keep the local record in step with what came back. */
async function handlePdfJobGet(jobId) {
  const view = await pdfClient.getPdfJob(jobId);
  await pdfClient.saveJobRecord({
    jobId: view.jobId,
    status: view.status,
    progress: view.progress,
    stage: view.stage || null,
    pageCount: view.pageCount,
    results: view.results || null,
    error: view.error || null
  });
  await ensurePdfPollAlarm();
  return view;
}

async function handlePdfJobAbandon(jobId) {
  const view = await pdfClient.abandonPdfJob(jobId);
  await pdfClient.saveJobRecord({
    jobId: view.jobId,
    status: view.status,
    error: view.error || null
  });
  await ensurePdfPollAlarm();
  return view;
}

/**
 * Open a finished PDF in a new tab. Always via a fresh poll: the presigned
 * URL a record might hold is minutes old and probably expired.
 */
async function handlePdfOpenResult(jobId, which) {
  const view = await pdfClient.getPdfJob(jobId);
  // Refresh the local record only when there already is one. The settings page
  // lists the whole account, so this can be a job another device started, and
  // minting a record for it would push it to the top of this device's list as
  // if it had just run here.
  const records = await pdfClient.listJobRecords();
  if (records.some(r => r.jobId === view.jobId)) {
    await pdfClient.saveJobRecord({
      jobId: view.jobId,
      status: view.status,
      progress: view.progress,
      stage: view.stage || null,
      pageCount: view.pageCount,
      results: view.results || null,
      error: view.error || null
    });
    await ensurePdfPollAlarm();
  }
  const results = view.results || {};
  const url = which === 'mono'
    ? (results.monoUrl || results.dualUrl)
    : (results.dualUrl || results.monoUrl);
  if (!url) {
    throw new comicClient.ComicApiError('result_unavailable', 'The translated PDF is not available', 404);
  }
  await chrome.tabs.create({ url });
  return { opened: true };
}

export {
  isLikelyPdfUrl,
  pdfFileNameFromUrl,
  ensurePdfPollAlarm,
  refreshPdfJobs,
  runPdfUrlJob,
  handlePdfCreateJob,
  handlePdfJobsHistory,
  handlePdfJobGet,
  handlePdfJobAbandon,
  handlePdfOpenResult,
};
