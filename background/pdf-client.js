// AI Translator — PDF translation API client (service worker side)
//
// PDF translation is the comic pipeline's shape with a bigger document in the
// middle: it runs on our servers, draws on the same monthly free page
// allowance, and needs the same signed-in
// account. Everything auth-related is therefore imported from comic-client.js
// rather than duplicated — one token, one sign-in, one error model.
//
// The transport differs from comics in one deliberate way: the bytes never
// travel through the API Worker. The extension asks /api/pdf/uploads for a
// presigned PUT, uploads straight to object storage, and only then creates the
// job against the storage key. See the server design doc
// (2026-08-02-pdf-translation-server-retypeset-design.md §3.1).

import { apiFetch, getToken, ComicApiError } from './comic-client.js';

// Kept in sync with pdfMaxBytes() on the server. Checking here saves the user
// a 30 MiB upload that would only be refused at job creation.
const MAX_PDF_BYTES = 30 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Byte validation
// ---------------------------------------------------------------------------

/** Magic-byte sniff: every real PDF starts with "%PDF-". */
export function isPdfBytes(buffer) {
  const b = new Uint8Array(buffer);
  if (b.length < 5) return false;
  return b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2d;
}

// ---------------------------------------------------------------------------
// Source acquisition
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
  if (buffer.byteLength > MAX_PDF_BYTES) {
    throw new ComicApiError('pdf_too_large', 'The PDF exceeds the size limit', 413, { maxBytes: MAX_PDF_BYTES });
  }
  // A login wall's HTML answered with a 200 is not a PDF; catching it here is
  // what turns "engine failed minutes later" into "could not fetch, upload it
  // yourself" at click time.
  if (!isPdfBytes(buffer)) {
    throw new ComicApiError('source_fetch_failed', 'The URL did not return a PDF');
  }
  return buffer;
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

/**
 * Start a PDF translation. Returns the 202 job view: `{jobId, status,
 * progress, pageCount, quote, ...}`.
 *
 * Three hops, all idempotent under `operationId`: ticket → presigned PUT →
 * job creation. Re-running the whole sequence with the same operationId lands
 * on the same storage key and adopts the same job instead of paying twice.
 */
export async function createPdfJob({
  operationId,
  bytes,
  fileName,
  targetLang,
  outputKind = 'dual',
  dualLayout = 'side-by-side'
}) {
  // Ask for the token before touching the bytes: a signed-out click must not
  // wait through a 30 MiB upload to learn it needed a sign-in.
  if (!(await getToken())) {
    throw new ComicApiError('unauthorized', 'Sign in to translate PDFs', 401, { loginRequired: true });
  }

  if (!bytes || !bytes.byteLength) {
    throw new ComicApiError('invalid_pdf', 'No PDF bytes to upload');
  }
  if (bytes.byteLength > MAX_PDF_BYTES) {
    throw new ComicApiError('pdf_too_large', 'The PDF exceeds the size limit', 413, {
      maxBytes: MAX_PDF_BYTES,
      bytes: bytes.byteLength
    });
  }
  if (!isPdfBytes(bytes)) {
    throw new ComicApiError('invalid_pdf', 'This file is not a PDF');
  }

  const opId = operationId || crypto.randomUUID();

  const ticket = await apiFetch('/api/pdf/uploads', {
    method: 'POST',
    body: { operationId: opId, byteSize: bytes.byteLength }
  });
  if (!ticket || !ticket.uploadUrl || !ticket.sourceKey) {
    throw new ComicApiError('upload_failed', 'The service returned no upload ticket');
  }

  // The presigned PUT goes to object storage, not the API — no bearer token,
  // and the signature in the URL is the entire authorization.
  let putResponse;
  try {
    putResponse = await fetch(ticket.uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': 'application/pdf' },
      body: bytes
    });
  } catch (error) {
    throw new ComicApiError('upload_failed', error?.message || 'Uploading the PDF failed');
  }
  if (!putResponse.ok) {
    throw new ComicApiError('upload_failed', `Uploading the PDF failed (HTTP ${putResponse.status})`, putResponse.status);
  }

  const job = await apiFetch('/api/pdf/jobs', {
    method: 'POST',
    body: {
      operationId: opId,
      sourceKey: ticket.sourceKey,
      // Cosmetic, but it has to travel: the name lives on the job row so the
      // website's history can label a job this extension created.
      fileName: fileName || '',
      targetLang: targetLang || 'zh-CN',
      output: {
        kind: outputKind,
        dualLayout,
        watermark: false
      }
    }
  });
  return { ...job, operationId: opId, fileName: fileName || '' };
}

export function getPdfJob(jobId) {
  return apiFetch(`/api/pdf/jobs/${encodeURIComponent(jobId)}`);
}

/**
 * The account's own job list, newest first — every device it ever translated
 * from, not just this one.
 *
 * The local records in this file are a device's cache and outlive nothing: 24h
 * TTL, 20 rows, gone with the browser profile. The settings page shows the
 * history a user actually means when they say "my translations", so it reads
 * the server and treats this as the truth.
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
const JOB_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_JOB_RECORDS = 20;

// A record written the moment the user clicks, before the download, the
// presigned PUT and the create have run — the several seconds during which
// nothing else exists to look at. It carries `pending: true` and a synthetic
// `local:<operationId>` id, and is replaced by the real record (or marked
// failed) as soon as the create settles.
const PENDING_ID_PREFIX = 'local:';
// A pending record older than this belongs to a worker that was killed
// mid-upload: nothing will ever come back to replace it, so stop showing it as
// in-flight. Generous enough to cover a 30 MiB upload on a slow link.
const PENDING_STALE_MS = 10 * 60 * 1000;

function isActiveStatus(status) {
  return status === 'queued' || status === 'running';
}

export function pendingJobId(operationId) {
  return `${PENDING_ID_PREFIX}${operationId}`;
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
 * was lost on the way back, and the job it made is in that list already. Keeping
 * the row would show one operation twice — a failed upload beside the job that
 * is actually running. The popup showed that error live when it happened; the
 * history is the server's account.
 */
export function isPendingInFlight(record) {
  return isPendingRecord(record) && isActiveStatus(record && record.status);
}

export async function listJobRecords() {
  const stored = await chrome.storage.local.get({ [JOBS_KEY]: [] });
  const records = Array.isArray(stored[JOBS_KEY]) ? stored[JOBS_KEY] : [];
  const cutoff = Date.now() - JOB_TTL_MS;
  const staleCutoff = Date.now() - PENDING_STALE_MS;
  let swept = false;
  const live = [];
  for (const record of records) {
    if (!record || !record.jobId || (record.createdAt || 0) <= cutoff) {
      swept = true;
      continue;
    }
    if (isPendingRecord(record) && isActiveStatus(record.status) && (record.createdAt || 0) <= staleCutoff) {
      record.status = 'failed';
      record.stage = null;
      record.error = { code: 'no_response', message: 'The upload did not finish' };
      record.settledAt = Date.now();
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
  const merged = { ...(previous || {}), ...record, pending: false };
  if (!merged.createdAt) merged.createdAt = previous?.createdAt || Date.now();
  const next = [merged, ...rest]
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .slice(0, MAX_JOB_RECORDS);
  await chrome.storage.local.set({ [JOBS_KEY]: next });
  return merged;
}

/** Upsert by jobId; newest first; TTL and cap applied on the way through. */
export async function saveJobRecord(record) {
  const records = await listJobRecords();
  const rest = records.filter(r => r.jobId !== record.jobId);
  const existing = records.find(r => r.jobId === record.jobId);
  const merged = { ...(existing || {}), ...record };
  if (!merged.createdAt) merged.createdAt = Date.now();
  const next = [merged, ...rest]
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .slice(0, MAX_JOB_RECORDS);
  await chrome.storage.local.set({ [JOBS_KEY]: next });
  return merged;
}

/**
 * Forget one job on this device.
 *
 * Local only, and deliberately so: the row it removes is the popup's copy, not
 * the job. A dismissed success is still downloadable from the settings history,
 * and a dismissed failure was still charged or refunded exactly as it was — the
 * server's account of both is untouched.
 */
export async function dismissJobRecord(jobId) {
  const records = await listJobRecords();
  const next = records.filter(r => r.jobId !== jobId);
  if (next.length !== records.length) {
    await chrome.storage.local.set({ [JOBS_KEY]: next });
  }
  return next;
}

export async function hasActiveJobs() {
  const records = await listJobRecords();
  // Pending records deliberately do not hold the alarm open: there is no
  // server job behind them yet to poll, and the create path re-arms the alarm
  // itself the moment there is one.
  return records.some(r => !isPendingRecord(r) && isActiveStatus(r.status));
}

// ---------------------------------------------------------------------------
// URL → operationId intents
// ---------------------------------------------------------------------------

// A URL job's operationId must survive a lost response: if the server accepted
// (and reserved points for) a create we never heard back from, a retry with a
// FRESH id would be a second paid job for the same PDF (PR #26 review). So the
// id is minted once per URL and persisted BEFORE the first attempt; every
// retry reuses it and lands on the server's idempotent adopt path — including
// the happy accident that retrying an already-finished operation resolves
// instantly and free.
const URL_OPS_KEY = 'pdfUrlOps';
const URL_OP_TTL_MS = JOB_TTL_MS; // aligned with the job records they map to
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
 * Re-poll every non-terminal record and persist what came back.
 *
 * Returns `{records, transitions}` — `transitions` are the records that just
 * crossed into a terminal state on THIS refresh, which is exactly the set the
 * caller may want to notify about. A job the server no longer knows (404 after
 * a sweep) is marked failed rather than left "running" forever.
 */
export async function refreshJobRecords() {
  const records = await listJobRecords();
  const transitions = [];
  let changed = false;

  for (const record of records) {
    if (!isActiveStatus(record.status)) continue;
    // A pending record names no server job — `getPdfJob('local:…')` would 404
    // and the 404 branch below would wrongly bury a job still uploading.
    if (isPendingRecord(record)) continue;
    let view;
    try {
      view = await getPdfJob(record.jobId);
    } catch (error) {
      if (error instanceof ComicApiError && error.status === 404) {
        Object.assign(record, {
          status: 'failed',
          error: { code: 'engine_error', message: 'The job is no longer known to the service' },
          settledAt: Date.now()
        });
        transitions.push(record);
        changed = true;
      }
      // Auth or network trouble: leave the record as-is, a later poll retries.
      continue;
    }
    const before = record.status;
    Object.assign(record, {
      status: view.status,
      progress: view.progress,
      stage: view.stage || null,
      pageCount: view.pageCount,
      results: view.results || null,
      error: view.error || null
    });
    if (before !== view.status) changed = true;
    if (isActiveStatus(before) && !isActiveStatus(view.status)) {
      // When it stopped, which is what the popup ages a finished row out by.
      record.settledAt = Date.now();
      transitions.push(record);
    }
  }

  if (changed || transitions.length) {
    await chrome.storage.local.set({ [JOBS_KEY]: records });
  }
  return { records, transitions };
}

/** Server/client error codes → i18n message keys (see i18n/messages.js). */
export function pdfErrorMessageKey(code) {
  switch (code) {
    case 'insufficient_points': return 'pdfErrInsufficientPoints';
    case 'too_many_pages': return 'pdfErrTooManyPages';
    case 'encrypted_pdf': return 'pdfErrEncrypted';
    case 'invalid_pdf':
    case 'invalid_source_key':
    case 'invalid_output':
    case 'missing_source': return 'pdfErrInvalid';
    case 'scanned_unsupported': return 'pdfErrScanned';
    case 'pdf_too_large': return 'pdfErrTooLarge';
    case 'source_fetch_failed': return 'pdfErrSourceFetch';
    case 'engine_error': return 'pdfErrEngine';
    case 'budget_exceeded': return 'pdfErrBudget';
    case 'container_unavailable':
    case 'gateway_unavailable':
    case 'storage_unavailable': return 'pdfErrUnavailable';
    case 'unauthorized': return 'pdfSignInRequired';
    case 'feature_disabled': return 'featureDisabled';
    case 'upload_failed':
    case 'network_error':
    case 'no_response': return 'pdfErrNetwork';
    default: return 'pdfFailed';
  }
}

export { MAX_PDF_BYTES, ComicApiError };
