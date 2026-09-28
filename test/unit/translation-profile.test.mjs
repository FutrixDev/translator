// 本页内存缓存的代数：ctx.translationProfile（content/content-translation-cache.js）。
//
// 悬停和字幕各有一份内存缓存，键里只有目标语言和原文；模型、提示词、词表变了，
// 代数加一，两边的键带着代数，旧译文就读不到了。这里在桩的 ctx 上真跑那个文件：
// 设置键、词表签名两种来源让代数递增；子帧只跟顶层（inherit）；悬停和字幕的键
// 真的随代数变（把两边的文件也在同一个 ctx 上跑起来，比一比加代前后的键）；持久
// 缓存的键因子在设置变了之后重新读；本站规则钉住的引擎或领域变了
// （ctx.customRules.onProfileChange）也加一代。
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { contentBundle } from './helpers/sources.mjs';

const repoFile = (rel) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');
const SOURCE = repoFile('content/content-translation-cache.js');

function fakeGlossary(initial) {
  let entries = initial;
  const subscribers = new Set();
  return {
    entries: () => entries,
    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    set(next) {
      entries = next;
      for (const fn of subscribers) fn();
    },
  };
}

// 规则的替身：只有 onProfileChange，fire() 就是 custom-rule.js 判定「引擎或领域变了」。
function fakeRules() {
  const subscribers = new Set();
  return {
    onProfileChange(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    fire() {
      for (const fn of subscribers) fn();
    },
    count: () => subscribers.size,
  };
}

/** 每次 new Function 求值一份新的闭包（CJS 缓存不认查询串）。 */
function load({ frameRole = 'top', entries = [], stored = {} } = {}) {
  const glossary = fakeGlossary(entries);
  const customRules = fakeRules();
  const ctx = { frameRole, glossary, customRules };
  globalThis.window = globalThis;
  globalThis.AI_TRANSLATOR_CONTENT = ctx;
  globalThis.chrome = {
    // 读的是调用那一刻的 stored：测试改它，就是用户改了设置。
    storage: { sync: { get: async () => ({ ...stored }) } },
    runtime: { getManifest: () => ({ version: '0.0.0' }) },
  };
  new Function(SOURCE)();
  return { ctx, glossary, customRules, profile: ctx.translationProfile };
}

test('本站规则的引擎或领域变了（onProfileChange 回调）加一代；子帧不自己加', () => {
  const { profile, customRules } = load();
  assert.equal(customRules.count(), 1, '缓存层在加载时订阅了规则');
  assert.equal(profile.generation(), 0);
  customRules.fire();
  assert.equal(profile.generation(), 1);
  customRules.fire();
  assert.equal(profile.generation(), 2);

  const child = load({ frameRole: 'child' });
  child.customRules.fire();
  assert.equal(child.profile.generation(), 0, '子帧只跟顶层的代数');
});

test('影响译文的设置键让代数加一；别的键（界面语言、主题）不动', () => {
  const { profile } = load();
  assert.equal(profile.generation(), 0);
  for (const key of ['apiEndpoint', 'modelName', 'customPrompt', 'translationEngine', 'autoTranslateEngine',
    'engineFallback', 'promptDomain', 'aiPageContext', 'provider']) {
    const before = profile.generation();
    profile.onSettingsChanged({ [key]: { newValue: 'x' } });
    assert.equal(profile.generation(), before + 1, key);
  }
  const settled = profile.generation();
  profile.onSettingsChanged({ uiLanguage: { newValue: 'en' }, theme: { newValue: 'dark' } });
  assert.equal(profile.generation(), settled);
});

test('词表签名（id 加 u）真变了才加一代；订阅回调但内容没变不加', () => {
  const { profile, glossary } = load({ entries: [{ id: 'a', u: 1, s: 'attention' }] });
  const seen = [];
  profile.subscribe((generation) => seen.push(generation));
  glossary.set([{ id: 'a', u: 1, s: 'attention' }]);
  assert.equal(profile.generation(), 0, '同一组词条不加代');
  glossary.set([{ id: 'a', u: 2, s: 'attention' }]);
  assert.equal(profile.generation(), 1, '改了词条（u 变了）加一代');
  glossary.set([{ id: 'a', u: 2, s: 'attention' }, { id: 'b', u: 1, s: 'token' }]);
  assert.equal(profile.generation(), 2, '加了词条加一代');
  glossary.set([{ id: 'b', u: 1, s: 'token' }, { id: 'a', u: 2, s: 'attention' }]);
  assert.equal(profile.generation(), 2, '只是顺序变了不加代');
  glossary.set([{ id: 'b', u: 1, s: 'token' }]);
  assert.equal(profile.generation(), 3, '删了词条加一代');
  assert.deepEqual(seen, [1, 2, 3]);
});

test('子帧不自己加代，只跟顶层指令里的代数（inherit）；inherit 拒绝非法值', () => {
  const { profile, glossary } = load({ frameRole: 'child', entries: [] });
  profile.onSettingsChanged({ modelName: { newValue: 'x' } });
  glossary.set([{ id: 'a', u: 1, s: 'attention' }]);
  assert.equal(profile.generation(), 0);
  const seen = [];
  profile.subscribe((generation) => seen.push(generation));
  profile.inherit(4);
  profile.inherit(4);
  assert.equal(profile.generation(), 4);
  assert.deepEqual(seen, [4], '同一个代数不重复通知');
  for (const bad of [-1, 1.5, '3', undefined, null]) {
    assert.throws(() => profile.inherit(bad), TypeError, String(bad));
  }
  assert.equal(profile.generation(), 4);
});

test('一个订阅者抛错只记日志，不拦住别的订阅者', () => {
  const { profile } = load();
  const seen = [];
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args);
  try {
    profile.subscribe(() => {
      throw new Error('boom');
    });
    profile.subscribe((generation) => seen.push(generation));
    profile.onSettingsChanged({ modelName: {} });
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(seen, [1]);
  assert.equal(errors.length, 1);
  assert.equal(errors[0][0], 'Blab Translation: translation profile subscriber failed');
});

test('改了模型之后，持久缓存的键因子重新读：下一次请求带的是新模型', async () => {
  const stored = { modelName: 'model-a' };
  const { ctx, profile } = load({ stored });
  const models = [];
  globalThis.TranslationCache = {
    serve: async (texts, factors) => {
      models.push(factors.model);
      return texts;
    },
  };
  globalThis.AutoStats = { add() {} };
  ctx.engine = { glossary: { current: async () => ({}) }, addenda: { stamp: () => '' } };
  // 入口先在本 frame 盖语域（引擎的 ctx.withPromptAddenda），再查缓存。
  ctx.withPromptAddenda = (message) => ({ ...message, addenda: {} });
  ctx.sendTranslation = async () => assert.fail('全部命中，不该发请求');
  const message = { type: 'TRANSLATE_BATCH_FAST', texts: ['x'], targetLang: 'zh-CN' };

  await ctx.requestTranslationCached(message);
  stored.modelName = 'model-b';
  await ctx.requestTranslationCached(message);
  assert.deepEqual(models, ['model-a', 'model-a'], '没收到变更之前，读过的那一份一直用');
  profile.onSettingsChanged({ modelName: { newValue: 'model-b' } });
  await ctx.requestTranslationCached(message);
  assert.deepEqual(models, ['model-a', 'model-a', 'model-b']);
});

test('悬停的内存缓存键随代数变：同一段文字、同一门目标语言，加代前后是两个键', () => {
  const { ctx, profile } = load();
  ctx.constants = { MATH_CONTAINER_SELECTOR: '.math', OWN_NODES_SELECTOR: '.own' };
  new Function(repoFile('content/hover/blocks.js'))();
  const before = ctx.hover.buildCacheKey('Attention is all you need.', 'zh-CN');
  assert.equal(ctx.hover.buildCacheKey('Attention is all you need.', 'zh-CN'), before, '不加代键不变');
  profile.onSettingsChanged({ modelName: { newValue: 'x' } });
  assert.notEqual(ctx.hover.buildCacheKey('Attention is all you need.', 'zh-CN'), before);
});

test('字幕的内存缓存键随代数变：同一句台词，加代前后查的是两个键', () => {
  const { ctx, profile } = load();
  const asked = [];
  ctx.captions = {
    state: {
      cues: [{ startMs: 0, endMs: 4000, text: 'Hello there.' }],
      trackId: 'en-1',
      overlay: {},
      cueCache: {
        get(key) {
          asked.push(key);
          return undefined;
        },
        clear() {},
      },
      pendingKeys: new Set(),
      failedUntil: new Map(),
    },
    getTargetLang: () => 'zh-CN',
    setOverlayContent() {},
  };
  globalThis.CaptionCore = {};
  new Function(repoFile('content/captions/translate.js'))();
  ctx.captions.renderActiveCue(1000);
  ctx.captions.renderActiveCue(1000);
  profile.onSettingsChanged({ customPrompt: { newValue: 'x' } });
  ctx.captions.renderActiveCue(1000);
  assert.equal(asked.length, 3);
  assert.equal(asked[1], asked[0], '不加代键不变');
  assert.notEqual(asked[2], asked[0]);
});

test('sync 设置的监听只有 bootstrap 一处：缓存那一层不再自己挂 onChanged，由 bootstrap 转交', () => {
  assert.doesNotMatch(SOURCE, /chrome\.storage\.onChanged/);
  const bootstrap = repoFile('content/content-bootstrap.js');
  assert.match(bootstrap, /ctx\.translationProfile\.onSettingsChanged\(changes\)/);
  // 缓存文件在悬停和字幕之前加载：两边读 ctx.translationProfile 时它已经在了。
  const order = contentBundle();
  const cacheAt = order.indexOf('content/content-translation-cache.js');
  assert.ok(cacheAt >= 0);
  assert.ok(order.indexOf('content/hover/blocks.js') > cacheAt);
  assert.ok(order.indexOf('content/captions/translate.js') > cacheAt);
  assert.ok(order.indexOf('content/content-glossary.js') < cacheAt, '词表镜像先于缓存层');
  assert.ok(order.indexOf('content/page/custom-rule.js') < cacheAt, '规则先于缓存层（加载时订阅 onProfileChange）');
});
