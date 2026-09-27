// 用户站点规则钉住的引擎（P1-B 设计 §3.7），在真的引擎上问，不在源码上问。
//
// 优先级只有一条：这一次请求指名的 message.engine > 本站规则的 engine > 设置
// （手动 / 自动两张开关）。钉住落在谓词 isBuiltinSelected 上，所以费用闸、回退、
// popup 的探测问的都是同一个答案 —— 这里逐个验它们真的跟着规则走。
//
// 引擎只在调用时读 ctx.customRules（content/page/custom-rule.js 挂的），这里用
// 一个桩替它：engineOverride() 答什么，本站规则就是什么。
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { installEngineHarness } from './helpers/engine-harness.mjs';
import { engineSource } from './helpers/sources.mjs';

const PAGE = 'This page is written in ordinary English prose, long enough for the detector to be sure about it.'.repeat(6);
const BLOCK = 'A paragraph of ordinary English prose, long enough that the engine asks the detector itself.';

const { ctx, translateCalls, sentToAI, setApiKey } = await installEngineHarness({ pageText: PAGE });

const charged = [];
globalThis.AutoStats = {
  textsChars: (texts) => texts.reduce((sum, text) => sum + String(text || '').length, 0),
  charge: async (chars, budget) => {
    charged.push({ chars, budget });
    return { allowed: true };
  }
};

let siteEngine = null;
let ready = Promise.resolve();
ctx.customRules = {
  whenReady: () => ready,
  engineOverride: () => siteEngine,
};

function configure(site, patch) {
  siteEngine = site;
  ready = Promise.resolve();
  Object.assign(ctx.settings, {
    translationEngine: 'builtin',
    autoTranslateEngine: 'builtin',
    engineFallback: 'local-only',
    autoAiDailyBudget: 200000
  }, patch);
  translateCalls.length = 0;
  sentToAI.length = 0;
  charged.length = 0;
}

const translate = (extra) => ctx.requestTranslation({
  type: 'TRANSLATE', text: BLOCK, targetLang: 'zh-CN', mode: 'text', ...extra
});

test('site engine ai outranks both settings, for manual and automatic requests', async () => {
  configure('ai', {});
  const manual = await translate({});
  assert.equal(manual.engine, 'ai');
  const auto = await translate({ auto: true });
  assert.equal(auto.engine, 'ai');
  assert.equal(sentToAI.length, 2);
  assert.equal(translateCalls.length, 0, 'the built-in engine answered although the site rule says ai');
  // 零点击的那一次照样过预算闸：规则钉的 AI 不是绕过日额度的后门。
  assert.equal(charged.length, 1);
  assert.equal(charged[0].chars, BLOCK.length);
});

test('site engine builtin outranks both settings set to ai', async () => {
  configure('builtin', { translationEngine: 'ai', autoTranslateEngine: 'ai' });
  assert.equal((await translate({})).engine, 'builtin');
  assert.equal((await translate({ auto: true })).engine, 'builtin');
  assert.equal(sentToAI.length, 0);
  assert.equal(translateCalls.length, 2);
});

test('a request that names its engine still outranks the site rule', async () => {
  configure('builtin', {});
  setApiKey('sk-test');
  const result = await translate({ engine: 'ai' });
  assert.equal(result.engine, 'ai');
  assert.equal(sentToAI.length, 1);
  setApiKey('');
});

test('no site engine: the settings speak, each for its own half', async () => {
  configure(null, { translationEngine: 'ai' });
  assert.equal((await translate({})).engine, 'ai');
  assert.equal((await translate({ auto: true })).engine, 'builtin');
});

test('a site pinned to builtin never falls back, even with fallback allowed', async () => {
  configure('builtin', { engineFallback: 'allow-ai' });
  setApiKey('sk-test');
  assert.equal(ctx.builtinTranslator.fallbackAllowed(), false);
  const realIsSecure = globalThis.self.isSecureContext;
  globalThis.self.isSecureContext = false;
  try {
    const result = await translate({});
    assert.equal(result.engine, 'builtin');
    assert.ok(result.error, 'the unsupported environment must be the answer');
    assert.equal(sentToAI.length, 0, 'a site pinned to the free engine billed the user');
  } finally {
    globalThis.self.isSecureContext = realIsSecure;
    setApiKey('');
  }
  configure(null, { engineFallback: 'allow-ai' });
  assert.equal(ctx.builtinTranslator.fallbackAllowed(), true);
  configure('ai', { engineFallback: 'allow-ai' });
  assert.equal(ctx.builtinTranslator.fallbackAllowed(), false);
});

test('the request waits for the rules before choosing an engine', async () => {
  configure(null, {});
  let release;
  ready = new Promise((resolve) => { release = resolve; });
  const pending = translate({});
  // 规则晚到：等它到了再选，钉的是 ai 就走 ai。
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(sentToAI.length + translateCalls.length, 0, 'the engine chose before the rules arrived');
  siteEngine = 'ai';
  release();
  assert.equal((await pending).engine, 'ai');
});

test('the popup probe reports the site engine', async () => {
  configure('ai', {});
  assert.equal((await ctx.builtinTranslator.probeStatus()).engine, 'ai');
  configure('builtin', { translationEngine: 'ai' });
  assert.equal((await ctx.builtinTranslator.probeStatus()).engine, 'builtin');
});

test('BUILTIN_TYPES is exactly the set of case labels handleWithBuiltin answers', () => {
  const source = engineSource();
  const declared = source.match(/const BUILTIN_TYPES = new Set\(\[([^\]]*)\]\);/);
  assert.ok(declared, 'BUILTIN_TYPES moved or changed shape');
  const types = [...declared[1].matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]).sort();
  const fn = source.slice(source.indexOf('async function handleWithBuiltin('));
  const body = fn.slice(0, fn.indexOf('\n  }\n'));
  const labels = [...body.matchAll(/case '([A-Z_]+)':/g)].map((m) => m[1]).sort();
  assert.deepEqual(types, labels);
});

test('a request type the built-in engine cannot answer goes to AI, unpinned', async () => {
  configure('builtin', {});
  const result = await ctx.requestTranslation({ type: 'TRANSLATE_WITH_CONTEXT', text: BLOCK, targetLang: 'zh-CN' });
  assert.equal(result.engine, 'ai');
  assert.equal(sentToAI.length, 1);
});

test('a site pinned to builtin on an http page with fallback allowed has no engine: none', async () => {
  configure('builtin', { translationEngine: 'ai', autoTranslateEngine: 'ai', engineFallback: 'allow-ai' });
  setApiKey('sk-test');
  const realIsSecure = globalThis.self.isSecureContext;
  globalThis.self.isSecureContext = false;
  try {
    assert.equal(await ctx.builtinTranslator.effectiveEngine({ auto: true }), 'none');
    assert.equal(await ctx.builtinTranslator.effectiveEngine({ auto: false }), 'none');
    // 同样的页面没有站点规则：设置说 AI 就是 AI。
    siteEngine = null;
    assert.equal(await ctx.builtinTranslator.effectiveEngine({ auto: true }), 'ai');
  } finally {
    globalThis.self.isSecureContext = realIsSecure;
    setApiKey('');
  }
});

test('a request that names builtin outranks a site pinned to ai', async () => {
  configure('ai', {});
  const result = await translate({ engine: 'builtin' });
  assert.equal(result.engine, 'builtin');
  assert.equal(sentToAI.length, 0);
  assert.equal(translateCalls.length, 1);
});

test('a request type the built-in engine cannot answer goes to AI on an http page too', async () => {
  configure('builtin', {});
  const realIsSecure = globalThis.self.isSecureContext;
  globalThis.self.isSecureContext = false;
  try {
    const result = await ctx.requestTranslation({ type: 'TRANSLATE_WITH_CONTEXT', text: BLOCK, targetLang: 'zh-CN' });
    assert.equal(result.engine, 'ai');
    assert.equal(sentToAI.length, 1);
  } finally {
    globalThis.self.isSecureContext = realIsSecure;
  }
});
