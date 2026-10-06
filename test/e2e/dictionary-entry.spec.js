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

function dictEntry(text) {
  return text === 'run' ? RUN_ENTRY : { translation: `[T] ${text}` };
}

async function servePage(context) {
  await context.route(`${ORIGIN}/**`, (route) => {
    route.fulfill({ status: 200, contentType: 'text/html', body: PAGE });
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
});
