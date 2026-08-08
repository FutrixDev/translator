/**
 * The settings page's PDF history, and its way out to the web library.
 *
 * The extension cannot render a PDF. Chrome's viewer is an out-of-process
 * iframe with a closed shadow DOM, so "show me the translated layout" is a
 * question only the website can answer — which is why every row in this list
 * links to the same job on translators-ai.com/settings/pdf.
 *
 * What this pins down is the part unit tests cannot see: that the link is built
 * from the origin the service worker is actually configured with (here, the
 * mock's), and that it reaches the DOM on the first render rather than one
 * poll later.
 */
const http = require('node:http');
const { test, expect } = require('./fixtures');
const { getServiceWorker } = require('./helpers');

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

function startMockService() {
  const server = http.createServer((req, res) => {
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
    send(404, { error: 'not_found' });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        base: `http://localhost:${server.address().port}`,
        close: () => new Promise(done => { server.close(done); server.closeAllConnections?.(); }),
      });
    });
  });
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

test.describe('PDF history → web library', () => {
  test('every server-side job links to itself in the web library', async ({ context, page, extensionId }) => {
    const service = await startMockService();
    try {
      await connectExtension(context, service.base);
      await page.goto(`chrome-extension://${extensionId}/options/options.html`);

      const history = page.locator('#pdfTasksHistoryList');
      await expect(history.locator('.pdf-task')).toHaveCount(2, { timeout: 15000 });

      // The link carries the job, so the library opens on the document the
      // reader clicked rather than on whatever is newest.
      await expect(history.locator('.pdf-task-view').first())
        .toHaveAttribute('href', `${service.base}/settings/pdf?job=pdf_done`);
      // Built from the configured origin, not from a hardcoded production one.
      expect(service.base.startsWith('http://localhost:')).toBe(true);

      // A failure gets one too: the library still has the original, which is
      // how "what was this file?" gets answered.
      await expect(history.locator('.pdf-task-view').nth(1))
        .toHaveAttribute('href', `${service.base}/settings/pdf?job=pdf_failed`);

      // And so does a job that is still running — its progress is readable
      // there while it works.
      await expect(page.locator('#pdfTasksActiveList .pdf-task-view'))
        .toHaveAttribute('href', `${service.base}/settings/pdf?job=pdf_running`);

      // The card header reaches the library itself, which is the only way in
      // when the list is empty.
      await expect(page.locator('#pdfTasksLibraryLink'))
        .toHaveAttribute('href', `${service.base}/settings/pdf`);
      await expect(page.locator('#pdfTasksLibraryLink')).toBeVisible();

      // New tab, and severed from this page: an <a target="_blank"> without
      // rel="noopener" hands the opened page a window.opener back to here.
      await expect(history.locator('.pdf-task-view').first()).toHaveAttribute('target', '_blank');
      await expect(history.locator('.pdf-task-view').first()).toHaveAttribute('rel', 'noopener');
    } finally {
      await service.close();
    }
  });
});
