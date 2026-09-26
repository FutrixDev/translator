// 正文范围的缓存（content/page/scope.js 的 resolvePageScope）：退回 body 的结果也
// 缓存，body 的字数一轮只数一次。
//
//   - 键（URL + 设置 + 覆盖）不变、这一轮里再问多少次，都不重数 body；
//   - 新的一轮（ctx.beginScopeRound()：发现层的 flush、手动整页翻译、子 frame 的
//     手动轮）只让「退回 body」的结果作废，于是晚长出正文的 <main> 下一轮能认出来；
//     认出来的 <main> 跨轮照旧有效；
//   - 加载 scope.js 不挂任何观察者或监听。
//
// 计数器数的是 body.textContent 被读了几次——textLength(body) 每调一次读一次。
// 发现层一批多个根只数一次、手动轮与发现轮真能认出长大的 <main>，在真浏览器里量：
// page-coverage-harness.spec.js「scope cache」。
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SOURCE = readFileSync(path.join(ROOT, 'content/page/scope.js'), 'utf8');

/**
 * 夹具：scope.js 求范围时碰到的那几样 DOM，逐个写成桩。
 * body 的字数 = bodyChars，<main> 的字数 = mainChars；两者都可以在测试中途改。
 */
function load({ bodyChars, mainChars }) {
  const counts = { body: 0, cssRounds: 0, sweeps: 0, includeQueries: 0 };
  const registrations = [];
  // rule / ruleVersion：用户站点规则（ctx.customRules 的桩）；includeHits：include
  // 选择器在页面上命中的元素（ctx.queryAllDeep 的桩）；builtin：内置规则表命中与否。
  // translated：页面上已挂的译文；released：清扫收回的那些。
  const page = {
    bodyChars, mainChars, mainConnected: true, rule: null, ruleVersion: 0, includeHits: [], builtin: null,
    translated: [], released: [],
  };

  const element = (localName, chars, extra = {}) => ({
    localName,
    getClientRects: () => [{}],
    querySelectorAll: () => [],
    contains: () => false,
    ...extra,
    get textContent() {
      if (localName === 'body') counts.body += 1;
      return 'x'.repeat(chars());
    },
  });
  const main = element('main', () => page.mainChars);
  // 展开运算符会把 getter 当场求成值，所以 isConnected 另外挂。
  Object.defineProperty(main, 'isConnected', { get: () => page.mainConnected });
  const body = element('body', () => page.bodyChars, { isConnected: true, contains: (node) => node === main });

  const ctx = {
    state: { pageScopeOverride: null },
    settings: { pageTranslateScope: 'main' },
    customRules: {
      current: () => page.rule,
      get version() {
        return page.ruleVersion;
      },
      beginRound: () => { counts.cssRounds += 1; },
      // custom-rule.js 的 sweepWith 在这份夹具里只看范围（ruleForbids 的 include 一半）。
      sweepWith: (scope) => {
        counts.sweeps += 1;
        for (const el of page.translated) if (ctx.outsidePageScope(el, scope)) page.released.push(el);
      },
    },
    usableSelector: (list) => list.join(','),
    queryAllDeep: () => {
      counts.includeQueries += 1;
      return page.includeHits;
    },
    composedContains: (ancestor, node) => ancestor === node || ancestor.contains(node),
    // 跨 shadow root 的父：region() 的 parent（shadow 里的顶层元素，父是宿主）。
    composedParent: (el) => el.parent || null,
  };
  const sandbox = {
    console,
    location: { href: 'https://news.example.com/a', hostname: 'news.example.com', pathname: '/a' },
    document: {
      body,
      querySelectorAll: () => (page.mainConnected ? [main] : []),
    },
    SiteRules: { matchBuiltin: () => page.builtin },
    Node: { DOCUMENT_POSITION_FOLLOWING: 4 },
    // 加载时若有人挂观察者或监听，这里记下来。
    MutationObserver: class { constructor() { registrations.push('MutationObserver'); } observe() {} },
    IntersectionObserver: class { constructor() { registrations.push('IntersectionObserver'); } observe() {} },
    addEventListener: (type) => registrations.push(`addEventListener:${type}`),
    AI_TRANSLATOR_CONTENT: ctx,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox, { filename: 'content/page/scope.js' });
  return { ctx, counts, page, body, main, registrations, location: sandbox.location };
}

// body 100 字、<main> 10 字：占比 0.1，退回 body。
const SHELL = { bodyChars: 100, mainChars: 10 };

test('loading the scope module registers no observer and no listener', () => {
  const { registrations, ctx } = load(SHELL);
  assert.deepEqual(registrations, []);
  assert.equal(typeof ctx.beginScopeRound, 'function');
});

test('(a) same key, same DOM: a fallback to body is counted once however often it is asked', () => {
  const { ctx, counts, body } = load(SHELL);
  const first = ctx.resolvePageScope();
  assert.equal(first.roots[0], body);
  assert.equal(first.mode, 'main');
  for (let i = 0; i < 5; i += 1) assert.equal(ctx.resolvePageScope(), first);
  // collectPageBlocks 是生产入口，走同一份缓存（收集器本身不在这份夹具里）。
  ctx.collectTranslatableBlocks = () => [];
  for (let i = 0; i < 3; i += 1) ctx.collectPageBlocks(body);
  assert.equal(counts.body, 1, 'the fallback recounted body within one round');
});

test('(b) a new round recounts a fallback once, and recognises a <main> that grew', () => {
  const { ctx, counts, page, body, main } = load(SHELL);
  ctx.resolvePageScope();
  assert.equal(counts.body, 1);

  // 同一轮里 <main> 长大了：缓存还没作废，照旧是 body——所以才要按轮作废。
  page.mainChars = 50;
  page.bodyChars = 140;
  assert.equal(ctx.resolvePageScope().roots[0], body);
  assert.equal(counts.body, 1);

  ctx.beginScopeRound();
  const grown = ctx.resolvePageScope();
  assert.equal(grown.roots[0], main, 'the grown <main> was not recognised in the next round');
  assert.ok(grown.share >= ctx.MAIN_TEXT_SHARE);
  assert.equal(counts.body, 2);
  ctx.resolvePageScope();
  assert.equal(counts.body, 2);

  // 认出来的 <main> 跨轮有效：新的一轮不重数。
  ctx.beginScopeRound();
  assert.equal(ctx.resolvePageScope(), grown);
  assert.equal(counts.body, 2, 'a found <main> was recounted at the start of a round');

  // 根掉出文档：不管哪一轮，下一次问就重求。
  page.mainConnected = false;
  assert.equal(ctx.resolvePageScope().roots[0], body);
  assert.equal(counts.body, 2, 'no rendered <main> at all: nothing to count body against');
});

test('(c) what else drops the cache: a new key, or invalidatePageScope()', () => {
  const { ctx, counts, location } = load(SHELL);
  ctx.resolvePageScope();
  assert.equal(counts.body, 1);

  // 换页（单页路由改 URL）：键变了。
  location.href = 'https://news.example.com/b';
  ctx.resolvePageScope();
  assert.equal(counts.body, 2);

  // 改设置：键变了；'page' 模式不数字数。
  ctx.settings.pageTranslateScope = 'page';
  assert.equal(ctx.resolvePageScope().mode, 'page');
  ctx.settings.pageTranslateScope = 'main';
  ctx.resolvePageScope();
  assert.equal(counts.body, 3);

  // 整页入口、子 frame 换覆盖值走 invalidatePageScope()。
  ctx.invalidatePageScope();
  ctx.resolvePageScope();
  assert.equal(counts.body, 4);
  ctx.resolvePageScope();
  assert.equal(counts.body, 4);
});

// ---------------------------------------------------------------- 用户规则 include（P1-B §3.3）

// 一个 include 区域的桩：order 是文档顺序，children 是它包含的别的区域（父指针
// 跟着挂上）；shadowChildren 是它 shadow root 里的区域：composedParent 走得到，
// Node.contains 看不见。rects 数 getClientRects 被调了几次。
function region(order, { rendered = true, children = [], shadowChildren = [] } = {}) {
  const el = {
    order,
    isConnected: true,
    rects: 0,
    parent: null,
    getClientRects: () => {
      el.rects += 1;
      return rendered ? [{}] : [];
    },
    contains: (node) => children.some((child) => child === node || child.contains(node)),
    compareDocumentPosition: (other) => (other.order > order ? 4 : 2),
  };
  for (const child of [...children, ...shadowChildren]) child.parent = el;
  return el;
}

function withInclude(fixture, hits) {
  fixture.page.rule = { include: ['.faq'], exclude: [], keepOriginal: [], css: '', engine: null };
  fixture.page.ruleVersion += 1;
  fixture.page.includeHits = hits;
}

test('include: rendered hits become the roots, outermost only', () => {
  const fixture = load(SHELL);
  const inner = region(2);
  const outer = region(1, { children: [inner] });
  const hidden = region(3, { rendered: false });
  const other = region(4);
  withInclude(fixture, [outer, inner, hidden, other]);
  const scope = fixture.ctx.resolvePageScope();
  assert.equal(scope.mode, 'include');
  assert.deepEqual(scope.roots, [outer, other]);
  assert.equal(scope.skip, null, 'include regions are translated whole, nav and all');
  assert.equal(fixture.ctx.pageScopeMode(), 'include');
  assert.equal(fixture.counts.body, 0, 'include mode counted body');
});

test('the ladder: override page, then include, then setting page or builtin, then main', () => {
  const fixture = load(SHELL);
  const { ctx, page } = fixture;
  withInclude(fixture, [region(1)]);
  ctx.settings.pageTranslateScope = 'page';
  page.builtin = { match: 'news.example.com' };
  assert.equal(ctx.pageScopeMode(), 'include', 'include outranks the setting and the builtin table');
  ctx.state.pageScopeOverride = 'page';
  assert.equal(ctx.pageScopeMode(), 'page');
  assert.equal(ctx.resolvePageScope().mode, 'page', 'the whole-page entry outranks include');
  ctx.state.pageScopeOverride = null;
  page.includeHits = [];
  assert.equal(ctx.pageScopeMode(), 'page', 'zero hits fall through to the setting');
  ctx.settings.pageTranslateScope = 'main';
  assert.equal(ctx.pageScopeMode(), 'page', 'then to the builtin table');
  page.builtin = null;
  assert.equal(ctx.pageScopeMode(), 'main');
});

test('include with zero hits is not cached: a region that renders later is picked up', () => {
  const fixture = load(SHELL);
  const { ctx, page } = fixture;
  withInclude(fixture, []);
  assert.equal(ctx.resolvePageScope().mode, 'main');
  const late = region(1);
  page.includeHits = [late];
  // 同一轮、同一个键：没有 beginScopeRound()，也没有 invalidatePageScope()。
  // 退下去的答案照样缓存，但零命中不算结果，取用前要再问一次 include。
  const scope = ctx.resolvePageScope();
  assert.equal(scope.mode, 'include', 'a zero-hit answer was cached');
  assert.deepEqual(scope.roots, [late]);
});

test('include is cached while its regions stay connected, and the rule version is in the key', () => {
  const fixture = load(SHELL);
  const { ctx, page } = fixture;
  const first = region(1);
  withInclude(fixture, [first]);
  const scope = ctx.resolvePageScope();
  page.includeHits = [region(2)];
  assert.equal(ctx.resolvePageScope(), scope, 'a connected include scope was recomputed');
  first.isConnected = false;
  assert.notEqual(ctx.resolvePageScope(), scope);
  const again = ctx.resolvePageScope();
  page.includeHits = [region(3)];
  page.ruleVersion += 1;
  assert.notEqual(ctx.resolvePageScope(), again, 'a new rule set did not change the key');
  page.rule = null;
  page.ruleVersion += 1;
  assert.equal(ctx.resolvePageScope().mode, 'main');
});

test('every scope round remounts the rule CSS', () => {
  const { ctx, counts } = load(SHELL);
  ctx.beginScopeRound();
  ctx.beginScopeRound();
  assert.equal(counts.cssRounds, 2);
});

test('include starts: inside a region, containing regions, disjoint', () => {
  const fixture = load(SHELL);
  const { ctx } = fixture;
  const leaf = region(2);
  const a = region(1, { children: [leaf] });
  const b = region(5);
  withInclude(fixture, [b, a]);
  const scope = ctx.resolvePageScope();
  // 数组在 vm 的上下文里造出来，原型不是这边的 Array：展开成本域数组再比。
  const starts = (dirty) => [...ctx.pageScopeStarts(dirty, scope)];
  assert.deepEqual(starts(leaf), [leaf], 'a dirty root inside a region is itself');
  const wrapper = region(0, { children: [a, b] });
  assert.deepEqual(starts(wrapper), [a, b], 'the regions it contains, in document order');
  assert.deepEqual(starts(region(9)), [], 'a dirty root outside every region');
});

test('outsidePageScope is only ever true in include mode', () => {
  const fixture = load(SHELL);
  const { ctx } = fixture;
  const leaf = region(2);
  const a = region(1, { children: [leaf] });
  const stray = region(9);
  assert.equal(ctx.outsidePageScope(stray, ctx.resolvePageScope()), false, 'main mode');
  withInclude(fixture, [a]);
  const scope = ctx.resolvePageScope();
  assert.equal(ctx.outsidePageScope(leaf, scope), false);
  assert.equal(ctx.outsidePageScope(a, scope), false);
  assert.equal(ctx.outsidePageScope(stray, scope), true);
  assert.equal(ctx.outsidePageScope(stray, null), false);
});

test('a recognised <main> is cached across rounds, yet a late include region still wins', () => {
  const fixture = load({ bodyChars: 100, mainChars: 80 });
  const { ctx, page, main, counts } = fixture;
  withInclude(fixture, []);
  assert.equal(ctx.resolvePageScope().roots[0], main);
  ctx.beginScopeRound();
  assert.equal(ctx.resolvePageScope().roots[0], main);
  assert.equal(counts.body, 1, 'the found <main> was recounted');
  const late = region(1);
  page.includeHits = [late];
  assert.deepEqual(ctx.resolvePageScope().roots, [late]);
});

// F2：区域晚到时，退下去那几轮在区域外挂的译文，范围第一次切到 include 时收回。
test('a late include region recalls the translations the fallback rounds left outside it, once', () => {
  const fixture = load(SHELL);
  const { ctx, page, counts } = fixture;
  withInclude(fixture, []);
  assert.equal(ctx.resolvePageScope().mode, 'main');
  // 作废缓存不清「上一次是退下去的」这条记录。
  ctx.invalidatePageScope();
  assert.equal(ctx.resolvePageScope().mode, 'main');
  assert.equal(counts.sweeps, 0);

  const inside = region(2);
  const late = region(1, { children: [inside] });
  const outside = region(5);
  page.translated = [inside, outside];
  page.includeHits = [late];
  assert.equal(ctx.resolvePageScope().mode, 'include');
  assert.equal(counts.sweeps, 1);
  assert.deepEqual(page.released, [outside], 'only the translation outside the region is recalled');

  // 之后的解析（走缓存、作废之后重算、新的一轮）都不再清扫。
  ctx.resolvePageScope();
  ctx.invalidatePageScope();
  assert.equal(ctx.resolvePageScope().mode, 'include');
  ctx.beginScopeRound();
  ctx.resolvePageScope();
  assert.equal(counts.sweeps, 1);
});

test('switching to include after the whole-page override is cleared does not sweep', () => {
  const fixture = load(SHELL);
  const { ctx, page, counts } = fixture;
  withInclude(fixture, [region(1)]);
  ctx.state.pageScopeOverride = 'page';
  assert.equal(ctx.resolvePageScope().mode, 'page');
  page.translated = [region(5)];
  ctx.state.pageScopeOverride = null;
  ctx.invalidatePageScope();
  assert.equal(ctx.resolvePageScope().mode, 'include');
  assert.equal(counts.sweeps, 0, 'the user asked for the whole page; its translations stay');
  assert.deepEqual(page.released, []);
});

test('an include that hits at once never sweeps from here (recompute sweeps a rule change)', () => {
  const fixture = load(SHELL);
  const { ctx, counts } = fixture;
  assert.equal(ctx.resolvePageScope().mode, 'main');
  withInclude(fixture, [region(1)]);
  assert.equal(ctx.resolvePageScope().mode, 'include');
  assert.equal(counts.sweeps, 0);
});

for (const drop of ['invalidatePageScope', 'beginScopeRound']) test(`${drop}() between the fallback and the late hit still sweeps`, () => {
  const fixture = load(SHELL);
  const { ctx, page, counts } = fixture;
  withInclude(fixture, []);
  assert.equal(ctx.resolvePageScope().mode, 'main');
  const outside = region(5);
  page.translated = [outside];
  page.includeHits = [region(1)];
  // 区域出现后、下一次解析前，缓存先被作废：新的一轮（发现层的 flush），或者子
  // frame 跟顶层换了覆盖值。
  ctx[drop]();
  assert.equal(ctx.resolvePageScope().mode, 'include');
  assert.equal(counts.sweeps, 1);
  assert.deepEqual(page.released, [outside]);
});

// F9：只问「有没有命中」的地方遇到第一个就答；零命中的解析只查一次 include；去内层
// 命中沿 composedParent 走，跨 shadow 也认得。
test('pageScopeMode() stops at the first rendered include hit', () => {
  const fixture = load(SHELL);
  const hits = [region(1), region(2), region(3)];
  withInclude(fixture, hits);
  assert.equal(fixture.ctx.pageScopeMode(), 'include');
  assert.deepEqual(hits.map((each) => each.rects), [1, 0, 0]);
});

test('one resolvePageScope() with zero include hits queries include once', () => {
  const fixture = load(SHELL);
  withInclude(fixture, []);
  assert.equal(fixture.ctx.resolvePageScope().mode, 'main');
  assert.equal(fixture.counts.includeQueries, 1);
});

test('include roots: a hit inside another hit through a shadow root is dropped, whatever the order', () => {
  const fixture = load(SHELL);
  const inner = region(2);
  const host = region(1, { shadowChildren: [inner] });
  assert.equal(host.contains(inner), false, 'Node.contains does not cross the shadow root');
  withInclude(fixture, [inner, host]);
  assert.deepEqual([...fixture.ctx.resolvePageScope().roots], [host]);
});
