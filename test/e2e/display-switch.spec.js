/**
 * The bilingual / translation-only switch and the style, from every surface
 * that writes them (design 2026-09-24-p0-c-display-styles.md §5, §7.2):
 *
 *   J-C2  the real popup page: style select and the segmented switch.
 *   J-C3  the float ball menu row, there and back.
 *   J-C4  what Alt+T does: the service worker's read-flip-write.
 *   J-C8  the options page: preview, the storage mirror, no stale write-back.
 *   + the popup display row in de / ru / es does not overflow its 280px.
 *
 * Every surface only writes chrome.storage.sync; the page's content script
 * applies it from its storage listener. So each journey asserts both ends:
 * the value stored, and the page that changed without a reload or a request.
 */
const { test, expect } = require('./fixtures');
const { startMockOpenAIServer } = require('./mock-openai-server');
const {
  getServiceWorker,
  getSyncSetting,
  openFloatBallMenu,
  setExtensionSettings,
  writeSyncSettings,
} = require('./helpers');
const { openTranslatedPage, expectTranslationOnly } = require('./display-fixtures');

const popupUrl = (extensionId) => `chrome-extension://${extensionId}/popup/popup.html`;
const optionsUrl = (extensionId) => `chrome-extension://${extensionId}/options/options.html`;

function htmlAttribute(page, name) {
  return page.evaluate((attr) => document.documentElement.getAttribute(attr), name);
}

async function rectOf(locator) {
  return locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
  });
}

test('J-C2: the popup style select and segmented switch change the page live, with no new request', async ({ page, context, extensionId }) => {
  const { endpoint, close, sentTexts } = await startMockOpenAIServer();
  try {
    await openTranslatedPage(page, context, endpoint);
    const requests = sentTexts.length;

    // The popup in a tab of its own: the page under test stays open behind it.
    const popup = await context.newPage();
    await popup.goto(popupUrl(extensionId));
    const row = popup.locator('#displayRow');
    const bilingual = popup.locator('#displayBilingual');
    const only = popup.locator('#displayTranslationOnly');
    const select = popup.locator('#translationStyleSelect');

    await expect(row).toBeVisible();
    await expect(select.locator('option')).toHaveCount(6);
    await expect(bilingual).toHaveAttribute('aria-pressed', 'true');
    await expect(only).toHaveAttribute('aria-pressed', 'false');

    // Geometry: the row is inside the popup body, and its two lines stack.
    const body = await rectOf(popup.locator('body'));
    const rowRect = await rectOf(row);
    expect(rowRect.width).toBeGreaterThan(0);
    expect(rowRect.left).toBeGreaterThanOrEqual(body.left);
    expect(rowRect.right).toBeLessThanOrEqual(body.right + 0.5);
    const segRect = await rectOf(popup.locator('.display-segment'));
    const selRect = await rectOf(select);
    expect(selRect.top).toBeGreaterThanOrEqual(segRect.bottom);

    await select.selectOption('underline');
    await expect.poll(() => getSyncSetting(context, 'translationStyle')).toBe('underline');
    await expect.poll(() => htmlAttribute(page, 'data-ai-translator-style')).toBe('underline');

    await only.click();
    await expect.poll(() => getSyncSetting(context, 'showTranslationOnly')).toBe(true);
    await expectTranslationOnly(page, true);
    await expect(only).toHaveAttribute('aria-pressed', 'true');
    await expect(bilingual).toHaveAttribute('aria-pressed', 'false');
    // The translation is still there, only the source went.
    await expect(page.locator('#p1 + p')).toBeVisible();

    await bilingual.click();
    await expect.poll(() => getSyncSetting(context, 'showTranslationOnly')).toBe(false);
    await expectTranslationOnly(page, false);
    await expect(bilingual).toHaveAttribute('aria-pressed', 'true');
    await expect(only).toHaveAttribute('aria-pressed', 'false');

    // A change made elsewhere while the popup is open shows up in the row.
    await writeSyncSettings(context, { showTranslationOnly: true, translationStyle: 'quote' });
    await expect(only).toHaveAttribute('aria-pressed', 'true');
    await expect(select).toHaveValue('quote');

    expect(sentTexts.length).toBe(requests);
  } finally {
    await close();
  }
});

test('J-C3: the float ball menu row flips translation-only and back, and its label follows', async ({ page, context }) => {
  const { endpoint, close, sentTexts } = await startMockOpenAIServer();
  try {
    await openTranslatedPage(page, context, endpoint);
    const requests = sentTexts.length;
    const row = page.locator('#ai-translator-float-menu [data-action="toggle-translation-only"]');

    await openFloatBallMenu(page);
    // Geometry: the menu is measured after it is mounted, so it sits inside the
    // viewport and does not cover the ball.
    const viewport = page.viewportSize();
    const menu = await rectOf(page.locator('#ai-translator-float-menu'));
    const ball = await rectOf(page.locator('#ai-translator-float-ball'));
    expect(menu.left).toBeGreaterThanOrEqual(0);
    expect(menu.top).toBeGreaterThanOrEqual(0);
    expect(menu.right).toBeLessThanOrEqual(viewport.width);
    expect(menu.bottom).toBeLessThanOrEqual(viewport.height);
    const overlaps = menu.left < ball.right && ball.left < menu.right && menu.top < ball.bottom && ball.top < menu.bottom;
    expect(overlaps, `menu ${JSON.stringify(menu)} covers ball ${JSON.stringify(ball)}`).toBe(false);

    await expect(row).toHaveText('Show Translation Only');
    await row.click();
    await expect.poll(() => getSyncSetting(context, 'showTranslationOnly')).toBe(true);
    await expectTranslationOnly(page, true);

    await openFloatBallMenu(page);
    await expect(row).toHaveText('Show Bilingual');
    await row.click();
    await expect.poll(() => getSyncSetting(context, 'showTranslationOnly')).toBe(false);
    await expectTranslationOnly(page, false);

    await openFloatBallMenu(page);
    await expect(row).toHaveText('Show Translation Only');

    expect(sentTexts.length).toBe(requests);
  } finally {
    await close();
  }
});

test('J-C4: the Alt+T command\'s write switches an open page both ways, live', async ({ page, context }) => {
  // Chrome does not deliver extension shortcuts in headless, so the key press
  // itself is covered by the unit test that calls runCommand
  // ('Alt+T flips showTranslationOnly and writes nothing else'). What the
  // command does is replayed here in the service worker, the same two calls
  // as toggleTranslationOnly() in background/commands.js.
  const { endpoint, close, sentTexts } = await startMockOpenAIServer();
  try {
    await openTranslatedPage(page, context, endpoint);
    const requests = sentTexts.length;
    const worker = await getServiceWorker(context);
    const toggle = () => worker.evaluate(async () => {
      const { showTranslationOnly } = await chrome.storage.sync.get({ showTranslationOnly: false });
      await chrome.storage.sync.set({ showTranslationOnly: !showTranslationOnly });
    });

    await toggle();
    await expectTranslationOnly(page, true);
    expect(await getSyncSetting(context, 'showTranslationOnly')).toBe(true);

    await toggle();
    await expectTranslationOnly(page, false);
    expect(await getSyncSetting(context, 'showTranslationOnly')).toBe(false);

    expect(sentTexts.length).toBe(requests);
  } finally {
    await close();
  }
});

test('J-C8: options previews the style, mirrors changes made elsewhere without writing, and never writes them back stale', async ({ page, context, extensionId }) => {
  await setExtensionSettings(page, { showTranslationOnly: false, translationStyle: 'default', showFloatBall: true });
  await page.goto(optionsUrl(extensionId));
  const styleSelect = page.locator('#translationStyle');
  const onlyBox = page.locator('#showTranslationOnly');
  const preview = page.locator('#translationStylePreview .ai-translator-inline-block');
  await expect(styleSelect.locator('option')).toHaveCount(6);
  await expect(styleSelect).toHaveValue('default');
  await expect(onlyBox).not.toBeChecked();

  const previewStyle = () => preview.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { decoration: cs.textDecorationLine, border: cs.borderLeftWidth };
  });
  expect(await previewStyle()).toEqual({ decoration: 'none', border: '0px' });

  // The preview follows the select, and the choice is stored.
  await styleSelect.selectOption('underline');
  await expect.poll(async () => (await previewStyle()).decoration).toBe('underline');
  await expect.poll(() => getSyncSetting(context, 'translationStyle')).toBe('underline');

  // Count every write this page makes from here on.
  const wrapped = await page.evaluate(() => {
    window.__optionsWrites = [];
    const original = chrome.storage.sync.set.bind(chrome.storage.sync);
    chrome.storage.sync.set = (items, ...rest) => {
      window.__optionsWrites.push(Object.keys(items));
      return original(items, ...rest);
    };
    return chrome.storage.sync.set !== original;
  });
  expect(wrapped).toBe(true);

  // Another surface (popup, float ball, Alt+T) changes both display keys.
  await writeSyncSettings(context, { showTranslationOnly: true, translationStyle: 'quote' });
  await expect(onlyBox).toBeChecked();
  await expect(styleSelect).toHaveValue('quote');
  await expect.poll(async () => (await previewStyle()).border).toBe('3px');
  // Mirroring is not saving: two options pages open side by side would
  // otherwise bounce the value between them.
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.__optionsWrites)).toEqual([]);

  // Now the user touches an unrelated switch on this page. The whole form is
  // saved — and must carry the mirrored values, not the ones it loaded with.
  await page.click('label:has(#showFloatBall)');
  await expect.poll(() => getSyncSetting(context, 'showFloatBall')).toBe(false);
  expect(await page.evaluate(() => window.__optionsWrites.length)).toBeGreaterThan(0);
  expect(await getSyncSetting(context, 'showTranslationOnly')).toBe(true);
  expect(await getSyncSetting(context, 'translationStyle')).toBe('quote');
});

for (const uiLanguage of ['de', 'ru', 'es']) {
  test(`the popup display row fits its 280px in ${uiLanguage}`, async ({ page, extensionId }) => {
    await setExtensionSettings(page, { uiLanguage });
    await page.goto(popupUrl(extensionId));
    const row = page.locator('#displayRow');
    await expect(row).toBeVisible();
    // The labels really are translated (not the English fallback).
    await expect(page.locator('#displayTranslationOnly')).not.toHaveText('Translation only');

    const fit = await page.evaluate(() => {
      const body = document.body.getBoundingClientRect();
      const row = document.getElementById('displayRow');
      const parts = [row, ...row.querySelectorAll('button, select, .display-segment, .display-style')];
      return {
        bodyWidth: body.width,
        docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        bodyOverflow: document.body.scrollWidth - document.body.clientWidth,
        parts: parts.map((el) => ({
          id: el.id || el.className || el.tagName,
          overflow: el.scrollWidth - el.clientWidth,
          left: el.getBoundingClientRect().left - body.left,
          right: el.getBoundingClientRect().right - body.right,
        })),
      };
    });
    expect(fit.bodyWidth).toBe(280);
    expect(fit.docOverflow).toBeLessThanOrEqual(0);
    expect(fit.bodyOverflow).toBeLessThanOrEqual(0);
    for (const part of fit.parts) {
      expect(part.overflow, `${part.id} scrolls sideways`).toBeLessThanOrEqual(0);
      expect(part.left, `${part.id} starts left of the body`).toBeGreaterThanOrEqual(-0.5);
      expect(part.right, `${part.id} ends right of the body`).toBeLessThanOrEqual(0.5);
    }
  });
}
