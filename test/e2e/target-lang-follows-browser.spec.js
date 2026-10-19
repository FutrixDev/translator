/**
 * A fresh install translates into the browser's language (targetLang '').
 *
 * Nothing on a fresh install writes targetLang: the settings page and the
 * welcome page show TargetLang.effective() and keep '' stored until the user
 * picks one, and the page translation resolves '' the same way before it asks
 * the model. Each surface is checked against navigator.language as its own
 * context reads it. In real Chrome every context reads the same one; here they
 * do not — Playwright emulates en-US in pages, while the worker follows the
 * system locale (macOS ignores --lang) — so no single expected language exists
 * and none is named.
 */
const { test, expect } = require('./fixtures');
const {
  getSyncSettings, setExtensionSettings, waitForContentReady, evaluateInContentScript,
  triggerPageTranslation, waitForTranslationComplete,
} = require('./helpers');
const { startMockOpenAIServer } = require('./mock-openai-server');

const SITE = 'https://fr.example.test';
const PAGE = `<!doctype html><html lang="fr"><head><title>Bonjour</title></head><body>
<p id="p1">Le chat dort sur le canapé pendant que la pluie tombe dehors.</p>
</body></html>`;

test('a fresh install shows, keeps and sends the browser language as the target', async ({ page, context, extensionId }) => {
  const browserLanguage = (target) => target.evaluate(() => TargetLang.browserLanguage());
  expect((await getSyncSettings(context, ['targetLang'])).targetLang).toBeUndefined();

  // The settings page shows it, and a save of something else leaves '' stored.
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options/options.html`);
  await expect(options.locator('#targetLang')).toHaveValue(await browserLanguage(options));
  const style = options.locator('#translationStyle');
  const other = await style.evaluate((s) => [...s.options].find((o) => !o.selected).value);
  await style.selectOption(other);
  await expect.poll(async () => (await getSyncSettings(context, ['translationStyle'])).translationStyle).toBe(other);
  expect((await getSyncSettings(context, ['targetLang'])).targetLang).toBe('');
  await options.close();

  // The welcome page shows it too.
  const welcome = await context.newPage();
  await welcome.goto(`chrome-extension://${extensionId}/onboarding/onboarding.html`);
  await welcome.waitForFunction(() => document.documentElement.dataset.ready === 'true');
  await expect(welcome.locator('#targetLang')).toHaveValue(await browserLanguage(welcome));
  await welcome.close();
  expect((await getSyncSettings(context, ['targetLang'])).targetLang).toBe('');

  // And the model is asked for it.
  const mock = await startMockOpenAIServer();
  try {
    await setExtensionSettings(page, {
      apiEndpoint: mock.endpoint, apiKey: 'test-key', modelName: 'gpt-4.1-mini',
      translationStyle: 'underline',
    });
    expect((await getSyncSettings(context, ['targetLang'])).targetLang).toBe('');
    await context.route(`${SITE}/**`, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: PAGE }));
    await page.goto(`${SITE}/`);
    await waitForContentReady(page);
    const promptName = await evaluateInContentScript(context, page,
      'TargetLang.promptName(TargetLang.browserLanguage())');
    await triggerPageTranslation(page);
    await waitForTranslationComplete(page);
    expect(mock.systemPrompts.length).toBeGreaterThan(0);
    for (const prompt of mock.systemPrompts) expect(prompt).toContain(promptName);
  } finally {
    await mock.close();
  }
});
