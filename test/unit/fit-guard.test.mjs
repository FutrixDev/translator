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
// 301 blocks, 5 newly introduced *visible* overlaps (baseline-controlled: the
// page's own overlaps measured before injection and subtracted). With the guard,
// 0 — and 225 of the 301 translations survive, because a block that cannot hold
// two languages still holds one: the source yields and the translation stays.
// The full three-page comparison is in the guard's own header.
//
// Exercised for real against a fake element tree rather than grepped for: what
// has to stay true is behavioural — a translation with nowhere to go takes the
// source's place, one that fits is left alone, a clipping ancestor is never
// second-guessed, and a block never ends up with neither language in it.
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// A fake DOM, deep enough for the guard's questions: where is this box, how tall
// is it, does it clip, where is my paired source, and what is my rect.
// ---------------------------------------------------------------------------

class FakeStyle {
  constructor() { this.props = new Map(); }
  getPropertyValue(name) { const e = this.props.get(name); return e ? e.value : ''; }
  getPropertyPriority(name) { const e = this.props.get(name); return e ? e.priority : ''; }
  setProperty(name, value, priority = '') { this.props.set(name, { value, priority }); }
  removeProperty(name) { this.props.delete(name); }
}

class FakeClassList {
  constructor(...names) { this.names = new Set(names); }
  add(name) { this.names.add(name); }
  remove(name) { this.names.delete(name); }
  contains(name) { return this.names.has(name); }
}

class FakeElement {
  constructor({ top = 0, height = 0, width = 100, overflowY = 'visible', position = 'static',
    classes = [], text = '', scrollHeight = null } = {}) {
    this.nodeType = 1;
    this.isConnected = true;
    this.parentElement = null;
    this.children = [];
    this.style = new FakeStyle();
    this.classList = new FakeClassList(...classes);
    this.attributes = new Set();
    this.clientTop = 0;
    this.hidden = false;   // 让出原文 = display:none，矩形塌成 0
    this.top = top;
    this.height = height;
    this.width = width;
    this.overflowY = overflowY;
    this.position = position;
    this.textContent = text;
    this.ownScrollHeight = scrollHeight;
  }

  append(child) { child.parentElement = this; this.children.push(child); return child; }

  remove() {
    if (!this.parentElement) return;
    const i = this.parentElement.children.indexOf(this);
    if (i !== -1) this.parentElement.children.splice(i, 1);
    this.parentElement = null;
    this.isConnected = false;
  }

  get previousElementSibling() {
    if (!this.parentElement) return null;
    const i = this.parentElement.children.indexOf(this);
    return i > 0 ? this.parentElement.children[i - 1] : null;
  }

  // 守卫只用类名选择器问祖先，够用即可
  closest(selector) {
    const name = selector.replace(/^\./, '');
    for (let n = this; n; n = n.parentElement) if (n.classList.contains(name)) return n;
    return null;
  }

  contains(other) {
    for (let n = other; n; n = n.parentElement) if (n === this) return true;
    return false;
  }

  setAttribute(name) { this.attributes.add(name); }
  removeAttribute(name) { this.attributes.delete(name); }
  hasAttribute(name) { return this.attributes.has(name); }

  // 站点定死的高度，不随内容变 —— 这正是本文件要处理的那类框
  get clientHeight() { return this.hidden ? 0 : this.height; }
  get scrollHeight() { return this.ownScrollHeight === null ? this.clientHeight : this.ownScrollHeight; }

  getBoundingClientRect() {
    if (this.hidden) return { top: 0, bottom: 0, height: 0, width: 0 };
    return { top: this.top, bottom: this.top + this.height, height: this.height, width: this.width };
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

// content-page-translation.js 那半边的替身：藏原文 = display:none，它的矩形塌成 0，
// 后面的译文在正常流里往上补上那段高度 —— 守卫重量一次量的正是这个之后的样子。
// 每个测试自己装，用完拆掉；默认不装是为了让「原文让不出去」那条路也测得到。
function withSourceYielding(fn) {
  const yielded = [];
  ctx.hideCrowdedSource = (translationEl) => {
    const source = translationEl.previousElementSibling;
    if (!source || !source.classList.contains('ai-translator-translated')) return false;
    source.hidden = true;
    translationEl.top -= source.height;
    translationEl.setAttribute('data-ai-translator-crowded');
    yielded.push(source);
    return true;
  };
  ctx.releaseSourceForTranslation = (translationEl) => {
    translationEl.removeAttribute('data-ai-translator-crowded');
    const source = translationEl.previousElementSibling;
    if (source && source.hidden) {
      source.hidden = false;
      translationEl.top += source.height;
    }
  };
  try { return fn(yielded); } finally {
    delete ctx.hideCrowdedSource;
    delete ctx.releaseSourceForTranslation;
  }
}

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

// ---------------------------------------------------------------------------
// 装不下的时候：**先让原文，让不动才撤**。装不下两种语言不等于装不下一种。
// ---------------------------------------------------------------------------

/** 一对：原文块 + 紧跟其后的译文，同住一个高度写死的框。 */
function crowdedPair({ hostHeight = 30, sourceHeight = 20, translationHeight = 20 } = {}) {
  const host = new FakeElement({ top: 100, height: hostHeight });
  const source = new FakeElement({ top: 100, height: sourceHeight, classes: ['ai-translator-translated'], text: 'Temperature' });
  const translation = new FakeElement({ top: 100 + sourceHeight, height: translationHeight });
  host.append(source);
  host.append(translation);
  body.append(host);
  return { host, source, translation };
}

test('a block that cannot hold both languages keeps the translation and yields the source', () => {
  // 40px 的内容塞进 30px 的框：撤译文用户什么都没得到，让原文他读到的正是他要的那行
  withSourceYielding(() => {
    const { source, translation } = crowdedPair();
    assert.equal(ctx.keepTranslationInFlow(translation), true);
    assert.equal(translation.isConnected, true, 'the translation was dropped even though the source could yield');
    assert.equal(source.hidden, true, 'the source did not yield');
    assert.equal(translation.hasAttribute('data-ai-translator-crowded'), true,
      'without the marker a showTranslationOnly toggle would un-hide the source and re-garble the block');
  });
});

test('a source that yielded and still does not fit gets put back, and the translation goes', () => {
  // 让了也没用（框连译文一个人都装不下）：两个都藏着的话这一块彻底空白，
  // 比重叠糟得多
  withSourceYielding(() => {
    const { source, translation } = crowdedPair({ hostHeight: 10, sourceHeight: 20, translationHeight: 40 });
    assert.equal(ctx.keepTranslationInFlow(translation), false);
    assert.equal(translation.isConnected, false);
    assert.equal(source.hidden, false, 'the source stayed hidden with no translation to show for it');
    assert.equal(translation.hasAttribute('data-ai-translator-crowded'), false,
      'the crowded marker outlived the translation it was set for');
  });
});

test('the source is put back even when it was hidden by translation-only mode', () => {
  // 「仅显示译文」开着时原文在守卫跑之前就藏好了，这时守卫的 hideCrowdedSource 可能
  // 一开始就说不（比如原文是被 wrap 包起来的那种）。撤译文那条路照样要放原文。
  let releasedFor = null;
  ctx.hideCrowdedSource = () => false;
  ctx.releaseSourceForTranslation = (el) => { releasedFor = el; };
  try {
    const { translation } = explainerCell();
    assert.equal(ctx.keepTranslationInFlow(translation), false);
    assert.equal(releasedFor, translation, 'the block was left with neither language in it');
  } finally {
    delete ctx.hideCrowdedSource;
    delete ctx.releaseSourceForTranslation;
  }
});

test('a box that is fixed-height and bottom-anchored pushes the source out, not the translation', () => {
  // transformer-explainer 顶部的 .title：display:flex; justify-content:end，高 80px
  // 写死。插一行译文，译文稳稳待在框底，被顶出框顶的是原文，往上撞进上一行。
  // 只量译文自己的矩形，这一整类永远量不到。
  withSourceYielding(() => {
    const host = new FakeElement({ top: 100, height: 80 });
    const source = new FakeElement({ top: 72, height: 28, classes: ['ai-translator-translated'], text: 'Multi-head Self Attention' });
    const translation = new FakeElement({ top: 140, height: 28 });
    host.append(source);
    host.append(translation);
    body.append(host);

    assert.ok(translation.getBoundingClientRect().bottom <= host.getBoundingClientRect().bottom,
      'setup: the translation itself must sit comfortably inside the box');
    assert.equal(ctx.keepTranslationInFlow(translation), true);
    assert.equal(source.hidden, true, 'the source was pushed out of the top and nobody noticed');
  });
});

test('a source whose own box cannot hold its own text is treated as no box at all', () => {
  // 顶栏的 Temperature / Sampling / Probabilities：clientHeight 0，字画在盒子外面。
  // 盒子没有高度，挨着它摆的任何东西都落在同一个 y 上 —— 「温度perature」。
  // 宿主本身好好的，是原文块的几何在撒谎。
  withSourceYielding(() => {
    const host = new FakeElement({ top: 100, height: 400 });
    const source = new FakeElement({
      top: 100, height: 0, scrollHeight: 22,
      classes: ['ai-translator-translated'], text: 'Temperature',
    });
    const translation = new FakeElement({ top: 100, height: 22 });
    host.append(source);
    host.append(translation);
    body.append(host);

    assert.equal(ctx.keepTranslationInFlow(translation), true);
    assert.equal(source.hidden, true, 'the translation was laid on top of text painted outside its own box');
  });
});

test('a source that fits its own text is not mistaken for a lying box', () => {
  // 上一条的反面：正常段落 scrollHeight == clientHeight，别拿它当撒谎的盒子
  withSourceYielding(() => {
    const host = new FakeElement({ top: 100, height: 400 });
    const source = new FakeElement({ top: 100, height: 40, classes: ['ai-translator-translated'], text: 'A normal paragraph' });
    const translation = new FakeElement({ top: 140, height: 40 });
    host.append(source);
    host.append(translation);
    body.append(host);

    assert.equal(ctx.keepTranslationInFlow(translation), true);
    assert.equal(source.hidden, false, 'a plain paragraph had its source hidden');
  });
});

test('a source nested around the translation is measured by the pair, not twice', () => {
  // 水平 flex / 表格单元格 / slot：译文插在原文**里面**，原文的矩形已经含着它。
  // 拿它自己的 scrollHeight 去问「装不装得下自己的字」会把译文也算进去，永远为真。
  withSourceYielding(() => {
    const host = new FakeElement({ top: 100, height: 400 });
    const source = new FakeElement({
      top: 100, height: 20, scrollHeight: 40,
      classes: ['ai-translator-translated'], text: 'Cell',
    });
    const translation = new FakeElement({ top: 100, height: 20 });
    source.append(translation);
    host.append(source);
    body.append(host);

    assert.equal(ctx.keepTranslationInFlow(translation), true);
    assert.equal(source.hidden, false,
      'the containing source was hidden — which would take the translation inside it down too');
  });
});

// ---------------------------------------------------------------------------
// 横向：**这一块比页面原本给它的地方宽了**，而且它推不开邻居，只能盖上去。
// ---------------------------------------------------------------------------

/**
 * 收缩包裹的一列：英文在 112px 里排得下，中文一行排下来把整块撑到 147px。
 * @param {{position?: string, sourceWidthAfter?: number, translationWidth?: number}} opts
 *   position 是外层那一列的定位方式 —— 出了流才推不开邻居。
 */
function shrinkToFitColumn({ position = 'absolute', sourceWidthAfter = 147,
  translationWidth = 147 } = {}) {
  const column = new FakeElement({ top: 0, height: 200, position });
  const holder = new FakeElement({ top: 0, height: 60 });
  const source = new FakeElement({
    top: 0, height: 30, width: sourceWidthAfter,
    classes: ['ai-translator-translated'], text: '11 more identical Transformer Blocks',
  });
  const translation = new FakeElement({ top: 30, height: 30, width: translationWidth });
  holder.append(source);
  holder.append(translation);
  column.append(holder);
  body.append(column);
  return { column, holder, source, translation };
}

test('a block that outgrew its column is dropped when the column cannot push its neighbours', () => {
  // 112 → 147px，外面那一列是 absolute：长出来的 35px 推不开隔壁，直接盖上去
  const { translation } = shrinkToFitColumn();
  assert.equal(ctx.keepTranslationInFlow(translation, 112), false);
  assert.equal(translation.isConnected, false);
});

test('the same widening in normal flow is left alone — the neighbours just move over', () => {
  // 表格单元格、按钮、inline-block 变宽都是这一类：页面重排一遍就好了，不关我们的事
  const { translation } = shrinkToFitColumn({ position: 'static' });
  assert.equal(ctx.keepTranslationInFlow(translation, 112), true);
  assert.equal(translation.isConnected, true);
});

test('a translation that got wide on its own, without widening the block, is left alone', () => {
  // Anthropic 那两条「跳到主要内容」：译文继承了原文的 absolute，刚被按回 static，
  // 于是自己从 206px 摊成整行 1585px。可原文块一点没变宽 —— 框没变，谁也没挤到。
  // 判据量的是原文块，不是这一对的并集，就是为了不把这一类算进来。
  const { translation } = shrinkToFitColumn({ sourceWidthAfter: 206, translationWidth: 1585 });
  assert.equal(ctx.keepTranslationInFlow(translation, 206), true);
  assert.equal(translation.isConnected, true);
});

test('without a pre-insert width the horizontal rule stays out of it', () => {
  // 悬停/划词那条路不量宽度，也就没有「原本给了多少」这个参照 —— 没有参照就不判
  const { translation } = shrinkToFitColumn();
  assert.equal(ctx.keepTranslationInFlow(translation), true);
  assert.equal(translation.isConnected, true);
});

test('a block that outgrew its column is dropped outright, without asking the source to yield', () => {
  // 前三条让原文有用，是因为框里挤的是两个人；这里把框撑宽的正是译文自己，
  // 原文让开框还是那么宽 —— 白让一次，还得再撤一次。
  withSourceYielding((yielded) => {
    const { source, translation } = shrinkToFitColumn();
    assert.equal(ctx.keepTranslationInFlow(translation, 112), false);
    assert.deepEqual(yielded, [], 'the source was asked to yield for a widening it cannot fix');
    assert.equal(source.hidden, false);
  });
});
