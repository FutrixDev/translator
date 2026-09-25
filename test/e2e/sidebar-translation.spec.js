/**
 * Sidebar Translation E2E Tests
 * Tests for sidebar menu translation alignment
 */
const { test, expect } = require('./fixtures');
const { testSites } = require('./test-sites');
const {
  waitForFloatBall,
  triggerPageTranslation,
  waitForTranslationComplete,
  verifyAlignment,
  setExtensionSettings,
} = require('./helpers');

test.describe('Sidebar Translation Alignment', () => {
  // Skip in CI environment (requires API key)
  test.skip(({ }) => !process.env.AI_TRANSLATOR_API_KEY, 'Requires API key');

  for (const site of testSites.sidebarWithIcons) {
    test(`should align translation with original text on ${site.name}`, async ({ page }) => {
      // These specs are about navigation and sidebar translation; the default
      // 'main' scope skips exactly those regions, so pin the whole-page scope.
      await setExtensionSettings(page, { pageTranslateScope: 'page' });
      await page.goto(site.url);
      await page.waitForLoadState('networkidle');
      await waitForFloatBall(page);

      // Trigger translation
      await triggerPageTranslation(page);
      await waitForTranslationComplete(page);

      // Wait for translations to appear
      await page.waitForSelector('.ai-translator-translated', {
        timeout: 30000,
      });

      // Verify alignment for sidebar items
      const alignment = await page.evaluate((selectors) => {
        const results = [];
        const translatedItems = document.querySelectorAll('li.ai-translator-translated');

        for (let i = 0; i < Math.min(translatedItems.length, 5); i++) {
          const original = translatedItems[i];
          const translation = original.nextElementSibling;

          if (!translation || !translation.classList.contains('ai-translator-inline-block')) {
            continue;
          }

          // Find original text position
          const textSpan = original.querySelector(selectors.menuText) ||
                          original.querySelector('span:last-child') ||
                          original;

          const originalRect = textSpan.getBoundingClientRect();
          const translationRect = translation.getBoundingClientRect();
          const translationStyle = window.getComputedStyle(translation);
          const paddingLeft = parseFloat(translationStyle.paddingLeft) || 0;

          results.push({
            originalLeft: originalRect.left,
            translationLeft: translationRect.left,
            paddingLeft: paddingLeft,
            effectiveLeft: translationRect.left + paddingLeft,
            diff: Math.abs(originalRect.left - (translationRect.left + paddingLeft)),
          });
        }

        return results;
      }, site.selectors);

      // Verify each translation is aligned (within 5px tolerance)
      for (const item of alignment) {
        expect(item.diff).toBeLessThan(5);
        expect(item.paddingLeft).toBeGreaterThan(0); // Should have padding for icon offset
      }
    });
  }

  test('translation should not align with icon', async ({ page }) => {
    const site = testSites.sidebarWithIcons[0];
    // These specs are about navigation and sidebar translation; the default
    // 'main' scope skips exactly those regions, so pin the whole-page scope.
    await setExtensionSettings(page, { pageTranslateScope: 'page' });
    await page.goto(site.url);
    await page.waitForLoadState('networkidle');
    await waitForFloatBall(page);

    // Trigger translation
    await triggerPageTranslation(page);
    await waitForTranslationComplete(page);

    // Check that translation is NOT aligned with icon
    const iconVsTranslation = await page.evaluate((selectors) => {
      const translatedItem = document.querySelector('li.ai-translator-translated');
      if (!translatedItem) return null;

      const icon = translatedItem.querySelector('svg');
      const translation = translatedItem.nextElementSibling;

      if (!icon || !translation) return null;

      const iconRect = icon.getBoundingClientRect();
      const translationRect = translation.getBoundingClientRect();
      const translationStyle = window.getComputedStyle(translation);
      const paddingLeft = parseFloat(translationStyle.paddingLeft) || 0;

      return {
        iconLeft: iconRect.left,
        translationEffectiveLeft: translationRect.left + paddingLeft,
        diff: Math.abs(iconRect.left - (translationRect.left + paddingLeft)),
      };
    }, site.selectors);

    if (iconVsTranslation) {
      // Translation should NOT be aligned with icon (diff should be > 10px)
      expect(iconVsTranslation.diff).toBeGreaterThan(10);
    }
  });
});

test.describe('Sidebar Translation - Visual Check', () => {
  test('should take screenshot of translated sidebar', async ({ page }) => {
    const site = testSites.sidebarWithIcons[0];
    // These specs are about navigation and sidebar translation; the default
    // 'main' scope skips exactly those regions, so pin the whole-page scope.
    await setExtensionSettings(page, { pageTranslateScope: 'page' });
    await page.goto(site.url);
    await page.waitForLoadState('networkidle');
    await waitForFloatBall(page);

    // Take before screenshot
    await page.screenshot({
      path: 'test/results/sidebar-before.png',
      fullPage: false,
    });

    // Skip actual translation if no API key
    if (process.env.AI_TRANSLATOR_API_KEY) {
      await triggerPageTranslation(page);
      await waitForTranslationComplete(page);

      // Take after screenshot
      await page.screenshot({
        path: 'test/results/sidebar-after.png',
        fullPage: false,
      });
    }
  });
});
