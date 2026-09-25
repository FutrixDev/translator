// 整页覆盖（pageScopeOverride）跟着顶层的指令走，设和清都跟：
// content/frames/child.js 的 applyDirective 精确镜像顶层——值变了才写、才让正文
// 范围的缓存作废；同值不动。
//
// 指令从生产监听进来（frames.setup() 挂上的 chrome.runtime.onMessage），不直接调
// 内部函数：FRAME_DIRECTIVE 这条消息就是顶层清掉覆盖后子 frame 唯一能听到的东西。
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

function loadChildFrame() {
  const listeners = [];
  const calls = { invalidatePageScope: 0, restart: 0 };
  // 夹具：content-bootstrap.js 建好的 ctx 里，child.js 用得到的那几样，逐个写成桩。
  const ctx = {
    frameRole: 'child',
    state: { translationsVisible: true, pageScopeOverride: null, isTranslatingPage: false },
    settings: { siteRules: {} },
    STATUS_AUTO: { RUNNING: 'running' },
    isExtensionContextInvalidated: () => false,
    invalidatePageScope: () => { calls.invalidatePageScope += 1; },
    setTranslationsVisible: (visible) => { ctx.state.translationsVisible = visible; },
    autoTranslate: { restart: () => { calls.restart += 1; }, onStateChange() {} },
    t: (key) => key,
  };
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    innerWidth: 640,
    innerHeight: 220,
    addEventListener() {},
    removeEventListener() {},
    location: { hostname: 'embed.example.com', pathname: '/widget' },
    AI_TRANSLATOR_CONTENT: ctx,
    chrome: {
      runtime: {
        // 中继回 null = 顶层还没登记这个 frame；这里只关心 FRAME_DIRECTIVE。
        sendMessage: async () => null,
        onMessage: { addListener: (fn) => listeners.push(fn) },
      },
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const rel of ['content/frames/shelf.js', 'content/frames/child.js']) {
    vm.runInContext(read(rel), sandbox, { filename: rel });
  }
  ctx.frames.setup();
  assert.equal(listeners.length, 1, 'child.js registers exactly one message listener');
  const send = (fields) => {
    const reply = listeners[0]({
      type: 'FRAME_DIRECTIVE',
      directive: { translate: false, manualEpoch: 0, visible: true, ...fields },
    });
    assert.equal(reply, undefined, 'FRAME_DIRECTIVE is fire-and-forget');
  };
  let epoch = 0;
  const directive = (scopeOverride) => send({ epoch: ++epoch, scopeOverride });
  return { ctx, calls, directive, send };
}

test('the child mirrors the top frame scope override: set, same value, clear', () => {
  const { ctx, calls, directive } = loadChildFrame();

  directive(null);
  assert.equal(ctx.state.pageScopeOverride, null);
  assert.equal(calls.invalidatePageScope, 0, 'nothing changed, nothing to invalidate');

  // 设：顶层点了「翻译整个页面」。
  directive('page');
  assert.equal(ctx.state.pageScopeOverride, 'page');
  assert.equal(calls.invalidatePageScope, 1);

  // 同值：下一条指令（比如显隐变了）照旧带着 'page'，不再作废缓存。
  directive('page');
  assert.equal(ctx.state.pageScopeOverride, 'page');
  assert.equal(calls.invalidatePageScope, 1, 'the same override invalidated the scope again');

  // 清：顶层不再覆盖。旧代码只在真值时写，这一步子 frame 会一直停在 'page'。
  directive(null);
  assert.equal(ctx.state.pageScopeOverride, null, 'the child kept an override the top had cleared');
  assert.equal(calls.invalidatePageScope, 2);

  // 缺字段与 null 同义：不是变化。
  directive(undefined);
  assert.equal(ctx.state.pageScopeOverride, null);
  assert.equal(calls.invalidatePageScope, 2);
});

test('a stale directive (epoch not newer) changes nothing', () => {
  const { ctx, calls, send } = loadChildFrame();
  send({ epoch: 5, scopeOverride: 'page' });
  send({ epoch: 3, scopeOverride: null });
  assert.equal(ctx.state.pageScopeOverride, 'page');
  assert.equal(calls.invalidatePageScope, 1);
});
