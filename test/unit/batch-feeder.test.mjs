// Focus-priority batching for page translation.
//
// createBatchFeeder in content/page/focus-order.js decides, at every pull, which
// blocks go next: the ones nearest the viewport, towards the scroll direction,
// holding focus. This suite loads the real batch.js against a faked window
// whose scroll position and element geometry it controls, and pins:
//   - viewport blocks are pulled before anything off screen, and the far tier
//     (past NEAR_SCREENS) goes in document order;
//   - a scroll by the reader between two pulls re-measures and re-scores what
//     is left, so content shifted by earlier insertions is not read stale;
//   - the pass's own insertions (no reader scroll) re-measure nothing: the
//     viewport the pass started on keeps going first (J5.1);
//   - a scroll made by scroll anchoring is no reader scroll: it keeps the scroll
//     direction and only shifts the viewport into the measured coordinates;
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
globalThis.document = { activeElement: null, getSelection: () => null, documentElement: { scrollHeight: 10000 } };
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
for (const module of ['focus-order', 'batch', 'collect', 'insert', 'failed-blocks', 'visibility', 'progress']) {
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
// `moveTo(y)` shifts it, as an insertion above it would. Every rect read is
// counted in `rectReads`.
let rectReads = 0;
function block(top, label = `b${seq++}`) {
  const geo = { top };
  const classes = new Set();
  const element = {
    nodeType: 1,
    localName: 'p',
    childNodes: [],
    parentNode: {},
    getBoundingClientRect: () => {
      rectReads += 1;
      return geo.top === null
        ? { top: 0, bottom: 0, width: 0, height: 0 }
        : { top: geo.top - window.scrollY, bottom: geo.top + 40 - window.scrollY, width: 600, height: 40 };
    },
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

// The document grows by `dh` (an insertion) and the viewport moves to `y`.
function scrollTo(y, dh = 0) {
  document.documentElement.scrollHeight += dh;
  window.scrollY = y;
  for (const fn of listeners.get('scroll') || []) fn({});
}

const labels = (batch) => batch && batch.map((b) => b.label);

// The feeder a manual pass would build: the batch shape the engine table gives.
const newFeeder = (blocks) => ctx.focusOrder.createBatchFeeder(blocks, ctx.pagePass.batchShape(false));

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
  // Reset the height with no scroll first, so the reset is not read as anchoring.
  scrollTo(window.scrollY, 10000 - document.documentElement.scrollHeight);
  scrollTo(0);
  document.activeElement = null;
  document.getSelection = noSelection;
  window.innerHeight = H;
});

// ==================== the score ====================

// The score is not exported: it is pinned through the order the feeder pulls
// in. Viewport [800, 1600). A block g px below or above is g / 800 screens off;
// towards the scroll costs 0.8 a screen, against it 1.2, so a block below and
// one above tie when above = 2/3 below. Each pair sits just either side of
// that line (600 vs 390 / 410), so a weight off by a few percent flips one.
function firstOfPair(belowGap, aboveGap) {
  const above = block(H - aboveGap - 40, 'above');
  const below = block(2 * H + belowGap, 'below');
  return withEngine(true, () => labels(newFeeder([above, below]).next())[0]);
}

test('the score: towards the scroll costs 0.8 a screen, against it 1.2', () => {
  scrollTo(H); // heading down: below is towards
  assert.equal(firstOfPair(600, 390), 'above', 'below 0.75 * 0.8 = 0.6, above 0.4875 * 1.2 = 0.585');
  assert.equal(firstOfPair(600, 410), 'below', 'below 0.6, above 0.5125 * 1.2 = 0.615');
  scrollTo(2 * H);
  scrollTo(H); // heading up: above is towards
  assert.equal(firstOfPair(390, 600), 'below', 'above 0.75 * 0.8 = 0.6, below 0.4875 * 1.2 = 0.585');
  assert.equal(firstOfPair(410, 600), 'above', 'above 0.6, below 0.5125 * 1.2 = 0.615');
});

// ==================== the feeder ====================

test('viewport blocks are pulled before any block off screen, then the far tier in document order', () => {
  // Six blocks three screens above the viewport come first in the document;
  // six blocks in the viewport come after them. Document order would send the
  // far six first. Once the viewport is done the far six go top down, not
  // nearest first: scored, the far tier spreads out from the viewport both
  // ways, and that order costs Blink twice the paint per frame.
  const far = [0, 100, 200, 300, 400, 500].map((y, i) => block(y, `far${i}`));
  const seen = [2400, 2500, 2600, 2700, 2800, 2900].map((y, i) => block(y, `view${i}`));
  scrollTo(3 * H); // viewport [2400, 3200)
  withEngine(true, () => {
    const feeder = newFeeder([...far, ...seen]);
    assert.deepEqual(labels(feeder.next()), ['view0']);
    assert.deepEqual(labels(feeder.next()), ['view1']);
    const rest = [];
    for (let batch = feeder.next(); batch; batch = feeder.next()) rest.push(...labels(batch));
    assert.deepEqual(rest, ['view2', 'view3', 'view4', 'view5', 'far0', 'far1', 'far2', 'far3', 'far4', 'far5']);
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
  const feeder = newFeeder(tierPage());
  assert.deepEqual(labels(feeder.next()), ['nearAbove', 'view0', 'view1', 'view2'], 'the far block is skipped, not the end of the batch');
  assert.deepEqual(labels(feeder.next()), ['far']);
  assert.equal(feeder.next(), null);
});

test('a scroll between two pulls re-scores what is left: the next batch is the new viewport, not the next in doc order', () => {
  const top = [0, 100, 200].map((y, i) => block(y, `top${i}`));
  const middle = [2400, 2500, 2600].map((y, i) => block(y, `mid${i}`));
  const bottom = [4800, 4900, 5000].map((y, i) => block(y, `bot${i}`));
  withEngine(true, () => {
    const feeder = newFeeder([...top, ...middle, ...bottom]);
    assert.deepEqual(labels(feeder.next()), ['top0']);
    scrollTo(4800);
    assert.deepEqual(labels(feeder.next()), ['bot0']);
    assert.deepEqual(labels(feeder.next()), ['bot1']);
    assert.deepEqual(labels(feeder.next()), ['bot2']);
    // What is left is all in the far tier now: document order.
    assert.deepEqual(labels(feeder.next()), ['top1']);
  });
});

test('three screens of scroll moves the next AI batch to the blocks now on screen, with the near tier only', () => {
  const seen = [0, 100, 200, 300, 400, 500].map((y, i) => block(y, `view${i}`));
  const mid = [2000, 2100].map((y, i) => block(y, `mid${i}`));
  const nearAbove = block(2300, 'nearAbove');
  const far = [3200, 3300, 3400, 3500, 3600, 3700].map((y, i) => block(y, `far${i}`));
  const below = block(5000, 'below');
  const feeder = newFeeder([...seen, ...mid, nearAbove, ...far, below]);
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
  const first = labels(newFeeder(all).next());
  assert.ok(!first.some((label) => label.startsWith('far')), 'the far tier waits for its own batch');
  assert.deepEqual(first, ['view0', 'view1', 'view2', 'view3', 'view4', 'view5', 'focused'], 'the batch is in doc order');
  withEngine(true, () => {
    assert.deepEqual(labels(newFeeder(all).next()), ['focused']);
  });
});

test('focus inside a block wins its place even when the viewport alone fills an AI batch', () => {
  // More near blocks than MAX_BATCH_ITEMS: without the pin the focus block,
  // scored by its distance, would wait behind all of them.
  const { all, focused } = focusPage(ctx.pagePass.LIMITS.MAX_BATCH_ITEMS + 5);
  document.activeElement = input(2 * H + 5 * H + 5, focused.element);
  const first = labels(newFeeder(all).next());
  assert.equal(first.length, ctx.pagePass.LIMITS.MAX_BATCH_ITEMS);
  assert.ok(first.includes('focused'), `the focus block is in the first batch: ${first.slice(-3)}`);
});

test('a selection anchored inside a block makes it the focus block', () => {
  const { all, focused } = focusPage();
  document.getSelection = () => ({ anchorNode: { parentNode: focused.element } });
  withEngine(true, () => assert.deepEqual(labels(newFeeder(all).next()), ['focused']));
});

test('a focused input in no block pins the nearest block within half a screen of it, and none past that', () => {
  const { all, focused } = focusPage();
  const focusTop = 2 * H + 5 * H;
  // The input sits 100px under the focus block (and 300px above the next one).
  const next = block(focusTop + 480, 'next');
  document.activeElement = input(focusTop + 140);
  withEngine(true, () => assert.deepEqual(labels(newFeeder([...all, next]).next()), ['focused']));
  // Contenteditable counts as an input.
  document.activeElement = { ...input(focusTop + 140), tagName: 'DIV', isContentEditable: true };
  withEngine(true, () => assert.deepEqual(labels(newFeeder([...all, next]).next()), ['focused']));
  // More than half a screen from every block: nothing is pinned, the viewport goes first.
  document.activeElement = input(focusTop + 40 + H / 2 + 20);
  withEngine(true, () => assert.deepEqual(labels(newFeeder(all).next()), ['view0']));
  // A focused button is not an input: nothing is pinned.
  document.activeElement = { ...input(focusTop + 140), tagName: 'BUTTON' };
  withEngine(true, () => assert.deepEqual(labels(newFeeder([...all, next]).next()), ['view0']));
});

test('an insertion above the viewport shifts the viewport by the anchoring scroll and measures nothing again', () => {
  // Viewport [2000, 2800), heading down. Call #1 is the viewport block.
  const above = block(0, 'above');
  const view = block(2000, 'view');
  const a = block(2850, 'a');
  const b = block(3900, 'b');
  withEngine(true, () => {
    scrollTo(2000);
    const feeder = newFeeder([above, view, a, b]);
    assert.deepEqual(labels(feeder.next()), ['view']);
    // A translation 1000px tall lands under `above`: everything after it moves
    // down by 1000, the document grows by 1000 and scroll anchoring moves the
    // viewport with it.
    for (const moved of [view, a, b]) moved.moveTo(moved.element.getBoundingClientRect().top + window.scrollY + 1000);
    scrollTo(3000, 1000);
    const reads = rectReads;
    // Now `a` is just under the viewport (3850). Against the old geometry with
    // the viewport not shifted back, `a` (old 2850) would be above it and `b`
    // (old 3900) just under it.
    assert.deepEqual(labels(feeder.next()), ['a']);
    assert.equal(rectReads, reads, 'nothing is measured again');
  });
});

test('the pass\'s own insertions re-measure nothing: the viewport it started on goes first (J5.1)', () => {
  // Viewport [2000, 2800). A block sits 24px above it (0.03 screens against the
  // scroll: 0.036); six blocks are in it.
  const above = block(1936, 'above');
  const seen = [2000, 2100, 2200, 2300, 2400, 2500].map((y, i) => block(y, `view${i}`));
  scrollTo(2000);
  withEngine(true, () => {
    const feeder = newFeeder([above, ...seen]);
    assert.deepEqual(labels(feeder.next()), ['view0']);
    const reads = rectReads;
    // Translations land inside the viewport: every block after the first moves
    // down and out of it, the document grows, nothing scrolls. Measured again,
    // view2 (now 3000) would be 0.25 screens down (0.2) and `above` would go
    // before it.
    seen.slice(1).forEach((moved, i) => moved.moveTo(2100 + i * 100 + (i + 1) * 400));
    document.documentElement.scrollHeight += 2000;
    const rest = [];
    for (let batch = feeder.next(); batch; batch = feeder.next()) rest.push(...labels(batch));
    assert.deepEqual(rest, ['view1', 'view2', 'view3', 'view4', 'view5', 'above']);
    assert.equal(rectReads, reads, 'no block is measured again');
  });
});

test('a scroll by the reader after insertions re-measures: the jump finds the blocks where they are now (J5.2)', () => {
  const start = block(100, 'start');
  const x = block(4000, 'x');
  const y = block(6000, 'y');
  withEngine(true, () => {
    const feeder = newFeeder([start, x, y]);
    assert.deepEqual(labels(feeder.next()), ['start']);
    // Insertions under `start` push x and y down by 1000, with no scroll.
    x.moveTo(5000);
    y.moveTo(7000);
    document.documentElement.scrollHeight += 2000;
    const reads = rectReads;
    // The reader jumps to [5000, 5800). Read stale, x (old 4000) would be over a
    // screen above and y (old 6000) just under: y would go first.
    scrollTo(5000);
    assert.deepEqual(labels(feeder.next()), ['x']);
    assert.equal(rectReads, reads + 2, 'what is left is measured again');
  });
});

test('a scroll made by scroll anchoring keeps the scroll direction; a scroll by the reader sets it', () => {
  // Two near blocks half a screen either side of the viewport [3500, 4300):
  // heading up, the one above goes first (0.4 against 0.6), heading down the
  // one below.
  const pair = () => [block(3060, 'above'), block(4700, 'below')];
  withEngine(true, () => {
    scrollTo(4000);
    scrollTo(3000); // heading up
    // An insertion above the viewport: the document grows by 500 and anchoring
    // moves the viewport down by the same 500. Not the reader: still heading up.
    scrollTo(3500, 500);
    assert.deepEqual(labels(newFeeder(pair()).next()), ['above']);
    // The reader scrolls down past the growth: heading down.
    scrollTo(3000);
    scrollTo(3500, 200);
    assert.deepEqual(labels(newFeeder(pair()).next()), ['below']);
  });
});

test('equal scores keep document order and blocks with no layout box go last, even one holding the focus', () => {
  const hidden = [block(null, 'hidden0'), block(null, 'hidden1')];
  const seen = [block(100, 'view0'), block(100, 'view1'), block(100, 'view2')];
  // The focus sits in hidden0: no layout box is checked before the focus.
  document.activeElement = hidden[0].element;
  withEngine(true, () => {
    const feeder = newFeeder([hidden[0], seen[0], hidden[1], seen[1], seen[2]]);
    const order = [];
    for (let batch = feeder.next(); batch; batch = feeder.next()) order.push(...labels(batch));
    assert.deepEqual(order, ['view0', 'view1', 'view2', 'hidden0', 'hidden1']);
  });
});

test('the built-in engine pulls one block per batch, the AI engine up to MAX_BATCH_ITEMS', () => {
  const many = Array.from({ length: ctx.pagePass.LIMITS.MAX_BATCH_ITEMS + 5 }, (_, i) => block(i, `v${i}`));
  withEngine(true, () => {
    assert.equal(newFeeder(many).next().length, 1);
  });
  const feeder = newFeeder(many);
  assert.equal(feeder.next().length, ctx.pagePass.LIMITS.MAX_BATCH_ITEMS);
  assert.equal(feeder.next().length, 5);
});

test('the concurrency the pool and the auto round cap read is the engine table, unchanged', () => {
  assert.deepEqual({ ...ctx.pagePass.LIMITS.CONCURRENCY }, { builtin: 4, ai: 12, blab: 6 });
  withEngine(true, () => assert.equal(ctx.pagePass.concurrency(true), 4));
  assert.equal(ctx.pagePass.concurrency(true), 12);
});

// ==================== progress counts blocks ====================

test('runTranslationPass reports progress once per block, 1..N, even when the N blocks share one batch', async () => {
  const blocks = [0, 100, 200, 300, 400].map((y, i) => block(y, `p${i}`));
  ctx.requestTranslation = async (message) => ({ translations: message.texts.map((t) => `译:${t}`) });
  const calls = [];
  await ctx.runTranslationPass(blocks, { onProgress: (done, total, outcome) => calls.push([done, total, outcome]) });
  assert.deepEqual(calls, [1, 2, 3, 4, 5].map((n) => [n, 5, 'settled']));
});

test('progress for a batch is delivered once the whole batch is in: no progress write between two inserts', async () => {
  // The progress bar is DOM; written between two inserts it makes the next
  // block's fit measurement force a layout, once per block.
  const blocks = [0, 100, 200].map((y, i) => block(y, `q${i}`));
  ctx.requestTranslation = async (message) => ({ translations: message.texts.map((t) => `译:${t}`) });
  const events = [];
  await ctx.runTranslationPass(blocks, {
    onSettled: (b) => events.push(`settled ${b.label}`),
    onProgress: (done) => events.push(`progress ${done}`),
  });
  assert.deepEqual(events, ['settled q0', 'settled q1', 'settled q2', 'progress 1', 'progress 2', 'progress 3']);
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

test('a reader jump smaller than the growth since the last scroll is still the reader: the view is sampled at every delivery', async () => {
  // Built-in engine, four calls in flight. The viewport [0, 800) holds v0..v3;
  // w sits a screen under it (near), x three screens under (far).
  const seen = [100, 200, 300, 400].map((y, i) => block(y, `v${i}`));
  const w = block(1600, 'w');
  const x = block(2500, 'x');
  const asked = [];
  const pending = [];
  ctx.requestTranslation = (message) => new Promise((resolve) => {
    asked.push(message.texts.join(' '));
    pending.push(() => resolve({ translations: message.texts.map((t) => `译:${t}`) }));
  });
  ctx.builtinTranslator = { isActive: () => true };
  let jumped = false;
  try {
    const pass = ctx.runTranslationPass([...seen, w, x], {
      onProgress: () => {
        if (jumped) return;
        jumped = true;
        // Right after the first delivery, the reader jumps (an anchor link, find
        // in page) to x, now at [4500, 5300). 4500 is less than the 6000 the
        // page grew by with no scroll, same sign: sampled only at scroll events,
        // the jump would be read as anchoring and w (at its stale 1600) would go
        // next.
        queueMicrotask(() => scrollTo(4500));
      },
    });
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(asked, ['Paragraph v0.', 'Paragraph v1.', 'Paragraph v2.', 'Paragraph v3.']);
    // v0's translation lands under the viewport: the page grows by 6000, no scroll.
    w.moveTo(4000);
    x.moveTo(4500);
    document.documentElement.scrollHeight += 6000;
    pending[0]();
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(asked[4], 'Paragraph x.');
    for (const resolve of pending.slice(1)) resolve();
    for (let i = 0; i < 4; i += 1) {
      await new Promise((r) => setTimeout(r, 0));
      for (const resolve of pending.splice(0)) resolve();
    }
    await pass;
  } finally {
    delete ctx.builtinTranslator;
  }
});

// Last in the file: the pointer they leave behind would bend every later order.
// Over RESORT_ABOVE blocks the order is kept for RESORT_EVERY pulls, so between
// two re-sorts it goes stale: a reader scroll moves the near tier, and a block
// the order still files under the far tier, in document order, can be near now
// while blocks ahead of it in that order are not. Each pull judges the tier
// afresh, so the near batch skips the now-far blocks and goes on to it — a
// `break` there would end the batch at the first now-far block.
test('over 4000 blocks the order is stale between re-sorts: a near batch still picks up a block that became near since', () => {
  scrollTo(40000); // viewport [40000, 40800), heading down
  const filler = Array.from({ length: 4000 }, (_, i) => block(i * 5, `fill${i}`));
  const aboveNear = block(39100, 'aboveNear'); // 1.125 screens up: near, scores 1.35
  const seen = Array.from({ length: 40 }, (_, i) => block(40000 + i * 20, `view${i}`));
  const belowNear = block(41000, 'belowNear'); // 0.25 screens down: near, scores 0.2
  const fresh = [42500, 42600].map((y, i) => block(y, `fresh${i}`)); // 2.1 screens down: far
  const feeder = newFeeder([...filler, aboveNear, ...seen, belowNear, ...fresh]);
  assert.deepEqual(labels(feeder.next()), seen.map((b) => b.label), 'the viewport fills the first AI batch');
  // 4004 left: no re-sort on the next pull. The order reads belowNear,
  // aboveNear, the filler, fresh0, fresh1. Viewport [41500, 42300): aboveNear
  // and the filler are far now, belowNear is still near, fresh0/1 have become near.
  scrollTo(41500);
  assert.deepEqual(labels(feeder.next()), ['belowNear', 'fresh0', 'fresh1']);
});

test('the pointer takes 0.5 off a block within a screen of it', () => {
  scrollTo(4000); // viewport [4000, 4800), heading down
  // The pointer at the viewport's bottom edge (4790): within a screen of a
  // block 640px below the viewport (0.8 * 0.8 = 0.64, less 0.5 = 0.14), more
  // than a screen from any block above it.
  for (const fn of listeners.get('pointermove') || []) fn({ clientY: 790 });
  const pair = (aboveGap) => [block(4000 - aboveGap - 40, 'above'), block(4800 + 640, 'below')];
  withEngine(true, () => {
    // above 100px up: 0.125 * 1.2 = 0.15. Without the pointer below scores 0.64.
    assert.deepEqual(labels(newFeeder(pair(100)).next()), ['below']);
    // above 80px up: 0.12, under below's 0.14: the bonus is not more than ~0.52.
    assert.deepEqual(labels(newFeeder(pair(80)).next()), ['above']);
  });
});

test('the pointer is kept in viewport coordinates: after a scroll it points where it is now', () => {
  // The pointer rests 100px from the top of the viewport while the page is at
  // the top, then the page scrolls to 4000 under it: it now points at 4100.
  for (const fn of listeners.get('pointermove') || []) fn({ clientY: 100 });
  scrollTo(4000); // viewport [4000, 4800), heading down
  const below = block(5200, 'below'); // half a screen below: 0.4, the pointer 1100px off
  const above = block(3600, 'above'); // 0.45 screens above: 0.54, the pointer 500px off: 0.04
  withEngine(true, () => {
    assert.deepEqual(labels(newFeeder([above, below]).next()), ['above'],
      'read at its old document offset (100) the pointer is near neither, and `below` would go first');
  });
});

// ==================== the pull pool ====================
//
// drainFeeder (content/page/focus-order.js) is the one concurrency pool behind a
// page pass and the language pre-check. On the first error every slot stops
// pulling, the items already in hand finish, and that first error is what the
// pool throws.

const ticks = async (n) => {
  for (let i = 0; i < n; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

function listFeeder(items, pulled) {
  const rest = [...items];
  return { next: () => { const item = rest.shift(); if (item) pulled.push(item); return item || null; } };
}

test('the pool stops pulling on the first error, lets the items in hand finish, and throws that first error', async () => {
  const pulled = [];
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let finished = 0;
  const processor = async (item) => {
    if (item === 1) throw new Error('first failure');
    await held;
    finished += 1;
    if (item === 3) throw new Error('a later failure');
  };
  const run = ctx.focusOrder.drainFeeder(listFeeder([1, 2, 3, 4, 5, 6], pulled), processor, { concurrency: 3 });
  // Settled the moment the pool settles: what had finished by then is part of the answer.
  let finishedWhenSettled = null;
  const outcome = run.then(() => null, (error) => error).finally(() => { finishedWhenSettled = finished; });
  await ticks(5);
  assert.deepEqual(pulled, [1, 2, 3], 'item 1 failed: no slot pulls a fourth item');
  release();
  const error = await outcome;
  assert.ok(error instanceof Error, 'the pool rejects');
  assert.match(error.message, /first failure/, 'with the first error, not a later one');
  assert.equal(finishedWhenSettled, 2, 'only after the two items in hand finished');
  assert.deepEqual(pulled, [1, 2, 3], 'and nothing was pulled after they did');
});

test('a feeder that throws rejects the pool with its error', async () => {
  const feeder = { next: () => { throw new Error('feeder broke'); } };
  await assert.rejects(ctx.focusOrder.drainFeeder(feeder, async () => {}, { concurrency: 3 }), /feeder broke/);
});

test('with nothing failing or stopping it, the pool drains every item once', async () => {
  const pulled = [];
  const done = [];
  await ctx.focusOrder.drainFeeder(listFeeder([1, 2, 3, 4, 5, 6, 7], pulled), async (item) => {
    await ticks(1);
    done.push(item);
  }, { concurrency: 3 });
  assert.deepEqual(pulled, [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual([...done].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7]);
});
