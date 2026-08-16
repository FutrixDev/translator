// Guards for content/content-clip-guard.js.
//
// A translation can be in the DOM, carry the right text, and still be invisible:
// it lands outside the visible box of an `overflow:hidden` ancestor. Measured on
// Higgsfield's project description, whose blurb sits in a collapsible
// `overflow:hidden; max-height:60px` wrapper:
//
//   before inserting   clientHeight 60, scrollHeight 60   (nothing clipped)
//   after inserting    clientHeight 60, scrollHeight 84   (translation at 532-552,
//                                                          wrapper ends at 530)
//
// This is a different failure from the managed-DOM one (see
// managed-dom-root.test.mjs) — there the node is deleted, here it survives and is
// merely clipped — so it needs a different test: geometry, not node identity.
//
// The module is exercised for real against a fake element tree rather than
// grepped for, because the thing that has to stay true is behavioural: a clipped
// translation gets revealed, an unclipped one is left alone, and everything the
// guard touches is put back exactly as it was.
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoFile = (rel) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');

// ---------------------------------------------------------------------------
// A fake DOM, just deep enough for the guard's three questions: does this
// ancestor clip, does the anchor stick out of it, and did relaxing help.
// ---------------------------------------------------------------------------

class FakeStyle {
  constructor() { this.props = new Map(); }
  getPropertyValue(name) { const e = this.props.get(name); return e ? e.value : ''; }
  getPropertyPriority(name) { const e = this.props.get(name); return e ? e.priority : ''; }
  setProperty(name, value, priority = '') { this.props.set(name, { value, priority }); }
  removeProperty(name) { this.props.delete(name); }
}

class FakeElement {
  constructor({ top = 0, height = 0, overflowY = 'visible', limit = Infinity, lineClamp = 'none' } = {}) {
    this.nodeType = 1;
    this.isConnected = true;
    this.parentElement = null;
    this.children = [];
    this.style = new FakeStyle();
    this.attributes = new Set();
    this.clientTop = 0;
    this.top = top;
    // 内容自然高度，以及站点给的高度上限（对应 max-height / height）
    this.contentHeight = height;
    this.limit = limit;
    this.overflowY = overflowY;
    this.webkitLineClamp = lineClamp;
  }

  append(child) { child.parentElement = this; this.children.push(child); return child; }

  // 上限被放开后（max-height:none / height:auto），可视高度回到内容高度
  get effectiveLimit() {
    const mh = this.style.getPropertyValue('max-height');
    const h = this.style.getPropertyValue('height');
    if (mh === 'none' || h === 'auto') return Infinity;
    return this.limit;
  }

  // 一个块的内容高度 = 自身高度和所有后代底边中的较大者
  get naturalHeight() {
    let bottom = this.top + this.contentHeight;
    const walk = (el) => {
      for (const c of el.children) {
        bottom = Math.max(bottom, c.top + c.contentHeight);
        walk(c);
      }
    };
    walk(this);
    return bottom - this.top;
  }

  get clientHeight() { return Math.min(this.naturalHeight, this.effectiveLimit); }

  getBoundingClientRect() {
    const height = this.clientHeight;
    return { top: this.top, bottom: this.top + height, height };
  }

  setAttribute(name) { this.attributes.add(name); }
  removeAttribute(name) { this.attributes.delete(name); }
  hasAttribute(name) { return this.attributes.has(name); }

  querySelector() { return this.translationInside ? {} : null; }
}

function loadGuard() {
  const body = new FakeElement();
  const html = new FakeElement();
  globalThis.Node = { ELEMENT_NODE: 1 };
  globalThis.window = {
    AI_TRANSLATOR_CONTENT: {},
    getComputedStyle: (el) => ({ overflowY: el.overflowY, webkitLineClamp: el.webkitLineClamp }),
  };
  globalThis.document = { body, documentElement: html };
  return { body, html };
}

const { body } = loadGuard();
await import('../../content/content-clip-guard.js');
const ctx = globalThis.window.AI_TRANSLATOR_CONTENT;

/** The real shape: a collapsed wrapper, the source text, the translation below it. */
function higgsfieldLayout() {
  // 折叠容器 470-530（限高 60），原文 470-530，译文 532-552 —— 掉在外面
  const wrapper = new FakeElement({ top: 470, height: 0, overflowY: 'hidden', limit: 60 });
  const source = new FakeElement({ top: 470, height: 60 });
  const translation = new FakeElement({ top: 532, height: 20 });
  wrapper.append(source);
  wrapper.append(translation);
  body.append(wrapper);
  wrapper.translationInside = true;
  return { wrapper, translation };
}

test('a translation clipped by a collapsed ancestor is revealed', () => {
  const { wrapper, translation } = higgsfieldLayout();
  assert.equal(wrapper.getBoundingClientRect().bottom, 530);
  assert.ok(translation.getBoundingClientRect().bottom > 530, 'setup: the translation must start out clipped');

  ctx.keepTranslationVisible(translation);

  assert.equal(wrapper.style.getPropertyValue('max-height'), 'none');
  assert.equal(wrapper.style.getPropertyPriority('max-height'), 'important', 'page CSS would win without it');
  assert.ok(
    translation.getBoundingClientRect().bottom <= wrapper.getBoundingClientRect().bottom,
    'the translation is still cut off'
  );
});

test('overflow is left alone — sites use it for rounded corners and masks', () => {
  const { wrapper, translation } = higgsfieldLayout();
  ctx.keepTranslationVisible(translation);
  assert.equal(wrapper.style.getPropertyValue('overflow'), '');
  assert.equal(wrapper.style.getPropertyValue('overflow-y'), '');
});

test('an ancestor that clips nothing of ours is not touched', () => {
  // 同样是 overflow:hidden 的容器，但译文在可视区内 —— 不该动它
  const wrapper = new FakeElement({ top: 0, height: 0, overflowY: 'hidden', limit: 400 });
  const translation = new FakeElement({ top: 100, height: 20 });
  wrapper.append(translation);
  body.append(wrapper);

  ctx.keepTranslationVisible(translation);

  assert.equal(wrapper.style.getPropertyValue('max-height'), '');
  assert.equal(wrapper.hasAttribute('data-ai-translator-unclipped'), false);
});

test('a scrollable ancestor is left alone — the reader can scroll to it', () => {
  const scroller = new FakeElement({ top: 0, height: 0, overflowY: 'auto', limit: 60 });
  const translation = new FakeElement({ top: 100, height: 20 });
  scroller.append(translation);
  body.append(scroller);

  ctx.keepTranslationVisible(translation);

  assert.equal(scroller.style.getPropertyValue('max-height'), '');
});

test('a hard height, not just max-height, is relaxed too', () => {
  // 放开 max-height 还不够的情形：高度是 height 写死的。
  // effectiveLimit 只认 height:auto，max-height:none 不解除限制。
  const wrapper = new FakeElement({ top: 0, height: 0, overflowY: 'hidden', limit: 60, lineClamp: '3' });
  Object.defineProperty(wrapper, 'effectiveLimit', {
    get() { return this.style.getPropertyValue('height') === 'auto' ? Infinity : this.limit; },
  });
  const translation = new FakeElement({ top: 62, height: 20 });
  wrapper.append(translation);
  body.append(wrapper);

  ctx.keepTranslationVisible(translation);

  assert.equal(wrapper.style.getPropertyValue('height'), 'auto');
  assert.equal(wrapper.style.getPropertyValue('-webkit-line-clamp'), 'none');
});

test('releasing restores the page exactly, priority included', () => {
  const { wrapper, translation } = higgsfieldLayout();
  // 站点自己写的内联样式，还原后必须一模一样
  wrapper.style.setProperty('max-height', '60px', '');
  wrapper.style.setProperty('height', '60px', 'important');

  ctx.keepTranslationVisible(translation);
  assert.equal(wrapper.style.getPropertyValue('max-height'), 'none');

  wrapper.translationInside = false; // 译文撤掉了
  ctx.releaseTranslationClipGuards();

  assert.equal(wrapper.style.getPropertyValue('max-height'), '60px');
  assert.equal(wrapper.style.getPropertyPriority('max-height'), '');
  assert.equal(wrapper.style.getPropertyValue('height'), '60px');
  assert.equal(wrapper.style.getPropertyPriority('height'), 'important');
  assert.equal(wrapper.hasAttribute('data-ai-translator-unclipped'), false);
});

test('a property the page never set inline is removed, not blanked', () => {
  const { wrapper, translation } = higgsfieldLayout();
  ctx.keepTranslationVisible(translation);
  wrapper.translationInside = false;
  ctx.releaseTranslationClipGuards();
  // 不能留下 max-height:"" 这种空声明——那和“没写过”在 CSSOM 里不是一回事
  assert.equal(wrapper.style.props.has('max-height'), false);
  assert.equal(wrapper.style.props.has('height'), false);
});

test('a container that still holds a translation stays relaxed', () => {
  const { wrapper, translation } = higgsfieldLayout();
  ctx.keepTranslationVisible(translation);
  ctx.releaseTranslationClipGuards(); // translationInside 仍为 true
  assert.equal(wrapper.style.getPropertyValue('max-height'), 'none');
});

test('a managed handle is measured as its source block, not as itself', () => {
  // 受管译文是原文块的一条 ::after，句柄只是挂在离屏 holder 里的替身。量句柄会走错
  // 整条祖先链：下面的 holder 才是它的父级，而那不是用户看不见译文的原因。
  const wrapper = new FakeElement({ top: 470, height: 0, overflowY: 'hidden', limit: 60 });
  const sourceBlock = new FakeElement({ top: 470, height: 84 }); // ::after 已经把它撑高
  wrapper.append(sourceBlock);
  body.append(wrapper);

  const holder = new FakeElement({ top: 0, height: 0, overflowY: 'hidden', limit: 0 });
  const handle = new FakeElement({ top: 0, height: 20 });
  holder.append(handle);
  body.append(holder);

  ctx.getManagedTranslationBlock = (el) => (el === handle ? sourceBlock : null);
  try {
    ctx.keepTranslationVisible(handle);
  } finally {
    delete ctx.getManagedTranslationBlock;
  }

  assert.equal(wrapper.style.getPropertyValue('max-height'), 'none', 'the real clipper was left collapsed');
  assert.equal(holder.style.getPropertyValue('max-height'), '', 'the offscreen holder was mistaken for the clipper');
});

// ---------------------------------------------------------------------------
// Wiring: the guard is worthless if a caller inserts without asking.
// ---------------------------------------------------------------------------

test('every insertion in the whole-page path asks the guards', () => {
  const source = repoFile('content/content-page-translation.js');
  const body = source.slice(source.indexOf('function insertTranslationBlock'));
  const end = body.indexOf('\n  function showPageTranslationProgress');
  const fn = body.slice(0, end);

  // 每一次把译文放进 DOM 之后，都要跟一次 finishTranslationInsert：
  // 「它看得见吗」（clip guard）+「页面给它地方站吗」（fit guard）。
  const insertions = fn.match(/\.(appendChild|after)\(\w+\)/g) || [];
  const guards = fn.match(/finishTranslationInsert\(/g) || [];
  assert.ok(insertions.length >= 4, `expected the insertion sites, found ${insertions.length}`);
  assert.equal(guards.length, insertions.length,
    'an insertion site was added without going through finishTranslationInsert');

  // 受管译文那条画成 ::after，没有节点可插，所以它自己单独问 clip guard
  assert.match(fn, /keepTranslationVisible\(element\)/,
    'the managed (::after) branch lost its visibility check');
});

test('the post-insert helper runs both guards, and in the order that matters', () => {
  const source = repoFile('content/content-page-translation.js');
  const body = source.slice(source.indexOf('function finishTranslationInsert'));
  const fn = body.slice(0, body.indexOf('\n  }') + 4);

  const clip = fn.indexOf('keepTranslationVisible(');
  const fit = fn.indexOf('keepTranslationInFlow(');
  const hide = fn.indexOf('hideSourceForTranslation(');
  assert.ok(clip !== -1, 'the clip guard is not called');
  assert.ok(fit !== -1, 'the fit guard is not called');
  assert.ok(hide !== -1, 'translation-only mode no longer hides the source');

  // clip guard 可能把某个祖先的 max-height 放开，框因此长高 —— fit guard 要量的是
  // 放开之后的样子，所以它必须在后面
  assert.ok(clip < fit, 'the fit guard must measure the box the clip guard just relaxed');
  // 顺序反了会出现最糟的结果：原文被藏起来，译文又被撤走，那一块彻底空白
  assert.ok(fit < hide, 'the source must not be hidden until the translation is known to survive');
});

test('the hover path asks the guard when it tracks a translation', () => {
  const source = repoFile('content/content-hover-translation.js');
  assert.match(source, /keepVisible\(translationEl\);/,
    'trackInlineTranslation is the single place hover/selection register a translation');
});

test('every disposal releases the guards it took', () => {
  const source = repoFile('content/content-hover-translation.js');
  const releases = source.match(/releaseClipGuards\(\)/g) || [];
  // 两处丢弃译文的地方（换块、移除），加上函数定义本身
  assert.equal(releases.length, 3, 'a disposal site drops a translation without releasing its guard');
});

test('the clip guard is the only place that forces a height open', () => {
  // 同 api-compat.js / account-gate.js：规则散出去就会各处漂移
  for (const file of [
    'content/content-hover-translation.js',
    'content/content-page-translation.js',
    'content/content-float-ball.js',
    'content/content-managed-translation.js',
  ]) {
    assert.doesNotMatch(repoFile(file), /setProperty\(\s*['"](max-height|-webkit-line-clamp)['"]/,
      `${file} relaxes a height constraint itself`);
  }
});

test('the guard module loads before the surfaces that call it', () => {
  const manifest = JSON.parse(repoFile('manifest.json'));
  const bundle = manifest.content_scripts.find((entry) => entry.js.includes('content/content-clip-guard.js'));
  assert.ok(bundle, 'content-clip-guard.js is not in any content script bundle');
  const at = (file) => bundle.js.indexOf(file);
  const guard = at('content/content-clip-guard.js');
  assert.ok(guard < at('content/content-hover-translation.js'));
  assert.ok(guard < at('content/content-page-translation.js'));
});
