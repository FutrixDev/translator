// 本机统计。四个计数、一个月一清、写入收在服务工作者里。
//
// 上半段是纯函数，直接跑。下半段要一个假的 chrome.storage.local —— 那正是这个
// 模块最容易错的地方：每个标签页都在往里记，读—改—写撞车丢的是用户看得见的数字。
import test from 'node:test';
import assert from 'node:assert/strict';

await import('../../shared/auto-stats.js');
const { AutoStats } = globalThis;

test('月份按本地时区，不是 UTC', () => {
  // 用户看的是自己墙上那本日历。'2026-01-01T00:30:00' 不带 Z，就是本地时间。
  assert.equal(AutoStats.currentMonth(new Date('2026-01-01T00:30:00')), '2026-01');
  assert.equal(AutoStats.currentMonth(new Date('2026-09-20T12:00:00')), '2026-09');
  // 个位数月份补零，否则 '2026-9' 和 '2026-09' 会被当成两个月。
  assert.equal(AutoStats.currentMonth(new Date('2026-03-05T12:00:00')), '2026-03');
});

test('mergeDelta 只加，跨月整份丢掉', () => {
  const first = AutoStats.mergeDelta(null, { pages: 1, aiChars: 200 }, '2026-09');
  assert.deepEqual(first, { month: '2026-09', pages: 1, aiChars: 200, cacheHits: 0, cacheMisses: 0 });

  const second = AutoStats.mergeDelta(first, { pages: 2, cacheHits: 5 }, '2026-09');
  assert.deepEqual(second, { month: '2026-09', pages: 3, aiChars: 200, cacheHits: 5, cacheMisses: 0 });

  // 新的月份：上个月那份不是「基数」，是别人的账。
  const october = AutoStats.mergeDelta(second, { pages: 1 }, '2026-10');
  assert.deepEqual(october, { month: '2026-10', pages: 1, aiChars: 0, cacheHits: 0, cacheMisses: 0 });
});

test('不是正数的值一律当零 —— 一个 NaN 不该毁掉一整个月', () => {
  const poisoned = { month: '2026-09', pages: NaN, aiChars: '900', cacheHits: -3, cacheMisses: Infinity };
  const fixed = AutoStats.mergeDelta(poisoned, { pages: 1.7 }, '2026-09');
  assert.deepEqual(fixed, { month: '2026-09', pages: 1, aiChars: 0, cacheHits: 0, cacheMisses: 0 });
});

test('空增量就是「读出来该显示的样子」', () => {
  // read() 就是这么用它的：归一化和累加是同一个函数，两者不会走偏。
  const stored = { month: '2026-09', pages: 4, aiChars: 10, cacheHits: 1, cacheMisses: 1 };
  assert.deepEqual(AutoStats.mergeDelta(stored, null, '2026-09'), stored);
  assert.deepEqual(AutoStats.mergeDelta(stored, null, '2026-10'),
    { month: '2026-10', pages: 0, aiChars: 0, cacheHits: 0, cacheMisses: 0 });
});

test('textsChars 数的是源文本，不是请求体', () => {
  assert.equal(AutoStats.textsChars(['ab', 'cde']), 5);
  // 一批里的空洞不该让整批的账算不出来。
  assert.equal(AutoStats.textsChars([null, 'ok']), 2);
  assert.equal(AutoStats.textsChars([]), 0);
  // 不是数组就是 0，而不是 NaN —— 一个坏掉的调用不该把这个月的计数毁掉。
  assert.equal(AutoStats.textsChars('nope'), 0);
  assert.equal(AutoStats.textsChars(undefined), 0);
});

test('一次都没量过的命中率是 null，不是 0', () => {
  // 「还没有数据」和「一次都没命中」是两句不同的话，把前者画成 0% 是在冤枉缓存。
  assert.equal(AutoStats.cacheHitRate(null), null);
  assert.equal(AutoStats.cacheHitRate({ cacheHits: 0, cacheMisses: 0 }), null);
  assert.equal(AutoStats.cacheHitRate({ cacheHits: 3, cacheMisses: 1 }), 0.75);
  assert.equal(AutoStats.cacheHitRate({ cacheHits: 0, cacheMisses: 4 }), 0);
});

// ---------------------------------------------------------------- 存储

/** chrome.storage.local 的最小替身：get 认默认值，set 整份覆盖。 */
function fakeStorage(initial) {
  const cell = { autoStats: initial === undefined ? null : initial };
  return {
    calls: cell,
    storage: {
      local: {
        async get(defaults) {
          const key = Object.keys(defaults)[0];
          return { [key]: cell[key] === undefined ? defaults[key] : cell[key] };
        },
        async set(values) {
          Object.assign(cell, values);
        }
      }
    }
  };
}

test('read 读不到存储也给一份空的，而不是让设置页整页报错', async () => {
  const saved = globalThis.chrome;
  globalThis.chrome = undefined;
  try {
    const stats = await AutoStats.read(new Date('2026-09-20T12:00:00'));
    assert.deepEqual(stats, AutoStats.emptyStats('2026-09'));
  } finally {
    globalThis.chrome = saved;
  }
});

test('read 把上个月那份归一化成这个月的空表', async () => {
  const saved = globalThis.chrome;
  globalThis.chrome = fakeStorage({ month: '2026-08', pages: 99, aiChars: 1, cacheHits: 1, cacheMisses: 1 });
  try {
    const stats = await AutoStats.read(new Date('2026-09-20T12:00:00'));
    assert.deepEqual(stats, AutoStats.emptyStats('2026-09'));
  } finally {
    globalThis.chrome = saved;
  }
});

test('applyWrite 认得 add 和 reset，别的一律拒绝', async () => {
  const saved = globalThis.chrome;
  const store = fakeStorage(null);
  globalThis.chrome = store;
  try {
    const month = AutoStats.currentMonth();
    await AutoStats.applyWrite({ kind: 'add', delta: { pages: 1, aiChars: 30 } });
    await AutoStats.applyWrite({ kind: 'add', delta: { cacheHits: 2, cacheMisses: 1 } });
    assert.deepEqual(store.calls.autoStats,
      { month, pages: 1, aiChars: 30, cacheHits: 2, cacheMisses: 1 });

    await AutoStats.applyWrite({ kind: 'reset' });
    assert.deepEqual(store.calls.autoStats, AutoStats.emptyStats(month));

    await assert.rejects(() => AutoStats.applyWrite({ kind: 'nonsense' }), /unknown auto-stats write/);
    await assert.rejects(() => AutoStats.applyWrite(null), /unknown auto-stats write/);
  } finally {
    globalThis.chrome = saved;
  }
});

test('并发的写按顺序排队，一笔都不会被盖掉', async () => {
  // 这是这个模块存在的理由：每个标签页都在记，而且记得很密。不排队的话两笔
  // 同时读到同一份旧数字，后写的那份把先写的盖掉 —— 悄无声息，越忙丢得越多。
  const saved = globalThis.chrome;
  const store = fakeStorage(null);
  globalThis.chrome = store;
  try {
    const month = AutoStats.currentMonth();
    await Promise.all(Array.from({ length: 20 },
      () => AutoStats.applyWrite({ kind: 'add', delta: { pages: 1 } })));
    assert.equal(store.calls.autoStats.pages, 20);
    assert.equal(store.calls.autoStats.month, month);
  } finally {
    globalThis.chrome = saved;
  }
});

test('一次写崩了，后面的照跑', async () => {
  // 队列只保证顺序，不传播失败（同 shared/site-rules.js）。
  const saved = globalThis.chrome;
  const store = fakeStorage(null);
  let failNext = true;
  const realSet = store.storage.local.set.bind(store.storage.local);
  store.storage.local.set = async (values) => {
    if (failNext) {
      failNext = false;
      throw new Error('quota');
    }
    return realSet(values);
  };
  globalThis.chrome = store;
  try {
    await assert.rejects(() => AutoStats.applyWrite({ kind: 'add', delta: { pages: 1 } }), /quota/);
    await AutoStats.applyWrite({ kind: 'add', delta: { pages: 1 } });
    assert.equal(store.calls.autoStats.pages, 1);
  } finally {
    globalThis.chrome = saved;
  }
});

test('不在服务工作者里就发消息，而且统计记不上不算错误', async () => {
  const saved = globalThis.chrome;
  const sent = [];
  globalThis.chrome = {
    runtime: {
      sendMessage: async (message) => {
        sent.push(message);
        if (message.kind === 'reset') throw new Error('receiving end does not exist');
        return { value: { month: '2026-09', pages: 1, aiChars: 0, cacheHits: 0, cacheMisses: 0 } };
      }
    }
  };
  try {
    const added = await AutoStats.add({ pages: 1 });
    assert.deepEqual(sent[0], { type: 'AUTO_STATS_WRITE', kind: 'add', delta: { pages: 1 } });
    assert.equal(added.pages, 1);

    // 页面卸载、扩展刚更新完的那一瞬，sendMessage 本来就会抛。调用方正在做的是
    // 翻译，不是记账 —— 这里吞掉，返回 null。
    assert.equal(await AutoStats.reset(), null);
    assert.deepEqual(sent[1], { type: 'AUTO_STATS_WRITE', kind: 'reset' });
  } finally {
    globalThis.chrome = saved;
  }
});

test('连 chrome.runtime 都没有时也不抛', async () => {
  const saved = globalThis.chrome;
  globalThis.chrome = {};
  try {
    assert.equal(await AutoStats.add({ pages: 1 }), null);
  } finally {
    globalThis.chrome = saved;
  }
});
