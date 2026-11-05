/**
 * The rest of the chapter follows the first page.
 *
 * 长条阅读页上读者亲手翻了第一页，同一页面上其余的页自己排队翻：离视口近的先翻；
 * 前面的页还在翻，也不挡往下滚到的页下单（跑几张由服务端排）；懒加载、还没滚到的
 * 页不会提前下单，滚到了才排进来；每页只下一次单。服务是 comic-fixtures.js 里那台模拟的（chapter 模式）。
 *
 * 站点开着自动翻译时，一进长条页就自己开始，不用点（watchAutoEntry）；没登录、
 * 站点没开都不动。额度用完：本章汇总标自己打开，首个按钮是「查看套餐」，停下之后
 * 往下滚也不再下单；要扣积分的页照旧先问一次。
 */
const { test, expect } = require('./fixtures');
const { connectExtension, sendMessageToActiveTab, setExtensionAccount } = require('./helpers');
const { startMockService, openComicPage, triggerComicTranslation } = require('./comic-fixtures');

const SUMMARY = '.ai-translator-comic-summary';

/**
 * [fixture] The reader's entry is the popup's "Always translate this site";
 * this writes the same user rule (and the master switch) from the worker.
 */
async function autoTranslateSite(worker, base) {
  await worker.evaluate(host => globalThis.SiteRules.setSiteAuto(host, true), new URL(base).hostname);
}

/**
 * Read down the strip a screen at a time, as a reader does. With
 * `writeAddress`, the page also records where the reader is, as many strip
 * readers do: the page number in the hash, then in the path.
 */
async function readDown(page, { writeAddress = false } = {}) {
  for (let y = 600; y <= 3000; y += 600) {
    await page.evaluate(({ top, writeAddress }) => {
      window.scrollTo(0, top);
      if (!writeAddress) return;
      const screen = top / 600;
      history.replaceState(null, '', screen % 2 ? `#page=${screen}` : `${location.pathname.replace(/\/\d+$/, '')}/${screen}`);
    }, { top: y, writeAddress });
    await page.waitForTimeout(300);
  }
}

const STEP_MS = 400;

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

      await readDown(page);
      await expect.poll(() => service.state.createBodies.length, { timeout: 20_000 }).toBe(6);
      await expect(page.locator('img.page[src*="/result.png?sig="]')).toHaveCount(6, { timeout: 30_000 });

      // Settled: nothing ordered twice.
      await page.waitForTimeout(1500);
      const ids = service.state.createBodies.map(body => body.pageId);
      expect(new Set(ids).size).toBe(6);
      expect(ids.length).toBe(6);
    } finally {
      await service.close();
    }
  });

  test('pages scrolled to are ordered while the earlier ones are still being redrawn', async ({ context, page }) => {
    test.setTimeout(60_000);
    // No job finishes inside this test: a page is ordered because the reader
    // reached it, never because an earlier page made room.
    const service = await startMockService('succeed', { chapter: { stepMs: 120_000 } });
    try {
      const worker = await connectExtension(context, service.base);
      const pageUrl = await openComicPage(page, service, '/strip');

      await triggerComicTranslation(worker, page, pageUrl, `${service.base}/source.png?page=1`);
      await expect.poll(() => service.state.createBodies.length, { timeout: 20_000 }).toBe(3);

      await readDown(page);
      await expect.poll(() => service.state.createBodies.length, { timeout: 20_000 }).toBe(6);
      await expect(page.locator('img.page[src*="/result.png?sig="]')).toHaveCount(0);
      expect(new Set(service.state.createBodies.map(body => body.pageId)).size).toBe(6);
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

  test.describe('on a site set to translate automatically', () => {
    test('a strip starts by itself on entry, with no click, and reads on as the reader scrolls', async ({ context, page }) => {
      test.setTimeout(90_000);
      const service = await startMockService('succeed', { chapter: { stepMs: STEP_MS } });
      try {
        const worker = await connectExtension(context, service.base);
        await autoTranslateSite(worker, service.base);
        await openComicPage(page, service, '/strip');

        // The loaded pages near the viewport, nothing lazy.
        await expect.poll(() => service.state.createBodies.length, { timeout: 20_000 }).toBe(3);
        await page.waitForTimeout(1500);
        expect(service.state.createBodies.length).toBe(3);

        await readDown(page);
        await expect.poll(() => service.state.createBodies.length, { timeout: 20_000 }).toBe(6);
        await expect(page.locator('img.page[src*="/result.png?sig="]')).toHaveCount(6, { timeout: 30_000 });
        const ids = service.state.createBodies.map(body => body.pageId);
        expect(new Set(ids).size).toBe(6);
        expect(ids.length).toBe(6);
      } finally {
        await service.close();
      }
    });

    test('paused, the strip orders nothing more; Continue picks the chapter up again', async ({ context, page }) => {
      test.setTimeout(90_000);
      const service = await startMockService('succeed', { chapter: { stepMs: STEP_MS } });
      try {
        const worker = await connectExtension(context, service.base);
        await autoTranslateSite(worker, service.base);
        await openComicPage(page, service, '/strip');
        await expect.poll(() => service.state.createBodies.length, { timeout: 20_000 }).toBe(3);

        // The popup's Pause, as for the page's text.
        await sendMessageToActiveTab(page, { type: 'SET_AUTO_PAUSED', paused: true });
        await readDown(page);
        await page.waitForTimeout(2000);
        expect(service.state.createBodies.length).toBe(3);

        // Continue: the pages the reader has reached are ordered, each once.
        await sendMessageToActiveTab(page, { type: 'SET_AUTO_PAUSED', paused: false });
        await expect.poll(() => service.state.createBodies.length, { timeout: 20_000 }).toBeGreaterThan(3);
        await page.evaluate(() => window.scrollTo(0, 0));
        await readDown(page);
        await expect.poll(() => service.state.createBodies.length, { timeout: 20_000 }).toBe(6);
        const ids = service.state.createBodies.map(body => body.pageId);
        expect(new Set(ids).size).toBe(6);
      } finally {
        await service.close();
      }
    });

    test('signed out, nothing starts and no sign-in opens', async ({ context, page }) => {
      const service = await startMockService('succeed', { chapter: { stepMs: STEP_MS } });
      try {
        const worker = await connectExtension(context, service.base, { signedIn: false });
        await autoTranslateSite(worker, service.base);
        const tabs = context.pages().length;
        await openComicPage(page, service, '/strip');
        await readDown(page);
        await page.waitForTimeout(2000);
        expect(service.state.createBodies.length).toBe(0);
        expect(service.state.puts.length).toBe(0);
        expect(context.pages().length).toBe(tabs);
        await expect(page.locator('.ai-translator-comic-progress')).toHaveCount(0);
      } finally {
        await service.close();
      }
    });

    test('signing in after the page loaded does not start it: its purchases were never read', async ({ context, page }) => {
      const service = await startMockService('succeed', { chapter: { stepMs: STEP_MS } });
      try {
        const worker = await connectExtension(context, service.base, { signedIn: false });
        await autoTranslateSite(worker, service.base);
        await openComicPage(page, service, '/strip');
        await setExtensionAccount(page, true);
        await page.waitForTimeout(1000);
        await readDown(page);
        await page.waitForTimeout(2000);
        expect(service.state.createBodies.length).toBe(0);
      } finally {
        await service.close();
      }
    });

    test('a used-up allowance opens the chapter card on View plans and orders nothing more', async ({ context, page }) => {
      test.setTimeout(60_000);
      const service = await startMockService('insufficient', { chapter: { stepMs: STEP_MS } });
      try {
        const worker = await connectExtension(context, service.base);
        await autoTranslateSite(worker, service.base);
        await openComicPage(page, service, '/strip');

        // Both pages that went out together are refused; the chapter card opens
        // on its own, and the first thing it offers is the plans, not Retry.
        await expect.poll(() => service.state.createBodies.length, { timeout: 20_000 }).toBe(2);
        const viewPlans = page.locator(`${SUMMARY} .ai-translator-comic-btn.is-primary`);
        await expect(viewPlans).toBeVisible({ timeout: 20_000 });
        await expect(viewPlans).toHaveText('View plans');
        await expect(page.locator(`${SUMMARY} .ai-translator-comic-btn`).nth(1)).toHaveText('Retry failed');

        // Stopped for this document: reading on does not buy the next page,
        // even on a reader that writes the page it is on into the address.
        await readDown(page, { writeAddress: true });
        await page.waitForTimeout(2000);
        expect(service.state.createBodies.length).toBe(2);

        const [opened] = await Promise.all([context.waitForEvent('page'), viewPlans.click()]);
        await expect.poll(() => opened.url()).toBe(`${service.base}/app/pricing?utm_source=extension&utm_medium=comic_quota`);
      } finally {
        await service.close();
      }
    });

    test('pages past the allowance still wait for the reader to approve the charge', async ({ context, page }) => {
      const service = await startMockService('confirm', { chapter: { stepMs: STEP_MS } });
      try {
        const worker = await connectExtension(context, service.base);
        await autoTranslateSite(worker, service.base);
        await openComicPage(page, service, '/strip');
        await expect.poll(() => service.state.createBodies.length, { timeout: 20_000 }).toBe(2);
        await readDown(page);
        await page.waitForTimeout(2000);
        expect(service.state.createBodies.length).toBe(2);
        expect(service.state.createBodies.every(body => body.confirmCharge !== true)).toBe(true);
        expect(Object.keys(service.state.jobs)).toHaveLength(0);
      } finally {
        await service.close();
      }
    });
  });

  test('a site not set to translate automatically does not start a strip on entry', async ({ context, page }) => {
    const service = await startMockService('succeed', { chapter: { stepMs: STEP_MS } });
    try {
      await connectExtension(context, service.base);
      await openComicPage(page, service, '/strip');
      await readDown(page);
      await page.waitForTimeout(2000);
      expect(service.state.createBodies.length).toBe(0);
    } finally {
      await service.close();
    }
  });
});
