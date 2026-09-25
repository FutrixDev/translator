/**
 * The welcome page a fresh install opens (design
 * docs/plans/2026-09-25-p0-f-onboarding-transfer.md §2, §13).
 *
 *   J-F1  a fresh install opens it, once, and it lays out in one screen
 *   J-F2  choosing a language writes targetLang
 *   J-F3  the on-device path shows the pack status and downloads on a click
 *   J-F4  "Set up AI" on this computer writes the preset and deep-links to the
 *         settings page's connection card, which is on screen when it opens
 *
 * Every journey ends in a geometry check (layout-checks.js): rendered, inside
 * the 1280x720 viewport, nothing overlapping, text at 4.5:1 or better. The
 * dark palette is measured in J-F1 and J-F3 — J-F3 because the download
 * button is the one primary button on the page.
 */
const { test, expect } = require('./fixtures');
const { getMessage } = require('../../i18n/messages');
const { setExtensionSettings, getSyncSettings, writeSyncSettings } = require('./helpers');
const { expectLaidOut } = require('./layout-checks');

const en = (key) => getMessage(key, 'en');
const onboardingUrl = (extensionId) => `chrome-extension://${extensionId}/onboarding/onboarding.html`;

async function openOnboarding(page, extensionId) {
  await page.goto(onboardingUrl(extensionId));
  await page.waitForFunction(() => document.documentElement.dataset.ready === 'true');
}

function report(label, text) {
  console.log(`${label}: ${text}`);
  test.info().annotations.push({ type: label, description: text });
}

test.describe('the welcome page a fresh install opens', () => {
  test.use({ keepOnboarding: true });

  test('J-F1 a fresh install opens the welcome page once, and it fits one screen in both themes', async ({ context, extensionId }) => {
    const opened = context.pages().filter((p) => p.url().startsWith(onboardingUrl(extensionId)));
    expect(opened).toHaveLength(1);
    const page = opened[0];

    // It opened before the fixture wrote the harness's base settings; draw it
    // again with them, in the dark palette first.
    await writeSyncSettings(context, { theme: 'dark' });
    await page.reload();
    await page.waitForFunction(() => document.documentElement.dataset.ready === 'true');
    await expect(page).toHaveTitle(en('onboardingPageTitle'));
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    // The four sections and the two footer buttons, one screen, nothing on top
    // of anything.
    const blocks = ['#builtinSection', '#targetSection', '#engineSection', '#shortcutSection', '#openSettings', '#done'];
    report('J-F1 dark blocks', await expectLaidOut(page, blocks, 'J-F1 dark blocks'));
    const texts = ['#onboardingTitle', '.lead', '#builtinSection h2', '#builtinStatus', '#targetLang',
      '#engineSection h2', '#shortcutSection h2', '#shortcutSection .desc', '#openSettings', '#done'];
    report('J-F1 dark text', await expectLaidOut(page, texts, 'J-F1 dark text'));

    // The shortcut list is the manifest's commands, each with its keys or "Not set".
    const rows = page.locator('#shortcutList .shortcut');
    await expect(rows).toHaveCount(2);
    await expect(rows.locator('.shortcut-label')).toHaveText([en('translatePage'), en('showTranslationOnly')]);
    for (const keys of await rows.locator('.shortcut-keys').allTextContents()) {
      expect(keys.trim().length).toBeGreaterThan(0);
    }
    await expect(page.locator('#shortcutSection .desc')).toContainText('chrome://extensions/shortcuts');

    await writeSyncSettings(context, { theme: 'light' });
    await page.reload();
    await page.waitForFunction(() => document.documentElement.dataset.ready === 'true');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    report('J-F1 light text', await expectLaidOut(page, texts, 'J-F1 light text'));

    // Reloading is not installing: still exactly one welcome tab.
    expect(context.pages().filter((p) => p.url().startsWith(onboardingUrl(extensionId)))).toHaveLength(1);
  });
});

test('J-F2 choosing a language on the welcome page writes targetLang', async ({ page, context, extensionId }) => {
  await setExtensionSettings(page, { targetLang: '' });
  await openOnboarding(page, extensionId);

  const select = page.locator('#targetLang');
  await select.selectOption('ja');
  await expect.poll(async () => (await getSyncSettings(context, ['targetLang'])).targetLang).toBe('ja');
  await expect(page.locator('#onboardingError')).toBeHidden();

  // Still set after a reload: the page shows what is stored, not what it drew.
  await page.reload();
  await page.waitForFunction(() => document.documentElement.dataset.ready === 'true');
  await expect(select).toHaveValue('ja');
  report('J-F2 layout', await expectLaidOut(page, ['label[for="targetLang"]', '#targetLang', '#targetSection .desc'], 'J-F2'));
});

test('J-F3 the on-device path shows the language pack status and downloads it on a click', async ({ page, context, extensionId }) => {
  // e2e Chromium has no Translator API; stub it in the page's own world, as
  // target-languages.spec.js J-B2 does. 'downloadable' until a create() has
  // run, then 'available' — which is what a real download does to the answer.
  await page.addInitScript(() => {
    let status = 'downloadable';
    self.__createCalls = [];
    self.Translator = {
      availability: async () => status,
      create: async (options) => {
        self.__createCalls.push({ source: options.sourceLanguage, target: options.targetLanguage });
        if (typeof options.monitor === 'function') {
          const monitor = new EventTarget();
          options.monitor(monitor);
          monitor.dispatchEvent(Object.assign(new Event('downloadprogress'), { loaded: 1 }));
        }
        status = 'available';
        return { translate: async (text) => text, destroy() {} };
      },
    };
  });
  await setExtensionSettings(page, { translationEngine: 'builtin', engineFallback: 'local-only', targetLang: 'fr', theme: 'dark' });
  await openOnboarding(page, extensionId);

  const status = page.locator('#builtinStatus');
  const download = page.locator('#downloadLanguagePack');
  await expect(status).toHaveText(en('builtinDownloadable'));
  await expect(download).toBeVisible();
  // Opening the page downloads nothing: that is the user's click to make.
  expect(await page.evaluate(() => self.__createCalls.length)).toBe(0);
  report('J-F3 dark', await expectLaidOut(page, ['#builtinStatus', '#downloadLanguagePack', '#builtinSection h2', '#builtinSection .desc'], 'J-F3 dark'));

  await download.click();
  await expect(status).toHaveText(en('builtinReady'));
  await expect(download).toBeHidden();
  expect(await page.evaluate(() => self.__createCalls)).toEqual([{ source: 'en', target: 'fr' }]);

  // Nothing about the engine changed just by downloading.
  expect((await getSyncSettings(context, ['translationEngine'])).translationEngine).toBe('builtin');
});

test('J-F4 setting up AI on this computer writes the preset and opens the connection card', async ({ page, context, extensionId }) => {
  await setExtensionSettings(page, { translationEngine: 'builtin', provider: 'openai', apiEndpoint: 'https://api.openai.com/v1/chat/completions', modelName: 'gpt-4.1-mini' });
  await openOnboarding(page, extensionId);

  await expect(page.locator('#aiProviders')).toBeHidden();
  await page.locator('#engineAi').check();
  await expect(page.locator('#aiProviders')).toBeVisible();
  // Choosing "AI" alone writes nothing: where it runs is still unanswered.
  expect((await getSyncSettings(context, ['translationEngine'])).translationEngine).toBe('builtin');
  report('J-F4 buttons', await expectLaidOut(page, ['#aiOllama', '#aiLmStudio', '#aiCloud', '#aiProviders .desc'], 'J-F4 buttons'));

  const preset = await page.evaluate(() => APICompat.PROVIDERS.ollama);
  const [settingsPage] = await Promise.all([
    context.waitForEvent('page', { predicate: (p) => p.url().includes('/options/options.html') }),
    page.locator('#aiOllama').click(),
  ]);

  await expect.poll(async () => getSyncSettings(context, ['translationEngine', 'provider', 'apiEndpoint', 'modelName'])).toEqual({
    translationEngine: 'ai',
    provider: 'ollama',
    apiEndpoint: preset.endpoint,
    modelName: preset.defaultModel || '',
  });

  expect(new URL(settingsPage.url()).hash).toBe('#apiSettingsCard');
  await settingsPage.waitForSelector('#provider');
  await expect(settingsPage.locator('#provider')).toHaveValue('ollama');
  const card = settingsPage.locator('#apiSettingsCard');
  await expect(card).toBeInViewport();
  const top = await card.evaluate((el) => el.getBoundingClientRect().top);
  // The anchor lands the card at the top of the window, not merely somewhere on it.
  expect(top).toBeGreaterThanOrEqual(0);
  expect(top).toBeLessThan(120);
  await settingsPage.close();
});
