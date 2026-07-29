const { test, expect } = require('./fixtures');
const { getMessage } = require('../../i18n/messages');
const { setExtensionSettings } = require('./helpers');

test('options hints use i18n keys', async ({ page, extensionId }) => {
  await setExtensionSettings(page, {
    targetLang: 'en',
    targetLangSetByUser: true,
  });

  const optionsUrl = `chrome-extension://${extensionId}/options/options.html`;
  await page.goto(optionsUrl);
  await page.waitForSelector('#provider');

  const hint = page.locator('[data-i18n-hint="hintApiEndpoint"]');
  await expect(hint).toHaveCount(1);
  await expect(hint).toHaveText(getMessage('hintApiEndpoint', 'en'));

  await expect(page.locator('#apiKey')).toHaveAttribute('placeholder', getMessage('placeholderApiKey', 'en'));
  await expect(page.locator('#toggleApiKey')).toHaveAttribute('title', getMessage('toggleApiKey', 'en'));
  await expect(page.locator('#provider option[value="openai"]')).toHaveText(getMessage('providerOpenai', 'en'));
  await expect(page.locator('#targetLang option[value="zh-CN"]')).toHaveText(getMessage('langZhCN', 'en'));
});

test('options disable selects when toggles are off', async ({ page, extensionId }) => {
  await setExtensionSettings(page, {
    targetLang: 'en',
    targetLangSetByUser: true,
  });

  const optionsUrl = `chrome-extension://${extensionId}/options/options.html`;
  await page.goto(optionsUrl);
  await page.waitForSelector('#provider');

  await expect(page.locator('#selectionTranslationMode')).toBeEnabled();
  await expect(page.locator('#selectionTranslationHotkey')).toBeEnabled();
  await expect(page.locator('#hoverTranslationHotkey')).toBeEnabled();

  await page.click('label:has(#enableSelection)');
  await expect(page.locator('#selectionTranslationMode')).toBeDisabled();
  await expect(page.locator('#selectionTranslationHotkey')).toBeDisabled();

  await page.click('label:has(#enableHoverTranslation)');
  await expect(page.locator('#hoverTranslationHotkey')).toBeDisabled();
});

/**
 * The conflict used to abort the save. Under autosave that would leave the
 * stored value and the visible one disagreeing with no way to reconcile them,
 * so the write goes through and the page says what is wrong instead — and the
 * warning is an error, which does not auto-hide, so it outlives the save toast.
 */
test('options warn about hotkey conflicts without dropping the change', async ({ page, context, extensionId }) => {
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
  await page.waitForSelector('#provider');

  await page.selectOption('#hoverTranslationHotkey', 'Control');
  await page.selectOption('#selectionTranslationHotkey', 'Control');

  await expect(page.locator('#statusMessage')).toHaveText(getMessage('hotkeyConflict', 'en'));

  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const stored = await worker.evaluate(() => new Promise((resolve) => {
    chrome.storage.sync.get(['selectionTranslationHotkey'], (r) => resolve(r.selectionTranslationHotkey));
  }));
  expect(stored).toBe('Control');
});
