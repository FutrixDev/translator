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
  const counts = { body: 0 };
  const registrations = [];
  const page = { bodyChars, mainChars, mainConnected: true };

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
  };
  const sandbox = {
    console,
    location: { href: 'https://news.example.com/a', hostname: 'news.example.com', pathname: '/a' },
    document: {
      body,
      querySelectorAll: () => (page.mainConnected ? [main] : []),
    },
    SiteRules: { matchBuiltin: () => null },
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
