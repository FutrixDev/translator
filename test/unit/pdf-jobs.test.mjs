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

// The popup and the upload page get the same helpers as a classic script.
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
  const elevenMinutesAgo = Date.now() - 11 * 60 * 1000;
  withStorage({
    pdfJobs: [{ jobId: 'local:op-1', status: 'queued', pending: true, createdAt: elevenMinutesAgo }]
  });
  const [record] = await pdf.listJobRecords();
  assert.equal(record.status, 'failed');
  assert.equal(record.error.code, 'no_response');
});

test('a fresh pending record is left alone', async () => {
  withStorage({
    pdfJobs: [{ jobId: 'local:op-1', status: 'queued', pending: true, createdAt: Date.now() }]
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

// ---------------------------------------------------------------------------
// The wiring these records depend on
// ---------------------------------------------------------------------------

test('the settings history merges only the local rows still in flight', () => {
  const source = repoFile('background/background.js');
  const body = source.slice(source.indexOf('async function handlePdfJobsHistory'));
  assert.ok(
    /records\.filter\(r => pdfClient\.isPendingInFlight\(r\)\)/.test(body),
    'a settled local row must not be prepended to the server list'
  );
});

test('the record is written before the work that can fail, not after it', () => {
  const source = repoFile('background/background.js');
  const body = source.slice(source.indexOf('async function handlePdfCreateJob'));
  const pendingAt = body.indexOf('pending: true');
  const createAt = body.indexOf('pdfClient.createPdfJob');
  assert.ok(pendingAt > -1, 'handlePdfCreateJob must write a pending record');
  assert.ok(createAt > -1);
  assert.ok(
    pendingAt < createAt,
    'the pending record must be written before the create, or the silent window is back'
  );
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
