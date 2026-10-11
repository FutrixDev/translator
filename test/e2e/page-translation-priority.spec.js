// Whole-page translation sends what the reader is looking at first (design
// ext-opt-page-translation §3, journeys J5.1, J5.2 and J5.4).
//
// The page is 200 paragraphs, each in an 800px section of fixed height: a
// translation lands inside its own section, so nothing moves while the pass
// runs and the measured geometry stays the page's geometry.
//
// The built-in engine is a stub (e2e Chromium has no on-device model). It
// answers '[B] ' + text after a fixed delay, keeps every text it was handed in
// call order, and can scroll the page itself at a given call number, so the
// scroll lands exactly between two pulls instead of somewhere a test timer
// happens to fire. The built-in engine sends one block per call
// (batch.js BUILTIN_BATCH), so the call order is the pull order.
//
// Mutants this has to catch (§6.2): the feeder not sorting (J5.1), the feeder
// not reading scrollY (J5.1, J5.2) and the auto round draining the whole queue
// instead of stopping at ROUND_CAP (J5.4).
const { test, expect } = require('./fixtures');
const {
  evaluateInContentScript,
  setExtensionSettings,
  triggerPageTranslation,
  waitForContentReady,
  writeSyncSettings,
} = require('./helpers');
const { startMockOpenAIServer } = require('./mock-openai-server');

const SITE = 'https://priority.test';
const COUNT = 200;
const SECTION_PX = 800;
const STUB_DELAY_MS = 80;
// PAGE_LIMITS.CONCURRENCY.builtin: how many calls can already be in flight
// when the reader moves.
const BUILTIN_CONCURRENCY = 4;

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Priority</title>
<style>
  body { margin: 0; font: 16px/24px sans-serif; }
  section { height: ${SECTION_PX}px; margin: 0; padding: 0; }
  section > p { margin: 0; min-height: 680px; }
</style></head>
<body>
${Array.from({ length: COUNT }, (_, i) => `<section><p id="s${i}">Segment ${i}: the harbour ferry leaves the northern pier every morning and returns before dusk.</p></section>`).join('\n')}
</body></html>`;

async function serve(context) {
  await context.route(`${SITE}/**`, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: PAGE }));
}

function settings(endpoint, extra) {
  return {
    apiEndpoint: endpoint,
    apiKey: 'test-key',
    modelName: 'gpt-4.1-mini',
    targetLang: 'zh-CN',
    skipTargetLanguageText: false,
    translationStyle: 'underline',
    translationEngine: 'builtin',
    autoTranslateEngine: 'builtin',
    ...extra,
  };
}

/**
 * The ordered built-in stub, in the content-script world. `gated` holds every
 * call until `self.__openGate(jumpId)` runs; that call also arms a jump to
 * `jumpId` at the next call number. `jump` arms one up front instead.
 * `self.__s150At` / `self.__jump.at` are performance.now() stamps (the page and
 * the isolated world share the document's time origin).
 */
function installStub(context, page, { gated = false, jump = null } = {}) {
  return evaluateInContentScript(context, page, `(() => {
    const delayMs = ${STUB_DELAY_MS};
    let release = null;
    const gate = new Promise((resolve) => { release = resolve; });
    if (!${gated}) release();
    self.__builtinCalls = 0;
    self.__builtinTexts = [];
    self.__jump = Object.assign({ atCall: 0, id: '', at: null }, ${JSON.stringify(jump)});
    self.__openGate = (id) => {
      Object.assign(self.__jump, { atCall: self.__builtinCalls + 1, id });
      release();
      return self.__builtinCalls;
    };
    // When the jump target's translation lands (insert.js puts it right after the block).
    self.__s150At = null;
    const target = document.getElementById('s150');
    const landed = () => {
      const next = target.nextElementSibling;
      return Boolean(next && next.matches('.ai-translator-inline-block') && next.textContent.includes('[B]'));
    };
    const watcher = new MutationObserver(() => {
      if (self.__s150At === null && landed()) {
        self.__s150At = performance.now();
        watcher.disconnect();
      }
    });
    watcher.observe(target.parentNode, { childList: true, subtree: true, characterData: true });
    self.Translator = {
      availability: async () => 'available',
      create: async () => ({
        translate: async (text) => {
          self.__builtinCalls += 1;
          const n = self.__builtinCalls;
          self.__builtinTexts.push(text);
          if (n === self.__jump.atCall) {
            self.__jump.at = performance.now();
            document.getElementById(self.__jump.id).scrollIntoView();
          }
          await gate;
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          return '[B] ' + text;
        },
        destroy() {},
      }),
    };
    return true;
  })()`);
}

/** The paragraph number of every built-in call, in call order. */
async function callOrder(context, page) {
  const texts = await evaluateInContentScript(context, page, 'self.__builtinTexts');
  return texts.map((text) => {
    const match = /Segment (\d+):/.exec(text);
    if (!match) throw new Error(`a built-in call without a segment number: ${text}`);
    return Number(match[1]);
  });
}

/** Paragraph numbers whose box intersects the viewport right now. */
function inViewport(page) {
  return page.evaluate(() => [...document.querySelectorAll('section > p')]
    .filter((p) => {
      const rect = p.getBoundingClientRect();
      return rect.bottom > 0 && rect.top < window.innerHeight;
    })
    .map((p) => Number(p.id.slice(1))));
}

test.describe('page translation pulls by viewport', () => {
  let mock;

  test.beforeEach(async () => {
    mock = await startMockOpenAIServer();
  });

  test.afterEach(async () => {
    await mock.close();
  });

  test('manual pass: the viewport goes first, and a jump mid-pass is served within the in-flight calls (J5.1, J5.2)', async ({ page, context }) => {
    test.setTimeout(90000);
    await serve(context);
    await setExtensionSettings(page, settings(mock.endpoint));
    await page.goto(`${SITE}/long`);
    await waitForContentReady(page);

    // Start in the middle of the page, straddling two paragraphs: from the top,
    // document order would put the viewport first by itself and prove nothing.
    await page.evaluate((y) => window.scrollTo(0, y), 100 * SECTION_PX + SECTION_PX / 2);
    const visible = await inViewport(page);
    expect(visible).toEqual([100, 101]);

    const JUMP_AT = 20;
    await installStub(context, page, { jump: { atCall: JUMP_AT, id: 's150' } });
    await triggerPageTranslation(page);

    await expect.poll(() => page.locator('.ai-translator-inline-block').count(), { timeout: 60000 }).toBe(COUNT);
    await page.waitForSelector('#ai-translator-progress', { state: 'hidden', timeout: 30000 });

    const order = await callOrder(context, page);
    expect(order).toHaveLength(COUNT);
    expect(new Set(order).size).toBe(COUNT);

    // J5.1: every viewport paragraph was called before any paragraph outside it.
    const lastVisible = Math.max(...visible.map((id) => order.indexOf(id)));
    const firstOutside = Math.min(...order.map((id, index) => (visible.includes(id) ? Infinity : index)));
    expect(lastVisible).toBeLessThan(firstOutside);
    expect(order.slice(0, visible.length).sort((a, b) => a - b)).toEqual(visible);

    // J5.2: the stub scrolled s150 into view during call JUMP_AT. Nothing in
    // flight is cancelled, so s150 waits at most for the calls already out.
    const s150Call = order.indexOf(150) + 1;
    expect(s150Call).toBeGreaterThan(JUMP_AT);
    expect(s150Call).toBeLessThanOrEqual(JUMP_AT + BUILTIN_CONCURRENCY);
  });

  test('auto pass: after a jump the next round re-scores, so a deep queue does not hold the new viewport back (J5.4)', async ({ page, context }) => {
    test.setTimeout(90000);
    await serve(context);
    // No rule yet: an "always" site starts its pump 250ms after load, before the
    // stub could be put in. The rule is flipped live once the stub is there.
    await setExtensionSettings(page, settings(mock.endpoint));
    await page.goto(`${SITE}/long`);
    await waitForContentReady(page);
    await installStub(context, page, { gated: true });
    await writeSyncSettings(context, { siteRules: { 'priority.test': 'always' } });

    // The first round (the opening band) is out and held at the gate.
    await expect.poll(() => evaluateInContentScript(context, page, 'self.__builtinCalls'), { timeout: 15000 })
      .toBeGreaterThan(0);

    // Build a deep queue: walk down to s100 one section a frame, so the
    // discovery band offers every paragraph on the way. A single jump would
    // only ever offer the band around where it lands.
    await page.evaluate(async ({ count, px }) => {
      const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
      for (let i = 1; i <= count; i += 1) {
        window.scrollTo(0, i * px);
        await frame();
        await frame();
      }
    }, { count: 100, px: SECTION_PX });
    const heldCalls = await evaluateInContentScript(context, page, 'self.__builtinCalls');
    // What the scheduler is holding back, from the one progress source.
    const queued = await evaluateInContentScript(context, page,
      'self.AI_TRANSLATOR_CONTENT.progressFeed.state().pending');

    // Let the held round finish; the next call (the first of the next round)
    // scrolls s150 into view and stamps the moment.
    await evaluateInContentScript(context, page, `self.__openGate('s150')`);

    await expect.poll(() => evaluateInContentScript(context, page, 'self.__s150At'), { timeout: 30000 })
      .not.toBeNull();
    const { jumpAt, landedAt } = await evaluateInContentScript(context, page,
      '({ jumpAt: self.__jump.at, landedAt: self.__s150At })');
    const order = await callOrder(context, page);
    const latency = landedAt - jumpAt;
    const bound = 250 + 2 * STUB_DELAY_MS;
    test.info().annotations.push({
      type: 'J5.4',
      description: `held=${heldCalls} queued=${queued} s150Call=${order.indexOf(150) + 1} latency=${Math.round(latency)}ms bound=${bound}ms`,
    });
    // The queue really was deep when the reader jumped: draining it in one
    // round would take queued / BUILTIN_CONCURRENCY waves of STUB_DELAY_MS,
    // well past the bound. Without that the bound proves nothing.
    expect(queued * STUB_DELAY_MS / BUILTIN_CONCURRENCY).toBeGreaterThan(2 * bound);
    expect(latency).toBeLessThanOrEqual(bound);
  });
});
