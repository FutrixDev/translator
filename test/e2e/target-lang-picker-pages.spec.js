/**
 * The target-language dropdown on the extension's own pages — the settings page
 * and the toolbar popup — is the selection card's dropdown (shared/lang-picker.js):
 *
 *   J-TP1 the settings page shows it in the Translation Engine card, above the
 *         engine, with the interface language next to it; the filter finds a
 *         language and Enter picks it; the pick is stored
 *   J-TP2 the popup's row picks a target and stores it; a settings page open in
 *         another tab follows the change, and a later save there does not write
 *         its old value back
 *   J-TP3 both pages show the recent group the content scripts recorded
 */
const { test, expect } = require('./fixtures');
const { setExtensionSettings, getSyncSettings, pickPageTargetLang } = require('./helpers');

const popupUrl = (extensionId) => `chrome-extension://${extensionId}/popup/popup.html`;
const optionsUrl = (extensionId) => `chrome-extension://${extensionId}/options/options.html`;

test('J-TP1 the settings page puts the target dropdown in the engine card, with search', async ({ page, context, extensionId }) => {
  await setExtensionSettings(page, { targetLang: 'fr' });
  await page.goto(optionsUrl(extensionId));
  await page.waitForSelector('#provider');

  // Order inside the engine card: target language, interface language, engine.
  const order = await page.evaluate(() => {
    const card = document.getElementById('translationEngine').closest('.settings-card');
    return ['targetLang', 'uiLanguage', 'translationEngine']
      .map((id) => card.contains(document.getElementById(id)) && document.getElementById(id))
      .every((el, i, all) => el && (i === 0 || (all[i - 1].compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)));
  });
  expect(order).toBe(true);
  await expect(page.locator('#targetLang')).toHaveAttribute('data-value', 'fr');

  await page.click('#targetLang .ai-translator-lang-trigger');
  const filter = page.locator('#targetLang .ai-translator-lang-filter');
  await expect(filter).toBeFocused();
  await filter.fill('jap');
  await page.keyboard.press('Enter');
  await expect(page.locator('#targetLang .ai-translator-lang-menu')).toBeHidden();
  await expect(page.locator('#targetLang')).toHaveAttribute('data-value', 'ja');
  await expect.poll(async () => (await getSyncSettings(context, ['targetLang'])).targetLang).toBe('ja');
});

test('J-TP2 the popup picks the target, and an open settings page follows it', async ({ page, context, extensionId }) => {
  await setExtensionSettings(page, { targetLang: 'fr' });
  const options = await context.newPage();
  await options.goto(optionsUrl(extensionId));
  await options.waitForSelector('#provider');
  await expect(options.locator('#targetLang')).toHaveAttribute('data-value', 'fr');

  await page.goto(popupUrl(extensionId));
  await expect(page.locator('#popupTargetLang')).toHaveAttribute('data-value', 'fr');
  await pickPageTargetLang(page, 'de', '#popupTargetLang');
  await expect.poll(async () => (await getSyncSettings(context, ['targetLang'])).targetLang).toBe('de');

  await expect(options.locator('#targetLang')).toHaveAttribute('data-value', 'de');
  // A save of something else on the settings page keeps the popup's pick.
  const style = options.locator('#translationStyle');
  const other = await style.evaluate((s) => [...s.options].find((o) => !o.selected).value);
  await style.selectOption(other);
  await expect.poll(async () => (await getSyncSettings(context, ['translationStyle'])).translationStyle).toBe(other);
  expect((await getSyncSettings(context, ['targetLang'])).targetLang).toBe('de');

  // And the other way: the settings page's pick reaches the open popup.
  await pickPageTargetLang(options, 'es');
  await expect(page.locator('#popupTargetLang')).toHaveAttribute('data-value', 'es');
  await options.close();
});

test('J-TP3 both pages show the recent group the content scripts recorded', async ({ page, context, extensionId }) => {
  await setExtensionSettings(page, { targetLang: 'fr' });
  await page.goto(popupUrl(extensionId));
  await page.evaluate(() => chrome.storage.local.set({ recentTargetLangs: ['ja', 'ko'] }));

  for (const [target, root] of [[page, '#popupTargetLang'], [null, '#targetLang']]) {
    const p = target || await context.newPage();
    if (!target) {
      await p.goto(optionsUrl(extensionId));
      await p.waitForSelector('#provider');
    }
    await p.click(`${root} .ai-translator-lang-trigger`);
    const recent = await p.locator(`${root} .ai-translator-lang-item[data-recent]`).evaluateAll((items) => items.map((i) => i.dataset.lang));
    expect(recent, root).toEqual(['ja', 'ko']);
    await p.keyboard.press('Escape');
    await expect(p.locator(`${root} .ai-translator-lang-menu`)).toBeHidden();
    if (!target) await p.close();
  }
});
