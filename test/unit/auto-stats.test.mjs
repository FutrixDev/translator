// 本机统计。四个按月的计数 + 一个按天的预算读数，写入收在服务工作者里。
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

test('日期也按本地时区，个位数补零', () => {
  assert.equal(AutoStats.currentDay(new Date('2026-01-01T00:30:00')), '2026-01-01');
  assert.equal(AutoStats.currentDay(new Date('2026-09-20T23:59:00')), '2026-09-20');
  assert.equal(AutoStats.currentDay(new Date('2026-03-05T12:00:00')), '2026-03-05');
});

test('mergeDelta 只加，跨月整份丢掉', () => {
  const first = AutoStats.mergeDelta(null, { pages: 1, aiChars: 200 }, '2026-09', '2026-09-20');
  assert.deepEqual(first,
    { month: '2026-09', pages: 1, aiChars: 200, cacheHits: 0, cacheMisses: 0, day: '2026-09-20', autoAiChars: 0 });

  const second = AutoStats.mergeDelta(first, { pages: 2, cacheHits: 5 }, '2026-09', '2026-09-20');
  assert.deepEqual(second,
    { month: '2026-09', pages: 3, aiChars: 200, cacheHits: 5, cacheMisses: 0, day: '2026-09-20', autoAiChars: 0 });

  // 新的月份：上个月那份不是「基数」，是别人的账。
  const october = AutoStats.mergeDelta(second, { pages: 1 }, '2026-10', '2026-10-01');
  assert.deepEqual(october,
    { month: '2026-10', pages: 1, aiChars: 0, cacheHits: 0, cacheMisses: 0, day: '2026-10-01', autoAiChars: 0 });
});

test('两个窗口各清各的期 —— 跨日不跨月，和跨月不跨日', () => {
  // 一条记录跨日不跨月是每天都在发生的事；跨月的那一天则是跨月又跨日。共用
  // 一个 base 会让其中一半在该清零的时候没清，那时「本月已用」和闸门认的
  // 「今天已用」就是两笔互相矛盾的账。
  const monday = AutoStats.mergeDelta(null, { pages: 2, autoAiChars: 500 }, '2026-09', '2026-09-21');

  // 第二天：按月的照加，按天的从零开始。
  const tuesday = AutoStats.mergeDelta(monday, { pages: 1, autoAiChars: 40 }, '2026-09', '2026-09-22');
  assert.equal(tuesday.pages, 3);
  assert.equal(tuesday.autoAiChars, 40);

  // 同一天里追加：两边都加。
  const later = AutoStats.mergeDelta(tuesday, { autoAiChars: 10 }, '2026-09', '2026-09-22');
  assert.equal(later.autoAiChars, 50);
  assert.equal(later.pages, 3);
});

test('budgetExceeded：0 和负数是不限，比的是 >=', () => {
  // 设置页那个框留空、或者填 0，说的都是「别管我」——和 autoTranslateLangs
  // 空数组同一个约定。
  assert.equal(AutoStats.budgetExceeded({ autoAiChars: 999999 }, 0), false);
  assert.equal(AutoStats.budgetExceeded({ autoAiChars: 999999 }, -1), false);
  assert.equal(AutoStats.budgetExceeded({ autoAiChars: 999999 }, undefined), false);
  assert.equal(AutoStats.budgetExceeded({ autoAiChars: 999999 }, NaN), false);

  // 刚好填满就该停，而不是等下一批把它顶破。
  assert.equal(AutoStats.budgetExceeded({ autoAiChars: 99 }, 100), false);
  assert.equal(AutoStats.budgetExceeded({ autoAiChars: 100 }, 100), true);
  assert.equal(AutoStats.budgetExceeded({ autoAiChars: 101 }, 100), true);
  assert.equal(AutoStats.budgetExceeded(null, 100), false);
});

test('不是正数的值一律当零 —— 一个 NaN 不该毁掉一整个月', () => {
  const poisoned = {
    month: '2026-09', pages: NaN, aiChars: '900', cacheHits: -3, cacheMisses: Infinity,
    day: '2026-09-22', autoAiChars: NaN
  };
  const fixed = AutoStats.mergeDelta(poisoned, { pages: 1.7 }, '2026-09', '2026-09-22');
  assert.deepEqual(fixed,
    { month: '2026-09', pages: 1, aiChars: 0, cacheHits: 0, cacheMisses: 0, day: '2026-09-22', autoAiChars: 0 });
});

test('空增量就是「读出来该显示的样子」', () => {
  // read() 就是这么用它的：归一化和累加是同一个函数，两者不会走偏。
  const stored = {
    month: '2026-09', pages: 4, aiChars: 10, cacheHits: 1, cacheMisses: 1,
    day: '2026-09-22', autoAiChars: 7
  };
  assert.deepEqual(AutoStats.mergeDelta(stored, null, '2026-09', '2026-09-22'), stored);
  assert.deepEqual(AutoStats.mergeDelta(stored, null, '2026-10', '2026-10-01'),
    { month: '2026-10', pages: 0, aiChars: 0, cacheHits: 0, cacheMisses: 0, day: '2026-10-01', autoAiChars: 0 });
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
    assert.deepEqual(stats, AutoStats.emptyStats('2026-09', '2026-09-20'));
  } finally {
    globalThis.chrome = saved;
  }
});

test('read 把上个月那份归一化成这个月的空表', async () => {
  const saved = globalThis.chrome;
  globalThis.chrome = fakeStorage({
    month: '2026-08', pages: 99, aiChars: 1, cacheHits: 1, cacheMisses: 1,
    day: '2026-08-31', autoAiChars: 4000
  });
  try {
    const stats = await AutoStats.read(new Date('2026-09-20T12:00:00'));
    assert.deepEqual(stats, AutoStats.emptyStats('2026-09', '2026-09-20'));
  } finally {
    globalThis.chrome = saved;
  }
});

test('applyWrite 认得 add / reset / charge，别的一律拒绝', async () => {
  const saved = globalThis.chrome;
  const store = fakeStorage(null);
  globalThis.chrome = store;
  try {
    const month = AutoStats.currentMonth();
    const day = AutoStats.currentDay();
    await AutoStats.applyWrite({ kind: 'add', delta: { pages: 1, aiChars: 30 } });
    await AutoStats.applyWrite({ kind: 'add', delta: { cacheHits: 2, cacheMisses: 1 } });
    assert.deepEqual(store.calls.autoStats,
      { month, pages: 1, aiChars: 30, cacheHits: 2, cacheMisses: 1, day, autoAiChars: 0 });

    await AutoStats.applyWrite({ kind: 'reset' });
    assert.deepEqual(store.calls.autoStats, AutoStats.emptyStats(month, day));

    await assert.rejects(() => AutoStats.applyWrite({ kind: 'nonsense' }), /unknown auto-stats write/);
    await assert.rejects(() => AutoStats.applyWrite(null), /unknown auto-stats write/);
  } finally {
    globalThis.chrome = saved;
  }
});

test('charge 问和记是同一次操作，拒了就一个字都不记', async () => {
  const saved = globalThis.chrome;
  const store = fakeStorage(null);
  globalThis.chrome = store;
  try {
    const first = await AutoStats.applyWrite({ kind: 'charge', chars: 60, budget: 100 });
    assert.equal(first.allowed, true);
    assert.equal(store.calls.autoStats.autoAiChars, 60);

    // 还没到顶：放行，并且记上，于是正好填满。
    const second = await AutoStats.applyWrite({ kind: 'charge', chars: 40, budget: 100 });
    assert.equal(second.allowed, true);
    assert.equal(store.calls.autoStats.autoAiChars, 100);

    // 填满之后再问就是拒，而且**一个字都不记** —— 没发出去的字符不该算用量。
    const third = await AutoStats.applyWrite({ kind: 'charge', chars: 5, budget: 100 });
    assert.equal(third.allowed, false);
    assert.equal(store.calls.autoStats.autoAiChars, 100);
  } finally {
    globalThis.chrome = saved;
  }
});

test('同时来的八批不会一起挤过闸门', async () => {
  // 这是 charge 存在的理由。read + add 两步的话，八个批次都在各自的 read 里
  // 看到「还没超」，然后八个一起记账 —— 闸门不能有八个人同时通过的写法。
  const saved = globalThis.chrome;
  const store = fakeStorage(null);
  globalThis.chrome = store;
  try {
    const verdicts = await Promise.all(Array.from({ length: 8 },
      () => AutoStats.applyWrite({ kind: 'charge', chars: 100, budget: 250 })));
    assert.equal(verdicts.filter(v => v.allowed).length, 3);
    assert.equal(store.calls.autoStats.autoAiChars, 300);
  } finally {
    globalThis.chrome = saved;
  }
});

test('读不到存储时 charge 放行 —— 预算是自我约束，不是权限', async () => {
  const saved = globalThis.chrome;
  globalThis.chrome = undefined;
  try {
    const verdict = await AutoStats.applyWrite({ kind: 'charge', chars: 999999, budget: 1 });
    assert.equal(verdict.allowed, true);
    assert.equal(verdict.stats, null);
  } finally {
    globalThis.chrome = saved;
  }
});

test('消息发不出去时 charge 也放行', async () => {
  // 页面卸载、扩展刚更新完的那一瞬 sendMessage 会抛，request 给回 null。
  const saved = globalThis.chrome;
  globalThis.chrome = { runtime: { sendMessage: async () => { throw new Error('no receiving end'); } } };
  try {
    assert.deepEqual(await AutoStats.charge(500, 100), { allowed: true, stats: null });
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
