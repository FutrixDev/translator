/**
 * Comic page translation — end-to-end against a mock of the translation service.
 *
 * 这一份问的是下单本身：原地替换与翻回原图、额度用尽、重试不重复下单、上传的是
 * worker 取到的字节、被拒时退回页面像素、诱饵图层、从 popup 起手、上色与切换产物。
 * 读者翻页、页位复用、跨次访问那一组在 comic-reader.spec.js。
 *
 * 夹具（合成 PNG、读者页、模拟服务）在 comic-fixtures.js，那份文件顶上写了为什么
 * 服务是模拟的。
 */
const { test, expect } = require('./fixtures');
const { connectExtension } = require('./helpers');
const {
  SOURCE_PNG,
  startMockService,
  openComicPage,
  triggerComicTranslation,
  triggerComicPageTranslation,
} = require('./comic-fixtures');

const IMAGE_MAGIC = [Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from([0xff, 0xd8, 0xff])];

/** The create's page was re-encoded by the page's canvas, not the file the server holds. */
function expectCanvasUpload(service, created) {
  expect(created.imageBase64).toBeUndefined();
  const put = service.state.puts.find(entry => entry.sourceKey === created.sourceKey);
  expect(put).toBeTruthy();
  expect(IMAGE_MAGIC.some(magic => put.bytes.subarray(0, magic.length).equals(magic))).toBe(true);
  expect(put.bytes.equals(SOURCE_PNG)).toBe(false);
}

test.describe('Comic page translation', () => {
  test('replaces the page in place and can flip back to the original', async ({ context, page }) => {
    const service = await startMockService('succeed');
    try {
      const worker = await connectExtension(context, service.base);
      await page.goto(`${service.base}/page`);
      await page.waitForSelector('#comic');

      await triggerComicTranslation(worker, page, `${service.base}/page`, `${service.base}/source.png`);

      await expect(page.locator('.ai-translator-comic-progress')).toBeVisible();

      // The swap is the whole feature: same element, new pixels.
      await expect(page.locator('#comic')).toHaveAttribute(
        'src', /\/result\.png\?sig=/, { timeout: 20000 },
      );
      await expect(page.locator('.ai-translator-comic-progress')).toHaveCount(0);

      const badge = page.locator('.ai-translator-comic-badge');
      await expect(badge).toBeVisible();

      await badge.click();
      // Resolved, not the attribute: flipping back restores the markup exactly
      // as the site wrote it, and the site wrote a relative URL.
      expect(await page.locator('#comic').evaluate(img => img.src)).toBe(`${service.base}/source.png`);
      await expect(page.locator('#comic')).toHaveAttribute('src', '/source.png');
      await badge.click();
      await expect(page.locator('#comic')).toHaveAttribute('src', /\/result\.png\?sig=/);

      // One user action must reserve exactly once, whatever the retries.
      expect(service.state.createBodies).toHaveLength(1);
      expect(service.state.createBodies[0].operationId).toBeTruthy();
      expect(service.state.createBodies[0].targetLang).toBe('zh-CN');
      // The library names the job after the page, not the address's last segment.
      expect(service.state.createBodies[0].pageTitle).toBe('Comic');
      // No mode was sent, and the default must stay the original product.
      expect(service.state.createBodies[0].mode).toBe('translate');
    } finally {
      await service.close();
    }
  });

  test('a used-up allowance offers the plans and when it comes back, and spends nothing', async ({ context, page }) => {
    const service = await startMockService('insufficient');
    try {
      const worker = await connectExtension(context, service.base);
      await page.goto(`${service.base}/page`);
      await page.waitForSelector('#comic');

      await triggerComicTranslation(worker, page, `${service.base}/page`, `${service.base}/source.png`);

      const overlay = page.locator('.ai-translator-comic-progress');
      await expect(overlay).toHaveClass(/is-error/);
      await expect(overlay).toContainText('Free pages reset on Nov 1.');
      await expect(overlay).toContainText('Plans include 300 pages a month.');
      // The original page is still what the reader sees. Read the resolved
      // property, not the attribute — an untouched src stays relative.
      expect(await page.locator('#comic').evaluate(img => img.src)).toBe(`${service.base}/source.png`);

      const later = overlay.locator('.ai-translator-comic-btn:not(.is-primary)');
      await expect(later).toHaveText('Translate again after Nov 1');
      const viewPlans = overlay.locator('.ai-translator-comic-btn.is-primary');
      await expect(viewPlans).toHaveText('View plans');
      const [opened] = await Promise.all([context.waitForEvent('page'), viewPlans.click()]);
      await expect.poll(() => opened.url()).toBe(`${service.base}/app/pricing?utm_source=extension&utm_medium=comic_quota`);
      await expect(overlay).toHaveCount(0);
      expect(service.state.polls).toBe(0);
    } finally {
      await service.close();
    }
  });

  test('retrying an undelivered result re-polls the job instead of ordering another', async ({ context, page }) => {
    // The redraw succeeded and the free page is spent; only the download of the
    // finished page failed. A retry that fell through to POST /jobs would order
    // a second redraw of the same page and count it again — a page out of the
    // month's allowance, lost to a transient 403 on a presigned URL.
    const service = await startMockService('succeed', { resultFailures: 1 });
    try {
      const worker = await connectExtension(context, service.base);
      await page.goto(`${service.base}/page`);
      await page.waitForSelector('#comic');

      await triggerComicTranslation(worker, page, `${service.base}/page`, `${service.base}/source.png`);

      const overlay = page.locator('.ai-translator-comic-progress');
      await expect(overlay).toHaveClass(/is-error/, { timeout: 20000 });
      // The unreadable result was NOT swapped in over a page the reader can see.
      expect(await page.locator('#comic').evaluate(img => img.src)).toBe(`${service.base}/source.png`);
      expect(service.state.createBodies).toHaveLength(1);

      await triggerComicTranslation(worker, page, `${service.base}/page`, `${service.base}/source.png`);

      await expect(page.locator('#comic')).toHaveAttribute(
        'src', /\/result\.png\?sig=/, { timeout: 20000 },
      );
      await expect(page.locator('.ai-translator-comic-badge')).toBeVisible();
      // The crux: still one job, so still one page counted.
      expect(service.state.createBodies).toHaveLength(1);
    } finally {
      await service.close();
    }
  });

  test('uploads the bytes the worker fetched, and never sends a URL', async ({ context, page }) => {
    const service = await startMockService('succeed');
    try {
      const worker = await connectExtension(context, service.base);
      await page.goto(`${service.base}/page`);
      await page.waitForSelector('#comic');

      await triggerComicTranslation(worker, page, `${service.base}/page`, `${service.base}/source.png`);

      await expect.poll(() => service.state.createBodies.length, { timeout: 20000 }).toBe(1);
      const [created] = service.state.createBodies;
      // Acquisition happens before the post, not after a rejection: the worker
      // fetched the file itself, carrying the site's cookies and exempt from
      // CORS. Nothing in the body tells the service where the pixels came from.
      expect(created.imageUrl).toBeUndefined();
      expect(created.imageBase64).toBeUndefined();
      // One ticket, one PUT of exactly the file the server sent, and the create
      // names what was put. The bytes going up unchanged is the signature of the
      // worker fetch — the page-canvas rung below re-encodes them.
      expect(service.state.tickets).toHaveLength(1);
      expect(service.state.tickets[0].pages).toEqual([{ index: 0, format: 'png', byteSize: SOURCE_PNG.length }]);
      expect(service.state.puts).toHaveLength(1);
      const [put] = service.state.puts;
      expect(put.contentType).toBe('image/png');
      expect(put.authorization).toBe('');
      expect(put.bytes.equals(SOURCE_PNG)).toBe(true);
      expect(created.sourceKey).toBe(put.sourceKey);
    } finally {
      await service.close();
    }
  });

  test('falls back to the pixels in the page when the worker is refused', async ({ context, page }) => {
    const service = await startMockService('succeed', { hotlinkGuard: true });
    try {
      const worker = await connectExtension(context, service.base);
      // The reader can see the page; only a request without a Referer is refused.
      await openComicPage(page, service);

      await triggerComicTranslation(worker, page, `${service.base}/page`, `${service.base}/source.png`);

      await expect(page.locator('#comic')).toHaveAttribute(
        'src', /\/result\.png\?sig=/, { timeout: 20000 },
      );

      // The worker did try, and was turned away — that is what forced the canvas.
      expect(service.state.sourceDenied).toBeGreaterThan(0);
      // Still a single post: the failed acquisition never reached the service,
      // so no reservation was made and none had to be reused.
      expect(service.state.createBodies).toHaveLength(1);
      const [upload] = service.state.createBodies;
      expect(upload.imageUrl).toBeUndefined();
      // Bytes that are an image but not the file the server holds are the
      // signature of the canvas path: the page re-encoded what it had decoded.
      expectCanvasUpload(service, upload);
    } finally {
      await service.close();
    }
  });

  test('does not upload a 200 that is not an image', async ({ context, page }) => {
    // The guard answers 200 with an HTML interstitial instead of 403. Status and
    // content-type are both whatever the origin felt like claiming, so the bytes
    // are the only reliable test — without the magic-byte sniff this uploads an
    // HTML page, pays for the round trip, and comes back with a rejection the UI
    // cannot explain.
    const service = await startMockService('succeed', { hotlinkGuard: true, guardStatus: 200 });
    try {
      const worker = await connectExtension(context, service.base);
      await openComicPage(page, service);

      await triggerComicTranslation(worker, page, `${service.base}/page`, `${service.base}/source.png`);

      await expect(page.locator('#comic')).toHaveAttribute(
        'src', /\/result\.png\?sig=/, { timeout: 20000 },
      );

      expect(service.state.sourceDenied).toBeGreaterThan(0);
      expect(service.state.createBodies).toHaveLength(1);
      const [upload] = service.state.createBodies;
      // Recovered by the canvas, exactly as a 403 does — the point is that the
      // HTML never became an upload.
      expectCanvasUpload(service, upload);
    } finally {
      await service.close();
    }
  });

  test('translates the artwork under a decoy overlay, not the decoy', async ({ context, page }) => {
    // srcUrl names the placeholder, because that is what the browser hit-tested.
    // Translating it would spend a free page redrawing a 58×65 spacer and leave the
    // page the reader is looking at untouched.
    const service = await startMockService('succeed');
    try {
      const worker = await connectExtension(context, service.base);
      await openComicPage(page, service, '/decoy-page');

      await triggerComicTranslation(worker, page, `${service.base}/decoy-page`, `${service.base}/decoy.png`);

      await expect(page.locator('#comic')).toHaveAttribute(
        'src', /\/result\.png\?sig=/, { timeout: 20000 },
      );
      // The overlay is the site's, not ours to touch.
      expect(await page.locator('#decoy').evaluate(img => img.src)).toBe(`${service.base}/decoy.png`);
      expect(service.state.createBodies).toHaveLength(1);
    } finally {
      await service.close();
    }
  });

  test('starts from the popup with no right-click, and pays for one page', async ({ context, page }) => {
    // The entry point that exists because comic hosts cancel `contextmenu`. The
    // decoy has to be recognised as the same page, or one click buys two jobs.
    const service = await startMockService('succeed');
    try {
      const worker = await connectExtension(context, service.base);
      await openComicPage(page, service, '/decoy-page');

      await triggerComicPageTranslation(worker, page, `${service.base}/decoy-page`);

      await expect(page.locator('#comic')).toHaveAttribute(
        'src', /\/result\.png\?sig=/, { timeout: 20000 },
      );
      expect(service.state.createBodies).toHaveLength(1);
    } finally {
      await service.close();
    }
  });

  /**
   * The pointer buys nothing: hovering only offers.
   *
   * An earlier build started work from the cursor alone. Now a hover shows the
   * image hover bar's chip (test/e2e/comic-hover.spec.js owns it) and nothing
   * else: no job is ordered and no overlay or badge is drawn until the chip,
   * the context menu or the float ball is pressed.
   */
  test('hovering orders nothing, even with the feature on', async ({ context, page }) => {
    const service = await startMockService('succeed');
    const worker = await connectExtension(context, service.base);
    try {
      await worker.evaluate(() => chrome.storage.sync.set({ enableComicTranslation: true }));
      await openComicPage(page, service, '/decoy-page');

      // Move, don't just land: the old trigger was mousemove-driven, so a
      // single hover point would not have fired it either.
      const box = await page.locator('#decoy').boundingBox();
      for (const fraction of [0.3, 0.5, 0.7]) {
        await page.mouse.move(box.x + box.width * fraction, box.y + box.height * fraction);
      }
      // The offer is there, so the hover landed and the silence below means something.
      await expect(page.locator('#ai-translator-comic-hover-btn')).toBeVisible();
      await page.waitForTimeout(600);

      // No overlay, badge or spinner of ours: those belong to a job.
      expect(await page.locator('[class^="ai-translator-comic"]').count()).toBe(0);
      expect(service.state.createBodies).toHaveLength(0);
    } finally {
      await worker.evaluate(() => chrome.storage.sync.remove('enableComicTranslation'));
      await service.close();
    }
  });

  /**
   * Colorizing a page that is showing its translation is a request about the
   * translation, not about the raw page underneath it. The job still runs from
   * the original pixels — stacking a redraw on a redraw compounds artefacts —
   * so both products are asked for in one job instead.
   */
  test('colorizing a translated page asks for both products in one job', async ({ context, page }) => {
    const service = await startMockService('succeed');
    const worker = await connectExtension(context, service.base);
    try {
      await page.goto(`${service.base}/page`);
      await page.waitForSelector('#comic');

      await triggerComicTranslation(worker, page, `${service.base}/page`, `${service.base}/source.png`);
      await expect(page.locator('#comic')).toHaveAttribute(
        'src', /\/result\.png\?sig=/, { timeout: 20000 },
      );
      expect(service.state.createBodies).toHaveLength(1);
      expect(service.state.createBodies[0].mode).toBe('translate');

      await triggerComicTranslation(worker, page, `${service.base}/page`, `${service.base}/source.png`, 'colorize');
      await expect.poll(() => service.state.createBodies.length, { timeout: 20000 }).toBe(2);
      // The whole point: not 'colorize', which would have redrawn the original
      // and thrown the translation away.
      expect(service.state.createBodies[1].mode).toBe('translate_colorize');
      // And from the original bytes, not from the translated result.
      const putFor = body => service.state.puts.find(put => put.sourceKey === body.sourceKey);
      expect(putFor(service.state.createBodies[1]).bytes.equals(SOURCE_PNG)).toBe(true);
      expect(putFor(service.state.createBodies[0]).bytes.equals(SOURCE_PNG)).toBe(true);

      await expect(page.locator('.ai-translator-comic-badge')).toBeVisible({ timeout: 20000 });
      const recordKeys = await worker.evaluate(
        () => chrome.storage.local.get('comicJobs').then(r => Object.keys(r.comicJobs || {})),
      );
      expect(recordKeys.filter(k => k.startsWith('translate|'))).toHaveLength(1);
      expect(recordKeys.filter(k => k.startsWith('translate_colorize|'))).toHaveLength(1);
    } finally {
      await service.close();
    }
  });

  /**
   * Switching a finished page to the other product must not orphan what was
   * already bought. Translate, flip back to the original, colorize it, flip
   * back again and ask for the translation: the last click has to re-poll the
   * first job for a fresh URL — three swaps, exactly two reservations.
   *
   * The badge flips are what make each click a request about the ORIGINAL, so
   * the combined mode above stays out of it and the two single-product
   * purchases are the thing under test.
   */
  test('switching modes re-polls the finished job instead of paying again', async ({ context, page }) => {
    const service = await startMockService('succeed');
    const worker = await connectExtension(context, service.base);
    const badge = page.locator('.ai-translator-comic-badge');
    try {
      await page.goto(`${service.base}/page`);
      await page.waitForSelector('#comic');

      await triggerComicTranslation(worker, page, `${service.base}/page`, `${service.base}/source.png`);
      await expect(page.locator('#comic')).toHaveAttribute(
        'src', /\/result\.png\?sig=/, { timeout: 20000 },
      );
      expect(service.state.createBodies).toHaveLength(1);

      // The other product on the same page: a second paid job, by design.
      await badge.click();
      await expect(page.locator('#comic')).toHaveAttribute('src', /\/source\.png/);
      await triggerComicTranslation(worker, page, `${service.base}/page`, `${service.base}/source.png`, 'colorize');
      await expect.poll(() => service.state.createBodies.length, { timeout: 20000 }).toBe(2);
      expect(service.state.createBodies[1].mode).toBe('colorize');
      await expect(page.locator('#comic')).toHaveAttribute(
        'src', /\/result\.png\?sig=/, { timeout: 20000 },
      );

      // Back to the translation: already bought, so this must be a poll of the
      // first job. The switch tears the colorize badge down, and only a
      // successful recovery puts a badge back — asserting on that cycle rather
      // than on the src, which matches the same result pattern either way.
      await badge.click();
      await expect(page.locator('#comic')).toHaveAttribute('src', /\/source\.png/);
      await triggerComicTranslation(worker, page, `${service.base}/page`, `${service.base}/source.png`, 'translate');
      await expect(badge).toBeVisible({ timeout: 20000 });
      await expect(page.locator('#comic')).toHaveAttribute(
        'src', /\/result\.png\?sig=/, { timeout: 20000 },
      );
      // The whole point: three results shown, exactly two reservations made.
      expect(service.state.createBodies).toHaveLength(2);

      // Both purchases survive for later visits — one record per (mode, image),
      // not one per image with the second overwriting the first.
      const recordKeys = await worker.evaluate(
        () => chrome.storage.local.get('comicJobs').then(r => Object.keys(r.comicJobs || {})),
      );
      expect(recordKeys.filter(k => k.startsWith('translate|'))).toHaveLength(1);
      expect(recordKeys.filter(k => k.startsWith('colorize|'))).toHaveLength(1);
    } finally {
      await service.close();
    }
  });

  test('colorizes from the right-click menu and sends the colorize mode', async ({ context, page }) => {
    const service = await startMockService('succeed');
    const worker = await connectExtension(context, service.base);
    try {
      await worker.evaluate(() => chrome.storage.sync.set({ enableComicTranslation: true }));
      await openComicPage(page, service, '/decoy-page');

      // The decoy is what the right-click reports, and it still has to resolve
      // to the artwork behind it — the same job the translate entry does.
      await triggerComicTranslation(worker, page, `${service.base}/decoy-page`, `${service.base}/decoy.png`, 'colorize',
      );
      await expect(page.locator('#comic')).toHaveAttribute(
        'src', /\/result\.png\?sig=/, { timeout: 20000 },
      );
      // Same pipeline, different product — the mode is the entire difference
      // the server can see.
      expect(service.state.createBodies).toHaveLength(1);
      expect(service.state.createBodies[0].mode).toBe('colorize');
    } finally {
      await worker.evaluate(() => chrome.storage.sync.remove('enableComicTranslation'));
      await service.close();
    }
  });
});
