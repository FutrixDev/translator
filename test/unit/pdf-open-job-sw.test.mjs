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
const buttonListeners = [];
const created = [];
const fetched = [];
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
    onButtonClicked: { addListener: (fn) => buttonListeners.push(fn) },
    create: (id, options, callback) => { created.push({ id, options }); if (callback) callback(id); },
    clear: (_id, callback) => { if (callback) callback(true); },
  }, passThrough()),
}, passThrough());

// Matched on the path alone, so the test can hand the worker a site base the
// reader link refuses while the job poll still answers.
globalThis.fetch = async (url) => {
  fetched.push(String(url));
  if (!jobView || !String(url).includes('/api/pdf/jobs/')) {
    return new Response(JSON.stringify({ error: { code: 'not_found' } }), { status: 404 });
  }
  return new Response(JSON.stringify(jobView), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
};

await import('../../background/background.js');

function send(message, sender = {}) {
  return new Promise((resolve) => {
    for (const listener of messageListeners) listener(message, sender, resolve);
  });
}

/**
 * Click a job's notification — its body, or with `button` its "View
 * translation" button — and wait until the worker has opened something.
 */
async function clickNotification(jobId, { button = false } = {}) {
  const before = opened.length;
  for (const listener of button ? buttonListeners : clickListeners) {
    listener(`pdf-job-${jobId}`, ...(button ? [0] : []));
  }
  for (let i = 0; i < 200 && opened.length === before; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  // Long enough for a second listener's tab to land too, had one opened it.
  await new Promise((resolve) => setTimeout(resolve, 20));
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
  jobView = finished('pdf_job_7', 'pdf');
  assert.deepEqual(await clickNotification('pdf_job_7'), ['https://site.test/app/reader/pdf_job_7?utm_source=extension&utm_medium=notification']);
});

test('J5: a finished Word job opens the reader too', async () => {
  jobView = finished('doc job/8', 'docx');
  assert.deepEqual(await clickNotification('doc job/8'), ['https://site.test/app/reader/doc%20job%2F8?utm_source=extension&utm_medium=notification']);
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
  const reply = await send({ type: 'PDF_OPEN_JOB', jobId: 'pdf_job_12', via: 'popup' });
  assert.deepEqual(reply, { ok: true, data: { opened: 'reader' } });
  assert.deepEqual(opened.slice(before), ['https://site.test/app/reader/pdf_job_12?utm_source=extension&utm_medium=popup']);
});

test('PDF_OPEN_JOB: a base that is not http(s) is an error, not a detour', async () => {
  jobView = finished('pdf_job_13', 'pdf');
  const base = local.comicApiBase;
  local.comicApiBase = 'javascript:alert(1)';
  const before = opened.length;
  try {
    const reply = await send({ type: 'PDF_OPEN_JOB', jobId: 'pdf_job_13', via: 'popup' });
    assert.equal(reply.ok, false);
    assert.equal(reply.error.code, 'invalid_site_base');
    assert.deepEqual(opened.slice(before), [], 'nothing opened');
  } finally {
    local.comicApiBase = base;
  }
});

test('PDF_OPEN_JOB: a pending local: record names no job and opens nothing', async () => {
  const before = opened.length;
  const reply = await send({ type: 'PDF_OPEN_JOB', jobId: 'local:op-1', via: 'popup' });
  assert.equal(reply.ok, false);
  assert.equal(reply.error.code, 'result_unavailable');
  assert.deepEqual(opened.slice(before), []);
});

test('PDF_OPEN_JOB: an entry the site links do not know is an error, not an untagged link', async () => {
  jobView = finished('pdf_job_14', 'pdf');
  const before = opened.length;
  const reply = await send({ type: 'PDF_OPEN_JOB', jobId: 'pdf_job_14' });
  assert.equal(reply.ok, false);
  assert.match(reply.error.message, /SiteLinks: unknown entry/);
  assert.deepEqual(opened.slice(before), [], 'nothing opened');
});

test('a finished job\'s "View translation" button opens the reader, like its body', async () => {
  jobView = finished('pdf_job_15', 'pdf');
  assert.deepEqual(await clickNotification('pdf_job_15', { button: true }),
    ['https://site.test/app/reader/pdf_job_15?utm_source=extension&utm_medium=notification']);
});

test('only a finished job\'s notification carries the View button', async () => {
  const { notifyPdfTerminal } = await import('../../background/pdf-notify.js');
  created.length = 0;
  await notifyPdfTerminal({ jobId: 'job_a', status: 'succeeded', fileName: 'a.pdf' });
  await notifyPdfTerminal({ jobId: 'job_b', status: 'failed', error: { code: 'job_failed' } });
  await notifyPdfTerminal({ jobId: 'job_c', status: 'abandoned', error: {} });
  assert.deepEqual(created.map(({ id, options }) => [id, (options.buttons || []).map(b => b.title)]), [
    ['pdf-job-job_a', ['View translation']],
    ['pdf-job-job_b', []],
    ['pdf-job-job_c', []],
  ]);
});

// PDF_PAGE_JOB: the PDF tab's own bar asking after the job started from it.
const PDF_URL = 'https://papers.test/a.pdf';
const pdfTab = { tab: { id: 3, url: PDF_URL } };
const pageRecord = (jobId, status, extra = {}) => ({
  jobId, status, fileName: 'a.pdf', sourceFormat: 'pdf', sourceUrl: PDF_URL,
  progress: 0, error: null, createdAt: Date.now(), ...extra,
});

async function pageJob(records, refresh = false) {
  local.pdfJobs = records;
  fetched.length = 0;
  try {
    return await send({ type: 'PDF_PAGE_JOB', refresh }, pdfTab);
  } finally {
    delete local.pdfJobs;
  }
}

test('PDF_PAGE_JOB: the newest job started from this address answers, read from storage alone', async () => {
  const now = Date.now();
  const reply = await pageJob([
    pageRecord('job_old', 'succeeded', { createdAt: now - 60_000, settledAt: now - 30_000 }),
    pageRecord('job_new', 'running', { progress: 40, createdAt: now }),
    pageRecord('job_elsewhere', 'running', { sourceUrl: 'https://papers.test/b.pdf', createdAt: now + 1 }),
    pageRecord('job_upload', 'running', { sourceUrl: null, createdAt: now + 2 }),
  ]);
  assert.deepEqual(reply, { ok: true, data: { job: { jobId: 'job_new', phase: 'running', progress: 40, message: '' } } });
  assert.deepEqual(fetched, [], 'a refresh:false look asks the network nothing');
});

test('PDF_PAGE_JOB: no job from this address is null, not the newest job on the device', async () => {
  const reply = await pageJob([pageRecord('job_b', 'succeeded', { sourceUrl: 'https://papers.test/b.pdf' })]);
  assert.deepEqual(reply, { ok: true, data: { job: null } });
});

test('PDF_PAGE_JOB: each status maps to the bar\'s phase; a receipt has no job to open yet', async () => {
  const phase = async (record) => (await pageJob([record])).data.job;
  assert.deepEqual(await phase(pageRecord('local:op-2', 'queued', { pending: true })),
    { jobId: null, phase: 'running', progress: 0, message: '' });
  assert.equal((await phase(pageRecord('job_w', 'awaiting_confirm'))).phase, 'awaiting');
  const done = await phase(pageRecord('job_d', 'succeeded', { settledAt: Date.now() }));
  assert.equal(done.phase, 'succeeded');
  assert.equal(done.message, 'Your translation is ready. Click to open it.');
  const failed = await phase(pageRecord('job_f', 'failed', { settledAt: Date.now(), error: { code: 'insufficient_credits' } }));
  assert.equal(failed.phase, 'failed');
  assert.ok(failed.message && failed.message !== 'insufficient_credits', failed.message);
  assert.equal((await phase(pageRecord('job_x', 'abandoned', { settledAt: Date.now(), error: {} }))).phase, 'failed');
});

test('PDF_PAGE_JOB refresh:true polls the job and answers the fresh status', async () => {
  jobView = { jobId: 'job_r', status: 'succeeded', format: 'pdf', progress: 100 };
  const reply = await pageJob([pageRecord('job_r', 'running', { progress: 60 })], true);
  assert.equal(reply.data.job.phase, 'succeeded');
  assert.ok(fetched.some(url => url.includes('/api/pdf/jobs/')), JSON.stringify(fetched));
});
