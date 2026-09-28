// 子 frame 的翻译请求信封（P1-C §3.8）：缓存和词表都在顶层，子 frame 的缓存查询
// 也经顶层，信封里的 via 说它在子 frame 里调的是哪一个。
//
//   子 frame（content/frames/child.js）覆写两条入口「送出」的那一步（盖语域留在
//     子 frame，D-382）：ctx.sendTranslation → via 'direct'，
//     ctx.sendTranslationCached → via 'cached'；
//   中继（background/frame-relay.js）：via 原样带到 FRAME_ENGINE_RELAY；
//   顶层（content/frames/top.js）：'cached' 调 ctx.sendTranslationCached，
//     'direct' 调 ctx.sendTranslation，别的值抛错、按失败回话；指令带 generation。
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
const flush = () => new Promise((resolve) => setImmediate(resolve));

function run(files, ctx, sandboxExtra) {
  const listeners = [];
  const sent = [];
  const errors = [];
  const sandbox = {
    console: { log() {}, warn() {}, error: (...args) => errors.push(args) },
    innerWidth: 640,
    innerHeight: 220,
    length: 1,
    addEventListener() {},
    removeEventListener() {},
    location: { hostname: 'embed.example.com', pathname: '/widget' },
    document: { getElementById: () => null },
    AI_TRANSLATOR_CONTENT: ctx,
    chrome: {
      runtime: {
        sendMessage: async (message) => {
          sent.push(message);
          return { translations: ['[T] x'], engine: 'ai' };
        },
        onMessage: { addListener: (fn) => listeners.push(fn) },
      },
    },
    ...sandboxExtra,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const rel of ['content/frames/shelf.js', ...files]) vm.runInContext(read(rel), sandbox, { filename: rel });
  return { listeners, sent, errors };
}

test('the child sends both engine calls to the top frame, each saying which one it was', async () => {
  const ctx = {
    frameRole: 'child',
    state: {},
    t: (key) => key,
    builtinTranslator: { pageSourceLang: async () => 'fr' },
    // 引擎和缓存层两个文件在 manifest 里排在 child.js 前面：它们先挂上的这两个
    // 「送出」会被覆盖。
    sendTranslation: () => assert.fail('the child must not run the engine itself'),
    sendTranslationCached: () => assert.fail('the child must not look up its own cache'),
  };
  const { sent } = run(['content/frames/child.js'], ctx);
  const message = { type: 'TRANSLATE_BATCH_FAST', texts: ['x'], targetLang: 'zh-CN' };
  await ctx.sendTranslationCached(message);
  await ctx.sendTranslation(message);
  assert.deepEqual(sent.map((m) => [m.type, m.via]), [
    ['FRAME_ENGINE_REQUEST', 'cached'],
    ['FRAME_ENGINE_REQUEST', 'direct'],
  ]);
  for (const each of sent) {
    // 消息是 vm 那个 realm 里造的对象，原型不同：按 JSON 比内容。
    assert.deepEqual(JSON.parse(JSON.stringify(each.message)), { ...message, allowDownload: false, pageSourceLang: 'fr' });
  }
});

test('the relay carries via through to the top frame unchanged', async () => {
  let listener = null;
  const toTop = [];
  globalThis.chrome = {
    runtime: { onMessage: { addListener: (fn) => { listener = fn; } } },
    tabs: {
      sendMessage: async (tabId, message, options) => {
        toTop.push({ tabId, message, options });
        return { translations: ['[T] x'] };
      },
    },
  };
  await import('../../background/frame-relay.js');
  const replies = [];
  const keep = listener({ type: 'FRAME_ENGINE_REQUEST', via: 'cached', message: { texts: ['x'] } },
    { tab: { id: 7 }, frameId: 3, documentId: 'doc-3' }, (reply) => replies.push(reply));
  assert.equal(keep, true);
  await flush();
  assert.deepEqual(toTop.map((each) => [each.tabId, each.message, each.options]), [
    [7, { type: 'FRAME_ENGINE_RELAY', via: 'cached', message: { texts: ['x'] } }, { frameId: 0 }],
  ]);
  assert.deepEqual(replies, [{ translations: ['[T] x'] }]);
});

function loadTop() {
  const calls = [];
  let generation = 0;
  const generationSubscribers = [];
  const broadcasts = [];
  const ctx = {
    frameRole: 'top',
    state: { translationsVisible: true, pageScopeOverride: null, isTranslatingPage: false },
    t: (key) => key,
    autoTranslate: { isOn: () => true, onStateChange: (fn) => fn() },
    customRules: { engineOverride: () => null, onChange() {} },
    translationProfile: {
      generation: () => generation,
      subscribe: (fn) => generationSubscribers.push(fn),
    },
    sendTranslation: async (message) => {
      calls.push(['direct', message.texts]);
      return { translations: ['direct'] };
    },
    sendTranslationCached: async (message) => {
      calls.push(['cached', message.texts]);
      return { translations: ['cached'] };
    },
  };
  const env = run(['content/frames/top.js'], ctx);
  ctx.frames.sendToRelay = (message) => broadcasts.push(message.directive);
  ctx.frames.setup();
  const bump = () => {
    generation += 1;
    for (const fn of generationSubscribers) fn(generation);
  };
  return { ctx, calls, broadcasts, bump, ...env };
}

async function relay(listener, via) {
  const replies = [];
  const keep = listener({ type: 'FRAME_ENGINE_RELAY', via, message: { texts: ['x'] } }, {}, (reply) => replies.push(reply));
  assert.equal(keep, true, 'the relay keeps the channel open for its answer');
  await flush();
  return replies;
}

test('the top frame runs a relayed request through the call the child named', async () => {
  const { listeners, calls, errors } = loadTop();
  assert.equal(listeners.length, 1);
  assert.deepEqual(await relay(listeners[0], 'cached'), [{ translations: ['cached'] }]);
  assert.deepEqual(await relay(listeners[0], 'direct'), [{ translations: ['direct'] }]);
  assert.deepEqual(calls, [['cached', ['x']], ['direct', ['x']]]);
  assert.deepEqual(errors, []);
});

test('an unknown via is a failure answered to the child and logged once, never a silent direct call', async () => {
  const { listeners, calls, errors } = loadTop();
  for (const via of [undefined, 'cache', '']) {
    const replies = await relay(listeners[0], via);
    assert.equal(replies.length, 1);
    assert.match(replies[0].error, /unknown via/);
  }
  assert.deepEqual(calls, []);
  assert.equal(errors.length, 3);
  assert.equal(errors[0][0], 'Blab Translation: frame engine relay failed');
});

test('a pass-fatal error (an unknown prompt domain) keeps its mark across the relay, and is logged once', async () => {
  const { ctx, listeners, errors } = loadTop();
  const fatal = Object.assign(new Error('promptDomainUnknown'), { passFatal: true, domain: 'astrology' });
  ctx.sendTranslationCached = async () => { throw fatal; };
  ctx.sendTranslation = async () => { throw new Error('plain'); };
  // 回话是 vm 那个 realm 里造的对象，原型不同：按 JSON 比内容。
  const reply = async (via) => JSON.parse(JSON.stringify(await relay(listeners[0], via)));
  assert.deepEqual(await reply('cached'), [{ error: 'promptDomainUnknown', passFatal: true }]);
  assert.deepEqual(await reply('direct'), [{ error: 'plain' }], 'an ordinary error carries no mark');
  assert.equal(errors.length, 2);
  assert.equal(errors[0][1], fatal);
});

test('the top frame directive carries the generation and is re-broadcast when it changes', () => {
  const { broadcasts, bump, listeners } = loadTop();
  // 刚 setup 完（window.length > 0）广播过一次第一版指令。
  assert.equal(broadcasts.length, 1);
  assert.equal(broadcasts[0].generation, 0);
  // 登记一个子 frame：没有登记的子 frame 时，变化不广播（top.js 的 refreshDirective）。
  const hello = [];
  listeners[0]({ type: 'FRAME_CHILD_HELLO', documentId: 'doc-1', sized: true }, {}, (reply) => hello.push(reply));
  assert.equal(hello[0].generation, 0);
  bump();
  const last = broadcasts[broadcasts.length - 1];
  assert.equal(last.generation, 1);
  assert.equal(last.epoch, 2);
});
