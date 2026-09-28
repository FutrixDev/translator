// include 区域晚到（T1）：规则写了 include、区域还没出现时，范围退回下一档，退下去的
// 那几轮把区域外的块也收了。区域长出来、范围第一次切到 include，这是「范围在轮次
// 中途变了」，和规则变化是同一类事，只走一条路：content/page/custom-rule.js 的
// rescope()——当场清扫；有轮次在跑就记 pending，由那一轮收尾时 afterRound() 再扫；
// 补翻与回调订阅者（调度器重启、会话号 +1）推迟到当前同步段之后，同一次命中只回调
// 一次。
//
// 退下去那一轮收的块在清扫那一刻可能还没挂上：
//   - 手动轮进行中（发现层在跑，它的一次收块碰上晚到）：那一轮后面挂上的译文，收尾
//     时由 afterRound() 收回；
//   - 自动路径，块在路上：调度器重启，会话号变了，结果回来被会话守卫挡掉；
//   - 自动路径，块在排队：重启清空队列，泵起来时没有它。
// CONTROL：同一条时间线由规则变化引起时，本来就收得回来（F7）。
//
// 手动轮那两条在同一个 ctx 里装真实的 custom-rule.js、scope.js、frames/top.js 与
// content-page-translation.js；调度器那两条在 vm 里装真实的 custom-rule.js、
// content-auto-translate.js 与 scope.js。只有收块、送翻、DOM 换成桩。
//
// 源自源码层复验的探针 review-b1r1-source/probes/r1-late-hit-residual.test.mjs：那三条
// RESIDUAL 断言的是修之前的行为，这里反过来断言修之后的行为。
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { repoSource } from './helpers/sources.mjs';

await import('../../shared/lang-tags.js');
await import('../../shared/site-rules-builtin.js');
await import('../../shared/storage-writer.js');
await import('../../shared/site-rules.js');
await import('../../shared/sync-collection.js');
await import('../../shared/prompt-addenda.js');
await import('../../shared/api-compat.js');
// custom-rules.js 在加载时取走 AIProfiles（规则 v3 的 profile，P1-D）。
await import('../../shared/ai-profiles.js');
await import('../../shared/custom-rules.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tick = () => new Promise((resolve) => setImmediate(resolve));
const put = (id, value) => ({ [`customRule:${id}`]: { newValue: value } });

// 一棵极小的组合树：body > { R（include 区域，晚渲染）> I, X, W }。
function tree() {
  const make = (name, parent) => {
    const el = {
      name, parent, text: `${name} text long enough to translate`, isConnected: true,
      getClientRects: () => [{}], children: [],
      contains(node) {
        for (let up = node && node.parent; up; up = up.parent) if (up === el) return true;
        return false;
      },
    };
    if (parent) parent.children.push(el);
    return el;
  };
  const body = make('body', null);
  body.localName = 'body';
  const R = make('R', body);
  const I = make('I', R);
  const X = make('X', body); // 退下去那一轮收的，晚到命中那一刻还在路上 / 在排队
  const W = make('W', body); // 更早挂上、落在将来区域之外的译文
  return { body, R, I, X, W };
}

// ------------------------------------------------------- 手动轮（真实顶层 frame）

const PAGE_SOURCES = [
  'content/page/custom-rule.js',
  'content/page/scope.js',
  'content/frames/top.js',
  'content/content-page-translation.js',
].map(repoSource);

async function loadTopFrame(rule, { includeHitsAtStart = false } = {}) {
  const href = 'https://example.com/news/1';
  const url = new URL(href);
  globalThis.location = { href, hostname: url.hostname, pathname: url.pathname };
  const t = tree();
  let progress = null;
  globalThis.document = {
    adoptedStyleSheets: [],
    body: t.body,
    querySelectorAll: () => [],
    getElementById: (id) => (id === 'ai-translator-progress' ? progress : null),
  };
  globalThis.CSSStyleSheet = class { replaceSync() {} };
  globalThis.SpaNavigation = { onRouteChange() {} };
  if (!globalThis.Node) globalThis.Node = { DOCUMENT_POSITION_FOLLOWING: 4 };
  const listeners = [];
  globalThis.chrome = {
    runtime: {
      sendMessage: () => Promise.resolve({ rules: [rule] }),
      onMessage: { addListener: (fn) => listeners.push(fn) },
    },
  };

  const page = { includeHits: includeHitsAtStart ? [t.R] : [], translated: [t.W] };
  const log = [];
  const passes = [];
  const ctx = {
    frameRole: 'top',
    t: (key) => key,
    settings: { pageTranslateScope: 'main' },
    state: {
      pageHasBeenTranslated: false, isTranslatingPage: false, translationsVisible: true,
      pageScopeOverride: null, translationProgress: { current: 0, total: 0 },
    },
    syncMirrors: [],
    // 缓存层那个文件的 ctx.translationProfile：顶层指令带它的代数（P1-C §3.8）。
    translationProfile: { generation: () => 0, subscribe() {} },
    frames: { sendToRelay() {} },
    autoTranslate: { isOn: () => false, onStateChange: (fn) => fn(), markPageExplicit() {} },
    isExtensionContextAvailable: () => true,
    revealHiddenTranslations() {},
    showPageTranslationProgress: () => { progress = { shown: true }; },
    hidePageTranslationProgress: () => { progress = null; },
    updatePageTranslationProgress() {},
    showTranslatingHint() {},
    showTranslationError: (e) => log.push(`error:${e}`),
    showPageNotice: (text) => log.push(`notice:${text}`),
    getManagedSkipCount: () => 0,
    filterBlocksByLanguage: async (blocks) => blocks,
    usableSelector: (list) => list.join(','),
    queryAllDeep: (selector) => (selector === '.ai-translator-translated' ? [...page.translated] : page.includeHits),
    composedContains: (ancestor, node) => ancestor === node || ancestor.contains(node),
    composedParent: (el) => el.parent || null,
    // 真实 ruleForbids（collect.js）的 include 一半；这里的规则没有 exclude。
    ruleForbids: (el, scope) => ctx.outsidePageScope(el, scope),
    releaseTranslation: (el) => {
      log.push(`release:${el.name}`);
      page.translated = page.translated.filter((each) => each !== el);
    },
    // 退下去的轮次看到 X（区域还没出现）；include 轮次看到 I。
    collectTranslatableBlocks: (root, { scope }) => {
      log.push(`collect:${scope.mode}`);
      return scope.mode === 'include' ? [{ element: t.I, text: 'i' }] : [{ element: t.X, text: 'x' }];
    },
    // 停住；release(n) 把第 n 次送翻的译文挂上（记进 translated），再结束它。
    runTranslationPass: (blocks) => new Promise((resolve) => {
      log.push(`pass:${passes.length + 1}:${blocks.map((b) => b.element.name).join(',')}`);
      passes.push(() => {
        for (const block of blocks) page.translated.push(block.element);
        resolve(null);
      });
    }),
  };
  globalThis.window = { AI_TRANSLATOR_CONTENT: ctx, length: 1 };
  for (const source of PAGE_SOURCES) new Function(source)();
  ctx.customRules.init();
  await ctx.customRules.whenReady();
  ctx.frames.setup();
  const notified = { count: 0 };
  ctx.customRules.onChange(() => { notified.count += 1; });
  const release = async (n) => { passes[n - 1](); await sleep(0); };
  const changeRule = async (fields) => {
    ctx.syncMirrors[0].onStorageChange(put(rule.id, { ...rule, ...fields }));
    await sleep(220);
  };
  // 发现层 flush（content-auto-discover.js）做的事：开新的一轮，再收块。
  const flush = () => { ctx.beginScopeRound(); ctx.collectPageBlocks(t.body); };
  return { ctx, t, page, log, notified, release, changeRule, flush };
}

const INCLUDE_RULE = { id: 'a', v: 1, match: ['example.com'], include: ['.article'], updatedAt: 1 };
const PLAIN_RULE = { id: 'a', v: 1, match: ['example.com'], exclude: ['.ad'], updatedAt: 1 };

test('manual round, discovery live: a late hit mid-round is swept at once, and the round\'s later insertions outside the region are recalled when it ends', async () => {
  const top = await loadTopFrame(INCLUDE_RULE);
  const { ctx, t, page, log, notified, release, flush } = top;
  assert.deepEqual(ctx.customRules.current().include, ['.article'], 'the include rule is loaded');

  ctx.translatePage();
  await sleep(10);
  assert.deepEqual(log, ['collect:main', 'pass:1:X'], 'the manual round collected X under the fallback');

  // 区域在第 1 次送翻途中渲染出来；发现层的 flush 解析范围。
  page.includeHits = [t.R];
  flush();
  assert.deepEqual(log.slice(2), ['release:W', 'collect:include'], 'the late hit sweeps inside resolvePageScope, before collect');
  await tick();
  assert.equal(notified.count, 1, 'one late hit notifies the subscribers once');

  // 第 1 次送翻把 X 挂上、这一轮结束：afterRound 看到 pending，再扫一次。
  await release(1);
  assert.ok(log.includes('release:X'), `the round's end recalled the late X: ${JSON.stringify(log)}`);
  assert.ok(!page.translated.includes(t.X), 'X is not left outside the include region');
  assert.ok(log.includes('pass:2:I'), 'the catch-up round then translates the region');
  assert.equal(notified.count, 1, 'the round end is not another scope change');
});

test('CONTROL: the same mid-round switch to include caused by a rule change is re-swept when the round ends', async () => {
  const top = await loadTopFrame(PLAIN_RULE, { includeHitsAtStart: true });
  const { ctx, t, page, log, release, changeRule } = top;
  ctx.translatePage();
  await sleep(10);
  assert.deepEqual(log, ['collect:main', 'pass:1:X']);

  // 区域已经在；第 1 次送翻途中规则加上了 include。
  await changeRule({ include: ['.article'] });
  assert.ok(log.includes('release:W'), 'recompute swept W');
  assert.ok(!log.includes('release:X'), 'X was not inserted yet');

  await release(1);
  assert.ok(log.includes('release:X'), `afterRound recalled the late X: ${JSON.stringify(log)}`);
  assert.ok(!page.translated.includes(t.X));
});

test('a rule change whose own sweep runs into the late hit notifies the subscribers once', async () => {
  const top = await loadTopFrame(INCLUDE_RULE);
  const { ctx, t, page, log, notified, changeRule, flush } = top;
  flush();
  assert.equal(ctx.resolvePageScope().mode, 'main', 'the include region is not there yet');
  // 区域出现与规则变化落在同一拍：recompute() 的清扫解析范围，碰上晚到，rescope()
  // 嵌套一次。
  page.includeHits = [t.R];
  await changeRule({ css: '.x { color: red; }' });
  assert.equal(ctx.resolvePageScope().mode, 'include');
  assert.ok(log.includes('release:W'), 'W was swept');
  assert.equal(notified.count, 1, `a nested rescope() coalesces into one notification: ${notified.count}`);
});

// ------------------------------------------------------- 自动调度器（真实泵 + 真实 scope.js）

async function loadScheduler() {
  const t = tree();
  const timers = [];
  const passes = [];
  const log = [];
  const page = { includeHits: [], translated: [t.W] };
  let onCandidates = null;
  const rule = { id: 'a', v: 1, match: ['example.com'], include: ['.article'], updatedAt: 1 };
  const ctx = {
    frameRole: 'top',
    state: { isTranslatingPage: false, translationsVisible: true, pageScopeOverride: null },
    settings: { autoTranslate: true, siteRules: {}, autoAiDailyBudget: 0, pageTranslateScope: 'main' },
    syncMirrors: [],
    usableSelector: (list) => list.join(','),
    queryAllDeep: (selector) => (selector === '.ai-translator-translated' ? [...page.translated] : page.includeHits),
    composedContains: (ancestor, node) => ancestor === node || ancestor.contains(node),
    composedParent: (el) => el.parent || null,
    ruleForbids: (el, scope) => ctx.outsidePageScope(el, scope),
    releaseTranslation: (el) => {
      log.push(`release:${el.name}`);
      page.translated = page.translated.filter((each) => each !== el);
    },
    collectTranslatableBlocks: (root, { scope }) => {
      log.push(`collect:${scope.mode}`);
      return [];
    },
    onLanguagePackReady() {},
    getEffectiveTargetLang: () => 'zh-CN',
    readSourceText: (element) => element.text,
    setupAutoDiscovery: (options) => {
      onCandidates = options.onCandidates;
      return {
        rescan() {}, stop: () => log.push('restart'), suspend: () => log.push('suspend'), resume: () => log.push('resume'),
      };
    },
    builtinTranslator: { effectiveEngine: async () => 'builtin' },
    filterBlocksByLanguage: async (blocks) => blocks,
    runTranslationPass: (blocks, options) => new Promise((resolve) => {
      log.push(`pass:${blocks.map((b) => b.element.name).join(',')}`);
      passes.push({ blocks, options, resolve });
    }),
  };
  const sandbox = {
    console,
    queueMicrotask,
    document: { body: t.body, adoptedStyleSheets: [], querySelectorAll: () => [] },
    location: { href: 'https://example.com/news/1', hostname: 'example.com', pathname: '/news/1' },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout() {},
    requestAnimationFrame() {},
    CSSStyleSheet: class { replaceSync() {} },
    chrome: { runtime: { sendMessage: () => Promise.resolve({ rules: [rule] }) } },
    CustomRules: globalThis.CustomRules,
    SiteRules: { decide: () => ({ verdict: 'auto', reason: 'TEST' }), matchBuiltin: () => null },
    SpaNavigation: { onRouteChange() {} },
    AutoStats: { add() {}, read: async () => ({}), budgetExceeded: () => false },
    Node: { DOCUMENT_POSITION_FOLLOWING: 4 },
    AI_TRANSLATOR_CONTENT: ctx,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const rel of ['content/page/custom-rule.js', 'shared/block-identity.js', 'shared/session-guard.js',
    'content/content-auto-translate.js', 'content/page/scope.js']) {
    vm.runInContext(repoSource(rel), sandbox, { filename: rel });
  }
  ctx.customRules.init();
  await ctx.customRules.whenReady();
  assert.deepEqual(ctx.customRules.current().include, ['.article'], 'the include rule is loaded');
  ctx.setupAutoTranslate();
  assert.ok(onCandidates, 'the scheduler started discovery');
  assert.equal(ctx.autoTranslate.isOn(), true);
  // 定时器是宏任务：先让当前同步段之后的微任务跑完，再触发它。
  const fire = async () => { const { fn } = timers.shift(); fn(); await tick(); await tick(); };
  // 发现层的 flush（开新的一轮，再收块）与 onBand（只收块）。
  const flush = () => { ctx.beginScopeRound(); ctx.collectPageBlocks(t.body); };
  const band = (el) => ctx.collectPageBlocks(el);
  return { ctx, t, page, log, passes, timers, fire, flush, band, offer: (blocks) => onCandidates(blocks) };
}

test('auto, in flight: a late hit seen by onBand during the pump restarts the scheduler after the collect, and the fallback batch is refused', async () => {
  const s = await loadScheduler();
  const { ctx, t, page, log, passes, fire, flush, band, offer } = s;
  flush(); // 找到 X 的那一次 flush，还在退下去的范围里
  offer([{ element: t.X, text: t.X.text }]);
  await fire(); // START_DEBOUNCE_MS
  assert.deepEqual(log, ['collect:main', 'suspend', 'pass:X'], 'the pump is translating X with discovery suspended');

  page.includeHits = [t.R];
  band(t.I); // onBand 不受 suspend 约束：它重新收块，于是重新解析范围
  assert.deepEqual(log.slice(3), ['release:W', 'collect:include'],
    'swept at once; the restart is not inside the synchronous collect');
  await tick();
  assert.deepEqual(log.slice(5), ['restart'], 'the scheduler restarted right after that synchronous segment');

  const { options, resolve } = passes[0];
  assert.equal(options.isAborted(), true, 'the session moved on');
  assert.equal(options.accept({ element: t.X, text: t.X.text }), false, 'accept() refuses the fallback batch');
  resolve(null);
  await tick();
  assert.ok(!page.translated.includes(t.X), 'X never lands outside the include region');
});

test('auto, queued: a late hit seen before the start debounce fires restarts the scheduler, and the pump no longer takes the fallback block', async () => {
  const s = await loadScheduler();
  const { t, page, log, passes, fire, flush, band, offer } = s;
  flush();
  offer([{ element: t.X, text: t.X.text }]);
  page.includeHits = [t.R];
  band(t.I);
  assert.deepEqual(log, ['collect:main', 'release:W', 'collect:include']);
  await tick();
  assert.deepEqual(log.slice(3), ['restart'], 'the restart ran before the start debounce timer');

  await fire();
  assert.equal(passes.length, 0, `the queue was dropped with the old session: ${JSON.stringify(log)}`);
  assert.ok(!log.includes('pass:X'));
});
