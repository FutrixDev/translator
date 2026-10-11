// Focus-priority batching for page translation (design
// docs/design/ext-opt-page-translation.md §3, acceptance §6.1 batch A item 1).
//
// createBatchFeeder in content/page/batch.js decides, at every pull, which
// blocks go next: the ones nearest the viewport, towards the scroll direction,
// holding focus. This suite loads the real batch.js against a faked window
// whose scroll position and element geometry it controls, and pins:
//   - viewport blocks are pulled before anything off screen;
//   - a scroll between two pulls re-scores what is left, on geometry measured
//     after the scroll (content shifted by an insertion is not read stale);
//   - a block of the other tier is skipped, not the end of the batch;
//   - the focus block (focus or selection inside it, or the nearest block
//     beside a focused input) is pulled first wherever it is;
//   - ties keep document order and blocks with no layout box go last;
//   - runTranslationPass reports progress once per block, never per batch, so a
//     manual run wired to ctx.progressFeed settles exactly N of N.
//
// Run with: node --test test/unit/batch-feeder.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

// ==================== the faked browser ====================

const listeners = new Map();
globalThis.window = {
  AI_TRANSLATOR_CONTENT: {
    constants: { MATH_CONTAINER_SELECTOR: '.katex' },
    settings: { skipTargetLanguageText: false },
    state: {},
    t: (key) => key,
    escapeHtml: (s) => s,
    isExtensionContextAvailable: () => true,
    isExtensionContextInvalidated: () => false,
    getEffectiveTargetLang: () => 'zh-CN',
    getLangBase: (lang) => (lang || '').split('-')[0],
    getLanguageDetectionText: (text) => text || '',
  },
  scrollY: 0,
  innerHeight: 800,
  addEventListener: (type, fn) => {
    if (!listeners.has(type)) listeners.set(type, []);
    listeners.get(type).push(fn);
  },
};
globalThis.document = { activeElement: null, getSelection: () => null };
globalThis.chrome = {};
globalThis.Node = { ELEMENT_NODE: 1, TEXT_NODE: 3 };
console.warn = () => {};
console.error = () => {};

await import('../../shared/block-identity.js');
await import('../../shared/text-markers.js');
await import('../../shared/lang-tags.js');
await import('../../shared/site-rules-builtin.js');
await import('../../shared/storage-writer.js');
await import('../../shared/site-rules.js');
await import('../../content/page/custom-rule.js');
await import('../../content/page/shadow.js');
await import('../../content/page/notranslate.js');
await import('../../content/page/scope.js');
await import('../../content/page/reader-hidden.js');
await import('../../content/page/not-prose.js');
for (const module of ['batch', 'collect', 'insert', 'failed-blocks', 'visibility', 'progress']) {
  await import(`../../content/page/${module}.js`);
}
await import('../../content/frames/shelf.js');
await import('../../content/page/progress-feed.js');
const ctx = globalThis.window.AI_TRANSLATOR_CONTENT;

ctx.isInsideManagedDomRoot = () => true;
ctx.canRenderManagedTranslation = () => true;
ctx.renderManagedTranslation = () => {};

// ==================== helpers ====================

const H = 800;
let seq = 0;

// A block whose layout box sits at document offset `top` (40px tall). The rect
// is read through the live window.scrollY, as getBoundingClientRect would be.
// `top: null` is a block with no layout box (display:none).
// `moveTo(y)` shifts it, as an insertion above it would.
function block(top, label = `b${seq++}`) {
  const geo = { top };
  const classes = new Set();
  const element = {
    nodeType: 1,
    localName: 'p',
    childNodes: [],
    parentNode: {},
    getBoundingClientRect: () => (geo.top === null
      ? { top: 0, bottom: 0, width: 0, height: 0 }
      : { top: geo.top - window.scrollY, bottom: geo.top + 40 - window.scrollY, width: 600, height: 40 }),
    classList: {
      contains: (c) => classes.has(c),
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
    },
  };
  return { text: `Paragraph ${label}.`, element, label, moveTo: (y) => { geo.top = y; } };
}

// A focused text input at document offset `top`, inside `parent` (or nowhere).
function input(top, parent = null) {
  return {
    tagName: 'INPUT',
    parentNode: parent,
    getBoundingClientRect: () => ({ top: top - window.scrollY, bottom: top + 30 - window.scrollY, width: 200, height: 30 }),
  };
}

function scrollTo(y) {
  window.scrollY = y;
  for (const fn of listeners.get('scroll') || []) fn({});
}

const labels = (batch) => batch && batch.map((b) => b.label);

function withEngine(builtin, fn) {
  if (builtin) ctx.builtinTranslator = { isActive: () => true };
  try {
    return fn();
  } finally {
    delete ctx.builtinTranslator;
  }
}

const noSelection = () => null;

test.beforeEach(() => {
  scrollTo(0);
  document.activeElement = null;
  document.getSelection = noSelection;
  window.innerHeight = H;
});

// ==================== the score (design §3.1) ====================

test('the score: one point per screen, towards the scroll is cheaper, focus -inf, pointer -0.5, hidden +inf', () => {
  const b = block(0);
  const view = (over) => ({ scrollY: 0, height: H, scrollDir: 1, pointerDocY: null, focusBlock: null, ...over });
  // In the viewport: 0.
  assert.equal(ctx.scoreBlockForViewport(b, { hidden: false, top: 100, bottom: 140 }, view()), 0);
  // Two screens below while scrolling down: 2 * 0.8; scrolling up: 2 * 1.2.
  const below = { hidden: false, top: 3 * H, bottom: 3 * H + 40 };
  assert.equal(ctx.scoreBlockForViewport(b, below, view()), 2 * 0.8);
  assert.equal(ctx.scoreBlockForViewport(b, below, view({ scrollDir: -1 })), 2 * 1.2);
  // The focus block is pinned first, however far it is.
  assert.equal(ctx.scoreBlockForViewport(b, below, view({ focusBlock: b })), -Infinity);
  // The pointer within a screen of the block's top takes 0.5 off.
  assert.equal(ctx.scoreBlockForViewport(b, below, view({ pointerDocY: 3 * H + 10 })), 2 * 0.8 - 0.5);
  assert.equal(ctx.scoreBlockForViewport(b, { hidden: true, top: 0, bottom: 0 }, view()), Infinity);
});

// ==================== the feeder (design §3.2) ====================

test('viewport blocks are pulled before any block off screen, even when the page is scrolled past them in doc order', () => {
  // Six blocks three screens above the viewport come first in the document;
  // six blocks in the viewport come after them. Document order would send the
  // far six first.
  const far = [0, 100, 200, 300, 400, 500].map((y, i) => block(y, `far${i}`));
  const seen = [2400, 2500, 2600, 2700, 2800, 2900].map((y, i) => block(y, `view${i}`));
  scrollTo(3 * H); // viewport [2400, 3200)
  withEngine(true, () => {
    const feeder = ctx.createBatchFeeder([...far, ...seen], false);
    assert.deepEqual(labels(feeder.next()), ['view0']);
    assert.deepEqual(labels(feeder.next()), ['view1']);
    const rest = [];
    for (let batch = feeder.next(); batch; batch = feeder.next()) rest.push(...labels(batch));
    assert.deepEqual(rest, ['view2', 'view3', 'view4', 'view5', 'far5', 'far4', 'far3', 'far2', 'far1', 'far0']);
  });
});

// The tier layout: scrolled two screens down (heading down), viewport
// [1600, 2400). A near block sits just under a screen above it (0.95 screens,
// against the scroll: 1.14) and a far block 1.3 screens below (towards the
// scroll: 1.04). By score the far block comes between the viewport and the
// near one, so a feeder that ends the batch at the far block leaves the near
// one for later, and one with no tiers takes all of them at once.
function tierPage() {
  scrollTo(2 * H);
  const above = block(800, 'nearAbove');
  const seen = [1600, 1700, 1800].map((y, i) => block(y, `view${i}`));
  const far = block(3440, 'far');
  return [above, ...seen, far];
}

test('the AI engine fills one batch with the near tier, skipping a far block that scores between, and keeps the far tier for the next pull', () => {
  const feeder = ctx.createBatchFeeder(tierPage(), false);
  assert.deepEqual(labels(feeder.next()), ['nearAbove', 'view0', 'view1', 'view2'], 'the far block is skipped, not the end of the batch');
  assert.deepEqual(labels(feeder.next()), ['far']);
  assert.equal(feeder.next(), null);
});

test('a scroll between two pulls re-scores what is left: the next batch is the new viewport, not the next in doc order', () => {
  const top = [0, 100, 200].map((y, i) => block(y, `top${i}`));
  const middle = [2400, 2500, 2600].map((y, i) => block(y, `mid${i}`));
  const bottom = [4800, 4900, 5000].map((y, i) => block(y, `bot${i}`));
  withEngine(true, () => {
    const feeder = ctx.createBatchFeeder([...top, ...middle, ...bottom], false);
    assert.deepEqual(labels(feeder.next()), ['top0']);
    scrollTo(4800);
    assert.deepEqual(labels(feeder.next()), ['bot0']);
    assert.deepEqual(labels(feeder.next()), ['bot1']);
    assert.deepEqual(labels(feeder.next()), ['bot2']);
    // Scrolled down past the middle: it is above now, two screens up.
    assert.deepEqual(labels(feeder.next()), ['mid2']);
  });
});

test('three screens of scroll moves the next AI batch to the blocks now on screen, with the near tier only', () => {
  const seen = [0, 100, 200, 300, 400, 500].map((y, i) => block(y, `view${i}`));
  const mid = [2000, 2100].map((y, i) => block(y, `mid${i}`));
  const nearAbove = block(2300, 'nearAbove');
  const far = [3200, 3300, 3400, 3500, 3600, 3700].map((y, i) => block(y, `far${i}`));
  const below = block(5000, 'below');
  const feeder = ctx.createBatchFeeder([...seen, ...mid, nearAbove, ...far, below], false);
  assert.deepEqual(labels(feeder.next()), ['view0', 'view1', 'view2', 'view3', 'view4', 'view5']);
  // Viewport [3200, 4000), heading down. `below` is 1.25 screens down (1.0),
  // nearAbove 1.075 screens up (1.29): near, but it scores after `below`.
  scrollTo(3200);
  assert.deepEqual(labels(feeder.next()), ['nearAbove', 'far0', 'far1', 'far2', 'far3', 'far4', 'far5']);
  assert.deepEqual(labels(feeder.next()), ['mid0', 'mid1', 'below']);
});

// J5.3: scrolled one screen down (viewport [800, 1600), heading down), the
// focus block five screens below the viewport bottom, a far tier three screens
// below.
function focusPage(viewCount = 6) {
  scrollTo(H);
  const seen = Array.from({ length: viewCount }, (_, i) => block(800 + i * 10, `view${i}`));
  const far = [4000, 4100, 4200].map((y, i) => block(y, `far${i}`));
  const focused = block(2 * H + 5 * H, 'focused');
  return { seen, far, focused, all: [...seen, ...far, focused] };
}

test('focus inside a block five screens away: it rides in the first AI batch, and is the built-in call #1', () => {
  const { all, focused } = focusPage();
  // The focus sits on an input inside the block.
  document.activeElement = input(2 * H + 5 * H + 5, focused.element);
  const first = labels(ctx.createBatchFeeder(all, false).next());
  assert.ok(!first.some((label) => label.startsWith('far')), 'the far tier waits for its own batch');
  assert.deepEqual(first, ['view0', 'view1', 'view2', 'view3', 'view4', 'view5', 'focused'], 'the batch is in doc order');
  withEngine(true, () => {
    assert.deepEqual(labels(ctx.createBatchFeeder(all, false).next()), ['focused']);
  });
});

test('focus inside a block wins its place even when the viewport alone fills an AI batch', () => {
  // More near blocks than MAX_BATCH_ITEMS: without the pin the focus block,
  // scored by its distance, would wait behind all of them.
  const { all, focused } = focusPage(ctx.PAGE_LIMITS.MAX_BATCH_ITEMS + 5);
  document.activeElement = input(2 * H + 5 * H + 5, focused.element);
  const first = labels(ctx.createBatchFeeder(all, false).next());
  assert.equal(first.length, ctx.PAGE_LIMITS.MAX_BATCH_ITEMS);
  assert.ok(first.includes('focused'), `the focus block is in the first batch: ${first.slice(-3)}`);
});

test('a selection anchored inside a block makes it the focus block', () => {
  const { all, focused } = focusPage();
  document.getSelection = () => ({ anchorNode: { parentNode: focused.element } });
  withEngine(true, () => assert.deepEqual(labels(ctx.createBatchFeeder(all, false).next()), ['focused']));
});

test('a focused input in no block pins the nearest block within half a screen of it, and none past that', () => {
  const { all, focused } = focusPage();
  const focusTop = 2 * H + 5 * H;
  // The input sits 100px under the focus block (and 300px above the next one).
  const next = block(focusTop + 480, 'next');
  document.activeElement = input(focusTop + 140);
  withEngine(true, () => assert.deepEqual(labels(ctx.createBatchFeeder([...all, next], false).next()), ['focused']));
  // Contenteditable counts as an input.
  document.activeElement = { ...input(focusTop + 140), tagName: 'DIV', isContentEditable: true };
  withEngine(true, () => assert.deepEqual(labels(ctx.createBatchFeeder([...all, next], false).next()), ['focused']));
  // More than half a screen from every block: nothing is pinned, the viewport goes first.
  document.activeElement = input(focusTop + 40 + H / 2 + 20);
  withEngine(true, () => assert.deepEqual(labels(ctx.createBatchFeeder(all, false).next()), ['view0']));
  // A focused button is not an input: nothing is pinned.
  document.activeElement = { ...input(focusTop + 140), tagName: 'BUTTON' };
  withEngine(true, () => assert.deepEqual(labels(ctx.createBatchFeeder([...all, next], false).next()), ['view0']));
});

test('a scroll after an insertion re-measures: the next pull reads where the blocks are now, not where they were', () => {
  // Viewport [2000, 2800), heading down. Call #1 is the viewport block.
  const above = block(0, 'above');
  const view = block(2000, 'view');
  const a = block(2850, 'a');
  const b = block(3900, 'b');
  withEngine(true, () => {
    scrollTo(2000);
    const feeder = ctx.createBatchFeeder([above, view, a, b], false);
    assert.deepEqual(labels(feeder.next()), ['view']);
    // A translation 1000px tall lands under `above`: everything after it moves
    // down by 1000 and scroll anchoring moves the viewport with it.
    for (const moved of [view, a, b]) moved.moveTo(moved.element.getBoundingClientRect().top + window.scrollY + 1000);
    scrollTo(3000);
    // Now `a` is just under the viewport (3850). Read with the old geometry, `a`
    // would be above it (2850) and `b` (old 3900) just under it.
    assert.deepEqual(labels(feeder.next()), ['a']);
  });
});

test('equal scores keep document order and blocks with no layout box go last', () => {
  const hidden = [block(null, 'hidden0'), block(null, 'hidden1')];
  const seen = [block(100, 'view0'), block(100, 'view1'), block(100, 'view2')];
  withEngine(true, () => {
    const feeder = ctx.createBatchFeeder([hidden[0], seen[0], hidden[1], seen[1], seen[2]], false);
    const order = [];
    for (let batch = feeder.next(); batch; batch = feeder.next()) order.push(...labels(batch));
    assert.deepEqual(order, ['view0', 'view1', 'view2', 'hidden0', 'hidden1']);
  });
});

test('the built-in engine pulls one block per batch, the AI engine up to MAX_BATCH_ITEMS', () => {
  const many = Array.from({ length: ctx.PAGE_LIMITS.MAX_BATCH_ITEMS + 5 }, (_, i) => block(i, `v${i}`));
  withEngine(true, () => {
    assert.equal(ctx.createBatchFeeder(many, false).next().length, 1);
  });
  const feeder = ctx.createBatchFeeder(many, false);
  assert.equal(feeder.next().length, ctx.PAGE_LIMITS.MAX_BATCH_ITEMS);
  assert.equal(feeder.next().length, 5);
});

test('the concurrency the pool and the auto round cap read is the engine table, unchanged', () => {
  assert.deepEqual({ ...ctx.PAGE_LIMITS.CONCURRENCY }, { builtin: 4, ai: 12, blab: 6 });
  withEngine(true, () => assert.equal(ctx.passConcurrency(true), 4));
  assert.equal(ctx.passConcurrency(true), 12);
});

// ==================== progress counts blocks (design §2) ====================

test('runTranslationPass reports progress once per block, 1..N, even when the N blocks share one batch', async () => {
  const blocks = [0, 100, 200, 300, 400].map((y, i) => block(y, `p${i}`));
  ctx.requestTranslation = async (message) => ({ translations: message.texts.map((t) => `译:${t}`) });
  const calls = [];
  await ctx.runTranslationPass(blocks, { onProgress: (done, total, outcome) => calls.push([done, total, outcome]) });
  assert.deepEqual(calls, [1, 2, 3, 4, 5].map((n) => [n, 5, 'settled']));
});

test('a failed block counts once, as failed', async () => {
  const blocks = [0, 100].map((y, i) => block(y, `f${i}`));
  ctx.requestTranslation = async () => ({ error: 'apiErrorUnavailable' });
  const calls = [];
  await ctx.runTranslationPass(blocks, {
    auto: true,
    onProgress: (done, total, outcome) => calls.push([done, total, outcome]),
  });
  assert.deepEqual(calls, [[1, 2, 'failed'], [2, 2, 'failed']]);
});

test('a manual pass wired to ctx.progressFeed settles each block exactly once: N of N, never past known', async () => {
  const blocks = [0, 100, 200, 300, 400, 500].map((y, i) => block(y, `m${i}`));
  ctx.requestTranslation = async (message) => (message.texts.some((t) => t.includes('m5'))
    ? { error: 'apiErrorUnavailable' }
    : { translations: message.texts.map((t) => `译:${t}`) });
  const feed = ctx.progressFeed;
  feed.manual.begin(blocks.length);
  // Built-in engine: one block per batch, so exactly one block (m5) fails.
  ctx.builtinTranslator = { isActive: () => true };
  try {
    // The wiring the manual entry (content-page-translation.js) is to use: one feed call per onProgress.
    await ctx.runTranslationPass(blocks, {
      // The failure marker needs a real document; what is counted does not depend on it.
      markFailures: false,
      onProgress: (done, total, outcome) => (outcome === 'failed' ? feed.manual.fail() : feed.manual.settle()),
    });
  } finally {
    delete ctx.builtinTranslator;
  }
  feed.manual.end(feed.state().failed > 0 ? 'partial' : 'done');
  const s = feed.state();
  assert.deepEqual([s.source, s.phase, s.known, s.settled, s.failed, s.inflight], ['manual', 'partial', 6, 6, 1, 0]);
});
