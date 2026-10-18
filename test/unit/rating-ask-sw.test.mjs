// The one store-rating ask (background/rating-ask.js): after this device's
// third finished PDF the worker asks, once, and never again — whether the
// jobs finished under the poll or under a page, and however the ask is
// answered. Nothing is counted but local storage.
//
// Behavioural, over the real worker modules, like pdf-open-job-sw.test.mjs:
// storage is an in-memory copy, the network answers each job with the view
// the test names, and notifications and tabs are recorded.
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';

const local = { comicToken: 'tok', comicApiBase: 'https://site.test/' };
const sync = { enablePdfTranslation: true };
const opened = [];
const created = [];
const cleared = [];
const messageListeners = [];
const clickListeners = [];
const buttonListeners = [];
const views = new Map();
const fetched = [];

function area(store) {
  return {
    get: async (keys) => {
      if (keys == null) return structuredClone(store);
      const defaults = typeof keys === 'string' ? { [keys]: undefined }
        : Array.isArray(keys) ? Object.fromEntries(keys.map((key) => [key, undefined])) : keys;
      const out = {};
      for (const [key, value] of Object.entries(defaults)) {
        if (key in store) out[key] = structuredClone(store[key]);
        else if (value !== undefined) out[key] = value;
      }
      return out;
    },
    set: async (values) => { Object.assign(store, structuredClone(values)); },
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

const passThrough = () => ({ get: (t, prop) => (prop in t ? t[prop] : standIn()) });

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
    create: (id, options, callback) => { created.push({ id, ...options }); if (callback) callback(id); },
    clear: (id, callback) => { cleared.push(id); if (callback) callback(true); },
    onClicked: { addListener: (fn) => clickListeners.push(fn) },
    onButtonClicked: { addListener: (fn) => buttonListeners.push(fn) },
  }, passThrough()),
}, passThrough());

globalThis.fetch = async (url) => {
  const id = decodeURIComponent(String(url).split('/api/pdf/jobs/')[1] || '');
  fetched.push(id);
  if (!views.has(id)) {
    return new Response(JSON.stringify({ error: { code: 'network_error' } }), { status: 503 });
  }
  return new Response(JSON.stringify({ jobId: id, ...views.get(id) }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
};

await import('../../background/background.js');
const { refreshPdfJobs } = await import('../../background/pdf-jobs.js');
const { RATING_ASK_KEY, STORE_REVIEWS_URL, noteJobSettled } = await import('../../background/rating-ask.js');

const running = (jobId, sourceFormat) => ({
  jobId, sourceFormat, fileName: `${jobId}.${sourceFormat}`, status: 'running', progress: 10, createdAt: Date.now(),
});
const DONE = { status: 'succeeded', progress: 100, results: { dualUrl: 'https://r2.test/d', monoUrl: 'https://r2.test/m' } };
const FAILED = { status: 'failed', progress: 40, error: { code: 'engine_error', message: 'x' } };

function send(message) {
  return new Promise((resolve) => {
    for (const listener of messageListeners) listener(message, {}, resolve);
  });
}

const asks = () => created.filter((n) => n.id === 'rating-ask');

async function settled() {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

test('notes that arrive together are each counted once: none lost, none doubled', async () => {
  const done = (jobId) => ({ jobId, sourceFormat: 'pdf', status: 'succeeded' });
  await Promise.all([noteJobSettled(done('x1')), noteJobSettled(done('x2')), noteJobSettled(done('x1'))]);
  assert.deepEqual(local[RATING_ASK_KEY], { pdfJobs: ['x1', 'x2'], asked: false });
  assert.deepEqual(asks(), []);
  delete local[RATING_ASK_KEY];
});

test('two PDFs settling in one poll count as two; a failed PDF and a Word job count for nothing', async () => {
  local.pdfJobs = [running('p1', 'pdf'), running('p2', 'pdf'), running('f1', 'pdf'), running('w1', 'docx')];
  views.set('p1', DONE).set('p2', DONE).set('f1', FAILED).set('w1', DONE);
  await refreshPdfJobs();
  assert.deepEqual(local[RATING_ASK_KEY], { pdfJobs: ['p1', 'p2'], asked: false });
  assert.deepEqual(asks(), []);
  // The job notifications themselves still went out.
  assert.equal(created.filter((n) => String(n.id).startsWith('pdf-job-')).length, 4);
});

test('a job already counted, seen again by a page, counts for nothing more', async () => {
  const reply = await send({ type: 'PDF_JOB_GET', jobId: 'p1' });
  assert.equal(reply.ok, true);
  assert.deepEqual(local[RATING_ASK_KEY].pdfJobs, ['p1', 'p2']);
  assert.deepEqual(asks(), []);
});

test('the third PDF, finished under a page, raises the ask once — neutral, with Rate and No thanks', async () => {
  local.pdfJobs = [...local.pdfJobs, running('p3', 'pdf')];
  views.set('p3', DONE);
  const reply = await send({ type: 'PDF_JOB_GET', jobId: 'p3' });
  assert.equal(reply.ok, true);
  await settled();
  assert.deepEqual(local[RATING_ASK_KEY], { pdfJobs: ['p1', 'p2', 'p3'], asked: true });
  const [ask] = asks();
  assert.equal(asks().length, 1);
  assert.equal(ask.title, 'Rate Blab Translation?');
  assert.deepEqual(ask.buttons.map((b) => b.title), ['Rate on Chrome Web Store', 'No thanks']);
  assert.doesNotMatch(`${ask.title} ${ask.message}`, /\b(5|five)\b|★|star|reward|free|credit/i,
    'asks for a rating, not a good one, and offers nothing for it');
});

test('after the ask, no finished PDF raises it again', async () => {
  local.pdfJobs = [...local.pdfJobs, running('p4', 'pdf'), running('p5', 'pdf')];
  views.set('p4', DONE).set('p5', DONE);
  await refreshPdfJobs();
  await send({ type: 'PDF_JOB_GET', jobId: 'p4' });
  await settled();
  assert.equal(asks().length, 1);
  assert.deepEqual(local[RATING_ASK_KEY], { pdfJobs: ['p1', 'p2', 'p3'], asked: true }, 'stops counting');
});

test('Rate opens the store\'s review tab; No thanks opens nothing; the body opens the store; each clears the ask', async () => {
  assert.equal(STORE_REVIEWS_URL, 'https://chromewebstore.google.com/detail/kbaebnmocaoogcjclbjmmhbbplbpcbpo/reviews');

  let before = opened.length;
  cleared.length = 0;
  for (const listener of buttonListeners) listener('rating-ask', 1);
  await settled();
  assert.deepEqual(opened.slice(before), []);
  assert.deepEqual(cleared, ['rating-ask']);

  before = opened.length;
  cleared.length = 0;
  for (const listener of buttonListeners) listener('rating-ask', 0);
  await settled();
  assert.deepEqual(opened.slice(before), [STORE_REVIEWS_URL]);
  assert.deepEqual(cleared, ['rating-ask']);

  before = opened.length;
  cleared.length = 0;
  for (const listener of clickListeners) listener('rating-ask');
  await settled();
  assert.deepEqual(opened.slice(before), [STORE_REVIEWS_URL], 'the store, once, and not routed as a job');
  assert.deepEqual(cleared, ['rating-ask']);
});

test('a job notification\'s click is not taken for the ask', async () => {
  const before = opened.length;
  cleared.length = 0;
  for (const listener of clickListeners) listener('pdf-job-local:op-9');
  await settled();
  assert.deepEqual(opened.slice(before), []);
  assert.deepEqual(cleared, ['pdf-job-local:op-9'], 'the job listener clears its own notification');
});
