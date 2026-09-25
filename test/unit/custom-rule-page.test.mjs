// 本页的用户站点规则（content/page/custom-rule.js，ctx.customRules），以及它两头
// 的接线：bootstrap 把 sync 增量按前缀分给它，调度器 / frames/top.js 订阅它。
//
// custom-rule.js 在真的 CustomRules / SyncCollection 上跑（镜像、防抖、按主机过滤
// 都是真的），只把浏览器那几样换成桩：chrome.runtime（CUSTOM_RULES_FOR_HOST 的
// 回话）、location、adoptedStyleSheets、SpaNavigation。每条测试 new Function
// 重新求值一份（CJS 缓存不认查询串，import 拿不到新闭包）。
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { contentBundle } from './helpers/sources.mjs';

await import('../../shared/lang-tags.js');
await import('../../shared/site-rules-builtin.js');
await import('../../shared/storage-writer.js');
await import('../../shared/site-rules.js');
await import('../../shared/sync-collection.js');
await import('../../shared/custom-rules.js');

const repoFile = (rel) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');
const SOURCE = repoFile('content/page/custom-rule.js');
const DEBOUNCE_WAIT = 220;
// 整个内容脚本 bundle（manifest 里那一份清单），接线断言问的是它，不是某个文件。
const contentSource = () => contentBundle().map(repoFile).join('\n');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const RULE_A = { v: 1, match: ['example.com'], exclude: ['.ad'], updatedAt: 1 };
const RULE_DOCS = { v: 1, match: ['example.com/docs/*'], exclude: ['.toc'], updatedAt: 1 };
const RULE_OTHER = { v: 1, match: ['other.org'], exclude: ['.x'], updatedAt: 1 };

class FakeSheet {
  replaceSync(text) {
    this.text = text;
  }
}

/**
 * 装一份 custom-rule.js。rules：CUSTOM_RULES_FOR_HOST 回的那一包（带 id）。
 * 返回 ctx 与记录：订阅回调、清扫收回的元素、路由监听。
 */
function load({ rules = [], frameRole = 'top', href = 'https://example.com/news/1' } = {}) {
  const url = new URL(href);
  globalThis.location = { href, hostname: url.hostname, pathname: url.pathname };
  globalThis.document = { adoptedStyleSheets: [] };
  globalThis.CSSStyleSheet = FakeSheet;
  const routes = [];
  globalThis.SpaNavigation = { onRouteChange: (fn) => routes.push(fn) };
  const requests = [];
  globalThis.chrome = {
    runtime: {
      sendMessage: async (message) => {
        requests.push(message);
        return { rules };
      },
    },
  };
  const events = [];
  const translated = [];
  const ctx = {
    frameRole,
    state: { pageHasBeenTranslated: false, isTranslatingPage: false },
    syncMirrors: [],
    autoTranslate: { isOn: () => true },
    resolvePageScope: () => ({ mode: 'main' }),
    queryAllDeep: () => translated,
    ruleForbids: (el) => el.forbidden(),
    releaseTranslation: (el) => events.push(`release:${el.name}`),
  };
  globalThis.window = { AI_TRANSLATOR_CONTENT: ctx };
  new Function(SOURCE)();
  const rulesApi = ctx.customRules;
  rulesApi.onChange(() => events.push('changed'));
  return { ctx, rules: rulesApi, events, routes, requests, translated };
}

function navigate(fixture, href) {
  const url = new URL(href);
  Object.assign(globalThis.location, { href, hostname: url.hostname, pathname: url.pathname });
  for (const fn of fixture.routes) fn();
}

const put = (id, value) => ({ [`customRule:${id}`]: { newValue: value } });

test('before init: no rule, no engine, ready at once, nothing registered', async () => {
  const { rules, ctx, requests } = load({ rules: [{ id: 'a', ...RULE_A }] });
  assert.equal(rules.current(), null);
  assert.equal(rules.engineOverride(), null);
  assert.equal(rules.version, 0);
  await rules.whenReady();
  assert.equal(ctx.syncMirrors.length, 0);
  assert.equal(requests.length, 0);
  rules.beginRound();
  assert.deepEqual(globalThis.document.adoptedStyleSheets, [], 'no rule, no sheet');
});

test('init asks once, registers the customRule: prefix, and the winning rule answers', async () => {
  const fixture = load({ rules: [{ id: 'a', ...RULE_A, engine: 'ai' }] });
  const { rules, ctx, requests, events } = fixture;
  rules.init();
  rules.init();
  await rules.whenReady();
  assert.deepEqual(requests, [{ type: 'CUSTOM_RULES_FOR_HOST' }]);
  assert.equal(ctx.syncMirrors.length, 1);
  assert.equal(ctx.syncMirrors[0].prefix, 'customRule:');
  assert.equal(rules.current().id, 'a');
  assert.deepEqual(rules.current().exclude, ['.ad']);
  assert.deepEqual(rules.current().include, [], 'missing groups are filled in');
  assert.equal(rules.engineOverride(), 'ai');
  assert.equal(events.filter((e) => e === 'changed').length, 1, 'the arrival is one change');
});

test('a change to another host is no change here; a change to this page is exactly one', async () => {
  const fixture = load({ rules: [{ id: 'a', ...RULE_A }] });
  const { rules, ctx, events } = fixture;
  rules.init();
  await rules.whenReady();
  events.length = 0;

  ctx.syncMirrors[0].onStorageChange(put('o', RULE_OTHER));
  await sleep(DEBOUNCE_WAIT);
  assert.deepEqual(events, [], 'another host woke the page');

  ctx.syncMirrors[0].onStorageChange(put('a', { ...RULE_A, exclude: ['.ad', '.promo'] }));
  ctx.syncMirrors[0].onStorageChange(put('a', { ...RULE_A, exclude: ['.ad', '.promo', '.foot'] }));
  await sleep(DEBOUNCE_WAIT);
  assert.deepEqual(events, ['changed'], 'two deltas in one burst are one change');
  assert.deepEqual(rules.current().exclude, ['.ad', '.promo', '.foot']);
});

test('a route change re-picks: a different rule is a change, the same rule is not', async () => {
  const fixture = load({ rules: [{ id: 'a', ...RULE_A }, { id: 'd', ...RULE_DOCS }] });
  const { rules, events } = fixture;
  rules.init();
  await rules.whenReady();
  events.length = 0;
  navigate(fixture, 'https://example.com/news/2');
  assert.deepEqual(events, [], 'the same rule still wins');
  navigate(fixture, 'https://example.com/docs/intro');
  assert.deepEqual(events, ['changed']);
  assert.equal(rules.current().id, 'd');
});

test('the pipeline: CSS, then the sweep, then the subscribers', async () => {
  const fixture = load({ rules: [{ id: 'a', ...RULE_A }] });
  const { rules, ctx, events, translated } = fixture;
  rules.init();
  await rules.whenReady();
  events.length = 0;
  let excluded = false;
  translated.push(
    { name: 'kept', forbidden: () => false },
    { name: 'ad', forbidden: () => excluded },
  );
  rules.onChange(() => events.push(`sheets:${globalThis.document.adoptedStyleSheets.length}`));
  excluded = true;
  ctx.syncMirrors[0].onStorageChange(put('a', { ...RULE_A, css: '.ai-translator-inline-block { color: rgb(1, 2, 3) }' }));
  await sleep(DEBOUNCE_WAIT);
  assert.deepEqual(events, ['release:ad', 'changed', 'sheets:1']);
  const [sheet] = globalThis.document.adoptedStyleSheets;
  assert.match(sheet.text, /rgb\(1, 2, 3\)/);

  // CSS 去掉：那一张 sheet 摘下来。
  ctx.syncMirrors[0].onStorageChange(put('a', RULE_A));
  await sleep(DEBOUNCE_WAIT);
  assert.deepEqual(globalThis.document.adoptedStyleSheets, []);
});

test('unsafe CSS is never mounted, and the log carries no rule content', async () => {
  const warned = [];
  const realWarn = console.warn;
  console.warn = (...args) => warned.push(args.map(String).join(' '));
  try {
    const fixture = load({ rules: [{ id: 'a', ...RULE_A }] });
    const { rules, ctx } = fixture;
    rules.init();
    await rules.whenReady();
    // 写入时已经挡过；这里模拟一条绕过写入口、直接落进 sync 的规则。
    ctx.syncMirrors[0].onStorageChange(put('a', { ...RULE_A, css: 'body { background: url(http://127.0.0.1/leak) }' }));
    await sleep(DEBOUNCE_WAIT);
    rules.beginRound();
  } finally {
    console.warn = realWarn;
  }
  assert.deepEqual(globalThis.document.adoptedStyleSheets, []);
  assert.ok(warned.length >= 1);
  for (const line of warned) assert.doesNotMatch(line, /leak|127\.0\.0\.1|background/);
});

test('a catch-up round runs only after a manual translation the scheduler is not following', async () => {
  const fixture = load({ rules: [{ id: 'a', ...RULE_A }] });
  const { rules, ctx, events } = fixture;
  ctx.beginScopeRound = () => events.push('round');
  ctx.collectPageBlocks = () => ['block'];
  ctx.filterBlocksByLanguage = async (blocks) => blocks;
  ctx.runTranslationPass = async (blocks) => {
    events.push(`pass:${blocks.length}:${ctx.state.isTranslatingPage}`);
    return null;
  };
  let following = true;
  ctx.autoTranslate.isOn = () => following;
  rules.init();
  await rules.whenReady();
  events.length = 0;

  // 没翻过：不补。
  ctx.syncMirrors[0].onStorageChange(put('a', { ...RULE_A, exclude: ['.b'] }));
  await sleep(DEBOUNCE_WAIT);
  assert.deepEqual(events, ['changed']);

  // 翻过、调度器在跟：由调度器重启接手，不补。
  ctx.state.pageHasBeenTranslated = true;
  events.length = 0;
  ctx.syncMirrors[0].onStorageChange(put('a', { ...RULE_A, exclude: ['.c'] }));
  await sleep(DEBOUNCE_WAIT);
  assert.deepEqual(events, ['changed']);

  // 翻过、调度器没在跟：补一轮，isTranslatingPage 在这一轮里是 true，完了复原。
  following = false;
  events.length = 0;
  ctx.syncMirrors[0].onStorageChange(put('a', { ...RULE_A, exclude: ['.d'] }));
  await sleep(DEBOUNCE_WAIT);
  assert.deepEqual(events, ['round', 'changed', 'pass:1:true']);
  assert.equal(ctx.state.isTranslatingPage, false);
});

test('a child frame takes the engine from the directive, not from its own rule', async () => {
  const fixture = load({ frameRole: 'child', rules: [{ id: 'a', ...RULE_A, engine: 'builtin' }] });
  const { rules, events } = fixture;
  rules.init();
  await rules.whenReady();
  assert.equal(rules.engineOverride(), null, 'its own rule named an engine');
  events.length = 0;
  rules.inherit('ai');
  assert.deepEqual(events, ['changed']);
  assert.equal(rules.engineOverride(), 'ai');
  rules.inherit('ai');
  assert.deepEqual(events, ['changed'], 'the same directive twice is one change');
  rules.inherit(null);
  assert.deepEqual(events, ['changed', 'changed']);
  assert.equal(rules.engineOverride(), null);
});

// ---------------------------------------------------------------- 两头的接线

// bootstrap 里那一段按前缀分流的函数，原样拿出来跑。
function routeSyncMirrorsOf(ctx) {
  const source = repoFile('content/content-bootstrap.js');
  const start = source.indexOf('  function routeSyncMirrors(changes) {');
  assert.ok(start > 0, 'routeSyncMirrors moved');
  const end = source.indexOf('\n  }\n', start);
  return new Function('ctx', `${source.slice(start, end + 4)}\nreturn routeSyncMirrors;`)(ctx);
}

test('bootstrap: prefixed keys go to their mirror and never into settings', () => {
  const got = [];
  const ctx = { syncMirrors: [{ prefix: 'customRule:', onStorageChange: (part) => got.push(part) }] };
  const route = routeSyncMirrorsOf(ctx);
  const changes = {
    'customRule:a': { newValue: RULE_A },
    targetLang: { newValue: 'ja' },
    'customRule:b': { newValue: undefined },
  };
  const rest = route(changes);
  assert.deepEqual(Object.keys(rest), ['targetLang']);
  assert.deepEqual(got, [{ 'customRule:a': changes['customRule:a'], 'customRule:b': changes['customRule:b'] }]);
  // 没有前缀键：整包原样返回，镜像不被叫。
  got.length = 0;
  assert.deepEqual(route({ theme: { newValue: 'dark' } }), { theme: { newValue: 'dark' } });
  assert.deepEqual(got, []);
});

test('bootstrap: routing happens before settings are written, and names no collection', () => {
  const source = repoFile('content/content-bootstrap.js');
  const routed = source.indexOf('changes = routeSyncMirrors(changes);');
  const written = source.indexOf('ctx.settings[key] = changes[key].newValue;');
  assert.ok(routed > 0 && written > routed, 'settings are written before the collections are routed out');
  assert.doesNotMatch(source, /customRule:/);
  assert.match(source, /ctx\.syncMirrors = \[\];/);
});

test('subscribers: the scheduler restarts and the top frame re-broadcasts on a rule change', () => {
  const content = contentSource();
  assert.match(content, /ctx\.customRules\.onChange\(\(\) => start\('custom-rule'\)\);/);
  assert.match(content, /ctx\.customRules\.onChange\(refreshDirective\);/);
  // 指令带上引擎覆盖，比较也比它：只改规则引擎的变化也要广播。
  assert.match(content, /engineOverride: ctx\.customRules\.engineOverride\(\) \|\| null,/);
  assert.match(content, /&& a\.engineOverride === b\.engineOverride/);
  assert.match(content, /ctx\.customRules\.inherit\(next\.engineOverride \?\? null\);/);
});

test('"is the scheduler following this page" is asked in one place: autoTranslate.isOn()', () => {
  const content = contentSource();
  const direct = content.match(/STATUS\.(IDLE|RUNNING) \|\| [^\n]*STATUS\.(IDLE|RUNNING)/g) || [];
  assert.equal(direct.length, 1, `IDLE/RUNNING spelled out more than once: ${direct.join(' | ')}`);
  assert.match(content, /function isOn\(\) \{\n\s*return status === STATUS\.IDLE \|\| status === STATUS\.RUNNING;/);
  assert.match(content, /return ctx\.autoTranslate\.isOn\(\) \|\| !!state\.isTranslatingPage;/, 'frames/top.js');
  assert.match(content, /ctx\.autoTranslate && ctx\.autoTranslate\.isOn\(\)/, 'custom-rule.js');
});
