// Focus-priority batching for page translation (design
// docs/design/ext-opt-page-translation.md §3, acceptance §6.1 batch A item 1).
//
// createBatchFeeder in content/page/batch.js decides, at every pull, which
// blocks go next: the ones nearest the viewport, towards the scroll direction,
// holding focus. This suite loads the real batch.js against a faked window
// whose scroll position and element geometry it controls, and pins:
//   - viewport blocks are pulled before anything off screen;
//   - a scroll between two pulls re-scores what is left;
//   - a focused block five screens away rides in the first batch;
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
function block(top, label = `b${seq++}`) {
  const classes = new Set();
  const element = {
    nodeType: 1,
    localName: 'p',
    childNodes: [],
    parentNode: {},
    getBoundingClientRect: () => (top === null
      ? { top: 0, bottom: 0, width: 0, height: 0 }
      : { top: top - window.scrollY, bottom: top + 40 - window.scrollY, width: 600, height: 40 }),
    classList: {
      contains: (c) => classes.has(c),
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
    },
  };
  return { text: `Paragraph ${label}.`, element, label };
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

test.beforeEach(() => {
  scrollTo(0);
  document.activeElement = null;
  window.innerHeight = H;
});

// ==================== the score (design §3.1) ====================

test('the score: one point per screen, towards the scroll is cheaper, focus -2, pointer -0.5, hidden +inf', () => {
  const b = block(0);
  const view = (over) => ({ scrollY: 0, height: H, scrollDir: 1, pointerDocY: null, focused: new Set(), ...over });
  // In the viewport: 0.
  assert.equal(ctx.scoreBlockForViewport(b, { hidden: false, top: 100, bottom: 140 }, view()), 0);
  // Two screens below while scrolling down: 2 * 0.8; scrolling up: 2 * 1.2.
  const below = { hidden: false, top: 3 * H, bottom: 3 * H + 40 };
  assert.equal(ctx.scoreBlockForViewport(b, below, view()), 2 * 0.8);
  assert.equal(ctx.scoreBlockForViewport(b, below, view({ scrollDir: -1 })), 2 * 1.2);
  // Focus anywhere inside the block takes 2 off.
  assert.equal(ctx.scoreBlockForViewport(b, below, view({ focused: new Set([b.element]) })), 2 * 0.8 - 2);
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

test('the AI engine fills one batch with the viewport and keeps the far tier for the next pull', () => {
  const seen = [0, 100, 200, 300, 400, 500].map((y, i) => block(y, `view${i}`));
  const far = [3200, 3300, 3400, 3500, 3600, 3700].map((y, i) => block(y, `far${i}`));
  const feeder = ctx.createBatchFeeder([...seen, ...far], false);
  assert.deepEqual(labels(feeder.next()), ['view0', 'view1', 'view2', 'view3', 'view4', 'view5']);
  assert.deepEqual(labels(feeder.next()), ['far0', 'far1', 'far2', 'far3', 'far4', 'far5']);
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

test('three screens of scroll moves the next AI batch to the six blocks that are now on screen', () => {
  const seen = [0, 100, 200, 300, 400, 500].map((y, i) => block(y, `view${i}`));
  const far = [3200, 3300, 3400, 3500, 3600, 3700].map((y, i) => block(y, `far${i}`));
  const mid = [2000, 2100].map((y, i) => block(y, `mid${i}`));
  const feeder = ctx.createBatchFeeder([...seen, ...mid, ...far], false);
  assert.deepEqual(labels(feeder.next()), ['view0', 'view1', 'view2', 'view3', 'view4', 'view5']);
  scrollTo(3200);
  assert.deepEqual(labels(feeder.next()), ['far0', 'far1', 'far2', 'far3', 'far4', 'far5']);
});

test('a focused block five screens away rides in the first batch', () => {
  // Scrolled one screen down from the top: viewport [800, 1600), heading down.
  scrollTo(H);
  const seen = [800, 900, 1000, 1100, 1200, 1300].map((y, i) => block(y, `view${i}`));
  const far = [4000, 4100, 4200].map((y, i) => block(y, `far${i}`)); // three screens below
  const focused = block(2 * H + 5 * H, 'focused'); // five screens below the viewport bottom
  // The focus sits on an input inside the block, as in J5.3.
  document.activeElement = { parentNode: focused.element };
  const feeder = ctx.createBatchFeeder([...seen, ...far, focused], false);
  const first = labels(feeder.next());
  assert.ok(first.includes('focused'), `the focused block is in the first batch: ${first}`);
  assert.ok(!first.some((label) => label.startsWith('far')), 'the far tier waits for its own batch');
  assert.deepEqual(first, ['view0', 'view1', 'view2', 'view3', 'view4', 'view5', 'focused'], 'the batch is in doc order');
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
