/**
 * The chapter pill: one count for every page this document is translating.
 *
 * 一页上同时翻了十二张，右上角的「翻译本章 n/12」要跟着每页的结果一步步走，最后停在
 * 服务端失败两张之后的 10/12；卡片列出这两张，「重试失败」只重派这两张，「在阅读台
 * 打开本章」打开的是这一章的文档，从最前面的那一页开始。每张图自己的标照旧，数目和
 * 汇总一致。服务是 comic-fixtures.js 里那台模拟的（chapter 模式）。
 */
const { test, expect } = require('./fixtures');
const { connectExtension, setExtensionAccount } = require('./helpers');
const { startMockService, triggerComicTranslation, triggerComicPageTranslation } = require('./comic-fixtures');

const ROOT = '.ai-translator-comic-summary';
const PILL = `${ROOT} .ai-translator-comic-summary-pill`;
const LABEL = `${ROOT} .ai-translator-comic-summary-label`;
const ITEM = `${ROOT} .ai-translator-comic-summary-item`;
const BUTTON = `${ROOT} .ai-translator-comic-summary-btn`;
const WAITING = `${ROOT} .ai-translator-comic-summary-waiting`;
const RESULTS = 'img.page[src*="/result.png?sig="]';
const FAIL_PAGES = [3, 8];

/** Every label the pill has shown, in order, recorded from the page itself. */
function recordLabels(page) {
  return page.evaluate((selector) => {
    window.__summaryLabels = [];
    new MutationObserver(() => {
      const label = document.querySelector(selector);
      const text = label ? label.textContent : '';
      const seen = window.__summaryLabels;
      if (text && seen[seen.length - 1] !== text) seen.push(text);
    }).observe(document.documentElement, { subtree: true, childList: true, characterData: true });
  }, LABEL);
}

const doneOf = text => Number(/(\d+)\/(\d+)/.exec(text)[1]);

/** The twelve-page chapter, every page decoded; resolves to its URL. */
async function openChapter(page, service) {
  const pageUrl = `${service.base}/chapter12`;
  await page.goto(pageUrl);
  await decodePages(page);
  return pageUrl;
}

const decodePages = page => page.locator('img.page').evaluateAll(imgs => Promise.all(imgs.map(img => img.decode())));

test.describe('Comic chapter summary', () => {
  test('counts a chapter to 10/12, retries only the failed pages, and opens the chapter in the reader', async ({ context, page }) => {
    test.setTimeout(90_000);
    const service = await startMockService('succeed', { chapter: { failPages: FAIL_PAGES, stepMs: 600 } });
    try {
      const worker = await connectExtension(context, service.base);
      const pageUrl = `${service.base}/chapter12`;
      await page.goto(pageUrl);
      await page.locator('img.page').evaluateAll(imgs => Promise.all(imgs.map(img => img.decode())));
      await recordLabels(page);

      await triggerComicPageTranslation(worker, pageUrl);
      await expect.poll(() => service.state.createBodies.length, { timeout: 20_000 }).toBe(12);
      expect(service.state.createBodies.map(body => body.pageIndex).sort((a, b) => a - b))
        .toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);

      await expect(page.locator(LABEL)).toHaveText('Chapter 10/12', { timeout: 30_000 });
      await expect(page.locator(ROOT)).toHaveClass(/is-error/);

      // Step by step: never backwards, and through at least one figure between
      // the start and the end rather than jumping straight to the result.
      const labels = await page.evaluate(() => window.__summaryLabels);
      // Getting ready until the first job exists, then counted out of every
      // page, running ones included, and never back to getting ready.
      const counted = labels.slice(labels.findIndex(label => label !== 'Preparing…'));
      labels.slice(0, labels.length - counted.length).forEach(label => expect(label).toBe('Preparing…'));
      counted.forEach(label => expect(label).toMatch(/\/12$/));
      const done = counted.map(doneOf);
      done.forEach((n, i) => { if (i) expect(n).toBeGreaterThanOrEqual(done[i - 1]); });
      expect(done.some(n => n > 0 && n < 10)).toBe(true);
      expect(labels[labels.length - 1]).toBe('Chapter 10/12');

      // The pages' own marks say the same: ten translated, two failed.
      await expect(page.locator('img.page[src*="/result.png?sig="]')).toHaveCount(10);
      await expect(page.locator('.ai-translator-comic-progress.is-error')).toHaveCount(2);
      // The chapter card lists the failures; each page's own card stays shut
      // until its chip is clicked.
      const errorCards = page.locator('.ai-translator-comic-progress.is-error .ai-translator-comic-card');
      await expect(errorCards.nth(0)).toBeHidden();
      await expect(errorCards.nth(1)).toBeHidden();
      await page.locator('.ai-translator-comic-progress.is-error .ai-translator-comic-pill').nth(0).click();
      await expect(errorCards.nth(0)).toBeVisible();
      await expect(errorCards.nth(1)).toBeHidden();

      // Fixed in the corner, clear of the page's own toolbar button.
      const [pill, native] = await Promise.all([
        page.locator(PILL).boundingBox(),
        page.locator('#native').boundingBox(),
      ]);
      expect(pill.y >= native.y + native.height || pill.x + pill.width <= native.x).toBe(true);
      expect(Math.round(1280 - (pill.x + pill.width))).toBeLessThanOrEqual(16);

      await page.locator(PILL).click();
      await expect(page.locator(ITEM)).toHaveCount(2);
      await expect(page.locator(ITEM).nth(0)).toContainText(`Page ${FAIL_PAGES[0] + 1}`);
      await expect(page.locator(ITEM).nth(1)).toContainText(`Page ${FAIL_PAGES[1] + 1}`);

      await page.locator(BUTTON, { hasText: 'Retry failed' }).click();
      await expect.poll(() => service.state.createBodies.length, { timeout: 20_000 }).toBe(14);
      expect(service.state.createBodies.slice(12).map(body => body.pageIndex).sort((a, b) => a - b)).toEqual(FAIL_PAGES);
      await expect(page.locator(LABEL)).toHaveText('Chapter 12/12', { timeout: 30_000 });
      await expect(page.locator(ITEM)).toHaveCount(0);
      await expect(page.locator('img.page[src*="/result.png?sig="]')).toHaveCount(12);
      expect(service.state.createBodies).toHaveLength(14);

      const opened = context.waitForEvent('page');
      await page.locator(BUTTON, { hasText: 'Open chapter in reader' }).click();
      const reader = await opened;
      await reader.waitForURL(/\/app\/reader\//);
      const url = new URL(reader.url());
      expect(url.origin).toBe(service.base);
      expect(url.pathname).toBe('/app/reader/asset_chapter_1');
      expect(url.searchParams.get('pageIndex')).toBe('0');
      expect(url.searchParams.get('utm_medium')).toBe('comic_summary');
    } finally {
      await service.close();
    }
  });

  test('a failed page says why, on its own card and in the chapter card', async ({ context, page }) => {
    test.setTimeout(90_000);
    const service = await startMockService('succeed', {
      chapter: { failPages: FAIL_PAGES, failCode: 'comic_unsupported_script', stepMs: 300 }
    });
    try {
      const worker = await connectExtension(context, service.base);
      const pageUrl = await openChapter(page, service);
      await triggerComicPageTranslation(worker, pageUrl);
      await expect(page.locator(LABEL)).toHaveText('Chapter 10/12', { timeout: 30_000 });

      await page.locator('.ai-translator-comic-progress.is-error .ai-translator-comic-pill').nth(0).click();
      await expect(page.locator('.ai-translator-comic-progress.is-error .ai-translator-comic-card').nth(0))
        .toContainText('This script is not supported yet');

      await page.locator(PILL).click();
      await expect(page.locator(ITEM)).toHaveCount(2);
      for (const i of [0, 1]) {
        await expect(page.locator(ITEM).nth(i).locator('.ai-translator-comic-summary-reason'))
          .toHaveText('This script is not supported yet');
      }
    } finally {
      await service.close();
    }
  });

  test('cancelling all while every page waits on the charge card frees them to run again', async ({ context, page }) => {
    test.setTimeout(90_000);
    const service = await startMockService('confirm', { chapter: { stepMs: 600 } });
    try {
      const worker = await connectExtension(context, service.base);
      const pageUrl = `${service.base}/chapter12`;
      await page.goto(pageUrl);
      await page.locator('img.page').evaluateAll(imgs => Promise.all(imgs.map(img => img.decode())));

      await triggerComicPageTranslation(worker, pageUrl);
      await expect.poll(() => service.state.createBodies.length, { timeout: 20_000 }).toBe(12);
      // Every page waits on its price: nothing is translating, and the pill
      // says what it waits for instead of spinning.
      await expect(page.locator(LABEL)).toHaveText('Awaiting confirmation', { timeout: 10_000 });
      await expect(page.locator(ROOT)).not.toHaveClass(/is-busy/);

      await page.locator(PILL).click();
      await expect(page.locator(WAITING)).toBeVisible();
      await expect(page.locator(WAITING)).toHaveText('Pages waiting for confirmation: 12');
      await page.locator(BUTTON, { hasText: 'Cancel all' }).click();
      await expect(page.locator(ROOT)).toHaveCount(0);
      await expect(page.locator('.ai-translator-comic-progress')).toHaveCount(0);

      // Every page let go of its card, so asking again asks the service again.
      await triggerComicPageTranslation(worker, pageUrl);
      await expect.poll(() => service.state.createBodies.length, { timeout: 20_000 }).toBe(24);
      await expect(page.locator(LABEL)).toHaveText('Awaiting confirmation', { timeout: 10_000 });
    } finally {
      await service.close();
    }
  });

  test('cancelling all while every page waits on the sign-in card frees them to run again', async ({ context, page }) => {
    test.setTimeout(90_000);
    const service = await startMockService('succeed', { chapter: { stepMs: 600 } });
    try {
      const worker = await connectExtension(context, service.base, { signedIn: false });
      const pageUrl = `${service.base}/chapter12`;
      await page.goto(pageUrl);
      await page.locator('img.page').evaluateAll(imgs => Promise.all(imgs.map(img => img.decode())));

      await triggerComicPageTranslation(worker, pageUrl);
      await expect(page.locator('.ai-translator-comic-progress .ai-translator-comic-label', { hasText: 'Sign-in needed' }))
        .toHaveCount(12, { timeout: 20_000 });
      // All twelve wait on the reader, so the pill does too, without a spinner.
      await expect(page.locator(LABEL)).toHaveText('Sign-in needed');
      await expect(page.locator(ROOT)).not.toHaveClass(/is-busy/);

      await page.locator(PILL).click();
      await expect(page.locator(WAITING)).toBeVisible();
      await expect(page.locator(WAITING)).toHaveText('Pages waiting for sign-in: 12');
      await page.locator(BUTTON, { hasText: 'Cancel all' }).click();
      await expect(page.locator(ROOT)).toHaveCount(0);
      await expect(page.locator('.ai-translator-comic-progress')).toHaveCount(0);

      // No page is still waiting on a card that is gone: asking again runs all twelve.
      await triggerComicPageTranslation(worker, pageUrl);
      await expect(page.locator(LABEL)).toHaveText('Sign-in needed', { timeout: 20_000 });
      await expect(page.locator('.ai-translator-comic-progress')).toHaveCount(12);
    } finally {
      await service.close();
    }
  });

  test('one page on the charge card and one on the sign-in card: the pill asks for the sign-in first', async ({ context, page }) => {
    test.setTimeout(90_000);
    const service = await startMockService('confirm', { chapter: { stepMs: 600 } });
    try {
      const worker = await connectExtension(context, service.base);
      const pageUrl = await openChapter(page, service);

      await triggerComicTranslation(worker, pageUrl, `${service.base}/source.png?page=1`);
      await expect(page.locator('.ai-translator-comic-progress .ai-translator-comic-label', { hasText: 'Awaiting confirmation' }))
        .toHaveCount(1, { timeout: 20_000 });
      await setExtensionAccount(page, false);
      await triggerComicTranslation(worker, pageUrl, `${service.base}/source.png?page=2`);
      await expect(page.locator('.ai-translator-comic-progress .ai-translator-comic-label', { hasText: 'Sign-in needed' }))
        .toHaveCount(1, { timeout: 20_000 });

      // Sign-in comes before any price, so it is what the pill waits for.
      await expect(page.locator(LABEL)).toHaveText('Sign-in needed');
      await expect(page.locator(ROOT)).not.toHaveClass(/is-busy/);
      await page.locator(PILL).click();
      await expect(page.locator(WAITING)).toBeVisible();
      await expect(page.locator(`${WAITING} > div`)).toHaveText(['Pages waiting for sign-in: 1', 'Pages waiting for confirmation: 1']);
    } finally {
      await service.close();
    }
  });

  test('while every page is still getting ready the pill does not spin, and it does once a job exists', async ({ context, page }) => {
    test.setTimeout(90_000);
    const service = await startMockService('succeed', { chapter: { stepMs: 15_000 }, uploadDelayMs: 2500 });
    try {
      const worker = await connectExtension(context, service.base);
      const pageUrl = await openChapter(page, service);

      await triggerComicPageTranslation(worker, pageUrl);
      await expect(page.locator(LABEL)).toHaveText('Preparing…', { timeout: 10_000 });
      await expect(page.locator(ROOT)).not.toHaveClass(/is-busy/);
      // Read while the uploads are still held: no page had its job yet.
      expect(service.state.createBodies).toHaveLength(0);

      await expect.poll(() => service.state.createBodies.length, { timeout: 20_000 }).toBeGreaterThan(0);
      await expect(page.locator(ROOT)).toHaveClass(/is-busy/, { timeout: 10_000 });
      await expect(page.locator(LABEL)).toHaveText(/^Chapter \d+\/12$/);
    } finally {
      await service.close();
    }
  });

  test('cancelling all stops the running pages and keeps the finished ones', async ({ context, page }) => {
    test.setTimeout(90_000);
    const service = await startMockService('succeed', { chapter: { stepMs: 900 } });
    try {
      const worker = await connectExtension(context, service.base);
      const pageUrl = `${service.base}/chapter12`;
      await page.goto(pageUrl);
      await page.locator('img.page').evaluateAll(imgs => Promise.all(imgs.map(img => img.decode())));

      await triggerComicPageTranslation(worker, pageUrl);
      await expect(page.locator(LABEL)).toHaveText(/^Chapter [3-6]\/12$/, { timeout: 30_000 });
      await page.locator(PILL).click();
      await page.locator(BUTTON, { hasText: 'Cancel all' }).click();

      const results = page.locator('img.page[src*="/result.png?sig="]');
      await expect(page.locator(LABEL)).toHaveText(/^Chapter (\d+)\/\1$/);
      const label = await page.locator(LABEL).textContent();
      const finished = doneOf(label);
      await expect(results).toHaveCount(finished);
      await expect.poll(() => service.state.abandoned.length).toBe(12 - finished);
      // Only running jobs were abandoned; a finished page keeps its result.
      const kept = await results.evaluateAll(imgs => imgs.map(img => new URL(img.src).searchParams.get('sig')));
      expect(service.state.abandoned.filter(jobId => kept.includes(jobId))).toEqual([]);
      await page.waitForTimeout(1500);
      await expect(results).toHaveCount(finished);
    } finally {
      await service.close();
    }
  });

  test('a reload mid-chapter brings the chapter pill back with every running page', async ({ context, page }) => {
    test.setTimeout(90_000);
    const service = await startMockService('succeed', { chapter: { stepMs: 15_000 } });
    try {
      const worker = await connectExtension(context, service.base);
      const pageUrl = await openChapter(page, service);

      await triggerComicPageTranslation(worker, pageUrl);
      await expect.poll(() => service.state.createBodies.length, { timeout: 20_000 }).toBe(12);
      await expect(page.locator(LABEL)).toHaveText('Chapter 0/12');

      await page.reload();
      await decodePages(page);
      await expect(page.locator('.ai-translator-comic-progress')).toHaveCount(12, { timeout: 15_000 });
      // Picked back up, not asked again: the pill counts the resumed jobs.
      await expect(page.locator(LABEL)).toHaveText('Chapter 0/12');
      expect(service.state.createBodies).toHaveLength(12);
    } finally {
      await service.close();
    }
  });

  test('pages resumed after a reload that then fail are counted, listed and offered a retry', async ({ context, page }) => {
    test.setTimeout(120_000);
    const service = await startMockService('succeed', { chapter: { failPages: [0, 1], stepMs: 4_000 } });
    try {
      const worker = await connectExtension(context, service.base);
      const pageUrl = await openChapter(page, service);
      await triggerComicPageTranslation(worker, pageUrl);
      await expect.poll(() => service.state.createBodies.length, { timeout: 20_000 }).toBe(12);

      // Every page is still running on the server when the page goes away, so
      // all twelve outcomes — the two failures too — arrive on resumed jobs.
      await page.reload();
      await decodePages(page);
      await expect(page.locator(LABEL)).toHaveText('Chapter 10/12', { timeout: 80_000 });
      await expect(page.locator(ITEM)).toHaveCount(2, { timeout: 10_000 });
      await expect(page.locator(BUTTON, { hasText: 'Retry failed' })).toHaveCount(1);
      await expect(page.locator(BUTTON, { hasText: 'Cancel all' })).toHaveCount(0);
      // The failures are told in the chapter card; their own cards stay shut.
      const errorCards = page.locator('.ai-translator-comic-progress.is-error .ai-translator-comic-card');
      await expect(errorCards).toHaveCount(2);
      await expect(errorCards.nth(0)).toBeHidden();
      await expect(errorCards.nth(1)).toBeHidden();
      expect(service.state.createBodies).toHaveLength(12);
    } finally {
      await service.close();
    }
  });

  test('a reload after the whole chapter finished puts the pages back without a chapter pill', async ({ context, page }) => {
    test.setTimeout(90_000);
    const service = await startMockService('succeed', { chapter: { stepMs: 150 } });
    try {
      const worker = await connectExtension(context, service.base);
      const pageUrl = await openChapter(page, service);
      await triggerComicPageTranslation(worker, pageUrl);
      await expect(page.locator(LABEL)).toHaveText('Chapter 12/12', { timeout: 40_000 });

      // No decode wait: the restore swaps finished pages' src under it.
      await page.reload();
      await expect(page.locator(RESULTS)).toHaveCount(12, { timeout: 20_000 });
      await expect(page.locator('.ai-translator-comic-badge')).toHaveCount(12);
      // Give a pill raised by the restore time to show up.
      await page.waitForTimeout(1500);
      await expect(page.locator(ROOT)).toHaveCount(0);
      expect(service.state.createBodies).toHaveLength(12);
    } finally {
      await service.close();
    }
  });

  test('a reload with four pages finished and eight running counts the finished ones', async ({ context, page }) => {
    test.setTimeout(120_000);
    // Page n finishes 8 s after the one before it: a wide window to reload in
    // between the fourth and the fifth.
    const service = await startMockService('succeed', { chapter: { stepMs: 8_000 } });
    try {
      const worker = await connectExtension(context, service.base);
      const pageUrl = await openChapter(page, service);
      await triggerComicPageTranslation(worker, pageUrl);
      await expect(page.locator(LABEL)).toHaveText('Chapter 4/12', { timeout: 60_000 });

      // Every label from the reloaded document's first moment on.
      await page.addInitScript((selector) => {
        window.__summaryLabels = [];
        new MutationObserver(() => {
          const label = document.querySelector(selector);
          const text = label ? label.textContent : '';
          const seen = window.__summaryLabels;
          if (text && seen[seen.length - 1] !== text) seen.push(text);
        }).observe(document, { subtree: true, childList: true, characterData: true });
      }, LABEL);
      // No decode wait: the restore swaps finished pages' src under it.
      await page.reload();
      // As the chips have it: four translated, eight still running — not 0/8.
      await expect(page.locator(LABEL)).toHaveText('Chapter 4/12', { timeout: 6_000 });
      await expect(page.locator(RESULTS)).toHaveCount(4);
      // From its first frame: no 0/8 while the finished pages were still on
      // their way back.
      const labels = await page.evaluate(() => window.__summaryLabels);
      expect(labels[0]).toBe('Chapter 4/12');
      labels.forEach(label => expect(label).toMatch(/\/12$/));
      expect(service.state.createBodies).toHaveLength(12);
    } finally {
      await service.close();
    }
  });

  test('a page translated after reloading a finished chapter brings the pill back counting the restored pages', async ({ context, page }) => {
    test.setTimeout(90_000);
    const service = await startMockService('succeed', { chapter: { stepMs: 150 } });
    try {
      const worker = await connectExtension(context, service.base);
      const pageUrl = await openChapter(page, service);
      await triggerComicPageTranslation(worker, pageUrl);
      await expect(page.locator(LABEL)).toHaveText('Chapter 12/12', { timeout: 40_000 });

      // No decode wait: the restore swaps finished pages' src under it.
      await page.reload();
      await expect(page.locator(RESULTS)).toHaveCount(12, { timeout: 20_000 });
      await expect(page.locator(ROOT)).toHaveCount(0);

      // A thirteenth page the reader asks for on this load.
      await page.evaluate(() => {
        const img = document.createElement('img');
        img.className = 'page';
        img.src = '/source.png?page=13';
        img.width = 150;
        img.style.cssText = 'display:block;margin:0 10px 10px 0';
        document.querySelector('img.page').parentElement.appendChild(img);
        return img.decode();
      });
      await triggerComicTranslation(worker, pageUrl, `${service.base}/source.png?page=13`);
      await expect(page.locator(LABEL)).toHaveText('Chapter 13/13', { timeout: 20_000 });
      expect(service.state.createBodies).toHaveLength(13);
    } finally {
      await service.close();
    }
  });
});
