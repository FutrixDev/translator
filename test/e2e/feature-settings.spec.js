const { test, expect } = require('./fixtures');
const {
  connectExtension, setExtensionSettings, setExtensionAccount, getServiceWorker, getSyncSetting, getDefaultProfile,
} = require('./helpers');
const { startMockBlabService } = require('./mock-blab-service');
const { getMessage } = require('../../i18n/messages');

// 这张卡上已经没有「开 / 关」了：字幕翻不翻跟着主开关和站点规则走。剩下的开关
// 里挑一个来守自动保存这条路——「视频一开就自动开字幕」。
test('options toggle updates a caption setting', async ({ page, context, extensionId }) => {
  await setExtensionSettings(page, {
    targetLang: 'en',
    apiKey: 'sk-test',
    apiEndpoint: 'https://api.openai.com/v1/chat/completions',
    modelName: 'gpt-4.1-mini',
    provider: 'openai',
  });

  const optionsUrl = `chrome-extension://${extensionId}/options/options.html`;
  await page.goto(optionsUrl);

  const toggleLabel = page.locator('label:has(#autoEnableCaptions)');
  await expect(toggleLabel).toBeVisible();
  // On by default (R33, D-351), and the page shows it that way.
  await expect(page.locator('#autoEnableCaptions')).toBeChecked();
  // No Save button any more: the toggle is the whole interaction.
  await toggleLabel.click();

  await expect.poll(async () => getSyncSetting(context, 'autoEnableCaptions')).toBe(false);
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

  await expect.poll(async () => getSyncSetting(context, 'showFloatBall')).toBe(false);
});

/**
 * Typing is debounced, so what matters is that the debounce actually fires and
 * that leaving the field does not lose the last keystrokes.
 */
test('typed fields autosave after the debounce', async ({ page, context, extensionId }) => {
  await setExtensionSettings(page, {
    targetLang: 'en',
    provider: 'custom',
    apiKey: '',
  });

  await page.goto(`chrome-extension://${extensionId}/options/options.html`);

  await page.fill('#apiKey', 'sk-typed-not-clicked');
  await page.locator('#apiKey').blur();

  // P1-D: the key lives on the default AI profile now, not in a sync key of its own.
  await expect.poll(async () => (await getDefaultProfile(context)).apiKey).toBe('sk-typed-not-clicked');
});

/**
 * Test Connection belongs to the API card now, and it is the only thing left on
 * the page that judges the credentials — so it has to name the missing field.
 */
test('test connection sits in the API card and reports the missing field', async ({ page, extensionId }) => {
  await setExtensionSettings(page, {
    targetLang: 'en',
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
    provider: 'openai',
    apiKey: '',
    modelName: 'gpt-4.1-mini',
    showFloatBall: true,
  });

  await page.goto(`chrome-extension://${extensionId}/options/options.html`);
  await page.click('label:has(#showFloatBall)');

  // The write still happens — silence is not "nothing was saved".
  await expect.poll(async () => getSyncSetting(context, 'showFloatBall')).toBe(false);
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
test('an autosave flush stays quiet while a connection test is in flight', async ({ page, context, extensionId }) => {
  await setExtensionSettings(page, {
    targetLang: 'en',
    provider: 'openai',
    apiKey: 'sk-old',
    modelName: 'gpt-4.1-mini',
  });

  // P1-D: the probe runs in the service worker (AI_PROFILE_TEST), which
  // page.route cannot see.
  await context.route('https://api.openai.com/**', async (route) => {
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

/**
 * Requirement of the free model: PDF translation ships ON for an account, and
 * switching it off has to retract every way in — the two popup rows and the two
 * context menu entries — not just grey out the settings card.
 */
test('the PDF switch is on by default and its entry points follow it', async ({ page, context, extensionId }) => {
  await setExtensionSettings(page, { targetLang: 'en' });
  // "On by default" is a statement about the preference; the entry points
  // below also need the account the feature runs on (see the next test for a
  // device without one).
  await setExtensionAccount(page);

  const popupUrl = `chrome-extension://${extensionId}/popup/popup.html`;
  await page.goto(popupUrl);
  // Not "translate this PDF" — that one needs the active tab to be a PDF.
  await expect(page.locator('#pdfTranslateLocal')).toBeVisible();

  const worker = await getServiceWorker(context);
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
  await expect.poll(async () => getSyncSetting(context, 'enablePdfTranslation')).toBe(false);

  await expect.poll(async () => worker.evaluate(() => globalThis.__pdfMenuUpdates
    .filter(u => u.id === 'translate-pdf-page' && u.visible !== undefined)
    .map(u => u.visible).at(-1))).toBe(false);
  await expect.poll(async () => worker.evaluate(() => globalThis.__pdfMenuUpdates
    .filter(u => u.id === 'translate-pdf-link' && u.visible !== undefined)
    .map(u => u.visible).at(-1))).toBe(false);

  await page.goto(popupUrl);
  // Both PDF rows start hidden in popup.html, so "hidden" proves nothing until
  // the popup has read the switches. The comic row is put on screen by the same
  // storage read, started in the same tick as the PDF one: once it shows (and a
  // beat after), the PDF gate has had its say too.
  await expect(page.locator('#comicTranslatePage')).toBeVisible();
  await page.waitForTimeout(500);
  await expect(page.locator('#pdfTranslateLocal')).toBeHidden();
  await expect(page.locator('#pdfTranslateCurrent')).toBeHidden();

  await worker.evaluate(() => { delete globalThis.__pdfMenuUpdates; });
});

/**
 * The two account-backed features, on a device with no account.
 *
 * The switches sync and the token does not, so this is the state EVERY new
 * install starts in — both features ship on, so their preference arrives
 * switched on before the user has ever signed in. The settings page shows it as
 * it is (on) and says what is missing, so the user can turn it off without an
 * account (D-365); the popup offers the entry points, and using one signs in
 * first (D-467) — only the task list, which belongs to the account, stays away.
 */
test('signed out, a switch that is on shows on and says it waits for a sign-in', async ({ page, context, extensionId }) => {
  await setExtensionSettings(page, {
    targetLang: 'en',
    // Exactly what sync delivers from a device that IS signed in.
    enableComicTranslation: true,
    enablePdfTranslation: true,
  });
  await setExtensionAccount(page, false);

  await page.goto(`chrome-extension://${extensionId}/options/options.html`);
  await expect(page.locator('#comicSignedOut')).toBeVisible();
  await expect(page.locator('#enableComicTranslation')).toBeChecked();
  await expect(page.locator('#enablePdfTranslation')).toBeChecked();
  await expect(page.locator('#comicSignInPending')).toHaveText('On. Takes effect once you sign in.');
  await expect(page.locator('#pdfSignInPending')).toHaveText('On. Takes effect once you sign in.');
  // The task list belongs to the account.
  await expect(page.locator('#pdfTasksCard')).toBeHidden();

  // The popup offers both features; using one signs in first. The task list
  // is the account's, so it is not drawn.
  await page.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await expect(page.locator('#comicTranslatePage')).toBeVisible();
  await expect(page.locator('#comicColorizePage')).toBeVisible();
  await expect(page.locator('#pdfTranslateLocal')).toBeVisible();
  await expect(page.locator('#pdfJobs')).toBeHidden();

  // And drawing the page wrote nothing: the preference belongs to the account.
  expect(await getSyncSetting(context, 'enableComicTranslation')).toBe(true);
  expect(await getSyncSetting(context, 'enablePdfTranslation')).toBe(true);
});

/**
 * The other half of the same rule: signing in is what makes the preference
 * count, without the user having to re-flip anything.
 */
test('signing in makes the stored preference count', async ({ page, context, extensionId }) => {
  await setExtensionSettings(page, {
    targetLang: 'en',
    enableComicTranslation: true,
    enablePdfTranslation: true,
  });
  // The settings page asks the account service afresh when it opens (force:
  // the Blab Translation option reads the same account, design §5.4), so the
  // seeded account cache alone is not enough: a service has to answer.
  const service = await startMockBlabService();
  try {
    await connectExtension(context, service.base, { signedIn: false, comic: true, pdf: true });

    await page.goto(`chrome-extension://${extensionId}/options/options.html`);
    await expect(page.locator('#enableComicTranslation')).toBeChecked();
    await expect(page.locator('#comicSignInPending')).toBeVisible();

    await setExtensionAccount(page, true);
    await page.reload();

    await expect(page.locator('#comicSignedIn')).toBeVisible();
    await expect(page.locator('#enableComicTranslation')).toBeChecked();
    await expect(page.locator('#enablePdfTranslation')).toBeChecked();
    await expect(page.locator('#comicSignInPending')).toBeHidden();
    await expect(page.locator('#pdfSignInPending')).toBeHidden();
    await expect(page.locator('#comicTargetLang')).toBeEnabled();
    await expect(page.locator('#pdfTargetLang')).toBeEnabled();

    await page.goto(`chrome-extension://${extensionId}/popup/popup.html`);
    await expect(page.locator('#comicTranslatePage')).toBeVisible();
    await expect(page.locator('#pdfTranslateLocal')).toBeVisible();
  } finally {
    await service.close();
  }
});

/**
 * Layout, but load-bearing: YouTube moved out of the old Feature Settings card
 * so it sits beside Translation Settings, and what is left is Advanced Settings
 * with the two account-backed features side by side.
 */
test('YouTube has its own card and Advanced Settings holds the two account features', async ({ page, extensionId }) => {
  await setExtensionSettings(page, { targetLang: 'en' });
  await page.goto(`chrome-extension://${extensionId}/options/options.html`);

  // Read the heading through the i18n key, not through a copy of the English
  // string: this test is about which card holds which control, and the card's
  // wording is not its business. It was "YouTube Settings" until subtitle
  // translation stopped being YouTube-only, and a hardcoded copy failed the
  // test on a rename that was entirely correct.
  const youtubeCard = page.locator('.settings-card:has(#autoEnableCaptions)');
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
      youtube: index('#autoEnableCaptions'),
      advanced: index('#enableComicTranslation'),
    };
  });
  expect(order.youtube).toBe(order.translation + 1);
  expect(order.advanced).toBeGreaterThan(order.youtube);
});

/**
 * 每日 AI 额度那一格数的是**所有**没人点就花到 AI 的字：自动翻译的页面，和
 * 沿用手动引擎的视频字幕。它曾经只跟着「自动模式的引擎」亮 —— 于是一个手动选了
 * AI、字幕正在花钱的人，面对的是一个灰掉的框，而那个框恰恰在替他数钱。
 */
test('the daily AI budget stays live while any unattended path can reach AI', async ({ page, extensionId }) => {
  // 从三条路都关着开始：手动内置、仅本地、自动模式也是内置。这时它才没什么可数的。
  await setExtensionSettings(page, {
    targetLang: 'en',
    apiKey: 'sk-test',
    autoTranslate: true,
    translationEngine: 'builtin',
    autoTranslateEngine: 'builtin',
    engineFallback: 'local-only',
  });

  await page.goto(`chrome-extension://${extensionId}/options/options.html`);
  const budget = page.locator('#autoAiBudgetGroup');
  await expect(budget).toHaveClass(/\bdisabled\b/);

  // 手动引擎选了 AI：字幕走它，额度要管。
  await page.selectOption('#translationEngine', 'ai');
  await expect(budget).not.toHaveClass(/\bdisabled\b/);
  await page.selectOption('#translationEngine', 'builtin');
  await expect(budget).toHaveClass(/\bdisabled\b/);

  // 允许回退到自己的接口：内置顶不住时自动页面和字幕都会花到 AI。
  await page.selectOption('#engineFallback', 'allow-ai');
  await expect(budget).not.toHaveClass(/\bdisabled\b/);
});
