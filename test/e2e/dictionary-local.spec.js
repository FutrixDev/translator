// Offline dictionary, batch B2: the selection card and the input box ask the
// installed pack first (design ext-offline-dictionary §5, task book
// offline-dict-b2-wiring.md). Journeys J-B2.1–J-B2.4, J-B2.6, J-B2.7 and the
// cold-start latency line; J-B2.5 (the input box) is in
// input-dictionary-note.spec.js beside the other notes. Fix round 1 (D-641,
// offline-dict-b2-r1.md): J-B2.2 runs under the default settings and finds the
// selection's sentence in the prompt, J-B2.2b sends no sentence for an
// ordinary lookup, J-B2.9 explains a Japanese word the pack proved a word, and
// J-B2.10 takes a sentence on the same page as text again.
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
  getServiceWorker,
  openInputDialog,
  recycleWorker,
  setExtensionSettings,
  translateInput,
  waitForFloatBall,
  writeSyncSettings,
} = require('./helpers');
const { HOSTILE_ENTRY_CSS } = require('./hostile-css');
const { waitForSettled } = require('./layout-checks');
const {
  CONTRAST_SELECTORS,
  ENTRY_STYLES,
  ORIGIN,
  expectEntryStyles,
  expectReadableContrast,
  openCardOn,
  servePages,
  settings,
  zh,
} = require('./dict-entry-checks');
const { startMockOpenAIServer } = require('./mock-openai-server');
const { DictPackServer } = require('./dict-pack-server');
const { DictPack, install, listedAt } = require('./dict-pack-journeys');
require('../../shared/dict-entry.js');
require('../../shared/prompt-addenda.js');

const PACK_VER = '2026.10.13';

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
  <p id="lead">今朝はパンを <span id="tabemashita">食べました</span> 、とてもおいしかったです。昼はうどんにします。</p>
  <p id="tail">午後は公園をゆっくり散歩しました。</p>
  <p id="note">明日は <span id="sensei">先生</span> に会います。</p>
</body></html>`;

// What the model answers when it is asked about `ran` or 食べました in
// context: marked so the entry on the card can only have come from the model.
const MODEL_ENTRIES = {
  ran: { translation: '[AI] 跑', senses: [{ pos: 'v.', defs: ['[AI] 跑（过去式）'] }] },
  食べました: { translation: '[AI] 吃', senses: [{ pos: 'v.', defs: ['[AI] 吃（过去式）'] }] },
};
const modelEntry = (text) => MODEL_ENTRIES[text] || { translation: `[T] ${text}` };

// The PAGE CONTEXT addendum of a system prompt (background/prompts.js: the
// heading line, then the context as one line of JSON), or null without one.
function pageContextIn(prompt) {
  const lines = prompt.split('\n');
  const at = lines.indexOf(globalThis.PromptAddenda.HEADINGS.context);
  return at < 0 ? null : JSON.parse(lines[at + 1]);
}

// The text of `selector` as the reader sees it: whitespace runs folded.
const pageText = (page, selector) => page.locator(selector)
  .evaluate((el) => el.textContent.replace(/\s+/g, ' ').trim());

const evidenceDir = () => process.env.DICT_B2_EVIDENCE || test.info().outputPath();
function shotPath(name) {
  const dir = evidenceDir();
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, name);
}

/**
 * The model mock, the pack host with en→zh-CN and ja→zh-CN published, the
 * settings, and `url` open with the packs of the `installed` sources installed.
 */
async function setUp(page, context, { url = `${ORIGIN}/`, css = '', extra = {}, installed = ['en', 'ja'] } = {}) {
  const mock = await startMockOpenAIServer({ dictEntry: modelEntry });
  const server = new DictPackServer();
  server.publishFixture('en-zh-CN');
  server.publishFixture('ja-zh-CN');
  await server.attach(context);
  await servePages(context, { '/': EN_PAGE, '/ja': JA_PAGE }, css);
  await setExtensionSettings(page, settings(mock.endpoint, { uiLanguage: 'zh-CN', ...extra }));
  await page.goto(url);
  await waitForFloatBall(page);
  for (const src of installed) await install(context, page, src, 'zh-CN', PACK_VER);
  return mock;
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

// The credits line stays one line: the prefix and every link on one row.
async function expectCreditsOneLine(line, label) {
  const layout = await creditsLayout(line);
  expect(new Set(layout.offsetTops).size, `${label}: prefix and links share one offsetTop ${JSON.stringify(layout)}`).toBe(1);
  expect(new Set(layout.rectTops).size, `${label}: one row ${JSON.stringify(layout)}`).toBe(1);
  expect(layout.height, `${label}: one line high ${JSON.stringify(layout)}`).toBeLessThan(layout.lineHeight * 1.5);
}

// J-B2.7: the offline entry, credits line included, holds the computed styles
// and the contrast C7/C8 hold a model's entry to (dict-entry-checks.js).
async function expectEntryHolds(page, line, entrySelector, label) {
  await line.scrollIntoViewIfNeeded();
  await waitForSettled(page);
  await expectCreditsOneLine(line, label);
  await expectEntryStyles(page, entrySelector, ENTRY_STYLES);
  await expectReadableContrast(page, entrySelector, label, CONTRAST_SELECTORS);
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

      // J-B2.2 — one click: the same word to the model, with the sentence it
      // was selected in, under the default settings (aiPageContext off).
      expect(await evaluateInContentScript(context, page,
        'window.AI_TRANSLATOR_CONTENT.settings.aiPageContext')).not.toBe(true);
      const sentence = await pageText(page, '#lead');
      await parts.switchBtn.click();
      await expect.poll(() => mock.sentTexts).toEqual(['ran']);
      expect(mock.systemPrompts[0]).toContain(globalThis.DictEntry.PROMPT_MARK);
      expect(pageContextIn(mock.systemPrompts[0])).toEqual({ title: 'River notes', before: sentence });
      expect(mock.systemPrompts[0]).not.toContain(await pageText(page, '#tail'));
      await expect(parts.tag).toHaveText(zh('cardEngineAi'));
      await expect(parts.title).toHaveText(zh('aiTranslate'));
      await expect(parts.text).toHaveText('[AI] 跑');
      await expect(parts.entry.locator('.ai-translator-dict-defs')).toHaveText(['[AI] 跑（过去式）']);
      await expect(parts.credits).toHaveCount(0);
      await card.screenshot({ path: shotPath('j-b2-2-card-model.png') });

      // The card stays pinned: asking again goes to the model, not the pack,
      // still as an explanation with the sentence.
      await parts.retranslate.click();
      await expect.poll(() => mock.sentTexts.length).toBe(2);
      expect(mock.systemPrompts[1]).toContain(globalThis.DictEntry.PROMPT_MARK);
      expect(pageContextIn(mock.systemPrompts[1])).toEqual({ title: 'River notes', before: sentence });
      await expect(parts.tag).toHaveText(zh('cardEngineAi'));
      await expect(parts.credits).toHaveCount(0);
    } finally {
      await mock.close();
    }
  });

  test('J-B2.2b: an ordinary lookup on the same page sends no page context', async ({ page, context }) => {
    const mock = await setUp(page, context);
    try {
      const card = await openCardOn(page, '#zebra');
      const parts = cardPart(card);
      await expect.poll(() => mock.sentTexts).toEqual(['zebra']);
      expect(mock.systemPrompts[0]).toContain(globalThis.DictEntry.PROMPT_MARK);
      expect(pageContextIn(mock.systemPrompts[0])).toBeNull();
      expect(mock.systemPrompts[0]).not.toContain(await pageText(page, '#tail'));
      await expect(parts.tag).toHaveText(zh('cardEngineAi'));
      await expect(parts.text).toHaveText('[T] zebra');
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

  // D-686 (design §3.4 revised): Han without kana in a selection on a Japanese
  // page is Japanese. 先生 is not in the ja→zh-CN pack, so this asks for the
  // pack before it is installed: the worker must be asked for ja-zh-CN. Read
  // as Chinese, the pair would be zh-CN→zh-CN, which is no lookup at all, and
  // no pack would ever be asked for.
  test('J-B2.11: kanji alone on a Japanese page ask for the Japanese pack, not the Chinese one (D-686)', async ({ page, context }) => {
    const mock = await setUp(page, context, { url: `${ORIGIN}/ja`, installed: ['en'] });
    try {
      const worker = await getServiceWorker(context);
      await worker.evaluate(() => {
        self.__dictWanted = [];
        chrome.runtime.onMessage.addListener((message) => {
          if (message && message.type === 'DICT_PACK_WANT') self.__dictWanted.push(`${message.src}-${message.tgt}`);
        });
      });
      const card = await openCardOn(page, '#sensei');
      const parts = cardPart(card);
      // No pack for the pair yet: the card takes its usual path meanwhile.
      await expect.poll(() => mock.sentTexts).toEqual(['先生']);
      await expect(parts.tag).toHaveText(zh('cardEngineAi'));
      await expect.poll(() => worker.evaluate(() => self.__dictWanted)).toEqual([DictPack.pairOf('ja', 'zh-CN')]);
      await listedAt(context, DictPack.pairOf('ja', 'zh-CN'), PACK_VER);
    } finally {
      await mock.close();
    }
  });

  test('J-B2.9/J-B2.10: explaining a word the pack proved asks for an entry; a new sentence is text again', async ({ page, context }) => {
    const mock = await setUp(page, context, { url: `${ORIGIN}/ja` });
    try {
      // J-B2.3 again: 食べました is answered by the pack.
      let card = await openCardOn(page, '#tabemashita');
      let parts = cardPart(card);
      await expect(parts.tag).toHaveText(zh('cardEngineDict'));
      await expect(parts.text).toHaveText('吃');
      await expect(parts.switchBtn).toHaveText(zh('cardUseAiExplain'));
      expect(mock.sentTexts).toEqual([]);

      // J-B2.9 — the model is asked for a dictionary entry of the word, with
      // its sentence and not the next one.
      const lead = await pageText(page, '#lead');
      const sentence = lead.slice(0, lead.indexOf('。') + 1);
      const next = lead.slice(sentence.length).trim();
      expect(next.length).toBeGreaterThan(0);
      await parts.switchBtn.click();
      await expect.poll(() => mock.sentTexts).toEqual(['食べました']);
      expect(mock.systemPrompts[0]).toContain(globalThis.DictEntry.PROMPT_MARK);
      expect(pageContextIn(mock.systemPrompts[0])).toEqual({ title: '朝ごはん', before: sentence });
      expect(mock.systemPrompts[0]).not.toContain(next);
      await expect(parts.text).toHaveText('[AI] 吃');
      await expect(parts.entry.locator('.ai-translator-dict-pos')).toHaveText(['v.']);
      await expect(parts.entry.locator('.ai-translator-dict-defs')).toHaveText(['[AI] 吃（过去式）']);
      await expect(parts.tag).toHaveText(zh('cardEngineAi'));
      // The title names the engine that answered (CARD_TITLE in content-popup.js).
      await expect(parts.title).toHaveText(zh('aiTranslate'));
      await expect(parts.credits).toHaveCount(0);
      await card.screenshot({ path: shotPath('j-b2-9-card-explain-ja.png') });
      await evaluateInContentScript(context, page, 'window.AI_TRANSLATOR_CONTENT.hideTranslationPopup()');
      await page.evaluate(() => window.getSelection().removeAllRanges());

      // J-B2.10 — a sentence on the same page: translated as text, no entry,
      // no page context.
      card = await openCardOn(page, '#tail');
      parts = cardPart(card);
      const tail = await pageText(page, '#tail');
      await expect.poll(() => mock.sentTexts).toEqual(['食べました', tail]);
      expect(mock.systemPrompts[1]).not.toContain(globalThis.DictEntry.PROMPT_MARK);
      expect(pageContextIn(mock.systemPrompts[1])).toBeNull();
      await expect(parts.tag).toHaveText(zh('cardEngineAi'));
      await expect(parts.text).toHaveText(`[T] ${tail}`);
      await expect(parts.entry).toBeHidden();
      await card.screenshot({ path: shotPath('j-b2-10-card-sentence.png') });
    } finally {
      await mock.close();
    }
  });

  test('J-B2.4/J-B2.6: a word the pack lacks, and any word with the switch off, go to the engine as before', async ({ page, context }) => {
    const mock = await setUp(page, context);
    try {
      // Count the lookups' pack reads (every one asks for DictPack.PACKS_KEY).
      await evaluateInContentScript(context, page, `(() => {
        const area = chrome.storage.local;
        const get = area.get.bind(area);
        self.__packReads = 0;
        area.get = (keys, ...rest) => {
          if ([].concat(keys || []).includes(DictPack.PACKS_KEY)) self.__packReads++;
          return get(keys, ...rest);
        };
        return true;
      })()`);
      const packReads = () => evaluateInContentScript(context, page, 'self.__packReads');

      // J-B2.4 — not in the pack: today's path, nothing said about the pack.
      let card = await openCardOn(page, '#zebra');
      let parts = cardPart(card);
      await expect.poll(() => mock.sentTexts).toEqual(['zebra']);
      expect(await packReads(), 'a word is looked up in the pack first').toBe(1);
      expect(mock.systemPrompts[0]).toContain(globalThis.DictEntry.PROMPT_MARK);
      await expect(parts.text).toHaveText('[T] zebra');
      await expect(parts.title).toHaveText(zh('aiTranslate'));
      await expect(parts.tag).toHaveText(zh('cardEngineAi'));
      await expect(parts.credits).toHaveCount(0);
      await expect(card).not.toContainText('词典');
      await card.screenshot({ path: shotPath('j-b2-4-card-miss.png') });
      await evaluateInContentScript(context, page, 'window.AI_TRANSLATOR_CONTENT.hideTranslationPopup()');

      // A sentence is not a word: it is translated as today and never costs a
      // pack read (DictEntry.isDictCandidate, the word condition of the rule).
      await page.evaluate(() => window.getSelection().removeAllRanges());
      card = await openCardOn(page, '#lead');
      await expect.poll(() => mock.sentTexts.length).toBe(2);
      expect(mock.sentTexts[1]).toContain('Yesterday I ran along the river');
      expect(mock.systemPrompts[1]).not.toContain(globalThis.DictEntry.PROMPT_MARK);
      await expect(cardPart(card).tag).toHaveText(zh('cardEngineAi'));
      expect(await packReads(), 'a sentence never reads the pack').toBe(1);
      await evaluateInContentScript(context, page, 'window.AI_TRANSLATOR_CONTENT.hideTranslationPopup()');
      await page.evaluate(() => window.getSelection().removeAllRanges());

      // J-B2.6 — the switch off: `ran` is in the pack, and goes to the model anyway.
      await writeSyncSettings(context, { offlineDictionary: false });
      await expect.poll(() => evaluateInContentScript(context, page,
        'window.AI_TRANSLATOR_CONTENT.settings.offlineDictionary')).toBe(false);
      card = await openCardOn(page, '#ran');
      parts = cardPart(card);
      await expect.poll(() => mock.sentTexts.length).toBe(3);
      expect(mock.sentTexts[2]).toBe('ran');
      expect(await packReads(), 'the switch off reads no pack').toBe(1);
      await expect(parts.text).toHaveText('[AI] 跑');
      await expect(parts.title).toHaveText(zh('aiTranslate'));
      await expect(parts.tag).toHaveText(zh('cardEngineAi'));
      await expect(parts.credits).toHaveCount(0);
      await card.screenshot({ path: shotPath('j-b2-6-card-switch-off.png') });
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
        await expectEntryHolds(page, cardPart(card).credits, '.ai-translator-popup .ai-translator-dict-entry', `${theme} card`);
        await card.screenshot({ path: shotPath(`j-b2-7-card-${theme}-hostile.png`) });
        await evaluateInContentScript(context, page, 'window.AI_TRANSLATOR_CONTENT.hideTranslationPopup()');

        await openInputDialog(page);
        await translateInput(page, 'ran');
        const dialogLine = page.locator('#ai-translator-input-dict .ai-translator-dict-credits');
        await expect(dialogLine.locator('a')).toHaveText(['Tatoeba']);
        await expectEntryHolds(page, dialogLine, '#ai-translator-input-dict', `${theme} input box`);
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
