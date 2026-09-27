// The service worker's half of D-353's consent (background/background.js,
// background/pdf-jobs.js): a switched-off feature still runs for the one page
// where the user pressed the media shortcut or the hint's button, and for no
// other request.
//
// Behavioural, over the real worker modules: the listener the worker registers
// is the one answering, the storage is an in-memory copy, and the network is a
// recorder. A regex over `consent:` in the source could not tell a flag that is
// read from a flag that is merely passed along.
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';

const sync = { enableComicTranslation: false, enablePdfTranslation: false };
const local = { comicToken: 'tok', comicApiBase: 'https://api.test' };
const requests = [];
const messageListeners = [];

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

/**
 * Everything the worker touches at load that this test has no opinion about
 * (menus, alarms, the icon, lifecycle events) answers with a harmless stand-in,
 * so the module graph loads as it does in Chrome.
 */
function standIn() {
  const fn = () => standIn();
  return new Proxy(fn, {
    get: (_target, prop) => (prop === 'then' ? undefined : standIn()),
    apply: () => undefined,
  });
}

globalThis.chrome = new Proxy({
  storage: { sync: area(sync), local: area(local), session: area({}), onChanged: { addListener() {} } },
  runtime: new Proxy({
    onMessage: { addListener: (fn) => messageListeners.push(fn) },
    getURL: (p) => `chrome-extension://test/${p}`,
    lastError: undefined,
  }, { get: (target, prop) => (prop in target ? target[prop] : standIn()) }),
}, { get: (target, prop) => (prop in target ? target[prop] : standIn()) });

globalThis.fetch = async (url, init = {}) => {
  requests.push({ url: String(url), method: init.method || 'GET' });
  return new Response(JSON.stringify({ jobId: 'job-1', status: 'queued' }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
};

await import('../../background/background.js');
const { startPdfUrlTranslation } = await import('../../background/pdf-jobs.js');

function send(message) {
  return new Promise((resolve) => {
    const sender = { tab: { id: 1, url: 'https://comics.example/read/1' } };
    for (const listener of messageListeners) listener(message, sender, resolve);
  });
}

const comicCreate = (consent) => ({
  type: 'COMIC_JOB_CREATE',
  consent,
  job: { operationId: `op-${consent}`, imageBase64: 'AAAA', pageUrl: 'https://comics.example/read/1', mode: 'translate' },
});

test('comic, switched off: the hint\'s consent runs the job for this page', async () => {
  requests.length = 0;
  const reply = await send(comicCreate(true));
  assert.equal(reply.ok, true, JSON.stringify(reply));
  assert.deepEqual(requests.map((r) => `${r.method} ${r.url}`), ['POST https://api.test/api/comic/jobs']);
  assert.equal(sync.enableComicTranslation, false, 'consent turned the setting on');
});

test('comic, switched off: without consent the create is refused before the network', async () => {
  requests.length = 0;
  const reply = await send(comicCreate(false));
  assert.equal(reply.ok, false);
  assert.equal(reply.error.code, 'feature_disabled');
  assert.deepEqual(requests, []);
});

test('PDF, switched off: consent gets past the switch; no consent does not', async () => {
  // Not a PDF URL, so a request that passes the switch stops at the very next
  // check with nothing sent — which is the point where the two answers differ.
  const url = 'https://example.com/page';
  assert.deepEqual(await startPdfUrlTranslation({ url, consent: false }), { started: false, reason: 'disabled' });
  assert.deepEqual(await startPdfUrlTranslation({ url, consent: true }), { started: false, reason: 'not_a_pdf' });
});
