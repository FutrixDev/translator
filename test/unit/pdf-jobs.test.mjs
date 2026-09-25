// Guards for the PDF job records — the rows every PDF surface renders from.
//
// The bug these exist for: a job used to be recorded only after the download,
// the presigned upload and the create had all succeeded. Until then every
// surface read an empty list, so a click on "Translate This PDF" looked like it
// had done nothing and people clicked again — and if the popup closed in the
// meantime, a failure was swallowed entirely with it.
//
// The fix is a `pending` record written before any network work, carrying a
// synthetic `local:<operationId>` id. That id names no server job, which is
// what the rest of these tests are about: anything that polls the server has to
// step over it.
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { optionsSource, popupSource, uploadPageSource } from './helpers/sources.mjs';

const repoFile = (rel) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');

/** An in-memory chrome.storage.local, which is all pdf-client.js touches. */
function withStorage(initial = {}) {
  const store = { ...initial };
  globalThis.chrome = {
    storage: {
      local: {
        get: async (defaults) => {
          const out = { ...defaults };
          for (const key of Object.keys(defaults)) {
            if (key in store) out[key] = store[key];
          }
          return out;
        },
        set: async (values) => { Object.assign(store, values); }
      }
    }
  };
  return store;
}

withStorage();
const pdf = await import('../../background/pdf-client.js');

// The popup and the upload page get the same helpers as a classic script —
// in the same order their <script> tags do, because pdf-ui.js reads the URL
// predicates off globalThis rather than keeping a second copy of them.
await import('../../shared/doc-jobs.js');
await import('../../shared/pdf-url.js');
await import('../../pdf/pdf-ui.js');
const ui = globalThis.AI_TRANSLATOR_PDF_UI;

// ---------------------------------------------------------------------------
// Pending records
// ---------------------------------------------------------------------------

test('a pending record is recognised by its synthetic id, not only its flag', () => {
  assert.equal(pdf.pendingJobId('op-1'), 'local:op-1');
  assert.equal(pdf.isPendingRecord({ jobId: 'local:op-1' }), true);
  assert.equal(pdf.isPendingRecord({ jobId: 'job-1', pending: true }), true);
  assert.equal(pdf.isPendingRecord({ jobId: 'job-1' }), false);
});

test('a pending record does not hold the poll alarm open', async () => {
  withStorage({
    pdfJobs: [{ jobId: 'local:op-1', status: 'queued', pending: true, createdAt: Date.now() }]
  });
  // Nothing to poll: the server has no job by that id yet, and the create path
  // re-arms the alarm itself as soon as it does.
  assert.equal(await pdf.hasActiveJobs(), false);

  withStorage({
    pdfJobs: [{ jobId: 'job-1', status: 'running', createdAt: Date.now() }]
  });
  assert.equal(await pdf.hasActiveJobs(), true);
});

test('a pending record that outlived its worker stops claiming to be in flight', async () => {
  // 20 minutes, counted from the create (which resets the receipt), so a slow
  // 50 MiB upload is not buried while it is still going up.
  const twentyOneMinutesAgo = Date.now() - 21 * 60 * 1000;
  withStorage({
    pdfJobs: [{ jobId: 'local:op-1', status: 'queued', pending: true, createdAt: twentyOneMinutesAgo }]
  });
  const [record] = await pdf.listJobRecords();
  assert.equal(record.status, 'failed');
  assert.equal(record.error.code, 'no_response');
});

test('a fresh pending record is left alone', async () => {
  withStorage({
    pdfJobs: [{ jobId: 'local:op-1', status: 'queued', pending: true, createdAt: Date.now() - 19 * 60 * 1000 }]
  });
  const [record] = await pdf.listJobRecords();
  assert.equal(record.status, 'queued');
});

test('the real job replaces the pending row rather than joining it', async () => {
  const store = withStorage({
    pdfJobs: [{
      jobId: 'local:op-1',
      operationId: 'op-1',
      fileName: '2312.03724.pdf',
      status: 'queued',
      pending: true,
      createdAt: Date.now()
    }]
  });
  const merged = await pdf.replaceJobRecord('local:op-1', {
    jobId: 'job-1',
    operationId: 'op-1',
    status: 'running',
    progress: 10
  });
  assert.equal(store.pdfJobs.length, 1);
  assert.equal(store.pdfJobs[0].jobId, 'job-1');
  assert.equal(merged.pending, false);
  // Carried over: the name is the client's, and the server view has no reason
  // to repeat it back on a poll.
  assert.equal(merged.fileName, '2312.03724.pdf');
});

test('a pending record reads as uploading, not as a queued server job', () => {
  assert.equal(ui.pdfStatusKey({ status: 'queued', pending: true }), 'pdfStatusUploading');
  assert.equal(ui.pdfStatusKey({ status: 'queued' }), 'pdfStatusQueued');
  // Once it has failed it is a failure, not an upload.
  assert.equal(ui.pdfStatusKey({ status: 'failed', pending: true }), 'pdfStatusFailed');
});

// The engine's own stage words (pipeline.py STAGES / FLOW_STAGES, the `names`
// pass in server.py, and saas's PDF_MERGING_STAGE) and the phase each reads as.
const running = (stage) => ui.pdfStatusKey({ status: 'running', stage });

test('each engine stage word reads as its phase', () => {
  assert.equal(running('parse'), 'pdfStageLayout');
  assert.equal(running('structure'), 'pdfStageLayout');
  assert.equal(running('names'), 'pdfStageTranslating');
  assert.equal(running('normalize'), 'pdfStageTranslating');
  assert.equal(running('translate'), 'pdfStageTranslating');
  assert.equal(running('typeset'), 'pdfStageTypesetting');
  assert.equal(running('rewrite'), 'pdfStageTypesetting');
  assert.equal(running('emit'), 'pdfStageTypesetting');
  assert.equal(running('merging'), 'pdfStageTypesetting');
});

test('the status line never steps back through a whole run', () => {
  // The bug: `emit` (writing the result file) matched neither loose pattern
  // and read as "Translating…" again after "Retypesetting…".
  const phase = { pdfStageLayout: 0, pdfStageTranslating: 1, pdfStageTypesetting: 2 };
  const runs = {
    pdf: ['parse', 'structure', 'names', 'translate', 'typeset', 'emit'],
    'split pdf': ['parse', 'structure', 'translate', 'typeset', 'emit', 'merging'],
    document: ['names', 'normalize', 'translate', 'rewrite', 'emit']
  };
  for (const [name, stages] of Object.entries(runs)) {
    const keys = stages.map(running);
    for (let i = 1; i < keys.length; i += 1) {
      assert.ok(
        phase[keys[i]] >= phase[keys[i - 1]],
        `${name}: ${stages[i - 1]}→${stages[i]} steps back (${keys.join(' → ')})`
      );
    }
    assert.equal(keys.at(-1), 'pdfStageTypesetting', `${name} ends on the last phase`);
  }
});

test('an unknown or missing stage word reads as the neutral "Translating…"', () => {
  assert.equal(running('some_future_stage'), 'pdfStageTranslating');
  assert.equal(running(''), 'pdfStageTranslating');
  assert.equal(running(null), 'pdfStageTranslating');
  assert.equal(running(undefined), 'pdfStageTranslating');
  // Looked up exactly: the pdf2zh-era words the old patterns caught are gone.
  assert.equal(running('render'), 'pdfStageTranslating');
  assert.equal(running('toString'), 'pdfStageTranslating');
});

test('a settled pending record stops standing in for the job the server has', () => {
  // In flight, it is the only trace of the click and the history must show it.
  assert.equal(pdf.isPendingInFlight({ jobId: 'local:op-1', status: 'queued' }), true);
  // Failed, it may well BE the job the server list already carries — the create
  // landed and the response was lost — and there is no id left to prove it is
  // not. Showing it would double up one operation.
  assert.equal(pdf.isPendingInFlight({ jobId: 'local:op-1', status: 'failed' }), false);
  // A real server job is never local filler, whatever its status.
  assert.equal(pdf.isPendingInFlight({ jobId: 'job-1', status: 'queued' }), false);
});

test('dismissing a job drops this device\'s row and leaves the rest alone', async () => {
  const store = withStorage({
    pdfJobs: [
      { jobId: 'job-1', status: 'failed', createdAt: Date.now(), error: { code: 'budget_exceeded' } },
      { jobId: 'job-2', status: 'running', createdAt: Date.now() }
    ]
  });
  const left = await pdf.dismissJobRecord('job-1');
  assert.deepEqual(left.map(r => r.jobId), ['job-2']);
  assert.deepEqual(store.pdfJobs.map(r => r.jobId), ['job-2']);
});

test('a job that finished stamps when it finished', async () => {
  // The popup ages a finished row out by this; without it a failure sits in the
  // menu for the record's whole 24-hour life. Every write goes through one
  // invariant (settledAt iff terminal), so a create that fails outright — which
  // no poll will ever visit — is stamped by the same write that fails it.
  const store = withStorage({
    pdfJobs: [{ jobId: 'local:op-1', status: 'queued', pending: true, createdAt: Date.now() }]
  });
  const failed = await pdf.saveJobRecord({ jobId: 'local:op-1', status: 'failed', error: { code: 'engine_error' } });
  assert.ok(Number.isFinite(failed.settledAt), 'the terminal write must stamp settledAt');
  assert.equal(store.pdfJobs[0].settledAt, failed.settledAt);

  // A job waiting for the user is not over, whatever wrote it.
  const awaiting = await pdf.replaceJobRecord('local:op-1', { jobId: 'job-1', status: 'awaiting_confirm' });
  assert.equal(awaiting.settledAt, null, 'awaiting_confirm must not read as finished');

  // And a poll that sees it end stamps it there.
  const { record } = pdf.applyJobView(awaiting, { status: 'abandoned', progress: 0 });
  assert.ok(Number.isFinite(record.settledAt));
});

// ---------------------------------------------------------------------------
// The wiring these records depend on
// ---------------------------------------------------------------------------

test('the popup stops showing a job that finished long ago', () => {
  const source = popupSource();
  assert.ok(
    /PDF_SETTLED_VISIBLE_MS/.test(source) &&
      /records\.filter\(isPdfJobStillWorthShowing\)/.test(source),
    'the popup list must age finished rows out rather than render every record'
  );
  assert.ok(
    /type: 'PDF_JOB_DISMISS'/.test(source),
    'and offer a way to drop one sooner'
  );
});

test('the settings history merges only the local rows still in flight', () => {
  const source = repoFile('background/pdf-jobs.js');
  const body = source.slice(source.indexOf('async function handlePdfJobsHistory'));
  assert.ok(
    /records\.filter\(r => pdfClient\.isPendingInFlight\(r\)\)/.test(body),
    'a settled local row must not be prepended to the server list'
  );
});

test('the record is written before the work that can fail, not after it', () => {
  const source = repoFile('background/pdf-jobs.js');
  // URL source: the worker downloads, takes a ticket and PUTs — the receipt
  // comes before all of it. Uploaded source: the create upserts the receipt
  // (resetting its clock) before it asks the server for the job.
  const body = source.slice(source.indexOf('async function handlePdfCreateJob'));
  const receiptAt = body.indexOf('pdfClient.saveJobRecord(receipt)');
  assert.ok(receiptAt > -1, 'handlePdfCreateJob must write the receipt');
  assert.ok(receiptAt < body.indexOf('pdfClient.fetchPdfFromUrl'),
    'the receipt must be written before the URL download, or the silent window is back');
  assert.ok(receiptAt < body.indexOf('pdfClient.createJobFromUpload'),
    'and before the create');
  // The upload page's own receipt: written by the ticket handler, and only
  // once the ticket is granted — a refusal has no job to show.
  const ticket = source.slice(source.indexOf('async function handlePdfUploadTicket'),
    source.indexOf('async function handlePdfCreateJob'));
  const grantedAt = ticket.indexOf('await pdfClient.requestUploadTicket');
  const savedAt = ticket.indexOf('pdfClient.saveJobRecord(receipt)');
  assert.ok(grantedAt > -1 && savedAt > grantedAt,
    'the ticket handler writes the receipt after the ticket is granted');
  // Both are the same row, built once.
  assert.equal((source.match(/pending: true/g) || []).length, 0,
    'the receipt is pdfClient.receiptRecord, not a hand-built row');
});

test('polling steps over records that name no server job', () => {
  const source = repoFile('background/pdf-client.js');
  const body = source.slice(source.indexOf('export async function refreshJobRecords'));
  const guardAt = body.search(/isPendingRecord\(record\)\)\s*continue;/);
  assert.ok(
    guardAt > -1,
    'refreshJobRecords must skip pending records — getPdfJob would 404 and bury them'
  );
  assert.ok(guardAt < body.indexOf('await getPdfJob'));
});

test('the file name travels to the server, where the history reads it', () => {
  const source = repoFile('background/pdf-client.js');
  const body = source.slice(source.indexOf("apiFetch('/api/pdf/jobs'"));
  assert.match(body.slice(0, 400), /fileName:/);
});

test('the settings page loads the shared PDF helpers before its own script', () => {
  const html = repoFile('options/options.html');
  const ui = html.indexOf('pdf/pdf-ui.js');
  const own = html.indexOf('src="options.js"');
  assert.ok(ui > -1, 'options.html must load pdf/pdf-ui.js');
  assert.ok(ui < own);
});

test('a disabled menu item in the popup actually looks disabled', () => {
  // `disabled` alone is invisible there: .menu-item sets its own colour, so a
  // button mid-request would still read as clickable.
  assert.match(repoFile('popup/popup.css'), /\.menu-item:disabled\s*\{/);
});

// ---------------------------------------------------------------------------
// The link out to the web library
//
// The extension cannot render a PDF: Chrome's viewer is an out-of-process
// iframe with a closed shadow DOM. The website can, so the settings history
// links each job to it — which only works if the URL is built from the origin
// the service worker is actually configured with, and refuses to be built at
// all from anything else.
// ---------------------------------------------------------------------------

test('a job in the history links to the same job in the web library', () => {
  assert.equal(
    ui.pdfLibraryUrl('https://blab-translation.com', 'job-1'),
    'https://blab-translation.com/app/settings/pdf?job=job-1'
  );
  // No job: the library itself, which is what the card header links to.
  assert.equal(ui.pdfLibraryUrl('https://blab-translation.com'), 'https://blab-translation.com/app/settings/pdf');
  // A trailing slash or a path on the configured base must not reach the URL.
  assert.equal(
    ui.pdfLibraryUrl('https://staging.example.com/', 'job-1'),
    'https://staging.example.com/app/settings/pdf?job=job-1'
  );
  // An id is a server id, but it still goes through encodeURIComponent — a
  // link is not the place to find out that assumption was wrong.
  assert.equal(
    ui.pdfLibraryUrl('https://blab-translation.com', 'a/b?c=d'),
    'https://blab-translation.com/app/settings/pdf?job=a%2Fb%3Fc%3Dd'
  );
});

test('a pending job gets no link, because the server has no such job', () => {
  // The library reads an unknown ?job= as a hint and falls back to the newest
  // document, so this link would quietly open the wrong one.
  assert.equal(ui.pdfLibraryUrl('https://blab-translation.com', 'local:op-1'), '');
});

test('the library link cannot be built from a base that is not a web origin', () => {
  // The base comes out of chrome.storage, and this value ends up in an href.
  assert.equal(ui.pdfLibraryUrl('javascript:alert(1)', 'job-1'), '');
  assert.equal(ui.pdfLibraryUrl('', 'job-1'), '');
  assert.equal(ui.pdfLibraryUrl(null, 'job-1'), '');
  assert.equal(ui.pdfLibraryUrl('not a url', 'job-1'), '');
});

// ---------------------------------------------------------------------------
// The sticky URL → operationId binding, and when it must let go
//
// The binding exists so a retry after a lost response replays the SAME id and
// adopts the same job instead of paying twice. But the server adopts by
// (user, operationId) regardless of status, and billing refuses an id it
// already settled — so once the job behind an id is failed, abandoned or gone,
// every replay is the same dead end for the binding's whole 24h TTL. That was
// the "翻译此PDF fails forever after one hiccup" bug: a burned id must be
// released the moment it is seen to burn.
// ---------------------------------------------------------------------------

test('a URL keeps its operation id across clicks, until it is released', async () => {
  withStorage();
  const first = await pdf.getOrCreateUrlOperationId('https://arxiv.org/pdf/2312.00001');
  assert.equal(await pdf.getOrCreateUrlOperationId('https://arxiv.org/pdf/2312.00001'), first);
  await pdf.releaseUrlOperationId(first);
  const second = await pdf.getOrCreateUrlOperationId('https://arxiv.org/pdf/2312.00001');
  assert.notEqual(second, first, 'after a release the next click must mint a fresh id');
});

test('releasing an id no URL holds leaves the other bindings alone', async () => {
  withStorage();
  const kept = await pdf.getOrCreateUrlOperationId('https://arxiv.org/pdf/2312.00002');
  await pdf.releaseUrlOperationId('never-issued');
  await pdf.releaseUrlOperationId(null);
  assert.equal(await pdf.getOrCreateUrlOperationId('https://arxiv.org/pdf/2312.00002'), kept);
});

test('a poll that sees the job die releases the binding; a success keeps it', async () => {
  const store = withStorage({
    comicToken: 'token',
    pdfJobs: [
      { jobId: 'job-dead', operationId: 'op-dead', status: 'running', createdAt: Date.now() },
      { jobId: 'job-live', operationId: 'op-live', status: 'running', createdAt: Date.now() }
    ],
    pdfUrlOps: {
      'https://a.example/dead.pdf': { opId: 'op-dead', createdAt: Date.now() },
      'https://a.example/live.pdf': { opId: 'op-live', createdAt: Date.now() }
    }
  });
  globalThis.fetch = async (url) => ({
    ok: true,
    status: 200,
    json: async () => (String(url).includes('job-dead')
      ? { jobId: 'job-dead', status: 'failed', progress: 40, error: { code: 'budget_exceeded', message: '', refunded: true } }
      : { jobId: 'job-live', status: 'succeeded', progress: 100, results: {} })
  });
  const { changes } = await pdf.refreshJobRecords();
  assert.equal(changes.length, 2);
  assert.equal(store.pdfUrlOps['https://a.example/dead.pdf'], undefined,
    'the failed job burned its id — the binding must go');
  assert.ok(store.pdfUrlOps['https://a.example/live.pdf'],
    'a succeeded id stays: replaying it resolves instantly and free');
});

test('a job the server has forgotten releases its binding too', async () => {
  // The 404 case: swept server-side, or deleted from the web history. Its
  // billing reservation is settled, so a replay of the id would only 409.
  const store = withStorage({
    comicToken: 'token',
    pdfJobs: [{ jobId: 'job-gone', operationId: 'op-gone', status: 'running', createdAt: Date.now() }],
    pdfUrlOps: { 'https://a.example/gone.pdf': { opId: 'op-gone', createdAt: Date.now() } }
  });
  globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({ error: 'not_found' }) });
  const { changes } = await pdf.refreshJobRecords();
  assert.equal(changes.length, 1);
  assert.equal(changes[0].record.status, 'failed');
  assert.equal(changes[0].transition, 'settled');
  assert.deepEqual(store.pdfUrlOps, {});
});

test('the create path releases the id when the server says it is burned', () => {
  const source = repoFile('background/pdf-jobs.js');
  const body = source.slice(source.indexOf('async function handlePdfCreateJob'));
  // The 409 family that can never succeed on replay…
  for (const code of ['operation_already_finished', 'output_conflict', 'job_conflict']) {
    assert.ok(body.includes(`'${code}'`), `the create catch must recognise ${code}`);
  }
  assert.match(body, /releaseUrlOperationId\(operationId\)/,
    'and both the 409 catch and the terminal-on-arrival adopt must release the id');
  // …and the job that arrives already dead (the idempotent adopt of a failed
  // attempt), which no poll will ever transition.
  assert.ok(
    /job\.status === 'failed' \|\| job\.status === 'abandoned'/.test(body),
    'a job terminal on arrival burns the id too'
  );
});

test('the upload page re-mints a burned operation id before offering retry', () => {
  // Same class of bug as the URL binding, bytes edition: the page keeps one
  // operationId per chosen file, and a Retry replaying it after a terminal
  // job would only re-adopt the same dead job.
  const source = uploadPageSource();
  const remint = source.slice(source.indexOf('function remint'), source.indexOf('function remint') + 200);
  assert.match(remint, /\.operationId = crypto\.randomUUID\(\)/,
    'remint must mint a fresh id');
  const view = source.slice(source.indexOf('function handleView'), source.indexOf('async function poll'));
  assert.match(view, /\(view\.status === 'failed' \|\| view\.status === 'abandoned'\) && currentFile\) remint\(currentFile\)/,
    'a terminal job must burn the id the next retry would otherwise replay');
  const start = source.slice(source.indexOf('async function startJob'));
  assert.match(source, /BURNED_ID_CODES = new Set\(\['operation_already_finished'/,
    'a settled-operation 409 must re-mint too');
  assert.match(start, /BURNED_ID_CODES\.has\(error\.code\)\) remint\(file\)/);
});

// ---------------------------------------------------------------------------
// One error map, honest copy
// ---------------------------------------------------------------------------

await import('../../i18n/messages.js');
const t = (key) => globalThis.getMessage(key, 'en');

test('the worker and the pages read the same error map', () => {
  // The map lives once, in shared/pdf-errors.js; both re-export it.
  assert.equal(pdf.pdfErrorMessageKey, ui.pdfErrorMessageKey);
  const pages = ['popup/popup.html', 'pdf/upload.html', 'options/options.html'];
  for (const page of pages) {
    const html = repoFile(page);
    const docJobs = html.indexOf('shared/doc-jobs.js');
    const shared = html.indexOf('shared/pdf-errors.js');
    const uiAt = html.indexOf('pdf-ui.js');
    assert.ok(shared > -1, `${page} must load shared/pdf-errors.js`);
    assert.ok(shared < uiAt, `${page} must load it before pdf-ui.js, which reads it`);
    // The map reads DocJobs (megabyteLabel, the format table) at call time.
    assert.ok(docJobs > -1 && docJobs < shared, `${page} must load shared/doc-jobs.js before pdf-errors.js`);
  }
});

test('the codes behind the retry-poisoning bug map to actionable copy', () => {
  assert.equal(ui.pdfErrorMessageKey('dispatch_rejected'), 'pdfErrBusy');
  assert.equal(ui.pdfErrorMessageKey('operation_already_finished'), 'pdfErrRetry');
  assert.equal(ui.pdfErrorMessageKey('job_conflict'), 'pdfErrRetry');
  assert.equal(ui.pdfErrorMessageKey('output_conflict'), 'pdfErrOutputConflict');
  assert.equal(ui.pdfErrorMessageKey('source_download_failed'), 'pdfErrUnavailable');
  assert.equal(ui.pdfErrorMessageKey('delivery_unreadable'), 'pdfErrEngine');
  assert.equal(ui.pdfErrorMessageKey('invalid_operation_id'), 'pdfErrInvalid');
  assert.equal(ui.pdfErrorMessageKey('missing_operation_id'), 'pdfErrInvalid');
  assert.equal(ui.pdfErrorMessageKey('invalid_byte_size'), 'pdfErrInvalid');
  // apiFetch mints http_<status> when the body carries no code.
  assert.equal(ui.pdfErrorMessageKey('http_503'), 'pdfErrUnavailable');
  assert.equal(ui.pdfErrorMessageKey('http_404'), 'pdfFailed');
});

test('the page-limit message shows the cap the server actually enforced', () => {
  // The server sends { maxPages } with too_many_pages; a ComicApiError carries
  // it under details, its toMessage() flattening carries it at the top level.
  assert.equal(
    ui.pdfErrorMessage({ code: 'too_many_pages', details: { maxPages: 32 } }, t),
    'This document has too many pages (32 max)'
  );
  assert.equal(
    ui.pdfErrorMessage({ code: 'too_many_pages', maxPages: 48 }, t),
    'This document has too many pages (48 max)'
  );
  // A stored record error without the cap says so in words — never a made-up
  // number, never the raw placeholder.
  assert.equal(ui.pdfErrorMessage({ code: 'too_many_pages' }, t), 'This document has too many pages');
  assert.equal(ui.pdfErrorMessageKey('too_many_pages', {}), 'docErrTooManyPagesNoMax');
});

test('every locale carries the new copy, and none leaks the placeholder', () => {
  const PLACEHOLDERS = ['{max}', '{pageCount}', '{maxPages}', '{measured}', '{reserved}',
    '{extra}', '{expires}', '{percent}', '{pdf}', '{book}', '{text}'];
  const holes = (text) => [...new Set(String(text).match(/\{[a-zA-Z]+\}/g) || [])].sort().join(',');
  const en = globalThis.I18N_MESSAGES.en;
  // Every document/PDF string that interpolates anything, as English has it.
  const keyed = Object.keys(en).filter((k) => /^(pdf|doc)/.test(k) && holes(en[k]));
  const covered = keyed.map((k) => holes(en[k])).join(',');
  for (const hole of PLACEHOLDERS) assert.ok(covered.includes(hole), `no document string carries ${hole}`);
  for (const [lang, table] of Object.entries(globalThis.I18N_MESSAGES)) {
    for (const key of ['pdfErrBusy', 'pdfErrRetry', 'pdfErrOutputConflict', 'docErrTooManyPagesNoMax']) {
      assert.ok(table[key], `${lang} is missing ${key}`);
    }
    // Same holes as English, key by key: a translation that drops {max} shows
    // a sentence with no number; one that invents {pages} shows the braces.
    for (const key of keyed) {
      assert.ok(table[key], `${lang} is missing ${key}`);
      assert.equal(holes(table[key]), holes(en[key]), `${lang}.${key} placeholders differ from en`);
    }
    assert.match(table.pdfErrTooManyPages, /\{maxPages\}/,
      `${lang}.pdfErrTooManyPages must interpolate the server's cap, not hardcode one`);
    const tr = (key) => globalThis.getMessage(key, lang);
    const errors = [
      { code: 'too_many_pages', maxPages: 32 },
      { code: 'too_many_pages' },
      { code: 'too_many_pages', details: { maxPages: 300, pageCount: 412, format: 'epub' } },
      { code: 'file_too_large', details: { format: 'pdf' } },
      { code: 'file_too_large' },
      { code: 'unsupported_format', details: { format: 'docx' } },
      { code: 'unsupported_format' }
    ];
    for (const error of errors) {
      const rendered = ui.pdfErrorMessage(error, tr);
      assert.ok(rendered && rendered !== 'undefined', `${lang} rendered nothing for ${error.code}`);
      assert.doesNotMatch(rendered, /\{[a-zA-Z]+\}/, `${lang} leaked a placeholder for ${JSON.stringify(error)}: ${rendered}`);
    }
  }
});

test('the settings page asks the worker for the origin instead of hardcoding one', () => {
  // 设置页拆成了一组同级脚本，哪一行落在哪个文件里是排版；这里问的是这一页。
  const options = optionsSource();
  assert.match(options, /ACCOUNT_SITE_BASE/);
  assert.match(options, /PDF_UI\.pdfLibraryUrl\(accountSiteBase, job\.jobId\)/);
  // The default origin lives in comic-client.js; a second copy here would be
  // the one that goes stale. Both the current origin and the pre-G1 one it
  // replaced are refused: a stale paste of the old name is the same bug, and
  // renaming the guard to the new domain alone would have let it through.
  assert.doesNotMatch(options, /blab-translation\.com/);
  assert.doesNotMatch(options, /translators-ai\.com/);

  const background = repoFile('background/background.js');
  assert.match(background, /case 'ACCOUNT_SITE_BASE':/);
});
