const { test, expect } = require('./fixtures');
const { setExtensionSettings, setExtensionAccount } = require('./helpers');
const { getMessage } = require('../../i18n/messages');

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

/**
 * Autosave is silent: it fires on every keystroke and every toggle, so
 * confirming each write turned the strip into a flashing banner and trained
 * users to ignore the one place hotkey conflicts and connection failures
 * appear. Changing a setting must leave the strip alone entirely.
 */
test('changing a setting says nothing', async ({ page, context, extensionId }) => {
  await setExtensionSettings(page, {
    targetLang: 'en',
    targetLangSetByUser: true,
    provider: 'openai',
    apiKey: '',
    modelName: 'gpt-4.1-mini',
    showFloatBall: true,
  });

  await page.goto(`chrome-extension://${extensionId}/options/options.html`);
  await page.click('label:has(#showFloatBall)');

  // The write still happens — silence is not "nothing was saved".
  await expect.poll(async () => getSetting(context, 'showFloatBall')).toBe(false);
  await expect(page.locator('#statusMessage')).toBeHidden();
});

/**
 * One status strip serves connection tests, sign-in, presets and rejected
 * hotkeys, so the two ways a routine message could trample a connection result
 * both need pinning.
 *
 * First: a success message auto-hides after three seconds, and that timer used
 * to be left running. Anything that appeared in the meantime got blanked along
 * with it.
 */
test('a success message does not blank a later message when it expires', async ({ page, extensionId }) => {
  await setExtensionSettings(page, {
    targetLang: 'en',
    targetLangSetByUser: true,
    provider: 'openai',
    apiKey: '',
    modelName: 'gpt-4.1-mini',
  });

  await page.goto(`chrome-extension://${extensionId}/options/options.html`);

  // Arms the three-second hide.
  await page.click('.btn-preset');
  await expect(page.locator('#statusMessage')).toContainText('Preset applied');

  // Well inside that window, put something the user must not lose.
  await page.click('#testConnection');
  await expect(page.locator('#statusMessage')).toContainText('API Key');

  await page.waitForTimeout(3500);
  await expect(page.locator('#statusMessage')).toBeVisible();
  await expect(page.locator('#statusMessage')).toContainText('API Key');
});

/**
 * Second: clicking Test Connection blurs whatever credential field is being
 * edited, so the autosave flush runs concurrently with the probe. That flush
 * must not answer a question the user asked of the API.
 */
test('an autosave flush stays quiet while a connection test is in flight', async ({ page, extensionId }) => {
  await setExtensionSettings(page, {
    targetLang: 'en',
    targetLangSetByUser: true,
    provider: 'openai',
    apiKey: 'sk-old',
    modelName: 'gpt-4.1-mini',
  });

  await page.route('https://api.openai.com/**', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ choices: [{ message: { content: 'hi' } }] }),
    });
  });

  await page.goto(`chrome-extension://${extensionId}/options/options.html`);

  // Edit the key and click straight to the button: the click blurs the field,
  // which flushes the pending save into the middle of the probe.
  await page.fill('#apiKey', 'sk-edited-then-tested');
  await page.click('#testConnection');

  // Mid-probe. The write has long since landed — this is about who gets to
  // speak, not about whether the save happened.
  await page.waitForTimeout(900);
  await expect(page.locator('#statusMessage')).toContainText('Translating');

  await expect(page.locator('#statusMessage')).toContainText('Connection Successful', { timeout: 5000 });
});

test('popup toggle updates youtube caption setting', async ({ page, context, extensionId }) => {
  const popupUrl = `chrome-extension://${extensionId}/popup/popup.html`;
  await page.goto(popupUrl);

  const toggle = page.locator('#toggleYoutubeCaptions');
  await expect(toggle).toBeVisible();
  await toggle.click();

  await expect.poll(async () => getSetting(context, 'enableYoutubeCaptionTranslation')).toBe(true);
});

/**
 * Requirement of the free model: PDF translation ships ON for an account, and
 * switching it off has to retract every way in — the two popup rows and the two
 * context menu entries — not just grey out the settings card.
 */
test('the PDF switch is on by default and its entry points follow it', async ({ page, context, extensionId }) => {
  await setExtensionSettings(page, { targetLang: 'en', targetLangSetByUser: true });
  // "On by default" is a statement about the preference, and the preference
  // only reaches the screen on a device that has the account the feature runs
  // on. Signed out it is off no matter what — the test below this one.
  await setExtensionAccount(page);

  const popupUrl = `chrome-extension://${extensionId}/popup/popup.html`;
  await page.goto(popupUrl);
  // Not "translate this PDF" — that one needs the active tab to be a PDF.
  await expect(page.locator('#pdfTranslateLocal')).toBeVisible();

  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  await worker.evaluate(async () => {
    globalThis.__pdfMenuUpdates = [];
    const original = chrome.contextMenus.update.bind(chrome.contextMenus);
    chrome.contextMenus.update = (id, props, cb) => {
      globalThis.__pdfMenuUpdates.push({ id, visible: props && props.visible });
      return original(id, props, cb);
    };
  });

  await page.goto(`chrome-extension://${extensionId}/options/options.html`);
  await expect(page.locator('#enablePdfTranslation')).toBeChecked();
  await page.click('label:has(#enablePdfTranslation)');
  await expect.poll(async () => getSetting(context, 'enablePdfTranslation')).toBe(false);

  await expect.poll(async () => worker.evaluate(() => globalThis.__pdfMenuUpdates
    .filter(u => u.id === 'translate-pdf-page' && u.visible !== undefined)
    .map(u => u.visible).at(-1))).toBe(false);
  await expect.poll(async () => worker.evaluate(() => globalThis.__pdfMenuUpdates
    .filter(u => u.id === 'translate-pdf-link' && u.visible !== undefined)
    .map(u => u.visible).at(-1))).toBe(false);

  await page.goto(popupUrl);
  await expect(page.locator('#pdfTranslateLocal')).toBeHidden();
  await expect(page.locator('#pdfTranslateThis')).toBeHidden();

  await worker.evaluate(() => { delete globalThis.__pdfMenuUpdates; });
});

/**
 * The rule the two account-backed features are subject to and no other setting
 * is: a device with no account cannot run either, so neither may show as on.
 *
 * The switches sync and the token does not, so this is the state EVERY new
 * install starts in — PDF ships on, so its preference arrives switched on
 * before the user has ever signed in. Showing that as an on switch offers a
 * feature whose every entry point can only answer "sign in".
 */
test('signed out, both account features read off however the preference arrived', async ({ page, context, extensionId }) => {
  await setExtensionSettings(page, {
    targetLang: 'en',
    targetLangSetByUser: true,
    // Exactly what sync delivers from a device that IS signed in.
    enableComicTranslation: true,
    enablePdfTranslation: true,
  });
  await setExtensionAccount(page, false);

  await page.goto(`chrome-extension://${extensionId}/options/options.html`);
  await expect(page.locator('#comicSignedOut')).toBeVisible();
  await expect(page.locator('#enableComicTranslation')).not.toBeChecked();
  await expect(page.locator('#enablePdfTranslation')).not.toBeChecked();
  // A switch that reads off must not leave its language select live.
  await expect(page.locator('#comicTargetLang')).toBeDisabled();
  await expect(page.locator('#pdfTargetLang')).toBeDisabled();

  // Every other way in is gone too — the switch is not merely cosmetic.
  await page.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await expect(page.locator('#comicTranslatePage')).toBeHidden();
  await expect(page.locator('#comicColorizePage')).toBeHidden();
  await expect(page.locator('#pdfTranslateLocal')).toBeHidden();

  // And the preference itself is untouched: it belongs to the account, not to
  // this device. Writing it off here would sync back and disable the feature on
  // the device that is still signed in.
  expect(await getSetting(context, 'enableComicTranslation')).toBe(true);
  expect(await getSetting(context, 'enablePdfTranslation')).toBe(true);
});

/**
 * The other half of the same rule: signing in is what makes the preference
 * count again, without the user having to re-flip anything.
 */
test('signing in restores the preference the signed-out device was hiding', async ({ page, context, extensionId }) => {
  await setExtensionSettings(page, {
    targetLang: 'en',
    targetLangSetByUser: true,
    enableComicTranslation: true,
    enablePdfTranslation: true,
  });
  await setExtensionAccount(page, false);

  await page.goto(`chrome-extension://${extensionId}/options/options.html`);
  await expect(page.locator('#enableComicTranslation')).not.toBeChecked();

  await setExtensionAccount(page, true);
  await page.reload();

  await expect(page.locator('#comicSignedIn')).toBeVisible();
  await expect(page.locator('#enableComicTranslation')).toBeChecked();
  await expect(page.locator('#enablePdfTranslation')).toBeChecked();
  await expect(page.locator('#comicTargetLang')).toBeEnabled();
  await expect(page.locator('#pdfTargetLang')).toBeEnabled();

  await page.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await expect(page.locator('#comicTranslatePage')).toBeVisible();
  await expect(page.locator('#pdfTranslateLocal')).toBeVisible();
});

/**
 * Layout, but load-bearing: YouTube moved out of the old Feature Settings card
 * so it sits beside Translation Settings, and what is left is Advanced Settings
 * with the two account-backed features side by side.
 */
test('YouTube has its own card and Advanced Settings holds the two account features', async ({ page, extensionId }) => {
  await setExtensionSettings(page, { targetLang: 'en', targetLangSetByUser: true });
  await page.goto(`chrome-extension://${extensionId}/options/options.html`);

  // Read the heading through the i18n key, not through a copy of the English
  // string: this test is about which card holds which control, and the card's
  // wording is not its business. It was "YouTube Settings" until subtitle
  // translation stopped being YouTube-only, and a hardcoded copy failed the
  // test on a rename that was entirely correct.
  const youtubeCard = page.locator('.settings-card:has(#enableYoutubeCaptionTranslation)');
  await expect(youtubeCard).toContainText(getMessage('youtubeSettings', 'en'));
  // Its own card, not the one comic and PDF live in.
  await expect(youtubeCard.locator('#enableComicTranslation')).toHaveCount(0);

  const advanced = page.locator('#advancedSettingsCard');
  await expect(advanced).toHaveText(/Advanced Settings/);
  await expect(advanced.locator('#comicFeatureCard #enableComicTranslation')).toHaveCount(1);
  await expect(advanced.locator('#pdfFeatureCard #enablePdfTranslation')).toHaveCount(1);
  // One account panel above both columns, not one per feature.
  await expect(advanced.locator('#comicAccountCard')).toHaveCount(1);

  // Translation Settings comes first, so the YouTube card is the one to its
  // right in the auto-fit grid.
  const order = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.settings-card')];
    const index = (selector) => cards.findIndex(card => card.querySelector(selector));
    return {
      translation: index('#enableSelection'),
      youtube: index('#enableYoutubeCaptionTranslation'),
      advanced: index('#enableComicTranslation'),
    };
  });
  expect(order.youtube).toBe(order.translation + 1);
  expect(order.advanced).toBeGreaterThan(order.youtube);
});
