// 帧协议的失败怎么处理（删除优于兼容：不许静默吞错）：
//
//   - 服务工作者这边（background/frame-relay.js）：「对面没有监听」是协议里的正常
//     情况，只经 isNoReceiver 一处判定、不打日志；别的错恰好一条日志。
//   - 内容脚本这边（content/frames/shelf.js 的 sendToRelay）：中继总在，扩展上下文
//     失效往上抛、不打日志；别的错恰好一条日志、回话当 null。
//
// Chrome 的两种消息语义是在 e2e 的真 Chromium 里实测的（frames.spec.js「relay
// semantics」），这里的错误文案抄自那次实测。
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NO_RECEIVER = 'Could not establish connection. Receiving end does not exist.';
const flush = () => new Promise((resolve) => setImmediate(resolve));

// ------------------------------------------------------------ 服务工作者这边

let relayListener = null;
let tabsSend = async () => undefined;
globalThis.chrome = {
  runtime: { onMessage: { addListener: (fn) => { relayListener = fn; } } },
  tabs: { sendMessage: (...args) => tabsSend(...args) },
};
// 中继在每次转发时才读 chrome.tabs，所以这个桩要一直挂着（node --test 每个文件一个进程）。
const { isNoReceiver } = await import('../../background/frame-relay.js');

async function withWarnings(run) {
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    await run();
    await flush();
  } finally {
    console.warn = original;
  }
  return warnings;
}

const SENDER = { tab: { id: 7 }, frameId: 3, documentId: 'doc-3' };

test('isNoReceiver recognises only the Chrome no-receiver rejection', () => {
  assert.equal(isNoReceiver(new Error(NO_RECEIVER)), true);
  assert.equal(isNoReceiver(NO_RECEIVER), true);
  assert.equal(isNoReceiver(new Error('Extension context invalidated.')), false);
  assert.equal(isNoReceiver(new Error('The message port closed before a response was received.')), false);
  assert.equal(isNoReceiver(undefined), false);
});

test('HELLO with no top frame listening answers null and logs nothing', async () => {
  tabsSend = async () => { throw new Error(NO_RECEIVER); };
  const replies = [];
  const warnings = await withWarnings(() => {
    const keep = relayListener({ type: 'FRAME_HELLO', sized: true }, SENDER, (reply) => replies.push(reply));
    assert.equal(keep, true, 'HELLO keeps the channel open for its answer');
  });
  assert.deepEqual(replies, [null]);
  assert.deepEqual(warnings, []);
});

test('a top frame that listens but does not answer is not an error either', async () => {
  tabsSend = async () => undefined;
  const replies = [];
  const warnings = await withWarnings(() => {
    relayListener({ type: 'FRAME_HELLO', sized: true }, SENDER, (reply) => replies.push(reply));
    relayListener({ type: 'FRAME_REPORT', translated: 2 }, SENDER, () => assert.fail('REPORT is fire-and-forget'));
    relayListener({ type: 'FRAME_DIRECTIVE_BROADCAST', directive: { epoch: 1 } }, SENDER, () => {});
  });
  assert.deepEqual(replies, [null]);
  assert.deepEqual(warnings, []);
});

test('BYE and the directive broadcast with no receiver log nothing', async () => {
  tabsSend = async () => { throw new Error(NO_RECEIVER); };
  const warnings = await withWarnings(() => {
    assert.equal(relayListener({ type: 'FRAME_BYE' }, SENDER, () => {}), undefined);
    assert.equal(relayListener({ type: 'FRAME_DIRECTIVE_BROADCAST', directive: { epoch: 1 } }, SENDER, () => {}), undefined);
  });
  assert.deepEqual(warnings, []);
});

test('any other failure relaying to the top logs exactly once, and the child still gets null', async () => {
  tabsSend = async () => { throw new Error('boom'); };
  const replies = [];
  const warnings = await withWarnings(() => {
    relayListener({ type: 'FRAME_ENGINE_REQUEST', message: { text: 'x' } }, SENDER, (reply) => replies.push(reply));
  });
  assert.deepEqual(replies, [null]);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0][0], 'Blab Translation: frame relay to top failed');
  assert.equal(warnings[0][1], 'FRAME_ENGINE_RELAY');
  assert.equal(warnings[0][2].message, 'boom');
});

test('any other failure broadcasting a directive logs exactly once', async () => {
  tabsSend = async () => { throw new Error('boom'); };
  const warnings = await withWarnings(() => {
    relayListener({ type: 'FRAME_DIRECTIVE_BROADCAST', directive: { epoch: 1 } }, SENDER, () => {});
  });
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0][0], 'Blab Translation: frame directive broadcast failed');
  assert.equal(warnings[0][1].message, 'boom');
});

test('the relay stays out of messages that are not FRAME_*', () => {
  tabsSend = async () => assert.fail('a non-frame message was relayed');
  assert.equal(relayListener({ type: 'TRANSLATE_TEXT' }, SENDER, () => {}), undefined);
});

// ------------------------------------------------------------ 内容脚本这边

/**
 * 只装 shelf.js。上下文失效的判定是 content-bootstrap.js 的
 * ctx.isExtensionContextInvalidated；这里不装 bootstrap，写一个带标注的桩。
 */
function loadShelf(sendMessage) {
  const warnings = [];
  const ctx = {
    frameRole: 'child',
    // 夹具：content-bootstrap.js 的 isExtensionContextInvalidated 桩，只认 Chrome 的上下文失效文案
    isExtensionContextInvalidated: (error) => String((error && error.message) || error).includes('Extension context invalidated'),
  };
  const sandbox = {
    console: { warn: (...args) => warnings.push(args) },
    chrome: { runtime: { sendMessage } },
  };
  sandbox.window = { AI_TRANSLATOR_CONTENT: ctx };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(path.join(ROOT, 'content/frames/shelf.js'), 'utf8'), sandbox);
  return { frames: ctx.frames, warnings };
}

test('sendToRelay passes a context-invalidated error up, without a log', async () => {
  const { frames, warnings } = loadShelf(async () => { throw new Error('Extension context invalidated.'); });
  await assert.rejects(frames.sendToRelay({ type: 'FRAME_HELLO' }), /Extension context invalidated/);
  assert.deepEqual(warnings, []);
});

test('sendToRelay logs any other failure exactly once and answers null', async () => {
  const { frames, warnings } = loadShelf(async () => { throw new Error('boom'); });
  assert.equal(await frames.sendToRelay({ type: 'FRAME_REPORT' }), null);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0][0], 'Blab Translation: frame relay message failed');
  assert.equal(warnings[0][1], 'FRAME_REPORT');
  assert.equal(warnings[0][2].message, 'boom');
});

test('sendToRelay hands the relay answer through untouched', async () => {
  const directive = { epoch: 4 };
  const { frames, warnings } = loadShelf(async () => directive);
  assert.equal(await frames.sendToRelay({ type: 'FRAME_HELLO' }), directive);
  assert.deepEqual(warnings, []);
});
