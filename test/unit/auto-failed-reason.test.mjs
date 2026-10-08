// 自动翻译放弃一段时，失败标记的 title 是这一段自己的原因（P1-D D2 修复回合 1 的 B，
// 任务书 p1-d-d2.md:89）。
//
// 零星几段失败时 runTranslationPass 不报整轮错误（要连错三批才报），giveUp 那一刻
// 手里的 error 是 null —— 只拿它做 title，标记上就只剩通用的「翻译失败」。所以
// batch.js 把每一个失败点的原因经 onBlockFailed 报上来，调度层记在 inflight 条目上，
// giveUp 时先用它；只有真的没有逐段原因（整轮级的失败）才回落到整轮的 error。
//
// 这里在 vm 里装**真实的** content/content-auto-translate.js（连同它要的
// spa-navigation / block-identity / session-guard），收块、送翻、判定换成桩；
// runTranslationPass 的桩由用例决定每一轮报哪些逐段原因、回什么整轮结果。
// 标记本身长什么样在 test/e2e/ai-retry-limits.spec.js（D-J11）。
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
  const passes = [];
  const marks = [];
  const ctx = {
    frameRole: 'top',
    state: { isTranslatingPage: false, translationsVisible: true },
    settings: { autoTranslate: true, siteRules: {}, autoAiDailyBudget: 0 },
    t: (key) => key,
    customRules: { isCatchingUp: () => false, onChange() {} },
    aiProfiles: { subscribe: () => () => {} },
    failedBlocks: {
      isMarked: () => false,
      mark: (block, reason, options) => marks.push({ element: block.element, reason, auto: options.auto }),
    },
    onLanguagePackReady() {},
    readSourceText: (el) => el.text,
    builtinTranslator: { effectiveEngine: async () => 'builtin' },
    filterBlocksByLanguage: async (blocks) => blocks,
    runTranslationPass: (blocks, options) => new Promise((resolve) => {
      passes.push({ blocks: [...blocks], options, resolve });
    }),
  };
  const sandbox = {
    console,
    queueMicrotask,
    URL,
    location: { href: 'https://example.com/a', hostname: 'example.com', pathname: '/a' },
    addEventListener() {},
    removeEventListener() {},
    document: { body: {}, visibilityState: 'visible', addEventListener() {}, removeEventListener() {} },
    setInterval: () => 0,
    clearInterval() {},
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout() {},
    requestAnimationFrame() {},
    SiteRules: { decide: () => ({ verdict: 'auto', reason: 'BUILTIN_ALWAYS', refused: false }) },
    AutoStats: { add() {}, read: async () => ({}), budgetExceeded: () => false },
    AI_TRANSLATOR_CONTENT: ctx,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const rel of ['shared/spa-navigation.js', 'shared/block-identity.js', 'shared/session-guard.js',
    'content/content-auto-translate.js']) {
    vm.runInContext(repoSource(rel), sandbox, { filename: rel });
  }
  let onCandidates = null;
  ctx.setupAutoDiscovery = (options) => {
    onCandidates = options.onCandidates;
    return { rescan() {}, stop() {}, suspend() {}, resume() {} };
  };
  ctx.setupAutoTranslate();
  const offer = (...els) => onCandidates(els.map((el) => ({ element: el, text: el.text })));
  // 起跑那一拍：拨最早的那个定时器，等 pump 走完它的几次 await。
  const fire = async () => {
    const { fn } = timers.shift();
    fn();
    for (let i = 0; i < 5; i += 1) await tick();
  };
  /** 结束最近一轮：先按 reasons 报逐段原因（element → 文案），再以 result 收尾。 */
  const settle = async (reasons, result = null) => {
    const pass = passes[passes.length - 1];
    for (const block of pass.blocks) {
      if (reasons.has(block.element)) pass.options.onBlockFailed(block, reasons.get(block.element));
    }
    pass.resolve(result);
    for (let i = 0; i < 5; i += 1) await tick();
  };
  return { passes, marks, offer, fire, settle };
}

test('a few scattered failures: the marker title is each block\'s own reason, not the generic text', async () => {
  const s = load();
  const a = element('a');
  const b = element('b');
  s.offer(a, b);
  await s.fire();
  assert.equal(s.passes.length, 1, 'the first pass went out');
  // 第一次失败：放回队列，不放标记。整轮没有报错（没到三批的门槛）。
  await s.settle(new Map([[a, 'apiErrorTimeout 30'], [b, 'apiErrorUnavailable']]));
  assert.deepEqual(s.marks, []);
  await s.fire();
  assert.equal(s.passes.length, 2, 'the failed blocks were sent a second time');
  // 第二次失败：放弃，放标记。原因可以和第一次不同，用的是这一次的。
  await s.settle(new Map([[a, 'apiErrorRateLimited'], [b, 'apiErrorUnavailable']]));
  assert.deepEqual(s.marks.map((m) => [m.element.name, m.reason, m.auto]), [
    ['a', 'apiErrorRateLimited', true],
    ['b', 'apiErrorUnavailable', true],
  ]);
});

test('no per-block reason (a whole-pass failure): the title falls back to the pass error', async () => {
  const s = load();
  const a = element('a');
  s.offer(a);
  await s.fire();
  await s.settle(new Map());
  await s.fire();
  await s.settle(new Map(), { message: 'extensionContextInvalidated', action: null });
  assert.deepEqual(s.marks.map((m) => [m.element.name, m.reason]), [['a', 'extensionContextInvalidated']]);
});
