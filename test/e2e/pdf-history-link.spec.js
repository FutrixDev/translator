/**
 * The settings page's document history: a finished job is viewed in the web
 * reader, and the card's header reaches the web library.
 *
 * The extension cannot render a PDF. Chrome's viewer is an out-of-process
 * iframe with a closed shadow DOM, so "show me the translated layout" is a
 * question only the website can answer — which is why a finished row's one
 * action opens <site>/app/reader/<job>, whose download menu has every file
 * (D-488).
 *
 * What this pins down is the part unit tests cannot see: that the reader and
 * library addresses are built from the origin the service worker is actually
 * configured with (here, the mock's), and that the row's action reaches the
 * worker and the worker opens the reader.
 */
const { test, expect } = require('./fixtures');
const { getServiceWorker } = require('./helpers');
const { startMockServer } = require('./mock-server');

const ACCOUNT = {
  email: 'reader@example.com',
  balancePoints: 0,
  freeQuota: { pdf_page: { limit: 20, remaining: 18 }, comic_page: { limit: 40, remaining: 40 } },
};

/** One of each row the list can draw: finished, still running, failed. */
const JOBS = [
  {
    jobId: 'pdf_done', status: 'succeeded', progress: 100, pageCount: 2,
    fileName: '2312.03724.pdf', targetLang: 'zh-CN', createdAt: 1754500000000,
    results: { dualUrl: 'https://example.com/dual.pdf', monoUrl: 'https://example.com/mono.pdf' },
  },
  {
    jobId: 'pdf_running', status: 'running', progress: 40, stage: 'translate', pageCount: 15,
    fileName: 'attention.pdf', targetLang: 'ja', createdAt: 1754400000000,
  },
  {
    jobId: 'pdf_failed', status: 'failed', progress: 0, pageCount: 8,
    fileName: 'scan-2019.pdf', targetLang: 'en', createdAt: 1754300000000,
    error: { code: 'scanned_unsupported', refunded: true },
  },
];

async function startMockService() {
  const { origin, close } = await startMockServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    if (!(req.headers.authorization || '').startsWith('Bearer ')) {
      return send(401, { error: 'unauthorized', loginRequired: true });
    }
    if (url.pathname === '/api/billing/me') return send(200, ACCOUNT);
    if (url.pathname === '/api/pdf/jobs' && req.method === 'GET') return send(200, { jobs: JOBS });
    // The worker polls a job before opening it, so the place it opens is the
    // job's state now, not when the row was drawn.
    const one = url.pathname.match(/^\/api\/pdf\/jobs\/([^/]+)$/);
    const job = one && JOBS.find((j) => j.jobId === decodeURIComponent(one[1]));
    if (job && req.method === 'GET') return send(200, job);
    send(404, { error: 'not_found' });
  });

  return { base: origin, close };
}

async function connectExtension(context, base) {
  const worker = await getServiceWorker(context);
  await worker.evaluate(async (base) => {
    await chrome.storage.sync.set({ enablePdfTranslation: true });
    // A record left by another test would join this list and shift the rows.
    await chrome.storage.local.remove(['comicAccountCache', 'pdfJobs', 'pdfUrlOps']);
    await chrome.storage.local.set({
      comicApiBase: base,
      comicToken: 'test-token',
      comicTokenExpiresAt: Date.now() + 3600_000,
    });
  }, base);
  return worker;
}

const shotDir = process.env.DOC_SCREENSHOT_DIR;

test.describe('Document history → web reader and library', () => {
  test('a finished job is viewed in the reader; a running or failed one has no action', async ({ context, page, extensionId }) => {
    const service = await startMockService();
    try {
      await connectExtension(context, service.base);
      await page.goto(`chrome-extension://${extensionId}/options/options.html`);

      const history = page.locator('#pdfTasksHistoryList');
      await expect(history.locator('.pdf-task')).toHaveCount(2, { timeout: 15000 });

      // J-B11: each row names its target language in the UI language (en here),
      // as Intl names it — worked out in the browser, not by the page under
      // test. zh-CN is looked up as zh-Hans, the way every name for it is.
      const intlName = (tag) => page.evaluate((code) => new Intl.DisplayNames(['en'], { type: 'language' }).of(code), tag);
      await expect(history.locator('.pdf-task-meta').first()).toContainText(` · ${await intlName('zh-Hans')} · `);
      await expect(history.locator('.pdf-task-meta').nth(1)).toContainText(` · ${await intlName('en')} · `);
      await expect(page.locator('#pdfTasksActiveList .pdf-task-meta')).toContainText(` · ${await intlName('ja')} · `);

      // J4 step 1: the finished row has exactly one action, View, and no
      // separate link to the website.
      const done = history.locator('.pdf-task').first();
      await expect(done.locator('button, a')).toHaveCount(1);
      const view = done.locator('.pdf-task-open');
      await expect(view).toHaveText(await page.evaluate(() => getMessage('docView', 'en')));
      // A failed row and a running one have nothing to open; their status
      // line says what happened.
      await expect(history.locator('.pdf-task').nth(1).locator('button, a')).toHaveCount(0);
      await expect(page.locator('#pdfTasksActiveList .pdf-task button, #pdfTasksActiveList .pdf-task a')).toHaveCount(0);
      if (shotDir) {
        await page.emulateMedia({ colorScheme: 'light' });
        await done.screenshot({ path: `${shotDir}/j4-options-row.png` });
      }

      // J4 step 2: the worker opens the reader on that job, at the configured
      // origin, not a hardcoded production one.
      expect(service.base.startsWith('http://127.0.0.1:')).toBe(true);
      const [reader] = await Promise.all([context.waitForEvent('page'), view.click()]);
      await expect.poll(() => reader.url()).toBe(`${service.base}/app/reader/pdf_done`);

      // The card header reaches the library itself, which is the only way in
      // when the list is empty.
      await expect(page.locator('#pdfTasksLibraryLink'))
        .toHaveAttribute('href', `${service.base}/app/settings/pdf`);
      await expect(page.locator('#pdfTasksLibraryLink')).toBeVisible();
      // New tab, and severed from this page: an <a target="_blank"> without
      // rel="noopener" hands the opened page a window.opener back to here.
      await expect(page.locator('#pdfTasksLibraryLink')).toHaveAttribute('target', '_blank');
      await expect(page.locator('#pdfTasksLibraryLink')).toHaveAttribute('rel', 'noopener');
    } finally {
      await service.close();
    }
  });
});
