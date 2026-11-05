/**
 * Classical Chinese (lzh) is a target like any other, in both directions.
 *
 * Chrome's Intl has no name for lzh in any UI language, so its names come from
 * target-lang.js's own table. These check what reaches the user and the model:
 * the settings page shows 文言文 rather than the bare code, a hover into lzh
 * tells the model "Classical Chinese (文言文)", and a hover over Classical
 * Chinese with a modern-language target is translated, not skipped.
 */
const { test, expect } = require('./fixtures');
const { setExtensionSettings, waitForContentReady } = require('./helpers');
const { startMockOpenAIServer } = require('./mock-openai-server');

const SITE = 'https://lzh.example.test';
// The opening lines of the Analects (論語·學而), and a plain English sentence.
const CLASSICAL = '學而時習之，不亦說乎？有朋自遠方來，不亦樂乎？';
const ENGLISH = 'The cat sleeps on the sofa while the rain falls outside.';
const PAGE = `<!doctype html><html><head><title>Reading</title></head><body>
<p id="classical">${CLASSICAL}</p>
<p id="english">${ENGLISH}</p>
</body></html>`;

async function hoverTranslate(page, selector) {
  await page.mouse.move(5, 5);
  await page.keyboard.down('Shift');
  await page.locator(selector).hover();
  await page.waitForSelector(`${selector} + .ai-translator-hover-translation:not(.ai-translator-inline-loading)`,
    { state: 'attached' });
  await page.keyboard.up('Shift');
}

test('the settings page offers Classical Chinese by name', async ({ context, extensionId }) => {
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options/options.html`);
  const label = await options.locator('#targetLang option[value="lzh"]').textContent();
  expect(label).not.toBe('lzh');
  const names = await options.evaluate(() => ['ar', 'de', 'en', 'es', 'fr', 'id', 'it', 'ja', 'ko', 'pt', 'ru', 'tr', 'vi', 'zh-CN', 'zh-TW']
    .map((ui) => TargetLang.nameOf('lzh', ui)));
  expect(names).toContain(label);
  await options.close();
});

test('hover translates into and out of Classical Chinese', async ({ page, context }) => {
  const mock = await startMockOpenAIServer();
  try {
    await setExtensionSettings(page, {
      apiEndpoint: mock.endpoint, apiKey: 'test-key', modelName: 'gpt-4.1-mini',
      targetLang: 'lzh', translationStyle: 'underline',
    });
    await context.route(`${SITE}/**`, (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: PAGE }));
    await page.goto(`${SITE}/`);
    await waitForContentReady(page);

    // Into Classical Chinese: the model is told the target by name, never as a bare code.
    await hoverTranslate(page, '#english');
    const into = mock.sentTexts.findIndex((text) => text.includes(ENGLISH));
    expect(into).toBeGreaterThanOrEqual(0);
    expect(mock.systemPrompts[into]).toContain('Classical Chinese (文言文)');

    // Out of Classical Chinese into English: the page text is sent, not skipped as "already target".
    await setExtensionSettings(page, { targetLang: 'en' });
    await hoverTranslate(page, '#classical');
    const outOf = mock.sentTexts.findIndex((text) => text.includes(CLASSICAL));
    expect(outOf).toBeGreaterThanOrEqual(0);
    expect(mock.systemPrompts[outOf]).toContain('English');
  } finally {
    await mock.close();
  }
});
