// One progress source for page translation: ctx.progressFeed.
//
// Two halves:
//   - the feed itself (content/page/progress-feed.js) in a fresh vm per test:
//     known only grows, settled <= known, failed <= settled, a new session
//     starts from zero, a manual run outranks the scheduler, the fraction is
//     capped below 1 until the run is done, subscribers are coalesced per frame;
//   - the scheduler (content/content-auto-translate.js) reporting into the real
//     feed, with collection and translation stubbed: a round takes at most
//     roundCap() batches, known counts what was accepted into flight (never the
//     queue), the rest is re-queued for an immediate next round, and a new
//     session zeroes the snapshot.
//
// That a manual pass counts each block once is pinned beside runTranslationPass
// in test/unit/batch-feeder.test.mjs, which loads the real batch.js.
//
// Run with: node --test test/unit/progress-feed.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { SCHEDULER_PRELUDE, docOrderFeeder } from './helpers/scheduler-stubs.mjs';
import { repoSource } from './helpers/sources.mjs';

const tick = () => new Promise((resolve) => setImmediate(resolve));

// ==================== the feed on its own ====================

function loadFeed() {
  const frames = [];
  const warnings = [];
  const ctx = {};
  const sandbox = {
    console: { ...console, warn: (...args) => warnings.push(args) },
    requestAnimationFrame: (fn) => { frames.push(fn); return frames.length; },
    AI_TRANSLATOR_CONTENT: ctx,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(repoSource('content/page/progress-feed.js'), sandbox, { filename: 'progress-feed.js' });
  const flush = () => {
    while (frames.length > 0) frames.shift()();
  };
  return { feed: ctx.progressFeed, frames, flush, warnings };
}

const counts = (s) => ({
  source: s.source, phase: s.phase, known: s.known, settled: s.settled,
  failed: s.failed, pending: s.pending, inflight: s.inflight, session: s.session,
});

function autoSnap(changes) {
  return { phase: 'running', session: 1, known: 0, settled: 0, failed: 0, pending: 0, inflight: 0, ...changes };
}

test('a manual run reports source manual, counts each settle and fail, and ends with nothing in flight', () => {
  const { feed } = loadFeed();
  assert.deepEqual(counts(feed.state()), {
    source: 'none', phase: 'idle', known: 0, settled: 0, failed: 0, pending: 0, inflight: 0, session: 0,
  });
  feed.manual.begin(4);
  assert.deepEqual(counts(feed.state()), {
    source: 'manual', phase: 'arming', known: 4, settled: 0, failed: 0, pending: 0, inflight: 4, session: 0,
  });
  feed.manual.settle();
  feed.manual.fail();
  feed.manual.settle(1);
  assert.deepEqual(counts(feed.state()), {
    source: 'manual', phase: 'running', known: 4, settled: 3, failed: 1, pending: 0, inflight: 1, session: 0,
  });
  feed.manual.end('partial');
  assert.equal(feed.state().phase, 'partial');
  assert.equal(feed.state().inflight, 0);
  assert.equal(feed.state().source, 'manual');
  assert.ok(Object.isFrozen(feed.state()));
});

test('the manual counters refuse to run past known, and refuse to run outside a manual run', () => {
  const { feed } = loadFeed();
  assert.throws(() => feed.manual.settle(), /no manual run/);
  assert.throws(() => feed.manual.begin(-1), /begin: known must be a non-negative integer, got -1/);
  assert.throws(() => feed.manual.begin(1.5), /non-negative integer/);
  feed.manual.begin(2);
  feed.manual.settle(2);
  // Past known, the in-flight count would go negative: refused before settled can exceed known.
  assert.throws(() => feed.manual.settle(), /inflight must be a non-negative integer, got -1/);
  assert.equal(feed.state().settled, 2);
  assert.throws(() => feed.manual.settle(0), /positive integer/);
  assert.throws(() => feed.manual.end('finished'), /unknown outcome/);
  feed.manual.end('done');
  assert.throws(() => feed.manual.fail(), /no manual run/);
});

test('known only grows within a session: a smaller known, settled or failed throws', () => {
  const { feed } = loadFeed();
  feed.auto.publish(autoSnap({ known: 10, settled: 4, failed: 1, inflight: 6 }));
  assert.throws(() => feed.auto.publish(autoSnap({ known: 6, settled: 4, failed: 1 })), /known went down from 10 to 6/);
  assert.throws(() => feed.auto.publish(autoSnap({ known: 10, settled: 3, failed: 1 })), /settled went down/);
  assert.throws(() => feed.auto.publish(autoSnap({ known: 10, settled: 4, failed: 0 })), /failed went down/);
  // The rejected snapshots never reached the screen.
  assert.equal(feed.state().known, 10);
  assert.equal(feed.state().settled, 4);
});

test('settled never exceeds known and failed never exceeds settled', () => {
  const { feed } = loadFeed();
  assert.throws(() => feed.auto.publish(autoSnap({ known: 2, settled: 3 })), /settled 3 exceeds known 2/);
  assert.throws(() => feed.auto.publish(autoSnap({ known: 2, settled: 1, failed: 2 })), /failed 2 exceeds settled 1/);
  assert.throws(() => feed.auto.publish(autoSnap({ phase: 'finished' })), /unknown phase/);
  const { inflight, ...missing } = autoSnap({});
  assert.equal(inflight, 0);
  assert.throws(() => feed.auto.publish(missing), /missing inflight/);
});

test('a new session starts from zero: the monotonic check does not compare across sessions', () => {
  const { feed } = loadFeed();
  feed.auto.publish(autoSnap({ known: 10, settled: 10 }));
  feed.auto.publish(autoSnap({ session: 2, phase: 'idle' }));
  assert.deepEqual(counts(feed.state()), {
    source: 'auto', phase: 'idle', known: 0, settled: 0, failed: 0, pending: 0, inflight: 0, session: 2,
  });
});

test('while a manual run is in progress the scheduler is validated but not shown, and manual inherits its session', () => {
  const { feed } = loadFeed();
  feed.auto.publish(autoSnap({ session: 3, known: 2, pending: 1, inflight: 2 }));
  feed.manual.begin(5);
  assert.equal(feed.state().session, 3, 'manual takes the scheduler session it interrupts');
  feed.auto.publish(autoSnap({ session: 3, known: 4, settled: 2, inflight: 2 }));
  assert.equal(feed.state().source, 'manual');
  assert.equal(feed.state().known, 5);
  // Still validated against the scheduler's own last report.
  assert.throws(() => feed.auto.publish(autoSnap({ session: 3, known: 3 })), /known went down/);
  feed.manual.settle(5);
  feed.manual.end('done');
  assert.equal(feed.state().source, 'manual', 'the manual end state stays until the scheduler reports again');
  feed.auto.publish(autoSnap({ session: 3, known: 4, settled: 4, phase: 'done' }));
  assert.equal(feed.state().source, 'auto');
});

test('the fraction is capped at 0.99 while anything is pending or in flight; only done draws a full ring', () => {
  const { feed } = loadFeed();
  const f = (changes) => feed.fraction({ ...autoSnap(changes) });
  assert.equal(f({ known: 0 }), 0);
  assert.equal(f({ known: 100, settled: 50, inflight: 50 }), 0.5);
  assert.equal(f({ known: 100, settled: 100, pending: 3 }), 0.99);
  assert.equal(f({ known: 100, settled: 100, inflight: 1 }), 0.99);
  assert.equal(f({ known: 4, settled: 4, failed: 1, phase: 'partial' }), 1);
  assert.equal(f({ known: 4, settled: 2, phase: 'done' }), 1);
  assert.equal(feed.RUNNING_CAP, 0.99);
});

test('subscribers are coalesced to one call per frame, can unsubscribe, and one that throws does not stop the others', () => {
  const { feed, frames, flush, warnings } = loadFeed();
  assert.throws(() => feed.subscribe('nope'), { name: 'TypeError' });
  const seen = [];
  feed.subscribe(() => { throw new Error('ring broke'); });
  const off = feed.subscribe((s) => seen.push(s.settled));
  feed.manual.begin(3);
  feed.manual.settle();
  feed.manual.settle();
  assert.equal(frames.length, 1, 'three changes, one frame');
  flush();
  assert.deepEqual(seen, [2], 'the subscriber sees the latest snapshot only');
  assert.equal(warnings.length, 1, 'the throwing subscriber was logged');
  off();
  feed.manual.settle();
  flush();
  assert.deepEqual(seen, [2]);
});

// ==================== the scheduler reporting into it ====================

function element(name) {
  return { name, text: `${name} text long enough to translate`, isConnected: true };
}

// `engine` is what effectiveEngine answers (a function: asked at each round's cost
// check); `overBudget` is AutoStats.budgetExceeded (asked only when the engine is 'ai').
function loadScheduler({ engine = () => 'builtin', overBudget = () => false } = {}) {
  const timers = new Map();
  let timerId = 0;
  const passes = [];
  const frames = [];
  const ctx = {
    // One block per batch, two concurrency slots: roundCap() = 2 x 2 = 4 batches.
    ...docOrderFeeder({ perBatch: 1, concurrency: 2 }),
    frameRole: 'top',
    state: { isTranslatingPage: false, translationsVisible: true },
    settings: { autoTranslate: true, siteRules: {}, autoAiDailyBudget: 0 },
    t: (key) => key,
    customRules: { isCatchingUp: () => false, onChange() {} },
    aiProfiles: { subscribe: () => () => {} },
    failedBlocks: { isMarked: () => false, mark() {} },
    onLanguagePackReady() {},
    readSourceText: (el) => el.text,
    builtinTranslator: { effectiveEngine: async () => engine() },
    filterBlocksByLanguage: async (blocks) => blocks,
    runTranslationPass: (blocks, options) => new Promise((resolve) => {
      passes.push({ blocks: [...blocks], options, resolve });
    }),
  };
  const sandbox = {
    console,
    queueMicrotask,
    URL,
    location: { href: 'https://example.com/a', hostname: 'example.com', pathname: '/a' },
    addEventListener() {},
    removeEventListener() {},
    document: { body: {}, visibilityState: 'visible', addEventListener() {}, removeEventListener() {} },
    setInterval: () => 0,
    clearInterval() {},
    setTimeout: (fn, ms) => { timerId += 1; timers.set(timerId, { fn, ms }); return timerId; },
    clearTimeout: (id) => { timers.delete(id); },
    requestAnimationFrame: (fn) => { frames.push(fn); return frames.length; },
    SiteRules: { decide: () => ({ verdict: 'auto', reason: 'BUILTIN_ALWAYS', refused: false }) },
    AutoStats: { add() {}, read: async () => ({}), budgetExceeded: () => overBudget() },
    AI_TRANSLATOR_CONTENT: ctx,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const rel of ['shared/spa-navigation.js', 'shared/block-identity.js', 'shared/session-guard.js',
    ...SCHEDULER_PRELUDE, 'content/content-auto-translate.js']) {
    vm.runInContext(repoSource(rel), sandbox, { filename: rel });
  }
  let onCandidates = null;
  ctx.setupAutoDiscovery = (options) => {
    onCandidates = options.onCandidates;
    return { rescan() {}, stop() {}, suspend() {}, resume() {} };
  };
  ctx.watchAddedElements = () => () => {};
  const auto = ctx.setupAutoTranslate();
  const feed = ctx.progressFeed;
  // Every snapshot the feed showed, in order, so a test can check known never fell.
  // Taken at every publish (the scheduler reads ctx.progressFeed at call time), not
  // only between test steps: a snapshot that lives for one statement counts too.
  const history = [feed.state()];
  const note = () => {
    if (history[history.length - 1] !== feed.state()) history.push(feed.state());
  };
  ctx.progressFeed = { ...feed, auto: { publish(partial) { feed.auto.publish(partial); note(); } } };
  const offer = (...els) => {
    onCandidates(els.map((el) => ({ element: el, text: el.text })));
    note();
  };
  const pendingTimers = () => [...timers.values()].map((t) => t.ms);
  // Fire the earliest pending timer and let the pump run through its awaits.
  const fire = async () => {
    const [id, { fn }] = timers.entries().next().value;
    timers.delete(id);
    fn();
    for (let i = 0; i < 5; i += 1) await tick();
    note();
  };
  // End the latest pass: `ok` blocks are settled, every other block fails.
  const settle = async (ok = () => true) => {
    const pass = passes[passes.length - 1];
    for (const block of pass.blocks) {
      if (ok(block.element)) pass.options.onSettled(block);
    }
    pass.resolve(null);
    for (let i = 0; i < 5; i += 1) await tick();
    note();
  };
  // End the latest pass the way runTranslationPass reports a failed round:
  // nothing settled, a failure with a message.
  const breakPass = async (message) => {
    passes[passes.length - 1].resolve({ message });
    for (let i = 0; i < 5; i += 1) await tick();
    note();
  };
  return { auto, feed, passes, history, offer, fire, settle, breakPass, pendingTimers };
}

const ledger = (s) => [s.phase, s.known, s.settled, s.failed, s.pending, s.inflight];

test('a round takes at most roundCap() batches; known counts what was accepted, the rest waits in pending', async () => {
  const s = loadScheduler();
  const els = Array.from({ length: 10 }, (_, i) => element(`p${i}`));
  s.offer(...els);
  assert.equal(s.feed.state().source, 'auto');
  assert.deepEqual(ledger(s.feed.state()), ['arming', 0, 0, 0, 10, 0], 'queued, nothing accepted yet');

  await s.fire();
  assert.equal(s.passes.length, 1);
  assert.deepEqual(s.passes[0].blocks.map((b) => b.element.name), ['p0', 'p1', 'p2', 'p3'],
    'roundCap() = pagePass.concurrency x 2 = 4 one-block batches');
  assert.deepEqual(ledger(s.feed.state()), ['running', 4, 0, 0, 6, 4]);
  assert.ok(s.feed.fraction(s.feed.state()) < 1);

  await s.settle();
  assert.deepEqual(ledger(s.feed.state()), ['running', 4, 4, 0, 6, 0], 'six still queued: not done');
  assert.deepEqual(s.pendingTimers(), [0], 'the leftovers start the next round at once, no debounce');

  await s.fire();
  assert.deepEqual(s.passes[1].blocks.map((b) => b.element.name), ['p4', 'p5', 'p6', 'p7']);
  assert.deepEqual(ledger(s.feed.state()), ['running', 8, 4, 0, 2, 4]);
  await s.settle();
  await s.fire();
  assert.deepEqual(s.passes[2].blocks.map((b) => b.element.name), ['p8', 'p9']);
  await s.settle();

  assert.deepEqual(ledger(s.feed.state()), ['done', 10, 10, 0, 0, 0]);
  assert.equal(s.feed.fraction(s.feed.state()), 1);
  assert.deepEqual(s.pendingTimers(), []);
  for (let i = 1; i < s.history.length; i += 1) {
    assert.ok(s.history[i].known >= s.history[i - 1].known, `known fell at snapshot ${i}`);
    assert.ok(s.history[i].settled <= s.history[i].known);
  }
});

test('a block that fails twice is counted once in known and lands as failed: phase partial', async () => {
  const s = loadScheduler();
  const a = element('a');
  const b = element('b');
  s.offer(a, b);
  await s.fire();
  await s.settle((el) => el === a);
  assert.deepEqual(ledger(s.feed.state()), ['running', 2, 1, 0, 1, 0], 'b failed once: back in the queue');
  await s.fire();
  assert.deepEqual(ledger(s.feed.state()), ['running', 2, 1, 0, 0, 1], 'the retry is not a new block');
  await s.settle(() => false);
  assert.deepEqual(ledger(s.feed.state()), ['partial', 2, 2, 1, 0, 0]);
  assert.equal(s.feed.fraction(s.feed.state()), 1);
});

test('two blocks that both fail twice, with nothing settled: failed never runs ahead of settled', async () => {
  // The all-fail case: the second round gives up on both blocks
  // at once. The ledger has to take each one before failed counts it — with
  // failed bumped first, failed is 2 while settled is still 0, and the feed
  // refuses the snapshot.
  const s = loadScheduler();
  const a = element('a');
  const b = element('b');
  s.offer(a, b);
  await s.fire();
  await s.settle(() => false);
  assert.deepEqual(ledger(s.feed.state()), ['running', 2, 0, 0, 2, 0], 'both failed once: back in the queue');
  await s.fire();
  await s.settle(() => false);
  assert.deepEqual(ledger(s.feed.state()), ['partial', 2, 2, 2, 0, 0]);
  assert.equal(s.feed.fraction(s.feed.state()), 1);
  // Nothing was ever translated, so every settled block is a failed one, in every
  // snapshot: published between the ledger and the failed count, a snapshot
  // would show a given-up block as translated (failed 0, settled 1).
  for (const snap of s.history) assert.equal(snap.failed, snap.settled, `failed ${snap.failed} != settled ${snap.settled}`);
});

test('a round that stops on an error leaves nothing pending or in flight on the feed', async () => {
  const s = loadScheduler();
  s.offer(...Array.from({ length: 6 }, (_, i) => element(`p${i}`)));
  await s.fire();
  assert.deepEqual(ledger(s.feed.state()), ['running', 4, 0, 0, 2, 4]);
  await s.breakPass('HTTP 500 from the endpoint');
  const snap = s.feed.state();
  assert.equal(s.auto.state().status, 'error');
  assert.deepEqual(ledger(snap), ['error', 4, 0, 0, 0, 0], 'the queue is still there, but nothing will send it');
  assert.equal(s.pendingTimers().length, 0, 'and indeed no round is scheduled');
});

test('a round refused by the AI budget leaves nothing pending or in flight on the feed', async () => {
  let spent = false;
  const s = loadScheduler({ engine: () => 'ai', overBudget: () => spent });
  s.offer(...Array.from({ length: 6 }, (_, i) => element(`p${i}`)));
  await s.fire();
  await s.settle();
  assert.deepEqual(ledger(s.feed.state()), ['running', 4, 4, 0, 2, 0]);
  spent = true;
  await s.fire();
  assert.equal(s.passes.length, 1, 'the budget stopped the next round before it took a block');
  assert.deepEqual(ledger(s.feed.state()), ['budget', 4, 4, 0, 0, 0]);
});

test('a round refused because no engine is usable leaves nothing pending or in flight on the feed', async () => {
  // COST_ENGINE: the same stop as the budget, under another reason.
  let engine = 'builtin';
  const s = loadScheduler({ engine: () => engine });
  s.offer(...Array.from({ length: 6 }, (_, i) => element(`p${i}`)));
  await s.fire();
  await s.settle();
  assert.deepEqual(ledger(s.feed.state()), ['running', 4, 4, 0, 2, 0]);
  engine = 'none';
  await s.fire();
  assert.equal(s.passes.length, 1, 'no engine: the next round never took a block');
  assert.equal(s.auto.state().status, 'off');
  assert.deepEqual(ledger(s.feed.state()), ['idle', 4, 4, 0, 0, 0]);
});

// A block that was accepted and can no longer reach a result.
test('a block disconnected while in flight is settled, not left owing the ring a block', async () => {
  const s = loadScheduler();
  const a = element('a');
  const b = element('b');
  s.offer(a, b);
  await s.fire();
  assert.deepEqual(ledger(s.feed.state()), ['running', 2, 0, 0, 0, 2]);
  a.isConnected = false;
  // The pass never settles a detached block; b comes back.
  await s.settle((el) => el === b);
  assert.deepEqual(ledger(s.feed.state()), ['done', 2, 2, 0, 0, 0]);
  assert.equal(s.feed.fraction(s.feed.state()), 1);
  assert.deepEqual(s.pendingTimers(), [], 'nothing re-queued the detached block');
});

test('a block that failed once and is then disconnected in the queue is settled too', async () => {
  const s = loadScheduler();
  const a = element('a');
  const b = element('b');
  s.offer(a, b);
  await s.fire();
  await s.settle((el) => el === a);
  assert.deepEqual(ledger(s.feed.state()), ['running', 2, 1, 0, 1, 0], 'b failed once: back in the queue');
  b.isConnected = false;
  await s.fire();
  assert.equal(s.passes.length, 1, 'the detached block was not sent again');
  assert.deepEqual(ledger(s.feed.state()), ['done', 2, 2, 0, 0, 0]);
});

test('a disconnected block reconnected with the same text is accepted again without settling twice', async () => {
  const s = loadScheduler();
  const a = element('a');
  const b = element('b');
  s.offer(a, b);
  await s.fire();
  a.isConnected = false;
  await s.settle((el) => el === b);
  assert.deepEqual(ledger(s.feed.state()), ['done', 2, 2, 0, 0, 0]);
  // Same node, same text: same key. Accepting it again takes it off the retired
  // list; what was reported settled cannot be taken back (the feed refuses a
  // falling settled), so it comes back as one more block owed — once.
  a.isConnected = true;
  s.offer(a);
  await s.fire();
  assert.deepEqual(s.passes[1].blocks.map((block) => block.element.name), ['a']);
  assert.deepEqual(ledger(s.feed.state()), ['running', 3, 2, 0, 0, 1]);
  await s.settle();
  assert.deepEqual(ledger(s.feed.state()), ['done', 3, 3, 0, 0, 0]);
  assert.equal(s.feed.fraction(s.feed.state()), 1);
  for (const snap of s.history) assert.ok(snap.settled <= snap.known, `settled ${snap.settled} > known ${snap.known}`);
});

// A node the discovery layer hands back with new text replaces its
// queued copy. The old copy's key was accepted once (it failed a round and was put
// back) and can no longer reach a result, so it is retired; without that, known
// stays one ahead of settled and the ring never closes.
test('a block that failed once and changed its text in the queue does not leave its old key owing the ring', async () => {
  const s = loadScheduler();
  const a = element('a');
  const b = element('b');
  const c = element('c');
  s.offer(a, b, c);
  await s.fire();
  await s.settle((el) => el === a);
  assert.deepEqual(ledger(s.feed.state()), ['running', 3, 1, 0, 2, 0], 'b and c failed once: back in the queue');
  b.text = 'b text rewritten by the page while it waited';
  s.offer(b);
  assert.deepEqual(ledger(s.feed.state()), ['running', 3, 2, 0, 2, 0], 'the old text of b is retired, not still owed');
  await s.fire();
  assert.deepEqual(s.passes[1].blocks.map((block) => block.text), [b.text, c.text]);
  assert.deepEqual(ledger(s.feed.state()), ['running', 4, 2, 0, 0, 2], 'the new text is one more block owed');
  // b's new text translates; c fails its second chance and is given up.
  await s.settle((el) => el === b);
  const snap = s.feed.state();
  assert.deepEqual(ledger(snap), ['partial', 4, 4, 1, 0, 0]);
  assert.equal(snap.known, snap.settled);
  assert.equal(s.feed.fraction(snap), 1);
  for (let i = 1; i < s.history.length; i += 1) {
    assert.ok(s.history[i].known >= s.history[i - 1].known, `known fell at snapshot ${i}`);
    assert.ok(s.history[i].settled <= s.history[i].known);
  }
});

// The same replacement, reached from the other side: the node comes back with new
// text while its old copy is still in flight, and that round fails. Putting the old
// copy back would overwrite the new one (the new text is never sent); keeping the
// new one without retiring the old key leaves the ring short.
test('a block re-offered with new text while in flight keeps the new text when its round fails', async () => {
  const s = loadScheduler();
  const a = element('a');
  const b = element('b');
  s.offer(a, b);
  await s.fire();
  assert.deepEqual(ledger(s.feed.state()), ['running', 2, 0, 0, 0, 2]);
  b.text = 'b text rewritten by the page while in flight';
  s.offer(b);
  assert.deepEqual(ledger(s.feed.state()), ['running', 2, 0, 0, 1, 2]);
  await s.settle((el) => el === a);
  assert.deepEqual(ledger(s.feed.state()), ['running', 2, 2, 0, 1, 0],
    'the in-flight copy of b is retired; the queued one with the new text stays');
  await s.fire();
  assert.deepEqual(s.passes[1].blocks.map((block) => block.text), [b.text], 'the next round sends the new text');
  await s.settle();
  assert.deepEqual(ledger(s.feed.state()), ['done', 3, 3, 0, 0, 0]);
  assert.equal(s.feed.fraction(s.feed.state()), 1);
});

test('a new session zeroes the snapshot and moves session forward', async () => {
  const s = loadScheduler();
  s.offer(...Array.from({ length: 6 }, (_, i) => element(`p${i}`)));
  await s.fire();
  await s.settle();
  const before = s.feed.state();
  assert.ok(before.known > 0 && before.settled > 0);
  s.auto.onSettingsChanged({ targetLang: 'ja' });
  const after = s.feed.state();
  assert.equal(after.session, before.session + 1);
  assert.deepEqual(ledger(after), [after.phase, 0, 0, 0, 0, 0]);
  assert.equal(after.source, 'auto');
});
