// Blab Translation as the OCR engine (D-740), driven end to end through the
// worker's OCR_IMAGE handler (background/ocr-recognize.js): the image is
// fetched, its format read off the bytes, checked against both caps before
// anything is sent, and posted to /api/blab/complete as {mime, base64} beside
// the prompt turns, with no temperature. The service's refusals reach the
// reader as themselves: no other engine is tried.
//
// fetch is a stub that answers the image URL with bytes and the service with
// JSON; createImageBitmap and OffscreenCanvas stand in for the decoder and the
// re-encoder, which Node does not have.
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';

const sync = { ocrEngine: 'blab', uiLanguage: 'en' };
const local = {};
const session = {};

function memoryArea(data) {
  return {
    get: async (defaults) => {
      if (defaults === null || defaults === undefined) return { ...data };
      if (typeof defaults === 'string') return defaults in data ? { [defaults]: data[defaults] } : {};
      if (Array.isArray(defaults)) return Object.fromEntries(defaults.filter((k) => k in data).map((k) => [k, data[k]]));
      const out = { ...defaults };
      for (const key of Object.keys(defaults)) if (key in data) out[key] = data[key];
      return out;
    },
    set: async (values) => { Object.assign(data, values); },
    remove: async (keys) => { for (const key of [].concat(keys)) delete data[key]; },
  };
}

const listener = { addListener() {}, removeListener() {} };
globalThis.chrome = {
  runtime: { getPlatformInfo: async () => ({ os: 'mac' }), getURL: (p) => `chrome-extension://x/${p}`, onMessage: listener },
  i18n: { getUILanguage: () => 'en' },
  storage: { sync: memoryArea(sync), local: memoryArea(local), session: memoryArea(session), onChanged: listener },
};

await import('../../shared/lang-tags.js');
await import('../../shared/site-rules-builtin.js');
await import('../../shared/storage-writer.js');
await import('../../shared/site-rules.js');
await import('../../shared/sync-collection.js');
await import('../../shared/api-compat.js');
await import('../../shared/ai-profiles.js');
await import('../../shared/engines.js');
await import('../../i18n/messages.js');
await import('../../i18n/lang/en.js');
const { handleOcrImage } = await import('../../background/ocr-recognize.js');

const BASE = 'http://blab.test';
const IMAGE_URL = 'https://cdn.example/page.jpg';
const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const WEBP_HEAD = [...'RIFF'].map((c) => c.charCodeAt(0)).concat([1, 2, 3, 4], [...'WEBP'].map((c) => c.charCodeAt(0)));

let tokens = 0;
function signIn() {
  local.comicApiBase = BASE;
  local.comicToken = `tok-${++tokens}`;
  delete local.comicAccountCache;
  for (const key of Object.keys(session)) delete session[key];
}

const json = (data, status = 200) => ({
  ok: status >= 200 && status < 300, status, headers: new Headers(), json: async () => data,
});

/**
 * Run `fn` with the image served as `bytes` (labelled `contentType`, which
 * must not matter) decoding to width × height, and the service answering
 * `reply`. Returns the service calls.
 */
async function withImage({ bytes, contentType = 'image/jpeg', width = 800, height = 600, reply }, fn) {
  const saved = {
    fetch: globalThis.fetch, bitmap: globalThis.createImageBitmap, canvas: globalThis.OffscreenCanvas,
    warn: console.warn, error: console.error,
  };
  const calls = [];
  const encodes = [];
  globalThis.fetch = async (url, init) => {
    if (url === IMAGE_URL) {
      return { ok: true, status: 200, blob: async () => new Blob([Uint8Array.from(bytes)], { type: contentType }) };
    }
    calls.push({ url, init });
    return reply;
  };
  globalThis.createImageBitmap = async () => ({ width, height, close() {} });
  globalThis.OffscreenCanvas = class {
    constructor(w, h) { this.width = w; this.height = h; }
    getContext() { return { drawImage() {} }; }
    async convertToBlob({ type }) {
      encodes.push({ type, width: this.width, height: this.height });
      return new Blob([Uint8Array.from(PNG_HEAD)], { type });
    }
  };
  console.warn = () => {};
  console.error = () => {};
  try {
    const result = await handleOcrImage({ srcUrl: IMAGE_URL }, { tab: { id: 1 }, frameId: 0 });
    return fn({ result, calls, encodes });
  } finally {
    globalThis.fetch = saved.fetch;
    globalThis.createImageBitmap = saved.bitmap;
    globalThis.OffscreenCanvas = saved.canvas;
    console.warn = saved.warn;
    console.error = saved.error;
  }
}

const RECOGNISED = json({ text: '{"text":"Hello","language":"en"}', usage: { used: 1, limit: 100, resetsAt: 'x' } });
const en = (key) => globalThis.getMessage(key, 'en');

test('blab ocr: the image goes to /api/blab/complete as {mime, base64}, labelled by its bytes, with no temperature', async () => {
  signIn();
  const bytes = [...WEBP_HEAD, 9, 9, 9, 9];
  await withImage({ bytes, contentType: 'image/jpeg', reply: RECOGNISED }, ({ result, calls, encodes }) => {
    assert.deepEqual({ text: result.text, language: result.language }, { text: 'Hello', language: 'en' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${BASE}/api/blab/complete`);
    assert.equal(calls[0].init.headers.Authorization, `Bearer ${local.comicToken}`);
    const body = JSON.parse(calls[0].init.body);
    assert.deepEqual(Object.keys(body).sort(), ['image', 'maxTokens', 'system', 'user']);
    assert.deepEqual(body.image, { mime: 'image/webp', base64: Buffer.from(bytes).toString('base64') },
      'the CDN said jpeg; the bytes are webp, and the service checks the bytes');
    assert.equal(body.system, globalThis.OCRCore.OCR_SYSTEM_PROMPT);
    assert.equal(body.user, globalThis.OCRCore.OCR_USER_INSTRUCTION, 'a plain string: the service builds the multimodal turn');
    assert.equal(encodes.length, 0, 'within both caps: sent untouched');
  });
});

test('blab ocr: past the longest-edge cap the image is re-encoded before anything is sent', async () => {
  signIn();
  await withImage({ bytes: [...PNG_HEAD, 0, 0], width: 720, height: 16000, reply: RECOGNISED }, ({ result, calls, encodes }) => {
    assert.equal(result.text, 'Hello');
    assert.equal(encodes.length, 1);
    assert.ok(Math.max(encodes[0].width, encodes[0].height) <= globalThis.OCRCore.OCR_MAX_DIMENSION);
    assert.equal(JSON.parse(calls[0].init.body).image.mime, 'image/png');
  });
});

test('blab ocr: bytes in no format the service takes are re-encoded, whatever the label says', async () => {
  signIn();
  await withImage({ bytes: [0x42, 0x4d, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], contentType: 'image/png', reply: RECOGNISED }, ({ calls, encodes }) => {
    assert.equal(encodes.length, 1, 'a BMP labelled png');
    assert.equal(JSON.parse(calls[0].init.body).image.mime, 'image/png');
  });
});

test('blab ocr: 422 vision_unavailable is said as itself, once, and no other engine is tried', async () => {
  signIn();
  await withImage({ bytes: [...PNG_HEAD, 0], reply: json({ error: 'vision_unavailable' }, 422) }, ({ result, calls }) => {
    assert.equal(calls.length, 1, 'not retried, and nothing else asked');
    assert.equal(result.error, en('blabVisionUnavailable'));
    assert.equal(result.action, undefined, 'nothing the reader can sign in or pay for');
  });
});

test('blab ocr: 403 plan_required offers the subscription, the same as a translation would', async () => {
  signIn();
  await withImage({ bytes: [...PNG_HEAD, 0], reply: json({ error: 'plan_required' }, 403) }, ({ result, calls }) => {
    assert.equal(calls.length, 1);
    assert.equal(result.error, en('blabPlanRequired'));
    assert.equal(result.action, 'subscribe');
  });
});

test('blab ocr: signed out, nothing is sent and the reader is offered sign-in', async () => {
  signIn();
  delete local.comicToken;
  await withImage({ bytes: [...PNG_HEAD, 0], reply: RECOGNISED }, ({ result, calls }) => {
    assert.equal(calls.length, 0);
    assert.equal(result.error, en('blabSignInRequired'));
    assert.equal(result.action, 'signin');
  });
});

test('blab ocr: the image card carries the refusal\'s entry (subscribe / sign in) to the reader', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../../content/content-image-ocr.js', import.meta.url), 'utf8');
  assert.match(source, /ctx\.showCardError\(popup, response\?\.error \|\| t\('translationFailed'\), response\?\.action \|\| null\);/);
});
