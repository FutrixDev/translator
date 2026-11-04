/**
 * One click on the float ball does what the page is (ctx.togglePage,
 * content/content-media-hints.js):
 *
 *   - a long comic strip on screen (hasComicStack): the click translates every
 *     page of it; the next click puts the originals back and stops the
 *     chapter (pages scrolled to afterwards are not bought), and the one after
 *     shows the translations again, still without ordering anything;
 *   - a PDF document: the click hands the PDF over, the same job Alt+M starts;
 *   - anything else stays the text toggle (float-ball.spec.js).
 *
 * The ball's title names what the next click will do, and the popup's
 * "Translate page" row asks the same question and reads the same words.
 */
const { test, expect } = require('./fixtures');
const { connectExtension, openPopupOver, waitForFloatBall } = require('./helpers');
const { clickBall } = require('./float-ball-helpers');
const { startMockService, openComicPage, triggerComicTranslation } = require('./comic-fixtures');
const { startDocService } = require('./doc-service-mock');

const BALL = '#ai-translator-float-ball';
const RESULT = 'img.page[src*="/result.png?sig="]';
/**
 * The comic flow's own "nothing to translate here" line (comic.showDetachedError).
 * Counted once, never with toHaveCount: that retries, and the toast takes
 * itself down after 4 s.
 */
const NO_PAGE_TOAST = '.ai-translator-comic-toast';
const PDF_JOBS = (service) => service.state.apiHits.filter(h => h === 'POST /api/pdf/jobs').length;

/** The ball's name is asked again on each mouseenter: leave it, then come back. */
async function hoverBallAgain(page) {
  await page.mouse.move(5, 5);
  await page.locator(BALL).hover({ position: { x: 18, y: 18 } });
}

test.describe('Float ball dispatch', () => {
  test('on a comic strip the ball translates the strip, then shows the originals, then the translations, ordering once', async ({ context, page }) => {
    test.setTimeout(90_000);
    const service = await startMockService('succeed', { chapter: { stepMs: 400 } });
    try {
      await connectExtension(context, service.base);
      await openComicPage(page, service, '/strip');
      await waitForFloatBall(page);

      const ball = page.locator(BALL);
      await expect(ball).toHaveAttribute('title', 'Translate Comic Page');

      await clickBall(page);
      // The pages already loaded are ordered; the lazy ones wait to be scrolled to.
      await expect.poll(() => service.state.createBodies.length, { timeout: 20_000 }).toBe(3);
      await expect(page.locator(RESULT)).toHaveCount(3, { timeout: 30_000 });
      const ordered = service.state.createBodies.length;

      await hoverBallAgain(page);
      await expect(ball).toHaveAttribute('title', 'Show Original');

      await clickBall(page);
      await expect(page.locator(RESULT)).toHaveCount(0);
      await hoverBallAgain(page);
      await expect(ball).toHaveAttribute('title', 'Translate Comic Page');

      // "Show original" also stops the chapter: reading on down the strip, the
      // lazy pages that come into view are not bought.
      for (let y = 600; y <= 3000; y += 600) {
        await page.evaluate(top => window.scrollTo(0, top), y);
        await page.waitForTimeout(300);
      }
      await page.waitForTimeout(2000);
      expect(service.state.createBodies.length).toBe(ordered);
      await page.evaluate(() => window.scrollTo(0, 0));

      await clickBall(page);
      await expect(page.locator(RESULT)).toHaveCount(3);
      // Showing a page that is already translated is not a new order — and the
      // pages still loading their redraw back are pages, not "no comic here".
      await page.waitForTimeout(1500);
      expect(service.state.createBodies.length).toBe(ordered);
      expect(await page.locator(NO_PAGE_TOAST).count()).toBe(0);
    } finally {
      await service.close();
    }
  });

  test('a page already colorized is put back as it was, not bought again as a combined job', async ({ context, page }) => {
    test.setTimeout(90_000);
    const service = await startMockService('succeed', { chapter: { stepMs: 400 } });
    try {
      const worker = await connectExtension(context, service.base);
      await openComicPage(page, service, '/strip');
      await waitForFloatBall(page);

      // Colorizing one page of a strip arms the chapter: the other pages on
      // screen follow in the same mode.
      await triggerComicTranslation(worker, page, `${service.base}/strip`, `${service.base}/source.png?page=1`, 'colorize');
      await expect(page.locator(RESULT)).toHaveCount(3, { timeout: 30_000 });
      const bought = service.state.createBodies.map(body => body.mode);
      expect(bought).toEqual(['colorize', 'colorize', 'colorize']);
      await hoverBallAgain(page);
      await expect(page.locator(BALL)).toHaveAttribute('title', 'Show Original');

      await clickBall(page);
      await expect(page.locator(RESULT)).toHaveCount(0);

      // The way back shows the colorized pages again. Asking them for a
      // translation too would be modeForShownResult's translate_colorize: a
      // second purchase for every page.
      await clickBall(page);
      await expect(page.locator(RESULT)).toHaveCount(3);
      await page.waitForTimeout(1500);
      expect(service.state.createBodies.map(body => body.mode)).toEqual(bought);
      expect(await page.locator(NO_PAGE_TOAST).count()).toBe(0);
    } finally {
      await service.close();
    }
  });

  test('on a comic strip the popup page row is the comic row', async ({ context, page, extensionId }) => {
    const service = await startMockService('succeed', { chapter: { stepMs: 400 } });
    try {
      await connectExtension(context, service.base);
      await openComicPage(page, service, '/strip');
      await waitForFloatBall(page);

      const popup = await openPopupOver(context, extensionId, page);
      await expect(popup.locator('#translatePageLabel')).toHaveText('Translate Comic Page');
      await expect(popup.locator('#comicTranslatePage')).toBeHidden();
      // Colorize has no counterpart on the page row: it stays.
      await expect(popup.locator('#comicColorizePage')).toBeVisible();
      expect(service.state.createBodies).toHaveLength(0);
    } finally {
      await service.close();
    }
  });

  test('on a PDF document the ball sends the PDF, one job per click', async ({ context, page }) => {
    const service = await startDocService();
    try {
      await connectExtension(context, service.base);
      await page.goto(`${service.base}/paper.pdf`);
      await waitForFloatBall(page, 15_000);

      await expect(page.locator(BALL)).toHaveAttribute('title', 'Translate This PDF');
      expect(service.state.apiHits).toEqual([]);

      await clickBall(page);
      await expect.poll(() => PDF_JOBS(service), { timeout: 20_000 }).toBe(1);
      expect(service.state.apiHits.filter(h => h === 'POST /api/pdf/uploads')).toHaveLength(1);
    } finally {
      await service.close();
    }
  });
});
