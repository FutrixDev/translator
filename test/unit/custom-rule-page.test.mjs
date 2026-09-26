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

// 计数：replaceSync 几次、adoptedStyleSheets 赋了几次值（F4）；onAdopt 让管线测试
// 把「挂 CSS」记进事件序列（M19）。
const sheetStats = { fills: 0, assigns: 0, onAdopt: null };

class FakeSheet {
  replaceSync(text) {
    sheetStats.fills += 1;
    this.text = text;
  }
}

function fakeDocument() {
  let list = [];
  return {
    get adoptedStyleSheets() {
      return list;
    },
    set adoptedStyleSheets(next) {
      sheetStats.assigns += 1;
      list = next;
      if (sheetStats.onAdopt) sheetStats.onAdopt(next);
    },
  };
}

/**
 * 装一份 custom-rule.js。rules：CUSTOM_RULES_FOR_HOST 回的那一包（带 id）。
 * 返回 ctx 与记录：订阅回调、清扫收回的元素、路由监听。
 */
function load({ rules = [], reply = { rules }, frameRole = 'top', href = 'https://example.com/news/1' } = {}) {
  const url = new URL(href);
  globalThis.location = { href, hostname: url.hostname, pathname: url.pathname };
  globalThis.document = fakeDocument();
  Object.assign(sheetStats, { fills: 0, assigns: 0, onAdopt: null });
  globalThis.CSSStyleSheet = FakeSheet;
  const routes = [];
  globalThis.SpaNavigation = { onRouteChange: (fn) => routes.push(fn) };
  const requests = [];
  globalThis.chrome = {
    runtime: {
      sendMessage: async (message) => {
        requests.push(message);
        return reply;
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

test('a reply without a rules list is a failed request, not an empty one', async () => {
  const warned = [];
  const realWarn = console.warn;
  console.warn = (...args) => warned.push(args.map(String).join(' '));
  try {
    for (const reply of [{}, { rules: 'a' }, { rules: { id: 'a' } }]) {
      warned.length = 0;
      const { rules } = load({ reply });
      rules.init();
      await rules.whenReady();
      assert.equal(rules.current(), null);
      assert.equal(warned.length, 1, JSON.stringify(reply));
      assert.match(warned[0], /mirror request failed.*CUSTOM_RULES_FOR_HOST reply has no rules list/);
    }
  } finally {
    console.warn = realWarn;
  }
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
  sheetStats.onAdopt = (list) => events.push(`adopt:${list.length}`);
  excluded = true;
  ctx.syncMirrors[0].onStorageChange(put('a', { ...RULE_A, css: '.ai-translator-inline-block { color: rgb(1, 2, 3) }' }));
  await sleep(DEBOUNCE_WAIT);
  assert.deepEqual(events, ['adopt:1', 'release:ad', 'changed', 'sheets:1'], 'CSS is mounted before the sweep');
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
  assert.equal(warned.length, 1, 'the change and the round after it are one warning');
  for (const line of warned) assert.doesNotMatch(line, /leak|127\.0\.0\.1|background/);
});

test('unsafe CSS warns once per rule and text: not per round, not per rebuilt object', async () => {
  const warned = [];
  const realWarn = console.warn;
  console.warn = (...args) => warned.push(args.map(String).join(' '));
  const unsafe = { ...RULE_A, css: 'body { background: url(http://127.0.0.1/leak) }' };
  try {
    const { rules, ctx } = load({ rules: [{ id: 'a', ...unsafe }] });
    rules.init();
    await rules.whenReady();
    rules.beginRound();
    rules.beginRound();
    assert.equal(warned.length, 1, 'two rounds on the same rule');

    // 镜像重建：同内容的新对象，版本变了，不再告警。
    ctx.syncMirrors[0].onStorageChange(put('a', { ...unsafe }));
    await sleep(DEBOUNCE_WAIT);
    rules.beginRound();
    assert.equal(warned.length, 1, 'the same text in a new object');

    // 同一条规则换一段不安全 CSS：再告警一次。
    ctx.syncMirrors[0].onStorageChange(put('a', { ...unsafe, css: '@import "http://127.0.0.1/x.css";' }));
    await sleep(DEBOUNCE_WAIT);
    rules.beginRound();
    assert.equal(warned.length, 2, 'new unsafe text');
  } finally {
    console.warn = realWarn;
  }
  assert.deepEqual(globalThis.document.adoptedStyleSheets, []);
});

test('the sheet is filled only when its text changes and assigned only when it is not last', async () => {
  const css = '.ai-translator-inline-block { color: rgb(1, 2, 3) }';
  const { rules, ctx } = load({ rules: [{ id: 'a', ...RULE_A, css }] });
  rules.init();
  await rules.whenReady();
  rules.beginRound();
  rules.beginRound();
  assert.equal(sheetStats.fills, 1, 'the arrival fills it once');
  assert.equal(sheetStats.assigns, 1, 'and adopts it once');
  const [ours] = globalThis.document.adoptedStyleSheets;

  // 页面把列表整个换掉：下一轮挂回最后，页面自己的 sheet 留着，不重填。
  const pageSheet = { page: true };
  globalThis.document.adoptedStyleSheets = [pageSheet];
  const pageAssigns = sheetStats.assigns;
  rules.beginRound();
  assert.deepEqual(globalThis.document.adoptedStyleSheets, [pageSheet, ours]);
  assert.equal(sheetStats.assigns, pageAssigns + 1);
  assert.equal(sheetStats.fills, 1);

  // 页面把一张新的排在我们后面：挪回最后。
  const later = { page: 'later' };
  globalThis.document.adoptedStyleSheets = [pageSheet, ours, later];
  rules.beginRound();
  assert.deepEqual(globalThis.document.adoptedStyleSheets, [pageSheet, later, ours]);

  // CSS 清空：摘掉一次，之后的轮次不再赋值。
  ctx.syncMirrors[0].onStorageChange(put('a', RULE_A));
  await sleep(DEBOUNCE_WAIT);
  assert.deepEqual(globalThis.document.adoptedStyleSheets, [pageSheet, later]);
  const cleared = sheetStats.assigns;
  rules.beginRound();
  rules.beginRound();
  assert.equal(sheetStats.assigns, cleared, 'nothing to remove, nothing assigned');
});

test('a catch-up round runs only after a manual translation the scheduler is not following', async () => {
  const fixture = load({ rules: [{ id: 'a', ...RULE_A }] });
  const { rules, ctx, events } = fixture;
  ctx.beginScopeRound = () => events.push('round');
  ctx.collectPageBlocks = () => ['block'];
  ctx.filterBlocksByLanguage = async (blocks) => blocks;
  ctx.runTranslationPass = async (blocks) => {
    events.push(`pass:${blocks.length}:${ctx.state.isTranslatingPage}:${ctx.customRules.isCatchingUp()}`);
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

  // 翻过、调度器没在跟：补一轮。这一轮举的是补翻自己的旗标（isCatchingUp），
  // 手动整页翻译的 isTranslatingPage 不动；完了复原。
  following = false;
  events.length = 0;
  ctx.syncMirrors[0].onStorageChange(put('a', { ...RULE_A, exclude: ['.d'] }));
  await sleep(DEBOUNCE_WAIT);
  assert.deepEqual(events, ['round', 'changed', 'pass:1:false:true']);
  assert.equal(ctx.state.isTranslatingPage, false);
  assert.equal(rules.isCatchingUp(), false);
});

// ---------------------------------------------------------------- 轮次收尾（afterRound）

/**
 * 装好规则、接上收块 / 送翻的桩；runTranslationPass 停住由测试放行。
 * sweeps 数清扫走了几次 queryAllDeep。
 */
async function loadRounds({ following = false } = {}) {
  const fixture = load({ rules: [{ id: 'a', ...RULE_A }] });
  const { ctx, events } = fixture;
  const held = [];
  let sweeps = 0;
  const query = ctx.queryAllDeep;
  ctx.queryAllDeep = (...args) => {
    sweeps += 1;
    return query(...args);
  };
  ctx.beginScopeRound = () => events.push('round');
  ctx.collectPageBlocks = () => ['block'];
  ctx.filterBlocksByLanguage = async (blocks) => blocks;
  ctx.runTranslationPass = () => new Promise((resolve) => {
    events.push(`pass:${ctx.state.isTranslatingPage}:${ctx.customRules.isCatchingUp()}`);
    held.push(() => resolve(null));
  });
  ctx.autoTranslate.isOn = () => following;
  fixture.rules.init();
  await fixture.rules.whenReady();
  ctx.state.pageHasBeenTranslated = true;
  events.length = 0;
  const change = async (exclude) => {
    ctx.syncMirrors[0].onStorageChange(put('a', { ...RULE_A, exclude }));
    await sleep(DEBOUNCE_WAIT);
  };
  const finish = async (n) => {
    held[n - 1]();
    await sleep(0);
  };
  return { ...fixture, held, change, finish, sweeps: () => sweeps };
}

test('a manual round that saw a rule change recalls, when it ends, a late translation in the new excluded area', async () => {
  const { ctx, rules, events, translated, change } = await loadRounds({ following: true });
  ctx.state.isTranslatingPage = true;
  // 规则变化时那一块还在路上：当场的清扫看不见它。
  let excluded = false;
  await change(['.ad', '.late']);
  excluded = true;
  assert.deepEqual(events, ['changed']);

  translated.push({ name: 'late', forbidden: () => excluded });
  ctx.state.isTranslatingPage = false;
  rules.afterRound();
  assert.deepEqual(events, ['changed', 'release:late']);
  assert.equal(rules.isCatchingUp(), false, 'the scheduler is following: no catch-up round');
});

test('a manual round that saw an exclude removed (scheduler off) opens a catch-up round when it ends', async () => {
  const { ctx, rules, events, change } = await loadRounds();
  ctx.state.isTranslatingPage = true;
  await change([]);
  assert.deepEqual(events, ['changed'], 'no catch-up round while the manual round runs');

  ctx.state.isTranslatingPage = false;
  rules.afterRound();
  await sleep(0);
  assert.deepEqual(events, ['changed', 'round', 'pass:false:true']);
});

test('no catch-up round during a round; afterRound() with nothing pending neither sweeps nor translates', async () => {
  const { ctx, rules, events, change, finish, sweeps } = await loadRounds();
  await change(['.b']);
  assert.deepEqual(events, ['round', 'changed', 'pass:false:true']);

  // 补翻轮进行中再改一次：不叠第二轮。
  await change(['.c']);
  assert.deepEqual(events, ['round', 'changed', 'pass:false:true', 'changed']);

  // 补翻轮收尾：补做清扫，再补一轮（变化发生在这一轮收块之后）。
  const before = sweeps();
  await finish(1);
  assert.equal(sweeps(), before + 1);
  assert.deepEqual(events.slice(4), ['round', 'pass:false:true']);
  await finish(2);
  assert.equal(rules.isCatchingUp(), false);

  // 没有待补：什么都不做。
  const quiet = sweeps();
  const length = events.length;
  ctx.state.isTranslatingPage = false;
  rules.afterRound();
  rules.afterRound();
  await sleep(0);
  assert.equal(sweeps(), quiet, 'afterRound() swept with nothing pending');
  assert.equal(events.length, length);
});

test('a catch-up round that ends with a manual round waiting starts no second catch-up', async () => {
  const { ctx, rules, events, change, finish, sweeps } = await loadRounds();
  await change(['.b']);
  assert.deepEqual(events, ['round', 'changed', 'pass:false:true']);

  // 补翻轮进行中：规则又变了，同时一下手动整页翻译在等它（F3）。
  await change(['.c']);
  ctx.state.isTranslatingPage = true;
  const before = sweeps();
  await finish(1);
  assert.equal(sweeps(), before + 1, 'the pending sweep still runs');
  assert.equal(rules.isCatchingUp(), false);
  assert.deepEqual(events, ['round', 'changed', 'pass:false:true', 'changed'], 'the waiting manual round takes over');

  // 手动轮结束：待补已经做完，不再补。
  ctx.state.isTranslatingPage = false;
  rules.afterRound();
  await sleep(0);
  assert.equal(rules.isCatchingUp(), false);
  assert.equal(events.length, 4);
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

// 「调度器在不在跟」两种拼法：肯定式 `=== IDLE || === RUNNING`，否定式
// `!== IDLE && !== RUNNING`，两个名字谁先都算。同一个名字前后比两次（child.js 的
// `was === RUNNING && status !== RUNNING`，问的是「刚跑完」）不算。
const SPELLED_OUT = /STATUS\.IDLE\s*(\|\||&&)[^\n]*STATUS\.RUNNING|STATUS\.RUNNING\s*(\|\||&&)[^\n]*STATUS\.IDLE/g;

test('the IDLE/RUNNING scan catches both spellings', () => {
  const samples = [
    'return status === STATUS.IDLE || status === STATUS.RUNNING;',
    'if (status !== STATUS.IDLE && status !== STATUS.RUNNING) return;',
    'const on = status === STATUS.RUNNING || status === STATUS.IDLE;',
  ];
  for (const sample of samples) assert.equal((sample.match(SPELLED_OUT) || []).length, 1, sample);
  for (const other of [
    'if (status === STATUS.IDLE) return;',
    'if (was === STATUS.RUNNING && snap.status !== STATUS.RUNNING) {',
  ]) assert.equal((other.match(SPELLED_OUT) || []).length, 0, other);
});

test('"is the scheduler following this page" is asked in one place: autoTranslate.isOn()', () => {
  const content = contentSource();
  const direct = content.match(SPELLED_OUT) || [];
  assert.equal(direct.length, 1, `IDLE/RUNNING spelled out more than once: ${direct.join(' | ')}`);
  assert.match(content, /function isOn\(\) \{\n\s*return status === STATUS\.IDLE \|\| status === STATUS\.RUNNING;/);
  assert.match(content, /return ctx\.autoTranslate\.isOn\(\) \|\| !!state\.isTranslatingPage;/, 'frames/top.js');
  assert.match(content, /ctx\.autoTranslate && ctx\.autoTranslate\.isOn\(\)/, 'custom-rule.js');
});
