// 站点适配层：内置规则表里的两串选择器，怎么落到收集器手上。
//
// 这一组盯住的是**退化方向**。规则表是数据，会随版本更新，而
// `matches()` / `closest()` 收到写坏的选择器会当场抛 SyntaxError——它们在
// collect.js 的 processElement 热路径上，一抛就是整页零块：不报错、不重试、
// 页面静默翻不了。所以坏选择器必须在这一层被挡掉，而不是让它传到热路径上。
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = { AI_TRANSLATOR_CONTENT: {} };
globalThis.location = { hostname: 'example.com', pathname: '/' };
// 这一层唯一用到的 DOM 能力就是「这串选择器合法吗」，而合法与否由
// querySelector 抛不抛来回答——so 这就是整个假 DOM。
globalThis.document = {
  querySelector(selector) {
    if (typeof selector !== 'string' || selector.includes('((')) throw new SyntaxError(selector);
    return null;
  },
};

// 坏选择器会被这一层叫一声；断言在下面说话。
console.warn = () => {};

await import('../../shared/lang-tags.js');
await import('../../shared/site-rules-builtin.js');
await import('../../shared/site-rules.js');
await import('../../content/page/site-adapter.js');

const ctx = globalThis.window.AI_TRANSLATOR_CONTENT;
const realRules = globalThis.SiteRules;

function at(hostname, pathname = '/') {
  globalThis.location = { hostname, pathname };
  return ctx.resolveSiteAdapter();
}

function withRule(rule, run) {
  globalThis.SiteRules = { matchBuiltin: () => rule };
  try {
    return run();
  } finally {
    globalThis.SiteRules = realRules;
  }
}

test('a site in the builtin table hands over both selector strings', () => {
  const adapter = at('x.com', '/alice/status/1');
  assert.ok(adapter, 'x.com 在内置表里，应当有适配');
  assert.equal(adapter.atomic, '[data-testid="tweetText"]');
  assert.match(adapter.exclude, /User-Name/);
});

test('a subdomain gets the parent domain rule', () => {
  const adapter = at('www.reddit.com', '/r/rust/');
  assert.ok(adapter, 'www.reddit.com 应当命中 reddit.com 那条');
  assert.match(adapter.exclude, /faceplate-timeago/);
});

// 内置表里 arXiv 那几条都是按路径写的，而且**各带各的选择器**：摘要页的
// `blockquote.abstract`、全文页的 `.ltx_bibliography`、列表页的 `.list-authors`，
// 没有一个在别的路径下存在。串了就是每一块都白算一轮 closest()。
test('a path-scoped rule does not leak to the rest of the site', () => {
  assert.match(at('arxiv.org', '/abs/2401.00001').atomic, /blockquote\.abstract/);
  assert.match(at('arxiv.org', '/html/2310.03714v1').exclude, /ltx_bibliography/);
  assert.match(at('arxiv.org', '/list/cs.CL/recent').exclude, /list-authors/);
  assert.equal(at('arxiv.org', '/'), null, 'arXiv 首页不在任何一条规则下');
});

test('a site with no rule gets nothing, and the caller falls back to the generic path', () => {
  assert.equal(at('nowhere.example', '/'), null);
});

test('a malformed selector is dropped, and the rest of the rule survives', () => {
  const adapter = withRule({
    match: 'example.com',
    state: 'always',
    atomicBlockSelectors: ['div((', '.good'],
    excludeSelectors: ['((', '.fine'],
    blockIdAttr: null,
  }, () => at('example.com', '/one'));
  assert.equal(adapter.atomic, '.good');
  assert.equal(adapter.exclude, '.fine');
});

test('a rule whose selectors are all malformed reads as no rule at all', () => {
  const adapter = withRule({
    match: 'example.com',
    state: 'always',
    atomicBlockSelectors: ['div(('],
    excludeSelectors: [],
    blockIdAttr: null,
  }, () => at('example.com', '/two'));
  assert.equal(adapter, null);
});

// 单页应用换路由时没有重新注入内容脚本，缓存若只按 host 存，摘要页翻完再
// pushState 回列表页，列表页会继续套着摘要页的选择器。
test('the cache follows the path, not just the host', () => {
  const abs = at('arxiv.org', '/abs/2401.00001');
  assert.ok(abs);
  assert.equal(at('arxiv.org', '/'), null);
  assert.deepEqual(at('arxiv.org', '/abs/2401.00002'), abs);
});
