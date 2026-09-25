// content/page/shadow.js 的两处「删除优于兼容」：
//
//   1. closed root 只对 HTMLElement 问 chrome.dom：名字带 `-` 的 MathML / SVG 元素
//      在调用之前就挡掉，不再靠 try/catch 吞掉 Chrome 的参数错误；
//   2. 译文样式只走 constructable stylesheet：装不上、要不到，接住的地方各打一条
//      日志；并发的 root 共用一次在途请求；空文本不缓存；replaceSync 失败不留下一张
//      空表。
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SOURCE = readFileSync(path.join(ROOT, 'content/page/shadow.js'), 'utf8');

const flush = () => new Promise((resolve) => setImmediate(resolve));

class FakeElement {
  constructor(localName) {
    this.localName = localName;
    this.nodeType = 1;
    this.shadowRoot = null;
    this.isConnected = true;
  }
}
class FakeHTMLElement extends FakeElement {}

/**
 * 每条测试一份新沙箱：shadow.js 的样式缓存是模块级的。
 * - sendMessage：GET_SHADOW_STYLES 的回话由测试给；
 * - sheets：每张 new CSSStyleSheet() 都记下来，replaceSync 可以按次数抛错。
 */
function load({ sendMessage, dom, failReplaceTimes = 0 } = {}) {
  const warnings = [];
  const sheets = [];
  let replaceFailures = failReplaceTimes;
  class FakeSheet {
    constructor() { sheets.push(this); this.css = null; }
    replaceSync(css) {
      if (replaceFailures > 0) { replaceFailures -= 1; throw new Error('replaceSync refused'); }
      this.css = css;
    }
  }
  const ctx = {};
  const sandbox = {
    console: { warn: (...args) => warnings.push(args), log() {}, error() {} },
    Node: { ELEMENT_NODE: 1, DOCUMENT_FRAGMENT_NODE: 11 },
    HTMLElement: FakeHTMLElement,
    CSSStyleSheet: FakeSheet,
    chrome: { runtime: sendMessage ? { sendMessage } : undefined, dom },
    globalThis: null,
  };
  sandbox.window = { AI_TRANSLATOR_CONTENT: ctx };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox, { filename: 'content/page/shadow.js' });
  return { ctx, warnings, sheets };
}

function shadowRoot() {
  const host = new FakeHTMLElement('x-host');
  return { nodeType: 11, host, adoptedStyleSheets: [] };
}

// 一个被分进 shadow root 的块：afterInsertTranslation 从它的 getRootNode() 找到 root。
function blockIn(root) {
  return {
    element: {
      isConnected: true,
      getRootNode: () => root,
      getAttribute: () => null,
    },
  };
}

test('MathML and SVG elements with a dash never reach chrome.dom, and yield no root', () => {
  // 夹具：chrome.dom 桩，对非 HTMLElement 抛错，模拟 Chrome 的参数校验
  const calls = [];
  const dom = {
    openOrClosedShadowRoot(el) {
      calls.push(el.localName);
      if (!(el instanceof FakeHTMLElement)) throw new TypeError('Error in invocation of dom.openOrClosedShadowRoot');
      return null;
    },
  };
  const { ctx } = load({ dom });
  const annotation = new FakeElement('annotation-xml'); // MathML
  const fontFace = new FakeElement('font-face'); // SVG
  for (const el of [annotation, fontFace]) {
    assert.equal(ctx.isShadowContainer(el), true, 'a dashed name is still a container for collect.js');
    el.children = [];
    assert.deepEqual([...ctx.composedChildren(el)], [], `${el.localName} got a composed tree`);
  }
  assert.deepEqual(calls, [], 'chrome.dom was asked about a non-HTMLElement');
  // 反面对照：自定义元素照常问，桩给的 closed root 被认出来。
  const closed = { nodeType: 11, host: null, children: ['inside'], childNodes: [] };
  const custom = new FakeHTMLElement('x-card');
  custom.children = [];
  const withRoot = load({ dom: { openOrClosedShadowRoot: () => closed } });
  assert.deepEqual([...withRoot.ctx.composedChildren(custom)], ['inside']);
});

test('concurrent roots share one GET_SHADOW_STYLES request and one sheet', async () => {
  let asked = 0;
  const { ctx, sheets, warnings } = load({
    sendMessage: async (message) => { asked += 1; assert.equal(message.type, 'GET_SHADOW_STYLES'); return { css: '.a{}' }; },
  });
  const roots = [shadowRoot(), shadowRoot(), shadowRoot()];
  for (const root of roots) ctx.afterInsertTranslation(blockIn(root));
  await flush();
  assert.equal(asked, 1, 'each root sent its own request');
  assert.equal(sheets.length, 1, 'each root built its own sheet');
  for (const root of roots) assert.deepEqual([...root.adoptedStyleSheets], [sheets[0]]);
  // 已经装上的 root 再插一块，不再问、不重复 adopt。
  ctx.afterInsertTranslation(blockIn(roots[0]));
  await flush();
  assert.equal(asked, 1);
  assert.equal(roots[0].adoptedStyleSheets.length, 1);
  assert.deepEqual(warnings, []);
});

test('an empty stylesheet reply is not cached: the next root asks again', async () => {
  const replies = [{ css: '' }, { css: '.a{}' }];
  let asked = 0;
  const { ctx, warnings } = load({ sendMessage: async () => replies[asked++] });
  const first = shadowRoot();
  ctx.afterInsertTranslation(blockIn(first));
  await flush();
  assert.deepEqual([...first.adoptedStyleSheets], [], 'an empty text was installed');
  const second = shadowRoot();
  ctx.afterInsertTranslation(blockIn(second));
  await flush();
  assert.equal(asked, 2, 'the empty reply was cached');
  assert.equal(second.adoptedStyleSheets.length, 1);
  assert.deepEqual(warnings, [], 'an empty reply is the worker already having logged, not a new failure');
});

test('a failed style request logs exactly once and is asked again next time', async () => {
  let asked = 0;
  const { ctx, warnings } = load({
    sendMessage: async () => {
      asked += 1;
      if (asked === 1) throw new Error('worker gone');
      return { css: '.a{}' };
    },
  });
  const first = shadowRoot();
  ctx.afterInsertTranslation(blockIn(first));
  await flush();
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0][0], 'Blab Translation: loading shadow styles failed');
  assert.equal(warnings[0][1].message, 'worker gone');
  assert.deepEqual([...first.adoptedStyleSheets], []);
  ctx.afterInsertTranslation(blockIn(first));
  await flush();
  assert.equal(asked, 2);
  assert.equal(first.adoptedStyleSheets.length, 1);
  assert.equal(warnings.length, 1);
});

test('replaceSync failing logs once, leaves no empty sheet behind, and the next insert installs it', async () => {
  const { ctx, sheets, warnings } = load({ sendMessage: async () => ({ css: '.a{}' }), failReplaceTimes: 1 });
  const root = shadowRoot();
  ctx.afterInsertTranslation(blockIn(root));
  await flush();
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0][0], 'Blab Translation: installing shadow styles failed');
  assert.equal(warnings[0][1].message, 'replaceSync refused');
  assert.deepEqual([...root.adoptedStyleSheets], [], 'the half-built sheet was adopted');
  // 下一次插入：新建一张（上一张没有留下来当共享表），这次装上了。
  const other = shadowRoot();
  ctx.afterInsertTranslation(blockIn(other));
  ctx.afterInsertTranslation(blockIn(root));
  await flush();
  assert.equal(sheets.length, 2);
  assert.equal(sheets[1].css, '.a{}');
  assert.deepEqual([...other.adoptedStyleSheets], [sheets[1]]);
  assert.deepEqual([...root.adoptedStyleSheets], [sheets[1]]);
  assert.equal(warnings.length, 1);
});
