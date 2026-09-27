// 一条一个 sync 键的集合（shared/sync-collection.js）。
//
// 用户站点规则和 P1-C 的词表都建在它上面：读、写、缓存、增量只有这一份。这一组
// 逐个测它交出去的成员，外加一道防抄写扫描 —— 建在它上面的模块里再出现
// onChanged、get(null) 或去抖计时器，就是第二份实现回来了。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

await import('../../shared/lang-tags.js');
await import('../../shared/site-rules-builtin.js');
await import('../../shared/storage-writer.js');
await import('../../shared/site-rules.js');
await import('../../shared/sync-collection.js');
const { SyncCollection, StorageWriter, SiteRules } = globalThis;

const SHARED = fileURLToPath(new URL('../../shared/', import.meta.url));
const readShared = (name) => readFileSync(`${SHARED}${name}`, 'utf8');

const PREFIX = 'note:';
// 存储值里带的 id 原样带出来（真实的解码器不带，可集合不能靠这一点）：下面凡是
// 值里写了 `id: 'forged'` 的用例，都在钉「条目的 id 以键上的为准」。
const decode = (value) => (value && value.v === 1 && typeof value.text === 'string'
  ? Object.assign(
    { v: 1, text: value.text, hosts: Array.isArray(value.hosts) ? value.hosts : [] },
    'id' in value ? { id: value.id } : {},
  )
  : null);

function makeCollection(over = {}) {
  return SyncCollection.create(Object.assign({
    prefix: PREFIX,
    decode,
    hosts: (entry) => entry.hosts,
    limits: { itemBytes: 200, totalBytes: 400, maxItems: 3 },
    errors: { tooLarge: 'noteTooLarge', budgetFull: 'notesBudgetFull' },
  }, over));
}

// 一个够用的 chrome.storage.sync：记下每次 get / set / remove。
function fakeSync(initial = {}) {
  const data = Object.assign({}, initial);
  const calls = { get: 0, set: [], remove: [] };
  return {
    data,
    calls,
    area: {
      get: async (keys) => {
        assert.equal(keys, null);
        calls.get += 1;
        return JSON.parse(JSON.stringify(data));
      },
      set: async (items) => {
        calls.set.push(items);
        Object.assign(data, JSON.parse(JSON.stringify(items)));
      },
      remove: async (keys) => {
        calls.remove.push(keys);
        for (const key of keys) delete data[key];
      },
    },
  };
}

function withChrome(chrome, run) {
  const saved = globalThis.chrome;
  globalThis.chrome = chrome;
  return Promise.resolve().then(run).finally(() => {
    globalThis.chrome = saved;
  });
}

function captureConsole(method) {
  const calls = [];
  const saved = console[method];
  console[method] = (...args) => calls.push(args);
  return { calls, restore: () => { console[method] = saved; } };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

// ------------------------------------------------------------ 纯函数

test('sync-collection: newId is 8 base36 characters and does not repeat', () => {
  const c = makeCollection();
  const ids = new Set(Array.from({ length: 200 }, () => c.newId()));
  assert.equal(ids.size, 200);
  for (const id of ids) assert.match(id, /^[0-9a-z]{8}$/);
  assert.equal(c.prefix, PREFIX);
});

test('sync-collection: collect filters by prefix, takes the id from the key, skips bad entries with one log', () => {
  const c = makeCollection();
  const warn = captureConsole('warn');
  let entries;
  try {
    entries = c.collect({
      'note:aaa11111': { v: 1, text: 'one', id: 'forged' },
      'note:bbb22222': { v: 2, text: 'from a newer version' },
      'note:ccc33333': 'garbage',
      'note:BAD KEY': { v: 1, text: 'key is not an id' },
      siteRules: { 'example.com': 'always' },
      targetLang: 'zh-CN',
    });
  } finally {
    warn.restore();
  }
  assert.deepEqual(entries, [{ v: 1, text: 'one', hosts: [], id: 'aaa11111' }]);
  assert.equal(warn.calls.length, 1, '一次 collect 最多一条日志');
  assert.match(warn.calls[0][0], /skipped 3/);
  // 日志只写数目，不带条目内容：那是用户数据。
  assert.doesNotMatch(warn.calls.flat().join(' '), /newer version|garbage/);
});

test('sync-collection: forHost keeps entries for every host and suffix matches only', () => {
  const c = makeCollection();
  const entries = [
    { id: 'a', hosts: [] },
    { id: 'b', hosts: ['example.com'] },
    { id: 'c', hosts: ['docs.example.com'] },
    { id: 'd', hosts: ['other.org', 'example.com'] },
  ];
  assert.deepEqual(c.forHost(entries, 'www.example.com').map((e) => e.id), ['a', 'b', 'd']);
  assert.deepEqual(c.forHost(entries, 'docs.example.com').map((e) => e.id), ['a', 'b', 'c', 'd']);
  assert.deepEqual(c.forHost(entries, 'notexample.com').map((e) => e.id), ['a']);
});

test('sync-collection: applyChanges adds, replaces and deletes without touching its input', () => {
  const c = makeCollection();
  const before = [
    { v: 1, text: 'old', hosts: [], id: 'aaa' },
    { v: 1, text: 'gone', hosts: [], id: 'bbb' },
  ];
  const frozen = JSON.stringify(before);
  const after = c.applyChanges(before, {
    'note:aaa': { oldValue: { v: 1, text: 'old' }, newValue: { v: 1, text: 'new', id: 'forged' } },
    'note:bbb': { oldValue: { v: 1, text: 'gone' } },
    'note:ccc': { newValue: { v: 1, text: 'added', hosts: ['example.com'] } },
    'note:ddd': { newValue: { v: 1, text: 'elsewhere', hosts: ['other.org'] } },
    targetLang: { newValue: 'ja' },
  }, 'example.com');
  assert.equal(JSON.stringify(before), frozen);
  assert.deepEqual(after, [
    { v: 1, text: 'new', hosts: [], id: 'aaa' },
    { v: 1, text: 'added', hosts: ['example.com'], id: 'ccc' },
  ]);
  // host 为 null：设置页看全部。
  const all = c.applyChanges([], { 'note:ddd': { newValue: { v: 1, text: 'x', hosts: ['other.org'] } } }, null);
  assert.deepEqual(all.map((e) => e.id), ['ddd']);
  // 新值读不懂：旧的那条也不能留着冒充。
  const warn = captureConsole('warn');
  try {
    assert.deepEqual(c.applyChanges(after, { 'note:aaa': { newValue: { v: 9 } } }, null).map((e) => e.id), ['ccc']);
  } finally {
    warn.restore();
  }
  assert.equal(warn.calls.length, 1);
});

test('sync-collection: usage counts the key name plus the stored value without id', () => {
  const c = makeCollection();
  const entry = { v: 1, text: '中文', hosts: [], id: 'abc12345' };
  const expected = 'note:abc12345'.length + StorageWriter.itemBytes({ v: 1, text: '中文', hosts: [] });
  assert.deepEqual(c.usage([entry]), { bytes: expected, count: 1 });
  assert.deepEqual(c.usage([]), { bytes: 0, count: 0 });
});

test('sync-collection: assertFits checks one item, the total and the count', () => {
  const c = makeCollection();
  const small = (id) => ({ v: 1, text: 'x', hosts: [], id });
  assert.doesNotThrow(() => c.assertFits([small('a'), small('b'), small('c')]));
  assert.throws(() => c.assertFits([{ v: 1, text: 'x'.repeat(300), hosts: [], id: 'a' }]), { message: 'noteTooLarge' });
  assert.throws(() => c.assertFits([small('a'), small('b'), small('c'), small('d')]), { message: 'notesBudgetFull' });
  const mid = (id) => ({ v: 1, text: 'y'.repeat(150), hosts: [], id });
  assert.throws(() => c.assertFits([mid('a'), mid('b'), mid('c')]), { message: 'notesBudgetFull' });
});

test('sync-collection: merge replaces by key keeping the old id, and gives new entries an id', () => {
  const c = makeCollection();
  const existing = [{ v: 1, text: 'hello', hosts: [], id: 'old00001' }];
  const byText = (entry) => entry.text;
  const { entries, added, replaced } = c.merge(existing, [
    { v: 1, text: 'hello', hosts: ['example.com'], id: 'incoming' },
    { v: 1, text: 'fresh', hosts: [] },
    { v: 1, text: 'kept', hosts: [], id: 'keep0001' },
  ], byText);
  assert.equal(added, 2);
  assert.equal(replaced, 1);
  assert.deepEqual(entries[0], { v: 1, text: 'hello', hosts: ['example.com'], id: 'old00001' });
  assert.match(entries[1].id, /^[0-9a-z]{8}$/);
  assert.equal(entries[2].id, 'keep0001');
  assert.equal(existing.length, 1, 'merge 不改传入的数组');
});

// ------------------------------------------------------------ write / cached

test('sync-collection: write stores values without id in one set plus one remove, and returns the result', async () => {
  const c = makeCollection();
  const store = fakeSync({
    'note:aaa': { v: 1, text: 'keep' },
    'note:bbb': { v: 1, text: 'drop' },
    other: 1,
  });
  await withChrome({ storage: { sync: store.area } }, async () => {
    const result = await c.write((entries) => {
      assert.deepEqual(entries.map((e) => e.id), ['aaa', 'bbb']);
      return {
        put: [{ v: 1, text: 'one', hosts: [], id: 'ccc' }, { v: 1, text: 'two', hosts: [], id: 'aaa' }],
        remove: ['bbb'],
        result: { id: 'ccc' },
      };
    });
    assert.deepEqual(result, { id: 'ccc' });
  });
  assert.equal(store.calls.set.length, 1, '一次多键 set 算一次写');
  assert.deepEqual(store.calls.set[0], {
    'note:ccc': { v: 1, text: 'one', hosts: [] },
    'note:aaa': { v: 1, text: 'two', hosts: [] },
  });
  assert.deepEqual(store.calls.remove, [['note:bbb']]);
  assert.equal(store.data.other, 1);
});

test('sync-collection: a write over quota throws the assertFits key and writes nothing', async () => {
  const c = makeCollection();
  const store = fakeSync({ 'note:aaa': { v: 1, text: 'x' }, 'note:bbb': { v: 1, text: 'x' }, 'note:ccc': { v: 1, text: 'x' } });
  await withChrome({ storage: { sync: store.area } }, async () => {
    await assert.rejects(
      c.write(() => ({ put: [{ v: 1, text: 'x', hosts: [], id: 'ddd' }] })),
      { message: 'notesBudgetFull' },
    );
    await assert.rejects(
      c.write(() => ({ put: [{ v: 1, text: 'x'.repeat(300), hosts: [], id: 'aaa' }] })),
      { message: 'noteTooLarge' },
    );
    // 删一条腾位置的同一次写，额度按写后的集合算。
    await c.write(() => ({ put: [{ v: 1, text: 'x', hosts: [], id: 'ddd' }], remove: ['aaa'] }));
    await assert.rejects(c.write(() => ({ put: [{ v: 1, text: 'x', hosts: [], id: 'NOT AN ID' }] })), /bad id/);
  });
  assert.equal(store.calls.set.length, 1);
  assert.deepEqual(Object.keys(store.data).sort(), ['note:bbb', 'note:ccc', 'note:ddd']);
});

test('sync-collection: cached remembers one get(null) and a write drops it', async () => {
  const c = makeCollection();
  const store = fakeSync({ 'note:aaa': { v: 1, text: 'one' } });
  await withChrome({ storage: { sync: store.area } }, async () => {
    const first = await c.cached();
    assert.equal(await c.cached(), first);
    assert.equal(store.calls.get, 1);
    await c.write(() => ({ put: [{ v: 1, text: 'two', hosts: [], id: 'bbb' }] }));
    assert.deepEqual((await c.cached()).map((e) => e.id), ['aaa', 'bbb']);
  });
});

// 在「服务工作者」里重新求值一遍：IN_SERVICE_WORKER 在 storage-writer 装载时就
// 定下来了，模块缓存不认查询串，只能拿源码另起一份。
function loadInWorker(chrome) {
  class FakeWorkerScope {}
  const scope = new FakeWorkerScope();
  scope.chrome = chrome;
  scope.SiteRules = SiteRules;
  for (const name of ['storage-writer.js', 'sync-collection.js']) {
    new Function('globalThis', 'ServiceWorkerGlobalScope', readShared(name))(scope, FakeWorkerScope);
  }
  assert.equal(scope.StorageWriter.IN_SERVICE_WORKER, true);
  return scope.SyncCollection;
}

test('sync-collection: in the worker a prefix hit on storage.onChanged drops the cache, other keys do not', async () => {
  const store = fakeSync({ 'note:aaa': { v: 1, text: 'one' } });
  const listeners = [];
  const chrome = { storage: { sync: store.area, onChanged: { addListener: (fn) => listeners.push(fn) } } };
  const c = loadInWorker(chrome).create({
    prefix: PREFIX, decode, hosts: (e) => e.hosts,
    limits: { itemBytes: 200, totalBytes: 400, maxItems: 3 },
    errors: { tooLarge: 'a', budgetFull: 'b' },
  });
  assert.equal(listeners.length, 1);
  await c.cached();
  listeners[0]({ targetLang: { newValue: 'ja' } }, 'sync');
  listeners[0]({ 'note:zzz': { newValue: { v: 1, text: 'z' } } }, 'local');
  await c.cached();
  assert.equal(store.calls.get, 1);
  listeners[0]({ 'note:zzz': { newValue: { v: 1, text: 'z' } } }, 'sync');
  await c.cached();
  assert.equal(store.calls.get, 2);
});

test('sync-collection: outside the worker create hangs no storage listener', () => {
  const listeners = [];
  const saved = globalThis.chrome;
  globalThis.chrome = { storage: { onChanged: { addListener: (fn) => listeners.push(fn) } } };
  try {
    makeCollection();
  } finally {
    globalThis.chrome = saved;
  }
  assert.equal(listeners.length, 0);
});

// ------------------------------------------------------------ mirror

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('sync-collection mirror: one request, deltas in flight are buffered in order and applied to the reply', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const c = makeCollection();
  const reply = deferred();
  let requests = 0;
  const m = c.mirror({ request: () => { requests += 1; return reply.promise; }, host: 'example.com' });
  let notified = 0;
  m.subscribe(() => { notified += 1; });
  m.onStorageChange({ 'note:bbb': { newValue: { v: 1, text: 'first' } } });
  m.onStorageChange({ 'note:bbb': { newValue: { v: 1, text: 'second' } } });
  m.onStorageChange({ 'note:aaa': { oldValue: { v: 1, text: 'a' } } });
  let ready = false;
  m.whenReady().then(() => { ready = true; });
  await tick();
  assert.equal(ready, false);
  reply.resolve([{ v: 1, text: 'a', hosts: [], id: 'aaa' }]);
  await tick();
  assert.equal(ready, true);
  assert.equal(requests, 1, '每个文档只请求一次');
  assert.deepEqual(m.entries(), [{ v: 1, text: 'second', hosts: [], id: 'bbb' }]);
  assert.equal(m.version, 1);
  assert.equal(notified, 1);
});

test('sync-collection mirror: later deltas are debounced 150 ms, then one version bump and one notice', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const c = makeCollection();
  const m = c.mirror({ request: async () => [], host: 'example.com' });
  await m.whenReady();
  await tick();
  const start = m.version;
  let notified = 0;
  const unsubscribe = m.subscribe(() => { notified += 1; });
  m.onStorageChange({ 'note:aaa': { newValue: { v: 1, text: 'a' } } });
  t.mock.timers.tick(100);
  m.onStorageChange({ 'note:bbb': { newValue: { v: 1, text: 'b', hosts: ['other.org'] } } });
  t.mock.timers.tick(149);
  assert.equal(m.version, start);
  assert.deepEqual(m.entries(), [], '去抖之前条目不动：version 和 entries 一起变');
  t.mock.timers.tick(1);
  assert.equal(m.version, start + 1);
  assert.equal(notified, 1);
  assert.deepEqual(m.entries().map((e) => e.id), ['aaa'], '别的主机的条目不进镜像');
  unsubscribe();
  m.onStorageChange({ 'note:aaa': { oldValue: { v: 1, text: 'a' } } });
  t.mock.timers.tick(150);
  assert.equal(notified, 1);
  assert.deepEqual(m.entries(), []);
});

test('sync-collection mirror: whenReady gives up after 1500 ms as empty, and a late reply still lands', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const c = makeCollection();
  const reply = deferred();
  const m = c.mirror({ request: () => reply.promise, host: 'example.com' });
  let ready = false;
  m.whenReady().then(() => { ready = true; });
  t.mock.timers.tick(1499);
  await tick();
  assert.equal(ready, false);
  t.mock.timers.tick(1);
  await tick();
  assert.equal(ready, true);
  assert.deepEqual(m.entries(), []);
  let notified = 0;
  m.subscribe(() => { notified += 1; });
  reply.resolve([{ v: 1, text: 'late', hosts: [], id: 'aaa' }]);
  await tick();
  assert.deepEqual(m.entries().map((e) => e.id), ['aaa']);
  assert.equal(notified, 1);
});

test('sync-collection mirror: a failed request is logged once and counts as empty', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const c = makeCollection();
  const warn = captureConsole('warn');
  const boom = new Error('receiving end does not exist');
  try {
    const m = c.mirror({ request: async () => { throw boom; }, host: 'example.com' });
    await m.whenReady();
    assert.deepEqual(m.entries(), []);
  } finally {
    warn.restore();
  }
  assert.equal(warn.calls.length, 1);
  assert.equal(warn.calls[0][1], boom);
});

// ------------------------------------------------------------ 守卫

// 注释里会提到这些名字；只看代码。
const stripComments = (text) => text
  .replace(/^[ \t]*\/\/.*$/gm, '')
  .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '');

test('sync-collection: loading without StorageWriter or SiteRules throws', () => {
  const source = readShared('sync-collection.js');
  assert.throws(() => new Function('globalThis', source)({ SiteRules }), /storage-writer/);
  assert.throws(() => new Function('globalThis', source)({ StorageWriter }), /site-rules/);
});

test('sync-collection: the module never reads location — the host is always passed in', () => {
  assert.doesNotMatch(stripComments(readShared('sync-collection.js')), /\blocation\b/);
});

test('sync-collection: modules built on it hold no storage listener, get(null) or debounce timer of their own', () => {
  const own = stripComments(readShared('sync-collection.js'));
  // 先确认扫描的三样东西确实在 sync-collection 里：扫描本身不能是空转。
  assert.match(own, /storage\.onChanged/);
  assert.match(own, /\.get\(null\)/);
  assert.match(own, /setTimeout\(/);
  const builtOn = readdirSync(SHARED)
    .filter((name) => name.endsWith('.js') && name !== 'sync-collection.js')
    .filter((name) => /SyncCollection\.create\(/.test(readShared(name)));
  assert.ok(builtOn.includes('custom-rules.js'), `建在集合上的模块：${builtOn.join(', ')}`);
  for (const name of builtOn) {
    const code = stripComments(readShared(name));
    assert.doesNotMatch(code, /onChanged/, `${name} 自己挂了 storage 监听`);
    assert.doesNotMatch(code, /\.get\(\s*null\s*\)/, `${name} 自己 get(null)`);
    assert.doesNotMatch(code, /setTimeout\(|clearTimeout\(/, `${name} 自己去抖`);
  }
});
