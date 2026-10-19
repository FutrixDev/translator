// The progress ring on the float ball (design ext-opt-page-translation §4, §6.1
// batch B 1-4, journeys J3.1-J3.5, J3.7 and J3.8).
//
// The ring reads one source, ctx.progressFeed, and writes two things: the
// phase as data-phase on svg.ai-translator-ring and the share settled as the
// arc's stroke-dashoffset. A Playwright-side poll sees a handful of states out
// of a round that changes every frame, so every journey here installs a probe
// in the content-script world that records, frame by frame:
//
//   frames  one entry per requestAnimationFrame: what is on screen in that
//           frame, next to the feed's state at that moment.
//   paints  one entry per feed notification, read right after the ring's own
//           subscriber has painted it (the ring subscribes at load, the probe
//           later, and subscribers run in that order in the same frame). Each
//           pairs an offset with the exact snapshot it was drawn from.
//   writes  one entry per change the ring makes to its svg, seen by a
//           MutationObserver. Notifications are coalesced per frame, so a
//           manual round's end and the auto scheduler's next report can share
//           one; the page entry repaints the ring synchronously at the end of
//           a manual round, and only this list is sure to see that paint.
//
// Mutants this has to catch (§6.2): the 0.99 cap gone (J3.5: an auto round
// between two of its sub-rounds has settled === known while more blocks wait),
// the 600 ms gate gone (B-3), and progress delivered per 40-block batch again
// instead of per block (the built-in variant of B-1).
const { test, expect } = require('./fixtures');
const {
  evaluateInContentScript,
  setExtensionSettings,
  stubBuiltinTranslator,
  waitForContentReady,
  writeSyncSettings,
} = require('./helpers');
const { startMockOpenAIServer } = require('./mock-openai-server');

const HOST = 'ring.test';
const ORIGIN = `https://${HOST}`;
// 122.5 × (1 − 0.99): the least the arc may leave open while anything is still
// out. The ring writes offsets with toFixed(2), so the cap reads back as 1.23.
const CAP_OFFSET = 1.23;
const GATE_MS = 600;
// One frame either side of a timer: the probe sees a change in the first frame
// after it happens.
const FRAME_MS = 20;
// Uneven built-in answer times, so the four concurrent calls settle in
// different frames instead of all in one.
const BUILTIN_DELAYS_MS = [70, 110, 150, 90, 130];

const SENTENCE = 'the harbour ferry leaves the northern pier every morning and returns before dusk.';
// Compact rows: 80 of them fit in the auto discovery band (a screen above and
// below the viewport), so an auto round sees them all at once.
const COMPACT_CSS = 'body { margin: 0; font: 12px/14px sans-serif; } p { margin: 0; }';
const rows = (count, prefix = 'Line') =>
  Array.from({ length: count }, (_, i) => `<p id="p${i}">${prefix} ${i}: ${SENTENCE}</p>`).join('\n');
const html = (body, css = COMPACT_CSS) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Ring</title><style>${css}</style></head>
<body>${body}</body></html>`;

// Two paragraphs on screen, two far below: the page pass sends the far pair in a
// batch of its own (the feeder pulls the viewport first), so failing that
// batch fails exactly those two.
const BROKEN = 'Broken buoy';
const PAGES = {
  '/long': html(`<div id="view">${rows(80)}</div>`),
  // More than three AI batches (40 a batch): three failed batches end the pass
  // with an error (batch.js MAX_BATCH_FAILURES); two would only be partial.
  '/many': html(rows(130)),
  '/partial': html(`<p id="a">Alpha: ${SENTENCE}</p>
<p id="b">Bravo: ${SENTENCE}</p>
<div style="height:3000px"></div>
<p id="t1">${BROKEN} one drifted past the harbour mouth during the night.</p>
<p id="t2">${BROKEN} two was found tangled in the nets of a trawler at dawn.</p>`, 'body { font: 16px/24px sans-serif; }'),
  '/one': html(`<div id="log"><p id="first">First entry: ${SENTENCE}</p></div>`),
};

async function serve(context) {
  await context.route(`${ORIGIN}/**`, (route) => {
    const body = PAGES[new URL(route.request().url()).pathname];
    if (!body) return route.fulfill({ status: 404, body: 'not found' });
    return route.fulfill({ status: 200, contentType: 'text/html', body });
  });
}

function settings(endpoint, extra = {}) {
  return {
    apiEndpoint: endpoint,
    apiKey: 'test-key',
    modelName: 'gpt-4.1-mini',
    targetLang: 'zh-CN',
    skipTargetLanguageText: false,
    translationStyle: 'underline',
    ...extra,
  };
}

const BUILTIN = { translationEngine: 'builtin', autoTranslateEngine: 'builtin' };

const PROBE = `(() => {
  const feed = self.AI_TRANSLATOR_CONTENT.progressFeed;
  const probe = { frames: [], paints: [], writes: [], mouseupAt: null };
  self.__ringProbe = probe;
  const read = () => {
    const ball = document.getElementById('ai-translator-float-ball');
    const svg = ball && ball.querySelector('svg.ai-translator-ring');
    const arc = svg && svg.querySelector('.ai-translator-ring-arc');
    const dot = ball && ball.querySelector('.ai-translator-status-dot');
    return {
      t: performance.now(),
      phase: svg ? svg.dataset.phase : null,
      offset: arc ? parseFloat(arc.style.strokeDashoffset) : null,
      display: svg ? getComputedStyle(svg).display : null,
      animation: arc ? getComputedStyle(arc).animationName : null,
      dot: dot ? dot.dataset.state : null,
      track: document.querySelector('.ai-translator-progress-track') !== null,
      feed: { ...feed.state() },
    };
  };
  // The ball starts a page round on mouseup (content-float-ball.js).
  document.addEventListener('mouseup', () => {
    if (probe.mouseupAt === null) probe.mouseupAt = performance.now();
  }, true);
  const tick = () => {
    probe.frames.push(read());
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  feed.subscribe(() => probe.paints.push(read()));
  const svg = document.querySelector('#ai-translator-float-ball svg.ai-translator-ring');
  new MutationObserver(() => probe.writes.push(read())).observe(svg, { attributes: true, subtree: true });
  return true;
})()`;

const installProbe = (context, page) => evaluateInContentScript(context, page, PROBE);
const readProbe = (context, page) => evaluateInContentScript(context, page, 'self.__ringProbe');
const feedState = (context, page) =>
  evaluateInContentScript(context, page, 'self.AI_TRANSLATOR_CONTENT.progressFeed.state()');
const ring = (page) => page.locator('#ai-translator-float-ball svg.ai-translator-ring');

async function clickBall(page) {
  await page.click('#ai-translator-float-ball', { position: { x: 18, y: 18 } });
}

/**
 * Wait until the probe has seen the feed reach `phase` from `source`, then until
 * the ring has left the screen. Asked of the probe, not of the live feed: on a
 * page with auto translation on, the scheduler reports again right after a
 * manual round ends, and that report replaces the manual snapshot on the feed
 * well inside one Playwright poll.
 */
async function waitForRoundEnd(context, page, { source, phase = 'done', timeout = 60000 }) {
  const reached = `[...self.__ringProbe.paints, ...self.__ringProbe.writes].some((r) =>
    r.feed.source === ${JSON.stringify(source)} && r.feed.phase === ${JSON.stringify(phase)})`;
  await expect.poll(() => evaluateInContentScript(context, page, reached), { timeout }).toBe(true);
  await expect(ring(page)).toHaveAttribute('data-phase', 'idle', { timeout: 5000 });
}

/** The first record, in time, of the feed at `phase` from `source`. */
function firstAt(probe, source, phase) {
  const records = [...probe.paints, ...probe.writes, ...probe.frames]
    .filter((r) => r.feed.source === source && r.feed.phase === phase)
    .sort((a, b) => a.t - b.t);
  expect(records.length, `a record of ${source} ${phase}`).toBeGreaterThan(0);
  return records[0];
}

const busy = (record) => record.feed.pending + record.feed.inflight > 0;

/** §6.1 B-1: while anything is still out, the arc is never drawn full. */
function expectNeverFullWhileBusy(probe, label) {
  const full = probe.paints.filter((p) => busy(p) && p.offset === 0);
  expect(full.map((p) => p.feed), `${label}: offset 0 with blocks still out`).toEqual([]);
}

/** The offsets the ring drew while `source`'s round was running, in order. */
function runningOffsets(probe, source) {
  return probe.paints
    .filter((p) => p.feed.source === source && p.phase === 'running')
    .map((p) => p.offset);
}

/** ms from the first frame where the feed says done to the first frame the ring is display:none. */
function doneToHidden(probe, source) {
  const done = firstAt(probe, source, 'done');
  const after = probe.frames.filter((f) => f.t >= done.t);
  const hidden = after.findIndex((f) => f.display === 'none');
  expect(hidden, 'the ring leaves the screen after done').toBeGreaterThan(0);
  return { ms: after[hidden].t - done.t, after: after.slice(0, hidden) };
}

test.describe('float ball progress ring', () => {
  let mock;

  test.afterEach(async () => {
    if (mock) await mock.close();
    mock = null;
  });

  test('B-1 / J3.1: a manual round arms at once, fills monotonically short of full, then plays done and leaves', async ({ page, context }) => {
    test.setTimeout(90000);
    mock = await startMockOpenAIServer({ delayMs: 300 });
    await serve(context);
    await setExtensionSettings(page, settings(mock.endpoint));
    await page.goto(`${ORIGIN}/long`);
    await waitForContentReady(page);
    await installProbe(context, page);

    await clickBall(page);
    await waitForRoundEnd(context, page, { source: 'manual' });
    const probe = await readProbe(context, page);

    // Armed within 100 ms of the click, sweeping.
    const armed = probe.frames.find((f) => f.phase === 'arming');
    expect(armed, 'an arming frame').toBeTruthy();
    expect(armed.t - probe.mouseupAt).toBeLessThanOrEqual(100);
    expect(armed.animation).toContain('sweep');

    // Running: the arc only ever closes, ends at or under the cap, and is never
    // full while a block is still out.
    const offsets = runningOffsets(probe, 'manual');
    expect(offsets.length, 'running paints').toBeGreaterThan(0);
    for (let i = 1; i < offsets.length; i += 1) expect(offsets[i]).toBeLessThanOrEqual(offsets[i - 1]);
    expect(Math.min(...offsets)).toBeLessThanOrEqual(CAP_OFFSET);
    expectNeverFullWhileBusy(probe, 'manual');

    // Done: fill, mint, hold, fade — gone 1.6 s after the round ends.
    const { ms, after } = doneToHidden(probe, 'manual');
    expect(ms).toBeGreaterThanOrEqual(1400);
    expect(ms).toBeLessThanOrEqual(1900);
    expect(after.some((f) => f.phase === 'done'), 'the mint step').toBe(true);

    // The bar has no track any more, at any frame of the round.
    expect(probe.frames.some((f) => f.track)).toBe(false);
    await expect(page.locator('.ai-translator-progress-track')).toHaveCount(0);
  });

  test('B-1 built-in: one block a call moves the arc block by block', async ({ page, context }) => {
    test.setTimeout(90000);
    mock = await startMockOpenAIServer();
    await serve(context);
    await setExtensionSettings(page, settings(mock.endpoint, BUILTIN));
    await page.goto(`${ORIGIN}/long`);
    await waitForContentReady(page);
    await stubBuiltinTranslator(page, { delaysMs: BUILTIN_DELAYS_MS });
    await installProbe(context, page);

    await clickBall(page);
    await waitForRoundEnd(context, page, { source: 'manual' });
    const probe = await readProbe(context, page);

    const blocks = firstAt(probe, 'manual', 'done').feed.known;
    expect(blocks).toBe(80);
    expect(mock.sentTexts).toEqual([]);
    // Progress delivered per 40-block batch would draw two or three steps.
    const offsets = runningOffsets(probe, 'manual');
    for (let i = 1; i < offsets.length; i += 1) expect(offsets[i]).toBeLessThanOrEqual(offsets[i - 1]);
    const steps = new Set(offsets).size;
    test.info().annotations.push({ type: 'B-1 built-in', description: `${steps} distinct offsets for ${blocks} blocks` });
    expect(steps).toBeGreaterThanOrEqual(blocks / 2);
    expectNeverFullWhileBusy(probe, 'manual built-in');
  });

  test('B-2 / J3.2: a manual round that fails outright stays a full coral ring', async ({ page, context }) => {
    test.setTimeout(90000);
    // 400: not retried, so every batch fails once and fast.
    mock = await startMockOpenAIServer({ failWhen: () => true, failStatus: 400 });
    await serve(context);
    await setExtensionSettings(page, settings(mock.endpoint));
    await page.goto(`${ORIGIN}/many`);
    await waitForContentReady(page);
    await installProbe(context, page);

    await clickBall(page);
    await expect(ring(page)).toHaveAttribute('data-phase', 'error', { timeout: 30000 });
    await expect(page.locator('#ai-translator-progress')).toHaveClass(/ai-translator-progress-error-state/);
    await expect(ring(page).locator('.ai-translator-ring-arc')).toHaveCSS('stroke-dashoffset', '0px');
    // It stays: no fade-out follows an error.
    await page.waitForTimeout(2500);
    const probe = await readProbe(context, page);
    const ended = firstAt(probe, 'manual', 'error');
    // The click also switched this page's auto session on: it reports again as
    // soon as the manual round ends (requeues the blocks, then goes idle). None
    // of that is a next round, so none of it may take the coral ring away.
    const later = [...probe.paints, ...probe.writes].filter((r) => r.t > ended.t);
    expect(later.some((r) => r.feed.source === 'auto'), 'an auto report after the manual error').toBe(true);
    expect([...new Set(later.map((r) => `${r.phase}/${r.display}`))]).toEqual(['error/block']);
    const since = ended.t;
    const frames = probe.frames.filter((f) => f.t > since + FRAME_MS);
    expect(frames[frames.length - 1].t - since).toBeGreaterThanOrEqual(2400);
    expect([...new Set(frames.map((f) => `${f.phase}/${f.display}`))]).toEqual(['error/block']);
  });

  test('B-2: an auto round that fails outright lights the status dot and the ring in error', async ({ page, context }) => {
    test.setTimeout(90000);
    mock = await startMockOpenAIServer({ failWhen: () => true, failStatus: 400 });
    await serve(context);
    await setExtensionSettings(page, settings(mock.endpoint, { siteRules: { [HOST]: 'always' } }));
    await page.goto(`${ORIGIN}/many`);

    const dot = page.locator('#ai-translator-float-ball .ai-translator-status-dot');
    await expect(dot).toHaveAttribute('data-state', 'error', { timeout: 30000 });
    await expect(ring(page)).toHaveAttribute('data-phase', 'error');
    await expect(ring(page)).toBeVisible();
  });

  test('B-2 / J3.3: two failed paragraphs leave an amber ring with the gap, for good', async ({ page, context }) => {
    test.setTimeout(90000);
    mock = await startMockOpenAIServer({ failWhen: (text) => text.includes(BROKEN), failStatus: 400 });
    await serve(context);
    await setExtensionSettings(page, settings(mock.endpoint));
    await page.goto(`${ORIGIN}/partial`);
    await waitForContentReady(page);
    await installProbe(context, page);

    await clickBall(page);
    await expect(ring(page)).toHaveAttribute('data-phase', 'partial', { timeout: 30000 });
    const snap = await feedState(context, page);
    expect({ known: snap.known, settled: snap.settled, failed: snap.failed }).toEqual({ known: 4, settled: 4, failed: 2 });
    // The gap is the two given up: (settled − failed) / known = 1/2.
    await expect(ring(page).locator('.ai-translator-ring-arc')).toHaveAttribute('style', /stroke-dashoffset: 61\.25/);

    const since = await evaluateInContentScript(context, page, 'performance.now()');
    await page.waitForTimeout(5200);
    const probe = await readProbe(context, page);
    const held = probe.frames.filter((f) => f.t >= since);
    expect(held[held.length - 1].t - since).toBeGreaterThanOrEqual(5000);
    expect([...new Set(held.map((f) => `${f.phase}/${f.display}`))]).toEqual(['partial/block']);
  });

  test('B-3 / J3.4: a one-block auto round that ends inside 600 ms never shows the ring', async ({ page, context }) => {
    test.setTimeout(90000);
    // Long enough for the probe to see the dot breathe for a few frames, short
    // enough that the round ends inside the gate even on a loaded machine.
    mock = await startMockOpenAIServer({ delayMs: 30 });
    await serve(context);
    await setExtensionSettings(page, settings(mock.endpoint, { siteRules: { [HOST]: 'always' } }));
    await page.goto(`${ORIGIN}/one`);
    await page.waitForSelector('#first + .ai-translator-inline-block', { timeout: 30000 });
    await expect.poll(async () => (await feedState(context, page)).phase).toBe('done');
    await installProbe(context, page);

    // The page grows one paragraph: a one-block incremental round.
    await page.evaluate((text) => {
      const p = document.createElement('p');
      p.id = 'late';
      p.textContent = text;
      document.getElementById('log').appendChild(p);
    }, `A later entry: ${SENTENCE}`);
    await page.waitForSelector('#late + .ai-translator-inline-block', { timeout: 30000 });
    await expect.poll(async () => (await feedState(context, page)).phase).toBe('done');
    await page.waitForTimeout(GATE_MS + 200);
    const probe = await readProbe(context, page);

    const round = probe.frames.filter((f) => f.feed.phase === 'arming' || f.feed.phase === 'running');
    expect(round.length, 'frames of the incremental round').toBeGreaterThan(0);
    const roundMs = round[round.length - 1].t - round[0].t;
    test.info().annotations.push({ type: 'B-3', description: `incremental round ${Math.round(roundMs)} ms` });
    expect(roundMs, 'the round ended inside the gate').toBeLessThan(GATE_MS);
    expect([...new Set(probe.frames.map((f) => f.phase))]).toEqual(['idle']);
    expect(probe.frames.some((f) => f.dot === 'running'), 'the dot breathed').toBe(true);
    expect(probe.frames[probe.frames.length - 1].dot).toBe('none');
  });

  test('B-4 / J3.7: under reduced motion the ring neither spins nor fills, and leaves after 1.2 s', async ({ page, context }) => {
    test.setTimeout(90000);
    mock = await startMockOpenAIServer({ delayMs: 300 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await serve(context);
    await setExtensionSettings(page, settings(mock.endpoint));
    await page.goto(`${ORIGIN}/long`);
    await waitForContentReady(page);
    await installProbe(context, page);

    await clickBall(page);
    await waitForRoundEnd(context, page, { source: 'manual' });
    const probe = await readProbe(context, page);

    const arming = probe.frames.filter((f) => f.phase === 'arming');
    expect(arming.length, 'arming frames').toBeGreaterThan(0);
    for (const frame of arming) {
      expect(frame.animation).not.toMatch(/rotate|sweep/);
      expect(frame.animation).toContain('breathe');
    }
    // No fill-then-mint: straight to done, hold 900 ms, fade 300 ms.
    const { ms, after } = doneToHidden(probe, 'manual');
    expect(ms).toBeGreaterThanOrEqual(1000);
    expect(ms).toBeLessThanOrEqual(1500);
    expect(after.filter((f) => f.phase !== 'idle').every((f) => f.phase === 'done')).toBe(true);
  });

  test('J3.5: a long auto round shows after the gate, lets the share fall back as blocks arrive, and never sticks at 99%', async ({ page, context }) => {
    test.setTimeout(120000);
    mock = await startMockOpenAIServer();
    await serve(context);
    // No rule yet: an "always" site starts its pump 250 ms after load, before
    // the stub could be put in. The rule is flipped live once it is there.
    await setExtensionSettings(page, settings(mock.endpoint, BUILTIN));
    await page.goto(`${ORIGIN}/long`);
    await waitForContentReady(page);
    await stubBuiltinTranslator(page, { delaysMs: BUILTIN_DELAYS_MS });
    await installProbe(context, page);
    await writeSyncSettings(context, { siteRules: { [HOST]: 'always' } });

    await waitForRoundEnd(context, page, { source: 'auto', timeout: 90000 });
    const probe = await readProbe(context, page);
    expect(mock.sentTexts).toEqual([]);

    // Shown only once the round outlasted the gate.
    const started = probe.frames.find((f) => f.feed.source === 'auto' && ['arming', 'running'].includes(f.feed.phase));
    const shown = probe.frames.find((f) => f.phase !== 'idle');
    expect(started && shown, 'the round started and the ring showed').toBeTruthy();
    expect(shown.t - started.t).toBeGreaterThanOrEqual(GATE_MS - FRAME_MS);

    // Sub-rounds of roundCap() blocks: the denominator grows, so the share may
    // fall back; between two of them every admitted block is in while more wait,
    // and that is exactly where an uncapped share would draw a full ring.
    const knowns = [...new Set(probe.paints.map((p) => p.feed.known))];
    expect(knowns.length, 'the denominator grew round by round').toBeGreaterThan(2);
    const between = probe.paints.filter((p) => p.feed.known > 0 && p.feed.settled === p.feed.known && p.feed.pending > 0);
    test.info().annotations.push({ type: 'J3.5', description: `${knowns.length} denominators, ${between.length} between-round paints` });
    expect(between.length, 'paints between two sub-rounds').toBeGreaterThan(0);
    for (const p of between) expect(p.offset).toBe(CAP_OFFSET);
    expectNeverFullWhileBusy(probe, 'auto');

    // It finishes: the ring plays done and leaves instead of holding at 99%.
    expect(probe.frames.some((f) => f.phase === 'done')).toBe(true);
    expect(probe.frames[probe.frames.length - 1].display).toBe('none');
  });

  test('J3.8: a route change mid-round drops the ring to idle at once, and the new page earns its own', async ({ page, context }) => {
    test.setTimeout(120000);
    mock = await startMockOpenAIServer();
    await serve(context);
    await setExtensionSettings(page, settings(mock.endpoint, BUILTIN));
    await page.goto(`${ORIGIN}/long`);
    await waitForContentReady(page);
    await stubBuiltinTranslator(page, { delaysMs: BUILTIN_DELAYS_MS });
    await installProbe(context, page);
    await writeSyncSettings(context, { siteRules: { [HOST]: 'always' } });

    // Mid-round, with the ring on screen.
    await expect(ring(page)).toHaveAttribute('data-phase', 'running', { timeout: 30000 });
    const before = await feedState(context, page);
    expect(before.pending + before.inflight).toBeGreaterThan(0);

    // Next page: the URL changes and the view is replaced.
    await page.evaluate((body) => {
      history.pushState({}, '', '/long?page=2');
      document.getElementById('view').innerHTML = body;
    }, rows(60, 'Next'));

    await expect.poll(async () => (await feedState(context, page)).session, { timeout: 15000 })
      .toBeGreaterThan(before.session);
    await waitForRoundEnd(context, page, { source: 'auto', timeout: 90000 });
    const probe = await readProbe(context, page);

    const turned = probe.paints.findIndex((p) => p.feed.session > before.session);
    expect(turned).toBeGreaterThan(0);
    // Idle in the very paint of the new session: no done sequence for a page
    // that is gone.
    expect(probe.paints[turned].phase).toBe('idle');
    const afterTurn = probe.paints.slice(turned);
    const reshown = afterTurn.findIndex((p) => p.phase !== 'idle');
    expect(reshown, 'the new page brings the ring back').toBeGreaterThan(0);
    expect(afterTurn.slice(0, reshown).every((p) => p.phase === 'idle')).toBe(true);
    expect(afterTurn[reshown].feed.session).toBeGreaterThan(before.session);
    expect(['arming', 'running']).toContain(afterTurn[reshown].phase);
  });
});
