// The 'blab' engine's way out (background/blab-client.js) as callModel drives it
// (background/model-client.js): design §2.1 for the request, §5.2 for which
// failures are tried again, D-482 for temperature.
//
// fetch is a stub that honours its signal; chrome.storage.local is in memory
// and holds the account's token and the service address, which is all
// comic-client's apiFetch reads. chrome.storage.session, also in memory, holds
// the account-entry click (D-499) and outlives a module instance the way the
// browser's session storage outlives a recycled service worker.
//
// An account failure is remembered for the token it was given for (D-490 N1),
// so every signIn() below hands out a new token: a case starts from an account
// the client has not been refused for yet, in a fresh browser session.
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';

const store = {};
const session = {};

// A read held back by holdNextRead: it reads the stored values when it is
// asked, as a real read would, and hands them back only when the test opens it.
const heldReads = { local: null, session: null };

function memoryArea(data, name) {
  return {
    get: async (defaults) => {
      const out = { ...defaults };
      for (const key of Object.keys(defaults)) if (key in data) out[key] = data[key];
      const gate = heldReads[name];
      if (gate) {
        heldReads[name] = null;
        gate.reached = true;
        await gate.opened;
      }
      return out;
    },
    set: async (values) => { Object.assign(data, values); },
    remove: async (keys) => { for (const key of [].concat(keys)) delete data[key]; },
  };
}

/** Hold back the next chrome.storage[area].get; `open()` lets it answer (or disarms it if never reached). */
function holdNextRead(area) {
  let open;
  const gate = { reached: false, opened: new Promise((resolve) => { open = resolve; }) };
  heldReads[area] = gate;
  return {
    reached: () => gate.reached,
    open: () => {
      if (heldReads[area] === gate) heldReads[area] = null;
      open();
    },
  };
}

globalThis.chrome = {
  runtime: { getPlatformInfo: async () => ({ os: 'mac' }) },
  storage: { local: memoryArea(store, 'local'), session: memoryArea(session, 'session') },
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
const {
  blabRequest, sendBlab, dailyLimitHeld, noteAccountAction, refreshAfterAccountAction,
} = await import('../../background/blab-client.js');

const BASE = 'http://blab.test';
const BLAB = globalThis.Engines.BLAB_PROFILE;
const request = { system: 'sys', user: 'hello', maxTokens: 50 };

let tokens = 0;
function signIn() {
  store.comicApiBase = BASE;
  store.comicToken = `tok-${++tokens}`;
  delete store.comicAccountCache;
  for (const key of Object.keys(session)) delete session[key];
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
    assert.equal(calls[0].init.headers.Authorization, `Bearer ${store.comicToken}`);
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

test('blab (D-497 F7): only a network error is retried; 502, 503 and a timeout are tried once', async () => {
  // The service already retried its upstream before answering 502/503, and a
  // timed-out attempt has used the whole wait: a second try only doubles it.
  for (const reply of [json({ error: 'upstream_failed' }, 502), json({ error: 'unavailable' }, 503)]) {
    signIn();
    await withFetch(() => reply, async (calls) => {
      const clock = fakeClock();
      const error = await failureOf(call(request, { clock }));
      assert.equal(calls.length, 1, `${reply.status} is sent once`);
      assert.deepEqual(clock.waits, []);
      assert.equal(error.attempts, 1);
      assert.equal(error.apiFailure.status, reply.status);
    });
  }
  signIn();
  await withFetch(() => 'hang', async (calls) => {
    const error = await failureOf(callModel({ ...BLAB, timeoutSec: 0.05 }, request, { limit: false, clock: fakeClock() }));
    assert.equal(error.apiFailure.timeout, true);
    assert.equal(calls.length, 1, 'a timeout is not tried again');
    assert.equal(error.attempts, 1);
  });
  signIn();
  await withFetch(() => new TypeError('Failed to fetch'), async (calls) => {
    const clock = fakeClock();
    const error = await failureOf(call(request, { clock }));
    assert.equal(calls.length, MAX_ATTEMPTS);
    assert.equal(clock.waits.length, MAX_ATTEMPTS - 1);
    assert.equal(error.attempts, MAX_ATTEMPTS);
    assert.equal(error.apiFailure.network, true);
  });
  signIn();
  await withFetch((_, n) => (n === 1 ? new TypeError('Failed to fetch') : json({ text: 'second' })), async (calls) => {
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
    // The full address, as the 'ai' engine words it (N9).
    assert.equal(error.apiFailure.endpoint, `${BASE}/api/blab/complete`);
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

// ---------------------------------------------------------------------------
// The account-failure latch (D-490 N1)
// ---------------------------------------------------------------------------

const PLAN_REQUIRED = () => json({ error: 'plan_required', message: 'm' }, 403);
const dailyLimit = (resetsAt) => json({ error: 'daily_limit', message: 'm', limit: 100, used: 100, resetsAt }, 429);

/** Run `fn` with Date.now moved `ms` ahead. */
async function later(ms, fn) {
  const realNow = Date.now;
  const shifted = realNow() + ms;
  Date.now = () => shifted;
  try {
    return await fn();
  } finally {
    Date.now = realNow;
  }
}

test('latch: after plan_required the next calls are refused here, with the same failure and no request', async () => {
  signIn();
  await withFetch(PLAN_REQUIRED, async (calls) => {
    const first = await failureOf(call(request));
    assert.equal(calls.length, 1);
    for (let i = 0; i < 3; i++) {
      const again = await failureOf(call(request));
      assert.equal(again.apiFailure.blab, 'plan_required');
      assert.equal(again.apiFailure.retryable, false);
      assert.equal(again.apiFailure.latched, true);
      assert.equal(again.message, first.message);
    }
    assert.equal(calls.length, 1, 'refused locally: still the one request');
  });
});

test('latch: daily_limit holds until resetsAt and carries it on every refusal', async () => {
  signIn();
  const resetsAt = new Date(Date.now() + 3_600_000).toISOString();
  await withFetch((_, n) => (n === 1 ? dailyLimit(resetsAt) : json({ text: 'next day' })), async (calls) => {
    await failureOf(call(request));
    // Past the short TTL of the other codes, still before resetsAt: still held.
    const held = await later(120_000, () => failureOf(call(request)));
    assert.equal(held.apiFailure.blab, 'daily_limit');
    assert.equal(held.apiFailure.resetsAt, resetsAt);
    assert.equal(calls.length, 1);
    // resetsAt has come: the next call asks the service again.
    assert.deepEqual(await later(3_600_001, () => call(request)), { text: 'next day' });
    assert.equal(calls.length, 2);
  });
});

test('latch: plan_required is let go after its short TTL', async () => {
  signIn();
  await withFetch((_, n) => (n === 1 ? PLAN_REQUIRED() : json({ text: 'ok' })), async (calls) => {
    await failureOf(call(request));
    await failureOf(later(30_000, () => call(request)));
    assert.equal(calls.length, 1);
    assert.deepEqual(await later(61_000, () => call(request)), { text: 'ok' });
    assert.equal(calls.length, 2);
  });
});

test('latch: a new token (signed in again, another account) lets go at once, daily_limit too', async () => {
  for (const reply of [PLAN_REQUIRED, () => dailyLimit(new Date(Date.now() + 3_600_000).toISOString())]) {
    signIn();
    await withFetch((_, n) => (n === 1 ? reply() : json({ text: 'ok' })), async (calls) => {
      await failureOf(call(request));
      signIn();
      assert.deepEqual(await call(request), { text: 'ok' });
      assert.equal(calls.length, 2);
    });
  }
});

test('latch: after a server 401 (token dropped) the next sign-in lets go', async () => {
  signIn();
  await withFetch((_, n) => (n === 1 ? json({ error: 'unauthorized', message: 'm' }, 401) : json({ text: 'ok' })), async (calls) => {
    await failureOf(call(request));
    assert.equal(store.comicToken, undefined);
    signIn();
    assert.deepEqual(await call(request), { text: 'ok' });
    assert.equal(calls.length, 2);
  });
});

test('latch: billing/me judging the account available since the refusal lets go; a stale or negative answer does not', async () => {
  signIn();
  await withFetch((_, n) => (n === 1 ? PLAN_REQUIRED() : json({ text: 'ok' })), async (calls) => {
    await failureOf(call(request));
    // Fetched before the refusal: says nothing about now.
    store.comicAccountCache = { fetchedAt: Date.now() - 10_000, account: { blabTranslation: { available: true } } };
    await failureOf(call(request));
    // Judged since, still no plan.
    store.comicAccountCache = { fetchedAt: Date.now() + 1, account: { blabTranslation: { available: false } } };
    await failureOf(call(request));
    assert.equal(calls.length, 1);
    // Judged since, plan bought.
    store.comicAccountCache = { fetchedAt: Date.now() + 2, account: { blabTranslation: { available: true } } };
    assert.deepEqual(await call(request), { text: 'ok' });
    assert.equal(calls.length, 2);
  });
});

test('latch: a passing failure (503) is not remembered', async () => {
  signIn();
  await withFetch((_, n) => (n === 1 ? json({ error: 'unavailable' }, 503) : json({ text: 'ok' })), async (calls) => {
    await failureOf(call(request));
    assert.deepEqual(await call(request), { text: 'ok' });
    assert.equal(calls.length, 2);
  });
});

test('latch: captions resent every 8 s after an account error send nothing more', async () => {
  // content/captions/translate.js puts a failed line on an 8 s cooldown
  // (RETRY_COOLDOWN_MS) and sends it again; each resend is one more callModel
  // on the Blab profile. A minute of a playing video is seven of them.
  signIn();
  const resetsAt = new Date(Date.now() + 3_600_000).toISOString();
  const caption = { system: 'subtitle system', user: 'line', maxTokens: 200 };
  await withFetch(() => dailyLimit(resetsAt), async (calls) => {
    await failureOf(call(caption));
    for (let resend = 1; resend <= 7; resend++) {
      const error = await later(resend * 8_000, () => failureOf(call(caption)));
      assert.equal(error.apiFailure.blab, 'daily_limit');
    }
    assert.equal(calls.length, 1);
  });
});

test('latch: dailyLimitHeld answers the daily_limit latch only, for the token it was given for', async () => {
  signIn();
  const resetsAt = new Date(Date.now() + 3_600_000).toISOString();
  await withFetch(() => dailyLimit(resetsAt), async () => {
    assert.equal(await dailyLimitHeld(), false);
    await failureOf(call(request));
    assert.equal(await dailyLimitHeld(), true);
    // Past resetsAt it is a new day.
    assert.equal(await later(3_600_001, () => dailyLimitHeld()), false);
  });
  signIn();
  await withFetch(() => dailyLimit(resetsAt), async () => {
    await failureOf(call(request));
    signIn();
    assert.equal(await dailyLimitHeld(), false, 'another token');
  });
  signIn();
  await withFetch(PLAN_REQUIRED, async () => {
    await failureOf(call(request));
    assert.equal(await dailyLimitHeld(), false, 'plan_required is not the allowance');
  });
});

// ---------------------------------------------------------------------------
// After an account entry was clicked (D-497 F3)
// ---------------------------------------------------------------------------

const ME = `${BASE}/api/billing/me`;
const isMe = (calls) => calls.filter((c) => c.url === ME).length;

/** The service: billing/me says `available`, /api/blab/complete answers by `complete`. */
function service(available, complete) {
  return (init, n, url) => (url === ME ? json({ blabTranslation: { available } }) : complete(n));
}

async function withService(answer, run) {
  return withFetch(() => null, async () => {
    const calls = [];
    globalThis.fetch = (url, init) => {
      calls.push({ url, init });
      return Promise.resolve(answer(init, calls.length, url));
    };
    return run(calls);
  });
}

test('F3: with no entry clicked, nothing asks billing/me', async () => {
  signIn();
  await withService(service(true, (n) => (n === 1 ? PLAN_REQUIRED() : json({ text: 'ok' }))), async (calls) => {
    await failureOf(call(request));
    await refreshAfterAccountAction({ explicit: true });
    await refreshAfterAccountAction({ explicit: false });
    assert.equal(isMe(calls), 0);
    await failureOf(call(request));
  });
});

test('F3: after a click, requests nobody made ask billing/me at most every 10 s while latched', async () => {
  signIn();
  await withService(service(false, () => PLAN_REQUIRED()), async (calls) => {
    await failureOf(call(request));
    await noteAccountAction();
    await later(1_000, () => refreshAfterAccountAction({ explicit: false }));
    assert.equal(isMe(calls), 1);
    for (const ms of [2_000, 5_000, 10_900]) await later(ms, () => refreshAfterAccountAction({ explicit: false }));
    assert.equal(isMe(calls), 1, 'inside 10 s of the last ask');
    await later(11_100, () => refreshAfterAccountAction({ explicit: false }));
    assert.equal(isMe(calls), 2);
    // Still no plan: the latch holds and nothing goes to the service.
    await failureOf(later(11_200, () => call(request)));
    assert.equal(calls.length - isMe(calls), 1);
  });
});

/** The service: billing/me says `available()`; /api/blab/complete translates once it is, refuses before. */
function paywall(available) {
  return (init, n, url) => {
    if (url === ME) return json({ blabTranslation: { available: available() } });
    return available() ? json({ text: 'ok' }) : PLAN_REQUIRED();
  };
}

test('F3: after a click, the next request a person makes asks billing/me first and a plan bought since lets go', async () => {
  signIn();
  let available = false;
  await withService((init, n, url) => (url === ME
    ? json({ blabTranslation: { available } })
    : (n === 1 ? PLAN_REQUIRED() : json({ text: 'ok' }))), async (calls) => {
    await failureOf(call(request));
    await noteAccountAction();
    available = true;
    // A moment after the refusal, as a click and a new request always are.
    await later(5, () => refreshAfterAccountAction({ explicit: true }));
    assert.equal(isMe(calls), 1);
    assert.deepEqual(await call(request), { text: 'ok' });
  });
  // The click stays until billing/me says Blab is available (D-499): every
  // request a person makes before the plan is bought asks again, the one after
  // uses the click up, and a refusal after that asks nothing.
  signIn();
  available = false;
  await withService(paywall(() => available), async (calls) => {
    await failureOf(call(request));
    await noteAccountAction();
    await later(5, () => refreshAfterAccountAction({ explicit: true }));
    await later(10, () => refreshAfterAccountAction({ explicit: true }));
    assert.equal(isMe(calls), 2, 'not paid yet: each request a person makes asks');
    available = true;
    await later(15, () => refreshAfterAccountAction({ explicit: true }));
    assert.equal(isMe(calls), 3);
    assert.deepEqual(await later(20, () => call(request)), { text: 'ok' });
    // The plan lapses again: the refusal is remembered, and with the click used
    // up the next request asks nothing.
    available = false;
    await failureOf(later(25, () => call(request)));
    await later(30, () => refreshAfterAccountAction({ explicit: true }));
    assert.equal(isMe(calls), 3, 'the click was used up');
  });
});

test('F3: a billing/me failure is the request\'s failure, worded like the service\'s own, and leaves the click for the next one (journey 3)', async () => {
  signIn();
  let serviceDown = true;
  await withService((init, n, url) => {
    if (url === ME) return serviceDown ? json({ error: 'unavailable' }, 503) : json({ blabTranslation: { available: true } });
    return serviceDown ? PLAN_REQUIRED() : json({ text: 'ok' });
  }, async (calls) => {
    await failureOf(call(request));
    await noteAccountAction();
    const error = await failureOf(later(5, () => refreshAfterAccountAction({ explicit: true })));
    assert.equal(error.apiFailure.status, 503);
    assert.equal(error.apiFailure.endpoint, ME);
    assert.equal(isMe(calls), 1);
    // The user had paid; billing/me answers again.
    serviceDown = false;
    await later(10, () => refreshAfterAccountAction({ explicit: true }));
    assert.equal(isMe(calls), 2, 'the failed ask did not use the click up');
    assert.deepEqual(await later(15, () => call(request)), { text: 'ok' });
  });
});

// ---------------------------------------------------------------------------
// The click survives what the latch does not (D-499), and one billing/me for
// many batches (N-2)
// ---------------------------------------------------------------------------

/** A billing/me reply held back until `answer()`: what the batches see while it is on its way. */
function heldBackMe() {
  const pending = [];
  return {
    reply: (body) => new Promise((resolve) => { pending.push(() => resolve(json(body()))); }),
    started: () => pending.length > 0,
    answer: () => { for (const resolve of pending.splice(0)) resolve(); },
  };
}

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wait, a macrotask at a time, until `ready()`. A single-flight regression that
 * never gets there fails here instead of leaving `npm run test:unit` hanging.
 */
async function until(ready, what) {
  for (let i = 0; !ready(); i++) {
    if (i >= 200) throw new Error(`gave up waiting for ${what}`);
    await tick();
  }
}

test('F3-H: the latch runs out, a request nobody made is refused anew; the person\'s next request still asks billing/me and goes through', async () => {
  signIn();
  let available = false;
  await withService(paywall(() => available), async (calls) => {
    await failureOf(call(request));
    // The user clicks Subscribe and stays on the pricing page past the latch.
    await noteAccountAction();
    await later(61_000, async () => {
      // An automatic pass, then its refusal: a new latch, given after the click.
      await refreshAfterAccountAction({ explicit: false });
      await failureOf(call(request));
    });
    assert.equal(isMe(calls), 0, 'nothing was held when the automatic pass came');
    // The user pays and translates.
    available = true;
    await later(61_010, () => refreshAfterAccountAction({ explicit: true }));
    assert.equal(isMe(calls), 1, 'the click is still pending: the person\'s request asks billing/me');
    assert.deepEqual(await later(61_020, () => call(request)), { text: 'ok' });
  });
});

test('D-499: a click with nothing held, the person\'s request refused by the service, then paid: the next one inside the minute asks billing/me (journey 2)', async () => {
  signIn();
  let available = false;
  await withService(paywall(() => available), async (calls) => {
    await noteAccountAction();
    // Nothing is held: the person's request goes out as it is, and is refused.
    await later(5, async () => {
      await refreshAfterAccountAction({ explicit: true });
      await failureOf(call(request));
    });
    assert.equal(isMe(calls), 0);
    assert.equal(calls.length, 1);
    available = true;
    await later(10, () => refreshAfterAccountAction({ explicit: true }));
    assert.equal(isMe(calls), 1, 'finding nothing held did not use the click up');
    assert.deepEqual(await later(15, () => call(request)), { text: 'ok' });
  });
});

let restarts = 0;

test('D-499: the click outlives the service worker and the latch does not; after paying, the person\'s request asks billing/me (journey 1)', async () => {
  signIn();
  let available = false;
  await withService(paywall(() => available), async (calls) => {
    const sent = () => calls.length - isMe(calls);
    await failureOf(call(request));
    await noteAccountAction();
    // Chrome recycles the worker while the user is on the pricing page: a new
    // instance of the module, over the same session storage.
    const worker = await import(`../../background/blab-client.js?restart=${++restarts}`);
    assert.notEqual(worker.sendBlab, sendBlab, 'a new module instance');
    const send = () => worker.sendBlab(worker.blabRequest(request), new AbortController().signal);
    await later(1_000, async () => {
      // The automatic pass in the new worker: no latch there, so it is sent,
      // refused anew and latched again.
      await worker.refreshAfterAccountAction({ explicit: false });
      await failureOf(send());
    });
    assert.equal(sent(), 2, 'the new worker held no latch: it sent');
    assert.equal(isMe(calls), 0);
    // The old instance still has its own latch in its memory: it sends nothing.
    await failureOf(call(request));
    assert.equal(sent(), 2);
    // The user pays and translates.
    available = true;
    await later(1_010, () => worker.refreshAfterAccountAction({ explicit: true }));
    assert.equal(isMe(calls), 1, 'the click outlived the worker');
    assert.deepEqual(await later(1_020, send), { text: 'ok' });
    assert.deepEqual(session, {}, 'billing/me said available: the click is used up');
  });
});

test('N-2: batches sent together after a click share one billing/me, and every one goes through', async () => {
  signIn();
  let available = false;
  const me = heldBackMe();
  await withService((init, n, url) => (url === ME
    ? me.reply(() => ({ blabTranslation: { available } }))
    : (available ? json({ text: 'ok' }) : PLAN_REQUIRED())), async (calls) => {
    await failureOf(call(request));
    await noteAccountAction();
    available = true;
    // A page pass: each batch is a person's request, refreshed before it is sent.
    const batch = async () => {
      await refreshAfterAccountAction({ explicit: true });
      return call(request);
    };
    await later(5, async () => {
      const first = Promise.all([batch(), batch(), batch(), batch()]);
      await until(me.started, 'billing/me asked');
      // One more arrives while the answer is on its way.
      const late = batch();
      await tick(5);
      me.answer();
      assert.deepEqual(await first, Array(4).fill({ text: 'ok' }));
      assert.deepEqual(await late, { text: 'ok' });
    });
    assert.equal(isMe(calls), 1);
  });
});

test('N-2: a person\'s request that finds an automatic billing/me on its way waits for it, and asks again only while the latch still holds', async () => {
  for (const [paid, at] of [[false, 500_000], [true, 600_000]]) {
    signIn();
    let available = false;
    const me = heldBackMe();
    // Once paid, billing/me answers at once: an ask nobody expects then (a click
    // left pending) shows in the count instead of waiting forever.
    await withService((init, n, url) => (url === ME
      ? (available ? json({ blabTranslation: { available } }) : me.reply(() => ({ blabTranslation: { available } })))
      : PLAN_REQUIRED()), async (calls) => {
      // Past every earlier case's 10 s spacing, so the automatic request may ask.
      await later(at, () => failureOf(call(request)));
      await noteAccountAction();
      await later(at + 10, async () => {
        const automatic = refreshAfterAccountAction({ explicit: false });
        await until(me.started, 'the automatic billing/me');
        const person = refreshAfterAccountAction({ explicit: true });
        available = paid;
        me.answer();
        await automatic;
        // Not paid: the latch still holds, and the person's request asks itself.
        if (!paid) {
          await until(me.started, 'the person\'s own billing/me');
          me.answer();
        }
        await person;
      });
      assert.equal(isMe(calls), paid ? 1 : 2, paid ? 'released: no second ask' : 'still held: asks again');
      // The service refuses the next request (the plan lapsed again, or was
      // never bought): paid, nothing was held, so it is sent and latched anew;
      // not paid, the latch still holds and it is refused here.
      await later(at + 15, () => failureOf(call(request)));
      assert.equal(calls.length - isMe(calls), paid ? 2 : 1);
      // Paid: the automatic ask found Blab available and used the click up, so
      // the next person meets the new latch without asking. Not paid: the click
      // stays, and the next person asks again.
      await later(at + 20, async () => {
        const next = refreshAfterAccountAction({ explicit: true });
        if (!paid) {
          await until(me.started, 'the next person\'s billing/me');
          me.answer();
        }
        await next;
      });
      assert.equal(isMe(calls), paid ? 1 : 3, paid ? 'the click is used up' : 'the click is still there');
    });
  }
});

test('N-2 (D-499): a request reading the latch or the click while another\'s billing/me starts waits for that one', async () => {
  for (const reading of ['latch', 'click']) {
    signIn();
    let asks = 0;
    const me = heldBackMe();
    await withService((init, n, url) => {
      if (url !== ME) return PLAN_REQUIRED();
      // The first ask is held back; one asked after it (the regression) answers at once.
      return ++asks === 1 ? me.reply(() => ({ blabTranslation: { available: false } }))
        : json({ blabTranslation: { available: false } });
    }, async (calls) => {
      await failureOf(call(request));
      await noteAccountAction();
      await later(5, async () => {
        // The latch read starts with the token; the click read is session storage.
        const read = holdNextRead(reading === 'latch' ? 'local' : 'session');
        const first = refreshAfterAccountAction({ explicit: true });
        await until(read.reached, `the first request reading the ${reading}`);
        const second = refreshAfterAccountAction({ explicit: true });
        await until(me.started, 'the second request\'s billing/me');
        // Were the first to go on past a latch read without looking, the click
        // read would be its next stop: hold it there until the answer is in.
        const click = reading === 'latch' ? holdNextRead('session') : null;
        read.open();
        await tick();
        me.answer();
        await second;
        if (click) click.open();
        await first;
      });
      assert.equal(isMe(calls), 1, `${reading}: one billing/me`);
    });
  }
});

test('D-500: a request nobody made whose billing/me finds Blab available uses the click up, as a person\'s would', async () => {
  signIn();
  let available = false;
  await withService(paywall(() => available), async (calls) => {
    const sent = () => calls.length - isMe(calls);
    // Past every earlier case's 10 s spacing, so the automatic request may ask.
    const at = 700_000;
    await later(at, () => failureOf(call(request)));
    await noteAccountAction();
    // The user pays; the automatic pass is first to ask.
    available = true;
    await later(at + 10, () => refreshAfterAccountAction({ explicit: false }));
    assert.equal(isMe(calls), 1);
    assert.deepEqual(session, {}, 'billing/me said available: the click is used up, whoever asked');
    assert.deepEqual(await later(at + 20, () => call(request)), { text: 'ok' });
    // The plan lapses: the service refuses and the latch is back, with no click.
    available = false;
    await failureOf(later(at + 30, () => call(request)));
    assert.equal(sent(), 3);
    await later(at + 40, () => refreshAfterAccountAction({ explicit: true }));
    assert.equal(isMe(calls), 1, 'no click pending: the person\'s request asks nothing');
    await failureOf(later(at + 50, () => call(request)));
    assert.equal(sent(), 3, 'refused by the latch');
  });
});

// ---------------------------------------------------------------------------
// The latch as each call found it (D-498): batches read it together
// ---------------------------------------------------------------------------

test('latch: a call letting go of the latch it found leaves one given meanwhile in place', async () => {
  signIn();
  await withFetch(PLAN_REQUIRED, async (calls) => {
    await failureOf(call(request));
    // Signed in again: the remembered refusal no longer holds.
    signIn();
    const tokenRead = holdNextRead('local');
    const stale = dailyLimitHeld();
    assert.equal(tokenRead.reached(), true, 'the first call found the old latch and is reading the token');
    // Meanwhile a request lets the old latch go, is sent, refused: a new latch.
    await failureOf(call(request));
    assert.equal(calls.length, 2);
    tokenRead.open();
    assert.equal(await stale, false);
    await failureOf(call(request));
    assert.equal(calls.length, 2, 'the latch given meanwhile still refuses here');
  });
});

test('latch: a call answers by the latch it found, not by what another call left meanwhile', async () => {
  signIn();
  const resetsAt = new Date(Date.now() + 3_600_000).toISOString();
  await withFetch(() => dailyLimit(resetsAt), async (calls) => {
    await failureOf(call(request));
    // A request reads the latch, and the token as it is now.
    const tokenRead = holdNextRead('local');
    const pending = sendBlab(blabRequest(request), new AbortController().signal);
    assert.equal(tokenRead.reached(), true);
    // Then the user signs in again and another call lets the latch go.
    signIn();
    assert.equal(await dailyLimitHeld(), false);
    tokenRead.open();
    const error = await failureOf(pending);
    assert.equal(error.apiFailure.latched, true, 'refused by the latch it found, for the token it read');
    assert.equal(calls.length, 1);
  });
});
