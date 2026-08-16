const { test, expect } = require('./fixtures');
const { getMessage } = require('../../i18n/messages');
const { setExtensionSettings, getSyncSettings } = require('./helpers');

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

  // There is deliberately no OCR language picker: nobody can pre-declare what
  // language an image will contain, so recognition always runs the auto plan.
  await expect(page.locator('#ocrSourceLanguage')).toHaveCount(0);
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
 * A shared hotkey is not cosmetic. Both content scripts listen on document in
 * the capture phase, selection registered first, so one press runs both:
 * selection registers the block synchronously and fires its API request, hover
 * then reads that registration as "already translated" and clears it, bumping
 * the request id so the response is discarded on arrival. The call is still
 * billed and the user sees nothing. So the pair must never be persisted.
 *
 * Autosave only changes what the refusal looks like — with no Save button left
 * to reconcile them, the control snaps back rather than leaving the rejected
 * value on screen.
 */
test('options refuse to persist a conflicting hotkey and snap the control back', async ({ page, context, extensionId }) => {
  await setExtensionSettings(page, {
    targetLang: 'en',
    targetLangSetByUser: true,
    apiKey: 'sk-test',
    apiEndpoint: 'https://api.openai.com/v1/chat/completions',
    modelName: 'gpt-4.1-mini',
    provider: 'openai',
    enableSelection: true,
    enableHoverTranslation: true,
    selectionTranslationHotkey: 'Alt',
    hoverTranslationHotkey: 'Shift',
  });

  const optionsUrl = `chrome-extension://${extensionId}/options/options.html`;
  await page.goto(optionsUrl);
  await page.waitForSelector('#provider');

  await page.selectOption('#hoverTranslationHotkey', 'Control');
  await page.selectOption('#selectionTranslationHotkey', 'Control');

  await expect(page.locator('#statusMessage')).toHaveText(getMessage('hotkeyConflict', 'en'));
  // Snapped back, so the page is not claiming a setting that was refused.
  await expect(page.locator('#selectionTranslationHotkey')).toHaveValue('Alt');

  const stored = await getSyncSettings(context, ['selectionTranslationHotkey', 'hoverTranslationHotkey']);
  expect(stored.selectionTranslationHotkey).toBe('Alt');
  expect(stored.hoverTranslationHotkey).toBe('Control');
});

/**
 * A build of this branch persisted conflicts before the guard existed, so the
 * broken pair can already be in storage. The guard alone cannot reach it — the
 * next edit would just revert to the broken baseline — so the load path has to
 * break the tie itself.
 */
test('a conflicting pair already in storage is resolved on load', async ({ page, context, extensionId }) => {
  await setExtensionSettings(page, {
    targetLang: 'en',
    targetLangSetByUser: true,
    enableSelection: true,
    enableHoverTranslation: true,
    selectionTranslationHotkey: 'Control',
    hoverTranslationHotkey: 'Control',
  });

  await page.goto(`chrome-extension://${extensionId}/options/options.html`);
  await page.waitForSelector('#provider');

  await expect(page.locator('#statusMessage')).toHaveText(getMessage('hotkeyConflict', 'en'));
  await expect(page.locator('#hoverTranslationHotkey')).not.toHaveValue('Control');

  const stored = await getSyncSettings(context, ['selectionTranslationHotkey', 'hoverTranslationHotkey']);
  expect(stored.selectionTranslationHotkey).toBe('Control');
  expect(stored.hoverTranslationHotkey).not.toBe('Control');
});
