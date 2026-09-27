/**
 * The browser window itself in fullscreen (F11, macOS green button), then the
 * page's player fills it. The page cannot tell a fullscreen window from a
 * large one and no fullscreenchange fires, so before
 * content/content-video-stage.js the ball stayed painted over the video.
 *
 * Its own browser: the shared fixture pins a 1280x720 viewport, and a window
 * launched with --start-fullscreen only reports display-mode: fullscreen with
 * no fixed viewport.
 */
const { test, expect, chromium } = require('@playwright/test');
const { extensionPath } = require('./fixtures');
const { applyBaseSettings, waitForFloatBall } = require('./helpers');

const PAGE_URL = 'https://window-fullscreen.test/player.html';
const PAGE = `<!doctype html><html><body style="margin:0">
<h1>Window fullscreen</h1>
<div id="player" style="width:480px;height:270px">
  <video style="width:100%;height:100%;background:#000"></video>
</div>
</body></html>`;
const FILLED = 'position:fixed;inset:0;width:100vw;height:100vh;z-index:100000;background:#000';

test('float ball hides when a player fills a fullscreen window, and comes back', async () => {
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: !process.env.HEADED,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--no-sandbox',
      '--start-fullscreen',
    ],
    viewport: null,
  });
  try {
    await applyBaseSettings(context);
    await context.route(PAGE_URL, (r) => r.fulfill({ contentType: 'text/html', body: PAGE }));
    const page = await context.newPage();
    await page.goto(PAGE_URL);
    await waitForFloatBall(page);
    const ball = page.locator('#ai-translator-float-ball');

    // A fullscreen window with nothing filling it keeps the ball.
    expect(await page.evaluate(() => matchMedia('(display-mode: fullscreen)').matches)).toBe(true);
    await expect(ball).toBeVisible();

    const b = await ball.boundingBox();
    const centre = [b.x + b.width / 2, b.y + b.height / 2];
    const paintedAt = () => page.evaluate(([x, y]) => {
      const hit = document.elementFromPoint(x, y);
      return hit && hit.closest('#ai-translator-float-ball') ? 'ball' : hit && hit.tagName;
    }, centre);
    expect(await paintedAt()).toBe('ball');

    await page.evaluate((css) => { document.getElementById('player').style.cssText = css; }, FILLED);
    await expect(ball).toBeHidden();
    // Where the ball was, the reader now sees the video.
    expect(await paintedAt()).toBe('VIDEO');

    await page.evaluate(() => { document.getElementById('player').style.cssText = 'width:480px;height:270px'; });
    await expect(ball).toBeVisible();
    expect(await paintedAt()).toBe('ball');
  } finally {
    await context.close();
  }
});
