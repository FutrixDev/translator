// Blab Translation — document translation API client (service worker side)
//
// Document translation is the comic pipeline's shape with a bigger document in
// the middle: it runs on our servers, draws on the same monthly free page
// allowance, and needs the same signed-in account. Everything auth-related is
// therefore imported from comic-client.js rather than duplicated — one token,
// one sign-in, one error model.
//
// The transport differs from comics in one deliberate way: the bytes never
// travel through the API Worker. The client asks /api/pdf/uploads for a
// presigned PUT, the bytes go straight to object storage, and only then is the
// job created against the storage key. For a file the user picked, the upload
// PAGE does that PUT itself (it holds the File, and only its XHR reports
// progress); this module hands it the ticket. For a PDF fetched from a URL the
// worker has the bytes, so it PUTs them here (putSource).
//
// What a document is — formats, limits, MIME types, the sniff, the status sets
// — lives in shared/doc-jobs.js. Nothing here keeps a copy.

import { apiFetch, getToken, ComicApiError } from './comic-client.js';
// Side-effect modules (no exports): each publishes itself on globalThis, the
// same dual-mode arrangement as i18n/messages.js. doc-jobs first, because the
// error map reads it.
import '../shared/doc-jobs.js';
import '../shared/pdf-errors.js';

const DocJobs = globalThis.DocJobs;

function signInError() {
  return new ComicApiError('unauthorized', 'Sign in to translate documents', 401, { loginRequired: true });
}

/** The size refusal, in the server's own shape (createPdfUploadTicket). */
function tooLargeError(format, bytes) {
  return new ComicApiError(
    format === 'pdf' ? 'pdf_too_large' : 'file_too_large',
    'The document exceeds the size limit',
    413,
    { maxBytes: DocJobs.maxBytesFor(format), bytes, format }
  );
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

// ---------------------------------------------------------------------------
// Source acquisition (the URL path: PDF only)
// ---------------------------------------------------------------------------

/**
 * Fetch a PDF the user is looking at, from the worker.
 *
 * `credentials: 'include'` for the same reason as fetchImageAsBase64: a paper
 * behind an institutional login serves its bytes only to a cookie-bearing
 * request. Any failure — network, login wall, HTML interstitial — collapses to
 * `source_fetch_failed`, whose user-facing answer is always the same: download
 * the file and use the local upload page.
 */
export async function fetchPdfFromUrl(url) {
  if (!/^https?:/i.test(url || '')) {
    throw new ComicApiError('source_fetch_failed', 'Only http(s) PDFs can be fetched');
  }
  let response;
  try {
    response = await fetch(url, {
      credentials: 'include',
      headers: { Accept: 'application/pdf,*/*;q=0.8' }
    });
  } catch (error) {
    throw new ComicApiError('source_fetch_failed', error?.message || 'Could not download the PDF');
  }
  if (!response.ok) {
    throw new ComicApiError('source_fetch_failed', `The PDF could not be downloaded (HTTP ${response.status})`, response.status);
  }
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > DocJobs.maxBytesFor('pdf')) {
    throw tooLargeError('pdf', buffer.byteLength);
  }
  // A login wall's HTML answered with a 200 is not a PDF; catching it here is
  // what turns "engine failed minutes later" into "could not fetch, upload it
  // yourself" at click time.
  const head = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, DocJobs.SNIFF_BYTES));
  if (!DocJobs.matchesDeclaredFormat(head, 'pdf')) {
    throw new ComicApiError('source_fetch_failed', 'The URL did not return a PDF');
  }
  return buffer;
}

// ---------------------------------------------------------------------------
// Transport: ticket → PUT → create
// ---------------------------------------------------------------------------

/**
 * Ask for a presigned PUT for one operation. Returns `{sourceKey, uploadUrl,
 * maxBytes, sourceFormat}`.
 *
 * The token is checked first and the size second, both before any request: a
 * signed-out click must not learn it needed a sign-in only after an upload,
 * and an oversized file must not cost a round trip to be refused.
 *
 * Neither `fileName` nor the deprecated `format` alias is sent. The server only
 * guesses a format from a name when none is declared, and this client always
 * declares one.
 */
export async function requestUploadTicket({ operationId, byteSize, sourceFormat }) {
  if (!(await getToken())) throw signInError();
  if (byteSize > DocJobs.maxBytesFor(sourceFormat)) throw tooLargeError(sourceFormat, byteSize);

  const ticket = await apiFetch('/api/pdf/uploads', {
    method: 'POST',
    body: { operationId, byteSize, sourceFormat }
  });
  // A ticket for a different format would name a key ending in the wrong
  // extension, and the create would refuse it a round trip later.
  if (!ticket || !nonEmptyString(ticket.sourceKey) || !nonEmptyString(ticket.uploadUrl) ||
      ticket.sourceFormat !== sourceFormat) {
    throw new ComicApiError('upload_failed', 'The service returned no usable upload ticket');
  }
  return {
    sourceKey: ticket.sourceKey,
    uploadUrl: ticket.uploadUrl,
    maxBytes: ticket.maxBytes || DocJobs.maxBytesFor(sourceFormat),
    sourceFormat
  };
}

/**
 * The worker's own presigned PUT (the URL path). No bearer token: the
 * signature in the URL is the entire authorization.
 *
 * The log line carries the status and the operation id and nothing else — the
 * URL is a credential for as long as it lives, and a storage error body can
 * echo it back.
 */
export async function putSource(uploadUrl, bytes, format, operationId) {
  let response;
  try {
    response = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': DocJobs.contentTypeFor(format) },
      body: bytes
    });
  } catch (error) {
    console.warn(`[pdf] presigned PUT failed: network op=${operationId}`);
    throw new ComicApiError('upload_failed', error?.message || 'Uploading the document failed');
  }
  if (!response.ok) {
    console.warn(`[pdf] presigned PUT failed: HTTP ${response.status} op=${operationId}`);
    throw new ComicApiError('upload_failed', `Uploading the document failed (HTTP ${response.status})`, response.status);
  }
}

/**
 * Create the job against an uploaded source. Returns the 202 job view plus the
 * operation id and file name it was created under.
 *
 * Idempotent under `operationId`: re-posting it adopts the existing job instead
 * of paying twice.
 *
 * `confirmCharge` is D9's answer to "this will spend credits, is that alright":
 * a job that would cost credits and did not say yes is refused with 409
 * QUOTE_CONFIRM_REQUIRED carrying the server's quote, having reserved nothing.
 * The caller shows that quote and comes back with the SAME operationId and
 * `confirmCharge: true`, which is the same operation and cannot be charged
 * twice. Deciding to ask is not this layer's job — see shared/comic-charge.js.
 *
 * `declaredUnits` is the flow-document measurement (shared/doc-measure.js), in
 * standard pages. Sent only as a positive integer: the server reserves one page
 * for a document that says nothing, and asks again once it has counted.
 */
export async function createJobFromUpload({
  operationId,
  sourceKey,
  sourceFormat,
  fileName,
  targetLang,
  confirmCharge,
  declaredUnits
}) {
  const job = await apiFetch('/api/pdf/jobs', {
    method: 'POST',
    body: {
      operationId,
      sourceKey,
      sourceFormat,
      // Cosmetic, but it has to travel: the name lives on the job row so the
      // website's history can label a job this extension created.
      fileName: fileName || '',
      targetLang: targetLang || 'zh-CN',
      output: {
        kind: 'dual',
        dualLayout: 'side-by-side',
        watermark: false
      },
      ...(Number.isInteger(declaredUnits) && declaredUnits > 0 ? { declaredUnits } : {}),
      // Sent only to say yes. Absent is the server's default and already means
      // "not confirmed", and the server refuses anything that is not a boolean
      // outright (400 invalid_confirm_charge).
      ...(confirmCharge === true ? { confirmCharge: true } : {})
    }
  });
  return { ...job, operationId, fileName: fileName || '' };
}

export function getPdfJob(jobId) {
  return apiFetch(`/api/pdf/jobs/${encodeURIComponent(jobId)}`);
}

/**
 * The user agreed to pay for what the document turned out to be. No body: the
 * number being confirmed is the one in the job's own view, and a client naming
 * its own price is exactly what the server refuses to accept.
 */
export function confirmPdfJob(jobId) {
  return apiFetch(`/api/pdf/jobs/${encodeURIComponent(jobId)}/confirm`, { method: 'POST' });
}

/**
 * The account's own job list, newest first — every device it ever translated
 * from, not just this one. The local records below are a device's cache; the
 * settings page shows the history a user actually means.
 */
export async function listPdfJobs() {
  const data = await apiFetch('/api/pdf/jobs');
  return Array.isArray(data && data.jobs) ? data.jobs : [];
}

export function abandonPdfJob(jobId) {
  return apiFetch(`/api/pdf/jobs/${encodeURIComponent(jobId)}/abandon`, { method: 'POST' });
}

// ---------------------------------------------------------------------------
// Local job records — the popup's task list and the cross-restart memory
// ---------------------------------------------------------------------------

// chrome.storage.local: the records name server jobs bound to this device's
// token, exactly like the token itself. An array ordered newest-first.
const JOBS_KEY = 'pdfJobs';
const MAX_JOB_RECORDS = 20;
const HOUR_MS = 60 * 60 * 1000;
// A finished job stays a day after it finished.
const SETTLED_TTL_MS = 24 * HOUR_MS;
// A job not over yet stays four days from its creation: the server holds an
// awaiting_confirm job for 72 h, and the record must outlive that window or the
// one row that asks the user to confirm vanishes while the question is open.
const UNSETTLED_TTL_MS = 96 * HOUR_MS;

// A record written before the job exists — the ticket, the upload, the create.
// It carries `pending: true` and a synthetic `local:<operationId>` id, and is
// replaced by the real record (or marked failed) as soon as the create settles.
const PENDING_ID_PREFIX = 'local:';
// A pending record older than this belongs to a worker or a page that died
// mid-upload: nothing will come back to replace it, so stop showing it as in
// flight. The create resets the clock (handlePdfCreateJob), so this bounds the
// silence after the upload, not the upload itself.
const PENDING_STALE_MS = 20 * 60 * 1000;

export function pendingJobId(operationId) {
  return `${PENDING_ID_PREFIX}${operationId}`;
}

/**
 * The click's receipt: a row written before the server has a job to name, so
 * the surfaces have something to show during the upload. Both creates write
 * it — the upload ticket (after the ticket is granted) and the create itself
 * (which resets it, so the stale clock starts at the create, not the upload).
 */
export function receiptRecord({ operationId, fileName, sourceFormat }) {
  return {
    jobId: pendingJobId(operationId),
    operationId,
    fileName: fileName || `document.${DocJobs.extensionFor(sourceFormat)}`,
    sourceFormat,
    status: 'queued',
    stage: null,
    progress: 0,
    results: null,
    error: null,
    confirm: null,
    pending: true,
    createdAt: Date.now()
  };
}

export function isPendingRecord(record) {
  return !!(record && (record.pending || String(record.jobId || '').startsWith(PENDING_ID_PREFIX)));
}

/**
 * A pending record that is still worth showing next to the server's own list.
 *
 * Only while it is in flight. Once it has failed it names no server job and
 * carries no jobId to match one by, so a settled pending row cannot be told
 * apart from the case that matters: the create reached the server, the response
 * was lost on the way back, and the job it made is in that list already.
 */
export function isPendingInFlight(record) {
  return isPendingRecord(record) && DocJobs.isActiveStatus(record && record.status);
}

/** Has this record outlived its TTL? Finished jobs age from when they finished. */
function isExpired(record, now) {
  if (DocJobs.isTerminalStatus(record.status)) {
    return (record.settledAt || record.createdAt || 0) + SETTLED_TTL_MS <= now;
  }
  return (record.createdAt || 0) + UNSETTLED_TTL_MS <= now;
}

/**
 * The invariant every write goes through: `settledAt` is set if and only if the
 * status is terminal. An awaiting_confirm job is not over, and a record that
 * said it was would age out of the popup while it still needs an answer.
 */
function withSettledAt(record) {
  if (DocJobs.isTerminalStatus(record.status)) {
    return record.settledAt ? record : { ...record, settledAt: Date.now() };
  }
  return { ...record, settledAt: null };
}

/**
 * Newest first, at most `max`. Over the cap, finished records go before
 * unfinished ones, oldest first: a job still running or waiting on the user is
 * the last thing this list may forget.
 */
export function capRecords(records, max = MAX_JOB_RECORDS) {
  const sorted = [...records].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  let excess = sorted.length - max;
  if (excess <= 0) return sorted;
  const drop = new Set();
  const evict = (eligible) => {
    for (let i = sorted.length - 1; i >= 0 && excess > 0; i--) {
      if (!drop.has(sorted[i]) && eligible(sorted[i])) {
        drop.add(sorted[i]);
        excess--;
      }
    }
  };
  evict(r => DocJobs.isTerminalStatus(r.status));
  evict(() => true);
  return sorted.filter(r => !drop.has(r));
}

export async function listJobRecords() {
  const stored = await chrome.storage.local.get({ [JOBS_KEY]: [] });
  const records = Array.isArray(stored[JOBS_KEY]) ? stored[JOBS_KEY] : [];
  const now = Date.now();
  let swept = false;
  const live = [];
  for (const record of records) {
    if (!record || !record.jobId || isExpired(record, now)) {
      swept = true;
      continue;
    }
    if (isPendingRecord(record) && DocJobs.isActiveStatus(record.status) &&
        (record.createdAt || 0) <= now - PENDING_STALE_MS) {
      record.status = 'failed';
      record.stage = null;
      record.error = { code: 'no_response', message: 'The upload did not finish' };
      record.settledAt = now;
      swept = true;
    }
    live.push(record);
  }
  if (swept) {
    await chrome.storage.local.set({ [JOBS_KEY]: live });
  }
  return live;
}

/**
 * Swap a pending record for the real one the server just handed back.
 *
 * Done in a single write so the popup's 3-second poll can never observe the
 * gap where the click has no row at all.
 */
export async function replaceJobRecord(oldJobId, record) {
  const records = await listJobRecords();
  const previous = records.find(r => r.jobId === oldJobId);
  const rest = records.filter(r => r.jobId !== oldJobId && r.jobId !== record.jobId);
  const merged = withSettledAt({ ...(previous || {}), ...record, pending: false });
  if (!merged.createdAt) merged.createdAt = previous?.createdAt || Date.now();
  await chrome.storage.local.set({ [JOBS_KEY]: capRecords([merged, ...rest]) });
  return merged;
}

/** Upsert by jobId; newest first; TTL and cap applied on the way through. */
export async function saveJobRecord(record) {
  const records = await listJobRecords();
  const rest = records.filter(r => r.jobId !== record.jobId);
  const existing = records.find(r => r.jobId === record.jobId);
  const merged = withSettledAt({ ...(existing || {}), ...record });
  if (!merged.createdAt) merged.createdAt = Date.now();
  await chrome.storage.local.set({ [JOBS_KEY]: capRecords([merged, ...rest]) });
  return merged;
}

/**
 * Forget one job on this device.
 *
 * Local only, and deliberately so: the row it removes is the popup's copy, not
 * the job. The server's account of it is untouched.
 */
export async function dismissJobRecord(jobId) {
  const records = await listJobRecords();
  const next = records.filter(r => r.jobId !== jobId);
  if (next.length !== records.length) {
    await chrome.storage.local.set({ [JOBS_KEY]: next });
  }
  return next;
}

/**
 * Is there anything for the poll alarm to watch?
 *
 * Active jobs only. A job awaiting confirmation does not move until the user
 * answers (the confirm handler re-arms the alarm) or the server gives up after
 * 72 h — waking the worker every minute for three days to learn nothing is the
 * wrong trade. Pending records have no server job behind them yet.
 */
export async function hasActiveJobs() {
  const records = await listJobRecords();
  return records.some(r => !isPendingRecord(r) && DocJobs.isActiveStatus(r.status));
}

// ---------------------------------------------------------------------------
// Server view → record
// ---------------------------------------------------------------------------

/** The fields of a record that the server's view owns. */
export function recordFieldsFromView(view) {
  return {
    status: view.status,
    progress: view.progress,
    stage: view.stage || null,
    pageCount: view.pageCount,
    results: view.results || null,
    error: view.error || null,
    confirm: view.confirm || null
  };
}

/**
 * Fold a server view into a record. Pure.
 *
 * `transition` names what the change means to someone not looking:
 * `'settled'` when the job just became terminal, `'awaiting'` when it just
 * started waiting for a confirmation, null otherwise. `leftAwaiting` is set
 * when it stopped waiting, whichever way — the question it posed is gone.
 */
export function applyJobView(record, view) {
  const before = record.status;
  const next = withSettledAt({ ...record, ...recordFieldsFromView(view) });
  const settled = DocJobs.isTerminalStatus(next.status) && !DocJobs.isTerminalStatus(before);
  const awaiting = DocJobs.isAwaitingStatus(next.status) && !DocJobs.isAwaitingStatus(before);
  return {
    record: next,
    transition: settled ? 'settled' : (awaiting ? 'awaiting' : null),
    leftAwaiting: DocJobs.isAwaitingStatus(before) && !DocJobs.isAwaitingStatus(next.status)
  };
}

/**
 * The part of a failure worth keeping on a record: the code, the message, and
 * the facts the copy interpolates. A ComicApiError keeps the body's extra
 * fields under `details`; a messaging error has them flattened.
 */
export function errorRecordFrom(error) {
  const out = {
    code: (error && error.code) || 'engine_error',
    message: (error && error.message) || ''
  };
  for (const name of ['maxPages', 'maxBytes', 'format', 'pageCount', 'refunded']) {
    const value = error?.[name] ?? error?.details?.[name];
    if (value !== undefined && value !== null) out[name] = value;
  }
  return out;
}

/** A job is dead and its operation id with it: a replay would adopt the corpse. */
async function releaseIfBurned(record) {
  if (record.status === 'failed' || record.status === 'abandoned') {
    await releaseUrlOperationId(record.operationId);
  }
}

/**
 * The page-driven update: a surface just fetched this view. Only a record that
 * already exists is touched — the settings page lists the whole account, and
 * minting a record for another device's job would push it to the top of this
 * device's list as if it had just run here. Returns the applyJobView result, or
 * null when there was no record.
 */
export async function updateRecordFromView(jobId, view) {
  const records = await listJobRecords();
  const index = records.findIndex(r => r.jobId === jobId);
  if (index === -1) return null;
  const change = applyJobView(records[index], view);
  records[index] = change.record;
  await chrome.storage.local.set({ [JOBS_KEY]: records });
  if (change.transition === 'settled') await releaseIfBurned(change.record);
  return change;
}

// ---------------------------------------------------------------------------
// URL → operationId intents
// ---------------------------------------------------------------------------

// A URL job's operationId must survive a lost response: if the server accepted
// (and reserved points for) a create we never heard back from, a retry with a
// FRESH id would be a second paid job for the same PDF (PR #26 review). So the
// id is minted once per URL and persisted BEFORE the first attempt; every
// retry reuses it and lands on the server's idempotent adopt path.
//
// The idempotency is for LIVE work only, though. The server adopts a job for
// (user, operationId) whatever its status, and billing refuses to reserve
// under an id it already settled — so once the job behind an id is failed,
// abandoned, or gone, every replay of that id is the same dead end.
// releaseUrlOperationId() below is called the moment an id is seen to be
// burned, so the NEXT click mints a fresh id, a fresh reservation, a fresh
// dispatch.
const URL_OPS_KEY = 'pdfUrlOps';
// Its own number, not the records' TTL: a binding answers "is this click a
// replay?", which stops mattering a day after the click whatever the job did.
const URL_OP_TTL_MS = 24 * HOUR_MS;
const MAX_URL_OPS = 40;

export async function getOrCreateUrlOperationId(url) {
  const stored = await chrome.storage.local.get({ [URL_OPS_KEY]: {} });
  const map = stored[URL_OPS_KEY] && typeof stored[URL_OPS_KEY] === 'object' ? stored[URL_OPS_KEY] : {};
  const cutoff = Date.now() - URL_OP_TTL_MS;

  const live = {};
  for (const [key, entry] of Object.entries(map)) {
    if (entry && entry.opId && (entry.createdAt || 0) > cutoff) live[key] = entry;
  }

  let entry = live[url];
  if (!entry) {
    entry = { opId: crypto.randomUUID(), createdAt: Date.now() };
    const keys = Object.keys(live);
    if (keys.length >= MAX_URL_OPS) {
      keys.sort((a, b) => (live[a].createdAt || 0) - (live[b].createdAt || 0));
      for (const key of keys.slice(0, keys.length - MAX_URL_OPS + 1)) delete live[key];
    }
    live[url] = entry;
  }

  await chrome.storage.local.set({ [URL_OPS_KEY]: live });
  return entry.opId;
}

/**
 * Forget a URL → operationId binding whose id can never run again.
 *
 * Called when the id is known to be burned: the job behind it ended in
 * `failed`/`abandoned`, the server no longer knows the job (404), or the create
 * was refused with `operation_already_finished` / `output_conflict` /
 * `job_conflict`. NOT called for queued/running/awaiting/succeeded — those are
 * exactly the states the binding exists to make replays converge on.
 *
 * Keyed by the id, not the URL: the callers that observe a burned id hold the
 * record, which no longer remembers which URL minted it.
 */
export async function releaseUrlOperationId(operationId) {
  if (!operationId) return;
  const stored = await chrome.storage.local.get({ [URL_OPS_KEY]: {} });
  const map = stored[URL_OPS_KEY] && typeof stored[URL_OPS_KEY] === 'object' ? stored[URL_OPS_KEY] : {};
  let changed = false;
  for (const [key, entry] of Object.entries(map)) {
    if (entry && entry.opId === operationId) {
      delete map[key];
      changed = true;
    }
  }
  if (changed) {
    await chrome.storage.local.set({ [URL_OPS_KEY]: map });
  }
}

/**
 * The URL an operation id was minted for, or null.
 *
 * It exists for the context menu's charge confirmation: that question is asked
 * in a notification, whose answer can arrive minutes later and after the
 * service worker has been torn down. The notification carries the operation id
 * in its own id and the URL is looked back up here.
 */
export async function findUrlForOperationId(operationId) {
  if (!operationId) return null;
  const stored = await chrome.storage.local.get({ [URL_OPS_KEY]: {} });
  const map = stored[URL_OPS_KEY] && typeof stored[URL_OPS_KEY] === 'object' ? stored[URL_OPS_KEY] : {};
  const cutoff = Date.now() - URL_OP_TTL_MS;
  for (const [url, entry] of Object.entries(map)) {
    if (entry && entry.opId === operationId && (entry.createdAt || 0) > cutoff) return url;
  }
  return null;
}

/**
 * Re-poll every record that is not over and names a server job, and persist
 * what came back.
 *
 * Awaiting records are polled too: this runs when someone opens the popup, and
 * a job the user confirmed from the website, or that the server gave up on,
 * must not read "needs your confirmation" here forever.
 *
 * Returns `{records, changes}` — each change is an applyJobView result
 * (`{record, transition, leftAwaiting}`), which is exactly what the caller
 * decides notifications from. A job the server no longer knows (404 after a
 * sweep) is marked failed rather than left "running" forever.
 */
export async function refreshJobRecords() {
  const records = await listJobRecords();
  const changes = [];
  let changed = false;

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!DocJobs.isUnsettledStatus(record.status)) continue;
    // A pending record names no server job — `getPdfJob('local:…')` would 404
    // and the 404 branch below would wrongly bury a job still uploading.
    if (isPendingRecord(record)) continue;
    let view;
    try {
      view = await getPdfJob(record.jobId);
    } catch (error) {
      if (error instanceof ComicApiError && error.status === 404) {
        view = {
          status: 'failed',
          progress: record.progress,
          stage: null,
          pageCount: record.pageCount,
          error: { code: 'engine_error', message: 'The job is no longer known to the service' }
        };
      } else {
        // Auth or network trouble: leave the record as-is, a later poll retries.
        continue;
      }
    }
    const change = applyJobView(record, view);
    records[i] = change.record;
    if (change.record.status !== record.status || change.transition || change.leftAwaiting) {
      changed = true;
      changes.push(change);
    } else if (change.record.progress !== record.progress) {
      changed = true;
    }
    // A failure burns the operation id (see releaseUrlOperationId); a success
    // keeps it — replaying a succeeded id resolves instantly, free.
    if (change.transition === 'settled') await releaseIfBurned(change.record);
  }

  if (changed) {
    await chrome.storage.local.set({ [JOBS_KEY]: records });
  }
  return { records, changes };
}

/** The shared map from shared/pdf-errors.js, re-exported for the worker. */
export const { pdfErrorMessageKey, pdfErrorMessage, pdfAbandonedKey } = globalThis.AI_TRANSLATOR_PDF_ERRORS;

export { ComicApiError };
