// 同步存储的单写者（shared/storage-writer.js）。
//
// 站点规则、统计、自定义规则三家的「读—改—写」都排在服务工作者的一条队列里。
// 这段逻辑以前在前两家各抄了一份；这一组测的是那一份实现本身，外加一道守卫：
// 第二份队列回来了就红。
import test from 'node:test';
import assert from 'node:assert/strict';
import { sharedSource, workerSource } from './helpers/sources.mjs';

await import('../../shared/storage-writer.js');
const { StorageWriter } = globalThis;

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function withChrome(chrome, run) {
  const saved = globalThis.chrome;
  globalThis.chrome = chrome;
  return Promise.resolve().then(run).finally(() => {
    globalThis.chrome = saved;
  });
}

function captureWarn() {
  const calls = [];
  const saved = console.warn;
  console.warn = (...args) => calls.push(args);
  return { calls, restore: () => { console.warn = saved; } };
}

test('storage-writer: writes run one after another, in arrival order', async () => {
  const log = [];
  const writes = {
    slow: async (m) => { log.push(`start ${m.n}`); await tick(); await tick(); log.push(`end ${m.n}`); return m.n; },
  };
  const { applyWrite } = StorageWriter.create({ type: 'TEST_WRITE', writes, errors: 'throw' });
  const results = await Promise.all([1, 2, 3].map((n) => applyWrite({ kind: 'slow', n })));
  assert.deepEqual(results, [1, 2, 3]);
  assert.deepEqual(log, ['start 1', 'end 1', 'start 2', 'end 2', 'start 3', 'end 3']);
});

test('storage-writer: a failed write reaches its caller and does not block the next one', async () => {
  const writes = {
    boom: async () => { throw new Error('quota'); },
    ok: async () => 'fine',
  };
  const { applyWrite } = StorageWriter.create({ type: 'TEST_WRITE', writes, errors: 'throw' });
  const failed = applyWrite({ kind: 'boom' });
  const next = applyWrite({ kind: 'ok' });
  await assert.rejects(failed, /quota/);
  assert.equal(await next, 'fine');
});

test('storage-writer: each writer has its own queue', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const a = StorageWriter.create({ type: 'A_WRITE', writes: { hold: () => gate }, errors: 'throw' });
  const b = StorageWriter.create({ type: 'B_WRITE', writes: { go: async () => 'b' }, errors: 'throw' });
  const held = a.applyWrite({ kind: 'hold' });
  // A 卡着的时候 B 照样落地：一张表慢不该拖住另一张。
  assert.equal(await b.applyWrite({ kind: 'go' }), 'b');
  release('a');
  assert.equal(await held, 'a');
});

test('storage-writer: an unknown kind is refused with a label taken from the type', async () => {
  const site = StorageWriter.create({ type: 'SITE_RULES_WRITE', writes: {}, errors: 'throw' });
  await assert.rejects(site.applyWrite({ kind: 'nope' }), { message: 'unknown site-rules write: nope' });
  const stats = StorageWriter.create({ type: 'AUTO_STATS_WRITE', writes: {}, errors: 'swallow' });
  await assert.rejects(stats.applyWrite({ kind: 'x' }), { message: 'unknown auto-stats write: x' });
  const custom = StorageWriter.create({ type: 'CUSTOM_RULES_WRITE', writes: {}, errors: 'throw' });
  await assert.rejects(custom.applyWrite(null), { message: 'unknown custom-rules write: null' });
});

test('storage-writer: create refuses an unknown errors mode', () => {
  assert.throws(() => StorageWriter.create({ type: 'X_WRITE', writes: {}, errors: 'ignore' }), /errors mode/);
  assert.throws(() => StorageWriter.create({ type: 'X_WRITE', errors: 'throw' }), /needs type and writes/);
});

test("storage-writer 'throw': outside the worker the write is sent, and a reply error is thrown", async () => {
  const sent = [];
  const chrome = {
    runtime: {
      sendMessage: async (message) => {
        sent.push(message);
        if (message.kind === 'bad') return { error: 'customRuleTooLarge' };
        return { value: { id: 'abc' } };
      },
    },
  };
  const { request } = StorageWriter.create({ type: 'TEST_WRITE', writes: {}, errors: 'throw' });
  await withChrome(chrome, async () => {
    assert.deepEqual(await request('put', { rule: { v: 1 } }), { id: 'abc' });
    assert.deepEqual(sent[0], { type: 'TEST_WRITE', kind: 'put', rule: { v: 1 } });
    await assert.rejects(request('bad'), { message: 'customRuleTooLarge' });
  });
});

test("storage-writer 'throw': no extension runtime is an error, not a silent no-op", async () => {
  const { request } = StorageWriter.create({ type: 'TEST_WRITE', writes: {}, errors: 'throw' });
  await withChrome(undefined, async () => {
    await assert.rejects(request('put'), /TEST_WRITE: no extension runtime/);
  });
});

test("storage-writer 'swallow': no runtime gives null without a log", async () => {
  const { request } = StorageWriter.create({ type: 'TEST_WRITE', writes: {}, errors: 'swallow' });
  const warn = captureWarn();
  try {
    await withChrome(undefined, async () => {
      assert.equal(await request('add'), null);
    });
  } finally {
    warn.restore();
  }
  assert.equal(warn.calls.length, 0);
});

test("storage-writer 'swallow': a failure is logged once with the original error and becomes null", async () => {
  const boom = new Error('receiving end does not exist');
  const chrome = {
    runtime: {
      sendMessage: async (message) => {
        if (message.kind === 'reject') throw boom;
        if (message.kind === 'error') return { error: 'quota' };
        if (message.kind === 'empty') return undefined;
        return { value: { pages: 1 } };
      },
    },
  };
  const { request } = StorageWriter.create({ type: 'TEST_WRITE', writes: {}, errors: 'swallow' });
  const warn = captureWarn();
  try {
    await withChrome(chrome, async () => {
      assert.deepEqual(await request('add'), { pages: 1 });
      assert.equal(await request('empty'), null);
      assert.equal(warn.calls.length, 0);
      assert.equal(await request('reject'), null);
      assert.equal(warn.calls.length, 1);
      assert.match(warn.calls[0][0], /TEST_WRITE reject/);
      assert.equal(warn.calls[0][1], boom);
      assert.equal(await request('error'), null);
      assert.equal(warn.calls.length, 2);
      assert.equal(warn.calls[1][1].message, 'quota');
    });
  } finally {
    warn.restore();
  }
});

test('storage-writer: ITEM_BUDGET is 6 KB and itemBytes counts UTF-8 bytes of the JSON', () => {
  assert.equal(StorageWriter.ITEM_BUDGET, 6 * 1024);
  assert.equal(StorageWriter.itemBytes({ a: 1 }), '{"a":1}'.length);
  // 中文一个字三个字节：按字符数算会低估一半以上。
  assert.equal(StorageWriter.itemBytes('中'), 5);
  assert.equal(StorageWriter.IN_SERVICE_WORKER, false);
});

// 注释里会提到这些名字；只看代码。
const stripComments = (text) => text
  .replace(/^[ \t]*\/\/.*$/gm, '')
  .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '');

test('storage-writer: no second write queue in shared/ or background/', () => {
  const code = stripComments(`${sharedSource()}\n${workerSource()}`);
  assert.equal((code.match(/\bwriteQueue\b/g) || []).length, 0, 'writeQueue 是旧的手抄队列');
  assert.equal((code.match(/\benqueue\(/g) || []).length, 0, 'enqueue 是旧的手抄队列');
  assert.equal((code.match(/queue\.then\(/g) || []).length, 1, '排队只在 StorageWriter 的 applyWrite 里');
  assert.equal((code.match(/instanceof ServiceWorkerGlobalScope/g) || []).length, 1,
    '「我是不是服务工作者」只有 StorageWriter 回答');
  assert.equal((code.match(/\bMAX_ITEM_BYTES\b/g) || []).length, 0, '预算只有 ITEM_BUDGET 一个名字');
  assert.equal((code.match(/\bITEM_BUDGET\s*=/g) || []).length, 1, 'ITEM_BUDGET 只定义一次');
});
