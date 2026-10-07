// The 'blab' engine's way out (background/blab-client.js) as callModel drives it
// (background/model-client.js): design §2.1 for the request, §5.2 for which
// failures are tried again, D-482 for temperature.
//
// fetch is a stub that honours its signal; chrome.storage.local is in memory
// and holds the account's token and the service address, which is all
// comic-client's apiFetch reads.
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';

const store = {};
globalThis.chrome = {
  runtime: { getPlatformInfo: async () => ({ os: 'mac' }) },
  storage: {
    local: {
      get: async (defaults) => {
        const out = { ...defaults };
        for (const key of Object.keys(defaults)) if (key in store) out[key] = store[key];
        return out;
      },
      set: async (values) => { Object.assign(store, values); },
      remove: async (keys) => { for (const key of [].concat(keys)) delete store[key]; },
    },
  },
};

await import('../../shared/lang-tags.js');
await import('../../shared/site-rules-builtin.js');
await import('../../shared/storage-writer.js');
await import('../../shared/site-rules.js');
await import('../../shared/sync-collection.js');
await import('../../shared/api-compat.js');
await import('../../shared/ai-profiles.js');
await import('../../shared/engines.js');
const { callModel, MAX_ATTEMPTS } = await import('../../background/model-client.js');
const { blabRequest } = await import('../../background/blab-client.js');

const BASE = 'http://blab.test';
const BLAB = globalThis.Engines.BLAB_PROFILE;
const request = { system: 'sys', user: 'hello', maxTokens: 50 };

function signIn() {
  store.comicApiBase = BASE;
  store.comicToken = 'tok-1';
}

function abortError() {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

async function withFetch(answer, run) {
  const saved = globalThis.fetch;
  const savedWarn = console.warn;
  const calls = [];
  globalThis.fetch = (url, init) => {
    calls.push({ url, init });
    const reply = answer(init, calls.length);
    if (reply === 'hang') {
      return new Promise((_, reject) => {
        if (init.signal.aborted) reject(abortError());
        init.signal.addEventListener('abort', () => reject(abortError()), { once: true });
      });
    }
    if (reply instanceof Error) return Promise.reject(reply);
    return Promise.resolve(reply);
  };
  // apiFetch warns once per non-ok reply; that line is its own, not under test here.
  console.warn = () => {};
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = saved;
    console.warn = savedWarn;
  }
}

const json = (data, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Headers(),
  json: async () => data,
});

/** Records the backoff waits and returns at once, so retries run instantly. */
function fakeClock() {
  const waits = [];
  return {
    waits,
    random: () => 0.5,
    now: () => Date.now(),
    sleep: async (ms) => { waits.push(ms); },
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (handle) => clearTimeout(handle),
  };
}

const call = (req, opts = {}) => callModel(BLAB, req, { limit: false, clock: fakeClock(), ...opts });

async function failureOf(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail('expected the call to fail');
}

test('blab: posts system, user and maxTokens to /api/blab/complete with the account token', async () => {
  signIn();
  await withFetch(() => json({ text: ' Bonjour ', usage: { used: 1, limit: 100, resetsAt: 'x' } }), async (calls) => {
    const answer = await call(request);
    assert.deepEqual(answer, { text: 'Bonjour' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${BASE}/api/blab/complete`);
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer tok-1');
    assert.deepEqual(JSON.parse(calls[0].init.body), { system: 'sys', user: 'hello', maxTokens: 50 });
  });
});

test('blab (D-482): temperature is sent when the request has one and omitted when it has none', async () => {
  signIn();
  await withFetch(() => json({ text: 'ok' }), async (calls) => {
    await call({ ...request, temperature: 0.3 });
    await call({ ...request, temperature: 0 });
    await call(request);
    await call({ ...request, temperature: undefined });
    const bodies = calls.map((c) => JSON.parse(c.init.body));
    assert.equal(bodies[0].temperature, 0.3);
    assert.equal(bodies[1].temperature, 0, 'zero is a temperature, not an absent one');
    assert.equal('temperature' in bodies[2], false);
    assert.equal('temperature' in bodies[3], false);
  });
  assert.deepEqual(blabRequest({ user: 'u', maxTokens: 1 }).body, { system: '', user: 'u', maxTokens: 1 });
});

test('blab: daily_limit, plan_required and a server 401 are the account state: one request, never retried', async () => {
  const cases = [
    { status: 429, body: { error: 'daily_limit', message: 'm', limit: 100, used: 100, resetsAt: '2026-10-08T00:00:00Z' } },
    { status: 403, body: { error: 'plan_required', message: 'm' } },
    { status: 401, body: { error: 'unauthorized', message: 'm' } },
  ];
  for (const { status, body } of cases) {
    signIn();
    await withFetch(() => json(body, status), async (calls) => {
      const clock = fakeClock();
      const error = await failureOf(call(request, { clock }));
      assert.equal(calls.length, 1, `${body.error} is sent once`);
      assert.deepEqual(clock.waits, [], `${body.error} waits for no retry`);
      assert.equal(error.attempts, 1);
      assert.equal(error.apiFailure.blab, body.error);
      assert.equal(error.apiFailure.status, status);
      assert.equal(error.apiFailure.retryable, false);
      assert.equal(error.apiFailure.endpoint, `${BASE}/api/blab/complete`);
      if (body.error === 'daily_limit') assert.equal(error.apiFailure.resetsAt, '2026-10-08T00:00:00Z');
    });
  }
  assert.equal(store.comicToken, undefined, 'a server 401 drops the token, so the next use offers a sign-in');
});

test('blab: with no token on this device nothing is sent, and it reads as unauthorized', async () => {
  delete store.comicToken;
  store.comicApiBase = BASE;
  await withFetch(() => json({ text: 'never' }), async (calls) => {
    const error = await failureOf(call(request));
    assert.equal(calls.length, 0);
    assert.equal(error.apiFailure.blab, 'unauthorized');
    assert.equal(error.apiFailure.retryable, false);
  });
});

test('blab: upstream_failed (502), unavailable (503) and a network error are retried like any model failure', async () => {
  for (const reply of [json({ error: 'upstream_failed' }, 502), json({ error: 'unavailable' }, 503), new TypeError('Failed to fetch')]) {
    signIn();
    await withFetch(() => reply, async (calls) => {
      const clock = fakeClock();
      const error = await failureOf(call(request, { clock }));
      assert.equal(calls.length, MAX_ATTEMPTS);
      assert.equal(clock.waits.length, MAX_ATTEMPTS - 1);
      assert.equal(error.attempts, MAX_ATTEMPTS);
      assert.notEqual(error.apiFailure.retryable, false);
      if (reply instanceof Error) assert.equal(error.apiFailure.network, true);
      else assert.equal(error.apiFailure.status, reply.status);
    });
  }
  signIn();
  await withFetch((_, n) => (n === 1 ? json({ error: 'upstream_failed' }, 502) : json({ text: 'second' })), async (calls) => {
    assert.deepEqual(await call(request), { text: 'second' });
    assert.equal(calls.length, 2);
  });
});

test('blab: invalid_request (400) and too_large (413) are not retried', async () => {
  for (const [status, code] of [[400, 'invalid_request'], [413, 'too_large']]) {
    signIn();
    await withFetch(() => json({ error: code, limit: 24000 }, status), async (calls) => {
      const error = await failureOf(call(request));
      assert.equal(calls.length, 1);
      assert.equal(error.apiFailure.blab, code);
    });
  }
});

test('blab: an empty answer is apiFailure.empty, not an empty translation', async () => {
  signIn();
  await withFetch(() => json({ text: '   ' }), async (calls) => {
    const error = await failureOf(call(request));
    assert.equal(calls.length, 1);
    assert.equal(error.apiFailure.empty, true);
  });
});

test('blab: the attempt timeout is a timeout and the caller abort is err.aborted, never a network error', async () => {
  signIn();
  const quick = { ...BLAB, timeoutSec: 0.05 };
  await withFetch(() => 'hang', async () => {
    const error = await failureOf(callModel(quick, request, { limit: false, retry: false }));
    assert.equal(error.apiFailure.timeout, true);
    assert.equal(error.apiFailure.network, undefined);
  });
  await withFetch(() => 'hang', async (calls) => {
    const controller = new AbortController();
    const pending = callModel(BLAB, request, { limit: false, signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    const error = await failureOf(pending);
    assert.equal(error.aborted, true);
    assert.equal(error.apiFailure, undefined);
    assert.equal(calls.length, 1);
  });
});
