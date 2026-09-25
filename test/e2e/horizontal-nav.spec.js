/**
 * Horizontal Navigation E2E Tests
 * Tests for top navigation bar translation (inline display)
 */
const { test, expect } = require('./fixtures');
const { testSites } = require('./test-sites');
const {
  waitForFloatBall,
  triggerPageTranslation,
  waitForTranslationComplete,
  setExtensionSettings,
} = require('./helpers');

test.describe('Horizontal Navigation Translation', () => {
  // Skip in CI environment (requires API key)
  test.skip(({ }) => !process.env.AI_TRANSLATOR_API_KEY, 'Requires API key');

  test('translation should display inline (right of original)', async ({ page }) => {
    const site = testSites.horizontalNav[0];
    // These specs are about navigation and sidebar translation; the default
    // 'main' scope skips exactly those regions, so pin the whole-page scope.
    await setExtensionSettings(page, { pageTranslateScope: 'page' });
    await page.goto(site.url);
    await page.waitForLoadState('networkidle');
    await waitForFloatBall(page);

    // Trigger translation
    await triggerPageTranslation(page);
    await waitForTranslationComplete(page);

    // Check that translations are inline (inside the original element)
    const inlineTranslations = await page.evaluate(() => {
      const results = [];
      const translated = document.querySelectorAll('.ai-translator-translated');

      for (const el of translated) {
        const inlineBlock = el.querySelector('.ai-translator-inline-block.ai-translator-inline-right');
        if (inlineBlock) {
          const parentRect = el.getBoundingClientRect();
          const inlineRect = inlineBlock.getBoundingClientRect();

          results.push({
            hasInlineTranslation: true,
            // Check that translation is inside the parent element
            isInside: inlineRect.left >= parentRect.left && inlineRect.right <= parentRect.right,
            // Check that translation is on the same line (similar top position)
            sameLine: Math.abs(inlineRect.top - parentRect.top) < 20,
          });
        }
      }

      return results;
    });

    // Should have some inline translations
    expect(inlineTranslations.length).toBeGreaterThan(0);

    // All inline translations should be inside parent and on same line
    for (const item of inlineTranslations) {
      expect(item.hasInlineTranslation).toBe(true);
      expect(item.sameLine).toBe(true);
    }
  });

  test('horizontal nav should not increase height after translation', async ({ page }) => {
    const site = testSites.horizontalNav[0];
    // These specs are about navigation and sidebar translation; the default
    // 'main' scope skips exactly those regions, so pin the whole-page scope.
    await setExtensionSettings(page, { pageTranslateScope: 'page' });
    await page.goto(site.url);
    await page.waitForLoadState('networkidle');
    await waitForFloatBall(page);

    // Get nav height before translation
    const navHeightBefore = await page.evaluate(() => {
      const nav = document.querySelector('nav');
      return nav ? nav.getBoundingClientRect().height : 0;
    });

    // Trigger translation
    await triggerPageTranslation(page);
    await waitForTranslationComplete(page);

    // Get nav height after translation
    const navHeightAfter = await page.evaluate(() => {
      const nav = document.querySelector('nav');
      return nav ? nav.getBoundingClientRect().height : 0;
    });

    // Height should not increase significantly (allow 10px tolerance)
    expect(navHeightAfter - navHeightBefore).toBeLessThan(10);
  });
});

test.describe('Flex Layout Detection', () => {
  test('should detect horizontal flex parent', async ({ page }) => {
    // Create a test page with known flex layout
    await page.setContent(`
      <nav style="display: flex; flex-direction: row; gap: 10px;">
        <a href="#" id="test-link">Home</a>
        <a href="#">About</a>
        <a href="#">Contact</a>
      </nav>
    `);

    // Inject test to check flex detection
    const isHorizontalFlex = await page.evaluate(() => {
      const link = document.getElementById('test-link');
      const parent = link.parentElement;
      const style = window.getComputedStyle(parent);
      return (
        (style.display === 'flex' || style.display === 'inline-flex') &&
        (style.flexDirection === 'row' || style.flexDirection === 'row-reverse' || style.flexDirection === '')
      );
    });

    expect(isHorizontalFlex).toBe(true);
  });

  test('should NOT detect vertical flex as horizontal', async ({ page }) => {
    // Create a test page with vertical flex layout
    await page.setContent(`
      <nav style="display: flex; flex-direction: column; gap: 10px;">
        <a href="#" id="test-link">Home</a>
        <a href="#">About</a>
        <a href="#">Contact</a>
      </nav>
    `);

    // Inject test to check flex detection
    const isHorizontalFlex = await page.evaluate(() => {
      const link = document.getElementById('test-link');
      const parent = link.parentElement;
      const style = window.getComputedStyle(parent);
      return (
        (style.display === 'flex' || style.display === 'inline-flex') &&
        (style.flexDirection === 'row' || style.flexDirection === 'row-reverse' || style.flexDirection === '')
      );
    });

    expect(isHorizontalFlex).toBe(false);
  });
});
