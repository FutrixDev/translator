/**
 * Classical Chinese is a target like any other, in both directions, in two
 * scripts: lzh is Traditional (what 1.5.8 shipped, so a stored lzh keeps its
 * meaning) and lzh-Hans is Simplified.
 *
 * Chrome's Intl has no name for lzh in any UI language, so its names come from
 * target-lang.js's own table, and they carry the script. These check what
 * reaches the user and the model: the settings page shows both by name rather
 * than the bare code, a hover into either tells the model which script to
 * write, and a hover over Classical Chinese with a modern-language target is
 * translated, not skipped.
 */
const { test, expect } = require('./fixtures');
const { setExtensionSettings, waitForContentReady } = require('./helpers');
const { startMockOpenAIServer } = require('./mock-openai-server');

const SITE = 'https://lzh.example.test';
// The opening lines of the Analects (論語·學而), and a plain English sentence.
const CLASSICAL = '學而時習之，不亦說乎？有朋自遠方來，不亦樂乎？';
const ENGLISH = 'The cat sleeps on the sofa while the rain falls outside.';
const MODERN = '今天下午我们去公园散步，路边的花开得正好。';
const PAGE = `<!doctype html><html><head><title>Reading</title></head><body>
<p id="classical">${CLASSICAL}</p>
<p id="english">${ENGLISH}</p>
<p id="modern">${MODERN}</p>
</body></html>`;

async function hoverTranslate(page, selector) {
  await page.mouse.move(5, 5);
  await page.keyboard.down('Shift');
  await page.locator(selector).hover();
  await page.waitForSelector(`${selector} + .ai-translator-hover-translation:not(.ai-translator-inline-loading)`,
    { state: 'attached' });
  await page.keyboard.up('Shift');
}

test('the settings page offers Classical Chinese by name, in both scripts', async ({ context, extensionId }) => {
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options/options.html`);
  // The harness pins the UI language to English (E2E_BASE_SETTINGS in helpers.js).
  await options.click('#targetLang .ai-translator-lang-trigger');
  await expect(options.locator('#targetLang .ai-translator-lang-item:not([data-recent])[data-lang="lzh"]')).toHaveText('Classical Chinese (Traditional)');
  await expect(options.locator('#targetLang .ai-translator-lang-item:not([data-recent])[data-lang="lzh-Hans"]')).toHaveText('Classical Chinese (Simplified)');
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
    expect(mock.systemPrompts[into]).toContain('Classical Chinese (Traditional) (文言文（繁體）)');

    // Out of Classical Chinese into English: the page text is sent, not skipped as "already target".
    await setExtensionSettings(page, { targetLang: 'en' });
    await hoverTranslate(page, '#classical');
    const outOf = mock.sentTexts.findIndex((text) => text.includes(CLASSICAL));
    expect(outOf).toBeGreaterThanOrEqual(0);
    expect(mock.systemPrompts[outOf]).toContain('English');

    // The pair a Chinese reader means: modern Chinese into Classical Chinese, and back.
    // Both are Chinese script, and neither may be skipped as "already the target".
    await setExtensionSettings(page, { targetLang: 'lzh' });
    await hoverTranslate(page, '#modern');
    const modernIn = mock.sentTexts.findIndex((text) => text.includes(MODERN));
    expect(modernIn).toBeGreaterThanOrEqual(0);
    expect(mock.systemPrompts[modernIn]).toContain('Classical Chinese (Traditional) (文言文（繁體）)');

    // The same paragraph into Simplified Classical Chinese: the prompt names that script.
    await setExtensionSettings(page, { targetLang: 'lzh-Hans' });
    await page.reload();
    await waitForContentReady(page);
    await hoverTranslate(page, '#modern');
    const modernInSimplified = mock.sentTexts.findLastIndex((text) => text.includes(MODERN));
    expect(modernInSimplified).toBeGreaterThan(modernIn);
    expect(mock.systemPrompts[modernInSimplified]).toContain('Classical Chinese (Simplified) (文言文（简体）)');

    // A fresh page, so #classical carries no translation from the hover above.
    await setExtensionSettings(page, { targetLang: 'zh-CN' });
    await page.reload();
    await waitForContentReady(page);
    await hoverTranslate(page, '#classical');
    const toModern = mock.sentTexts.findLastIndex((text) => text.includes(CLASSICAL));
    expect(toModern).toBeGreaterThan(outOf);
    expect(mock.systemPrompts[toModern]).toContain('Simplified Chinese');
  } finally {
    await mock.close();
  }
});
