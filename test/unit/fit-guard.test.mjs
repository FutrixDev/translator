// Guards for content/content-fit-guard.js.
//
// The other half of "the page did not make room for the translation". The clip
// guard (clip-guard.test.mjs) covers the case where the translation is *hidden* —
// it lands outside an `overflow:hidden` box and the reader sees nothing. Here the
// box is just as unwilling to grow, but `overflow` is `visible`, so the
// translation is painted anyway, on top of whatever is next to it.
//
// Measured on poloclub's Transformer Explainer, a coordinate-driven
// visualisation where every token label lives in a cell whose height comes from
// the graph layout:
//
//   .cell             clientHeight 1.7px, holding a 12px absolutely positioned label
//   .textbook-tooltip clientHeight 5px,  scrollHeight 11px
//   .type-btn         clientHeight 17px, scrollHeight 41px once a translation is in
//
// 301 blocks, 22 newly introduced *visible* overlaps (baseline-controlled: the
// page's own overlaps measured before injection and subtracted). With the guard,
// 2.
//
// Exercised for real against a fake element tree rather than grepped for: what
// has to stay true is behavioural — a translation with nowhere to go is removed,
// one that fits is left alone, and a clipping ancestor is never second-guessed.
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// A fake DOM, deep enough for the guard's questions: where is this box, how tall
// is it, does it clip, and what is my translation's rect.
// ---------------------------------------------------------------------------

class FakeStyle {
  constructor() { this.props = new Map(); }
  getPropertyValue(name) { const e = this.props.get(name); return e ? e.value : ''; }
  getPropertyPriority(name) { const e = this.props.get(name); return e ? e.priority : ''; }
  setProperty(name, value, priority = '') { this.props.set(name, { value, priority }); }
  removeProperty(name) { this.props.delete(name); }
}

class FakeElement {
  constructor({ top = 0, height = 0, overflowY = 'visible', position = 'static' } = {}) {
    this.nodeType = 1;
    this.isConnected = true;
    this.parentElement = null;
    this.children = [];
    this.style = new FakeStyle();
    this.clientTop = 0;
    this.top = top;
    this.height = height;
    this.overflowY = overflowY;
    this.position = position;
  }

  append(child) { child.parentElement = this; this.children.push(child); return child; }

  remove() {
    if (!this.parentElement) return;
    const i = this.parentElement.children.indexOf(this);
    if (i !== -1) this.parentElement.children.splice(i, 1);
    this.parentElement = null;
    this.isConnected = false;
  }

  // 站点定死的高度，不随内容变 —— 这正是本文件要处理的那类框
  get clientHeight() { return this.height; }

  getBoundingClientRect() {
    return { top: this.top, bottom: this.top + this.height, height: this.height, width: 100 };
  }
}

globalThis.Node = { ELEMENT_NODE: 1 };
globalThis.window = {
  AI_TRANSLATOR_CONTENT: {},
  getComputedStyle: (el) => ({ overflowY: el.overflowY, position: el.position }),
};
globalThis.document = { body: new FakeElement(), documentElement: new FakeElement() };

await import('../../content/content-fit-guard.js');
const ctx = globalThis.window.AI_TRANSLATOR_CONTENT;
const { body } = globalThis.document;

/** The real shape: a graph cell whose height the layout fixed, translation spilling out. */
function explainerCell({ overflowY = 'visible' } = {}) {
  // 格子 100-102（高 2px），原文标签在里面，译文 100-125 —— 溢出 23px
  const cell = new FakeElement({ top: 100, height: 2, overflowY });
  const translation = new FakeElement({ top: 100, height: 25 });
  cell.append(translation);
  body.append(cell);
  return { cell, translation };
}

test('a translation that spills out of a fixed-height box is removed', () => {
  const { cell, translation } = explainerCell();
  assert.ok(translation.getBoundingClientRect().bottom > cell.getBoundingClientRect().bottom,
    'setup: the translation must start out spilling');

  assert.equal(ctx.keepTranslationInFlow(translation), false);
  assert.equal(translation.isConnected, false, 'the spilling translation was left in the page');
  assert.equal(cell.children.length, 0);
});

test('a translation the box made room for is left alone', () => {
  const box = new FakeElement({ top: 100, height: 60 });
  const translation = new FakeElement({ top: 120, height: 20 });
  box.append(translation);
  body.append(box);

  assert.equal(ctx.keepTranslationInFlow(translation), true);
  assert.equal(translation.isConnected, true);
});

test('a clipping ancestor is left to the clip guard, not second-guessed', () => {
  // 同样溢出，但框会裁剪 —— 溢出的那截根本不画出来，压不到谁。
  // 这里撤译文只会把 clip guard 已经处理好的情况弄砸。
  const { cell, translation } = explainerCell({ overflowY: 'hidden' });
  assert.equal(ctx.keepTranslationInFlow(translation), true);
  assert.equal(translation.isConnected, true);
  assert.equal(cell.children.length, 1);
});

test('a scrollable ancestor is left alone — the reader can scroll to it', () => {
  const { translation } = explainerCell({ overflowY: 'auto' });
  assert.equal(ctx.keepTranslationInFlow(translation), true);
  assert.equal(translation.isConnected, true);
});

test('a clipping box that still fits the translation gets no special treatment', () => {
  // transformer-explainer 的 span.label.float：39px 高、绝对定位、overflow:hidden，
  // 稳稳装下译文 —— 它裁不掉任何东西，谁也没保护，只是整个盖在隔壁的 2px 格子上。
  // 一见 hidden 就放行的话，这一类会全部漏过去。
  const cell = new FakeElement({ top: 100, height: 2 });
  const label = new FakeElement({ top: 100, height: 39, overflowY: 'hidden', position: 'absolute' });
  const translation = new FakeElement({ top: 110, height: 20 });
  label.append(translation);
  cell.append(label);
  body.append(cell);

  assert.equal(ctx.keepTranslationInFlow(translation), false,
    'the label swallowed the spill check even though it clips nothing');
  assert.equal(translation.isConnected, false);
});

test('an inline ancestor is skipped — it has no height box of its own', () => {
  // display:inline 的祖先 clientHeight 恒为 0，拿它去量只会得到假的溢出
  const outer = new FakeElement({ top: 100, height: 200 });
  const inline = new FakeElement({ top: 100, height: 0 });
  const translation = new FakeElement({ top: 120, height: 20 });
  inline.append(translation);
  outer.append(inline);
  body.append(outer);

  assert.equal(ctx.keepTranslationInFlow(translation), true);
  assert.equal(translation.isConnected, true);
});

test('a translation that inherited the page position:absolute is put back in flow', () => {
  // insertTranslationBlock 会复制原文块的 class，class 上挂着的可能正是页面自己的
  // position:absolute 和坐标 —— 译文于是一字不差地压在原文上
  const box = new FakeElement({ top: 100, height: 200 });
  const translation = new FakeElement({ top: 120, height: 20, position: 'absolute' });
  box.append(translation);
  body.append(box);

  ctx.keepTranslationInFlow(translation);

  assert.equal(translation.style.getPropertyValue('position'), 'static');
  assert.equal(translation.style.getPropertyPriority('position'), 'important',
    'page CSS would win without it');
});

test('a translation with no layout yet is kept — you cannot measure a spill from nothing', () => {
  const box = new FakeElement({ top: 100, height: 2 });
  const translation = new FakeElement({ top: 0, height: 0 });
  translation.getBoundingClientRect = () => ({ top: 0, bottom: 0, height: 0, width: 0 });
  box.append(translation);
  body.append(box);

  assert.equal(ctx.keepTranslationInFlow(translation), true);
  assert.equal(translation.isConnected, true);
});

test('a detached or non-element node is refused rather than measured', () => {
  assert.equal(ctx.keepTranslationInFlow(null), false);
  const orphan = new FakeElement({ top: 0, height: 10 });
  orphan.isConnected = false;
  assert.equal(ctx.keepTranslationInFlow(orphan), false);
});

test('removing a translation releases the clip guards taken for it', () => {
  // 撤译文之后，之前为它放开的祖先要还原，否则页面留着一个被撑开的框
  let released = 0;
  ctx.releaseTranslationClipGuards = () => { released += 1; };
  try {
    const { translation } = explainerCell();
    ctx.keepTranslationInFlow(translation);
    assert.equal(released, 1);
  } finally {
    delete ctx.releaseTranslationClipGuards;
  }
});
