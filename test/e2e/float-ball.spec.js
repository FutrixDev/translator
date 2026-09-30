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
  openExamplePage,
} = require('./helpers');

async function ballCentre(ball) {
  const b = await ball.boundingBox();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

// What is painted at a point: 'ball' when it is our ball, the tag otherwise.
function paintedAt(page, { x, y }) {
  return page.evaluate(([px, py]) => {
    const hit = document.elementFromPoint(px, py);
    if (!hit) return null;
    return hit.closest('#ai-translator-float-ball') ? 'ball' : hit.tagName;
  }, [x, y]);
}

test.describe('Float Ball', () => {
  test('should appear on page load', async ({ page }) => {
    await openExamplePage(page);
    await waitForFloatBall(page);

    const exists = await floatBallExists(page);
    expect(exists).toBe(true);
  });

  // 球本身是翻译 / 还原，菜单挪到了球上那颗 `···`：最常做的那件事该是最省事的
  // 那一下，而菜单里其余六项是偶尔才用一次的。
  test('should open menu from the ··· chip, not from the ball itself', async ({ page }) => {
    await openExamplePage(page);
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
    await openExamplePage(page);
    await waitForFloatBall(page);

    const theme = await getCurrentTheme(page);
    expect(['dark', 'light']).toContain(theme);
  });

  test('should hide on fullscreen and restore on exit', async ({ page }) => {
    await openExamplePage(page);
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

  // Web fullscreen (bilibili, Youku, most embeds): the player restyles itself
  // to cover the viewport and never calls the fullscreen API, so no
  // fullscreenchange fires. Before content/content-video-stage.js the ball
  // stayed painted over the video: elementFromPoint at the ball's own centre
  // hit the ball.
  test('should hide over a web-fullscreen player and restore when it shrinks', async ({ page }) => {
    await openExamplePage(page);
    await waitForFloatBall(page);
    const ball = page.locator('#ai-translator-float-ball');

    await page.evaluate(() => {
      const player = document.createElement('div');
      player.id = 'ai-web-fs-player';
      player.style.cssText = 'width:480px;height:270px';
      player.innerHTML = '<video style="width:100%;height:100%;background:#000"></video>';
      document.body.appendChild(player);
    });
    await expect(ball).toBeVisible();
    const centre = await ballCentre(ball);

    await page.evaluate(() => {
      document.getElementById('ai-web-fs-player').style.cssText =
        'position:fixed;inset:0;width:100vw;height:100vh;z-index:100000;background:#000';
    });
    await expect(ball).toBeHidden();
    expect(await paintedAt(page, centre)).toBe('VIDEO');

    await page.evaluate(() => {
      document.getElementById('ai-web-fs-player').style.cssText = 'width:480px;height:270px';
    });
    await expect(ball).toBeVisible();
    expect(await paintedAt(page, centre)).toBe('ball');
  });

  // Filling the viewport is not being on screen: a video pinned behind the
  // page's text (a background layer with no loop, so the backdrop rule does
  // not catch it) must not take the ball away.
  test('should stay over a full-viewport video the page covers', async ({ page }) => {
    await openExamplePage(page);
    await waitForFloatBall(page);
    const ball = page.locator('#ai-translator-float-ball');

    await page.evaluate(() => {
      const video = document.createElement('video');
      video.id = 'ai-covered-video';
      video.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;z-index:-1;background:#000';
      const column = document.createElement('div');
      column.style.cssText = 'min-height:100vh;background:#fff';
      column.textContent = 'Page text over a background video.';
      document.body.prepend(column);
      document.body.appendChild(video);
    });
    // Let at least two stage polls (400 ms) pass: hiding would show by then.
    await page.waitForTimeout(1000);
    expect(await page.evaluate(() => {
      const r = document.getElementById('ai-covered-video').getBoundingClientRect();
      return r.width >= innerWidth - 4 && r.height >= innerHeight - 4;
    })).toBe(true);
    await expect(ball).toBeVisible();
  });

  test('should be draggable', async ({ page }) => {
    await openExamplePage(page);
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
    await openExamplePage(page);
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
