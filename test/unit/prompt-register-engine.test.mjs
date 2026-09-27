// 语域附加说明在内容脚本这一半（R33 A4）：ctx.requestTranslation 入口用 ctx.withPromptAddenda
// 把这一页的语域挂到发给服务工作者的消息上，译文缓存把它放进键。
//
// 契约：
//   - 挂的是 `addenda: {register}`，只有标签；消息里不出现这一页的域名。
//   - 只挂在三种翻译消息上；这一页内置表里没有语域就不挂这个字段。
//   - 同一段文字在论坛页和新闻页上是两个缓存键。
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { installEngineHarness } from './helpers/engine-harness.mjs';

const PAGE = 'This page is written in ordinary English prose, long enough for the detector to be sure about it.'.repeat(6);
const BLOCK = 'A paragraph of ordinary English prose, long enough that the engine asks the detector itself.';

const { ctx, translateCalls, sentToAI, setApiKey } = await installEngineHarness({
  pageText: PAGE,
  url: 'https://old.reddit.com/r/test/comments/1/a_thread/',
});
await import('../../shared/engine-status.js');
setApiKey('test-key');

// 译文缓存那一层：content/content-translation-cache.js 在 manifest 里排在引擎之后，
// 要 TranslationCache（shared/translation-cache.js）、chrome.storage.local 与
// AutoStats。这里给一个内存里的 storage.local。
const local = new Map();
Object.assign(globalThis.chrome.storage, {
  local: {
    get: async (keys) => {
      const list = keys === null ? [...local.keys()] : [].concat(keys);
      return Object.fromEntries(list.filter((k) => local.has(k)).map((k) => [k, local.get(k)]));
    },
    set: async (items) => { for (const [k, v] of Object.entries(items)) local.set(k, v); },
    remove: async (keys) => { for (const k of [].concat(keys)) local.delete(k); },
  },
});
globalThis.chrome.runtime.getManifest = () => ({ version: '9.9.9' });
globalThis.AutoStats = { add() {} };
await import('../../shared/translation-cache.js');
await import('../../content/content-translation-cache.js');

function useAI() {
  Object.assign(ctx.settings, {
    translationEngine: 'ai',
    autoTranslateEngine: 'ai',
    engineFallback: 'allow-ai',
  });
  translateCalls.length = 0;
  sentToAI.length = 0;
}

function goTo(url) {
  globalThis.location = new URL(url);
}

const REDDIT = 'https://old.reddit.com/r/test/comments/1/a_thread/';

test('the one exit to the model carries the register label, and only the label', async () => {
  goTo(REDDIT);
  useAI();
  await ctx.requestTranslation({ type: 'TRANSLATE', text: BLOCK, targetLang: 'zh-CN', mode: 'text' });
  await ctx.requestTranslation({ type: 'TRANSLATE_BATCH', texts: [BLOCK, BLOCK], targetLang: 'zh-CN' });
  await ctx.requestTranslation({ type: 'TRANSLATE_BATCH_FAST', texts: [BLOCK], targetLang: 'zh-CN', delimiter: '@@' });
  assert.equal(sentToAI.length, 3);
  for (const message of sentToAI) {
    assert.equal(JSON.stringify(message.addenda), '{"register":"forum"}', message.type);
    // 除了要译的文字，整条消息里没有这一页是哪个站。
    const { text, texts, ...rest } = message;
    assert.doesNotMatch(JSON.stringify(rest), /reddit/i, message.type);
  }
});

test('each page gets its own register, and a page without one sends no addenda field', async () => {
  useAI();
  goTo('https://x.com/someone/status/1');
  await ctx.requestTranslation({ type: 'TRANSLATE', text: BLOCK, targetLang: 'zh-CN', mode: 'text' });
  goTo('https://www.bbc.co.uk/news/articles/x');
  await ctx.requestTranslation({ type: 'TRANSLATE', text: BLOCK, targetLang: 'zh-CN', mode: 'text' });
  goTo('https://example.test/');
  await ctx.requestTranslation({ type: 'TRANSLATE', text: BLOCK, targetLang: 'zh-CN', mode: 'text' });
  assert.deepEqual(sentToAI.map((m) => m.addenda && m.addenda.register), ['social', 'news', undefined]);
  assert.ok(!('addenda' in sentToAI[2]), 'a page with no register still grew an addenda key');
});

test('the built-in engine gets no addenda and other message types are left alone', async () => {
  goTo(REDDIT);
  useAI();
  Object.assign(ctx.settings, { translationEngine: 'builtin' });
  const result = await ctx.requestTranslation({ type: 'TRANSLATE', text: BLOCK, targetLang: 'zh-CN', mode: 'text' });
  assert.equal(result.engine, 'builtin');
  assert.equal(sentToAI.length, 0);
  assert.equal(translateCalls.length, 1);

  useAI();
  await ctx.requestTranslation({ type: 'SOMETHING_ELSE', payload: 1 });
  assert.equal(sentToAI.length, 1);
  assert.ok(!('addenda' in sentToAI[0]), 'a non-translation message was given addenda');
});

test('the same text on a forum page and on a news page are two cache keys', async () => {
  useAI();
  local.clear();
  const ask = () => ctx.requestTranslationCached({
    type: 'TRANSLATE_BATCH_FAST', texts: ['A cached paragraph.'], targetLang: 'zh-CN', delimiter: '@@',
  });
  globalThis.chrome.runtime.sendMessage = async (message) => {
    sentToAI.push(message);
    return { translations: message.texts.map((t) => `AI:${t}`) };
  };

  goTo(REDDIT);
  await ask();
  await ask();
  assert.equal(sentToAI.length, 1, 'the second forum request was not served from the cache');

  goTo('https://www.bbc.co.uk/news/articles/x');
  await ask();
  assert.equal(sentToAI.length, 2, 'a news page reused the forum translation');
  assert.equal(sentToAI[1].addenda.register, 'news');
});
