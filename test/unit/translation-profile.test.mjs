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

// 配置档签名按 AIProfiles.FEATURES 逐个功能解析（P1-D）；真模块，manifest 里排在缓存层前面。
await import('../../shared/lang-tags.js');
await import('../../shared/site-rules-builtin.js');
await import('../../shared/storage-writer.js');
await import('../../shared/site-rules.js');
await import('../../shared/sync-collection.js');
await import('../../shared/api-compat.js');
await import('../../shared/ai-profiles.js');

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
    // 缓存入口先等规则就绪（F1），替身一开始就是就绪的。
    whenReady: async () => {},
  };
}

// AI 配置档镜像的替身（P1-D）：use() 换一档就是 sync 增量到了；status 始终 ready。
function fakeAiProfiles(initial) {
  let current = initial;
  const subscribers = new Set();
  const resolved = [];
  return {
    whenReady: async () => {},
    status: () => 'ready',
    resolve(feature) {
      resolved.push(feature);
      return { profile: current };
    },
    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    use(next) {
      current = next;
      for (const fn of Array.from(subscribers)) fn();
    },
    resolved,
  };
}

const PROFILE_A = { id: 'a', apiEndpoint: 'https://a.example/v1/chat/completions', modelName: 'model-a' };
const PROFILE_B = { id: 'b', apiEndpoint: 'https://b.example/v1/chat/completions', modelName: 'model-b' };

/** 每次 new Function 求值一份新的闭包（CJS 缓存不认查询串）。 */
function load({ frameRole = 'top', entries = [], stored = {}, profile = PROFILE_A } = {}) {
  const glossary = fakeGlossary(entries);
  const customRules = fakeRules();
  const aiProfiles = fakeAiProfiles(profile);
  const ctx = { frameRole, glossary, customRules, aiProfiles };
  globalThis.window = globalThis;
  globalThis.AI_TRANSLATOR_CONTENT = ctx;
  globalThis.chrome = {
    // 读的是调用那一刻的 stored：测试改它，就是用户改了设置。
    storage: { sync: { get: async () => ({ ...stored }) } },
    runtime: { getManifest: () => ({ version: '0.0.0' }) },
  };
  new Function(SOURCE)();
  return { ctx, glossary, customRules, aiProfiles, profile: ctx.translationProfile };
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
  // 接口地址、模型、服务商三个旧键 P1-D 迁进配置档（aiProfile:<id>），迁移后就不在
  // sync 里了；它们换代走下面那条配置档订阅。
  for (const key of ['customPrompt', 'translationEngine', 'autoTranslateEngine',
    'engineFallback', 'promptDomain', 'aiPageContext']) {
    const before = profile.generation();
    profile.onSettingsChanged({ [key]: { newValue: 'x' } });
    assert.equal(profile.generation(), before + 1, key);
  }
  const settled = profile.generation();
  profile.onSettingsChanged({ uiLanguage: { newValue: 'en' }, theme: { newValue: 'dark' } });
  assert.equal(profile.generation(), settled);
  profile.onSettingsChanged({ apiEndpoint: {}, modelName: {}, provider: {}, apiKey: {} });
  assert.equal(profile.generation(), settled, '四个旧键不再是换代的来源');
});

test('配置档：本页解析出的接口地址或模型真变了才加一代；改名、换 Key 不加；子帧不自己加', () => {
  const { profile, aiProfiles } = load();
  aiProfiles.use(PROFILE_A);
  assert.equal(profile.generation(), 0, '第一次就绪只记签名');
  aiProfiles.use({ ...PROFILE_A, name: 'renamed', keyMissing: true });
  assert.equal(profile.generation(), 0, '名字和 keyMissing 不进签名');
  aiProfiles.use({ ...PROFILE_A, modelName: 'model-a2' });
  assert.equal(profile.generation(), 1, '换了模型');
  aiProfiles.use({ ...PROFILE_A, modelName: 'model-a2', apiEndpoint: 'https://c.example/v1' });
  assert.equal(profile.generation(), 2, '换了接口地址');
  assert.ok(aiProfiles.resolved.length > 0 && aiProfiles.resolved.every((f) => globalThis.AIProfiles.FEATURES.includes(f)));

  const child = load({ frameRole: 'child' });
  child.aiProfiles.use(PROFILE_A);
  child.aiProfiles.use(PROFILE_B);
  assert.equal(child.profile.generation(), 0, '子帧只跟顶层的代数');
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
  profile.onSettingsChanged({ customPrompt: { newValue: 'x' } });
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
    profile.onSettingsChanged({ customPrompt: {} });
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(seen, [1]);
  assert.equal(errors.length, 1);
  assert.equal(errors[0][0], 'Blab Translation: translation profile subscriber failed');
});

test('改了提示词之后，持久缓存的键因子重新读：下一次请求带的是新提示词；模型跟着配置档走', async () => {
  const stored = { customPrompt: 'prompt-a' };
  const { ctx, profile, aiProfiles } = load({ stored });
  const prompts = [];
  const models = [];
  globalThis.TranslationCache = {
    serve: async (texts, factors) => {
      prompts.push(factors.prompt);
      models.push(factors.model);
      return texts;
    },
  };
  globalThis.AutoStats = { add() {} };
  ctx.engine = {
    glossary: { current: async () => ({}) },
    addenda: { settings: () => ({ domain: 'general', context: false }), stamp: () => '' },
  };
  // 入口先在本 frame 盖语域（引擎的 ctx.withPromptAddenda），再查缓存。
  ctx.withPromptAddenda = (message) => ({ ...message, addenda: {} });
  ctx.sendTranslation = async () => assert.fail('全部命中，不该发请求');
  const message = { type: 'TRANSLATE_BATCH_FAST', feature: 'page', texts: ['x'], targetLang: 'zh-CN' };

  await ctx.requestTranslationCached(message);
  stored.customPrompt = 'prompt-b';
  await ctx.requestTranslationCached(message);
  assert.deepEqual(prompts, ['prompt-a', 'prompt-a'], '没收到变更之前，读过的那一份一直用');
  profile.onSettingsChanged({ customPrompt: { newValue: 'prompt-b' } });
  await ctx.requestTranslationCached(message);
  assert.deepEqual(prompts, ['prompt-a', 'prompt-a', 'prompt-b']);
  // 模型不经 sync 读：镜像换了档，下一次请求的键就是新模型。
  aiProfiles.use(PROFILE_B);
  await ctx.requestTranslationCached(message);
  assert.deepEqual(models, ['model-a', 'model-a', 'model-a', 'model-b']);
});

test('读不到自定义提示词就抛，不拿空串建键；下一次请求重读', async () => {
  const { ctx } = load();
  let fail = true;
  globalThis.chrome.storage.sync.get = async () => {
    if (fail) throw new Error('sync unavailable');
    return { customPrompt: 'p' };
  };
  const prompts = [];
  globalThis.TranslationCache = {
    serve: async (texts, factors) => {
      prompts.push(factors.prompt);
      return texts;
    },
  };
  globalThis.AutoStats = { add() {} };
  ctx.engine = {
    glossary: { current: async () => ({}) },
    addenda: { settings: () => ({ domain: 'general', context: false }), stamp: () => '' },
  };
  ctx.withPromptAddenda = (message) => ({ ...message, addenda: {} });
  ctx.sendTranslation = async () => assert.fail('读失败不该改成直发');
  const message = { type: 'TRANSLATE_BATCH_FAST', feature: 'page', texts: ['x'], targetLang: 'zh-CN' };
  await assert.rejects(ctx.requestTranslationCached(message), /sync unavailable/);
  fail = false;
  await ctx.requestTranslationCached(message);
  assert.deepEqual(prompts, ['p']);
});

test('这个功能没有可用的档：不查缓存，把解析结果交给送出那一步报真实原因', async () => {
  const { ctx, aiProfiles } = load();
  aiProfiles.resolve = () => ({ error: 'aiNotConfigured' });
  globalThis.TranslationCache = { serve: async () => assert.fail('没有档就没有键') };
  ctx.engine = {
    glossary: { current: async () => ({}) },
    addenda: { settings: () => ({ domain: 'general', context: false }), stamp: () => '' },
  };
  ctx.withPromptAddenda = (message) => ({ ...message, addenda: {} });
  const sent = [];
  ctx.sendTranslation = async (message, opts) => {
    sent.push(opts.profile);
    return { error: 'not configured' };
  };
  const reply = await ctx.requestTranslationCached({ type: 'TRANSLATE_BATCH_FAST', feature: 'page', texts: ['x'], targetLang: 'zh-CN' });
  assert.deepEqual(reply, { error: 'not configured' });
  assert.deepEqual(sent, [{ error: 'aiNotConfigured' }]);
});

test('悬停的内存缓存键随代数变：同一段文字、同一门目标语言，加代前后是两个键', () => {
  const { ctx, profile } = load();
  ctx.constants = { MATH_CONTAINER_SELECTOR: '.math', OWN_NODES_SELECTOR: '.own' };
  new Function(repoFile('content/hover/blocks.js'))();
  const before = ctx.hover.buildCacheKey('Attention is all you need.', 'zh-CN');
  assert.equal(ctx.hover.buildCacheKey('Attention is all you need.', 'zh-CN'), before, '不加代键不变');
  profile.onSettingsChanged({ customPrompt: { newValue: 'x' } });
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
  assert.ok(order.indexOf('content/content-ai-profiles.js') < cacheAt, '配置档镜像先于缓存层（加载时订阅）');
});

test('快照一致（P1-D §3.2）：键因子里的档和送出去的档是同一份，读 L2 期间镜像换了档也不变', async () => {
  const { ctx, aiProfiles } = load({ stored: { customPrompt: '' } });
  const keyed = [];
  globalThis.TranslationCache = {
    serve: async (texts, factors, sendMissing) => {
      keyed.push({ endpoint: factors.endpoint, model: factors.model });
      // 读 storage.local（L2）要一跳；这一跳里 sync 增量到了，本页换成 B 档。
      await Promise.resolve();
      aiProfiles.use(PROFILE_B);
      return sendMissing(texts);
    },
  };
  globalThis.AutoStats = { add() {} };
  ctx.engine = {
    glossary: { current: async () => ({}) },
    addenda: { settings: () => ({ domain: 'general', context: false }), stamp: () => '' },
  };
  ctx.withPromptAddenda = (message) => ({ ...message, addenda: {} });
  const sent = [];
  ctx.sendTranslation = async (message, opts) => {
    sent.push(opts.profile);
    return { translations: message.texts.map((text) => `T:${text}`) };
  };

  await ctx.requestTranslationCached({ type: 'TRANSLATE_BATCH_FAST', feature: 'page', texts: ['x'], targetLang: 'zh-CN' });
  assert.deepEqual(keyed, [{ endpoint: PROFILE_A.apiEndpoint, model: PROFILE_A.modelName }], '键按请求开始时的档算');
  assert.equal(sent.length, 1);
  assert.ok(sent[0] && sent[0].profile === PROFILE_A, '送出去的也是 A 档，不在未命中之后重新解析');
  // 第一次是这条请求（按消息里的 feature）；其余是 B 档到达时代数订阅逐个功能算签名。
  assert.deepEqual(aiProfiles.resolved, ['page', ...globalThis.AIProfiles.FEATURES],
    '一次请求只解析一次，按消息里的 feature');
});
