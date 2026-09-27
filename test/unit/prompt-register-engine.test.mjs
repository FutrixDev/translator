// 语域附加说明在内容脚本这一半（R33 A4）：ctx.requestTranslation 入口用 ctx.withPromptAddenda
// 把这一页的语域挂到发给服务工作者的消息上，译文缓存把它放进键。
//
// 契约：
//   - 挂的是 `addenda: {register}`，只有标签；消息里不出现这一页的域名；没有
//     语域的页面挂 `{}`。
//   - 只挂在三种翻译消息上；这一页内置表里没有语域就不挂这个字段。
//   - 同一段文字在论坛页和新闻页上是两个缓存键。
//   - 两头接起来（R33 N4）：这一半发出的消息交给服务工作者那一半真的翻译函数，
//     文字路径（单句、编号批、快速批，默认模板与自定义提示词两支）的系统提示词
//     带 REGISTER_RULE；单词/词典路径不带它，但这一页的体裁标签照样送到。
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

test('each page gets its own register, and a page without one sends empty addenda', async () => {
  useAI();
  goTo('https://x.com/someone/status/1');
  await ctx.requestTranslation({ type: 'TRANSLATE', text: BLOCK, targetLang: 'zh-CN', mode: 'text' });
  goTo('https://www.bbc.co.uk/news/articles/x');
  await ctx.requestTranslation({ type: 'TRANSLATE', text: BLOCK, targetLang: 'zh-CN', mode: 'text' });
  goTo('https://example.test/');
  await ctx.requestTranslation({ type: 'TRANSLATE', text: BLOCK, targetLang: 'zh-CN', mode: 'text' });
  assert.deepEqual(sentToAI.map((m) => m.addenda.register), ['social', 'news', undefined]);
  assert.equal(JSON.stringify(sentToAI[2].addenda), '{}', 'a page with no register still sends the field, empty');
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

// ---- 两头接起来：内容脚本发出的消息 → 服务工作者的翻译函数 → 系统提示词 ----
// 放在最后：它把服务工作者那一半（连同真的 AutoStats）装进这个进程，上面缓存
// 那条要的是桩。

test('the register rule reaches every text prompt and no word prompt, default and custom', async () => {
  // ai-translate.js 经 settings.js 摸到 chrome.i18n 与 fetch；fetch 记下系统提示词。
  globalThis.chrome.i18n.getUILanguage = () => 'en';
  const systems = [];
  let reply = () => 'translated';
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    systems.push(body.messages[0].content);
    return new Response(JSON.stringify({ choices: [{ message: { content: reply() } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const prompts = await import('../../background/prompts.js');
  const ai = await import('../../background/ai-translate.js');
  const { PromptAddenda } = globalThis;
  const FORUM_LINE = `${PromptAddenda.HEADINGS.register} ${PromptAddenda.REGISTER_SENTENCES.forum}`;

  goTo(REDDIT);
  useAI();
  globalThis.chrome.runtime.sendMessage = async (message) => {
    sentToAI.push(message);
    return { translation: 'AI', phonetic: '', isWord: false, translations: [] };
  };
  await ctx.requestTranslation({ type: 'TRANSLATE', text: BLOCK, targetLang: 'zh-CN', mode: 'text' });
  await ctx.requestTranslation({ type: 'TRANSLATE', text: 'hello', targetLang: 'zh-CN', mode: 'word' });
  await ctx.requestTranslation({ type: 'TRANSLATE_BATCH', texts: ['a', 'b'], targetLang: 'zh-CN' });
  await ctx.requestTranslation({ type: 'TRANSLATE_BATCH_FAST', texts: ['a', 'b'], targetLang: 'zh-CN', delimiter: '@@' });
  const [single, word, numbered, fast] = sentToAI;

  // background.js 的三个处理函数怎么把消息交下去，这里就怎么交。
  const base = {
    apiEndpoint: 'https://api.openai.com/v1/chat/completions',
    apiKey: 'test-key',
    modelName: 'gpt-4.1-mini',
  };
  for (const [label, settings] of [
    ['default template', { ...base, customPrompt: '' }],
    ['custom prompt', { ...base, customPrompt: 'Translate into {targetLang}. Be brief.' }],
  ]) {
    const sent = async (run, answer) => {
      systems.length = 0;
      reply = answer;
      await run();
      assert.equal(systems.length, 1, `${label}: ${systems.length} requests`);
      return systems[0];
    };
    const text = {
      single: await sent(() => ai.translateTextWithMode(
        single.text, single.targetLang, settings, single.mode === 'word', single.addenda), () => 'translated'),
      numbered: await sent(() => ai.translateBatchWithAI(
        numbered.texts, numbered.targetLang, settings, numbered.addenda), () => '[1] A\n\n[2] B'),
      fast: await sent(() => ai.translateBatchFastWithAI(
        fast.texts, fast.targetLang, settings, fast.delimiter, fast.addenda), () => 'A@@B'),
    };
    for (const [path, system] of Object.entries(text)) {
      assert.ok(system.includes(prompts.REGISTER_RULE), `${label} ${path} lacks the register rule:\n${system}`);
      assert.ok(system.includes(FORUM_LINE), `${label} ${path} lost the forum label`);
    }
    const dictionary = await sent(() => ai.translateTextWithMode(
      word.text, word.targetLang, settings, word.mode === 'word', word.addenda), () => '{"translation":"你好","phonetic":""}');
    assert.ok(!dictionary.includes(prompts.REGISTER_RULE), `${label} word prompt carries the register rule:\n${dictionary}`);
    assert.ok(dictionary.includes(FORUM_LINE), `${label} word prompt lost the forum label`);
  }
});
