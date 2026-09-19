import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// shared/spa-navigation.js 读的是 root.location / root.addEventListener /
// root.navigation / root.document —— 在内容脚本里 root 就是 window，在这里
// 是 node 的 globalThis，上面这几个名字本来一个都没有，可以随便装。
//
// 每个用例装一份全新的假世界，并用 `?case=N` 让 import 真的重新执行模块：
// 这个模块有进程内状态（lastUrl、监听、心跳），拿上一条用例的 lastUrl 去判断
// 这一条有没有导航，测出来的是缓存不是行为。
function makeTarget() {
  const handlers = new Map();
  return {
    addEventListener(type, fn) {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      const set = handlers.get(type);
      if (set) set.delete(fn);
    },
    dispatch(type) {
      for (const fn of [...(handlers.get(type) || [])]) fn({ type });
    },
    count(type) {
      const set = handlers.get(type);
      return set ? set.size : 0;
    }
  };
}

let instance = 0;

async function freshNavigation({ href = 'https://example.com/a', navigationApi = true, visibility = 'visible' } = {}) {
  const win = makeTarget();
  const doc = makeTarget();
  const nav = makeTarget();

  globalThis.addEventListener = win.addEventListener;
  globalThis.removeEventListener = win.removeEventListener;
  globalThis.location = { href };
  doc.visibilityState = visibility;
  globalThis.document = doc;
  globalThis.navigation = navigationApi ? nav : undefined;

  instance += 1;
  await import(`../../shared/spa-navigation.js?case=${instance}`);

  const seen = [];
  return {
    api: globalThis.SpaNavigation,
    win,
    doc,
    nav,
    seen,
    // 「地址变了」和「浏览器喊了一声」是两件事，测试里也分开做。
    go(next) { globalThis.location.href = next; },
    listen(extra) {
      return globalThis.SpaNavigation.onRouteChange((event) => {
        seen.push(event);
        if (extra) extra(event);
      });
    }
  };
}

// 每条用例都把心跳换成假定时器：真的等 800ms 是十几条用例十秒钟，而且一旦
// 上一条用例的 interval 活过了用例边界，它读的是下一条用例刚装好的 location。
//
// **Date 必须跟着一起假。** 只假 setInterval 的话 tick(800) 推的是定时器而不是
// 时钟，于是任何「距上次多久」的判断在测试里都永远读到 0 毫秒 —— 一版按时间窗
// 去重的实现能在这种测试下全绿通过，而它在真浏览器里每 800ms 就误报一次导航。
function fakeClock(t) {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
}

test('popstate: 后退一步立刻播报，from/to/via 齐全', async (t) => {
  fakeClock(t);
  const w = await freshNavigation({ href: 'https://example.com/a' });
  const stop = w.listen();
  w.go('https://example.com/b');
  w.win.dispatch('popstate');
  stop();
  assert.deepEqual(w.seen, [{ from: 'https://example.com/a', to: 'https://example.com/b', via: 'popstate' }]);
});

test('hashchange: 锚点跳转也是一次导航，via 报它自己的名字', async (t) => {
  fakeClock(t);
  const w = await freshNavigation({ href: 'https://example.com/doc' });
  const stop = w.listen();
  w.go('https://example.com/doc#install');
  w.win.dispatch('hashchange');
  stop();
  assert.equal(w.seen.length, 1);
  assert.equal(w.seen[0].to, 'https://example.com/doc#install');
  assert.equal(w.seen[0].via, 'hashchange');
});

test('Navigation API: pushState 走 navigatesuccess 这一路', async (t) => {
  fakeClock(t);
  const w = await freshNavigation();
  const stop = w.listen();
  // pushState 不派发 popstate —— 这一路存在的全部理由。
  w.go('https://example.com/pushed');
  w.nav.dispatch('navigatesuccess');
  stop();
  assert.equal(w.seen.length, 1);
  assert.equal(w.seen[0].via, 'navigation');
  assert.equal(w.seen[0].to, 'https://example.com/pushed');
});

test('轮询: 一个事件都没有也能发现，每 800ms 比一次', async (t) => {
  fakeClock(t);
  const w = await freshNavigation();
  const stop = w.listen();
  w.go('https://example.com/silent');
  t.mock.timers.tick(799);
  assert.equal(w.seen.length, 0, '还没到点');
  t.mock.timers.tick(1);
  stop();
  assert.equal(w.seen.length, 1);
  assert.equal(w.seen[0].via, 'poll');
});

test('去重: 三路对同一次导航各喊一声，只播一次 —— 哪怕相隔远超 250ms', async (t) => {
  fakeClock(t);
  const w = await freshNavigation();
  const stop = w.listen();
  w.go('https://example.com/b');
  w.win.dispatch('popstate');
  w.nav.dispatch('navigatesuccess');
  // 轮询比事件慢得多。按「250ms 时间窗」去重的实现会在这里漏出第二次播报，
  // 而上层收到第二次的后果是整页再翻一遍。
  t.mock.timers.tick(800 * 3);
  stop();
  assert.equal(w.seen.length, 1);
  assert.equal(w.seen[0].via, 'popstate', '先看见的那一路才算');
});

test('去重不吃真导航: 250ms 内 A→B→A 是两次，两次都播', async (t) => {
  fakeClock(t);
  const w = await freshNavigation({ href: 'https://example.com/a' });
  const stop = w.listen();
  w.go('https://example.com/b');
  w.win.dispatch('popstate');
  w.go('https://example.com/a');
  w.win.dispatch('popstate');
  stop();
  assert.deepEqual(w.seen.map((e) => e.to), ['https://example.com/b', 'https://example.com/a']);
  assert.equal(w.seen[1].from, 'https://example.com/b');
});

test('没有 Navigation API: 事件与轮询照常，不报错', async (t) => {
  fakeClock(t);
  const w = await freshNavigation({ navigationApi: false });
  const stop = w.listen();
  w.go('https://example.com/b');
  t.mock.timers.tick(800);
  w.go('https://example.com/c');
  w.win.dispatch('popstate');
  stop();
  assert.deepEqual(w.seen.map((e) => e.via), ['poll', 'popstate']);
});

test('页面隐藏时不轮询，回到前台立刻补一次', async (t) => {
  fakeClock(t);
  const w = await freshNavigation({ visibility: 'hidden' });
  const stop = w.listen();
  w.go('https://example.com/while-hidden');
  t.mock.timers.tick(800 * 5);
  assert.equal(w.seen.length, 0, '后台标签页不该有心跳');

  w.doc.visibilityState = 'visible';
  w.doc.dispatch('visibilitychange');
  assert.equal(w.seen.length, 1, '回到前台要补上隐藏期间那次导航，而不是再等 800ms');

  // 补完还要真的把心跳接上。
  w.go('https://example.com/after');
  t.mock.timers.tick(800);
  stop();
  assert.equal(w.seen.length, 2);
});

test('最后一个订阅者退订后，监听和心跳一起撤掉', async (t) => {
  fakeClock(t);
  const w = await freshNavigation();
  const stopA = w.listen();
  const stopB = w.listen();

  stopA();
  assert.equal(w.win.count('popstate'), 1, '还有人听着就不许撤');

  stopB();
  assert.equal(w.win.count('popstate'), 0);
  assert.equal(w.win.count('hashchange'), 0);
  assert.equal(w.nav.count('navigatesuccess'), 0);
  assert.equal(w.doc.count('visibilitychange'), 0);

  w.go('https://example.com/nobody-home');
  t.mock.timers.tick(800 * 10);
  w.win.dispatch('popstate');
  assert.equal(w.seen.length, 0);
});

test('一个回调抛异常，另一个照样收得到', async (t) => {
  fakeClock(t);
  t.mock.method(console, 'error', () => {});
  const w = await freshNavigation();
  const stopBad = globalThis.SpaNavigation.onRouteChange(() => { throw new Error('boom'); });
  const stop = w.listen();
  w.go('https://example.com/b');
  w.win.dispatch('popstate');
  stopBad();
  stop();
  assert.equal(w.seen.length, 1);
  assert.equal(console.error.mock.callCount(), 1);
});

test('重新订阅从当下起算，不补播没人听的时候发生的导航', async (t) => {
  fakeClock(t);
  const w = await freshNavigation({ href: 'https://example.com/a' });
  const stop = w.listen();
  stop();

  w.go('https://example.com/b');
  const stopAgain = w.listen();
  w.win.dispatch('popstate');
  assert.equal(w.seen.length, 0, '订阅之前的事不是这个订阅者的事');

  w.go('https://example.com/c');
  w.win.dispatch('popstate');
  stopAgain();
  assert.deepEqual(w.seen.map((e) => e.from), ['https://example.com/b']);
});

test('currentUrl 读的就是当下的 location.href', async (t) => {
  fakeClock(t);
  const w = await freshNavigation({ href: 'https://example.com/a' });
  assert.equal(w.api.currentUrl(), 'https://example.com/a');
  w.go('https://example.com/b');
  assert.equal(w.api.currentUrl(), 'https://example.com/b');
});

test('manifest 里装了它 —— 一个没被加载的模块等于没写', async () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'manifest.json'), 'utf8'));
  const isolated = manifest.content_scripts.find((entry) => (entry.world || 'ISOLATED') === 'ISOLATED');
  assert.ok(isolated.js.includes('shared/spa-navigation.js'));
});
