/**
 * The rest of the chapter follows the first page.
 *
 * 长条阅读页上读者亲手翻了第一页，同一页面上其余的页自己排队翻：离视口近的先翻，
 * 同时在跑的不超过上限；懒加载、还没滚到的页不会提前下单，滚到了才排进来；每页
 * 只下一次单。服务是 comic-fixtures.js 里那台模拟的（chapter 模式）。
 */
const { test, expect } = require('./fixtures');
const { connectExtension } = require('./helpers');
const { startMockService, openComicPage, triggerComicTranslation } = require('./comic-fixtures');

// content/comic/auto.js AUTO_CONCURRENCY, plus the reader's own page.
const PEAK = 2 + 1;
const STEP_MS = 400;

/** Jobs created and not yet finished at the moment each job was created. */
function peakInFlight(state) {
  const jobs = Object.values(state.jobs).map(job => ({
    start: job.createdAt, end: job.createdAt + STEP_MS * (job.pageIndex + 1),
  }));
  return Math.max(0, ...jobs.map(({ start }) => jobs.filter(job => job.start <= start && job.end > start).length));
}

test.describe('Comic auto translation', () => {
  test('a long strip translates itself page by page, lazy pages only once scrolled to, each page once', async ({ context, page }) => {
    test.setTimeout(90_000);
    const service = await startMockService('succeed', { chapter: { stepMs: STEP_MS } });
    try {
      const worker = await connectExtension(context, service.base);
      const pageUrl = await openComicPage(page, service, '/strip');

      await triggerComicTranslation(worker, page, pageUrl, `${service.base}/source.png?page=1`);
      // The pages already loaded follow on their own; the lazy ones are not
      // bought before the reader gets near them.
      await expect.poll(() => service.state.createBodies.length, { timeout: 20_000 }).toBe(3);
      await page.waitForTimeout(1500);
      expect(service.state.createBodies.length).toBe(3);
      expect(await page.locator('img.lazy[src]').count()).toBe(0);

      // Read down the strip a screen at a time, as a reader does.
      for (let y = 600; y <= 3000; y += 600) {
        await page.evaluate(top => window.scrollTo(0, top), y);
        await page.waitForTimeout(300);
      }
      await expect.poll(() => service.state.createBodies.length, { timeout: 20_000 }).toBe(6);
      await expect(page.locator('img.page[src*="/result.png?sig="]')).toHaveCount(6, { timeout: 30_000 });

      // Settled: nothing ordered twice, and never more at once than the cap.
      await page.waitForTimeout(1500);
      const ids = service.state.createBodies.map(body => body.pageId);
      expect(new Set(ids).size).toBe(6);
      expect(ids.length).toBe(6);
      expect(peakInFlight(service.state)).toBeLessThanOrEqual(PEAK);
    } finally {
      await service.close();
    }
  });

  test('a short chapter that is not a long strip stays one page', async ({ context, page }) => {
    const service = await startMockService('succeed', { chapter: { stepMs: STEP_MS } });
    try {
      const worker = await connectExtension(context, service.base);
      const pageUrl = await openComicPage(page, service, '/chapter');
      await triggerComicTranslation(worker, page, pageUrl, `${service.base}/source.png?page=1`);
      await expect.poll(() => service.state.createBodies.length, { timeout: 20_000 }).toBe(1);
      await page.waitForTimeout(1500);
      expect(service.state.createBodies.length).toBe(1);
    } finally {
      await service.close();
    }
  });
});
