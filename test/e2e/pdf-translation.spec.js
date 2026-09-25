/**
 * PDF translation — end-to-end against a mock of the translation service.
 *
 * The real service spends the monthly free allowance and runs a retypeset
 * engine for minutes, so
 * the API is stubbed here and everything else is real: the upload page's file
 * intake, the ticket it asks the service worker for, its own presigned PUT of
 * the File (the bytes never pass through the worker), the worker's job
 * creation in pdf-client.js, and the poll loop that draws progress and finally
 * offers the result.
 *
 * The mock (doc-service-mock.js) speaks the real contract (see translator-saas
 * app/api/pdf/{uploads,jobs}/...): an upload ticket whose uploadUrl points
 * back at this server, a PUT sink that checks it was truly handed a PDF, a
 * 202 job creation, and a poll that goes running → succeeded.
 */
const { test, expect } = require('./fixtures');
const { getServiceWorker } = require('./helpers');
const { startDocService, TINY_PDF } = require('./doc-service-mock');

/**
 * `behaviour` decides what POST /api/pdf/jobs does — the happy path and the
 * 402 the UI has a distinct answer for. The 401 case needs no behaviour at
 * all: without a token the client must refuse before any request is made.
 */
function startMockService(behaviour = 'succeed') {
  return startDocService({ create: behaviour });
}


/**
 * Point the extension at the mock and give it a token, as a real sign-in
 * would. comicApiBase on purpose: PDF and comics are one account on one
 * origin, and the pdf client reads the same override (see pdf-client.js
 * importing getApiBase's machinery from comic-client.js).
 */
async function connectExtension(context, base, { withToken = true } = {}) {
  const worker = await getServiceWorker(context);
  await worker.evaluate(async ({ base, withToken }) => {
    await chrome.storage.sync.set({ enablePdfTranslation: true });
    // pdfJobs too: a record left behind by a previous test would surface in
    // the next one's popup list and confuse its assertions.
    await chrome.storage.local.remove([
      'comicToken', 'comicTokenExpiresAt', 'comicAccountCache', 'pdfJobs', 'pdfUrlOps',
    ]);
    const values = { comicApiBase: base };
    if (withToken) {
      values.comicToken = 'test-token';
      values.comicTokenExpiresAt = Date.now() + 3600_000;
    }
    await chrome.storage.local.set(values);
  }, { base, withToken });
  return worker;
}

async function openUploadPage(page, extensionId) {
  await page.goto(`chrome-extension://${extensionId}/pdf/upload.html`);
  await page.setInputFiles('#pdfFileInput', {
    name: 'paper.pdf',
    mimeType: 'application/pdf',
    buffer: TINY_PDF,
  });
}

test.describe('PDF translation', () => {
  test('uploads a local PDF, shows progress, and offers the result', async ({ context, page, extensionId }) => {
    const service = await startMockService('succeed');
    try {
      await connectExtension(context, service.base);
      await openUploadPage(page, extensionId);

      // The job card appears at once with the file's name on it.
      await expect(page.locator('#pdfJobCard')).toBeVisible();
      await expect(page.locator('#pdfFileName')).toHaveText('paper.pdf');

      // Progress is a real state, not a flicker: the first poll answers
      // `running`, so the bar and a status line must be on screen.
      await expect(page.locator('#pdfProgressTrack')).toBeVisible();
      await expect(page.locator('#pdfStatusText')).not.toBeEmpty();

      // Terminal state: both result buttons, since the mock returned both.
      await expect(page.locator('#pdfOpenDual')).toBeVisible({ timeout: 20000 });
      await expect(page.locator('#pdfOpenMono')).toBeVisible();
      await expect(page.locator('#pdfError')).toBeHidden();

      // One user action: one ticket, one PUT, one job.
      expect(service.state.uploadTickets).toHaveLength(1);
      expect(service.state.uploadPuts).toHaveLength(1);
      expect(service.state.createBodies).toHaveLength(1);

      // The PUT really carried the PDF, typed as one.
      const [put] = service.state.uploadPuts;
      expect(put.contentType).toBe('application/pdf');
      expect(put.isPdf).toBe(true);
      expect(put.byteLength).toBe(TINY_PDF.length);
      // The presigned URL is the whole authorization: no bearer token rides along.
      expect(put.authorization).toBeNull();

      // The ticket declares the format and the size, and nothing it need not.
      const [ticket] = service.state.uploadTickets;
      expect(ticket).toEqual({ operationId: expect.any(String), byteSize: TINY_PDF.length, sourceFormat: 'pdf' });

      // The job names the key the ticket issued, and asks for the default
      // product: bilingual, side-by-side, no watermark.
      const [created] = service.state.createBodies;
      expect(created.operationId).toBeTruthy();
      expect(created.sourceKey).toBe(`pdf/u1/${created.operationId}/source.pdf`);
      expect(created.operationId).toBe(ticket.operationId);
      expect(created.sourceFormat).toBe('pdf');
      // A PDF is counted by the server; the page declares nothing for it.
      expect(created).not.toHaveProperty('declaredUnits');
      expect(created.output).toEqual({ kind: 'dual', dualLayout: 'side-by-side', watermark: false });
      expect(created.targetLang).toBeTruthy();

      // The service worker mirrored the job for the popup's task list.
      const worker = await getServiceWorker(context);
      const records = await worker.evaluate(
        () => chrome.storage.local.get('pdfJobs').then(r => r.pdfJobs || []),
      );
      expect(records).toHaveLength(1);
      expect(records[0].jobId).toBe('pdf_job_1');
      expect(records[0].fileName).toBe('paper.pdf');
      expect(records[0].status).toBe('succeeded');
    } finally {
      await service.close();
    }
  });

  test('a URL job retried after a lost response replays the same operation id', async ({ context, page, extensionId }) => {
    const service = await startMockService('flaky-create');
    try {
      await connectExtension(context, service.base);
      // PDF_CREATE_JOB is what both the popup button and the context menu
      // dispatch; sending it from an extension page exercises the exact
      // production path (a worker cannot runtime-message itself).
      await page.goto(`chrome-extension://${extensionId}/pdf/upload.html`);
      const sendCreate = (u) => page.evaluate(
        (targetUrl) => new Promise((resolve) => {
          chrome.runtime.sendMessage(
            { type: 'PDF_CREATE_JOB', source: { kind: 'url', url: targetUrl } },
            resolve,
          );
        }),
        u,
      );

      const url = `${service.base}/paper.pdf`;
      const first = await sendCreate(url);
      expect(first && first.ok).toBeFalsy(); // the response was lost mid-flight

      const second = await sendCreate(url);
      expect(second && second.ok).toBeTruthy();

      // Both attempts reached the server — with ONE operation id between them.
      expect(service.state.createBodies).toHaveLength(2);
      expect(service.state.createBodies[0].operationId).toBeTruthy();
      expect(service.state.createBodies[1].operationId).toBe(service.state.createBodies[0].operationId);
    } finally {
      await service.close();
    }
  });

  test('reports a used-up allowance with no action, and uploads only once', async ({ context, page, extensionId }) => {
    const service = await startMockService('insufficient');
    try {
      await connectExtension(context, service.base);
      await openUploadPage(page, extensionId);

      // The 402 lands after the upload but before any polling.
      await expect(page.locator('#pdfError')).toBeVisible({ timeout: 15000 });
      await expect(page.locator('#pdfError')).not.toBeEmpty();
      // Nothing to buy and nothing to retry: the month's free pages are spent,
      // so the page offers no action at all.
      await expect(page.locator('#pdfRecharge')).toHaveCount(0);
      await expect(page.locator('#pdfRetry')).toBeHidden();

      expect(service.state.createBodies).toHaveLength(1);
      expect(service.state.polls).toBe(0);
    } finally {
      await service.close();
    }
  });

  test('asks for sign-in instead of failing when no token is stored', async ({ context, page, extensionId }) => {
    const service = await startMockService('succeed');
    try {
      await connectExtension(context, service.base, { withToken: false });
      await openUploadPage(page, extensionId);

      await expect(page.locator('#pdfError')).toBeVisible({ timeout: 15000 });
      await expect(page.locator('#pdfSignIn')).toBeVisible();

      // Signed out, the client must not touch the service at all — no ticket,
      // no upload, no job. The token pre-check is what spares the transfer.
      expect(service.state.uploadTickets).toHaveLength(0);
      expect(service.state.uploadPuts).toHaveLength(0);
      expect(service.state.createBodies).toHaveLength(0);
    } finally {
      await service.close();
    }
  });
});
