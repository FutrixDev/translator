// Behaviour of the document job records across every status the server can
// report — the awaiting_confirm state in particular, which is neither active
// nor terminal and which every hand-built status set used to get wrong.
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';

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
await import('../../shared/pdf-url.js');
await import('../../pdf/pdf-ui.js');
const ui = globalThis.AI_TRANSLATOR_PDF_UI;
const errors = globalThis.AI_TRANSLATOR_PDF_ERRORS;

const HOUR = 60 * 60 * 1000;
const STATUSES = ['queued', 'running', 'awaiting_confirm', 'succeeded', 'failed', 'abandoned'];
const TERMINAL = new Set(['succeeded', 'failed', 'abandoned']);
const t = key => key;

// ---------------------------------------------------------------------------
// applyJobView: every status against every status
// ---------------------------------------------------------------------------

test('applyJobView names the transition for every pair of statuses', () => {
  for (const before of STATUSES) {
    for (const after of STATUSES) {
      const record = { jobId: 'j', status: before, createdAt: 1, settledAt: TERMINAL.has(before) ? 5 : null };
      const { record: next, transition, leftAwaiting } = pdf.applyJobView(record, { status: after, progress: 0 });
      const label = `${before} -> ${after}`;
      const expected = TERMINAL.has(after) && !TERMINAL.has(before)
        ? 'settled'
        : (after === 'awaiting_confirm' && before !== 'awaiting_confirm' ? 'awaiting' : null);
      assert.equal(transition, expected, label);
      assert.equal(leftAwaiting, before === 'awaiting_confirm' && after !== 'awaiting_confirm', label);
      // The invariant: settledAt is set if and only if the status is terminal.
      if (TERMINAL.has(after)) {
        assert.ok(Number.isFinite(next.settledAt) && next.settledAt > 0, `${label} stamps settledAt`);
      } else {
        assert.equal(next.settledAt, null, `${label} clears settledAt`);
      }
    }
  }
});

test('a terminal record keeps the moment it first settled', () => {
  const { record } = pdf.applyJobView({ jobId: 'j', status: 'failed', settledAt: 42 }, { status: 'failed' });
  assert.equal(record.settledAt, 42);
});

test('the view owns status, progress, stage, results, error and confirm', () => {
  const confirm = { extraUnits: 3, reservedUnits: 10, measuredUnits: 13 };
  const { record } = pdf.applyJobView(
    { jobId: 'j', status: 'running', fileName: 'a.docx', sourceFormat: 'docx', operationId: 'op' },
    { status: 'awaiting_confirm', progress: 12, stage: 'measuring', pageCount: 13, confirm }
  );
  assert.deepEqual(record.confirm, confirm);
  assert.equal(record.pageCount, 13);
  assert.equal(record.fileName, 'a.docx', 'fields the view does not own survive');
  assert.equal(record.sourceFormat, 'docx');
  assert.equal(record.operationId, 'op');
});

// ---------------------------------------------------------------------------
// TTLs and the cap
// ---------------------------------------------------------------------------

test('an awaiting record outlives the server\'s 72 h hold and goes after 96 h', async () => {
  const now = Date.now();
  withStorage({
    pdfJobs: [
      { jobId: 'kept', status: 'awaiting_confirm', createdAt: now - 95 * HOUR, settledAt: null },
      { jobId: 'gone', status: 'awaiting_confirm', createdAt: now - 97 * HOUR, settledAt: null }
    ]
  });
  const ids = (await pdf.listJobRecords()).map(r => r.jobId);
  assert.deepEqual(ids, ['kept']);
});

test('a finished record goes a day after it finished, not after it was created', async () => {
  const now = Date.now();
  withStorage({
    pdfJobs: [
      { jobId: 'late', status: 'succeeded', createdAt: now - 90 * HOUR, settledAt: now - 23 * HOUR },
      { jobId: 'old', status: 'failed', createdAt: now - 30 * HOUR, settledAt: now - 25 * HOUR }
    ]
  });
  const ids = (await pdf.listJobRecords()).map(r => r.jobId);
  assert.deepEqual(ids, ['late']);
});

test('a pending record is buried 20 minutes after the create, not before', async () => {
  const now = Date.now();
  withStorage({
    pdfJobs: [
      { jobId: 'local:a', pending: true, status: 'queued', createdAt: now - 19 * 60 * 1000 },
      { jobId: 'local:b', pending: true, status: 'queued', createdAt: now - 21 * 60 * 1000 }
    ]
  });
  const byId = Object.fromEntries((await pdf.listJobRecords()).map(r => [r.jobId, r]));
  assert.equal(byId['local:a'].status, 'queued');
  assert.equal(byId['local:b'].status, 'failed');
  assert.equal(byId['local:b'].error.code, 'no_response');
  assert.ok(byId['local:b'].settledAt > 0);
});

test('over the cap, finished records are forgotten before unfinished ones', () => {
  const records = [
    { jobId: 'new-done', status: 'succeeded', createdAt: 50 },
    { jobId: 'awaiting', status: 'awaiting_confirm', createdAt: 10 },
    { jobId: 'running', status: 'running', createdAt: 20 },
    { jobId: 'old-done', status: 'failed', createdAt: 30 }
  ];
  assert.deepEqual(pdf.capRecords(records, 2).map(r => r.jobId), ['running', 'awaiting']);
  assert.deepEqual(pdf.capRecords(records, 3).map(r => r.jobId), ['new-done', 'running', 'awaiting']);
  // With nothing finished left, the oldest unfinished record goes.
  assert.deepEqual(pdf.capRecords(records, 1).map(r => r.jobId), ['running']);
  assert.equal(pdf.capRecords(records, 10).length, 4);
});

test('a create that lands on awaiting_confirm is not stamped as settled', async () => {
  withStorage();
  const receipt = pdf.receiptRecord({ operationId: 'op-1', fileName: 'book.epub', sourceFormat: 'epub' });
  await pdf.saveJobRecord(receipt);
  const merged = await pdf.replaceJobRecord(receipt.jobId, {
    jobId: 'job-1', status: 'awaiting_confirm', confirm: { extraUnits: 2 }
  });
  assert.equal(merged.settledAt, null);
  assert.equal(merged.pending, false);
  assert.equal(merged.fileName, 'book.epub');
  const records = await pdf.listJobRecords();
  assert.deepEqual(records.map(r => r.jobId), ['job-1'], 'the receipt is replaced in one write');
});

test('a receipt without a file name is named after its format', () => {
  assert.equal(pdf.receiptRecord({ operationId: 'o', sourceFormat: 'md' }).fileName, 'document.md');
  assert.equal(pdf.receiptRecord({ operationId: 'o', sourceFormat: 'pdf' }).fileName, 'document.pdf');
});

// ---------------------------------------------------------------------------
// The poll
// ---------------------------------------------------------------------------

test('the poll asks about awaiting jobs and steps over pending ones', async () => {
  const now = Date.now();
  const store = withStorage({
    comicToken: 'test-token',
    pdfJobs: [
      { jobId: 'job-wait', operationId: 'op-w', status: 'awaiting_confirm', createdAt: now, settledAt: null },
      { jobId: 'local:op-p', pending: true, status: 'queued', createdAt: now },
      { jobId: 'job-done', status: 'succeeded', createdAt: now, settledAt: now }
    ]
  });
  const asked = [];
  globalThis.fetch = async (url) => {
    asked.push(String(url));
    return { ok: true, status: 200, json: async () => ({ id: 'job-wait', status: 'running', progress: 40 }) };
  };
  const { changes } = await pdf.refreshJobRecords();
  assert.equal(asked.length, 1);
  assert.match(asked[0], /job-wait/);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].leftAwaiting, true);
  assert.equal(changes[0].transition, null);
  assert.equal(store.pdfJobs.find(r => r.jobId === 'job-wait').status, 'running');
});

test('the poll reports a job that just started waiting', async () => {
  withStorage({
    comicToken: 'test-token',
    pdfJobs: [{ jobId: 'job-1', status: 'running', createdAt: Date.now() }]
  });
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ id: 'job-1', status: 'awaiting_confirm', confirm: { extraUnits: 4 } })
  });
  const { changes } = await pdf.refreshJobRecords();
  assert.equal(changes.length, 1);
  assert.equal(changes[0].transition, 'awaiting');
  assert.equal(changes[0].record.settledAt, null);
});

test('a page-driven update releases the URL binding of a job that was abandoned', async () => {
  const store = withStorage({
    pdfJobs: [{ jobId: 'job-1', operationId: 'op-1', status: 'awaiting_confirm', createdAt: Date.now() }],
    pdfUrlOps: { 'https://a.example/x.pdf': { opId: 'op-1', createdAt: Date.now() } }
  });
  const change = await pdf.updateRecordFromView('job-1', { status: 'abandoned', error: { code: 'abandoned' } });
  assert.equal(change.transition, 'settled');
  assert.equal(change.leftAwaiting, true);
  assert.deepEqual(store.pdfUrlOps, {});
  assert.equal(await pdf.updateRecordFromView('no-such-job', { status: 'failed' }), null,
    'a job this device never ran gets no record');
});

test('a success keeps the URL binding so a replay resolves for free', async () => {
  const store = withStorage({
    pdfJobs: [{ jobId: 'job-1', operationId: 'op-1', status: 'running', createdAt: Date.now() }],
    pdfUrlOps: { 'https://a.example/x.pdf': { opId: 'op-1', createdAt: Date.now() } }
  });
  await pdf.updateRecordFromView('job-1', { status: 'succeeded' });
  assert.ok(store.pdfUrlOps['https://a.example/x.pdf']);
});

// ---------------------------------------------------------------------------
// Writes that overlap
// ---------------------------------------------------------------------------

/**
 * chrome.storage.local as it really behaves under load: every call yields to
 * the event loop, and what get() hands back is a copy. The plain fake above
 * returns the stored array itself, so a stale write could never lose a row.
 */
function withRacingStorage(initial = {}) {
  const store = structuredClone(initial);
  const tick = () => new Promise(resolve => setImmediate(resolve));
  globalThis.chrome = {
    storage: {
      local: {
        get: async (defaults) => {
          await tick();
          const out = { ...defaults };
          for (const key of Object.keys(defaults)) {
            if (key in store) out[key] = structuredClone(store[key]);
          }
          return out;
        },
        set: async (values) => {
          await tick();
          Object.assign(store, structuredClone(values));
        }
      }
    }
  };
  return store;
}

/** A fetch that answers only when told to: the poll's request in flight. */
function heldFetch() {
  const held = [];
  globalThis.fetch = (url) => new Promise(resolve => held.push({ url: String(url), resolve }));
  return {
    held,
    asked: () => new Promise(function wait(resolve) {
      if (held.length) resolve(); else setImmediate(() => wait(resolve));
    }),
    answer: (body) => {
      for (const { resolve } of held.splice(0)) resolve({ ok: true, status: 200, json: async () => body });
    }
  };
}

test('an upload saved while the poll waits on the server keeps its row', async () => {
  const store = withRacingStorage({
    comicToken: 'test-token',
    pdfJobs: [{ jobId: 'job-1', operationId: 'op-1', status: 'running', createdAt: Date.now() - 1000 }]
  });
  const server = heldFetch();
  const polling = pdf.refreshJobRecords();
  await server.asked();
  await pdf.saveJobRecord(pdf.receiptRecord({ operationId: 'op-2', fileName: 'b.pdf', sourceFormat: 'pdf' }));
  server.answer({ id: 'job-1', status: 'succeeded', progress: 100 });
  const { changes } = await polling;
  assert.deepEqual(store.pdfJobs.map(r => [r.jobId, r.status]), [['local:op-2', 'queued'], ['job-1', 'succeeded']]);
  assert.equal(changes.length, 1);
});

test('two polls that see the same job finish report it once', async () => {
  withRacingStorage({
    comicToken: 'test-token',
    pdfJobs: [{ jobId: 'job-1', operationId: 'op-1', status: 'running', createdAt: Date.now() }]
  });
  const server = heldFetch();
  const first = pdf.refreshJobRecords();
  const second = pdf.refreshJobRecords();
  while (server.held.length < 2) await server.asked().then(() => new Promise(r => setImmediate(r)));
  server.answer({ id: 'job-1', status: 'succeeded', progress: 100 });
  const settled = [...(await first).changes, ...(await second).changes].filter(c => c.transition === 'settled');
  assert.equal(settled.length, 1, 'one notification for one finished job');
});

test('a page seeing the job finish first leaves the poll nothing to report', async () => {
  withRacingStorage({
    comicToken: 'test-token',
    pdfJobs: [{ jobId: 'job-1', operationId: 'op-1', status: 'running', createdAt: Date.now() }]
  });
  const server = heldFetch();
  const polling = pdf.refreshJobRecords();
  await server.asked();
  const page = await pdf.updateRecordFromView('job-1', { status: 'succeeded', progress: 100 });
  assert.equal(page.transition, 'settled');
  server.answer({ id: 'job-1', status: 'succeeded', progress: 100 });
  assert.deepEqual((await polling).changes, []);
});

test('saves and dismissals at once all land', async () => {
  const now = Date.now();
  const store = withRacingStorage({
    pdfJobs: [{ jobId: 'job-old', status: 'succeeded', createdAt: now - 3000, settledAt: now }]
  });
  await Promise.all([
    pdf.saveJobRecord({ jobId: 'job-a', status: 'running', createdAt: now }),
    pdf.saveJobRecord({ jobId: 'job-b', status: 'running', createdAt: now - 1000 }),
    pdf.dismissJobRecord('job-old'),
  ]);
  assert.deepEqual(store.pdfJobs.map(r => r.jobId), ['job-a', 'job-b']);
});

test('URL bindings claimed and released at once all land', async () => {
  const store = withRacingStorage({
    pdfUrlOps: { 'https://a.example/old.pdf': { opId: 'op-old', createdAt: Date.now() } }
  });
  const [a, b] = await Promise.all([
    pdf.getOrCreateUrlOperationId('https://a.example/a.pdf'),
    pdf.getOrCreateUrlOperationId('https://a.example/b.pdf'),
    pdf.releaseUrlOperationId('op-old'),
  ]);
  assert.deepEqual(Object.fromEntries(Object.entries(store.pdfUrlOps).map(([url, e]) => [url, e.opId])),
    { 'https://a.example/a.pdf': a, 'https://a.example/b.pdf': b });
});

// ---------------------------------------------------------------------------
// Error facts and the copy chosen from them (spec §7.1)
// ---------------------------------------------------------------------------

test('errorRecordFrom keeps the facts the copy interpolates, from either shape', () => {
  assert.deepEqual(
    pdf.errorRecordFrom({ code: 'too_many_pages', message: 'm', details: { maxPages: 800, format: 'epub', pageCount: 912 } }),
    { code: 'too_many_pages', message: 'm', maxPages: 800, format: 'epub', pageCount: 912 }
  );
  assert.deepEqual(pdf.errorRecordFrom({ code: 'abandoned', refunded: true }),
    { code: 'abandoned', message: '', refunded: true });
  assert.deepEqual(pdf.errorRecordFrom(null), { code: 'engine_error', message: '' });
});

test('the error map picks the sentence the facts can fill', () => {
  const key = pdf.pdfErrorMessageKey;
  assert.equal(key('too_many_pages', { maxPages: 500 }), 'pdfErrTooManyPages');
  assert.equal(key('too_many_pages', {}), 'docErrTooManyPagesNoMax');
  assert.equal(key('too_many_pages', { maxPages: 800, pageCount: 912, format: 'epub' }), 'docErrTooLongFlow');
  assert.equal(key('too_many_pages', { maxPages: 500, pageCount: 612, format: 'pdf' }), 'pdfErrTooManyPages');
  assert.equal(key('unsupported_format', { format: 'docx' }), 'docErrMismatch');
  assert.equal(key('unsupported_format', { format: 'rtf' }), 'docErrUnsupported');
  assert.equal(key('unsupported_format', {}), 'docErrUnsupported');
  assert.equal(key('file_too_large'), 'pdfErrTooLarge');
  assert.equal(key('empty_document'), 'docErrEmpty');
  assert.equal(key('page_count_unknown'), 'docErrPageCountUnknown');
  assert.equal(key('not_awaiting_confirm'), 'docErrNotAwaiting');
  assert.equal(key('abandoned', { refunded: true }), 'docErrAbandonedRefunded');
  assert.equal(key('abandoned', {}), 'docErrAbandoned');
  assert.equal(key('http_503'), 'pdfErrUnavailable');
  assert.equal(key('something_new'), 'pdfFailed');
});

test('the abandoned wording is one answer for every surface', () => {
  assert.equal(errors.pdfAbandonedKey({ code: 'queue_timeout' }), 'docErrQueueTimeout');
  assert.equal(errors.pdfAbandonedKey({ code: 'abandoned', refunded: true }), 'docErrAbandonedRefunded');
  assert.equal(errors.pdfAbandonedKey({ code: 'abandoned', details: { refunded: true } }), 'docErrAbandonedRefunded');
  assert.equal(errors.pdfAbandonedKey({}), 'pdfStatusAbandoned');
});

test('retry is offered only when a second attempt could answer differently', () => {
  for (const code of ['unsupported_format', 'empty_document', 'file_too_large', 'too_many_pages',
    'page_count_unknown', 'insufficient_points', 'feature_disabled', 'abandoned']) {
    assert.equal(ui.isRetryablePdfFailure({ code }), false, code);
  }
  for (const code of ['engine_error', 'no_response', 'dispatch_rejected', 'operation_already_finished']) {
    assert.equal(ui.isRetryablePdfFailure({ code }), true, code);
  }
});

test('the status line paints only a failure red', () => {
  assert.deepEqual(ui.pdfStatusLine({ status: 'awaiting_confirm' }, t),
    { text: 'docStatusAwaitingConfirm', isError: false });
  assert.deepEqual(ui.pdfStatusLine({ status: 'abandoned', error: { code: 'queue_timeout' } }, t),
    { text: 'docErrQueueTimeout', isError: false });
  assert.deepEqual(ui.pdfStatusLine({ status: 'failed', error: { code: 'empty_document' } }, t),
    { text: 'docErrEmpty', isError: true });
  assert.equal(ui.pdfStatusLine({ status: 'succeeded' }, t).isError, false);
});

// ---------------------------------------------------------------------------
// Notification ids
// ---------------------------------------------------------------------------

test('a notification click is routed by its own prefixes only', async () => {
  const notify = await import('../../background/pdf-notify.js');
  assert.equal(notify.jobIdFromNotificationId('pdf-job-abc'), 'abc');
  assert.equal(notify.jobIdFromNotificationId('pdf-confirm-abc'), 'abc');
  assert.equal(notify.jobIdFromNotificationId('pdf-job-'), null);
  assert.equal(notify.jobIdFromNotificationId('pdf-charge-op-1'), null);
  assert.equal(notify.jobIdFromNotificationId(undefined), null);
});
