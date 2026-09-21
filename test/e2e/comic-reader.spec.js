/**
 * Comic page translation — 读者那一半。
 *
 * 一次重绘要跑一分钟往上，读者不会干等：翻页、回来、隔天再打开。这一组问的都是
 * 「离开又回来」——在跑的任务要重新接上而不是重新下单，跑完的要取回而不是再买一次，
 * 被复用的页位不能继承上一页的译文，内联的图要认得出且记得住。
 *
 * 下单、计费、上传那一组在 comic-translation.spec.js；夹具在 comic-fixtures.js。
 */
const { test, expect } = require('./fixtures');
const { startMockService, connectExtension, triggerComicTranslation } = require('./comic-fixtures');

test.describe('Comic page translation — reader', () => {
  /**
   * A redraw runs for a minute or more, so readers page ahead while they wait.
   * The server has never cared — it finishes the job whoever is watching — but
   * the swap is view state in one document, and a navigation used to throw it
   * away along with the only reference to the job. Both halves of coming back
   * are money: an in-flight job must be re-attached rather than re-ordered, and
   * a finished one must be re-fetched rather than bought a second time.
   */
  test('re-attaches to a job still running after the reader navigates away', async ({ context, page }) => {
    const service = await startMockService('succeed', { succeedAfterMs: 8000 });
    const worker = await connectExtension(context, service.base);
    try {
      await worker.evaluate(() => chrome.storage.sync.set({ enableComicTranslation: true }));
      await page.goto(`${service.base}/page`);
      await page.waitForSelector('#comic');

      await triggerComicTranslation(worker, `${service.base}/page`, `${service.base}/source.png`);
      await expect(page.locator('.ai-translator-comic-overlay')).toBeVisible();

      // The overlay goes up on the click, before the job exists — reloading on
      // that alone tests nothing, because there is no job to come back to. Wait
      // for the record instead: it is written the moment the server hands back a
      // jobId, so its presence is exactly the precondition this test needs.
      await expect.poll(
        () => worker.evaluate(
          () => chrome.storage.local.get('comicJobs').then(r => Object.keys(r.comicJobs || {}).length),
        ),
        { timeout: 15000 },
      ).toBe(1);

      // Away and back while the redraw is still running. The document that
      // ordered it is gone; the job is not.
      await page.reload();
      await page.waitForSelector('#comic');
      await expect(page.locator('.ai-translator-comic-overlay')).toBeVisible();

      await expect(page.locator('#comic')).toHaveAttribute(
        'src', /\/result\.png\?sig=/, { timeout: 30000 },
      );
      await expect(page.locator('.ai-translator-comic-badge')).toBeVisible();
      // The point of the whole feature: one reservation, not two.
      expect(service.state.createBodies).toHaveLength(1);
    } finally {
      await worker.evaluate(() => chrome.storage.sync.remove('enableComicTranslation'));
      await service.close();
    }
  });

  test('puts a finished translation back on a later visit instead of charging again', async ({ context, page }) => {
    const service = await startMockService('succeed');
    const worker = await connectExtension(context, service.base);
    try {
      await worker.evaluate(() => chrome.storage.sync.set({ enableComicTranslation: true }));
      await page.goto(`${service.base}/page`);
      await page.waitForSelector('#comic');

      await triggerComicTranslation(worker, `${service.base}/page`, `${service.base}/source.png`);
      await expect(page.locator('#comic')).toHaveAttribute(
        'src', /\/result\.png\?sig=/, { timeout: 20000 },
      );

      await page.reload();
      await page.waitForSelector('#comic');

      // The presigned URL from last time is long dead, so this has to be a new
      // signature off a fresh poll — not the string that was in the old DOM.
      await expect(page.locator('#comic')).toHaveAttribute(
        'src', /\/result\.png\?sig=/, { timeout: 20000 },
      );
      expect(service.state.createBodies).toHaveLength(1);
      expect(service.state.polls).toBeGreaterThan(2);
    } finally {
      await worker.evaluate(() => chrome.storage.sync.remove('enableComicTranslation'));
      await service.close();
    }
  });

  /**
   * The reader that never reloads.
   *
   * `reload()` above is the easy shape of "the reader went away": the document
   * dies and the content script starts again from the records. An online reader
   * does neither — it recycles a handful of <img> elements and rewrites the URL
   * with pushState — so a translation that belongs to *an element* silently
   * becomes a translation of whatever page that element shows next.
   */
  const readerPage = (base, n) => `${base}/reader?page=${n}`;

  /** The context-menu stand-in, against a tab whose URL moves under it. */
  async function triggerReaderTranslation(worker, base, n) {
    await worker.evaluate(async ({ base, n }) => {
      const [tab] = await chrome.tabs.query({ url: `${base}/reader*` });
      await chrome.tabs.sendMessage(tab.id, {
        type: 'COMIC_TRANSLATE_IMAGE',
        srcUrl: `${base}/source.png?page=${n}`,
        pageUrl: `${base}/reader?page=${n}`,
        targetLang: 'zh-CN',
      });
    }, { base, n });
  }

  test('a recycled page slot does not inherit the previous page translation', async ({ context, page }) => {
    const service = await startMockService('succeed');
    const worker = await connectExtension(context, service.base);
    try {
      await page.goto(`${service.base}/reader`);
      await expect(page).toHaveURL(readerPage(service.base, 1));

      // Page 1 lives in the second slot: 1 % 2.
      const slots = page.locator('.page_img');
      await triggerReaderTranslation(worker, service.base, 1);
      await expect(slots.nth(1)).toHaveAttribute('src', /\/result\.png\?sig=/, { timeout: 20000 });

      const badge = page.locator('.ai-translator-comic-badge');
      await expect(badge).toBeVisible();

      // Forward one page. The other slot takes over; page 1's badge is still
      // its own, and has nothing on screen to sit on.
      await page.evaluate(() => window.turnTo(2));
      await expect(slots.nth(0)).toHaveAttribute('src', '/source.png?page=2');
      await expect(badge).toBeHidden();

      // Forward again — and this is the turn that used to break the reader,
      // because page 3 arrives in the element page 1 was translated in.
      await page.evaluate(() => window.turnTo(3));
      await expect(slots.nth(1)).toHaveAttribute('src', '/source.png?page=3');
      // Page 3 is untranslated, so it gets no badge and nothing covering it.
      await expect(page.locator('.ai-translator-comic-badge')).toHaveCount(0);
      await expect(page.locator('.ai-translator-comic-overlay')).toHaveCount(0);

      // And it can still be translated on its own: the slot's history must not
      // short-circuit into showing page 1's purchase again.
      await triggerReaderTranslation(worker, service.base, 3);
      await expect(slots.nth(1)).toHaveAttribute('src', /\/result\.png\?sig=/, { timeout: 20000 });
      expect(service.state.createBodies).toHaveLength(2);
    } finally {
      await service.close();
    }
  });

  test('the card for a page still redrawing does not follow the slot to another page', async ({ context, page }) => {
    // The reported symptom, exactly: translate a page, turn twice, and the
    // progress card for the first page is sitting on top of the third — which
    // is also unreadable and unclickable while it is there.
    const service = await startMockService('succeed', { succeedAfterMs: 8000 });
    const worker = await connectExtension(context, service.base);
    try {
      await page.goto(`${service.base}/reader`);
      await expect(page).toHaveURL(readerPage(service.base, 1));

      const slots = page.locator('.page_img');
      const overlay = page.locator('.ai-translator-comic-overlay');
      await triggerReaderTranslation(worker, service.base, 1);
      await expect(overlay).toBeVisible();

      // Two turns, so page 3 lands in the slot the running job started in.
      await page.evaluate(() => window.turnTo(2));
      await page.evaluate(() => window.turnTo(3));
      await expect(slots.nth(1)).toHaveAttribute('src', '/source.png?page=3');
      // Page 3 is on screen and readable: the card let go of the slot.
      await expect(slots.nth(1)).toBeVisible();
      await expect(overlay).toBeHidden();

      // Back to page 1, still running. One card, not a second one, and its
      // clock has been running the whole time.
      await page.evaluate(() => window.turnTo(1));
      await expect(overlay).toBeVisible();
      await expect(overlay).toHaveCount(1);

      await expect(slots.nth(1)).toHaveAttribute('src', /\/result\.png\?sig=/, { timeout: 30000 });
      expect(service.state.createBodies).toHaveLength(1);
    } finally {
      await service.close();
    }
  });

  test('a redraw that lands while the reader has turned away waits for them', async ({ context, page }) => {
    // The reader does not sit and watch: they turn the page while it renders.
    // The card belongs to the page it was started on — leaving it up would
    // cover the page they went to read — and the result, when it arrives, has
    // to wait rather than land on whatever is in the slot.
    const service = await startMockService('succeed', { succeedAfterMs: 6000 });
    const worker = await connectExtension(context, service.base);
    try {
      await page.goto(`${service.base}/reader`);
      await expect(page).toHaveURL(readerPage(service.base, 1));

      const slots = page.locator('.page_img');
      const overlay = page.locator('.ai-translator-comic-overlay');
      await triggerReaderTranslation(worker, service.base, 1);
      await expect(overlay).toBeVisible();

      // Away while it is still running.
      await page.evaluate(() => window.turnTo(2));
      await expect(slots.nth(0)).toHaveAttribute('src', '/source.png?page=2');
      await expect(overlay).toBeHidden();

      // Let it finish with page 2 on screen. The record is the only place the
      // outcome shows while the page it belongs to is not being displayed.
      await expect.poll(
        () => worker.evaluate(() => chrome.storage.local.get('comicJobs').then(
          r => Object.values(r.comicJobs || {}).map(job => job.status),
        )),
        { timeout: 40000 },
      ).toContain('succeeded');
      // Page 2 is untouched by a result that was never about it.
      await expect(slots.nth(0)).toHaveAttribute('src', '/source.png?page=2');

      await page.evaluate(() => window.turnTo(1));
      await expect(slots.nth(1)).toHaveAttribute('src', /\/result\.png\?sig=/, { timeout: 20000 });
      await expect(page.locator('.ai-translator-comic-badge')).toBeVisible();
      expect(service.state.createBodies).toHaveLength(1);
    } finally {
      await service.close();
    }
  });

  test('turning back to a translated page puts it back without ordering it again', async ({ context, page }) => {
    const service = await startMockService('succeed');
    const worker = await connectExtension(context, service.base);
    try {
      await page.goto(`${service.base}/reader`);
      await expect(page).toHaveURL(readerPage(service.base, 1));

      const slots = page.locator('.page_img');
      await triggerReaderTranslation(worker, service.base, 1);
      await expect(slots.nth(1)).toHaveAttribute('src', /\/result\.png\?sig=/, { timeout: 20000 });

      // Two turns forward, so the slot is recycled and every trace of page 1 is
      // gone from the DOM.
      await page.evaluate(() => window.turnTo(2));
      await page.evaluate(() => window.turnTo(3));
      await expect(slots.nth(1)).toHaveAttribute('src', '/source.png?page=3');
      await expect(page.locator('.ai-translator-comic-badge')).toHaveCount(0);

      // Back to page 1. The reader turned a page; they did not throw away what
      // they paid for.
      await page.evaluate(() => window.turnTo(1));
      await expect(slots.nth(1)).toHaveAttribute('src', /\/result\.png\?sig=/, { timeout: 20000 });
      await expect(page.locator('.ai-translator-comic-badge')).toBeVisible();
      expect(service.state.createBodies).toHaveLength(1);

      // And asking for it again buys nothing either: what the page knows about
      // page 1 has to outlive the DOM it was displayed in, or a reader working
      // through a chapter pays twice for every page they look at twice.
      await triggerReaderTranslation(worker, service.base, 1);
      await page.waitForTimeout(1500);
      expect(service.state.createBodies).toHaveLength(1);
    } finally {
      await service.close();
    }
  });

  test('gives a recycled slot its responsive markup back', async ({ context, page }) => {
    // Swapping a result in means stripping `srcset`, `sizes` and the
    // `<picture>` sources, because all three outrank `src`. The reader then
    // hands the slot to another page — rewriting `src` and `srcset` itself, and
    // nothing else. Whatever the extension stripped and the site does not
    // rewrite stays stripped forever: every page that lands in that slot for
    // the rest of the session renders from a candidate list that is missing.
    const service = await startMockService('succeed');
    const worker = await connectExtension(context, service.base);
    try {
      await page.goto(`${service.base}/picture-reader`);
      const slots = page.locator('.page_img');
      const before = await page.evaluate(() => {
        const img = document.querySelectorAll('.page_img')[1];
        return { sizes: img.getAttribute('sizes'), source: img.parentElement.querySelector('source').getAttribute('srcset') };
      });

      await worker.evaluate(async ({ base }) => {
        const [tab] = await chrome.tabs.query({ url: `${base}/picture-reader*` });
        await chrome.tabs.sendMessage(tab.id, {
          type: 'COMIC_TRANSLATE_IMAGE',
          srcUrl: `${base}/source.png?page=1`,
          pageUrl: `${base}/picture-reader?page=1`,
          targetLang: 'zh-CN',
        });
      }, { base: service.base });
      await expect(slots.nth(1)).toHaveAttribute('src', /\/result\.png\?sig=/, { timeout: 20000 });
      // Stripped while the result is in place, or the responsive markup would
      // put the untranslated page straight back.
      await expect(slots.nth(1)).not.toHaveAttribute('srcset', /./);

      // Two turns, so page 3 lands in the slot page 1 was translated in.
      await page.evaluate(() => window.turnTo(2));
      await page.evaluate(() => window.turnTo(3));
      await expect(slots.nth(1)).toHaveAttribute('src', '/source.png?page=3');

      await expect.poll(() => page.evaluate(() => {
        const img = document.querySelectorAll('.page_img')[1];
        return { sizes: img.getAttribute('sizes'), source: img.parentElement.querySelector('source').getAttribute('srcset') };
      })).toEqual(before);
      // And the two the site DID rewrite are left as the site wrote them —
      // restoring page 1's would put page 1 back on top of page 3.
      await expect(slots.nth(1)).toHaveAttribute('srcset', '/source.png?page=3 1x');
    } finally {
      await service.close();
    }
  });

  /** The popup's entry point, against a tab whose URL moves under it. */
  const triggerDataReaderTranslation = (worker, base) => worker.evaluate(async ({ base }) => {
    const [tab] = await chrome.tabs.query({ url: `${base}/data-reader*` });
    // No srcUrl: passing a megabyte of base64 through the context menu is not
    // what happens, and the float ball has none either.
    await chrome.tabs.sendMessage(tab.id, { type: 'COMIC_TRANSLATE_PAGE', targetLang: 'zh-CN' });
  }, { base });

  test('tells inlined pages apart without keeping them', async ({ context, page }) => {
    const service = await startMockService('succeed');
    const worker = await connectExtension(context, service.base);
    try {
      await page.goto(`${service.base}/data-reader`);
      const slots = page.locator('.page_img');

      await triggerDataReaderTranslation(worker, service.base);
      await expect(slots.nth(1)).toHaveAttribute('src', /\/result\.png\?sig=/, { timeout: 20000 });

      // Page 3 arrives in page 1's slot. Two inlined pages are two different
      // pages even though neither has a URL to tell them apart by.
      await page.evaluate(() => window.turnTo(2));
      await page.evaluate(() => window.turnTo(3));
      await expect(slots.nth(1)).toHaveAttribute('src', /^data:image\/png/);
      await expect(page.locator('.ai-translator-comic-badge')).toHaveCount(0);

      // Back to page 1: bought, so it comes back on its own and for nothing.
      await page.evaluate(() => window.turnTo(1));
      await expect(slots.nth(1)).toHaveAttribute('src', /\/result\.png\?sig=/, { timeout: 20000 });
      expect(service.state.createBodies).toHaveLength(1);
    } finally {
      await service.close();
    }
  });

  test('remembers an inlined page across a reload', async ({ context, page }) => {
    const service = await startMockService('succeed');
    const worker = await connectExtension(context, service.base);
    try {
      await page.goto(`${service.base}/data-reader`);
      await expect(page.locator('.page_img').nth(1)).toHaveAttribute('src', /^data:image\/png/);

      await triggerDataReaderTranslation(worker, service.base);
      await expect(page.locator('.page_img').nth(1)).toHaveAttribute(
        'src', /\/result\.png\?sig=/, { timeout: 20000 },
      );
      // The record is the whole point: without one there is nothing for the
      // next document to find.
      await expect.poll(
        () => worker.evaluate(() => chrome.storage.local.get('comicJobs').then(
          r => Object.values(r.comicJobs || {}).map(job => job.status),
        )),
        { timeout: 20000 },
      ).toEqual(['succeeded']);
      // And it holds an id of the page, not the page: a record that inlined a
      // megabyte of base64 would blow the extension's storage quota inside a
      // single chapter.
      const stored = await worker.evaluate(() => chrome.storage.local.get('comicJobs').then(
        r => JSON.stringify(r.comicJobs || {}).length,
      ));
      expect(stored).toBeLessThan(1000);

      await page.reload();
      await expect(page.locator('.page_img').nth(1)).toHaveAttribute(
        'src', /\/result\.png\?sig=/, { timeout: 20000 },
      );
      expect(service.state.createBodies).toHaveLength(1);
    } finally {
      await service.close();
    }
  });

  test('asks for sign-in instead of failing when no token is stored', async ({ context, page }) => {
    const service = await startMockService('succeed');
    try {
      const worker = await connectExtension(context, service.base, { withToken: false });
      await page.goto(`${service.base}/page`);
      await page.waitForSelector('#comic');

      await triggerComicTranslation(worker, `${service.base}/page`, `${service.base}/source.png`);

      const overlay = page.locator('.ai-translator-comic-overlay');
      await expect(overlay.locator('.ai-translator-comic-btn.is-primary')).toBeVisible();
      // Without a token the request must not even be attempted.
      expect(service.state.createBodies).toHaveLength(0);
    } finally {
      await service.close();
    }
  });
});
