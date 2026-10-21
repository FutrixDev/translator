// 语域附加说明在内容脚本这一半（R33 A4）：ctx.requestTranslation 入口用 ctx.withPromptAddenda
// 把这一页的语域挂到发给服务工作者的消息上，译文缓存把它放进键。
//
// 契约：
//   - 挂的是 `addenda: {register}`，只有标签；消息里不出现这一页的域名；没有
//     语域的页面挂 `{}`。
//   - 只挂在两种翻译消息上（P1-D 删了 TRANSLATE_BATCH）；这一页内置表里没有语域就不挂这个字段。
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
// 缓存层在加载时订阅词表镜像（ctx.glossary）和本站规则的 onProfileChange（P1-C）：
// manifest 里 content/content-glossary.js 与 content/page/custom-rule.js 都排在它
// 前面。这里装真的镜像（夹具不是顶层帧，镜像为空），规则那一边没有规则、不回调。
await import('../../shared/sync-collection.js');
// glossary.js 在加载时取走 BATCH_DELIMITER（词条里不许有批量分隔符，P1-D）。
await import('../../shared/batch-delimiter.js');
await import('../../shared/glossary.js');
await import('../../content/content-glossary.js');
ctx.customRules.onProfileChange = () => () => {};
await import('../../shared/translation-cache.js');
// 缓存层换代时清掉发现层的内容记忆（shared/block-identity.js）。
await import('../../shared/block-identity.js');
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
  await ctx.requestTranslation({ type: 'TRANSLATE', feature: 'selection', text: BLOCK, targetLang: 'zh-CN', mode: 'text' });
  await ctx.requestTranslation({ type: 'TRANSLATE_BATCH_FAST', feature: 'page', texts: [BLOCK], targetLang: 'zh-CN' });
  assert.equal(sentToAI.length, 2);
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
  await ctx.requestTranslation({ type: 'TRANSLATE', feature: 'selection', text: BLOCK, targetLang: 'zh-CN', mode: 'text' });
  goTo('https://www.bbc.co.uk/news/articles/x');
  await ctx.requestTranslation({ type: 'TRANSLATE', feature: 'selection', text: BLOCK, targetLang: 'zh-CN', mode: 'text' });
  goTo('https://example.test/');
  await ctx.requestTranslation({ type: 'TRANSLATE', feature: 'selection', text: BLOCK, targetLang: 'zh-CN', mode: 'text' });
  assert.deepEqual(sentToAI.map((m) => m.addenda.register), ['social', 'news', undefined]);
  assert.equal(JSON.stringify(sentToAI[2].addenda), '{}', 'a page with no register still sends the field, empty');
});

test('the built-in engine gets no addenda and other message types are left alone', async () => {
  goTo(REDDIT);
  useAI();
  Object.assign(ctx.settings, { translationEngine: 'builtin' });
  const result = await ctx.requestTranslation({ type: 'TRANSLATE', feature: 'selection', text: BLOCK, targetLang: 'zh-CN', mode: 'text' });
  assert.equal(result.engine, 'builtin');
  assert.equal(sentToAI.length, 0);
  assert.equal(translateCalls.length, 1);

  useAI();
  await ctx.requestTranslation({ type: 'SOMETHING_ELSE', feature: 'page', payload: 1 });
  assert.equal(sentToAI.length, 1);
  assert.ok(!('addenda' in sentToAI[0]), 'a non-translation message was given addenda');
});

test('the same text on a forum page and on a news page are two cache keys', async () => {
  useAI();
  local.clear();
  const ask = () => ctx.requestTranslationCached({
    type: 'TRANSLATE_BATCH_FAST', feature: 'page', texts: ['A cached paragraph.'], targetLang: 'zh-CN',
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

  // 键和请求出自同一个盖好的对象、同一个因子（D-382）：同一页、同一段，领域一变
  // 就是另一个键，送出去的请求也带着那个领域和这一页的语域。
  ctx.settings.promptDomain = 'legal';
  try {
    await ask();
    assert.equal(sentToAI.length, 3, 'a legal-domain request reused the general translation');
    assert.deepEqual(sentToAI[2].addenda, { register: 'news', domain: 'legal' });
    await ask();
    assert.equal(sentToAI.length, 3, 'the second legal-domain request was not served from the cache');
  } finally {
    ctx.settings.promptDomain = 'general';
  }
});

// 「用 AI 解释此处语境」带着那一句的 TRANSLATE 与不带的同一个词不能共用一条缓存
// （D-641）：TRANSLATE 根本不进缓存，每一次都发到模型，storage 里不留键。
test('a selection TRANSLATE, explained or not, never enters the cache (D-641)', async () => {
  useAI();
  local.clear();
  goTo('https://example.test/');
  globalThis.chrome.runtime.sendMessage = async (message) => {
    sentToAI.push(message);
    return { translation: 'AI' };
  };
  const ask = (extra) => ctx.requestTranslationCached({
    type: 'TRANSLATE', feature: 'selection', text: 'sat', targetLang: 'zh-CN', mode: 'word', ...extra,
  });
  await ask({});
  await ask({ explainContext: true, pageContext: { before: 'The cat sat on the mat.', after: '' } });
  await ask({});
  assert.equal(sentToAI.length, 3, 'a selection request was answered from the cache');
  assert.equal(sentToAI[0].addenda.context, undefined);
  assert.equal(sentToAI[1].addenda.context.before, 'The cat sat on the mat.');
  assert.equal(sentToAI[2].addenda.context, undefined, 'the explained answer leaked into a plain request');
  assert.equal(local.size, 0, 'a selection request wrote a cache entry');
});

// 算键（serve 头一步）和送出之间隔着读 storage（readL2）：那期间用户改了领域，
// 键和发出去的提示词也必须是同一份领域（D-384 F1）。缓存层在算键前取一份
// {domain, context}，经 opts 交给送出那一步；改之前送出时现读，键说 general、
// 请求却带着 legal，这一条 legal 的译文就存进了 general 的键。
test('a domain changed while the cache is read does not split the key from the request (D-384 F1)', async () => {
  useAI();
  local.clear();
  goTo('https://example.test/');
  globalThis.chrome.runtime.sendMessage = async (message) => {
    sentToAI.push(message);
    return { translations: message.texts.map((t) => `AI:${t}`) };
  };
  const stamps = [];
  const realStamp = ctx.engine.addenda.stamp;
  ctx.engine.addenda.stamp = (...args) => {
    const stamp = realStamp(...args);
    stamps.push(stamp);
    return stamp;
  };
  const realGet = globalThis.chrome.storage.local.get;
  let release;
  const reading = new Promise((resolve) => {
    globalThis.chrome.storage.local.get = (keys) => {
      resolve();
      return new Promise((done) => { release = () => done(realGet(keys)); });
    };
  });
  try {
    const pending = ctx.requestTranslationCached({
      type: 'TRANSLATE_BATCH_FAST', feature: 'page', texts: ['A paragraph read while the domain changes.'],
      targetLang: 'zh-CN',
    });
    await reading;
    ctx.settings.promptDomain = 'legal';
    release();
    await pending;
    assert.equal(sentToAI.length, 1);
    assert.equal(stamps.length, 1);
    const keyed = stamps[0].match(/\|d:([a-z]+)\|/)[1];
    const sent = sentToAI[0].addenda.domain || 'general';
    assert.equal(sent, keyed, `the key says d:${keyed} but the request carried ${sent}`);
  } finally {
    globalThis.chrome.storage.local.get = realGet;
    ctx.engine.addenda.stamp = realStamp;
    ctx.settings.promptDomain = 'general';
  }
});

// ---- 两头接起来：内容脚本发出的消息 → 服务工作者的监听器 → 系统提示词 ----
// 放在最后：它把服务工作者那一半（真的 background.js，连同真的 AutoStats）装进
// 这个进程，上面缓存那条要的是桩。

/**
 * 服务工作者加载时碰的、这里不关心的东西（菜单、闹钟、图标、生命周期事件）一律
 * 回一个无害的替身，模块图照 Chrome 里那样装起来（media-consent-sw.test.mjs 同法）。
 */
function standIn() {
  const fn = () => standIn();
  return new Proxy(fn, {
    get: (_target, prop) => (prop === 'then' ? undefined : standIn()),
    apply: () => undefined,
  });
}

function area(store) {
  return {
    get: async (keys) => {
      if (keys == null) return { ...store };
      const defaults = typeof keys === 'string' ? { [keys]: undefined }
        : Array.isArray(keys) ? Object.fromEntries(keys.map((key) => [key, undefined])) : keys;
      const out = {};
      for (const [key, value] of Object.entries(defaults)) {
        if (key in store) out[key] = store[key];
        else if (value !== undefined) out[key] = value;
      }
      return out;
    },
    set: async (values) => { Object.assign(store, values); },
    remove: async (keys) => { for (const key of [].concat(keys)) delete store[key]; },
  };
}

test('the register rule reaches every text prompt and no word prompt, default and custom', async () => {
  goTo(REDDIT);
  useAI();
  sentToAI.length = 0;
  globalThis.chrome.runtime.sendMessage = async (message) => {
    sentToAI.push(message);
    return { translation: 'AI', translations: [] };
  };
  await ctx.requestTranslation({ type: 'TRANSLATE', feature: 'selection', text: BLOCK, targetLang: 'zh-CN', mode: 'text' });
  await ctx.requestTranslation({ type: 'TRANSLATE', feature: 'selection', text: 'hello', targetLang: 'zh-CN', mode: 'word', wordLang: 'other' });
  await ctx.requestTranslation({ type: 'TRANSLATE_BATCH_FAST', feature: 'page', texts: ['a', 'b'], targetLang: 'zh-CN' });
  const [single, word, fast] = sentToAI;
  assert.equal(sentToAI.length, 3);

  // 内容脚本那一半到此为止；下面换上服务工作者的 chrome，装真的 background.js，
  // 三条消息交给它注册的监听器 —— 消息怎么拆、怎么交给翻译函数，是 background.js
  // 自己的事，这里不抄。接口、Key、模型在旧四键里，第一次取档时迁成
  // aiProfile:legacy（内容脚本这边选的正是那一档）；自定义提示词在设置里。
  const sync = {
    provider: 'openai',
    apiEndpoint: 'https://api.openai.com/v1/chat/completions',
    apiKey: 'test-key',
    modelName: 'gpt-4.1-mini',
    customPrompt: '',
  };
  const listeners = [];
  globalThis.chrome = new Proxy({
    i18n: { getUILanguage: () => 'en', detectLanguage: globalThis.chrome.i18n.detectLanguage },
    storage: { sync: area(sync), local: area({}), session: area({}), onChanged: { addListener() {} } },
    runtime: new Proxy({
      onMessage: { addListener: (fn) => listeners.push(fn) },
      getURL: (path) => `chrome-extension://test/${path}`,
      getManifest: () => ({ version: '9.9.9' }),
      // StorageWriter 在 Node 里认不出服务工作者（IN_SERVICE_WORKER 是加载时定的），
      // 于是 AutoStats 的记账写成一条消息发出去；这里没人收，回 null。
      sendMessage: async () => null,
      lastError: undefined,
    }, { get: (target, prop) => (prop in target ? target[prop] : standIn()) }),
  }, { get: (target, prop) => (prop in target ? target[prop] : standIn()) });
  // fetch 记下每一次真发出去的系统提示词，按次序回 replies 里的答案。
  const systems = [];
  let replies = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    systems.push(body.messages[0].content);
    return new Response(JSON.stringify({ choices: [{ message: { content: replies.shift() } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const prompts = await import('../../background/prompts.js');
  await import('../../background/background.js');
  const { PromptAddenda } = globalThis;
  const FORUM_LINE = `${PromptAddenda.HEADINGS.register} ${PromptAddenda.REGISTER_SENTENCES.forum}`;
  const send = (message) => new Promise((resolve) => {
    for (const listener of listeners) listener(message, { tab: { id: 1, url: REDDIT } }, resolve);
  });

  for (const [label, customPrompt] of [
    ['default template', ''],
    ['custom prompt', 'Translate into {targetLang}. Be brief.'],
  ]) {
    sync.customPrompt = customPrompt;
    const sent = async (message, answers) => {
      systems.length = 0;
      replies = [...answers];
      const reply = await send(message);
      assert.ok(reply && !reply.error, `${label} ${message.type}: ${JSON.stringify(reply)}`);
      assert.equal(systems.length, answers.length, `${label}: ${systems.length} requests`);
      assert.equal(replies.length, 0);
      return systems;
    };
    const [textPrompt] = await sent(single, ['translated']);
    const [fastPrompt] = await sent(fast, [`A${globalThis.BATCH_DELIMITER}B`]);
    // 分隔符对不上时快速批回退到编号批：同一条消息，第二次真发出去的请求。
    const [, numberedPrompt] = await sent(fast, ['A', '[1] A\n\n[2] B']);
    for (const [path, system] of Object.entries({ single: textPrompt, fast: fastPrompt, numbered: numberedPrompt })) {
      assert.ok(system.includes(prompts.REGISTER_RULE), `${label} ${path} lacks the register rule:\n${system}`);
      assert.ok(system.includes(FORUM_LINE), `${label} ${path} lost the forum label`);
    }
    assert.ok(numberedPrompt !== fastPrompt, `${label}: the fallback sent the fast prompt again`);
    const [dictionary] = await sent(word, ['{"translation":"你好"}']);
    // background.js 把 mode: 'word' 与 wordLang 交下去，选中的是这一档的规则。
    assert.ok(dictionary.endsWith(prompts.WORD_MODES.other.rules), `${label} word path:\n${dictionary}`);
    assert.ok(!dictionary.includes(prompts.REGISTER_RULE), `${label} word prompt carries the register rule:\n${dictionary}`);
    assert.ok(dictionary.includes(FORUM_LINE), `${label} word prompt lost the forum label`);
  }

  // 消息的请求那一半（background.js 的 translateRequestOf）：不带 mode 是文本；
  // 认不出的 mode、没有 wordLang 的词都在发出任何请求之前回错。
  sync.customPrompt = '';
  const { mode: _mode, ...noMode } = single;
  const [untagged] = await (async () => {
    systems.length = 0;
    replies = ['translated'];
    const reply = await send(noMode);
    assert.deepEqual(reply, { translation: 'translated' });
    return systems;
  })();
  assert.ok(untagged.includes(prompts.REGISTER_RULE), `a message without a mode took the word path:\n${untagged}`);
  for (const [bad, error] of [
    [{ ...single, mode: 'dictionary' }, /unknown request mode dictionary/],
    [{ ...word, wordLang: undefined }, /unknown wordLang undefined/],
  ]) {
    systems.length = 0;
    const reply = await send(bad);
    assert.match(reply.error, error);
    assert.equal(systems.length, 0, `${JSON.stringify(bad)} reached the model`);
  }
});
