// Batch C journeys C1–C3: a word looked up in the input box or the selection
// card shows a dictionary entry (phonetics with speakers, senses, examples,
// word forms) under the translation — from the AI engine only (D-469/D-470).
//
// The entry is drawn by one function, DictEntry.render (shared/dict-entry.js),
// for both surfaces; these journeys assert what reaches the DOM and what the
// speaker buttons hand to speechSynthesis.
//
// Pages are served on an https origin: the built-in engine is a SecureContext
// API. Chromium in the e2e run has no on-device model and no voices, so the
// built-in engine is a stub answering '[B] <text>' and speechSynthesis is a
// stub (in the content script's world) that records every utterance.
const { test, expect } = require('./fixtures');
const {
  setExtensionSettings,
  openFloatBallMenu,
  evaluateInContentScript,
  stubBuiltinTranslator,
  waitForFloatBall,
  HOSTILE_ENTRY_CSS,
} = require('./helpers');
const { startMockOpenAIServer } = require('./mock-openai-server');
const { getMessage } = require('../../i18n/messages');
require('../../shared/dict-entry.js');

const ORIGIN = 'https://dictionary.test';
const zh = (key) => getMessage(key, 'zh-CN');
const en = (key) => getMessage(key, 'en');

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Morning notes</title>
<style>body { margin: 0; padding: 40px 60px; font: 18px/28px Georgia, serif; color: #222; background: #fff; }
p { width: 640px; }</style></head>
<body>
  <p id="lead">Every day I <span id="word">run</span> along the river before the town wakes up.</p>
  <p id="tail">I will never <span id="phrase">give up</span> the morning.</p>
</body></html>`;

// What the model answers for a lookup of `run`. One definition carries markup,
// which must arrive as text: model strings go through textContent only.
const RUN_ENTRY = {
  translation: '跑',
  phonetics: [{ label: 'UK', ipa: '/rʌn/' }, { label: 'US', ipa: '/rʌn/' }],
  senses: [
    { pos: 'v.', defs: ['跑', '奔跑'] },
    { pos: 'n.', defs: ['跑步', '<img src=x onerror="window.__pwned=1">'] },
  ],
  examples: [{ source: 'I run every morning.', target: '我每天早上跑步。' }],
  forms: [
    { label: '过去式', value: 'ran' },
    { label: '过去分词', value: 'run' },
    { label: '现在分词', value: 'running' },
  ],
};

// A two-word phrase is a lookup too (D-473): 1–3 words, no sentence punctuation.
const GIVE_UP_ENTRY = {
  translation: '放弃',
  senses: [{ pos: 'phr. v.', defs: ['放弃', '戒掉'] }],
  examples: [{ source: 'Never give up.', target: '永不放弃。' }],
};

function dictEntry(text) {
  if (text === 'run') return RUN_ENTRY;
  if (text === 'give up') return GIVE_UP_ENTRY;
  return { translation: `[T] ${text}` };
}

// The page, optionally with a hostile stylesheet in its head.
async function servePage(context, css = '') {
  const body = css ? PAGE.replace('</head>', `<style>${css}</style></head>`) : PAGE;
  await context.route(`${ORIGIN}/**`, (route) => {
    route.fulfill({ status: 200, contentType: 'text/html', body });
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
    ...extra,
  };
}

// speechSynthesis in the content script's world: an en-GB and an en-US voice,
// and speak() records what it was asked to say and in which language.
async function stubSpeech(page) {
  await evaluateInContentScript(page.context(), page, `(() => {
    self.__spoken = [];
    const voices = [
      { lang: 'en-GB', name: 'Daniel', voiceURI: 'Daniel', localService: true, default: false },
      { lang: 'en-US', name: 'Samantha', voiceURI: 'Samantha', localService: true, default: true },
    ];
    // A plain utterance: the real one refuses a voice that is not a
    // SpeechSynthesisVoice, and these stub voices are not.
    window.SpeechSynthesisUtterance = class {
      constructor(text) { this.text = text; this.lang = ''; this.voice = null; }
    };
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
      getVoices: () => voices,
      addEventListener() {},
      cancel() {},
      speak(utterance) {
        self.__spoken.push({ text: utterance.text, lang: utterance.lang });
        setTimeout(() => utterance.onend && utterance.onend(), 0);
      },
    } });
  })()`);
}

const spoken = (page) => evaluateInContentScript(page.context(), page, 'self.__spoken');

async function openInputDialog(page) {
  await openFloatBallMenu(page);
  await page.click('.ai-translator-menu-item[data-action="translate-input"]');
  await page.waitForSelector('#ai-translator-input-dialog', { state: 'visible' });
}

async function lookUp(page, text) {
  await page.fill('#ai-translator-input-text', text);
  await page.click('#ai-translator-do-translate');
}

async function closeInputDialog(page) {
  await page.locator('#ai-translator-input-dialog .ai-translator-input-overlay').click({ position: { x: 5, y: 5 } });
  await expect(page.locator('#ai-translator-input-dialog')).toHaveCount(0);
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

// The blocks of a fully drawn `run` entry, under `root`.
async function expectRunEntry(page, root) {
  const entry = root.locator('.ai-translator-dict-entry');
  await expect(entry).toBeVisible();

  const phonetics = entry.locator('.ai-translator-dict-phonetic');
  await expect(phonetics).toHaveCount(2);
  await expect(phonetics.nth(0).locator('.ai-translator-dict-accent')).toHaveText(zh('dictUK'));
  await expect(phonetics.nth(0).locator('.ai-translator-dict-ipa')).toHaveText('/rʌn/');
  await expect(phonetics.nth(1).locator('.ai-translator-dict-accent')).toHaveText(zh('dictUS'));
  await expect(phonetics.nth(1).locator('.ai-translator-dict-ipa')).toHaveText('/rʌn/');

  const senses = entry.locator('.ai-translator-dict-sense');
  await expect(senses).toHaveCount(2);
  await expect(senses.nth(0).locator('.ai-translator-dict-pos')).toHaveText('v.');
  await expect(senses.nth(0).locator('.ai-translator-dict-defs')).toHaveText('跑; 奔跑');
  await expect(senses.nth(1).locator('.ai-translator-dict-pos')).toHaveText('n.');
  await expect(senses.nth(1).locator('.ai-translator-dict-defs'))
    .toHaveText('跑步; <img src=x onerror="window.__pwned=1">');
  await expect(entry.locator('img')).toHaveCount(0);

  await expect(entry.locator('.ai-translator-dict-examples .ai-translator-dict-heading')).toHaveText(zh('dictExamples'));
  await expect(entry.locator('.ai-translator-dict-example-source')).toHaveText('I run every morning.');
  await expect(entry.locator('.ai-translator-dict-example-target')).toHaveText('我每天早上跑步。');

  await expect(entry.locator('.ai-translator-dict-forms .ai-translator-dict-heading')).toHaveText(zh('dictForms'));
  await expect(entry.locator('.ai-translator-dict-form-value')).toHaveText(['ran', 'run', 'running']);
  await expect(entry.locator('.ai-translator-dict-form-label')).toHaveText(['过去式', '过去分词', '现在分词']);
  expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
}

// Both speakers: UK reads the word in en-GB, US in en-US.
async function expectAccentSpeakers(page, root) {
  const speak = (accent) => root.locator(`.ai-translator-dict-speak[data-accent="${accent}"]`);
  await speak('US').click();
  await expect.poll(() => spoken(page)).toEqual([{ text: 'run', lang: 'en-US' }]);
  await speak('UK').click();
  await expect.poll(() => spoken(page)).toEqual([
    { text: 'run', lang: 'en-US' },
    { text: 'run', lang: 'en-GB' },
  ]);
}

const shotDir = process.env.DICT_SCREENSHOT_DIR;

// What each element of the entry computes to, whatever the page says about
// bare spans and divs. A flex item's display is blockified, so the spans in a
// flex row compute to block (or flex for an inline-flex one).
const PRIMARY = 'var(--text-primary)';
const SECONDARY = 'var(--text-secondary)';
const ENTRY_STYLES = [
  ['.ai-translator-dict-section', 'flex', '0px', '13px', PRIMARY],
  ['.ai-translator-dict-heading', 'block', '0px', '11px', SECONDARY],
  ['.ai-translator-dict-phonetic', 'flex', '0px', '13px', PRIMARY],
  ['.ai-translator-dict-accent', 'block', '0px', '12px', SECONDARY],
  ['.ai-translator-dict-ipa', 'block', '0px', '14px', SECONDARY],
  ['.ai-translator-dict-sense', 'flex', '0px', '13px', PRIMARY],
  ['.ai-translator-dict-pos', 'block', '0px', '13px', 'var(--dict-pos)'],
  ['.ai-translator-dict-defs', 'block', '0px', '13px', PRIMARY],
  ['.ai-translator-dict-example', 'block', '0px 0px 0px 8px', '13px', PRIMARY],
  ['.ai-translator-dict-example-source', 'block', '0px', '13px', PRIMARY],
  ['.ai-translator-dict-example-target', 'block', '0px', '13px', SECONDARY],
  ['.ai-translator-dict-form', 'flex', '0px', '13px', PRIMARY],
  ['.ai-translator-dict-form-label', 'block', '0px', '13px', SECONDARY],
  ['.ai-translator-dict-form-value', 'block', '0px', '13px', PRIMARY],
];

// The computed display, padding, font-size and colour of every element above,
// with the colour each should have: its token, resolved on a probe inside the
// entry (an inline style, which no page rule outweighs).
function entryStyles(page, entrySelector) {
  return page.evaluate(({ entrySelector, rows }) => {
    const entry = document.querySelector(entrySelector);
    const probe = document.createElement('i');
    entry.appendChild(probe);
    const out = rows.map(([selector, , , , token]) => {
      const el = entry.querySelector(selector);
      const style = getComputedStyle(el);
      probe.style.color = token;
      return [selector, style.display, style.padding, style.fontSize, style.color, getComputedStyle(probe).color];
    });
    probe.remove();
    return out;
  }, { entrySelector, rows: ENTRY_STYLES });
}

async function expectEntryStyles(page, entrySelector) {
  const measured = await entryStyles(page, entrySelector);
  for (const [i, [selector, display, padding, fontSize]] of ENTRY_STYLES.entries()) {
    const [, gotDisplay, gotPadding, gotSize, color, tokenColor] = measured[i];
    expect({ selector, display: gotDisplay, padding: gotPadding, fontSize: gotSize, color })
      .toEqual({ selector, display, padding, fontSize, color: tokenColor });
    expect(color, selector).not.toBe('rgb(255, 0, 0)');
  }
}

// WCAG contrast of the entry's small secondary text against what is under it:
// the backgrounds of its ancestors, composited down to the first opaque one.
const CONTRAST_SELECTORS = [
  '.ai-translator-dict-heading',
  '.ai-translator-dict-form-label',
  '.ai-translator-dict-pos',
  '.ai-translator-dict-accent',
  '.ai-translator-dict-ipa',
  '.ai-translator-dict-example-target',
];

function contrastRatios(page, entrySelector) {
  return page.evaluate(({ entrySelector, selectors }) => {
    const parse = (value) => {
      const m = value.match(/rgba?\(([^)]+)\)/);
      const [r, g, b, a = 1] = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
      return { r, g, b, a };
    };
    const over = (top, bottom) => ({
      r: top.r * top.a + bottom.r * (1 - top.a),
      g: top.g * top.a + bottom.g * (1 - top.a),
      b: top.b * top.a + bottom.b * (1 - top.a),
      a: 1,
    });
    const background = (el) => {
      const layers = [];
      for (let node = el; node; node = node.parentElement) {
        const layer = parse(getComputedStyle(node).backgroundColor);
        if (layer.a === 0) continue;
        layers.push(layer);
        if (layer.a === 1) break;
      }
      let base = layers.length && layers.at(-1).a === 1 ? layers.pop() : { r: 255, g: 255, b: 255, a: 1 };
      while (layers.length) base = over(layers.pop(), base);
      return base;
    };
    const luminance = ({ r, g, b }) => {
      const lin = (c) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
      return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    };
    const entry = document.querySelector(entrySelector);
    return selectors.map((selector) => {
      const el = entry.querySelector(selector);
      const bg = background(el);
      const fg = over(parse(getComputedStyle(el).color), bg);
      const [hi, lo] = [luminance(fg), luminance(bg)].sort((x, y) => y - x);
      return [selector, Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100];
    });
  }, { entrySelector, selectors: CONTRAST_SELECTORS });
}

async function expectReadableContrast(page, entrySelector, label) {
  for (const [selector, ratio] of await contrastRatios(page, entrySelector)) {
    expect(ratio, `${label} ${selector}`).toBeGreaterThanOrEqual(4.5);
  }
}

test.describe('dictionary entry (batch C)', () => {
  test('C1: the input box looks a word up, and a sentence is only translated', async ({ page, context }) => {
    const mock = await startMockOpenAIServer({ dictEntry });
    try {
      await servePage(context);
      await setExtensionSettings(page, settings(mock.endpoint, { uiLanguage: 'zh-CN' }));
      await page.goto(`${ORIGIN}/`);
      await waitForFloatBall(page);
      await stubSpeech(page);
      await openInputDialog(page);

      await lookUp(page, 'run');
      await expect(page.locator('#ai-translator-result-text')).toHaveText('跑');
      const dialog = page.locator('#ai-translator-input-dialog');
      await expectRunEntry(page, dialog);
      expect(mock.systemPrompts.at(-1)).toContain(globalThis.DictEntry.PROMPT_MARK);
      if (shotDir) {
        await page.waitForTimeout(300);
        await page.locator('.ai-translator-input-modal').screenshot({ path: `${shotDir}/c1-input-light.png` });
        // The body scrolls; a second shot shows the examples and the forms.
        await dialog.locator('.ai-translator-dict-forms').scrollIntoViewIfNeeded();
        await page.locator('.ai-translator-input-modal').screenshot({ path: `${shotDir}/c1-input-light-forms.png` });
      }
      await expectAccentSpeakers(page, dialog);

      // A sentence is translated, not looked up: the plain prompt, no entry.
      await lookUp(page, 'I run every morning.');
      await expect(page.locator('#ai-translator-result-text')).toHaveText('[T] I run every morning.');
      await expect(page.locator('#ai-translator-input-dict')).toBeHidden();
      await expect(dialog.locator('.ai-translator-dict-section')).toHaveCount(0);
      expect(mock.systemPrompts.at(-1)).not.toContain(globalThis.DictEntry.PROMPT_MARK);

      // A translation-only entry draws no empty blocks.
      await lookUp(page, 'harbour');
      await expect(page.locator('#ai-translator-result-text')).toHaveText('[T] harbour');
      expect(mock.systemPrompts.at(-1)).toContain(globalThis.DictEntry.PROMPT_MARK);
      await expect(page.locator('#ai-translator-input-dict')).toBeHidden();
      await expect(dialog.locator('.ai-translator-dict-section')).toHaveCount(0);
    } finally {
      await mock.close();
    }
  });

  test('C2: the selection card shows the same entry, and the built-in engine shows none', async ({ page, context }) => {
    const mock = await startMockOpenAIServer({ dictEntry });
    try {
      await servePage(context);
      await setExtensionSettings(page, settings(mock.endpoint, { uiLanguage: 'zh-CN' }));
      await page.goto(`${ORIGIN}/`);
      await waitForFloatBall(page);
      await stubBuiltinTranslator(page);
      await stubSpeech(page);

      await page.dblclick('#word');
      const icon = page.locator('#ai-translator-selection-btn .ai-translator-selection-icon');
      await expect(icon).toBeVisible();
      await icon.click();

      const card = page.locator('.ai-translator-popup');
      await expect(card.locator('.ai-translator-translation-text')).toHaveText('跑');
      await expectRunEntry(page, card);
      if (shotDir) {
        await page.waitForTimeout(400);
        await card.screenshot({ path: `${shotDir}/c2-card-light.png` });
        await card.locator('.ai-translator-dict-forms').scrollIntoViewIfNeeded();
        await card.screenshot({ path: `${shotDir}/c2-card-light-forms.png` });
      }
      await expectAccentSpeakers(page, card);

      // Switch to the built-in engine: a translation and nothing else.
      const switchBtn = card.locator('.ai-translator-switch-engine');
      await expect(switchBtn).toHaveText(zh('cardUseBuiltin'));
      await switchBtn.click();
      await expect(card.locator('.ai-translator-translation-text')).toHaveText('[B] run');
      await expect(card.locator('.ai-translator-dict-entry')).toBeHidden();
      await expect(card.locator('.ai-translator-dict-section')).toHaveCount(0);

      // And back: the entry is drawn again.
      await switchBtn.click();
      await expect(card.locator('.ai-translator-translation-text')).toHaveText('跑');
      await expect(card.locator('.ai-translator-dict-phonetic')).toHaveCount(2);
    } finally {
      await mock.close();
    }
  });

  test('C3: with the built-in engine as the manual engine, a word is only translated', async ({ page, context }) => {
    const mock = await startMockOpenAIServer({ dictEntry });
    try {
      await servePage(context);
      await setExtensionSettings(page, settings(mock.endpoint, { translationEngine: 'builtin' }));
      await page.goto(`${ORIGIN}/`);
      await waitForFloatBall(page);
      await stubBuiltinTranslator(page);

      await openInputDialog(page);
      await lookUp(page, 'run');
      await expect(page.locator('#ai-translator-result-text')).toHaveText('[B] run');
      await expect(page.locator('#ai-translator-input-dict')).toBeHidden();
      await expect(page.locator('#ai-translator-input-dialog .ai-translator-dict-section')).toHaveCount(0);
      await expect(page.locator('#ai-translator-input-dialog .ai-translator-input-error')).toHaveCount(0);
      await page.locator('#ai-translator-input-dialog .ai-translator-input-overlay').click({ position: { x: 5, y: 5 } });
      await expect(page.locator('#ai-translator-input-dialog')).toHaveCount(0);

      await page.dblclick('#word');
      const icon = page.locator('#ai-translator-selection-btn .ai-translator-selection-icon');
      await expect(icon).toBeVisible();
      await icon.click();
      const card = page.locator('.ai-translator-popup');
      await expect(card.locator('.ai-translator-translation-text')).toHaveText('[B] run');
      await expect(card.locator('.ai-translator-engine-tag')).toHaveText(en('cardEngineBuiltin'));
      await expect(card.locator('.ai-translator-dict-entry')).toBeHidden();
      await expect(card.locator('.ai-translator-dict-section')).toHaveCount(0);
      await expect(card.locator('.ai-translator-error')).toBeHidden();
      expect(mock.sentTexts).toEqual([]);
    } finally {
      await mock.close();
    }
  });

  test('C4: a two-word phrase is looked up in the input box and in the card (D-473)', async ({ page, context }) => {
    const mock = await startMockOpenAIServer({ dictEntry });
    try {
      await servePage(context);
      await setExtensionSettings(page, settings(mock.endpoint, { uiLanguage: 'zh-CN' }));
      await page.goto(`${ORIGIN}/`);
      await waitForFloatBall(page);

      await openInputDialog(page);
      await lookUp(page, 'give up');
      await expect(page.locator('#ai-translator-result-text')).toHaveText('放弃');
      expect(mock.systemPrompts.at(-1)).toContain(globalThis.DictEntry.PROMPT_MARK);
      const dialog = page.locator('#ai-translator-input-dialog');
      await expect(dialog.locator('.ai-translator-dict-pos')).toHaveText('phr. v.');
      await expect(dialog.locator('.ai-translator-dict-defs')).toHaveText('放弃; 戒掉');
      await expect(dialog.locator('.ai-translator-dict-example-source')).toHaveText('Never give up.');
      await closeInputDialog(page);

      const card = await openCardOn(page, '#phrase');
      await expect(card.locator('.ai-translator-translation-text')).toHaveText('放弃');
      expect(mock.systemPrompts.at(-1)).toContain(globalThis.DictEntry.PROMPT_MARK);
      await expect(card.locator('.ai-translator-dict-pos')).toHaveText('phr. v.');
      await expect(card.locator('.ai-translator-dict-defs')).toHaveText('放弃; 戒掉');
      await expect(card.locator('.ai-translator-dict-example-target')).toHaveText('永不放弃。');
    } finally {
      await mock.close();
    }
  });

  test('C5: an answer that is not an entry shows the error and clears the last entry, in both surfaces', async ({ page, context }) => {
    let broken = false;
    const mock = await startMockOpenAIServer({ dictEntry: (text) => (broken ? 'not json' : dictEntry(text)) });
    try {
      await servePage(context);
      await setExtensionSettings(page, settings(mock.endpoint, { uiLanguage: 'zh-CN' }));
      await page.goto(`${ORIGIN}/`);
      await waitForFloatBall(page);

      await openInputDialog(page);
      const dialog = page.locator('#ai-translator-input-dialog');
      await lookUp(page, 'run');
      await expect(dialog.locator('.ai-translator-dict-sense')).toHaveCount(2);
      broken = true;
      await lookUp(page, 'run');
      await expect(page.locator('#ai-translator-result-text .ai-translator-input-error')).toHaveText(zh('dictEntryUnreadable'));
      await expect(page.locator('#ai-translator-input-dict')).toBeHidden();
      await expect(dialog.locator('.ai-translator-dict-section')).toHaveCount(0);
      await closeInputDialog(page);

      broken = false;
      const card = await openCardOn(page, '#word');
      await expect(card.locator('.ai-translator-dict-sense')).toHaveCount(2);
      broken = true;
      const retranslate = card.locator('.ai-translator-retranslate');
      await expect(retranslate).toBeEnabled();
      await retranslate.click();
      await expect(card.locator('.ai-translator-error')).toHaveText(zh('dictEntryUnreadable'));
      await expect(card.locator('.ai-translator-dict-entry')).toBeHidden();
      await expect(card.locator('.ai-translator-dict-section')).toHaveCount(0);
    } finally {
      await mock.close();
    }
  });

  test('C6: the input box and the card draw the same reply into the same markup', async ({ page, context }) => {
    const mock = await startMockOpenAIServer({ dictEntry });
    try {
      await servePage(context);
      await setExtensionSettings(page, settings(mock.endpoint, { uiLanguage: 'zh-CN' }));
      await page.goto(`${ORIGIN}/`);
      await waitForFloatBall(page);
      await stubSpeech(page);

      await openInputDialog(page);
      await lookUp(page, 'run');
      await expectRunEntry(page, page.locator('#ai-translator-input-dialog'));
      const fromDialog = await page.locator('#ai-translator-input-dict').innerHTML();
      await closeInputDialog(page);

      const card = await openCardOn(page, '#word');
      await expectRunEntry(page, card);
      const fromCard = await card.locator('.ai-translator-dict-entry').innerHTML();
      expect(fromCard).toBe(fromDialog);
      expect(fromCard).toContain('ai-translator-dict-forms');
    } finally {
      await mock.close();
    }
  });

  test('C7: a page\'s bare-tag rules cannot restyle the entry, in the input box or the card', async ({ page, context }) => {
    const mock = await startMockOpenAIServer({ dictEntry });
    try {
      await servePage(context, HOSTILE_ENTRY_CSS);
      await setExtensionSettings(page, settings(mock.endpoint, { uiLanguage: 'zh-CN' }));
      await page.goto(`${ORIGIN}/`);
      await waitForFloatBall(page);

      // The rules are live on the page's own spans and divs.
      expect(await page.evaluate(() => {
        const style = getComputedStyle(document.querySelector('#word'));
        return [style.color, style.fontSize, style.display];
      })).toEqual(['rgb(255, 0, 0)', '30px', 'block']);

      await openInputDialog(page);
      await lookUp(page, 'run');
      await expectRunEntry(page, page.locator('#ai-translator-input-dialog'));
      await expectEntryStyles(page, '#ai-translator-input-dict');
      await closeInputDialog(page);

      const card = await openCardOn(page, '#word');
      await expectRunEntry(page, card);
      await expectEntryStyles(page, '.ai-translator-popup .ai-translator-dict-entry');
    } finally {
      await mock.close();
    }
  });

  for (const theme of ['light', 'dark']) {
    test(`C8: the entry's small text reads at 4.5:1 or better in the ${theme} theme`, async ({ page, context }) => {
      const mock = await startMockOpenAIServer({ dictEntry });
      try {
        await servePage(context);
        await setExtensionSettings(page, settings(mock.endpoint, { uiLanguage: 'zh-CN', theme }));
        await page.goto(`${ORIGIN}/`);
        await waitForFloatBall(page);
        await expect(page.locator('html')).toHaveAttribute('data-ai-translator-theme', theme);

        await openInputDialog(page);
        await lookUp(page, 'run');
        await expectRunEntry(page, page.locator('#ai-translator-input-dialog'));
        await expectReadableContrast(page, '#ai-translator-input-dict', `${theme} input box`);
        await closeInputDialog(page);

        const card = await openCardOn(page, '#word');
        await expectRunEntry(page, card);
        await expectReadableContrast(page, '.ai-translator-popup .ai-translator-dict-entry', `${theme} card`);
      } finally {
        await mock.close();
      }
    });
  }
});
