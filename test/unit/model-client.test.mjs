// 模型请求的唯一出口（background/model-client.js 的 callModel）、在途保活
// （background/keepalive.js）和失败的唯一接住点（background/api-errors.js 的
// replyError），P1-D 设计 §3.6–§3.8。
//
// callModel 在这里测 D1 的三件事：超时、空答案、调用方取消；网络错与服务商
// 错的形状顺带钉住。D2 的重试（§3.9）也在这里：哪些失败再试、退避与抖动、
// Retry-After、等待中取消；限速器本身在 model-limiter.test.mjs。流式是 D3 的。
// fetch 换成桩，桩认 signal：abort 时像真 fetch 一样以 AbortError 拒绝。
// 会重试的用例传一个 clock：sleep 记下要等的毫秒数、立刻返回，不真等。
// 总预算（修复回合 1 的 H）用 virtualClock：计时器与 sleep 都在虚拟时间上，
// 没有别的事可做时拨到最早那个计时器，240 秒的路径一瞬间走完。
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.chrome = globalThis.chrome || {};
globalThis.chrome.runtime = globalThis.chrome.runtime || {};
globalThis.chrome.runtime.getPlatformInfo = async () => ({ os: 'mac' });

await import('../../shared/lang-tags.js');
await import('../../shared/site-rules-builtin.js');
await import('../../shared/storage-writer.js');
await import('../../shared/site-rules.js');
await import('../../shared/sync-collection.js');
await import('../../shared/api-compat.js');
await import('../../shared/ai-profiles.js');
const { callModel, parseRetryAfter, MAX_ATTEMPTS } = await import('../../background/model-client.js');
const { createLimiter } = await import('../../background/model-limiter.js');
await import('../../i18n/lang/en.js');
const { replyError } = await import('../../background/api-errors.js');
const { acquire, release, keepaliveState, PING_MS } = await import('../../background/keepalive.js');

const profile = (over = {}) => Object.assign({
  id: 'p1',
  provider: 'custom',
  apiEndpoint: 'http://127.0.0.1:9/v1/chat/completions',
  apiKey: 'sk-secret',
  modelName: 'test-model',
  timeoutSec: 60,
}, over);
const request = { system: 'sys', user: 'hello', maxTokens: 50, temperature: 0.3 };

function abortError() {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

/** fetch 桩：answer(init) 决定回什么；'hang' 就一直挂着，直到 signal 断开。 */
async function withFetch(answer, run) {
  const saved = globalThis.fetch;
  const calls = [];
  globalThis.fetch = (url, init) => {
    calls.push({ url, init });
    const reply = answer(init);
    if (reply === 'hang') {
      return new Promise((_, reject) => {
        if (init.signal.aborted) reject(abortError());
        init.signal.addEventListener('abort', () => reject(abortError()), { once: true });
      });
    }
    return Promise.resolve(reply);
  };
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = saved;
  }
}

const okJson = (data, status = 200, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Headers(headers),
  json: async () => data,
});

/** 不真等的时钟：sleep 记下毫秒数立刻返回；random 与 now 可定。 */
function fakeClock({ random = () => 0.5, now = () => Date.now() } = {}) {
  const waits = [];
  return {
    waits,
    random,
    now,
    sleep: async (ms, signal) => {
      waits.push(ms);
      if (signal && signal.aborted) throw Object.assign(new Error('aborted'), { aborted: true });
    },
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (handle) => clearTimeout(handle),
  };
}

/**
 * 虚拟时钟：now 从 0 起；setTimer / sleep 登记在虚拟时间上。每登记一次就排一轮
 * setImmediate —— 那时桩的 Promise 都已落定，没人再动 —— 把 now 拨到最早的计时器
 * 并触发它。桩 fetch 的答复都是立即的，所以「拨到下一个计时器」就是真实时间的走法。
 */
function virtualClock({ random = () => 0.5 } = {}) {
  let at = 0;
  let scheduled = false;
  const timers = new Set();
  const waits = [];
  function fireNext() {
    scheduled = false;
    if (timers.size === 0) return;
    let next = null;
    for (const timer of timers) if (!next || timer.due < next.due) next = timer;
    timers.delete(next);
    at = Math.max(at, next.due);
    next.fn();
    schedule();
  }
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    setImmediate(() => setImmediate(fireNext));
  }
  const setTimer = (fn, ms) => {
    const timer = { fn, due: at + ms };
    timers.add(timer);
    schedule();
    return timer;
  };
  const clearTimer = (timer) => timers.delete(timer);
  const sleep = (ms, signal) => {
    waits.push(ms);
    if (signal && signal.aborted) return Promise.reject(Object.assign(new Error('aborted'), { aborted: true }));
    return new Promise((resolve) => setTimer(resolve, ms));
  };
  return { now: () => at, random, setTimer, clearTimer, sleep, waits };
}
const chat = (text) => okJson({ choices: [{ message: { content: text } }] });

// ------------------------------------------------------------ callModel

test('callModel: answers { text } and releases its keepalive hold', async () => {
  await withFetch(() => chat('Bonjour'), async (calls) => {
    const out = await callModel(profile(), request);
    assert.deepEqual(out, { text: 'Bonjour' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, profile().apiEndpoint);
    assert.ok(calls[0].init.signal, 'every attempt carries its own signal');
  });
  assert.deepEqual(keepaliveState(), { holders: 0, running: false });
});

test('callModel: a profile without a positive timeoutSec is a caller bug', async () => {
  for (const timeoutSec of [undefined, 0, -1]) {
    await assert.rejects(callModel(profile({ timeoutSec }), request), TypeError);
  }
  assert.deepEqual(keepaliveState(), { holders: 0, running: false });
});

test('callModel: the profile timeout aborts the request as apiFailure.timeout with its seconds', async () => {
  await withFetch(() => 'hang', async () => {
    const started = Date.now();
    // D2：超时会重试，传不真等的 clock，三次各 0.05 秒仍远小于 2 秒。
    const clock = fakeClock();
    const error = await callModel(profile({ timeoutSec: 0.05 }), request, { clock }).then(
      () => assert.fail('should time out'), (err) => err);
    assert.ok(Date.now() - started < 2000, 'the timer, not the test runner, ended it');
    assert.equal(error.attempts, MAX_ATTEMPTS, 'a timeout is retried');
    assert.equal(error.aborted, undefined);
    assert.equal(error.apiFailure.timeout, true);
    assert.equal(error.apiFailure.seconds, 0.05);
    assert.ok(!/sk-secret|hello/.test(error.message), 'no key and no user text in the error');
  });
  assert.deepEqual(keepaliveState(), { holders: 0, running: false });
});

test('callModel: an empty answer throws apiFailure.empty instead of passing "" as a translation', async () => {
  for (const text of ['', undefined]) {
    await withFetch(() => okJson({ choices: [{ message: { content: text } }] }), async () => {
      const error = await callModel(profile(), request).then(() => assert.fail('should throw'), (err) => err);
      assert.equal(error.apiFailure.empty, true);
    });
  }
  assert.deepEqual(keepaliveState(), { holders: 0, running: false });
});

test('callModel: a caller abort is err.aborted, not an apiFailure', async () => {
  await withFetch(() => 'hang', async () => {
    const controller = new AbortController();
    const pending = callModel(profile(), request, { signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    const error = await pending.then(() => assert.fail('should abort'), (err) => err);
    assert.equal(error.aborted, true);
    assert.equal(error.apiFailure, undefined);
  });
  await withFetch(() => 'hang', async (calls) => {
    const controller = new AbortController();
    controller.abort();
    const error = await callModel(profile(), request, { signal: controller.signal })
      .then(() => assert.fail('should abort'), (err) => err);
    assert.equal(error.aborted, true);
    // D2：已经取消的请求在限速器那一关就停下，不再发出去（D1 时是发出去再被拒）。
    assert.equal(calls.length, 0);
  });
  assert.deepEqual(keepaliveState(), { holders: 0, running: false });
});

test('callModel: a real failure that lands as the caller aborts keeps its own shape (N9)', async () => {
  // The answer arrives, and the caller gives up while its body is being read:
  // the attempt's signal is aborted, but what was thrown is the server's 403,
  // not a cancellation, and it must not be reworded as one.
  const controller = new AbortController();
  await withFetch(() => ({
    ok: false,
    status: 403,
    headers: new Headers(),
    json: async () => { controller.abort(); return { error: { message: 'forbidden' } }; },
  }), async () => {
    const error = await callModel(profile(), request, { signal: controller.signal })
      .then(() => assert.fail('should throw'), (err) => err);
    assert.equal(error.aborted, undefined);
    assert.equal(error.apiFailure.status, 403);
  });
  assert.deepEqual(keepaliveState(), { holders: 0, running: false });
});

test('callModel: network and provider failures keep their structured shape', async () => {
  await withFetch(() => Promise.reject(new TypeError('Failed to fetch')), async () => {
    // D2：网络错会重试，传不真等的 clock。
    const error = await callModel(profile(), request, { clock: fakeClock() })
      .then(() => assert.fail('should throw'), (err) => err);
    assert.equal(error.apiFailure.network, true);
    assert.equal(error.apiFailure.status, 0);
  });
  await withFetch(() => okJson({ error: { message: 'bad key' } }, 401), async () => {
    const error = await callModel(profile(), request).then(() => assert.fail('should throw'), (err) => err);
    assert.equal(error.apiFailure.network, false);
    assert.equal(error.apiFailure.status, 401);
  });
  assert.deepEqual(keepaliveState(), { holders: 0, running: false });
});

test('callModel: holds the keepalive while in flight', async () => {
  let seen = null;
  await withFetch(() => {
    seen = keepaliveState();
    return chat('ok');
  }, () => callModel(profile(), request));
  assert.deepEqual(seen, { holders: 1, running: true });
  assert.deepEqual(keepaliveState(), { holders: 0, running: false });
});

// ------------------------------------------------------------ retry (D2, §3.9)

/** 按顺序回这些答复；用完了就一直回最后一个。 */
function sequence(...replies) {
  let i = 0;
  return () => {
    const reply = replies[Math.min(i, replies.length - 1)];
    i += 1;
    return typeof reply === 'function' ? reply() : reply;
  };
}
const fail = (status, headers) => () => okJson({ error: { message: `status ${status}` } }, status, headers);
const networkDown = () => Promise.reject(new TypeError('Failed to fetch'));

test('retry: which failures are tried again (network, timeout, 429, 5xx) and which are not', async () => {
  const retried = [['429', fail(429)], ['500', fail(500)], ['502', fail(502)], ['503', fail(503)], ['599', fail(599)],
    ['network', networkDown]];
  for (const [name, reply] of retried) {
    await withFetch(reply, async (calls) => {
      const clock = fakeClock();
      const error = await callModel(profile(), request, { clock }).then(() => assert.fail(name), (err) => err);
      assert.equal(calls.length, MAX_ATTEMPTS, `RETRY-CLASS ${name} is retried up to ${MAX_ATTEMPTS} tries`);
      assert.equal(error.attempts, MAX_ATTEMPTS);
      assert.equal(clock.waits.length, MAX_ATTEMPTS - 1);
    });
  }
  const once = [['400', fail(400)], ['401', fail(401)], ['403', fail(403)], ['404', fail(404)], ['422', fail(422)],
    ['empty answer', () => chat('')],
    ['unparseable body', () => ({ ok: true, status: 200, headers: new Headers(), json: async () => { throw new SyntaxError('x'); } })]];
  for (const [name, reply] of once) {
    await withFetch(reply, async (calls) => {
      const clock = fakeClock();
      const error = await callModel(profile(), request, { clock }).then(() => assert.fail(name), (err) => err);
      assert.equal(calls.length, 1, `NO-RETRY-CLASS ${name} is not retried`);
      assert.equal(error.attempts, 1);
      assert.deepEqual(clock.waits, []);
    });
  }
  assert.deepEqual(keepaliveState(), { holders: 0, running: false });
});

test('retry: two failures then an answer returns the answer; the last failure is rethrown as it was', async () => {
  await withFetch(sequence(fail(429), fail(503), () => chat('Salut')), async (calls) => {
    const out = await callModel(profile(), request, { clock: fakeClock() });
    assert.deepEqual(out, { text: 'Salut' });
    assert.equal(calls.length, 3);
    assert.notEqual(calls[0].init.signal, calls[1].init.signal, 'each attempt has its own signal');
  });
  await withFetch(sequence(fail(503), fail(503), fail(502)), async () => {
    const error = await callModel(profile(), request, { clock: fakeClock() }).then(() => assert.fail('x'), (err) => err);
    assert.equal(error.apiFailure.status, 502, 'the last failure is what the caller sees');
  });
  // 重试之后第 3 次撞上不可重试的也立刻停。
  await withFetch(sequence(fail(500), fail(401)), async (calls) => {
    const error = await callModel(profile(), request, { clock: fakeClock() }).then(() => assert.fail('x'), (err) => err);
    assert.equal(calls.length, 2);
    assert.equal(error.apiFailure.status, 401);
    assert.equal(error.attempts, 2);
  });
});

test('retry: backoff is 1 s then 2 s, each times a factor in [0.8, 1.2]', async () => {
  for (const [r, lo] of [[0, true], [0.5, false], [0.999999, false]]) {
    await withFetch(fail(500), async () => {
      const clock = fakeClock({ random: () => r });
      await callModel(profile(), request, { clock }).catch(() => {});
      assert.equal(clock.waits.length, 2);
      const [first, second] = clock.waits;
      assert.ok(first >= 800 && first <= 1200, `JITTER first wait ${first} within 1000 +-20%`);
      assert.ok(second >= 1600 && second <= 2400, `JITTER second wait ${second} within 2000 +-20%`);
      if (lo) assert.deepEqual(clock.waits, [800, 1600]);
    });
  }
  await withFetch(fail(500), async () => {
    const clock = fakeClock({ random: () => 0.5 });
    await callModel(profile(), request, { clock }).catch(() => {});
    assert.deepEqual(clock.waits, [1000, 2000]);
  });
});

test('retry: Retry-After in seconds or as an HTTP date replaces the backoff (no jitter)', async () => {
  await withFetch(sequence(fail(429, { 'Retry-After': '7' }), fail(429, { 'Retry-After': '3' }), () => chat('ok')),
    async (calls) => {
      const clock = fakeClock({ random: () => 0 });
      await callModel(profile(), request, { clock });
      assert.equal(calls.length, 3);
      assert.deepEqual(clock.waits, [7000, 3000], 'RETRY-AFTER seconds are waited exactly');
    });
  const now = Date.parse('2026-09-29T10:00:00Z');
  await withFetch(sequence(fail(503, { 'Retry-After': 'Tue, 29 Sep 2026 10:00:05 GMT' }), () => chat('ok')),
    async () => {
      const clock = fakeClock({ now: () => now });
      await callModel(profile(), request, { clock });
      assert.deepEqual(clock.waits, [5000], 'RETRY-AFTER date minus now');
    });
  // 读不懂的 Retry-After：按退避走。
  await withFetch(sequence(fail(429, { 'Retry-After': 'soon' }), () => chat('ok')), async () => {
    const clock = fakeClock({ random: () => 0.5 });
    await callModel(profile(), request, { clock });
    assert.deepEqual(clock.waits, [1000]);
  });
  assert.equal(parseRetryAfter(null, 0), null);
  assert.equal(parseRetryAfter('', 0), null);
  assert.equal(parseRetryAfter(' 12 ', 0), 12000);
  assert.equal(parseRetryAfter('1.5', 0), null, 'not an integer and not a date: unparseable');
  assert.equal(parseRetryAfter('Tue, 29 Sep 2026 09:59:00 GMT', now), 0, 'a date in the past is 0');
});

test('retry: Retry-After over 60 s fails at once with the wait, worded apiErrorRateLimitedWait', async () => {
  for (const header of ['120', 'Tue, 29 Sep 2026 10:02:00 GMT']) {
    await withFetch(fail(429, { 'Retry-After': header }), async (calls) => {
      const clock = fakeClock({ now: () => Date.parse('2026-09-29T10:00:00Z') });
      const error = await callModel(profile(), request, { clock }).then(() => assert.fail('x'), (err) => err);
      assert.equal(calls.length, 1, 'RATE-LIMITED-WAIT one request only');
      assert.deepEqual(clock.waits, []);
      assert.equal(error.apiFailure.rateLimitedWait, 120);
      const said = globalThis.APICompat.describeAPIFailure(error.apiFailure, (key) => globalThis.getMessage(key, 'en'));
      assert.match(said, /120/);
      assert.equal(said, globalThis.getMessage('apiErrorRateLimitedWait', 'en').replace('{seconds}', '120'));
    });
  }
  // 60 秒整还等。
  await withFetch(sequence(fail(429, { 'Retry-After': '60' }), () => chat('ok')), async () => {
    const clock = fakeClock();
    await callModel(profile(), request, { clock });
    assert.deepEqual(clock.waits, [60000]);
  });
});

test('retry: a 5xx with Retry-After over 60 s fails at once, worded as a server failure, not a rate limit', async () => {
  await withFetch(fail(503, { 'Retry-After': '120' }), async (calls) => {
    const clock = fakeClock();
    const error = await callModel(profile(), request, { clock }).then(() => assert.fail('x'), (err) => err);
    assert.equal(calls.length, 1, 'SERVER-WAIT one request only');
    assert.deepEqual(clock.waits, []);
    assert.equal(error.apiFailure.status, 503);
    assert.equal(error.apiFailure.rateLimitedWait, undefined, 'rateLimitedWait is for 429 only');
    const text = globalThis.APICompat.describeAPIFailure(error.apiFailure, (key) => globalThis.getMessage(key, 'en'));
    assert.ok(text.startsWith(globalThis.getMessage('apiErrorUnavailable', 'en')), text);
    assert.ok(!text.includes('120'), 'no "wait 120 s" for a server failure');
  });
});

test('retry: a caller abort during the wait stops at once, with no further request', async () => {
  await withFetch(fail(503), async (calls) => {
    const controller = new AbortController();
    const started = Date.now();
    // 默认时钟真等 1 秒；10 毫秒后取消。
    const pending = callModel(profile(), request, { signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    const error = await pending.then(() => assert.fail('should abort'), (err) => err);
    assert.equal(error.aborted, true, 'ABORT-IN-WAIT is err.aborted');
    assert.equal(error.apiFailure, undefined);
    assert.ok(Date.now() - started < 500, 'the wait was cut short');
    assert.equal(calls.length, 1);
  });
  assert.deepEqual(keepaliveState(), { holders: 0, running: false });
});

test('retry: the keepalive is held once across attempts and waits', async () => {
  const seen = [];
  await withFetch(sequence(fail(500), () => chat('ok')), async () => {
    const clock = fakeClock();
    const sleep = clock.sleep;
    clock.sleep = async (ms, signal) => {
      seen.push(keepaliveState());
      return sleep(ms, signal);
    };
    await callModel(profile(), request, { clock });
  });
  assert.deepEqual(seen, [{ holders: 1, running: true }]);
  assert.deepEqual(keepaliveState(), { holders: 0, running: false });
});

test('retry: retry:false tries once', async () => {
  await withFetch(fail(503), async (calls) => {
    const error = await callModel(profile(), request, { retry: false, clock: fakeClock() })
      .then(() => assert.fail('x'), (err) => err);
    assert.equal(calls.length, 1);
    assert.equal(error.attempts, 1);
  });
});

test('retry: replyError logs once, with how many attempts were made', async () => {
  const saved = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args);
  try {
    await withFetch(fail(503), async () => {
      const error = await callModel(profile(), request, { clock: fakeClock() }).then(() => assert.fail('x'), (err) => err);
      const reply = replyError('TRANSLATE', error, { settings: {}, profile: profile(), feature: 'page' });
      assert.equal(typeof reply.error, 'string');
    });
  } finally {
    console.error = saved;
  }
  assert.equal(logged.length, 1, 'the attempts in between are not logged');
  assert.match(String(logged[0][0]), /^TRANSLATE failed after 3 attempts \(profile p1, feature page\)/);
});

test('limit: time spent queued for the profile does not count against the attempt timeout', async () => {
  const slow = profile({ id: 'queued-timeout', concurrency: 1, timeoutSec: 0.3 });
  await withFetch(() => new Promise((resolve) => setTimeout(() => resolve(chat('ok')), 200)), async (calls) => {
    const started = Date.now();
    const [a, b] = await Promise.all([callModel(slow, request), callModel(slow, request)]);
    assert.deepEqual([a, b], [{ text: 'ok' }, { text: 'ok' }]);
    assert.ok(Date.now() - started >= 380, 'the second waited for the first (concurrency 1)');
    assert.equal(calls.length, 2);
  });
});

// ------------------------------------------------------------ total budget (fix round 1, H)

const BUDGET_MS = globalThis.AIProfiles.LIMITS.timeoutMax * 1000;
const said = (failure) => globalThis.APICompat.describeAPIFailure(failure, (key) => globalThis.getMessage(key, 'en'));

test('budget: three timeouts stop at the budget; the attempt it cut short reports the seconds it really waited', async () => {
  await withFetch(() => 'hang', async (calls) => {
    // 100 + 1 + 100 + 2 = 203 秒，第三次只剩 37 秒。
    const clock = virtualClock();
    const error = await callModel(profile({ timeoutSec: 100 }), request, { clock }).then(() => assert.fail('x'), (err) => err);
    assert.equal(calls.length, 3);
    assert.equal(error.apiFailure.timeout, true);
    assert.equal(error.apiFailure.seconds, 37, 'BUDGET the third attempt is cut to what is left');
    assert.equal(clock.now(), BUDGET_MS, 'the whole call took the budget, not 303 s');
    assert.equal(said(error.apiFailure), globalThis.getMessage('apiErrorTimeout', 'en').replace('{seconds}', '37'));
  });
  await withFetch(() => 'hang', async (calls) => {
    // 120 + 1 = 121，第二次截到 119 秒；之后剩 0，不再发第三次。
    const clock = virtualClock();
    const error = await callModel(profile({ timeoutSec: 120 }), request, { clock }).then(() => assert.fail('x'), (err) => err);
    assert.equal(calls.length, 2, 'BUDGET no attempt is started without the minimum left');
    assert.equal(error.attempts, 2);
    assert.equal(error.apiFailure.seconds, 119);
    assert.ok(clock.now() <= BUDGET_MS);
  });
  assert.deepEqual(keepaliveState(), { holders: 0, running: false });
});

test('budget: time queued in the limiter counts, and the retries after it stay inside the budget', async () => {
  const clock = virtualClock();
  const limiter = createLimiter({ now: clock.now, setTimer: clock.setTimer });
  const queued = profile({ id: 'budget-queue', concurrency: 1, timeoutSec: 60 });
  const release = await limiter.acquire(queued);
  clock.setTimer(release, 150000);
  await withFetch(() => 'hang', async (calls) => {
    // 排队 150 秒，第一次 60 秒，退避 1 秒，第二次只剩 29 秒，然后停。
    const error = await callModel(queued, request, { clock, limiter }).then(() => assert.fail('x'), (err) => err);
    assert.equal(calls.length, 2);
    assert.equal(error.apiFailure.seconds, 29);
    assert.equal(clock.now(), BUDGET_MS);
  });
  assert.deepEqual(limiter.state('budget-queue'), { inFlight: 0, queued: 0, recent: 0 });
});

test('budget: a Retry-After that would run past the budget is not waited; the last failure is rethrown', async () => {
  await withFetch(sequence('hang', fail(429, { 'Retry-After': '50' }), () => chat('late')), async (calls) => {
    // 180 秒超时、退避 1 秒；181 秒时 429 叫等 50 秒，等完只剩 9 秒 < 15。
    const clock = virtualClock();
    const error = await callModel(profile({ timeoutSec: 180 }), request, { clock }).then(() => assert.fail('x'), (err) => err);
    assert.equal(calls.length, 2);
    assert.deepEqual(clock.waits, [1000]);
    assert.equal(error.apiFailure.status, 429);
    assert.equal(error.attempts, 2);
    assert.ok(clock.now() <= BUDGET_MS);
  });
  await withFetch(sequence(fail(429, { 'Retry-After': '60' }), fail(503, { 'Retry-After': '60' }), () => chat('ok')),
    async () => {
      const clock = virtualClock();
      assert.deepEqual(await callModel(profile(), request, { clock }), { text: 'ok' });
      assert.deepEqual(clock.waits, [60000, 60000], 'waits that fit are still waited');
    });
});

test('budget: queued until the budget runs out rejects as a timeout, leaves the queue and holds no slot', async () => {
  const clock = virtualClock();
  const limiter = createLimiter({ now: clock.now, setTimer: clock.setTimer });
  const busy = profile({ id: 'budget-full', concurrency: 1 });
  const release = await limiter.acquire(busy);
  await withFetch(() => chat('never'), async (calls) => {
    const error = await callModel(busy, request, { clock, limiter }).then(() => assert.fail('x'), (err) => err);
    assert.equal(calls.length, 0);
    assert.equal(error.aborted, undefined);
    assert.equal(error.apiFailure.timeout, true);
    assert.equal(error.apiFailure.seconds, 225, 'seconds actually queued (budget minus one minimal attempt)');
    assert.equal(said(error.apiFailure), globalThis.getMessage('apiErrorTimeout', 'en').replace('{seconds}', '225'));
    assert.deepEqual(limiter.state('budget-full'), { inFlight: 1, queued: 0, recent: 0 }, 'only the holder');
    release();
    assert.deepEqual(limiter.state('budget-full'), { inFlight: 0, queued: 0, recent: 0 }, 'no slot leaked');
    assert.deepEqual(await callModel(busy, request, { clock, limiter }), { text: 'never' });
  });
  // 排队中调用方取消：仍是 err.aborted，不是超时。
  const hold = await limiter.acquire(busy);
  const controller = new AbortController();
  clock.setTimer(() => controller.abort(), 10000);
  const error = await callModel(busy, request, { clock, limiter, signal: controller.signal })
    .then(() => assert.fail('x'), (err) => err);
  assert.equal(error.aborted, true);
  assert.equal(error.apiFailure, undefined);
  hold();
  assert.deepEqual(limiter.state('budget-full'), { inFlight: 0, queued: 0, recent: 0 });
  assert.deepEqual(keepaliveState(), { holders: 0, running: false });
});

test('budget: retry:false, limit:false (AI_PROFILE_TEST) is held to the budget too', async () => {
  await withFetch(() => 'hang', async (calls) => {
    const clock = virtualClock();
    const error = await callModel(profile({ timeoutSec: 300 }), request, { retry: false, limit: false, clock })
      .then(() => assert.fail('x'), (err) => err);
    assert.equal(calls.length, 1);
    assert.equal(error.apiFailure.seconds, 240);
    assert.equal(clock.now(), BUDGET_MS);
  });
});

// ------------------------------------------------------------ keepalive

async function withTimers(run) {
  const savedSet = globalThis.setInterval;
  const savedClear = globalThis.clearInterval;
  const started = [];
  const cleared = [];
  globalThis.setInterval = (fn, ms) => {
    const handle = { fn, ms };
    started.push(handle);
    return handle;
  };
  globalThis.clearInterval = (handle) => cleared.push(handle);
  try {
    return await run({ started, cleared });
  } finally {
    globalThis.setInterval = savedSet;
    globalThis.clearInterval = savedClear;
  }
}

test('keepalive: 0 -> 1 starts one timer, overlapping holders share it, back to 0 clears it', async () => {
  await withTimers(async ({ started, cleared }) => {
    acquire();
    assert.equal(started.length, 1);
    assert.equal(started[0].ms, PING_MS);
    acquire();
    acquire();
    assert.equal(started.length, 1, 'overlapping requests share one timer');
    assert.deepEqual(keepaliveState(), { holders: 3, running: true });
    release();
    release();
    assert.equal(cleared.length, 0);
    release();
    assert.deepEqual(cleared, [started[0]]);
    assert.deepEqual(keepaliveState(), { holders: 0, running: false });

    acquire();
    assert.equal(started.length, 2, 'a new 0 -> 1 starts a fresh timer');
    release();
  });
});

test('keepalive: the ping asks an extension API and a failed ping is only a warning', async () => {
  await withTimers(async ({ started }) => {
    let asked = 0;
    const saved = globalThis.chrome.runtime.getPlatformInfo;
    const warnings = [];
    const savedWarn = console.warn;
    console.warn = (...args) => warnings.push(args);
    try {
      globalThis.chrome.runtime.getPlatformInfo = async () => {
        asked += 1;
        throw new Error('context gone');
      };
      acquire();
      started[0].fn();
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(asked, 1);
      assert.equal(warnings.length, 1);
      release();
    } finally {
      globalThis.chrome.runtime.getPlatformInfo = saved;
      console.warn = savedWarn;
    }
  });
});

test('keepalive: release without acquire throws', () => {
  assert.throws(() => release(), /without acquire/);
});
