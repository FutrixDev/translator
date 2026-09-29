// 模型请求的唯一出口（background/model-client.js 的 callModel）、在途保活
// （background/keepalive.js）和失败的唯一接住点（background/api-errors.js 的
// replyError），P1-D 设计 §3.6–§3.8。
//
// callModel 只在这里测 D1 的三件事：超时、空答案、调用方取消；网络错与服务商
// 错的形状顺带钉住。重试是 D2 的，流式是 D3 的。fetch 换成桩，桩认 signal：
// abort 时像真 fetch 一样以 AbortError 拒绝。
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.chrome = globalThis.chrome || {};
globalThis.chrome.runtime = globalThis.chrome.runtime || {};
globalThis.chrome.runtime.getPlatformInfo = async () => ({ os: 'mac' });

await import('../../shared/api-compat.js');
const { callModel } = await import('../../background/model-client.js');
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

const okJson = (data, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => data,
});
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
    const error = await callModel(profile({ timeoutSec: 0.05 }), request).then(
      () => assert.fail('should time out'), (err) => err);
    assert.ok(Date.now() - started < 2000, 'the timer, not the test runner, ended it');
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
    assert.equal(calls.length, 1);
  });
  assert.deepEqual(keepaliveState(), { holders: 0, running: false });
});

test('callModel: network and provider failures keep their structured shape', async () => {
  await withFetch(() => Promise.reject(new TypeError('Failed to fetch')), async () => {
    const error = await callModel(profile(), request).then(() => assert.fail('should throw'), (err) => err);
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
