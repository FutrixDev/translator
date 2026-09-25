/**
 * J-C5 — the source-peek card (design 2026-09-24-p0-c-display-styles.md §4,
 * §7.2). In translation-only mode the source is hidden; pointing at a page
 * translation shows its source in a small card, and every way of putting the
 * card away works: pointer leaves, Esc, a second tap.
 *
 * Geometry is the point of a floating card, so every opening asserts it: fully
 * inside the viewport (with its 8px margin), at most 12px from the
 * translation, and never under the pointer that opened it.
 */
const { test, expect } = require('./fixtures');
const { startMockOpenAIServer } = require('./mock-openai-server');
const { writeSyncSettings } = require('./helpers');
const { openTranslatedPage, expectTranslationOnly, touchTap } = require('./display-fixtures');

const CARD = '#ai-translator-source-peek';
const MAX_GAP_PX = 12;
const VIEWPORT_MARGIN_PX = 8;

async function parkPointer(page) {
  await page.mouse.move(2, 715);
}

function rectOf(locator) {
  return locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  });
}

/** The card is up, shows `sourceText`, and sits where §4 says it may. */
async function expectCardFor(page, translation, sourceText, pointer) {
  const card = page.locator(CARD);
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute('role', 'tooltip');
  await expect(card.locator('.ai-translator-source-peek-text')).toHaveText(sourceText);
  await expect(card.locator('.ai-translator-source-peek-label')).not.toHaveText('');

  const viewport = page.viewportSize();
  const box = await rectOf(card);
  const anchor = await rectOf(translation);
  expect(box.left).toBeGreaterThanOrEqual(VIEWPORT_MARGIN_PX - 0.5);
  expect(box.top).toBeGreaterThanOrEqual(VIEWPORT_MARGIN_PX - 0.5);
  expect(box.right).toBeLessThanOrEqual(viewport.width - VIEWPORT_MARGIN_PX + 0.5);
  expect(box.bottom).toBeLessThanOrEqual(viewport.height - VIEWPORT_MARGIN_PX + 0.5);

  const gap = box.top >= anchor.bottom ? box.top - anchor.bottom : anchor.top - box.bottom;
  expect(gap, `card ${JSON.stringify(box)} vs translation ${JSON.stringify(anchor)}`).toBeGreaterThanOrEqual(0);
  expect(gap).toBeLessThanOrEqual(MAX_GAP_PX);

  if (pointer) {
    const under = pointer.x >= box.left && pointer.x <= box.right && pointer.y >= box.top && pointer.y <= box.bottom;
    expect(under, `pointer ${JSON.stringify(pointer)} is under the card ${JSON.stringify(box)}`).toBe(false);
  }
}

test('J-C5: the source-peek card opens on hover and tap, and closes on leave, Esc and a second tap', async ({ page, context }) => {
  const { endpoint, close, sentTexts } = await startMockOpenAIServer();
  try {
    await openTranslatedPage(page, context, endpoint);
    await parkPointer(page);
    const requests = sentTexts.length;
    const translation = page.locator('#p1 + p');
    const sourceText = (await page.locator('#p1').textContent()).trim();

    // Bilingual: the source is on screen, so hovering opens nothing.
    const box = await translation.boundingBox();
    const pointer = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await page.mouse.move(pointer.x, pointer.y);
    await page.waitForTimeout(600);
    await expect(page.locator(CARD)).toHaveCount(0);
    await parkPointer(page);

    await writeSyncSettings(context, { showTranslationOnly: true });
    await expectTranslationOnly(page, true);
    // Translation-only moves the translation up into the source's place.
    const onlyBox = await translation.boundingBox();
    const onlyPointer = { x: onlyBox.x + onlyBox.width / 2, y: onlyBox.y + onlyBox.height / 2 };

    // 1. Hover opens it; leaving closes it.
    await page.mouse.move(onlyPointer.x, onlyPointer.y);
    await expectCardFor(page, translation, sourceText, onlyPointer);
    await parkPointer(page);
    await expect(page.locator(CARD)).toHaveCount(0);

    // 2. Esc closes it with the pointer still on the translation.
    await page.mouse.move(onlyPointer.x, onlyPointer.y);
    await expectCardFor(page, translation, sourceText, onlyPointer);
    await page.keyboard.press('Escape');
    await expect(page.locator(CARD)).toHaveCount(0);
    await parkPointer(page);

    // 3. A finger has no hover: a tap opens it, a second tap closes it.
    await touchTap(page, translation);
    await expectCardFor(page, translation, sourceText, null);
    await touchTap(page, translation);
    await expect(page.locator(CARD)).toHaveCount(0);

    // Showing the source never asks the model for anything.
    expect(sentTexts.length).toBe(requests);
  } finally {
    await close();
  }
});
