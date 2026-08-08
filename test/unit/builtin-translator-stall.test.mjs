// Guards for the stall watchdog in content/content-translation-engine.js.
//
// The Translator API's three entry points — availability(), create() and
// translate() — have no timeout. When one of them wedges (a language-pack
// download that hangs, a session that never answers) the promise does not
// reject, it simply never settles. `translators` caches the *promise*, so every
// block of a whole-page translation ends up awaiting the same dead promise:
// `ctx.requestTranslation` never returns, the progress bar sits at
// `正在翻译... 0%` forever, and no error is ever shown. The fallback to the AI
// path below it was always correct — nothing ever gave up long enough to reach
// it.
//
// The fix is a watchdog whose deadline can be pushed back, because the two
// failure modes it has to tell apart look identical from the outside:
//
//   a 40 MB language pack crawling in over a slow link  -> must NOT be killed
//   a download that stopped moving an hour ago          -> must be killed
//
// A wall-clock cap on create() cannot separate those; "no downloadprogress for
// a full minute" can. That is also why the options page's deliberate,
// user-initiated download button survives — see the last test.
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoFile = (rel) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');

// ==================== the faked browser ====================

// Enough of a page for the engine's IIFE to install itself and run. Everything
// interesting is swapped per test through `stubCreate` / `self.Translator`.
const ENGLISH = 'The quick brown fox jumps over the lazy dog, again and again. ';

let apiKey = 'sk-test';
let storageListener = () => {};
const sentToAI = [];

globalThis.self = {
  isSecureContext: true,
  Translator: {
    availability: async () => 'available',
    create: async () => fakeTranslator(),
  },
};
// Node ships a read-only `navigator`, and the engine reads userActivation off
// it to decide whether a download may start.
Object.defineProperty(globalThis, 'navigator', {
  value: { userActivation: { isActive: true } },
  configurable: true,
  writable: true,
});
globalThis.window = {
  AI_TRANSLATOR_CONTENT: {},
  addEventListener() {},
  removeEventListener() {},
};
globalThis.window.top = globalThis.window;
globalThis.document = { body: { innerText: ENGLISH.repeat(20) } };
globalThis.chrome = {
  i18n: {
    detectLanguage: async () => ({ isReliable: true, languages: [{ language: 'en', percentage: 99 }] }),
  },
  storage: {
    sync: { get: async () => ({ apiKey }) },
    onChanged: { addListener: (fn) => { storageListener = fn; } },
  },
  runtime: {
    // Stands in for the AI path: the whole point of the fix is that requests
    // reach it instead of disappearing into a stuck built-in translator.
    sendMessage: async (message) => {
      sentToAI.push(message);
      if (Array.isArray(message.texts)) return { translations: message.texts.map((x) => `AI:${x}`) };
      return { translation: `AI:${message.text}`, phonetic: '', isWord: false };
    },
  },
};

// The engine logs every fallback; that is correct behaviour but it drowns the
// test output, so keep the console quiet and let assertions do the talking.
console.info = () => {};
console.warn = () => {};

await import('../../content/content-translation-engine.js');
const ctx = globalThis.window.AI_TRANSLATOR_CONTENT;

// ==================== helpers ====================

function fakeTranslator(overrides = {}) {
  return {
    translate: async (text) => `builtin:${text}`,
    destroy() {},
    ...overrides,
  };
}

/**
 * Replace `Translator.create` and record every call. `impl(call)` decides what
 * the returned promise does; `call.emit(loaded)` fires a `downloadprogress`
 * event at whatever listener the engine registered on the monitor.
 */
function stubCreate(impl) {
  const calls = [];
  self.Translator.create = (options) => {
    const listeners = [];
    if (typeof options.monitor === 'function') {
      options.monitor({
        addEventListener: (type, fn) => { if (type === 'downloadprogress') listeners.push(fn); },
      });
    }
    const call = {
      options,
      emit: (loaded) => listeners.forEach((fn) => fn({ loaded })),
    };
    calls.push(call);
    return impl(call);
  };
  return calls;
}

// setImmediate is deliberately left unmocked, so this drains the microtask
// queue (every await in the engine's own path) without advancing the clock.
const drain = () => new Promise((resolve) => setImmediate(resolve));

async function waitFor(predicate, label) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await drain();
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function isPending(promise) {
  const marker = Symbol('pending');
  const settled = promise.then(() => 'settled', () => 'settled');
  return (await Promise.race([settled, drain().then(() => marker)])) === marker;
}

function translateRequest(targetLang, extra = {}) {
  return ctx.requestTranslation({ type: 'TRANSLATE', text: ENGLISH, targetLang, ...extra });
}

const AI_RESULT = { translation: `AI:${ENGLISH}`, phonetic: '', isWord: false };

// ==================== the core failure ====================

test('a create() that never settles falls back to the AI path', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  self.Translator.availability = async () => 'available';
  const calls = stubCreate(() => new Promise(() => {}));

  const pending = translateRequest('ja');
  await waitFor(() => calls.length === 1, 'create() to be called');

  // The language pack is already downloaded here, so create() is a local
  // operation: no progress events exist to wait on, and a short cap applies.
  t.mock.timers.tick(19_000);
  assert.equal(await isPending(pending), true, 'gave up before the create budget was spent');

  t.mock.timers.tick(2_000);
  assert.deepEqual(await pending, AI_RESULT, 'never fell back to the AI path');
});

test('a whole-page batch gives up once, not once per block', async (t) => {
  // The reported symptom: "4 blocks, 4 batches", zero requests reaching the API
  // server, 0% forever. Every block awaits the same cached create() promise, so
  // the batch must abandon the built-in engine as a whole — waiting out one
  // timeout per block would just move the hang.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  self.Translator.availability = async () => 'available';
  const calls = stubCreate(() => new Promise(() => {}));
  const texts = ['First block of text.', 'Second block.', 'Third block.', 'Fourth block.'];

  const pending = ctx.requestTranslation({
    type: 'TRANSLATE_BATCH_FAST', texts, targetLang: 'ru', allowDownload: true,
  });
  await waitFor(() => calls.length === 1, 'create() to be called');
  t.mock.timers.tick(21_000);

  assert.deepEqual(await pending, { translations: texts.map((x) => `AI:${x}`) });
  assert.equal(calls.length, 1, 'each block waited out its own create() timeout');
  assert.equal(sentToAI.at(-1).type, 'TRANSLATE_BATCH_FAST', 'the batch did not reach the AI path intact');
});

// ==================== slow vs. stuck ====================

test('a download that keeps moving is never killed; silence is', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  self.Translator.availability = async () => 'downloadable';
  const calls = stubCreate(() => new Promise(() => {}));

  const pending = translateRequest('ko');
  await waitFor(() => calls.length === 1, 'create() to be called');

  // The first event is the one that says the download exists at all; after it
  // the window widens, because a slow link does go quiet between chunks.
  t.mock.timers.tick(29_000);
  calls[0].emit(0.02);
  await drain();

  // Ten minutes of genuinely slow download. Any wall-clock cap short enough to
  // rescue the 0% hang would have killed this one; a stall deadline does not.
  for (let step = 1; step <= 10; step++) {
    t.mock.timers.tick(59_000);
    calls[0].emit(step / 20);
    await drain();
  }
  assert.equal(await isPending(pending), true, 'a download that was still moving got killed');

  // Now it stops. One minute of complete silence is the giving-up point.
  t.mock.timers.tick(59_000);
  assert.equal(await isPending(pending), true, 'gave up before the stall window was spent');
  t.mock.timers.tick(2_000);
  assert.deepEqual(await pending, AI_RESULT, 'a stalled download never fell back');
});

test('a download that never starts is given up on without waiting out a stall window', async (t) => {
  // Measured in the very browser the e2e suite drives (headless Chrome,
  // en->zh): availability() answers "downloadable" in a millisecond and then
  // create() hangs having never fired a single downloadprogress event. Nothing
  // is moving, so there is nothing to be patient about — the short window
  // before the first sign of life is what makes this case recover quickly.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  self.Translator.availability = async () => 'downloadable';
  const calls = stubCreate(() => new Promise(() => {}));

  const pending = translateRequest('hu');
  await waitFor(() => calls.length === 1, 'create() to be called');

  t.mock.timers.tick(29_000);
  assert.equal(await isPending(pending), true, 'gave up before the start window was spent');
  t.mock.timers.tick(2_000);
  assert.deepEqual(await pending, AI_RESULT, 'a download that never began still hung the page');
});

test('a stalled create is aborted, so the browser stops waiting on it too', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  self.Translator.availability = async () => 'available';
  const calls = stubCreate(() => new Promise(() => {}));

  const pending = translateRequest('fi');
  await waitFor(() => calls.length === 1, 'create() to be called');
  assert.equal(calls[0].options.signal.aborted, false);

  t.mock.timers.tick(21_000);
  await pending;
  assert.equal(calls[0].options.signal.aborted, true, 'a dead download was left running');
});

test('a timed-out create is not cached, so the next attempt really retries', async (t) => {
  // Caching the promise is what turned one stuck create() into a stuck page.
  // The flip side is that a timed-out entry must not poison the retry.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  self.Translator.availability = async () => 'available';
  const calls = stubCreate(() => new Promise(() => {}));

  const first = translateRequest('fr');
  await waitFor(() => calls.length === 1, 'the first create()');
  t.mock.timers.tick(21_000);
  await first;

  self.Translator.create = async () => fakeTranslator();
  assert.deepEqual(await translateRequest('fr'), {
    translation: `builtin:${ENGLISH}`, phonetic: '', isWord: false,
  });
});

// ==================== the other two entry points ====================

test('an availability() that never answers is an engine failure, not a bad pair', async (t) => {
  // Reporting this as UNSUPPORTED_PAIR would make a batch treat it as one
  // block's problem and ask again for the next block — one timeout per block.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let asked = 0;
  self.Translator.availability = () => { asked += 1; return new Promise(() => {}); };

  const texts = ['First block.', 'Second block.', 'Third block.'];
  const pending = ctx.requestTranslation({
    type: 'TRANSLATE_BATCH_FAST', texts, targetLang: 'sv', allowDownload: true,
  });
  await waitFor(() => asked === 1, 'availability() to be called');
  t.mock.timers.tick(16_000);

  assert.deepEqual(await pending, { translations: texts.map((x) => `AI:${x}`) });
  assert.equal(asked, 1, 'every block asked again and waited out its own timeout');
});

test('a translate() that never returns drops the wedged session and falls back', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  self.Translator.availability = async () => 'available';
  let destroyed = 0;
  let translateCalls = 0;
  self.Translator.create = async () => fakeTranslator({
    translate: () => { translateCalls += 1; return new Promise(() => {}); },
    destroy: () => { destroyed += 1; },
  });

  const pending = translateRequest('pl');
  await waitFor(() => translateCalls === 1, 'translate() to be called');
  t.mock.timers.tick(121_000);

  assert.deepEqual(await pending, AI_RESULT);
  assert.equal(destroyed, 1, 'the wedged session was left in the cache for the next block to hit');

  // And the session really is gone: the next attempt builds a fresh one.
  self.Translator.create = async () => fakeTranslator();
  assert.deepEqual(await translateRequest('pl'), {
    translation: `builtin:${ENGLISH}`, phonetic: '', isWord: false,
  });
});

// ==================== what the user is told ====================

test('with no API key there is nothing to fall back to, so the reason is shown', async (t) => {
  // With an API key the fallback is silent and the page just gets translated.
  // Without one there is no fallback, and a stall must surface as a message
  // rather than as a progress bar that never moves. ctx.t is absent here, so
  // the i18n key itself comes back.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  storageListener({ apiKey: { newValue: '' } }, 'sync');
  self.Translator.availability = async () => 'available';
  const calls = stubCreate(() => new Promise(() => {}));

  const pending = translateRequest('da');
  await waitFor(() => calls.length === 1, 'create() to be called');
  t.mock.timers.tick(21_000);

  assert.deepEqual(await pending, { error: 'builtinUnavailable' });
  storageListener({ apiKey: { newValue: 'sk-test' } }, 'sync');
});

test('the progress bar is handed back when the download ends, however it ends', async (t) => {
  // Whole-page translation borrows the progress bar to show the download
  // percentage. If a stalled download were abandoned without saying so, the bar
  // would keep reading "downloading language pack, 30%" while the AI path
  // quietly translated the page behind it.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  self.Translator.availability = async () => 'downloadable';
  const calls = stubCreate(() => new Promise(() => {}));
  let handedBack = 0;
  ctx.onBuiltinDownloadEnded = () => { handedBack += 1; };
  t.after(() => { delete ctx.onBuiltinDownloadEnded; });

  const pending = translateRequest('nl');
  await waitFor(() => calls.length === 1, 'create() to be called');
  calls[0].emit(0.3);
  await drain();
  assert.equal(handedBack, 0, 'handed the bar back while the download was still running');

  t.mock.timers.tick(61_000);
  await pending;
  assert.equal(handedBack, 1, 'a stalled download left the bar reading "downloading"');
});

// ==================== the deliberate download must survive ====================

test("the options page's download button still survives a long, moving download", async (t) => {
  // ensureDownloaded is the one place a multi-minute wait is the *feature*:
  // a real user gesture, a visible progress bar, a 40 MB pack. Ten minutes of
  // download at one progress event every half minute must go through.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let finishCreate;
  const calls = stubCreate(() => new Promise((resolve) => { finishCreate = resolve; }));
  const seen = [];

  const done = ctx.builtinTranslator.ensureDownloaded('en', 'it', (loaded) => seen.push(loaded));
  await waitFor(() => calls.length === 1, 'create() to be called');

  for (let step = 1; step <= 20; step++) {
    calls[0].emit(step / 20);
    await drain();
    t.mock.timers.tick(30_000);
  }
  finishCreate(fakeTranslator());

  assert.equal(await done, 'available');
  assert.equal(seen.length, 20, 'the progress bar stopped being fed');
});

test('a download button that really is stuck stops instead of spinning forever', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = stubCreate(() => new Promise(() => {}));

  const done = ctx.builtinTranslator.ensureDownloaded('en', 'tr');
  await waitFor(() => calls.length === 1, 'create() to be called');
  t.mock.timers.tick(29_000);
  assert.equal(await isPending(done), true, 'gave up before the start window was spent');
  t.mock.timers.tick(2_000);

  await assert.rejects(done, (error) => {
    assert.equal(error.name, 'EngineUnavailableError');
    assert.equal(error.reason, 'timedOut');
    return true;
  });
});

// ==================== structural guards ====================

test('every call into the Translator API goes through the watchdog', async () => {
  // One call site each: availability() behind probeAvailability, create()
  // behind getTranslator. A second, unwrapped call site is exactly how this bug
  // comes back — it would hang with no timeout and no way to fall back.
  const src = repoFile('content/content-translation-engine.js');
  assert.equal((src.match(/self\.Translator\.availability\(/g) || []).length, 1);
  assert.equal((src.match(/self\.Translator\.create\(/g) || []).length, 1);
  assert.match(src, /function stallWatchdog\(/);

  for (const file of [
    'content/content-page-translation.js',
    'content/content-hover-translation.js',
    'content/content-popup.js',
    'options/options.js',
  ]) {
    assert.doesNotMatch(
      repoFile(file),
      /Translator\.(create|availability|translate)\(/,
      `${file} reaches into the Translator API directly, bypassing the watchdog`,
    );
  }
});

test('the page-translation surface answers the download-ended hook', () => {
  // The engine calls ctx.onBuiltinDownloadEnded whenever a download-bearing
  // create() ends. Without a listener the progress bar keeps its stale
  // "downloading language pack" label for the rest of the page translation.
  assert.match(repoFile('content/content-page-translation.js'), /ctx\.onBuiltinDownloadEnded = function/);
});
