// 规则变化补的那一轮（content/page/custom-rule.js 的 catchUpRound，设计 §3.6 第 3 步）
// 和别的轮次之间的边界：
//
//   - 它举自己的旗标（isCatchingUp / whenCaughtUp），不碰手动整页翻译的
//     state.isTranslatingPage：顶层指令（frames/top.js）不因它变成「翻」，「翻译整页」
//     也不因它走忙分支；
//   - 手动整页翻译等它收完再收块，这一下点击不丢；
//   - 调度器的 pump 等它收完再收块；
//   - 手动轮进行中规则变了，那一轮结束时补做清扫（afterRound）。
//
// 前两组在同一个 ctx 里装真实的 custom-rule.js、scope.js、frames/top.js 与
// content-page-translation.js，只把收块、送翻、进度条、chrome 这几样换成桩。pump
// 那一组在 vm 里装真实的 content-auto-translate.js。
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

await import('../../shared/lang-tags.js');
await import('../../shared/site-rules-builtin.js');
await import('../../shared/storage-writer.js');
await import('../../shared/site-rules.js');
await import('../../shared/sync-collection.js');
await import('../../shared/custom-rules.js');

const repoFile = (rel) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');
const PAGE_SOURCES = [
  'content/page/custom-rule.js',
  'content/page/scope.js',
  'content/frames/top.js',
  'content/content-page-translation.js',
].map(repoFile);
const DEBOUNCE_WAIT = 220;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const put = (id, value) => ({ [`customRule:${id}`]: { newValue: value } });

const RULE = { id: 'a', v: 1, match: ['example.com'], exclude: ['.ad'], updatedAt: 1 };

/**
 * 顶层 frame：自动翻译关着（调度器不在跟）、整页翻过一次、本页有一条规则。
 * 每一次 runTranslationPass 都停住，由测试放行（release）。
 * holdRules：CUSTOM_RULES_FOR_HOST 的回话先不给，由测试 answerRules() 放行；这时
 * 不等规则到、也不算「整页翻过」。
 */
async function loadTopFrame({ holdRules = false } = {}) {
  const href = 'https://example.com/news/1';
  const url = new URL(href);
  globalThis.location = { href, hostname: url.hostname, pathname: url.pathname };
  let progress = null;
  const body = { localName: 'body' };
  globalThis.document = {
    adoptedStyleSheets: [],
    body,
    querySelectorAll: () => [],
    getElementById: (id) => (id === 'ai-translator-progress' ? progress : null),
  };
  globalThis.CSSStyleSheet = class { replaceSync() {} };
  globalThis.SpaNavigation = { onRouteChange() {} };
  const listeners = [];
  let answerRules = null;
  const rulesReply = holdRules
    ? new Promise((resolve) => { answerRules = () => resolve({ rules: [RULE] }); })
    : Promise.resolve({ rules: [RULE] });
  globalThis.chrome = {
    runtime: {
      sendMessage: () => rulesReply,
      onMessage: { addListener: (fn) => listeners.push(fn) },
    },
  };

  const log = [];
  const passes = [];
  const broadcasts = [];
  const translated = [];
  const counts = { explicit: 0, hint: 0, errors: 0 };
  const ctx = {
    frameRole: 'top',
    t: (key) => key,
    settings: { pageTranslateScope: 'main' },
    state: {
      pageHasBeenTranslated: false,
      isTranslatingPage: false,
      translationsVisible: true,
      pageScopeOverride: null,
      translationProgress: { current: 0, total: 0 },
    },
    syncMirrors: [],
    frames: { sendToRelay: (message) => broadcasts.push(message.directive) },
    autoTranslate: {
      isOn: () => false,
      onStateChange: (fn) => fn(),
      markPageExplicit: () => { counts.explicit += 1; },
    },
    isExtensionContextAvailable: () => true,
    revealHiddenTranslations() {},
    showPageTranslationProgress: () => { progress = { shown: true }; },
    hidePageTranslationProgress: () => { progress = null; },
    updatePageTranslationProgress: (done, total) => log.push(`progress:${done}/${total}`),
    showTranslatingHint: () => { counts.hint += 1; },
    showTranslationError: () => { counts.errors += 1; },
    showPageNotice: (text) => log.push(`notice:${text}`),
    getManagedSkipCount: () => 0,
    filterBlocksByLanguage: async (blocks) => blocks,
    collectTranslatableBlocks: (root, { scope }) => {
      log.push(`collect:${scope.mode}`);
      return [{ element: {}, text: 'x' }];
    },
    queryAllDeep: () => translated,
    ruleForbids: (el) => el.forbidden(),
    releaseTranslation: (el) => log.push(`release:${el.name}`),
    runTranslationPass: (blocks, options = {}) => new Promise((resolve) => {
      const n = passes.length + 1;
      log.push(`pass:${n}`);
      passes.push(() => {
        if (options.onProgress) options.onProgress(blocks.length);
        resolve(null);
      });
    }),
  };
  globalThis.window = { AI_TRANSLATOR_CONTENT: ctx, length: 1 };
  for (const source of PAGE_SOURCES) new Function(source)();

  ctx.customRules.init();
  if (!holdRules) {
    await ctx.customRules.whenReady();
    // 规则装载完之后才算「整页翻过」：装载本身不该起补翻轮。
    ctx.state.pageHasBeenTranslated = true;
  }
  ctx.frames.setup();
  assert.equal(listeners.length, 1, 'top.js listens to its children');

  let child = 0;
  // 一个新的子 frame 登记，拿到的是顶层此刻的指令。
  const hello = () => {
    let reply;
    listeners[0]({ type: 'FRAME_CHILD_HELLO', documentId: `child-${++child}` }, {}, (value) => { reply = value; });
    return reply;
  };
  const changeRule = async (fields) => {
    ctx.syncMirrors[0].onStorageChange(put('a', { ...RULE, ...fields }));
    await sleep(DEBOUNCE_WAIT);
  };
  const release = async (n) => {
    passes[n - 1]();
    await sleep(0);
  };
  return {
    ctx, log, passes, broadcasts, translated, counts, hello, changeRule, release, answerRules,
    progress: () => progress,
  };
}

test('a catch-up round leaves the top frame directive at "do not translate", before, during and after', async () => {
  const top = await loadTopFrame();
  const { ctx, broadcasts, hello, changeRule, release } = top;
  assert.equal(hello().translate, false, 'before');

  await changeRule({ exclude: ['.b'] });
  assert.equal(ctx.customRules.isCatchingUp(), true, 'the rule change started a catch-up round');
  assert.equal(ctx.state.isTranslatingPage, false);
  assert.equal(hello().translate, false, 'during');

  await release(1);
  await ctx.customRules.whenCaughtUp();
  assert.equal(ctx.customRules.isCatchingUp(), false);
  assert.equal(hello().translate, false, 'a frame that registers after the round');
  assert.ok(broadcasts.length >= 1);
  for (const directive of broadcasts) assert.equal(directive.translate, false, JSON.stringify(directive));
});

test('translatePage() collects nothing until this page\'s rules have arrived', async () => {
  const top = await loadTopFrame({ holdRules: true });
  const { ctx, log, answerRules } = top;
  ctx.translatePage();
  await sleep(10);
  assert.equal(ctx.state.isTranslatingPage, true, 'the click started a round');
  assert.deepEqual(log, [], 'the round collected before the rules arrived');
  answerRules();
  await sleep(10);
  assert.deepEqual(log, ['collect:main', 'pass:1'], 'the round collects once the rules are ready');
  assert.deepEqual(ctx.customRules.current().exclude, ['.ad']);
});

for (const entry of ['translatePage', 'translateWholePage']) {
  test(`${entry}() during a catch-up round runs a full manual round after it`, async () => {
    const top = await loadTopFrame();
    const { ctx, log, counts, hello, changeRule, release } = top;
    await changeRule({ exclude: ['.b'] });
    assert.deepEqual(log, ['collect:main', 'pass:1'], 'the catch-up round is collecting');

    ctx[entry]();
    await sleep(10);
    assert.equal(counts.hint, 0, 'the click took the busy branch');
    assert.equal(ctx.state.isTranslatingPage, true);
    assert.equal(counts.explicit, 1, 'markPageExplicit');
    assert.equal(hello().manualEpoch, 1, 'children are told to run their own round');
    assert.deepEqual(log, ['collect:main', 'pass:1'], 'the manual round collected while the catch-up round ran');

    await release(1);
    assert.deepEqual(log, ['collect:main', 'pass:1', `collect:${entry === 'translateWholePage' ? 'page' : 'main'}`, 'pass:2']);
    await release(2);
    assert.deepEqual(log.slice(4), ['progress:1/1']);
    assert.equal(top.progress(), null, 'the progress bar is put away');
    assert.equal(ctx.state.isTranslatingPage, false);
    assert.deepEqual(ctx.state.translationProgress, { current: 0, total: 0 });
    assert.equal(counts.hint, 0);
    assert.equal(counts.errors, 0);
    assert.equal(hello().translate, false, 'the manual round has ended');
  });
}

test('a manual round recalls, when it ends, a late translation that landed in a newly excluded area', async () => {
  const top = await loadTopFrame();
  const { ctx, log, translated, changeRule, release } = top;
  ctx.translatePage();
  await sleep(10);
  assert.deepEqual(log, ['collect:main', 'pass:1']);

  // 这一轮送出去的块还在路上，规则把它所在的区域排除了：清扫当场跑，那时它还没挂上。
  let excluded = false;
  translated.push({ name: 'late', forbidden: () => excluded });
  excluded = true;
  translated.length = 0;
  await changeRule({ exclude: ['.ad', '.late'] });
  assert.deepEqual(log, ['collect:main', 'pass:1'], 'no catch-up round while the manual round runs');

  // 译文回来、挂上，然后这一轮结束。
  translated.push({ name: 'late', forbidden: () => excluded });
  await release(1);
  // 收尾：先收回挂进新禁止区域的那条，再按第 3 步补一轮（调度器没在跟）。
  assert.deepEqual(log, ['collect:main', 'pass:1', 'progress:1/1', 'release:late', 'collect:main', 'pass:2']);
  assert.equal(ctx.customRules.isCatchingUp(), true);
});

// ---------------------------------------------------------------- 调度器的 pump

function loadScheduler() {
  const timers = [];
  const calls = { engine: 0, filtered: 0 };
  const flags = { catching: false };
  let onCandidates = null;
  const ctx = {
    frameRole: 'top',
    state: { isTranslatingPage: false, translationsVisible: true },
    settings: { autoTranslate: true, siteRules: {}, autoAiDailyBudget: 0 },
    customRules: { onChange() {}, isCatchingUp: () => flags.catching },
    onLanguagePackReady() {},
    getEffectiveTargetLang: () => 'zh-CN',
    readSourceText: (element) => element.text,
    setupAutoDiscovery: (options) => {
      onCandidates = options.onCandidates;
      return { rescan() {}, stop() {}, suspend() {}, resume() {} };
    },
    builtinTranslator: {
      effectiveEngine: async () => {
        calls.engine += 1;
        return 'builtin';
      },
    },
    // 收到块就算过了闸；之后的译不必跑。
    filterBlocksByLanguage: () => {
      calls.filtered += 1;
      return new Promise(() => {});
    },
  };
  const sandbox = {
    console,
    document: { body: {} },
    location: { hostname: 'example.com', pathname: '/' },
    setTimeout: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimeout() {},
    requestAnimationFrame() {},
    SiteRules: { decide: () => ({ verdict: 'auto', reason: 'TEST' }) },
    SpaNavigation: { onRouteChange() {} },
    AI_TRANSLATOR_CONTENT: ctx,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const rel of ['shared/block-identity.js', 'shared/session-guard.js', 'content/content-auto-translate.js']) {
    vm.runInContext(repoFile(rel), sandbox, { filename: rel });
  }
  ctx.setupAutoTranslate();
  assert.ok(onCandidates, 'the scheduler started discovery');
  const fire = async () => {
    const { fn, ms } = timers.shift();
    fn();
    await new Promise((resolve) => setImmediate(resolve));
    return ms;
  };
  return { ctx, timers, calls, flags, fire, offer: (blocks) => onCandidates(blocks) };
}

test('the pump takes no block while a catch-up round runs, and comes back after MANUAL_RETRY_MS', async () => {
  const scheduler = loadScheduler();
  const { ctx, timers, calls, flags, fire, offer } = scheduler;
  assert.equal(ctx.autoTranslate.isOn(), true);
  flags.catching = true;
  offer([{ element: { isConnected: true, text: 'hello world' }, text: 'hello world' }]);
  assert.equal(timers.length, 1);

  assert.equal(await fire(), 250, 'the first start is the debounce');
  assert.equal(calls.engine, 0, 'the pump went on to the cost check');
  assert.equal(calls.filtered, 0, 'the pump took blocks');
  assert.deepEqual(timers.map((each) => each.ms), [500], 'it retries after MANUAL_RETRY_MS');

  flags.catching = false;
  assert.equal(await fire(), 500);
  assert.equal(calls.engine, 1);
  assert.equal(calls.filtered, 1, 'the retry takes the queued block');
});
