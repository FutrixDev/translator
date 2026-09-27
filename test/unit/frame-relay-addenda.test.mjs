// 子 frame 的翻译请求经中继在顶层送出（content/frames/child.js → background/
// frame-relay.js → content/frames/top.js），语域（R33 A4 的 addenda）是**发起请求
// 的那个 frame** 的：
//
//   - 子 frame 那一页有语域，请求带的是它自己的；
//   - 子 frame 那一页没有语域，请求里就没有 addenda 这个字段 —— 顶层是新闻站也
//     不许替它补一个 news；
//   - 顶层自己发的请求照旧按顶层的地址盖。
//
// 两个 frame 各是一个 vm 上下文，装的是真的引擎族、shelf.js 和 top.js / child.js；
// 中间是真的 background/frame-relay.js。跨 frame 的消息都过一遍 JSON，和 Chrome
// 的结构化克隆一样，谁也拿不到对面的对象。
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

const PAGE = 'This page is written in ordinary English prose, long enough for the detector to be sure. '.repeat(6);
const BLOCK = 'A paragraph of ordinary English prose, long enough that the engine asks the detector itself.';
const NEWS = 'https://www.bbc.co.uk/news/articles/x';
const FORUM = 'https://old.reddit.com/r/test/comments/1/a_thread/';
const PLAIN = 'https://comments.example.test/embed';

// manifest 里引擎族与帧协议的装载顺序（只取这两件事要的那几份）。
const SCRIPTS = [
  'shared/api-compat.js',
  'shared/lang-tags.js',
  'shared/target-lang.js',
  'shared/site-rules-builtin.js',
  'shared/storage-writer.js',
  'shared/site-rules.js',
  'shared/prompt-addenda.js',
  'content/engine/languages.js',
  'content/engine/watchdog.js',
  'content/content-translation-engine.js',
  'content/frames/shelf.js',
];

/**
 * 一个 frame：自己的全局、自己的 location、自己的一份引擎。`sendMessage` 是这个
 * frame 的 chrome.runtime.sendMessage。返回 ctx 与这个 frame 装上的 onMessage 监听。
 */
function frameRealm({ url, role, sendMessage }) {
  const listeners = [];
  const sandbox = {
    console: { info() {}, warn() {}, log() {}, error: console.error },
    setTimeout,
    clearTimeout,
    URL,
    isSecureContext: true,
    Translator: {
      availability: async () => 'available',
      create: async () => ({ translate: async (text) => `builtin:${text}`, destroy() {} }),
    },
    navigator: { userActivation: { isActive: false } },
    document: { body: { innerText: PAGE } },
    location: new URL(url),
    chrome: {
      i18n: { detectLanguage: async () => ({ isReliable: true, languages: [{ language: 'en', percentage: 99 }] }) },
      storage: {
        sync: { get: async () => ({ apiKey: 'test-key' }), set: async () => {} },
        local: { get: async () => ({}), set: async () => {} },
        onChanged: { addListener() {} },
      },
      runtime: {
        id: 'test',
        sendMessage,
        onMessage: { addListener: (fn) => listeners.push(fn) },
      },
    },
  };
  sandbox.self = sandbox;
  sandbox.window = sandbox;
  sandbox.length = 0;
  sandbox.addEventListener = () => {};
  sandbox.removeEventListener = () => {};
  sandbox.AI_TRANSLATOR_CONTENT = {
    frameRole: role,
    state: {},
    settings: { translationEngine: 'ai', autoTranslateEngine: 'ai', engineFallback: 'allow-ai' },
    t: (key) => key,
    isExtensionContextInvalidated: () => false,
    getLanguageDetectionText: (text) => String(text || '').slice(0, 400),
    autoTranslate: { onStateChange() {} },
    customRules: { whenReady: async () => {}, onChange() {}, engineOverride: () => null },
  };
  vm.createContext(sandbox);
  for (const rel of [...SCRIPTS, `content/frames/${role}.js`]) {
    vm.runInContext(read(rel), sandbox, { filename: rel });
  }
  return { ctx: sandbox.AI_TRANSLATOR_CONTENT, listeners };
}

/** 调一个 onMessage 监听，按 Chrome 的规矩收它的回话（return true = 异步回话）。 */
function deliver(listener, message, sender) {
  return new Promise((resolve) => {
    const async = listener(clone(message), sender, (reply) => resolve(clone(reply)));
    if (async !== true) resolve(undefined);
  });
}

// ------------------------------------------------------------ 顶层：新闻页

const sentToAI = [];
const top = frameRealm({
  url: NEWS,
  role: 'top',
  sendMessage: async (message) => {
    sentToAI.push(clone(message));
    return { translation: `AI:${message.text}`, phonetic: '', isWord: false };
  },
});
top.ctx.frames.setup();
assert.equal(top.listeners.length, 1, 'top.js did not listen for its children');

// ------------------------------------------------------------ 中继：服务工作者

let relayListener = null;
globalThis.chrome = {
  runtime: { onMessage: { addListener: (fn) => { relayListener = fn; } } },
  tabs: {
    sendMessage: (_tabId, message, options) => {
      assert.deepEqual(options, { frameId: 0 });
      return deliver(top.listeners[0], message, { id: 'test' });
    },
  },
};
await import('../../background/frame-relay.js');
const SENDER = { tab: { id: 7 }, frameId: 3, documentId: 'doc-3' };

function childFrame(url) {
  return frameRealm({
    url,
    role: 'child',
    sendMessage: (message) => deliver(relayListener, message, SENDER),
  });
}

function translate(ctx) {
  return ctx.requestTranslation({ type: 'TRANSLATE', text: BLOCK, targetLang: 'zh-CN', mode: 'text' });
}

test('a child frame with a register sends its own, not the top page one', async () => {
  sentToAI.length = 0;
  const child = childFrame(FORUM);
  const result = await translate(child.ctx);
  assert.equal(result.translation, `AI:${BLOCK}`);
  assert.equal(sentToAI.length, 1);
  assert.deepEqual(sentToAI[0].addenda, { register: 'forum' });
  // 它确实是经顶层送出的中继请求。
  assert.equal(sentToAI[0].allowDownload, false);
});

test('a child frame without a register sends no addenda under a news top page', async () => {
  sentToAI.length = 0;
  const child = childFrame(PLAIN);
  await translate(child.ctx);
  await child.ctx.requestTranslation({ type: 'TRANSLATE_BATCH_FAST', texts: [BLOCK], targetLang: 'zh-CN', delimiter: '@@' });
  assert.equal(sentToAI.length, 2);
  for (const message of sentToAI) {
    assert.ok(!('addenda' in message), `${message.type} grew addenda: ${JSON.stringify(message.addenda)}`);
  }
});

test('the top page own requests still carry the top page register', async () => {
  sentToAI.length = 0;
  await translate(top.ctx);
  assert.deepEqual(sentToAI[0].addenda, { register: 'news' });
});

test('a request is stamped once: stamping a stamped request throws', () => {
  const stamped = top.ctx.withPromptAddenda({ type: 'TRANSLATE', text: BLOCK, targetLang: 'zh-CN' });
  assert.deepEqual(clone(stamped.addenda), { register: 'news' });
  assert.throws(() => top.ctx.withPromptAddenda(stamped), /already stamped/);
  // 没有语域的那一页盖出来也没有这个字段，于是不会被当成「盖过」。
  const bare = { type: 'TRANSLATE', text: BLOCK, targetLang: 'zh-CN' };
  const child = childFrame(PLAIN);
  const once = child.ctx.withPromptAddenda(bare);
  assert.ok(!('addenda' in once));
});
