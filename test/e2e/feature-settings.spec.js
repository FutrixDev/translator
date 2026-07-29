const { test, expect } = require('./fixtures');
const { setExtensionSettings } = require('./helpers');

async function getSetting(context, key) {
  let worker = context.serviceWorkers()[0];
  if (!worker) {
    worker = await context.waitForEvent('serviceworker');
  }
  return worker.evaluate((settingKey) => new Promise((resolve) => {
    chrome.storage.sync.get([settingKey], (result) => resolve(result[settingKey]));
  }), key);
}

test('options toggle updates youtube caption setting', async ({ page, context, extensionId }) => {
  await setExtensionSettings(page, {
    targetLang: 'en',
    targetLangSetByUser: true,
    apiKey: 'sk-test',
    apiEndpoint: 'https://api.openai.com/v1/chat/completions',
    modelName: 'gpt-4.1-mini',
    provider: 'openai',
  });

  const optionsUrl = `chrome-extension://${extensionId}/options/options.html`;
  await page.goto(optionsUrl);

  const toggleLabel = page.locator('label:has(#enableYoutubeCaptionTranslation)');
  await expect(toggleLabel).toBeVisible();
  // No Save button any more: the toggle is the whole interaction.
  await toggleLabel.click();

  await expect.poll(async () => getSetting(context, 'enableYoutubeCaptionTranslation')).toBe(true);
});

/**
 * The trap autosave sets. The old Save button refused to write anything at all
 * when the API key was blank, so moving that validation onto every change would
 * have meant a user who has not configured a key cannot change ANY setting —
 * the toggle would move on screen and nothing would be stored. Settings that
 * have nothing to do with the API must save regardless of it.
 */
test('settings save without an API key configured', async ({ page, context, extensionId }) => {
  await setExtensionSettings(page, {
    targetLang: 'en',
    targetLangSetByUser: true,
    apiKey: '',
    apiEndpoint: '',
    modelName: '',
    provider: 'openai',
    showFloatBall: true,
  });

  await page.goto(`chrome-extension://${extensionId}/options/options.html`);

  const toggleLabel = page.locator('label:has(#showFloatBall)');
  await expect(toggleLabel).toBeVisible();
  await toggleLabel.click();

  await expect.poll(async () => getSetting(context, 'showFloatBall')).toBe(false);
});

/**
 * Typing is debounced, so what matters is that the debounce actually fires and
 * that leaving the field does not lose the last keystrokes.
 */
test('typed fields autosave after the debounce', async ({ page, context, extensionId }) => {
  await setExtensionSettings(page, {
    targetLang: 'en',
    targetLangSetByUser: true,
    provider: 'custom',
    apiKey: '',
  });

  await page.goto(`chrome-extension://${extensionId}/options/options.html`);

  await page.fill('#apiKey', 'sk-typed-not-clicked');
  await page.locator('#apiKey').blur();

  await expect.poll(async () => getSetting(context, 'apiKey')).toBe('sk-typed-not-clicked');
});

/**
 * Test Connection belongs to the API card now, and it is the only thing left on
 * the page that judges the credentials — so it has to name the missing field.
 */
test('test connection sits in the API card and reports the missing field', async ({ page, extensionId }) => {
  await setExtensionSettings(page, {
    targetLang: 'en',
    targetLangSetByUser: true,
    provider: 'openai',
    apiKey: '',
    modelName: 'gpt-4.1-mini',
  });

  await page.goto(`chrome-extension://${extensionId}/options/options.html`);

  await expect(page.locator('#saveSettings')).toHaveCount(0);
  // Inside the API settings card, not in a page-wide action bar at the bottom.
  await expect(page.locator('.settings-card:has(#apiKey) #testConnection')).toBeVisible();

  await page.click('#testConnection');
  await expect(page.locator('#statusMessage')).toBeVisible();
  await expect(page.locator('#statusMessage')).toContainText('API Key');
});

test('popup toggle updates youtube caption setting', async ({ page, context, extensionId }) => {
  const popupUrl = `chrome-extension://${extensionId}/popup/popup.html`;
  await page.goto(popupUrl);

  const toggle = page.locator('#toggleYoutubeCaptions');
  await expect(toggle).toBeVisible();
  await toggle.click();

  await expect.poll(async () => getSetting(context, 'enableYoutubeCaptionTranslation')).toBe(true);
});
