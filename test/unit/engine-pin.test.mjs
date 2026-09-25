// message.engine：一次请求指名要哪个引擎（划词卡片上的「换引擎」，P0-D）。
//
// 契约（content/content-translation-engine.js 的 requestTranslation）：
//   - 只认 undefined / 'builtin' / 'ai'，别的值直接抛错；
//   - 指名了就不回落：指名内置而内置顶不住，给真实原因，engineFallback 为
//     'allow-ai' 也不改走 AI；指名 AI 就完全不碰内置；
//   - 每个响应都盖上 engine，说是谁译的（出错时说是谁没译成）。
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { installEngineHarness } from './helpers/engine-harness.mjs';

const PAGE = 'This page is written in ordinary English prose, long enough for the detector to be sure about it.'.repeat(6);
const BLOCK = 'A paragraph of ordinary English prose, long enough that the engine asks the detector itself.';

const { ctx, translateCalls, sentToAI, setApiKey } = await installEngineHarness({ pageText: PAGE });
// 回落时记下的细分原因来自 EngineStatus（manifest 里排在引擎前面）。
await import('../../shared/engine-status.js');
// AI 那边配好了，engineFallback 为 'allow-ai' 时回落是真的走得通的 —— 不然
// 「不回落」这件事证不出来。
setApiKey('test-key');

const realTranslator = self.Translator;

function configure(patch) {
  Object.assign(ctx.settings, {
    translationEngine: 'builtin',
    autoTranslateEngine: 'builtin',
    engineFallback: 'allow-ai',
  }, patch);
  self.Translator = realTranslator;
  self.isSecureContext = true;
  translateCalls.length = 0;
  sentToAI.length = 0;
}

const translate = (extra) => ctx.requestTranslation({
  type: 'TRANSLATE', text: BLOCK, targetLang: 'zh-CN', mode: 'text', ...extra
});

test('an engine the contract does not know is a caller bug, not "no preference"', async () => {
  configure({});
  await assert.rejects(translate({ engine: 'google' }), /unknown engine "google"/);
  await assert.rejects(translate({ engine: null }), /unknown engine null/);
  assert.equal(sentToAI.length + translateCalls.length, 0);
});

test('pinned builtin in an environment without it returns the real reason, even with allow-ai', async () => {
  configure({ translationEngine: 'ai' });
  self.isSecureContext = false;
  const result = await translate({ engine: 'builtin' });
  assert.equal(result.engine, 'builtin');
  assert.equal(result.error, 'builtinUnsupportedEnv');
  assert.equal(sentToAI.length, 0, 'a pinned builtin request fell back to AI');
});

test('pinned builtin that fails mid-translation does not fall back either', async () => {
  configure({});
  self.Translator = {
    availability: async () => 'available',
    create: async () => ({ translate: async () => { throw new Error('model crashed'); }, destroy() {} }),
  };
  // 语言对与别的用例不同：实例按语言对缓存，别撞上前面建好的那个。
  const result = await translate({ engine: 'builtin', targetLang: 'ja' });
  assert.equal(result.engine, 'builtin');
  assert.ok(result.error, JSON.stringify(result));
  assert.equal(sentToAI.length, 0, 'a pinned builtin request fell back to AI');

  // 同样的失败，没指名引擎：allow-ai 下照常回落，证明上面挡住的是指名这一条。
  const unpinned = await translate({ targetLang: 'ja' });
  assert.equal(sentToAI.length, 1);
  assert.equal(unpinned.engine, 'ai');
});

test('pinned ai never touches the builtin engine, whatever the settings say', async () => {
  configure({ translationEngine: 'builtin' });
  const result = await translate({ engine: 'ai' });
  assert.equal(translateCalls.length, 0);
  assert.equal(sentToAI.length, 1);
  assert.equal(result.translation, `AI:${BLOCK}`);
  assert.equal(result.engine, 'ai');
});

test('every path stamps the engine that answered', async () => {
  configure({ translationEngine: 'builtin' });
  const builtin = await translate({});
  assert.equal(builtin.engine, 'builtin');
  assert.match(builtin.translation, /^builtin\(/);

  configure({ translationEngine: 'ai' });
  assert.equal((await translate({})).engine, 'ai');

  // 回落：选了内置，环境没有，allow-ai 顶上。
  configure({ translationEngine: 'builtin' });
  self.isSecureContext = false;
  const fallback = await translate({});
  assert.equal(sentToAI.length, 1);
  assert.equal(fallback.engine, 'ai');

  // 没开回落时的错误，也说是内置没译成。
  configure({ translationEngine: 'builtin', engineFallback: 'local-only' });
  self.isSecureContext = false;
  const refused = await translate({});
  assert.equal(refused.engine, 'builtin');
  assert.ok(refused.error);
});

test('the budget gate refusal on the AI exit is stamped ai', async () => {
  configure({ translationEngine: 'ai' });
  globalThis.AutoStats = {
    textsChars: () => 0,
    charge: async () => ({ allowed: false }),
  };
  const result = await translate({ unattended: true });
  assert.equal(result.budgetSpent, true);
  assert.equal(result.engine, 'ai');
  assert.equal(sentToAI.length, 0);
});

test('engineChoices reads the AI config afresh and reports both sides', async () => {
  configure({});
  setApiKey('');
  assert.deepEqual({ ...(await ctx.engineChoices('fr')) }, { builtin: true, ai: false });
  setApiKey('test-key');
  self.isSecureContext = false;
  assert.deepEqual({ ...(await ctx.engineChoices('fr')) }, { builtin: false, ai: true });
});

// 卡片正用 AI 译成一门端上没有的语言（fa）时，「改用内置」点了只会报错，所以不给。
// 判定和语言菜单标「仅 AI」的是同一个谓词：两处答案必须一致。
test('engineChoices offers builtin only for a target the builtin engine knows', async () => {
  configure({});
  setApiKey('test-key');
  assert.deepEqual({ ...(await ctx.engineChoices('fa')) }, { builtin: false, ai: true });
  assert.deepEqual({ ...(await ctx.engineChoices('fr')) }, { builtin: true, ai: true });
  // 扩展码先过 toApiLang：zh-TW 在端上是 zh-Hant，认得。
  assert.equal((await ctx.engineChoices('zh-TW')).builtin, true);
  const bt = ctx.builtinTranslator;
  for (const code of ['fa', 'fr', 'ur', 'he', 'zh-TW', 'sw']) {
    assert.equal((await ctx.engineChoices(code)).builtin, bt.supportsTarget(code), code);
  }
});
