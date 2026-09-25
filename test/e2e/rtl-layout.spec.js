/**
 * Right-to-left layout (design 2026-09-24-p0-b-target-languages-rtl.md §6, §7,
 * §10.2). Every translation we put on a page carries its own lang/dir, aligns
 * to its own start edge when the source runs the other way, and leaves the
 * icon indent and the nav gap on the source's start side.
 *
 *   J-B3  Arabic, bilingual, on an English page
 *   J-B4  Hebrew, translation only, on an English page
 *   J-B5  an RTL (Hebrew) page translated into English
 *   J-B6  the RTL page's horizontal nav
 *   J-B7  hover translation: loading state in the UI language, result in Arabic
 */
const { test, expect } = require('./fixtures');
const { startMockOpenAIServer } = require('./mock-openai-server');
const {
  openPage,
  openTranslatedPage,
  measure,
  expectRightAligned,
  expectLeftAligned,
  sourceInset,
} = require('./rtl-fixtures');

const TRANSLATIONS = '#main > p.ai-translator-inline-block';

async function expectEveryTranslationMarked(page, lang, dir) {
  const marks = await page.locator('.ai-translator-inline-block').evaluateAll(
    (els) => els.map((el) => ({ lang: el.lang, dir: el.dir })),
  );
  expect(marks.length).toBeGreaterThan(0);
  for (const mark of marks) expect(mark).toEqual({ lang, dir });
}

test('J-B3 an Arabic translation of an English page is marked, right-aligned, and keeps the icon indent on the left', async ({ page, context }) => {
  const api = await startMockOpenAIServer();
  try {
    await openTranslatedPage(page, context, api.endpoint, { path: 'ltr', targetLang: 'ar' });
    await expectEveryTranslationMarked(page, 'ar', 'rtl');

    const translations = page.locator(TRANSLATIONS);
    for (let i = 0; i < await translations.count(); i += 1) {
      await expectRightAligned(translations.nth(i));
    }

    const inset = await sourceInset(page, 'ltr');
    expect(inset).toBeGreaterThan(20);
    const icon = await measure(page.locator('#icon-p + p.ai-translator-inline-block'));
    expect(Math.abs(icon.padding.left - inset)).toBeLessThanOrEqual(1);
    expect(icon.padding.right).toBe(0);
  } finally {
    await api.close();
  }
});

test('J-B4 a Hebrew translation stays right-aligned with the English source hidden', async ({ page, context }) => {
  const api = await startMockOpenAIServer();
  try {
    await openTranslatedPage(page, context, api.endpoint, {
      path: 'ltr',
      targetLang: 'he',
      settings: { showTranslationOnly: true },
    });
    await expect.poll(() => page.evaluate(() => document.documentElement.getAttribute('data-ai-translator-only'))).toBe('');
    await expect(page.locator('#p1')).toBeHidden();
    await expectEveryTranslationMarked(page, 'he', 'rtl');

    const translations = page.locator(TRANSLATIONS);
    for (let i = 0; i < await translations.count(); i += 1) {
      await expect(translations.nth(i)).toBeVisible();
      await expectRightAligned(translations.nth(i));
    }
  } finally {
    await api.close();
  }
});

test('J-B5 an English translation of a Hebrew page is ltr, left-aligned, and indents on the right', async ({ page, context }) => {
  const api = await startMockOpenAIServer();
  try {
    await openTranslatedPage(page, context, api.endpoint, { path: 'rtl', targetLang: 'en' });
    await expectEveryTranslationMarked(page, 'en', 'ltr');

    const translations = page.locator(TRANSLATIONS);
    for (let i = 0; i < await translations.count(); i += 1) {
      await expectLeftAligned(translations.nth(i));
    }

    const inset = await sourceInset(page, 'rtl');
    expect(inset).toBeGreaterThan(20);
    const icon = await measure(page.locator('#icon-p + p.ai-translator-inline-block'));
    expect(Math.abs(icon.padding.right - inset)).toBeLessThanOrEqual(1);
    expect(icon.padding.left).toBe(0);
  } finally {
    await api.close();
  }
});

test('J-B6 on an RTL nav the inline translation sits left of the link text, 4px away', async ({ page, context }) => {
  const api = await startMockOpenAIServer();
  try {
    await openTranslatedPage(page, context, api.endpoint, { path: 'rtl', targetLang: 'en' });

    const links = page.locator('#nav > a');
    for (let i = 0; i < await links.count(); i += 1) {
      const link = links.nth(i);
      const span = await measure(link.locator('.ai-translator-inline-right'));
      expect(span.margin).toEqual({ left: '0px', right: '4px' });
      expect({ lang: span.lang, dir: span.dir }).toEqual({ lang: 'en', dir: 'ltr' });

      const text = await measure(link, { firstTextNode: true });
      const spanBox = await link.locator('.ai-translator-inline-right').boundingBox();
      expect(Math.abs(text.line.left - (spanBox.x + spanBox.width) - 4)).toBeLessThanOrEqual(1);
    }
  } finally {
    await api.close();
  }
});

test('J-B7 hover translation: the loading state speaks the UI language, the result is Arabic and right-aligned', async ({ page, context }) => {
  // Slow enough to read the loading state before the result replaces it.
  const api = await startMockOpenAIServer({ delayMs: 1500 });
  try {
    await openPage(page, context, api.endpoint, { path: 'ltr', targetLang: 'ar' });

    await page.keyboard.down('Shift');
    await page.locator('#p1').hover();
    const loading = page.locator('#p1 + .ai-translator-hover-translation.ai-translator-inline-loading');
    await loading.waitFor({ state: 'attached' });
    expect(await loading.evaluate((el) => ({ lang: el.lang, dir: el.dir }))).toEqual({ lang: 'en', dir: 'ltr' });

    const result = page.locator('#p1 + .ai-translator-hover-translation:not(.ai-translator-inline-loading)');
    await result.waitFor({ state: 'attached', timeout: 15000 });
    await page.keyboard.up('Shift');
    await expect(result).toContainText('[T]');
    expect(await result.evaluate((el) => ({ lang: el.lang, dir: el.dir }))).toEqual({ lang: 'ar', dir: 'rtl' });
    await expectRightAligned(result);
  } finally {
    await api.close();
  }
});
