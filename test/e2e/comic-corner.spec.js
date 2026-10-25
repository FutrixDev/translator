/**
 * Where the pill and the badge sit when only part of the image can be seen.
 *
 * 进度标和徽标是 fixed 定位的，没有人替它们裁剪：图片在阅读器自己的滚动框里被滚出一半时，
 * 角标要贴着能看见的那一截的上沿（框的上沿 + 8），图片整个滚出去就不显示；窗口滚过图片
 * 顶部时也一样，贴着视口上沿。服务是 comic-fixtures.js 里那台模拟的。
 */
const { test, expect } = require('./fixtures');
const { connectExtension } = require('./helpers');
const { startMockService, triggerComicTranslation } = require('./comic-fixtures');

const PILL = '.ai-translator-comic-progress .ai-translator-comic-pill';
const BADGE = '.ai-translator-comic-badge';

async function openComicPage(page, service, path) {
  await page.goto(`${service.base}${path}`);
  await page.locator('#comic').evaluate(img => img.decode());
}

const topOf = (page, selector) => page.locator(selector).evaluate(el => Math.round(el.getBoundingClientRect().top));
const scrollBox = (page, y) => page.locator('#box').evaluate((box, top) => {
  box.scrollTop = top;
  return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}, y);
// Scrolls with `selector`'s old placement wiped first, and waits until the pin
// has placed it again. The expected top is also the top from before the
// scroll, so a read that could still see the old placement passes on a pin
// that never followed the box; two frames were not always enough for that.
const scrollBoxRepinned = async (page, selector, y) => {
  await page.locator(selector).evaluate((el) => { el.style.top = '-1000px'; });
  await scrollBox(page, y);
  await expect.poll(() => topOf(page, selector)).not.toBe(-1000);
};

test.describe('Comic corner placement', () => {
  test('in a scroll box, the pill follows the box edge and leaves with the image', async ({ context, page }) => {
    const service = await startMockService('succeed', { succeedAfterMs: 60_000 });
    try {
      const worker = await connectExtension(context, service.base);
      await openComicPage(page, service, '/scroller');
      await triggerComicTranslation(worker, `${service.base}/scroller`, `${service.base}/source.png`);
      await expect(page.locator(PILL)).toBeVisible();
      expect(await topOf(page, PILL)).toBe(108);

      // The image's top is 100 px above the box's: the pill stays on the box's edge.
      await scrollBoxRepinned(page, PILL, 200);
      expect(await topOf(page, '#comic')).toBe(-100);
      expect(await topOf(page, PILL)).toBe(108);
      await expect(page.locator(PILL)).toBeVisible();

      // Scrolled out of the box, though the window would still show it.
      await scrollBox(page, 700);
      await expect(page.locator(PILL)).toBeHidden();

      await scrollBox(page, 0);
      await expect(page.locator(PILL)).toBeVisible();
    } finally {
      await service.close();
    }
  });

  test('in a scroll box, the badge follows the box edge and leaves with the image', async ({ context, page }) => {
    const service = await startMockService('succeed');
    try {
      const worker = await connectExtension(context, service.base);
      await openComicPage(page, service, '/scroller');
      await triggerComicTranslation(worker, `${service.base}/scroller`, `${service.base}/source.png`);
      await expect(page.locator('#comic')).toHaveAttribute('src', /\/result\.png\?sig=/, { timeout: 20_000 });
      await expect(page.locator(BADGE)).toBeVisible();
      expect(await topOf(page, BADGE)).toBe(108);

      await scrollBoxRepinned(page, BADGE, 200);
      expect(await topOf(page, '#comic')).toBe(-100);
      expect(await topOf(page, BADGE)).toBe(108);

      await scrollBox(page, 700);
      await expect(page.locator(BADGE)).toBeHidden();
    } finally {
      await service.close();
    }
  });

  test('with the window scrolled past the image top, the pill sits at the viewport top', async ({ context, page }) => {
    const service = await startMockService('succeed', { succeedAfterMs: 60_000 });
    try {
      const worker = await connectExtension(context, service.base);
      await openComicPage(page, service, '/tall');
      expect(await page.evaluate(() => document.documentElement.scrollHeight > window.innerHeight)).toBe(true);
      await triggerComicTranslation(worker, `${service.base}/tall`, `${service.base}/source.png`);
      await expect(page.locator(PILL)).toBeVisible();
      expect(await topOf(page, PILL)).toBe(108);

      // 200 px past the image's top (which starts 100 px down).
      await page.evaluate(() => window.scrollTo(0, 300));
      await expect.poll(() => topOf(page, '#comic')).toBe(-200);
      await expect.poll(() => topOf(page, PILL)).toBe(8);
    } finally {
      await service.close();
    }
  });
});
