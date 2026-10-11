// Why a typed word sometimes has a dictionary entry and sometimes not
// (design ext-opt-input-translation §A, D-542). The entry comes only from a
// model engine; the dialog now says which engine answered, and when a word
// comes back without an entry, says why in one line under the translation.
// The built-in engine is the STUB from stubBuiltinTranslator ('[B] ' + text).
const { test, expect } = require('./fixtures');
const {
  setExtensionSettings,
  openExamplePage,
  openInputDialog,
  pickInputTargetLang,
  translateInput,
  recycleWorker,
  stubBuiltinTranslator,
} = require('./helpers');
const { expectLaidOut } = require('./layout-checks');
const { startMockOpenAIServer } = require('./mock-openai-server');
const { getMessage } = require('../../i18n/messages');
require('../../shared/dict-entry.js');

const en = (key) => getMessage(key, 'en');

const RUN_ENTRY = {
  translation: '跑',
  phonetics: [{ label: '', ipa: 'pǎo' }],
  senses: [{ pos: 'v.', defs: ['跑', '奔跑'] }],
  examples: [{ source: 'I run every morning.', target: '我每天早上跑步。' }],
};
const dialogPart = {
  tag: '#ai-translator-input-dialog .ai-translator-engine-tag',
  dict: '#ai-translator-input-dict',
  note: '#ai-translator-input-dict-note',
  noteText: '#ai-translator-input-dict-note .ai-translator-dict-note-text',
  switchBtn: '#ai-translator-input-dict-note .ai-translator-switch-engine',
  settingsBtn: '#ai-translator-input-dict-note .ai-translator-open-settings',
  result: '#ai-translator-result-text',
};

const entryWithIpa = (text) => ({ translation: `[D] ${text}`, phonetics: [{ label: '', ipa: `ipa-${text}` }] });

function aiSettings(endpoint, extra = {}) {
  return { apiEndpoint: endpoint, apiKey: 'test-key', modelName: 'gpt-4.1-mini', targetLang: 'zh-CN', ...extra };
}

test('J-I1 a word looked up with the built-in engine says why there is no entry, and one click asks the AI', async ({ page }) => {
  const mock = await startMockOpenAIServer({ dictEntry: (text) => (text === 'run' ? RUN_ENTRY : { translation: `[T] ${text}` }) });
  try {
    // 1. Built-in, local only, on an https page; the AI is configured but not chosen.
    await setExtensionSettings(page, aiSettings(mock.endpoint, { translationEngine: 'builtin', engineFallback: 'local-only' }));
    await openExamplePage(page);
    await stubBuiltinTranslator(page);
    await openInputDialog(page);
    await expect(page.locator('#ai-translator-input-dialog .ai-translator-title')).toHaveText(en('inputTextTranslation'));

    // 2. The built-in answer, its tag, and the line that says why there is no entry.
    await translateInput(page, 'run');
    await expect(page.locator(dialogPart.result)).toHaveText('[B] run');
    await expect(page.locator(dialogPart.tag)).toHaveText(en('cardEngineBuiltin'));
    await expect(page.locator(dialogPart.noteText)).toHaveText(en('inputDictNeedsModel'));
    await expect(page.locator(dialogPart.note)).toBeVisible();
    await expect(page.locator(dialogPart.switchBtn)).toBeVisible();
    await expect(page.locator(dialogPart.switchBtn)).toHaveText(en('cardUseAi'));
    await expect(page.locator(dialogPart.settingsBtn)).toBeHidden();
    await expect(page.locator(dialogPart.dict)).toBeHidden();
    await expect(page.locator('#ai-translator-input-dialog .ai-translator-input-error')).toHaveCount(0);
    expect(mock.sentTexts).toEqual([]);

    // 3. One click: the same word, asked of the AI, with its entry.
    await page.click(dialogPart.switchBtn);
    await expect(page.locator(dialogPart.tag)).toHaveText(en('cardEngineAi'));
    await expect(page.locator(dialogPart.result)).toHaveText('跑');
    await expect(page.locator(`${dialogPart.dict} .ai-translator-dict-ipa`)).toHaveText('pǎo');
    await expect(page.locator(dialogPart.dict)).toContainText('我每天早上跑步。');
    await expect(page.locator(dialogPart.note)).toBeHidden();
    expect(mock.sentTexts).toEqual(['run']);
    expect(mock.systemPrompts[0]).toContain(globalThis.DictEntry.PROMPT_MARK);

    // The click pinned that one request only: the next lookup follows the settings again.
    await translateInput(page, 'run');
    await expect(page.locator(dialogPart.tag)).toHaveText(en('cardEngineBuiltin'));
    await expect(page.locator(dialogPart.note)).toBeVisible();
    expect(mock.sentTexts).toEqual(['run']);

    // Emptying the box and picking another language asks for nothing, and the
    // note about the last word goes with it: it no longer describes the screen.
    await page.fill('#ai-translator-input-text', '');
    await pickInputTargetLang(page, 'fr');
    await expect(page.locator(dialogPart.note)).toBeHidden();
    await expect(page.locator(dialogPart.switchBtn)).toBeHidden();
    expect(mock.sentTexts).toEqual(['run']);

    // 4. With the AI chosen in settings, the entry comes straight away, and nothing to explain.
    await page.click('#ai-translator-input-dialog .ai-translator-close');
    await setExtensionSettings(page, { translationEngine: 'ai' });
    await openInputDialog(page);
    await translateInput(page, 'run');
    await expect(page.locator(dialogPart.tag)).toHaveText(en('cardEngineAi'));
    await expect(page.locator(`${dialogPart.dict} .ai-translator-dict-ipa`)).toHaveText('pǎo');
    await expect(page.locator(dialogPart.note)).toBeHidden();
    await expect(page.locator(dialogPart.switchBtn)).toBeHidden();
  } finally {
    await mock.close();
  }
});

test('J-I2 kana, hangul and a word with a full stop are looked up; a sentence is translated, with nothing to explain', async ({ page }) => {
  const mock = await startMockOpenAIServer({ dictEntry: entryWithIpa });
  try {
    await setExtensionSettings(page, aiSettings(mock.endpoint));
    await openExamplePage(page);
    await openInputDialog(page);

    const asLookup = (i) => mock.systemPrompts[i].includes(globalThis.DictEntry.PROMPT_MARK);
    for (const [i, typed] of ['こんにちは', '안녕하세요', 'apple.'].entries()) {
      await translateInput(page, typed);
      await expect.poll(() => mock.sentTexts.length).toBe(i + 1);
      expect(mock.sentTexts[i]).toBe(typed);
      expect(asLookup(i), `${typed} went out as a lookup`).toBe(true);
      await expect(page.locator(dialogPart.result)).toHaveText(`[D] ${typed}`);
      await expect(page.locator(`${dialogPart.dict} .ai-translator-dict-ipa`)).toHaveText(`ipa-${typed}`);
      await expect(page.locator(dialogPart.note)).toBeHidden();
    }

    // A sentence: text mode, no entry, and no line under it either.
    await translateInput(page, 'How are you doing');
    await expect.poll(() => mock.sentTexts.length).toBe(4);
    expect(asLookup(3)).toBe(false);
    await expect(page.locator(dialogPart.result)).toHaveText('[T] How are you doing');
    await expect(page.locator(dialogPart.tag)).toHaveText(en('cardEngineAi'));
    await expect(page.locator(dialogPart.dict)).toBeHidden();
    await expect(page.locator(dialogPart.note)).toBeHidden();
  } finally {
    await mock.close();
  }
});

test('J-I3 a model answer with every list empty says the model gave none', async ({ page }) => {
  const mock = await startMockOpenAIServer({
    dictEntry: () => ({ translation: '我爱你', phonetics: [], senses: [], examples: [], forms: [] }),
  });
  try {
    await setExtensionSettings(page, aiSettings(mock.endpoint));
    await openExamplePage(page);
    await openInputDialog(page);
    await translateInput(page, 'I love you');
    await expect.poll(() => mock.sentTexts.length).toBe(1);
    expect(mock.systemPrompts[0]).toContain(globalThis.DictEntry.PROMPT_MARK);
    await expect(page.locator(dialogPart.result)).toHaveText('我爱你');
    await expect(page.locator(dialogPart.tag)).toHaveText(en('cardEngineAi'));
    await expect(page.locator(dialogPart.noteText)).toHaveText(en('dictEntryEmpty'));
    await expect(page.locator(dialogPart.note)).toBeVisible();
    // Nothing to switch to: it was the model that came back empty.
    await expect(page.locator(dialogPart.switchBtn)).toBeHidden();
  } finally {
    await mock.close();
  }
});

test('J-I4 the last thing asked is what the dialog shows: a slow earlier answer lands on nothing', async ({ page }) => {
  // Answers in arrival order, so which request an answer belongs to is plain on the page.
  let asked = 0;
  const mock = await startMockOpenAIServer({
    delayMs: 1500,
    dictEntry: () => ({ translation: asked++ === 0 ? 'FIRST (zh-CN)' : 'SECOND (fr)', phonetics: [{ label: '', ipa: `ipa-${asked}` }] }),
  });
  try {
    await setExtensionSettings(page, aiSettings(mock.endpoint));
    await openExamplePage(page);
    await openInputDialog(page);

    await translateInput(page, 'run');
    await expect.poll(() => mock.sentTexts.length).toBe(1);
    mock.setDelayMs(100);
    await pickInputTargetLang(page, 'fr');
    await expect.poll(() => mock.sentTexts.length).toBe(2);
    expect(mock.systemPrompts[1]).not.toBe(mock.systemPrompts[0]);

    const result = page.locator(dialogPart.result);
    await expect(result).toHaveText('SECOND (fr)');
    await expect(result).toHaveAttribute('lang', 'fr');
    const firstAnswerDue = mock.requestTimes[0] + 1500;
    await page.waitForTimeout(Math.max(0, firstAnswerDue - Date.now()) + 700);
    await expect(result).toHaveText('SECOND (fr)');
    await expect(result).toHaveAttribute('lang', 'fr');
    await expect(page.locator(`${dialogPart.dict} .ai-translator-dict-ipa`)).toHaveText('ipa-2');
    await expect(page.locator(dialogPart.note)).toBeHidden();
  } finally {
    await mock.close();
  }
});

test('J-I5 "use AI" asks about the word the note was written for, not what the box holds by now', async ({ page }) => {
  const mock = await startMockOpenAIServer({ delayMs: 1500, dictEntry: entryWithIpa });
  try {
    await setExtensionSettings(page, aiSettings(mock.endpoint, { translationEngine: 'builtin', engineFallback: 'local-only' }));
    await openExamplePage(page);
    await stubBuiltinTranslator(page);
    await openInputDialog(page);
    await translateInput(page, 'apple');
    await expect(page.locator(dialogPart.result)).toHaveText('[B] apple');
    await expect(page.locator(dialogPart.tag)).toHaveText(en('cardEngineBuiltin'));
    await expect(page.locator(dialogPart.switchBtn)).toBeVisible();

    // Typed over and not translated: the note on screen is still about apple.
    await page.fill('#ai-translator-input-text', 'I love you');
    await page.click(dialogPart.switchBtn);
    // While the model is asked, the tag names nobody: the built-in engine
    // answered the last request, not this one.
    const asking = await page.evaluate(([tag]) => ({
      loading: !!document.querySelector('#ai-translator-input-dialog .ai-translator-input-loading'),
      tagHidden: document.querySelector(tag).hidden,
    }), [dialogPart.tag]);
    expect(asking).toEqual({ loading: true, tagHidden: true });

    await expect(page.locator(dialogPart.result)).toHaveText('[D] apple');
    await expect(page.locator(dialogPart.tag)).toHaveText(en('cardEngineAi'));
    expect(mock.sentTexts).toEqual(['apple']);
    expect(mock.systemPrompts[0]).toContain(globalThis.DictEntry.PROMPT_MARK);
  } finally {
    await mock.close();
  }
});

test('J-I6 with no engine to switch to, the note offers the settings page', async ({ page, context }) => {
  // Built-in only: no AI profile, no Blab account.
  await setExtensionSettings(page, { translationEngine: 'builtin', engineFallback: 'local-only', targetLang: 'zh-CN' });
  await openExamplePage(page);
  await stubBuiltinTranslator(page);
  await openInputDialog(page);
  await translateInput(page, 'apple');
  await expect(page.locator(dialogPart.result)).toHaveText('[B] apple');
  await expect(page.locator(dialogPart.noteText)).toHaveText(en('inputDictNeedsModel'));
  await expect(page.locator(dialogPart.settingsBtn)).toHaveText(en('openSettings'));
  await expect(page.locator(dialogPart.settingsBtn)).toBeVisible();
  await expect(page.locator(dialogPart.switchBtn)).toBeHidden();
  console.log('J-I6 note contrast:', await expectLaidOut(page, [dialogPart.noteText, dialogPart.settingsBtn], 'J-I6 note'));

  const [options] = await Promise.all([context.waitForEvent('page'), page.click(dialogPart.settingsBtn)]);
  await options.waitForLoadState('domcontentloaded');
  expect(options.url()).toContain('/options/options.html');
});

test('J-I7 an earlier request that fails late does not write its error over the later answer', async ({ page, context }) => {
  const mock = await startMockOpenAIServer({ delayMs: 20000, dictEntry: entryWithIpa });
  try {
    await setExtensionSettings(page, aiSettings(mock.endpoint));
    await openExamplePage(page);
    await openInputDialog(page);
    await translateInput(page, 'run');
    await expect.poll(() => mock.sentTexts.length).toBe(1);
    mock.setDelayMs(0);
    await translateInput(page, 'walk');
    const result = page.locator(dialogPart.result);
    await expect(result).toHaveText('[D] walk');

    // 'run' is still out. Stopping the worker drops its message channel, so the
    // dialog's sendMessage for it rejects now, after 'walk' has answered.
    const failed = page.waitForEvent('console', {
      predicate: (message) => message.text().includes('Blab Translation: input translation failed'),
    });
    await recycleWorker(context, page);
    await failed;

    await expect(result).toHaveText('[D] walk');
    await expect(page.locator(`${dialogPart.dict} .ai-translator-dict-ipa`)).toHaveText('ipa-walk');
    await expect(page.locator(dialogPart.tag)).toHaveText(en('cardEngineAi'));
    await expect(page.locator('#ai-translator-input-dialog .ai-translator-input-error')).toHaveCount(0);
  } finally {
    await mock.close();
  }
});
