/**
 * Document formats — the upload page's journeys for everything that is not a
 * PDF (spec docs/plans/2026-09-24-p0-e-document-formats.md §9.2, J-E1–J-E7).
 *
 * The service is the shared mock (doc-service-mock.js); everything on this
 * side is real: the page's local refusals and measurement, its own presigned
 * PUT, the worker's create and poll, the over-page confirmation reached from
 * the popup's notification-backed row, and the result saved under its format's
 * name. The numbers the creates must declare are the fixtures' hand-counted
 * oracle (doc-fixtures.js), the same the measurement unit tests pin.
 */
const fs = require('node:fs');
const { test, expect } = require('./fixtures');
const { getServiceWorker } = require('./helpers');
const { startDocService, TINY_PDF } = require('./doc-service-mock');
const { FIXTURES, mobiBytes } = require('./doc-fixtures');

/** Where the finished-card screenshots go, when a run is collecting evidence. */
const shotDir = process.env.DOC_SCREENSHOT_DIR;

const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const MIB = 1024 * 1024;

/** Point the extension at the mock, signed in, in English, with no old jobs. */
async function connectExtension(context, base) {
  const worker = await getServiceWorker(context);
  await worker.evaluate(async (apiBase) => {
    await chrome.storage.sync.set({ enablePdfTranslation: true });
    await chrome.storage.local.remove(['comicAccountCache', 'pdfJobs', 'pdfUrlOps']);
    await chrome.storage.local.set({
      comicApiBase: apiBase, comicToken: 'test-token', comicTokenExpiresAt: Date.now() + 3600_000,
    });
  }, base);
  return worker;
}

/** A fresh upload page, handed one file. */
async function upload(page, extensionId, name, buffer) {
  await page.goto(`chrome-extension://${extensionId}/pdf/upload.html`);
  await page.setInputFiles('#pdfFileInput', { name, mimeType: 'application/octet-stream', buffer });
}

/** Every locator on screen, with an area, inside the viewport, none overlapping. */
async function expectLaidOut(page, locators) {
  const viewport = page.viewportSize();
  const boxes = [];
  for (const locator of locators) {
    const box = await locator.boundingBox();
    expect(box).not.toBeNull();
    expect(box.width).toBeGreaterThan(0);
    expect(box.height).toBeGreaterThan(0);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
    boxes.push(box);
  }
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const [a, b] = [boxes[i], boxes[j]];
      const apart = a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
      expect(apart, `element ${i} overlaps element ${j}`).toBe(true);
    }
  }
}

/** The English string for a key, straight from the catalog the page loaded. */
const message = (page, key) => page.evaluate(k => getMessage(k, 'en'), key);

/**
 * Click an action that opens a tab and return that tab's address as the
 * browser has it. Read without waiting for the load: the mock answers the
 * reader path with a 404, and the address is what is under test.
 */
async function urlOpenedBy(context, action) {
  const [opened] = await Promise.all([context.waitForEvent('page'), action.click()]);
  await expect.poll(() => opened.url()).not.toBe('about:blank');
  return opened.url();
}

/**
 * J-E1 / J-E2: a measurable document goes up with its format and its measured
 * length, comes back succeeded, and saves under "<name> (bilingual).<ext>".
 */
for (const format of ['docx', 'epub']) {
  const fixture = FIXTURES[format];
  test(`J-E${format === 'docx' ? 1 : 2}: ${format === 'docx' ? 'a' : 'an'} ${format} is uploaded, declared, translated and saved`,
    async ({ context, page, extensionId }) => {
      const service = await startDocService();
      try {
        await connectExtension(context, service.base);
        await upload(page, extensionId, fixture.fileName, fixture.bytes);
        await expect(page.locator('#docSaveDual')).toBeVisible({ timeout: 20000 });
        // J2 step 1: View is the one primary action; the file the format
        // writes back is saved from a secondary button beside it (D-488).
        await expect(page.locator('#docView')).toBeVisible();
        await expect(page.locator('#docView')).toHaveClass(/\bbtn-primary\b/);
        await expect(page.locator('#docSaveDual')).toHaveClass(/\bbtn-secondary\b/);
        await expect(page.locator('#pdfOpenDual')).toHaveCount(0);
        await expect(page.locator('#pdfError')).toBeHidden();

        const [ticket] = service.state.uploadTickets;
        expect(service.state.uploadTickets).toHaveLength(1);
        expect(ticket).toEqual({ operationId: expect.any(String), byteSize: fixture.bytes.length, sourceFormat: format });

        const [put] = service.state.uploadPuts;
        expect(service.state.uploadPuts).toHaveLength(1);
        expect(put.contentType).toBe(format === 'docx' ? DOCX_TYPE : 'application/epub+zip');
        expect(put.byteLength).toBe(fixture.bytes.length);
        expect(put.authorization).toBeNull();

        const [created] = service.state.createBodies;
        expect(service.state.createBodies).toHaveLength(1);
        expect(created.operationId).toBe(ticket.operationId);
        expect(created.sourceKey).toBe(`pdf/u1/${ticket.operationId}/source.${format}`);
        expect(created.sourceFormat).toBe(format);
        expect(created.fileName).toBe(fixture.fileName);
        expect(created.targetLang).toBeTruthy();
        expect(created.output).toEqual({ kind: 'dual', dualLayout: 'side-by-side', watermark: false });
        // docx 4235 characters -> 2; epub 2413 -> 1, which only holds if the
        // 1199-character nav.xhtml was left out.
        expect(created.declaredUnits).toBe(fixture.units);

        // The extension orders dual, and the engine writes that one file back.
        await expect(page.locator('#docSaveMono')).toBeHidden();
        await expect(page.locator('#pdfJobCard .job-actions button:visible')).toHaveCount(2);
        await expect(page.locator('#pdfJobCard a')).toHaveCount(0);
        await expectLaidOut(page, [page.locator('#pdfFileName'), page.locator('#docView'),
          page.locator('#docSaveDual')]);
        if (shotDir && format === 'docx') {
          await page.emulateMedia({ colorScheme: 'light' });
          await page.locator('#pdfJobCard').screenshot({ path: `${shotDir}/j2-docx-card.png` });
        }

        // J2 step 2: View opens the reader on this job.
        expect(await urlOpenedBy(context, page.locator('#docView'))).toBe(`${service.base}/app/reader/pdf_job_1`);

        // J2 step 3: the save is unchanged.

        const [download] = await Promise.all([
          page.waitForEvent('download'),
          page.locator('#docSaveDual').click(),
        ]);
        const stem = fixture.fileName.replace(/\.[a-z]+$/, '');
        expect(download.suggestedFilename()).toBe(`${stem} (bilingual).${format}`);
        expect(fs.readFileSync(await download.path())).toEqual(service.resultBytes('pdf_job_1', 'dual'));
      } finally {
        await service.close();
      }
    });
}

test('J-E3: a job that turns out longer asks, from the popup, and continues once confirmed',
  async ({ context, page, extensionId }) => {
    const confirm = { measuredUnits: 5, reservedUnits: 2, extraUnits: 3, expiresAt: Date.now() + 86_400_000 };
    const service = await startDocService({ views: () => [{ status: 'queued', progress: 0 }] });
    try {
      const worker = await connectExtension(context, service.base);
      await upload(page, extensionId, FIXTURES.docx.fileName, FIXTURES.docx.bytes);
      await expect(page.locator('#pdfAbandon')).toBeVisible({ timeout: 20000 });
      // Nobody is watching the job page any more: only the worker's poll can tell.
      await page.close();

      await worker.evaluate(() => {
        globalThis.__notes = [];
        const { create, clear } = chrome.notifications;
        chrome.notifications.create = (...args) => {
          globalThis.__notes.push(['create', typeof args[0] === 'string' ? args[0] : null]);
          return create.apply(chrome.notifications, args);
        };
        chrome.notifications.clear = (...args) => {
          globalThis.__notes.push(['clear', args[0]]);
          return clear.apply(chrome.notifications, args);
        };
      });
      service.script('pdf_job_1', [{ status: 'awaiting_confirm', progress: 0, confirm }]);

      const popup = await context.newPage();
      await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
      const review = popup.locator('.pdf-job-open', { hasText: await message(popup, 'docReview') });
      await expect(review).toBeVisible({ timeout: 15000 });
      const notes = () => worker.evaluate(() => globalThis.__notes);
      expect(await notes()).toContainEqual(['create', 'pdf-confirm-pdf_job_1']);
      expect((await notes()).filter(([, id]) => id === 'pdf-job-pdf_job_1')).toEqual([]);

      const row = popup.locator('.pdf-job', { hasText: FIXTURES.docx.fileName });
      await expect(row.locator('.pdf-job-status')).toHaveText(await message(popup, 'docStatusAwaitingConfirm'));
      await expectLaidOut(popup, [row.locator('.pdf-job-name'), row.locator('.pdf-job-status'), review]);

      const [jobPage] = await Promise.all([context.waitForEvent('page'), review.click()]);
      await expect.poll(() => jobPage.url()).toBe(`chrome-extension://${extensionId}/pdf/upload.html#job=pdf_job_1`);
      const panel = jobPage.locator('#docConfirmText');
      await expect(panel).toContainText('5');
      await expect(panel).toContainText('2');
      await expect(panel).toContainText('3');
      await expectLaidOut(jobPage, [panel, jobPage.locator('#docConfirmContinue'), jobPage.locator('#pdfAbandon')]);

      await jobPage.locator('#docConfirmContinue').click();
      await expect(jobPage.locator('#docSaveDual')).toBeVisible({ timeout: 20000 });
      expect(service.state.confirms).toEqual(['pdf_job_1']);
      expect(await notes()).toContainEqual(['clear', 'pdf-confirm-pdf_job_1']);
    } finally {
      await service.close();
    }
  });

test('J-E4: a MOBI declares nothing, goes up typed as MOBI, and is read in the reader',
  async ({ context, page, extensionId }) => {
    const service = await startDocService();
    try {
      await connectExtension(context, service.base);
      const bytes = mobiBytes(512);
      await upload(page, extensionId, 'novel.mobi', bytes);
      // No file comes back, and none is needed: the reader shows the job.
      await expect(page.locator('#docView')).toBeVisible({ timeout: 20000 });
      await expect(page.locator('#docSaveDual')).toBeHidden();
      await expect(page.locator('#docSaveMono')).toBeHidden();
      await expect(page.locator('#pdfJobCard .job-actions button:visible')).toHaveCount(1);

      const [put] = service.state.uploadPuts;
      expect(put.contentType).toBe('application/x-mobipocket-ebook');
      expect(put.byteLength).toBe(bytes.length);
      const [created] = service.state.createBodies;
      expect(created.sourceFormat).toBe('mobi');
      expect(created).not.toHaveProperty('declaredUnits');

      await expectLaidOut(page, [page.locator('#pdfFileName'), page.locator('#docView')]);
      expect(await urlOpenedBy(context, page.locator('#docView'))).toBe(`${service.base}/app/reader/pdf_job_1`);
    } finally {
      await service.close();
    }
  });

test('J-E5: five files the server would refuse are refused here, with no request',
  async ({ context, page, extensionId }) => {
    const service = await startDocService();
    try {
      await connectExtension(context, service.base);
      const cases = [
        { name: 'notes.rtf', bytes: Buffer.from('{\\rtf1 hello}'), key: 'docErrUnsupported' },
        { name: 'empty.docx', bytes: Buffer.alloc(0), key: 'docErrEmpty' },
        { name: 'big.txt', bytes: Buffer.alloc(10 * MIB + 1, 0x61), key: 'pdfErrTooLarge', fill: { max: '10 MB' } },
        { name: 'fake.docx', bytes: Buffer.from('this is not a zip archive'), key: 'docErrMismatch' },
        { name: 'long.txt', bytes: Buffer.alloc(2_400_001, 0x61), key: 'docErrTooLongFlow',
          fill: { pageCount: '801', maxPages: '800' } },
      ];
      for (const c of cases) {
        await upload(page, extensionId, c.name, c.bytes);
        let expected = await message(page, c.key);
        for (const [name, value] of Object.entries(c.fill || {})) expected = expected.split(`{${name}}`).join(value);
        expect(expected).not.toMatch(/\{\w+\}/);
        await expect(page.locator('#pdfError'), c.name).toHaveText(expected);
        await expect(page.locator('#pdfFileName')).toHaveText(c.name);
        // No file was sent anywhere, so there is nothing to try again with.
        await expect(page.locator('#pdfRetry')).toBeHidden();
        await expectLaidOut(page, [page.locator('#pdfFileName'), page.locator('#pdfError')]);
      }
      expect(service.state.uploadTickets).toEqual([]);
      expect(service.state.uploadPuts).toEqual([]);
      expect(service.state.apiHits).toEqual([]);
    } finally {
      await service.close();
    }
  });

test('J-E6 / J3: "View" in the popup opens a finished job of any format in the reader',
  async ({ context, page, extensionId }) => {
    const service = await startDocService();
    try {
      await connectExtension(context, service.base);
      await upload(page, extensionId, 'paper.pdf', TINY_PDF);
      await expect(page.locator('#docView')).toBeVisible({ timeout: 20000 });
      await upload(page, extensionId, FIXTURES.txt.fileName, FIXTURES.txt.bytes);
      await expect(page.locator('#docSaveDual')).toBeVisible({ timeout: 20000 });

      const viewFromPopup = async (fileName, shot) => {
        const popup = await context.newPage();
        await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
        const row = popup.locator('.pdf-job', { hasText: fileName });
        // J3 step 1: the finished row's one action is View.
        const view = row.locator('.pdf-job-open');
        await expect(view).toHaveText(await message(popup, 'docView'));
        await expectLaidOut(popup, [row.locator('.pdf-job-name'), row.locator('.pdf-job-status'), view]);
        if (shot) {
          await popup.emulateMedia({ colorScheme: 'light' });
          // The popup's document section, so the row is seen where it lives.
          await popup.locator('#pdfJobs').locator('xpath=..').screenshot({ path: shot });
        }
        // J3 step 2: a tab on the reader, and the popup closes behind it.
        const url = await urlOpenedBy(context, view);
        await expect.poll(() => popup.isClosed()).toBe(true);
        return url;
      };

      expect(await viewFromPopup('paper.pdf', shotDir && `${shotDir}/j3-popup-row.png`))
        .toBe(`${service.base}/app/reader/pdf_job_1`);
      // Not the PDF's file and not the job page: a finished Word, EPUB, text or
      // Markdown job is read there too, with its file in the download menu.
      expect(await viewFromPopup(FIXTURES.txt.fileName)).toBe(`${service.base}/app/reader/pdf_job_2`);
      expect(context.pages().map((p) => p.url()).filter((u) => u.includes('/result/'))).toEqual([]);
    } finally {
      await service.close();
    }
  });

test('J-E7: a docx job holding only the translated file offers and saves that file',
  async ({ context, page, extensionId }) => {
    const fixture = FIXTURES.docx;
    // Named, not left to the mock's default: a job ordered translated-only on
    // the website comes back with `results` holding the mono URL alone, and
    // the page must offer that file rather than nothing.
    const service = await startDocService({
      views: () => [
        { status: 'running', progress: 40, stage: 'translate' },
        { status: 'succeeded', progress: 100, pointsCharged: 3, files: ['mono'] },
      ],
    });
    try {
      await connectExtension(context, service.base);
      await upload(page, extensionId, fixture.fileName, fixture.bytes);
      await expect(page.locator('#docSaveMono')).toBeVisible({ timeout: 20000 });
      await expect(page.locator('#docSaveDual')).toBeHidden();
      await expect(page.locator('#pdfError')).toBeHidden();
      await expectLaidOut(page, [page.locator('#pdfFileName'), page.locator('#docView'),
        page.locator('#docSaveMono')]);

      const [download] = await Promise.all([
        page.waitForEvent('download'),
        page.locator('#docSaveMono').click(),
      ]);
      const stem = fixture.fileName.replace(/\.[a-z]+$/, '');
      expect(download.suggestedFilename()).toBe(`${stem} (translated).docx`);
      expect(fs.readFileSync(await download.path())).toEqual(service.resultBytes('pdf_job_1', 'mono'));
    } finally {
      await service.close();
    }
  });
