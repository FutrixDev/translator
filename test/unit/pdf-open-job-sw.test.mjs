// Where a document job opens from the service worker (D-488): the notification
// click and the PDF_OPEN_JOB message both end in openPdfJob, which sends a
// finished job of any format to the web reader and every other job to the
// extension's job page.
//
// Behavioural, over the real worker modules, like media-consent-sw.test.mjs:
// the listeners the worker registers are the ones answering, storage is an
// in-memory copy, the network answers the job view the test names, and the
// tabs the worker opens are recorded. The notification harness in Playwright
// cannot fire chrome.notifications.onClicked, so this is J5's evidence.
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';

const local = { comicToken: 'tok', comicApiBase: 'https://site.test/' };
const sync = { enablePdfTranslation: true };
const opened = [];
const messageListeners = [];
const clickListeners = [];
let jobView = null;

function area(store) {
  return {
    get: async (keys) => {
      if (keys == null) return { ...store };
      const defaults = typeof keys === 'string' ? { [keys]: undefined }
        : Array.isArray(keys) ? Object.fromEntries(keys.map((key) => [key, undefined])) : keys;
      const out = {};
      for (const [key, value] of Object.entries(defaults)) {
        if (key in store) out[key] = store[key];
        else if (value !== undefined) out[key] = value;
      }
      return out;
    },
    set: async (values) => { Object.assign(store, values); },
    remove: async (keys) => { for (const key of [].concat(keys)) delete store[key]; },
  };
}

/** Whatever the worker touches at load that this test has no opinion about. */
function standIn() {
  const fn = () => standIn();
  return new Proxy(fn, {
    get: (_target, prop) => (prop === 'then' ? undefined : standIn()),
    apply: () => undefined,
  });
}

const passThrough = (target) => ({ get: (t, prop) => (prop in t ? t[prop] : standIn()) });

globalThis.chrome = new Proxy({
  storage: { sync: area(sync), local: area(local), session: area({}), onChanged: { addListener() {} } },
  runtime: new Proxy({
    onMessage: { addListener: (fn) => messageListeners.push(fn) },
    getURL: (p) => `chrome-extension://test/${p}`,
    lastError: undefined,
  }, passThrough()),
  tabs: new Proxy({
    create: async ({ url }) => { opened.push(url); return { id: opened.length }; },
  }, passThrough()),
  notifications: new Proxy({
    onClicked: { addListener: (fn) => clickListeners.push(fn) },
    clear: (_id, callback) => { if (callback) callback(true); },
  }, passThrough()),
}, passThrough());

// Matched on the path alone, so the test can hand the worker a site base the
// reader link refuses while the job poll still answers.
globalThis.fetch = async (url) => {
  if (!jobView || !String(url).includes('/api/pdf/jobs/')) {
    return new Response(JSON.stringify({ error: { code: 'not_found' } }), { status: 404 });
  }
  return new Response(JSON.stringify(jobView), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
};

await import('../../background/background.js');

function send(message) {
  return new Promise((resolve) => {
    for (const listener of messageListeners) listener(message, {}, resolve);
  });
}

/** Click a job's notification and wait until the worker has opened something. */
async function clickNotification(jobId) {
  const before = opened.length;
  for (const listener of clickListeners) listener(`pdf-job-${jobId}`);
  for (let i = 0; i < 200 && opened.length === before; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return opened.slice(before);
}

const finished = (jobId, format) => ({
  jobId,
  status: 'succeeded',
  format,
  sourceFormat: format,
  results: { dualUrl: `https://r2.test/${jobId}/dual`, monoUrl: `https://r2.test/${jobId}/mono` },
});

test('J5: a finished PDF\'s notification opens the reader, not the result file', async () => {
  assert.equal(clickListeners.length, 1, 'the worker registers one notification click listener');
  jobView = finished('pdf_job_7', 'pdf');
  assert.deepEqual(await clickNotification('pdf_job_7'), ['https://site.test/app/reader/pdf_job_7']);
});

test('J5: a finished Word job opens the reader too', async () => {
  jobView = finished('doc job/8', 'docx');
  assert.deepEqual(await clickNotification('doc job/8'), ['https://site.test/app/reader/doc%20job%2F8']);
});

test('an awaiting or running job opens the extension job page', async () => {
  jobView = { jobId: 'job_9', status: 'awaiting_confirm', format: 'pdf' };
  assert.deepEqual(await clickNotification('job_9'), ['chrome-extension://test/pdf/upload.html#job=job_9']);
  jobView = { jobId: 'job_10', status: 'running', format: 'pdf', progress: 40 };
  assert.deepEqual(await clickNotification('job_10'), ['chrome-extension://test/pdf/upload.html#job=job_10']);
});

test('a job the poll cannot refresh opens its job page, which shows the error', async () => {
  jobView = null;
  assert.deepEqual(await clickNotification('job_11'), ['chrome-extension://test/pdf/upload.html#job=job_11']);
});

test('PDF_OPEN_JOB from a row: a finished job opens the reader and says so', async () => {
  jobView = finished('pdf_job_12', 'pdf');
  const before = opened.length;
  const reply = await send({ type: 'PDF_OPEN_JOB', jobId: 'pdf_job_12' });
  assert.deepEqual(reply, { ok: true, data: { opened: 'reader' } });
  assert.deepEqual(opened.slice(before), ['https://site.test/app/reader/pdf_job_12']);
});

test('PDF_OPEN_JOB: a base that is not http(s) is an error, not a detour', async () => {
  jobView = finished('pdf_job_13', 'pdf');
  const base = local.comicApiBase;
  local.comicApiBase = 'javascript:alert(1)';
  const before = opened.length;
  try {
    const reply = await send({ type: 'PDF_OPEN_JOB', jobId: 'pdf_job_13' });
    assert.equal(reply.ok, false);
    assert.equal(reply.error.code, 'invalid_site_base');
    assert.deepEqual(opened.slice(before), [], 'nothing opened');
  } finally {
    local.comicApiBase = base;
  }
});

test('PDF_OPEN_JOB: a pending local: record names no job and opens nothing', async () => {
  const before = opened.length;
  const reply = await send({ type: 'PDF_OPEN_JOB', jobId: 'local:op-1' });
  assert.equal(reply.ok, false);
  assert.equal(reply.error.code, 'result_unavailable');
  assert.deepEqual(opened.slice(before), []);
});
