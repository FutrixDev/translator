/**
 * Float Ball E2E Tests
 * Tests for float ball visibility, persistence, and theme
 */
const { test, expect } = require('./fixtures');
const { testSites } = require('./test-sites');
const {
  waitForFloatBall,
  openFloatBallMenu,
  floatBallExists,
  getCurrentTheme,
} = require('./helpers');

test.describe('Float Ball', () => {
  test('should appear on page load', async ({ page }) => {
    await page.goto('https://example.com');
    await waitForFloatBall(page);

    const exists = await floatBallExists(page);
    expect(exists).toBe(true);
  });

  // 球本身是翻译 / 还原，菜单挪到了球上那颗 `···`：最常做的那件事该是最省事的
  // 那一下，而菜单里其余六项是偶尔才用一次的。
  test('should open menu from the ··· chip, not from the ball itself', async ({ page }) => {
    await page.goto('https://example.com');
    await waitForFloatBall(page);

    // 单击球 —— 菜单不该出来。这一条是反向的：`···` 能开菜单证明不了球不能开。
    await page.click('#ai-translator-float-ball', { position: { x: 18, y: 18 } });
    await page.waitForTimeout(300);
    await expect(page.locator('#ai-translator-float-menu')).toHaveCount(0);

    await openFloatBallMenu(page);
    await expect(page.locator('#ai-translator-float-menu')).toBeVisible();
  });

  test('should persist after React SPA navigation', async ({ page }) => {
    const site = testSites.reactSPA[0];
    await page.goto(site.url);
    await waitForFloatBall(page);

    // Initial check
    let exists = await floatBallExists(page);
    expect(exists).toBe(true);

    // Navigate within SPA
    await page.getByRole('link', { name: 'Reference', exact: true }).click();
    await page.waitForLoadState('networkidle');

    // Wait a bit for any React hydration
    await page.waitForTimeout(2000);

    // Check float ball still exists
    exists = await floatBallExists(page);
    expect(exists).toBe(true);
  });

  test('should apply correct theme', async ({ page }) => {
    await page.goto('https://example.com');
    await waitForFloatBall(page);

    const theme = await getCurrentTheme(page);
    expect(['dark', 'light']).toContain(theme);
  });

  test('should hide on fullscreen and restore on exit', async ({ page }) => {
    await page.goto('https://example.com');
    await waitForFloatBall(page);

    await page.evaluate(() => {
      const button = document.createElement('button');
      button.id = 'ai-fs-trigger';
      button.textContent = 'fullscreen';
      button.addEventListener('click', () => document.documentElement.requestFullscreen());
      document.body.appendChild(button);
    });

    await page.click('#ai-fs-trigger');
    await page.waitForFunction(() => !!document.fullscreenElement);

    await expect(page.locator('#ai-translator-float-ball')).toBeHidden();

    await page.evaluate(() => document.exitFullscreen());
    await page.waitForFunction(() => !document.fullscreenElement);

    await expect(page.locator('#ai-translator-float-ball')).toBeVisible();
  });

  test('should be draggable', async ({ page }) => {
    await page.goto('https://example.com');
    await waitForFloatBall(page);

    const floatBall = page.locator('#ai-translator-float-ball');
    const initialBox = await floatBall.boundingBox();

    // Drag float ball
    const startX = initialBox.x + initialBox.width / 2;
    const startY = initialBox.y + initialBox.height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(100, 100);
    await page.mouse.up();

    const newBox = await floatBall.boundingBox();

    // Position should have changed
    expect(newBox.x).not.toBe(initialBox.x);
    expect(newBox.y).not.toBe(initialBox.y);
  });

  test('should stay within viewport bounds', async ({ page }) => {
    await page.goto('https://example.com');
    await waitForFloatBall(page);

    const floatBall = page.locator('#ai-translator-float-ball');
    const box = await floatBall.boundingBox();
    const viewport = page.viewportSize();

    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
  });
});

test.describe('Float Ball on Different Sites', () => {
  for (const site of testSites.reactSPA) {
    test(`should persist on ${site.name}`, async ({ page }) => {
      await page.goto(site.url);

      // Wait for page to fully load
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(3000); // Wait for any hydration

      await waitForFloatBall(page, 15000);

      const exists = await floatBallExists(page);
      expect(exists).toBe(true);
    });
  }
});
