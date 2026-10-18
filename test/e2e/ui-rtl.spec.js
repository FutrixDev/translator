// An Arabic interface reads right to left everywhere it is drawn: the
// extension's own pages (popup, settings) through TargetLang.mark on <html>,
// and the panels drawn into a page (float ball menu, input dialog) through
// data-ai-translator-ui-dir on the page's <html>. Switching to a left-to-right
// language (French) puts the panels back to left to right without a reload.
//
// Each journey also saves a screenshot to its output directory, the record of
// what the RTL layout looks like.
const { test, expect } = require('./fixtures');
const { openExamplePage, openFloatBallMenu, openInputDialogFromMenu, writeSyncSettings } = require('./helpers');

const direction = (page, selector) =>
  page.locator(selector).evaluate((el) => getComputedStyle(el).direction);

test('ui-rtl: popup and settings page are drawn right to left in Arabic', async ({ context, extensionId, page }, testInfo) => {
  await writeSyncSettings(context, { uiLanguage: 'ar' });

  await page.setViewportSize({ width: 420, height: 640 });
  await page.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
  expect(await direction(page, 'body')).toBe('rtl');
  await page.screenshot({ path: testInfo.outputPath('popup-ar.png'), fullPage: true });

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`chrome-extension://${extensionId}/options/options.html`);
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  expect(await direction(page, 'body')).toBe('rtl');
  await page.screenshot({ path: testInfo.outputPath('options-ar.png') });
});

test('ui-rtl: the float ball menu and input dialog follow the interface direction', async ({ context, page }, testInfo) => {
  await writeSyncSettings(context, { uiLanguage: 'ar' });
  await openExamplePage(page);
  await expect(page.locator('html')).toHaveAttribute('data-ai-translator-ui-dir', 'rtl');
  // The page itself is not ours: its direction stays as it was.
  expect(await direction(page, 'body')).toBe('ltr');

  await openFloatBallMenu(page);
  expect(await direction(page, '#ai-translator-float-menu')).toBe('rtl');
  await page.screenshot({ path: testInfo.outputPath('float-menu-ar.png') });

  await openInputDialogFromMenu(page);
  expect(await direction(page, '#ai-translator-input-dialog')).toBe('rtl');
  await page.screenshot({ path: testInfo.outputPath('input-dialog-ar.png') });

  await writeSyncSettings(context, { uiLanguage: 'fr' });
  await expect(page.locator('html')).toHaveAttribute('data-ai-translator-ui-dir', 'ltr');
  expect(await direction(page, '#ai-translator-input-dialog')).toBe('ltr');
});
