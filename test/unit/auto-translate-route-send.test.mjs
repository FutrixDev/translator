// 自动翻译发请求之前先对一次地址（R33 D-360 F1）。
//
// 这一代是替哪个地址判的，发出去之前就拿哪个地址对。对不上，就把路由信号当场补上
// —— SpaNavigation.check('send')，和 popstate / navigatesuccess / 轮询走同一个
// announce，于是进的是同一个 onRouteChange，重新判定只有那一条路。
//
// 为什么非对不可：页面的路由器拦下 Navigation API 的 navigate 事件时，隔离世界的
// navigatesuccess 要等它的处理函数落定，只剩 800ms 一次的轮询；而发现层 400ms +
// 起跑 250ms 之后这一批就出门了。x.com 从首页点进私信，私信正文会按首页的判定送
// 出去（内置表里 /messages 是 never）。
//
// 这里在 vm 里装**真实的** shared/spa-navigation.js、shared/session-guard.js、
// shared/block-identity.js 与 content/content-auto-translate.js；路由的三个触发器
// 全部静音（没有 navigation、事件不派发、轮询由用例手动拨），于是「信号没到」是
// 确定的，不靠计时。收块、送翻、判定换成桩。端到端的那一条在
// test/e2e/page-translation-site-rules.spec.js。
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { repoSource } from './helpers/sources.mjs';

const tick = () => new Promise((resolve) => setImmediate(resolve));

function element(name) {
  return { name, text: `${name} text long enough to translate`, isConnected: true };
}

function load() {
  const timers = [];
  const polls = [];
  const passes = [];
  const decided = [];
  const routes = [];
  const setHref = (href) => {
    const url = new URL(href);
    sandbox.location.href = href;
    sandbox.location.hostname = url.hostname;
    sandbox.location.pathname = url.pathname;
  };
  const ctx = {
    frameRole: 'top',
    state: { isTranslatingPage: false, translationsVisible: true },
    settings: { autoTranslate: true, siteRules: {}, autoAiDailyBudget: 0 },
    t: (key) => key,
    customRules: { isCatchingUp: () => false, onChange() {} },
    onLanguagePackReady() {},
    readSourceText: (el) => el.text,
    setupAutoDiscovery: () => ({ rescan() {}, stop() {}, suspend() {}, resume() {} }),
    builtinTranslator: { effectiveEngine: async () => 'builtin' },
    filterBlocksByLanguage: async (blocks) => blocks,
    runTranslationPass: (blocks, options) => new Promise((resolve) => {
      passes.push({ texts: [...blocks].map((block) => block.text), options, resolve });
    }),
  };
  const sandbox = {
    console,
    queueMicrotask,
    URL,
    location: { href: '', hostname: '', pathname: '' },
    // 三个路由触发器全静音：没有 Navigation API，窗口事件不派发，轮询攒着由用例拨。
    addEventListener() {},
    removeEventListener() {},
    document: { body: {}, visibilityState: 'visible', addEventListener() {}, removeEventListener() {} },
    setInterval: (fn) => { polls.push(fn); return polls.length; },
    clearInterval() {},
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout() {},
    requestAnimationFrame() {},
    // 内置表的那一格：x.com 的 /messages 是 never，其余自动翻。
    SiteRules: {
      decide: ({ path }) => {
        decided.push(path);
        return path.startsWith('/messages')
          ? { verdict: 'off', reason: 'BUILTIN_NEVER', refused: true }
          : { verdict: 'auto', reason: 'BUILTIN_ALWAYS', refused: false };
      },
    },
    AutoStats: { add() {}, read: async () => ({}), budgetExceeded: () => false },
    AI_TRANSLATOR_CONTENT: ctx,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  setHref('https://x.com/home');
  vm.createContext(sandbox);
  for (const rel of ['shared/spa-navigation.js', 'shared/block-identity.js', 'shared/session-guard.js',
    'content/content-auto-translate.js']) {
    vm.runInContext(repoSource(rel), sandbox, { filename: rel });
  }
  sandbox.SpaNavigation.onRouteChange((change) => routes.push(change));
  let onCandidates = null;
  ctx.setupAutoDiscovery = (options) => {
    onCandidates = options.onCandidates;
    return { rescan() {}, stop() {}, suspend() {}, resume() {} };
  };
  const auto = ctx.setupAutoTranslate();
  assert.equal(auto.state().reason, 'BUILTIN_ALWAYS', 'x.com/home is translated automatically');
  const offer = (el) => onCandidates([{ element: el, text: el.text }]);
  const fire = async () => {
    const { fn } = timers.shift();
    fn();
    for (let i = 0; i < 5; i += 1) await tick();
  };
  return { auto, ctx, timers, polls, passes, decided, routes, setHref, offer, fire };
}

test('the page moved before the first batch left: the route signal is raised then and nothing is sent', async () => {
  const s = load();
  const home = element('home');
  s.offer(home);
  // pushState 到私信页；隔离世界还没听说（轮询还没拨）。
  s.setHref('https://x.com/messages/abc');
  s.offer(element('dm'));
  await s.fire(); // 起跑那一拍
  assert.equal(s.passes.length, 0, 'no batch may leave under the home page verdict');
  assert.equal(s.auto.state().reason, 'BUILTIN_NEVER', 'the DM page was judged through the route handler');
  assert.deepEqual(s.routes.map((r) => [r.to, r.via]), [['https://x.com/messages/abc', 'send']],
    'the signal went out through SpaNavigation, so every route subscriber heard it');
});

test('the poll that arrives later for the same move does not restart the page a second time', async () => {
  const s = load();
  s.offer(element('home'));
  s.setHref('https://x.com/messages/abc');
  await s.fire();
  const judged = s.decided.length;
  for (const poll of s.polls) poll(); // 那次迟到的轮询
  assert.equal(s.decided.length, judged, 'the same navigation must not be judged twice');
  assert.equal(s.routes.length, 1);
});

test('the page moved while a pass was running: the next batch asks first and stops', async () => {
  const s = load();
  s.offer(element('home'));
  await s.fire();
  assert.equal(s.passes.length, 1, 'the home page batch went out');
  const { options } = s.passes[0];
  assert.equal(options.isAborted(), false, 'same page, same session');
  s.setHref('https://x.com/messages/abc');
  assert.equal(options.isAborted(), true, 'the remaining batches of this pass are dropped');
  assert.equal(s.auto.state().reason, 'BUILTIN_NEVER');
  assert.deepEqual(s.routes.map((r) => r.via), ['send']);
});

test('a page that did not move sends normally and raises no route signal', async () => {
  const s = load();
  s.offer(element('home'));
  await s.fire();
  assert.equal(s.passes.length, 1);
  assert.deepEqual(s.passes[0].texts, ['home text long enough to translate']);
  assert.equal(s.routes.length, 0);
});
