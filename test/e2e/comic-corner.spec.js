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
const RUNNING = '.ai-translator-comic-progress.is-busy .ai-translator-comic-pill';

async function openComicPage(page, service, path) {
  await page.goto(`${service.base}${path}`);
  await page.locator('#comic').evaluate(img => img.decode());
}

const topOf = (page, selector) => page.locator(selector).evaluate(el => Math.round(el.getBoundingClientRect().top));
const scrollBox = (page, to, axis = 'y') => page.locator('#box').evaluate((box, [position, along]) => {
  if (along === 'x') box.scrollLeft = position;
  else box.scrollTop = position;
  return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}, [to, axis]);
/** Scrolls the box so only the last `seen` px of the image, on `axis`, are left in it. */
const leaveInBox = (page, axis, seen) => page.locator('#comic').evaluate((img, [along, px]) => {
  const box = document.querySelector('#box');
  if (along === 'x') box.scrollLeft = img.offsetWidth - px;
  else box.scrollTop = img.offsetHeight - px;
  return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}, [axis, seen]);
const sizeOf = (page, selector, side) => page.locator(selector).evaluate((el, key) => el.getBoundingClientRect()[key], side);
/** The image 1200 px wide in a 500 px box, and room to scroll all of it out. */
const widenImage = page => page.evaluate(() => {
  const img = document.querySelector('#comic');
  img.removeAttribute('width');
  img.style.width = '1200px';
  document.querySelector('#box > div').style.width = '2000px';
});
// Scrolls, then wipes `selector`'s placement, in one task, and waits until the
// pin has placed it again. The expected top is also the top from before the
// scroll, so a read that could still see the old placement passes on a pin
// that never followed the box. Split over two evaluates, a frame could re-pin
// between the wipe and the scroll and the read would see the old answer.
const scrollBoxRepinned = async (page, selector, y) => {
  await page.evaluate(([target, top]) => {
    document.querySelector('#box').scrollTop = top;
    document.querySelector(target).style.top = '-1000px';
  }, [selector, y]);
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

  test('a sliver of the image left sideways hides the pill until there is room for it again', async ({ context, page }) => {
    const service = await startMockService('succeed', { succeedAfterMs: 60_000 });
    try {
      const worker = await connectExtension(context, service.base);
      await openComicPage(page, service, '/scroller');
      await widenImage(page);
      await triggerComicTranslation(worker, `${service.base}/scroller`, `${service.base}/source.png`);
      // Measured once the job runs: "Translating the comic…" and its number
      // are the pill at its widest, about 150 px.
      await expect(page.locator(RUNNING)).toBeVisible({ timeout: 15_000 });
      const width = await sizeOf(page, PILL, 'width');
      expect(width + 16).toBeGreaterThan(120);

      // 120 px of the image's right end are left in the box, then 15.
      await leaveInBox(page, 'x', 120);
      expect(await page.locator('#box').evaluate(box => box.scrollLeft)).toBe(1080);
      await expect(page.locator(PILL)).toBeHidden();
      // Room for the pill and an inset each side: back.
      await leaveInBox(page, 'x', Math.ceil(width) + 16 + 30);
      await expect(page.locator(PILL)).toBeVisible();
      await leaveInBox(page, 'x', 15);
      expect(await page.locator('#box').evaluate(box => box.scrollLeft)).toBe(1185);
      await expect(page.locator(PILL)).toBeHidden();
      await scrollBox(page, 0, 'x');
      await expect(page.locator(PILL)).toBeVisible();
    } finally {
      await service.close();
    }
  });

  test('a sliver of the image left at the box bottom hides the pill instead of pushing it over the box edge', async ({ context, page }) => {
    const service = await startMockService('succeed', { succeedAfterMs: 60_000 });
    try {
      const worker = await connectExtension(context, service.base);
      await openComicPage(page, service, '/scroller');
      await triggerComicTranslation(worker, `${service.base}/scroller`, `${service.base}/source.png`);
      await expect(page.locator(RUNNING)).toBeVisible({ timeout: 15_000 });
      const height = await sizeOf(page, PILL, 'height');
      expect(height + 16).toBeGreaterThan(20);

      await leaveInBox(page, 'y', 20);
      await expect(page.locator(PILL)).toBeHidden();
      // With room again it sits on the box edge, inside the image.
      await leaveInBox(page, 'y', Math.ceil(height) + 16 + 10);
      await expect(page.locator(PILL)).toBeVisible();
      await expect.poll(() => topOf(page, PILL)).toBe(108);
      await scrollBox(page, 0);
      await expect(page.locator(PILL)).toBeVisible();
    } finally {
      await service.close();
    }
  });

  test('the badge judges a sliver by its own size, sideways and down', async ({ context, page }) => {
    const service = await startMockService('succeed');
    try {
      const worker = await connectExtension(context, service.base);
      await openComicPage(page, service, '/scroller');
      await widenImage(page);
      await triggerComicTranslation(worker, `${service.base}/scroller`, `${service.base}/source.png`);
      await expect(page.locator('#comic')).toHaveAttribute('src', /\/result\.png\?sig=/, { timeout: 20_000 });
      await expect(page.locator(BADGE)).toBeVisible();
      const width = await sizeOf(page, BADGE, 'width');
      const height = await sizeOf(page, BADGE, 'height');

      // Whichever end of the image is left, the badge needs its own width and
      // an inset each side — narrower than the pill, so it stays where the
      // pill would already be gone.
      await leaveInBox(page, 'x', Math.floor(width) + 16 - 4);
      await expect(page.locator(BADGE)).toBeHidden();
      await leaveInBox(page, 'x', Math.ceil(width) + 16 + 4);
      await expect(page.locator(BADGE)).toBeVisible();
      await leaveInBox(page, 'x', 15);
      await expect(page.locator(BADGE)).toBeHidden();
      await scrollBox(page, 0, 'x');
      await expect(page.locator(BADGE)).toBeVisible();

      await leaveInBox(page, 'y', Math.floor(height) + 16 - 4);
      await expect(page.locator(BADGE)).toBeHidden();
      await leaveInBox(page, 'y', Math.ceil(height) + 16 + 4);
      await expect(page.locator(BADGE)).toBeVisible();
      await scrollBox(page, 0);
      await expect(page.locator(BADGE)).toBeVisible();
    } finally {
      await service.close();
    }
  });

  test('an image wider than its box keeps the pill and the badge inside the box', async ({ context, page }) => {
    // Held long enough that the pill is still there when its edge is read.
    const service = await startMockService('succeed', { succeedAfterMs: 5000 });
    try {
      const worker = await connectExtension(context, service.base);
      await openComicPage(page, service, '/scroller');
      await page.locator('#comic').evaluate((img) => {
        img.removeAttribute('width');
        img.style.width = '900px';
      });
      // The box's visible part, inside its border and scrollbar.
      const edges = (selector) => page.evaluate((target) => {
        const box = document.querySelector('#box');
        const rect = box.getBoundingClientRect();
        const left = rect.left + box.clientLeft;
        const el = document.querySelector(target).getBoundingClientRect();
        return { left: Math.round(el.left - left), right: Math.round(left + box.clientWidth - el.right) };
      }, selector);

      await triggerComicTranslation(worker, `${service.base}/scroller`, `${service.base}/source.png`);
      await expect(page.locator(PILL)).toBeVisible();
      // The image's own right edge is 400 px past the box's: the pill takes
      // the box's.
      await expect.poll(async () => (await edges('.ai-translator-comic-progress')).right, { timeout: 3_000 }).toBe(8);

      await expect(page.locator('#comic')).toHaveAttribute('src', /\/result\.png\?sig=/, { timeout: 20_000 });
      await expect(page.locator(BADGE)).toBeVisible();
      // Scrolled sideways, the image's left edge leaves the box; the badge stays.
      // Before and after, the right answer is the same 8, so the scroll and
      // moving the badge off happen in one task — no frame can re-pin it from
      // the old scroll position in between — and it is read only once the pin
      // has placed it again.
      await page.evaluate((badge) => {
        document.querySelector('#box').scrollLeft = 300;
        document.querySelector(badge).style.left = '-1000px';
      }, BADGE);
      await expect.poll(() => page.locator(BADGE).evaluate(el => el.style.left)).not.toBe('-1000px');
      expect((await edges(BADGE)).left).toBe(8);
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
