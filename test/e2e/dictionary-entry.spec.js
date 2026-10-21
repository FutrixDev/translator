// Batch C journeys C1–C3: a word looked up in the input box or the selection
// card shows a dictionary entry (phonetics with speakers, senses, examples,
// word forms) under the translation — from a model engine (D-469/D-470) or the
// offline dictionary (D-561), never the built-in engine.
// C9: a short formula is translated, not looked up (D-474).
// C10: an offline dictionary answer draws its credits as links (D-561).
// J1–J3: the phonetics are the translation's, in the target language, and
// their speakers read the translation (D-487); the source text keeps its own
// speaker on each surface.
// J4–J6: which entry a model writes for a word follows what is proven about
// its language. Proven the target's (a script that pins it): the monolingual
// prompt. Proven another (a script the target is not written in): the
// bilingual prompt. Neither (a short Latin word, English or not, under an
// English target): one prompt that lets the model decide, and the entry is
// drawn as the model says it wrote it: monolingual (a gloss, the word's own
// IPA read aloud as the word, examples with no translation row) or bilingual.
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
  openInputDialog,
  pickInputTargetLang,
  translateInput,
  closeInputDialog,
  evaluateInContentScript,
  stubBuiltinTranslator,
  waitForFloatBall,
} = require('./helpers');
const { HOSTILE_ENTRY_CSS } = require('./hostile-css');
const {
  ACCENT_STYLES,
  MODEL_CONTRAST_SELECTORS,
  MODEL_ENTRY_STYLES,
  ORIGIN,
  en,
  expectEntryStyles,
  expectReadableContrast,
  openCardOn,
  servePages,
  settings,
  zh,
} = require('./dict-entry-checks');
const { startMockOpenAIServer } = require('./mock-openai-server');
require('../../shared/dict-entry.js');


const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Morning notes</title>
<style>body { margin: 0; padding: 40px 60px; font: 18px/28px Georgia, serif; color: #222; background: #fff; }
p { width: 640px; }</style></head>
<body>
  <p id="lead">Every day I <span id="word">run</span> along the river before the town wakes up.</p>
  <p id="tail">I will never <span id="phrase">give up</span> the morning.</p>
  <p id="loan">It was pure <span id="loanword">Schadenfreude</span>, and he knew it.</p>
</body></html>`;

// What the model answers for a lookup of `run` into zh-CN. The phonetics are
// the translation's: one pinyin row, no UK/US label (D-487). One definition
// carries markup, which must arrive as text: model strings go through
// textContent only.
const RUN_ENTRY = {
  translation: '跑',
  phonetics: [{ label: '', ipa: 'pǎo' }],
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

// `猫` looked up into English: the translation's two IPA rows, UK and US.
const CAT_ENTRY = {
  translation: 'cat',
  phonetics: [{ label: 'UK', ipa: '/kæt/' }, { label: 'US', ipa: '/kæt/' }],
};

function dictEntry(text) {
  if (text === 'run') return RUN_ENTRY;
  if (text === 'give up') return GIVE_UP_ENTRY;
  if (text === '猫') return CAT_ENTRY;
  return { translation: `[T] ${text}` };
}

// The page, optionally with a hostile stylesheet in its head.
const servePage = (context, css = '') => servePages(context, { '/': PAGE }, css);

// speechSynthesis in the content script's world: an en-GB, an en-US and a
// zh-CN voice, and speak() records what it was asked to say and in which
// language. self.__asked records each speech call as our code makes it (the
// text and the language it declares) before any script or voice matching:
// for Han text the matching settles on zh-CN whatever was declared, so only
// the declared language shows which language a speaker asked for.
async function stubSpeech(page) {
  await evaluateInContentScript(page.context(), page, `(() => {
    self.__spoken = [];
    self.__asked = [];
    const resolveSpokenLang = SpeechLang.resolveSpokenLang;
    SpeechLang.resolveSpokenLang = (text, declared, detect) => {
      self.__asked.push({ text, lang: declared });
      return resolveSpokenLang(text, declared, detect);
    };
    const voices = [
      { lang: 'en-GB', name: 'Daniel', voiceURI: 'Daniel', localService: true, default: false },
      { lang: 'en-US', name: 'Samantha', voiceURI: 'Samantha', localService: true, default: true },
      { lang: 'zh-CN', name: 'Tingting', voiceURI: 'Tingting', localService: true, default: false },
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
const asked = (page) => evaluateInContentScript(page.context(), page, 'self.__asked');

// The blocks of a fully drawn `run` entry, under `root`.
async function expectRunEntry(page, root) {
  const entry = root.locator('.ai-translator-dict-entry');
  await expect(entry).toBeVisible();

  // The translation's pinyin, one row, no UK/US label.
  const phonetics = entry.locator('.ai-translator-dict-phonetic');
  await expect(phonetics).toHaveCount(1);
  await expect(phonetics.locator('.ai-translator-dict-ipa')).toHaveText('pǎo');
  await expect(entry.locator('.ai-translator-dict-accent')).toHaveCount(0);
  await expect(phonetics).not.toContainText(zh('dictUK'));
  await expect(phonetics).not.toContainText(zh('dictUS'));

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

// The `run` entry's one speaker reads the translation, 跑, in zh-CN — not the
// looked-up `run` (D-487).
async function expectTranslationSpeaker(page, root) {
  const speak = root.locator('.ai-translator-dict-speak');
  await expect(speak).toHaveCount(1);
  await expect(speak).toHaveAttribute('aria-label', zh('pronounceTranslation'));
  await speak.click();
  await expect.poll(() => asked(page)).toEqual([{ text: '跑', lang: 'zh-CN' }]);
  await expect.poll(() => spoken(page)).toEqual([{ text: '跑', lang: 'zh-CN' }]);
}

const shotDir = process.env.DICT_SCREENSHOT_DIR;

test.describe('dictionary entry (batch C)', () => {
  test('C1: the input box looks a word up, and a sentence is only translated', async ({ page, context }) => {
    const mock = await startMockOpenAIServer({ dictEntry });
    try {
      await servePage(context);
      await setExtensionSettings(page, settings(mock.endpoint, { uiLanguage: 'zh-CN' }));
      await page.goto(`${ORIGIN}/`);
      await waitForFloatBall(page);
      await openInputDialog(page);

      await translateInput(page, 'run');
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

      // A sentence is translated, not looked up: the plain prompt, no entry.
      await translateInput(page, 'I run every morning.');
      await expect(page.locator('#ai-translator-result-text')).toHaveText('[T] I run every morning.');
      await expect(page.locator('#ai-translator-input-dict')).toBeHidden();
      await expect(dialog.locator('.ai-translator-dict-section')).toHaveCount(0);
      expect(mock.systemPrompts.at(-1)).not.toContain(globalThis.DictEntry.PROMPT_MARK);

      // A translation-only entry draws no empty blocks.
      await translateInput(page, 'harbour');
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
      await expect(card.locator('.ai-translator-dict-phonetic')).toHaveCount(1);
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
      await translateInput(page, 'run');
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
      await translateInput(page, 'give up');
      await expect(page.locator('#ai-translator-result-text')).toHaveText('放弃');
      expect(mock.systemPrompts.at(-1)).toContain(globalThis.DictEntry.PROMPT_MARK);
      const dialog = page.locator('#ai-translator-input-dialog');
      await expect(dialog.locator('.ai-translator-dict-pos')).toHaveText('phr. v.');
      await expect(dialog.locator('.ai-translator-dict-defs')).toHaveText('放弃; 戒掉');
      await expect(dialog.locator('.ai-translator-dict-example-source')).toHaveText('Never give up.');
      await closeInputDialog(page, { via: 'overlay' });

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
      await translateInput(page, 'run');
      await expect(dialog.locator('.ai-translator-dict-sense')).toHaveCount(2);
      broken = true;
      await translateInput(page, 'run');
      await expect(page.locator('#ai-translator-result-text .ai-translator-input-error')).toHaveText(zh('dictEntryUnreadable'));
      await expect(page.locator('#ai-translator-input-dict')).toBeHidden();
      await expect(dialog.locator('.ai-translator-dict-section')).toHaveCount(0);
      await closeInputDialog(page, { via: 'overlay' });

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
      await translateInput(page, 'run');
      await expectRunEntry(page, page.locator('#ai-translator-input-dialog'));
      const fromDialog = await page.locator('#ai-translator-input-dict').innerHTML();
      await closeInputDialog(page, { via: 'overlay' });

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
      await translateInput(page, 'run');
      await expectRunEntry(page, page.locator('#ai-translator-input-dialog'));
      await expectEntryStyles(page, '#ai-translator-input-dict', MODEL_ENTRY_STYLES);
      // The UK/US label, from an English translation.
      await page.fill('#ai-translator-input-text', '');
      await pickInputTargetLang(page, 'en');
      await translateInput(page, '猫');
      await expect(page.locator('#ai-translator-input-dict .ai-translator-dict-accent')).toHaveCount(2);
      await expectEntryStyles(page, '#ai-translator-input-dict', ACCENT_STYLES);
      await closeInputDialog(page, { via: 'overlay' });

      const card = await openCardOn(page, '#word');
      await expectRunEntry(page, card);
      await expectEntryStyles(page, '.ai-translator-popup .ai-translator-dict-entry', MODEL_ENTRY_STYLES);
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
        await translateInput(page, 'run');
        await expectRunEntry(page, page.locator('#ai-translator-input-dialog'));
        await expectReadableContrast(page, '#ai-translator-input-dict', `${theme} input box`, MODEL_CONTRAST_SELECTORS);
        // The UK/US label, from an English translation.
        await page.fill('#ai-translator-input-text', '');
        await pickInputTargetLang(page, 'en');
        await translateInput(page, '猫');
        await expect(page.locator('#ai-translator-input-dict .ai-translator-dict-accent')).toHaveCount(2);
        await expectReadableContrast(page, '#ai-translator-input-dict', `${theme} input box`, ['.ai-translator-dict-accent']);
        await closeInputDialog(page, { via: 'overlay' });

        const card = await openCardOn(page, '#word');
        await expectRunEntry(page, card);
        await expectReadableContrast(page, '.ai-translator-popup .ai-translator-dict-entry', `${theme} card`, MODEL_CONTRAST_SELECTORS);
      } finally {
        await mock.close();
      }
    });
  }

  test('C9: a short formula in the input box is translated with the math rule, not looked up (D-474)', async ({ page, context }) => {
    const mock = await startMockOpenAIServer({ dictEntry });
    try {
      await servePage(context);
      await setExtensionSettings(page, settings(mock.endpoint, { uiLanguage: 'zh-CN' }));
      await page.goto(`${ORIGIN}/`);
      await waitForFloatBall(page);
      await openInputDialog(page);

      // Three tokens and no sentence punctuation, but formula notation: the text
      // prompt with the math placeholder rule, not the dictionary prompt.
      const sent = mock.sentTexts.length;
      await translateInput(page, '$x + y$');
      await expect(page.locator('#ai-translator-result-text')).toHaveText('[T] $x + y$');
      expect(mock.sentTexts.length).toBe(sent + 1);
      expect(mock.systemPrompts.at(-1)).not.toContain(globalThis.DictEntry.PROMPT_MARK);
      expect(mock.systemPrompts.at(-1)).toContain('Placeholders such as {{1}}');
      await expect(page.locator('#ai-translator-input-dict')).toBeHidden();
      await expect(page.locator('#ai-translator-input-dialog .ai-translator-dict-section')).toHaveCount(0);
    } finally {
      await mock.close();
    }
  });
  test('J1: input box into zh-CN — the phonetics are the translation\'s pinyin, and its speaker reads the translation (D-487)', async ({ page, context }) => {
    const mock = await startMockOpenAIServer({ dictEntry });
    try {
      await servePage(context);
      await setExtensionSettings(page, settings(mock.endpoint, { uiLanguage: 'zh-CN', targetLang: 'zh-CN' }));
      await page.goto(`${ORIGIN}/`);
      await waitForFloatBall(page);
      await stubSpeech(page);
      await openInputDialog(page);

      // Step 1: one pinyin row, no UK/US.
      await translateInput(page, 'run');
      await expect(page.locator('#ai-translator-result-text')).toHaveText('跑');
      const dict = page.locator('#ai-translator-input-dict');
      await expect(dict.locator('.ai-translator-dict-phonetic')).toHaveCount(1);
      await expect(dict.locator('.ai-translator-dict-ipa')).toHaveText('pǎo');
      await expect(dict.locator('.ai-translator-dict-accent')).toHaveCount(0);
      await expect(dict.locator('.ai-translator-dict-phonetics')).toHaveText('pǎo');
      if (shotDir) {
        await page.waitForTimeout(300);
        await page.locator('.ai-translator-input-modal').screenshot({ path: `${shotDir}/j1-input-zh.png` });
      }

      // Step 2: the row's speaker reads 跑 in zh-CN, not `run`.
      await expectTranslationSpeaker(page, dict);

      // Step 3: the dialog's own source speaker still reads `run`, in no
      // declared language (detected from the text), as before.
      await page.locator('#ai-translator-input-speak').click();
      await expect.poll(() => asked(page)).toEqual([
        { text: '跑', lang: 'zh-CN' },
        { text: 'run', lang: '' },
      ]);
    } finally {
      await mock.close();
    }
  });

  test('J2: input box into English — the translation\'s UK and US IPA, each speaker reading it in its accent (D-487)', async ({ page, context }) => {
    const mock = await startMockOpenAIServer({ dictEntry });
    try {
      await servePage(context);
      await setExtensionSettings(page, settings(mock.endpoint, { targetLang: 'en' }));
      await page.goto(`${ORIGIN}/`);
      await waitForFloatBall(page);
      await stubSpeech(page);
      await openInputDialog(page);

      // Step 1: two rows, UK and US, the IPA of `cat`.
      await translateInput(page, '猫');
      await expect(page.locator('#ai-translator-result-text')).toHaveText('cat');
      const dict = page.locator('#ai-translator-input-dict');
      const rows = dict.locator('.ai-translator-dict-phonetic');
      await expect(rows).toHaveCount(2);
      await expect(rows.locator('.ai-translator-dict-accent')).toHaveText([en('dictUK'), en('dictUS')]);
      await expect(rows.locator('.ai-translator-dict-ipa')).toHaveText(['/kæt/', '/kæt/']);
      for (const i of [0, 1]) {
        await expect(rows.nth(i).locator('.ai-translator-dict-speak')).toHaveAttribute('aria-label', en('pronounceTranslation'));
      }
      if (shotDir) {
        await page.waitForTimeout(300);
        await page.locator('.ai-translator-input-modal').screenshot({ path: `${shotDir}/j2-input-en.png` });
      }

      // Step 2: US then UK; both read `cat`, never `猫`.
      await dict.locator('.ai-translator-dict-speak[data-accent="US"]').click();
      await expect.poll(() => spoken(page)).toEqual([{ text: 'cat', lang: 'en-US' }]);
      await dict.locator('.ai-translator-dict-speak[data-accent="UK"]').click();
      await expect.poll(() => spoken(page)).toEqual([
        { text: 'cat', lang: 'en-US' },
        { text: 'cat', lang: 'en-GB' },
      ]);
      expect(await asked(page)).toEqual([
        { text: 'cat', lang: 'en-US' },
        { text: 'cat', lang: 'en-GB' },
      ]);
    } finally {
      await mock.close();
    }
  });

  test('J3: the selection card into zh-CN — the translation\'s pinyin and speaker; the card\'s source speaker reads the selection (D-487)', async ({ page, context }) => {
    const mock = await startMockOpenAIServer({ dictEntry });
    try {
      await servePage(context);
      await setExtensionSettings(page, settings(mock.endpoint, { uiLanguage: 'zh-CN', targetLang: 'zh-CN' }));
      await page.goto(`${ORIGIN}/`);
      await waitForFloatBall(page);
      await stubSpeech(page);

      const card = await openCardOn(page, '#word');
      await expect(card.locator('.ai-translator-translation-text')).toHaveText('跑');
      const dict = card.locator('.ai-translator-dict-entry');
      await expect(dict.locator('.ai-translator-dict-phonetic')).toHaveCount(1);
      await expect(dict.locator('.ai-translator-dict-ipa')).toHaveText('pǎo');
      await expect(dict.locator('.ai-translator-dict-accent')).toHaveCount(0);
      if (shotDir) {
        await page.waitForTimeout(400);
        await card.screenshot({ path: `${shotDir}/j3-card-zh.png` });
      }

      await expectTranslationSpeaker(page, dict);

      await card.locator('.ai-translator-speak-source').click();
      await expect.poll(() => asked(page)).toEqual([
        { text: '跑', lang: 'zh-CN' },
        { text: 'run', lang: '' },
      ]);
    } finally {
      await mock.close();
    }
  });

  // What a model answers to the prompt that lets it decide (the word may or may
  // not be English, the reader reads English): `monolingual` says which entry
  // it wrote. popular and run are English, so a monolingual entry whose
  // examples have no translation; Schadenfreude is German, so a bilingual one.
  const DECIDED_ENTRIES = {
    popular: {
      monolingual: true,
      translation: 'liked by many people',
      phonetics: [{ label: 'UK', ipa: '/ˈpɒpjələ/' }, { label: 'US', ipa: '/ˈpɑːpjələr/' }],
      senses: [{ pos: 'adj.', defs: ['liked or enjoyed by a large number of people', 'of ordinary people'] }],
      examples: [{ source: 'It was a popular song in the sixties.', target: '' }],
      forms: [{ label: 'comparative', value: 'more popular' }],
    },
    run: {
      monolingual: true,
      translation: 'move fast on foot',
      phonetics: [{ label: 'UK', ipa: '/rʌn/' }, { label: 'US', ipa: '/rʌn/' }],
      senses: [{ pos: 'v.', defs: ['move at a speed faster than a walk'] }],
      examples: [{ source: 'I run every morning.', target: '' }],
    },
    Schadenfreude: {
      monolingual: false,
      translation: 'malicious joy',
      phonetics: [{ label: 'UK', ipa: '/ˈʃɑːdənfrɔɪdə/' }, { label: 'US', ipa: '/ˈʃɑːdənˌfrɔɪdə/' }],
      senses: [{ pos: 'n.', defs: ['pleasure taken in someone else\'s misfortune'] }],
      examples: [{ source: 'Er empfand Schadenfreude.', target: 'He felt a malicious joy.' }],
    },
  };
  const decidedEntry = (text) => DECIDED_ENTRIES[text] || { translation: `[T] ${text}` };

  // The last request went out with the prompt that lets the model decide.
  function expectDecidingPrompt(mock) {
    const system = mock.systemPrompts.at(-1);
    expect(system.startsWith('You are a dictionary for a reader of English.')).toBe(true);
    expect(system.endsWith(globalThis.DictEntry.RULES.unknown)).toBe(true);
    expect(system).toContain('"monolingual"');
  }

  // The entry under `root` has no translation row: UK/US rows whose speakers
  // read `word`, and examples with no translation.
  async function expectMonolingualEntry(page, root, word) {
    const entry = root.locator('.ai-translator-dict-entry');
    await expect(entry).toBeVisible();
    const rows = entry.locator('.ai-translator-dict-phonetic');
    await expect(rows.locator('.ai-translator-dict-accent')).toHaveText([en('dictUK'), en('dictUS')]);
    for (const i of [0, 1]) {
      await expect(rows.nth(i).locator('.ai-translator-dict-speak')).toHaveAttribute('aria-label', en('pronounceOriginal'));
    }
    const { source } = DECIDED_ENTRIES[word].examples[0];
    await expect(entry.locator('.ai-translator-dict-example-source')).toHaveText(source);
    await expect(entry.locator('.ai-translator-dict-example-target')).toHaveCount(0);
    await expect(entry.locator('.ai-translator-dict-example')).toHaveText(source);
    const before = (await spoken(page)).length;
    await entry.locator('.ai-translator-dict-speak[data-accent="US"]').click();
    await expect.poll(async () => (await spoken(page)).slice(before)).toEqual([{ text: word, lang: 'en-US' }]);
    await entry.locator('.ai-translator-dict-speak[data-accent="UK"]').click();
    await expect.poll(async () => (await spoken(page)).slice(before))
      .toEqual([{ text: word, lang: 'en-US' }, { text: word, lang: 'en-GB' }]);
  }

  test('J4: input box into English — popular is the model\'s call and comes back monolingual; 猫 is proven foreign and goes out bilingual', async ({ page, context }) => {
    const mock = await startMockOpenAIServer({ dictEntry: decidedEntry });
    try {
      await servePage(context);
      await setExtensionSettings(page, settings(mock.endpoint, { targetLang: 'en' }));
      await page.goto(`${ORIGIN}/`);
      await waitForFloatBall(page);
      await stubSpeech(page);
      await openInputDialog(page);

      await translateInput(page, 'popular');
      await expect(page.locator('#ai-translator-result-text')).toHaveText('liked by many people');
      expectDecidingPrompt(mock);
      const dialog = page.locator('#ai-translator-input-dialog');
      await expectMonolingualEntry(page, dialog, 'popular');
      await expect(dialog.locator('.ai-translator-dict-defs')).toHaveText('liked or enjoyed by a large number of people; of ordinary people');
      await expect(dialog.locator('.ai-translator-dict-form-value')).toHaveText('more popular');
      if (shotDir) {
        await page.waitForTimeout(300);
        await page.locator('.ai-translator-input-modal').screenshot({ path: `${shotDir}/j4-input-en-en.png` });
      }

      // Han is not written in English: proven another language, the bilingual
      // lookup, whatever the model would have said.
      await translateInput(page, '猫');
      await expect(page.locator('#ai-translator-result-text')).toHaveText('[T] 猫');
      expect(mock.systemPrompts.at(-1).startsWith('You are a bilingual dictionary.')).toBe(true);
      expect(mock.systemPrompts.at(-1).endsWith(globalThis.DictEntry.RULES.other)).toBe(true);
    } finally {
      await mock.close();
    }
  });

  test('J5: the selection card on an English page into English — run comes back monolingual, Schadenfreude bilingual, from the same deciding prompt', async ({ page, context }) => {
    const mock = await startMockOpenAIServer({ dictEntry: decidedEntry });
    try {
      await servePage(context);
      await setExtensionSettings(page, settings(mock.endpoint, { targetLang: 'en' }));
      await page.goto(`${ORIGIN}/`);
      await waitForFloatBall(page);
      await stubSpeech(page);

      const card = await openCardOn(page, '#word');
      await expect(card.locator('.ai-translator-translation-text')).toHaveText('move fast on foot');
      expectDecidingPrompt(mock);
      await expectMonolingualEntry(page, card, 'run');

      // The same prompt; the model says it translated, so the entry is the
      // bilingual one: the speakers read the translation, the example keeps
      // its translation.
      await page.keyboard.press('Escape');
      await expect(card).toHaveCount(0);
      const loan = await openCardOn(page, '#loanword');
      await expect(loan.locator('.ai-translator-translation-text')).toHaveText('malicious joy');
      expectDecidingPrompt(mock);
      const entry = loan.locator('.ai-translator-dict-entry');
      await expect(entry).toBeVisible();
      const speakers = entry.locator('.ai-translator-dict-phonetic .ai-translator-dict-speak');
      await expect(speakers).toHaveCount(2);
      for (const i of [0, 1]) await expect(speakers.nth(i)).toHaveAttribute('aria-label', en('pronounceTranslation'));
      await expect(entry.locator('.ai-translator-dict-example-source')).toHaveText('Er empfand Schadenfreude.');
      await expect(entry.locator('.ai-translator-dict-example-target')).toHaveText('He felt a malicious joy.');
      const before = (await spoken(page)).length;
      await entry.locator('.ai-translator-dict-speak[data-accent="US"]').click();
      await expect.poll(async () => (await spoken(page)).slice(before)).toEqual([{ text: 'malicious joy', lang: 'en-US' }]);
    } finally {
      await mock.close();
    }
  });

  test('J6: input box into Chinese — 猫 is proven Chinese by its script and goes out monolingual', async ({ page, context }) => {
    const mock = await startMockOpenAIServer({ dictEntry: (text) => ({ translation: `猫科动物（${text}）` }) });
    try {
      await servePage(context);
      await setExtensionSettings(page, settings(mock.endpoint, { targetLang: 'zh-CN' }));
      await page.goto(`${ORIGIN}/`);
      await waitForFloatBall(page);
      await openInputDialog(page);

      await translateInput(page, '猫');
      await expect(page.locator('#ai-translator-result-text')).toHaveText('猫科动物（猫）');
      const system = mock.systemPrompts.at(-1);
      expect(system.startsWith('You are a monolingual ')).toBe(true);
      expect(system.endsWith(globalThis.DictEntry.RULES.target)).toBe(true);
    } finally {
      await mock.close();
    }
  });

  // D-561: an offline dictionary answer ({engine: 'dict', entry, credits}) is
  // read by the same entryFor and drawn by the same render. This draws a
  // hand-made answer into the input box's real entry container from the
  // content script, where the card and the dialog call render, and reads the
  // links off the page. The answer carries the two credits a pack can carry:
  // an unsafe credit never reaches a card, because parsePack refuses the whole
  // pack (D-686; test/unit/dict-pack.test.mjs). A real pack answer, entered
  // from the page, is dictionary-local.spec.js (J-B2.1–J-B2.7).
  test('C10: an offline dictionary entry ends in a credits line of links; a model answer\'s credits are dropped (D-561); unsafe credits are refused by parsePack (unit)', async ({ page, context }) => {
    const mock = await startMockOpenAIServer({ dictEntry });
    try {
      await servePage(context);
      await setExtensionSettings(page, settings(mock.endpoint, { uiLanguage: 'zh-CN' }));
      await page.goto(`${ORIGIN}/`);
      await waitForFloatBall(page);
      await openInputDialog(page);
      // A word looked up first, so the result area is on screen and the line
      // below has a layout to measure; nothing after it asks a model.
      await translateInput(page, 'run');
      await expect(page.locator('#ai-translator-result-text')).toHaveText('跑');
      const asked = mock.systemPrompts.length;

      const drawAnswer = (answer) => evaluateInContentScript(context, page, `(() => {
        const answer = ${JSON.stringify(answer)};
        const entry = DictEntry.entryFor('word', answer);
        DictEntry.render(document.getElementById('ai-translator-input-dict'), entry, {
          targetLang: 'zh-CN', text: 'run', t: (key) => getMessage(key, 'zh-CN'), speech: null,
        });
        return 'credits' in entry;
      })()`);
      const entry = { translation: '跑', senses: [{ pos: 'v.', defs: ['跑', '奔跑'] }] };
      const credits = [
        { label: 'JMdict © EDRDG', href: 'https://www.edrdg.org/edrdg/licence.html' },
        { label: 'Tatoeba', href: 'https://tatoeba.org/' },
      ];
      const dict = page.locator('#ai-translator-input-dict');

      expect(await drawAnswer({ engine: 'dict', translation: '跑', entry, credits })).toBe(true);
      // The result area around it stays hidden until a translation arrives;
      // render itself un-hides the entry container.
      expect(await dict.evaluate((el) => el.hidden)).toBe(false);
      const line = dict.locator('.ai-translator-dict-credits');
      await expect(line).toHaveCount(1);
      await expect(line.locator('.ai-translator-dict-credits-prefix')).toHaveText(zh('dictCredits'));
      // One line of its own, not a stacked section: prefix, first link, a
      // ' · ' text node, second link, in that order (render owns the order),
      // laid out side by side on one row (dict-entry.css owns that).
      const order = await line.evaluate((el) => ({
        className: el.className,
        nodes: [...el.childNodes].map((n) => (n.nodeType === Node.TEXT_NODE ? `text:${n.data}` : n.className)),
      }));
      expect(order).toEqual({
        className: 'ai-translator-dict-credits',
        nodes: ['ai-translator-dict-credits-prefix', 'ai-translator-dict-credit-link', 'text: · ', 'ai-translator-dict-credit-link'],
      });
      const row = await line.evaluate((el) => ({
        height: el.getBoundingClientRect().height,
        tops: [...el.children].map((child) => child.offsetTop),
      }));
      expect(row.height, JSON.stringify(row)).toBeGreaterThan(0);
      expect(new Set(row.tops).size, `prefix and links on one row: ${JSON.stringify(row)}`).toBe(1);
      const links = line.locator('a');
      await expect(links).toHaveText(['JMdict © EDRDG', 'Tatoeba']);
      const attrs = await links.evaluateAll((all) => all.map((a) => ({
        href: a.href, target: a.target, noopener: a.relList.contains('noopener'), noreferrer: a.relList.contains('noreferrer'),
      })));
      expect(attrs).toEqual([
        { href: 'https://www.edrdg.org/edrdg/licence.html', target: '_blank', noopener: true, noreferrer: true },
        { href: 'https://tatoeba.org/', target: '_blank', noopener: true, noreferrer: true },
      ]);

      // The same credits on a model answer: dropped, no line, the entry as before.
      expect(await drawAnswer({ engine: 'ai', translation: '跑', entry: { ...entry, credits }, credits })).toBe(false);
      await expect(dict.locator('.ai-translator-dict-sense')).toHaveCount(1);
      await expect(dict.locator('.ai-translator-dict-credits')).toHaveCount(0);
      await expect(dict.locator('a')).toHaveCount(0);

      // Nothing after the first word asked a model.
      expect(mock.systemPrompts).toHaveLength(asked);
    } finally {
      await mock.close();
    }
  });
});
