// Offline dictionary, batch B2: the selection card and the input box ask the
// installed pack first (design ext-offline-dictionary §5, task book
// offline-dict-b2-wiring.md). Journeys J-B2.1–J-B2.4, J-B2.6, J-B2.7 and the
// cold-start latency line; J-B2.5 (the input box) is in
// input-dictionary-note.spec.js beside the other notes.
//
// Every step starts in the real UI: a word selected with the mouse and the
// card opened from the selection icon, or a word typed into the input box.
// The packs are the hand-made fixtures of test/fixtures/dict-runtime, served by
// DictPackServer through context.route; the model is the local mock server,
// whose sentTexts is the count of TRANSLATE requests that reached a model.
//
// DICT_B2_EVIDENCE names a directory for the screenshots and latency.json
// (the batch's evidence folder); without it they go to the test's own output
// folder.
const fs = require('fs');
const path = require('path');
const { test, expect } = require('./fixtures');
const {
  closeInputDialog,
  evaluateInContentScript,
  openInputDialog,
  recycleWorker,
  setExtensionSettings,
  translateInput,
  waitForFloatBall,
  writeSyncSettings,
} = require('./helpers');
const { HOSTILE_ENTRY_CSS } = require('./hostile-css');
const { contrastOf, waitForSettled, MIN_CONTRAST } = require('./layout-checks');
const { startMockOpenAIServer } = require('./mock-openai-server');
const { DictPackServer } = require('./dict-pack-server');
const { install } = require('./dict-pack-journeys');
const { getMessage } = require('../../i18n/messages');
require('../../shared/dict-entry.js');

const ORIGIN = 'https://dictionary.test';
const PACK_VER = '2026.10.13';
const zh = (key) => getMessage(key, 'zh-CN');

const EN_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>River notes</title>
<style>body { margin: 0; padding: 40px 60px; font: 18px/28px Georgia, serif; color: #222; background: #fff; }
p { width: 640px; }</style></head>
<body>
  <p id="lead">Yesterday I <span id="ran">ran</span> along the river before the town woke up.</p>
  <p id="tail">A <span id="zebra">zebra</span> on a poster watched me go by.</p>
</body></html>`;

const JA_PAGE = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>朝ごはん</title>
<style>body { margin: 0; padding: 40px 60px; font: 18px/28px sans-serif; color: #222; background: #fff; }
p { width: 640px; }</style></head>
<body>
  <p id="lead">今朝はパンを <span id="tabemashita">食べました</span> 、とてもおいしかったです。</p>
</body></html>`;

// What the model answers when it is asked about `ran` in context: marked so the
// entry on the card can only have come from the model.
const MODEL_RAN = {
  translation: '[AI] 跑',
  senses: [{ pos: 'v.', defs: ['[AI] 跑（过去式）'] }],
};
const modelEntry = (text) => (text === 'ran' ? MODEL_RAN : { translation: `[T] ${text}` });

const evidenceDir = () => process.env.DICT_B2_EVIDENCE || test.info().outputPath();
function shotPath(name) {
  const dir = evidenceDir();
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, name);
}

async function servePages(context, css = '') {
  const withCss = (html) => (css ? html.replace('</head>', `<style>${css}</style></head>`) : html);
  await context.route(`${ORIGIN}/**`, (route) => {
    const at = new URL(route.request().url()).pathname;
    const body = at === '/ja' ? JA_PAGE : EN_PAGE;
    route.fulfill({ status: 200, contentType: 'text/html', body: withCss(body) });
  });
}

function settings(endpoint, extra = {}) {
  return {
    provider: 'custom',
    apiEndpoint: endpoint,
    apiKey: 'test-key',
    modelName: 'gpt-4.1-mini',
    targetLang: 'zh-CN',
    enableSelection: true,
    selectionTranslationMode: 'popup',
    uiLanguage: 'zh-CN',
    // The model is asked with the page around the word (J-B2.2).
    aiPageContext: true,
    ...extra,
  };
}

/**
 * The model mock, the pack host with en→zh-CN and ja→zh-CN published, the
 * settings, and `url` open with both packs installed.
 */
async function setUp(page, context, { url = `${ORIGIN}/`, css = '', extra = {} } = {}) {
  const mock = await startMockOpenAIServer({ dictEntry: modelEntry });
  const server = new DictPackServer();
  server.publishFixture('en-zh-CN');
  server.publishFixture('ja-zh-CN');
  await server.attach(context);
  await servePages(context, css);
  await setExtensionSettings(page, settings(mock.endpoint, extra));
  await page.goto(url);
  await waitForFloatBall(page);
  await install(context, page, 'en', 'zh-CN', PACK_VER);
  await install(context, page, 'ja', 'zh-CN', PACK_VER);
  return mock;
}

// Select the text of `selector` with the mouse, as a reader would, and open the
// card from the selection icon.
async function openCardOn(page, selector) {
  const box = await page.locator(selector).boundingBox();
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + 1, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 1, y, { steps: 5 });
  await page.mouse.up();
  const icon = page.locator('#ai-translator-selection-btn .ai-translator-selection-icon');
  await expect(icon).toBeVisible();
  await icon.click();
  return page.locator('.ai-translator-popup');
}

const cardPart = (card) => ({
  title: card.locator('.ai-translator-title'),
  tag: card.locator('.ai-translator-engine-tag'),
  text: card.locator('.ai-translator-translation-text'),
  entry: card.locator('.ai-translator-dict-entry'),
  credits: card.locator('.ai-translator-dict-credits'),
  switchBtn: card.locator('.ai-translator-switch-engine'),
  retranslate: card.locator('.ai-translator-retranslate'),
});

// The local entry for `run`, from the en→zh-CN fixture pack.
async function expectLocalRunEntry(card) {
  const { title, tag, text, entry, credits } = cardPart(card);
  await expect(title).toHaveText(zh('dictTitle'));
  await expect(tag).toHaveText(zh('cardEngineDict'));
  await expect(text).toHaveText('跑');
  await expect(entry).toBeVisible();
  await expect(entry.locator('.ai-translator-dict-ipa')).toHaveText('pǎo');
  await expect(entry.locator('.ai-translator-dict-pos')).toHaveText(['v.', 'n.']);
  await expect(entry.locator('.ai-translator-dict-defs')).toHaveText(['跑; 奔跑; 经营', '跑步; 一段路程']);
  await expect(entry.locator('.ai-translator-dict-example-source'))
    .toHaveText(['I run every morning.', 'She runs a small shop.']);
  await expect(entry.locator('.ai-translator-dict-form-value')).toHaveText(['ran', 'run', 'running']);
  await expect(credits).toHaveCount(1);
  await expect(credits.locator('.ai-translator-dict-credits-prefix')).toHaveText(zh('dictCredits'));
  await expect(credits.locator('a')).toHaveText(['Tatoeba']);
  await expect(credits.locator('a')).toHaveAttribute('href', 'https://tatoeba.org/');
}

// Where the credits line sits against the card's scroll container
// (.ai-translator-content, max-height 340px, overflow-y auto).
function creditsPlacement(card) {
  return card.evaluate((popup) => {
    const scroller = popup.querySelector('.ai-translator-content');
    const line = popup.querySelector('.ai-translator-dict-credits');
    const box = scroller.getBoundingClientRect();
    const rect = line.getBoundingClientRect();
    return {
      scrollerHeight: Math.round(box.height),
      scrollHeight: scroller.scrollHeight,
      scrollTop: Math.round(scroller.scrollTop),
      overflowY: getComputedStyle(scroller).overflowY,
      lineTop: Math.round(rect.top - box.top),
      lineBottom: Math.round(rect.bottom - box.top),
      inView: rect.top >= box.top - 1 && rect.bottom <= box.bottom + 1,
    };
  });
}

// The credits line's children and their boxes: one line means one top.
function creditsLayout(line) {
  return line.evaluate((el) => {
    const parts = [...el.children];
    return {
      height: el.getBoundingClientRect().height,
      lineHeight: parseFloat(getComputedStyle(el).lineHeight) || parseFloat(getComputedStyle(el).fontSize) * 1.5,
      offsetTops: parts.map((p) => p.offsetTop),
      rectTops: parts.map((p) => Math.round(p.getBoundingClientRect().top)),
    };
  });
}

// The credits line's computed styles, each against the token it should be:
// resolved on a probe inside the same entry (an inline style no page rule
// outweighs).
function creditsStyles(line) {
  return line.evaluate((el) => {
    const probe = document.createElement('i');
    el.closest('.ai-translator-dict-entry').appendChild(probe);
    const token = (value) => {
      probe.style.color = value;
      return getComputedStyle(probe).color;
    };
    const read = (node) => {
      const s = getComputedStyle(node);
      return { display: s.display, padding: s.padding, fontSize: s.fontSize, color: s.color, decoration: s.textDecorationLine };
    };
    const out = {
      line: read(el),
      prefix: read(el.querySelector('.ai-translator-dict-credits-prefix')),
      link: read(el.querySelector('.ai-translator-dict-credit-link')),
      secondary: token('var(--text-secondary)'),
      pos: token('var(--dict-pos)'),
    };
    probe.remove();
    return out;
  });
}

async function expectCreditsHold(line, label) {
  const layout = await creditsLayout(line);
  expect(new Set(layout.offsetTops).size, `${label}: prefix and links share one offsetTop ${JSON.stringify(layout)}`).toBe(1);
  expect(new Set(layout.rectTops).size, `${label}: one row ${JSON.stringify(layout)}`).toBe(1);
  expect(layout.height, `${label}: one line high ${JSON.stringify(layout)}`).toBeLessThan(layout.lineHeight * 1.5);

  const styles = await creditsStyles(line);
  expect({ label, ...styles.line, color: styles.line.color })
    .toEqual({ label, display: 'block', padding: '0px', fontSize: '12px', color: styles.secondary, decoration: 'none' });
  expect({ label, ...styles.prefix })
    .toEqual({ label, display: 'inline', padding: '0px 4px 0px 0px', fontSize: '12px', color: styles.secondary, decoration: 'none' });
  expect({ label, ...styles.link })
    .toEqual({ label, display: 'inline', padding: '0px', fontSize: '12px', color: styles.pos, decoration: 'underline' });
  for (const part of ['line', 'prefix', 'link']) expect(styles[part].color, `${label} ${part}`).not.toBe('rgb(255, 0, 0)');

  for (const selector of ['.ai-translator-dict-credits-prefix', '.ai-translator-dict-credit-link']) {
    const ratio = await contrastOf(line.locator(selector).first());
    console.log(`J-B2.7 contrast ${label} ${selector}: ${ratio.toFixed(2)}`);
    expect(ratio, `${label} ${selector}`).toBeGreaterThanOrEqual(MIN_CONTRAST);
  }
}

test.describe('offline dictionary in the card and the input box (batch B2)', () => {
  test('J-B2.1/J-B2.2: a selected word the pack has is answered locally; "explain in context" asks the model, with the page', async ({ page, context }) => {
    const mock = await setUp(page, context);
    try {
      // J-B2.1 — the local entry: title, tag, the run entry, its credits.
      const card = await openCardOn(page, '#ran');
      const parts = cardPart(card);
      await expectLocalRunEntry(card);
      // The one way on: the model engine available now, worded as an explanation.
      await expect(parts.switchBtn).toBeVisible();
      await expect(parts.switchBtn).toHaveText(zh('cardUseAiExplain'));
      await expect(parts.switchBtn).toHaveAttribute('data-engine', 'ai');
      expect(mock.sentTexts, 'a local hit sends no TRANSLATE').toEqual([]);

      // Must-do 3: the credits line is reachable in the card's scroll container.
      await page.waitForTimeout(400); // the reveal animation
      const before = await creditsPlacement(card);
      console.log('J-B2.1 credits placement (default):', JSON.stringify(before));
      await card.screenshot({ path: shotPath('j-b2-1-card-default.png') });
      await parts.credits.scrollIntoViewIfNeeded();
      const after = await creditsPlacement(card);
      console.log('J-B2.1 credits placement (scrolled):', JSON.stringify(after));
      expect(after.inView, `credits reachable: ${JSON.stringify(after)}`).toBe(true);
      await card.screenshot({ path: shotPath('j-b2-1-card-credits.png') });
      expect(mock.sentTexts).toEqual([]);

      // J-B2.2 — one click: the same word to the model, with the page context.
      await parts.switchBtn.click();
      await expect.poll(() => mock.sentTexts).toEqual(['ran']);
      expect(mock.systemPrompts[0]).toContain(globalThis.DictEntry.PROMPT_MARK);
      expect(mock.systemPrompts[0]).toContain('PAGE CONTEXT');
      expect(mock.systemPrompts[0]).toContain('River notes');
      await expect(parts.tag).toHaveText(zh('cardEngineAi'));
      await expect(parts.title).toHaveText(zh('aiTranslate'));
      await expect(parts.text).toHaveText('[AI] 跑');
      await expect(parts.entry.locator('.ai-translator-dict-defs')).toHaveText(['[AI] 跑（过去式）']);
      await expect(parts.credits).toHaveCount(0);
      await card.screenshot({ path: shotPath('j-b2-2-card-model.png') });

      // The card stays pinned: asking again goes to the model, not the pack.
      await parts.retranslate.click();
      await expect.poll(() => mock.sentTexts.length).toBe(2);
      await expect(parts.tag).toHaveText(zh('cardEngineAi'));
      await expect(parts.credits).toHaveCount(0);
    } finally {
      await mock.close();
    }
  });

  test('J-B2.3: a conjugated Japanese word finds its head; the JMdict credit opens in a new tab', async ({ page, context }) => {
    const mock = await setUp(page, context, { url: `${ORIGIN}/ja` });
    try {
      await context.route('https://www.edrdg.org/**', (route) => route.fulfill({
        status: 200, contentType: 'text/html', body: '<!doctype html><title>EDRDG licence</title><p>licence</p>',
      }));
      const card = await openCardOn(page, '#tabemashita');
      const parts = cardPart(card);
      await expect(parts.title).toHaveText(zh('dictTitle'));
      await expect(parts.tag).toHaveText(zh('cardEngineDict'));
      await expect(parts.text).toHaveText('吃');
      await expect(parts.entry.locator('.ai-translator-dict-pos')).toHaveText(['v1']);
      await expect(parts.entry.locator('.ai-translator-dict-defs')).toHaveText(['吃; 食用']);
      await expect(parts.entry.locator('.ai-translator-dict-form-value')).toHaveText(['食べた', '食べます']);
      const link = parts.credits.locator('a');
      await expect(link).toHaveText(['JMdict © EDRDG']);
      await parts.credits.scrollIntoViewIfNeeded();
      await page.waitForTimeout(400);
      await card.screenshot({ path: shotPath('j-b2-3-card-jmdict.png') });

      const [opened] = await Promise.all([context.waitForEvent('page'), link.click()]);
      await opened.waitForLoadState('domcontentloaded');
      expect(opened.url()).toBe('https://www.edrdg.org/edrdg/licence.html');
      expect(opened).not.toBe(page);
      expect(mock.sentTexts).toEqual([]);
    } finally {
      await mock.close();
    }
  });

  test('J-B2.4/J-B2.6: a word the pack lacks, and any word with the switch off, go to the engine as before', async ({ page, context }) => {
    const mock = await setUp(page, context);
    try {
      // J-B2.4 — not in the pack: today's path, nothing said about the pack.
      let card = await openCardOn(page, '#zebra');
      let parts = cardPart(card);
      await expect.poll(() => mock.sentTexts).toEqual(['zebra']);
      expect(mock.systemPrompts[0]).toContain(globalThis.DictEntry.PROMPT_MARK);
      await expect(parts.text).toHaveText('[T] zebra');
      await expect(parts.title).toHaveText(zh('aiTranslate'));
      await expect(parts.tag).toHaveText(zh('cardEngineAi'));
      await expect(parts.credits).toHaveCount(0);
      await expect(card).not.toContainText('词典');
      await card.screenshot({ path: shotPath('j-b2-4-card-miss.png') });
      await evaluateInContentScript(context, page, 'window.AI_TRANSLATOR_CONTENT.hideTranslationPopup()');

      // J-B2.6 — the switch off: `ran` is in the pack, and goes to the model anyway.
      await writeSyncSettings(context, { offlineDictionary: false });
      await expect.poll(() => evaluateInContentScript(context, page,
        'window.AI_TRANSLATOR_CONTENT.settings.offlineDictionary')).toBe(false);
      card = await openCardOn(page, '#ran');
      parts = cardPart(card);
      await expect.poll(() => mock.sentTexts).toEqual(['zebra', 'ran']);
      await expect(parts.text).toHaveText('[AI] 跑');
      await expect(parts.title).toHaveText(zh('aiTranslate'));
      await expect(parts.tag).toHaveText(zh('cardEngineAi'));
      await expect(parts.credits).toHaveCount(0);
    } finally {
      await mock.close();
    }
  });

  // J-B2.7 — a page whose bare `a` and `span` rules would restyle the credits,
  // in both themes, on both surfaces.
  const HOSTILE_LINKS = `${HOSTILE_ENTRY_CSS}
    a, a:link, a:visited, a:hover { color: red; display: block; text-decoration: none; padding: 12px; font-size: 30px; }
    span { color: red; display: block; padding: 6px; }
  `;
  for (const theme of ['dark', 'light']) {
    test(`J-B2.7: the credits line stays one readable line under a hostile page, ${theme} theme`, async ({ page, context }) => {
      const mock = await setUp(page, context, { css: HOSTILE_LINKS, extra: { theme } });
      try {
        await expect(page.locator('html')).toHaveAttribute('data-ai-translator-theme', theme);
        const card = await openCardOn(page, '#ran');
        await expectLocalRunEntry(card);
        const line = cardPart(card).credits;
        await line.scrollIntoViewIfNeeded();
        await waitForSettled(page);
        await expectCreditsHold(line, `${theme} card`);
        await card.screenshot({ path: shotPath(`j-b2-7-card-${theme}-hostile.png`) });
        await evaluateInContentScript(context, page, 'window.AI_TRANSLATOR_CONTENT.hideTranslationPopup()');

        await openInputDialog(page);
        await translateInput(page, 'ran');
        const dialogLine = page.locator('#ai-translator-input-dict .ai-translator-dict-credits');
        await expect(dialogLine.locator('a')).toHaveText(['Tatoeba']);
        await dialogLine.scrollIntoViewIfNeeded();
        await waitForSettled(page);
        await expectCreditsHold(dialogLine, `${theme} input box`);
        await page.locator('#ai-translator-input-dialog .ai-translator-input-modal').screenshot({ path: shotPath(`j-b2-7-input-${theme}-hostile.png`) });
        await closeInputDialog(page);
        expect(mock.sentTexts).toEqual([]);
      } finally {
        await mock.close();
      }
    });
  }

  // Must-do 4: with the service worker stopped before every lookup, from the
  // click on the selection icon to the entry on the card, p95 at most 100 ms
  // over 30 lookups. Both ends are read in the content script's world (no
  // Playwright round trip inside the interval): the start in a capturing click
  // listener, the end when the entry is unhidden with its blocks in it
  // (`domMs`) and at the next animation frame after that (`frameMs`).
  test('cold-start latency: a local hit after the worker stopped, 30 times', async ({ page, context }) => {
    test.setTimeout(240000);
    const mock = await setUp(page, context);
    try {
      await evaluateInContentScript(context, page, `(() => {
        self.__lat = { start: null, dom: null, frame: null };
        document.addEventListener('click', (event) => {
          if (event.target.closest && event.target.closest('#ai-translator-selection-btn')) {
            self.__lat = { start: performance.now(), dom: null, frame: null };
          }
        }, true);
        new MutationObserver(() => {
          const lat = self.__lat;
          if (lat.start === null || lat.dom !== null) return;
          const entry = document.querySelector('.ai-translator-popup .ai-translator-dict-entry');
          if (!entry || entry.hidden || !entry.childElementCount) return;
          lat.dom = performance.now();
          requestAnimationFrame(() => { lat.frame = performance.now(); });
        }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden'] });
        return true;
      })()`);

      const runs = [];
      for (let i = 0; i < 30; i++) {
        await evaluateInContentScript(context, page, 'window.AI_TRANSLATOR_CONTENT.hideTranslationPopup()');
        await page.evaluate(() => window.getSelection().removeAllRanges());
        await recycleWorker(context, page);
        const card = await openCardOn(page, '#ran');
        await expect(cardPart(card).tag).toHaveText(zh('cardEngineDict'));
        await expect.poll(() => evaluateInContentScript(context, page, 'self.__lat.frame !== null')).toBe(true);
        const lat = await evaluateInContentScript(context, page, 'self.__lat');
        runs.push({ domMs: lat.dom - lat.start, frameMs: lat.frame - lat.start });
      }
      expect(mock.sentTexts).toEqual([]);

      const stats = (values) => {
        const sorted = [...values].sort((a, b) => a - b);
        const at = (p) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
        const round = (n) => Math.round(n * 100) / 100;
        return { count: sorted.length, p50: round(at(50)), p95: round(at(95)), max: round(sorted.at(-1)) };
      };
      const result = {
        what: 'click on the selection icon -> local dictionary entry on the card, service worker stopped (CDP ServiceWorker.stopAllWorkers) before each run',
        measuredIn: 'content-script world, performance.now()',
        recycledBeforeEachRun: true,
        domVisible: stats(runs.map((r) => r.domMs)),
        nextFrame: stats(runs.map((r) => r.frameMs)),
        runs: runs.map((r) => ({ domMs: Math.round(r.domMs * 100) / 100, frameMs: Math.round(r.frameMs * 100) / 100 })),
      };
      fs.writeFileSync(shotPath('latency.json'), `${JSON.stringify(result, null, 2)}\n`);
      console.log(`DICT_B2_LATENCY ${JSON.stringify({ domVisible: result.domVisible, nextFrame: result.nextFrame })}`);
      expect(result.nextFrame.p95).toBeLessThanOrEqual(100);
    } finally {
      await mock.close();
    }
  });
});
