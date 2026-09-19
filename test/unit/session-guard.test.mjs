import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

await import('../../shared/block-identity.js');
await import('../../shared/session-guard.js');

const { BlockIdentity, SessionGuard } = globalThis;

// 假元素：SessionGuard 只碰 isConnected，其余全靠注入的 readText 读。
// 整个模块因此在 node 里跑得起来，而这几条校验恰恰是最难在浏览器里造出来的。
function el(text, { connected = true } = {}) {
  return { text, isConnected: connected };
}

function guard() {
  return SessionGuard.create({
    readText: (element) => element.text,
    fingerprint: (text) => BlockIdentity.fingerprint(text)
  });
}

test('create 缺依赖直接抛，不给一个永远返回 true 的 accept', () => {
  assert.throws(() => SessionGuard.create(), TypeError);
  assert.throws(() => SessionGuard.create({ readText: () => '' }), TypeError);
  assert.throws(() => SessionGuard.create({ fingerprint: () => '' }), TypeError);
});

test('一切未变: 盖章后立刻校验通过', () => {
  const g = guard();
  const node = el('Hello world');
  assert.equal(g.accept(g.stamp(node)), true);
});

// —— 三条校验各自独立生效（设计 §9.1）——
// 每条都单独造一次，确保不是「另外两条顺手挡住了」。

test('校验一 · 节点已离开文档: 其余两条都成立也不写', () => {
  const g = guard();
  const node = el('Hello world');
  const ticket = g.stamp(node);
  node.isConnected = false;
  assert.equal(ticket.sessionVersion, g.version(), '代次没变');
  assert.equal(g.accept(ticket), false);
});

test('校验二 · 代次已翻篇: 节点还在、文字没动也不写', () => {
  const g = guard();
  const node = el('Hello world');
  const ticket = g.stamp(node);
  g.bump('language-changed');
  assert.equal(node.isConnected, true);
  assert.equal(node.text, 'Hello world', '文字一个字没动');
  assert.equal(g.accept(ticket), false);
});

test('校验三 · 节点被回收装了别的内容: 代次没变、还连着也不写', () => {
  const g = guard();
  // 虚拟列表的日常：同一个 DOM 节点滚出去再滚回来，装的是另一条推文。
  const node = el('第一条推文');
  const ticket = g.stamp(node);
  node.text = '第八十条推文';
  assert.equal(ticket.sessionVersion, g.version());
  assert.equal(node.isConnected, true);
  assert.equal(g.accept(ticket), false);
});

test('文字改回来就还能写: 指纹认的是文本不是次数', () => {
  const g = guard();
  const node = el('Hello world');
  const ticket = g.stamp(node);
  node.text = '别的东西';
  assert.equal(g.accept(ticket), false);
  node.text = 'Hello world';
  assert.equal(g.accept(ticket), true);
});

test('指纹归一化跟着 BlockIdentity 走: 排版空白变了不算变', () => {
  const g = guard();
  const node = el('Hello   world');
  const ticket = g.stamp(node);
  // 页面重排后同一段文字的空白换了个样子。这不是内容变化，重翻一遍是白花钱。
  node.text = 'Hello world';
  assert.equal(g.accept(ticket), true);
});

test('代次从 1 起: 没盖章的请求不会被当成同代放行', () => {
  const g = guard();
  assert.equal(g.version(), 1);
  // 「字段没填」在 JS 里读出来是 undefined，落到整数上常被写成 0。
  // 代次若从 0 起，一张空票就恰好和当下同代。
  assert.equal(g.accept({ element: el('x'), sessionVersion: 0, textFingerprint: '' }), false);
  assert.equal(g.accept({ element: el('x'), textFingerprint: '' }), false);
});

test('bump 每次加一并把新代次交出来，理由进 debug 日志', (t) => {
  const g = guard();
  t.mock.method(console, 'debug', () => {});
  assert.equal(g.bump('route-change'), 2);
  assert.equal(g.bump('engine-changed'), 3);
  assert.equal(g.version(), 3);
  assert.equal(console.debug.mock.callCount(), 2);
  assert.equal(console.debug.mock.calls[0].arguments[2], 'route-change');
});

test('bump 之后新盖的章照常通过: 作废的是旧请求不是这一页', () => {
  const g = guard();
  const node = el('Hello world');
  const stale = g.stamp(node);
  g.bump('route-change');
  const fresh = g.stamp(node);
  assert.equal(g.accept(stale), false);
  assert.equal(g.accept(fresh), true);
});

test('blockId: 同一个元素同一个号，不同元素不同号', () => {
  const g = guard();
  const a = el('a');
  const b = el('b');
  assert.equal(g.blockId(a), g.blockId(a));
  assert.notEqual(g.blockId(a), g.blockId(b));
  assert.equal(g.stamp(a).blockId, g.blockId(a), '盖章用的是同一个号');
});

test('blockId 不往元素上挂属性: 页面框架会克隆、比较它自己的节点', () => {
  const g = guard();
  const node = el('a');
  g.blockId(node);
  assert.deepEqual(Object.keys(node), ['text', 'isConnected']);
});

test('两个 guard 互不相干: 一个作废不影响另一个', () => {
  const g1 = guard();
  const g2 = guard();
  const node = el('Hello world');
  const ticket2 = g2.stamp(node);
  g1.bump('unrelated');
  assert.equal(g2.accept(ticket2), true);
});

test('空票 / 没有元素: 返回 false 而不是抛', () => {
  const g = guard();
  assert.equal(g.accept(null), false);
  assert.equal(g.accept(undefined), false);
  assert.equal(g.accept({ sessionVersion: 1, textFingerprint: '' }), false);
});

test('manifest 里装了它 —— 一个没被加载的模块等于没写', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'manifest.json'), 'utf8'));
  const isolated = manifest.content_scripts.find((entry) => (entry.world || 'ISOLATED') === 'ISOLATED');
  const js = isolated.js;
  assert.ok(js.includes('shared/session-guard.js'));
  // 它靠 BlockIdentity 算指纹的调用方在后面，但模块自身不读全局 —— 依赖是注入的。
  // 仍然要求排在 block-identity 之后，免得将来有人顺手改成直接读全局。
  assert.ok(js.indexOf('shared/session-guard.js') > js.indexOf('shared/block-identity.js'));
});
