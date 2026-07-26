/**
 * Comic page translation — end-to-end against a mock of the translation service.
 *
 * The real service costs credits and calls an image model, so the API is
 * stubbed here and everything else is real: the service worker's HTTP client,
 * the bearer token in chrome.storage.local, the poll loop, and the in-place
 * swap of the <img>. What that leaves untested is only the native context-menu
 * click, which Playwright cannot drive — the message it sends is dispatched
 * directly instead.
 */
const http = require('node:http');
const { test, expect } = require('./fixtures');

const SOURCE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1200">
  <rect width="800" height="1200" fill="#e9e4d8"/>
  <text x="60" y="120" font-size="48" fill="#1a1a1a">ORIGINAL</text>
</svg>`;

const RESULT_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1200">
  <rect width="800" height="1200" fill="#d8e4e9"/>
  <text x="60" y="120" font-size="48" fill="#1a1a1a">TRANSLATED</text>
</svg>`;

const PAGE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Comic</title></head>
<body style="margin:0">
  <img id="comic" src="/source.svg" width="400">
</body></html>`;

/**
 * A stand-in for the translation service.
 *
 * `behaviour` decides what POST /api/comic/jobs does, so one server covers the
 * happy path and each failure the UI has a distinct answer for.
 *
 * `hotlinkGuard` makes /source.svg answer only requests that carry a Referer,
 * which is what a real hotlink-protected CDN does — and, incidentally, the one
 * thing the service worker cannot fake, since Referer is a forbidden header for
 * fetch. That is precisely the case that has to fall through to the page.
 */
function startMockService(behaviour = 'succeed', { hotlinkGuard = false } = {}) {
  const state = { polls: 0, createBodies: [], sourceHits: 0, sourceDenied: 0 };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const send = (status, body, type = 'application/json') => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };

    if (url.pathname === '/page') return send(200, PAGE_HTML, 'text/html; charset=utf-8');
    if (url.pathname === '/source.svg') {
      state.sourceHits += 1;
      if (hotlinkGuard && !req.headers.referer) {
        state.sourceDenied += 1;
        return send(403, 'forbidden', 'text/plain');
      }
      return send(200, SOURCE_SVG, 'image/svg+xml');
    }
    if (url.pathname === '/result.svg') return send(200, RESULT_SVG, 'image/svg+xml');

    const authorized = (req.headers.authorization || '').startsWith('Bearer ');

    if (url.pathname === '/api/comic/jobs' && req.method === 'POST') {
      let raw = '';
      req.on('data', chunk => { raw += chunk; });
      req.on('end', () => {
        const body = JSON.parse(raw || '{}');
        state.createBodies.push(body);
        if (!authorized) return send(401, { error: 'unauthorized', loginRequired: true });
        // The service takes bytes and only bytes — there is no "here is a URL,
        // go fetch it" mode, because a URL the server dereferences is whatever
        // the page the reader right-clicked said. Mirroring the real 400 means a
        // client that regressed to posting a URL fails here instead of passing.
        if (!body.imageBase64) return send(400, { error: 'missing_image' });
        if (behaviour === 'insufficient') {
          return send(402, {
            error: 'insufficient_points',
            message: 'Not enough points',
            balance: 0,
            rechargeUrl: '/billing',
          });
        }
        send(202, { jobId: 'job_test_1', status: 'queued', progress: 0.05, quote: { points: 10 } });
      });
      return;
    }

    if (url.pathname.startsWith('/api/comic/jobs/') && req.method === 'GET') {
      if (!authorized) return send(401, { error: 'unauthorized', loginRequired: true });
      state.polls += 1;
      // First poll still running, second one done: the UI has to survive at
      // least one non-terminal answer or the progress states are never seen.
      if (state.polls < 2) return send(200, { jobId: 'job_test_1', status: 'running', progress: 0.4 });
      return send(200, {
        jobId: 'job_test_1',
        status: 'succeeded',
        progress: 1,
        resultUrl: `http://localhost:${server.address().port}/result.svg`,
        width: 800,
        height: 1200,
        pointsCharged: 10,
      });
    }

    send(404, { error: 'not_found' });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        port,
        base: `http://localhost:${port}`,
        state,
        close: () => new Promise(done => server.close(done)),
      });
    });
  });
}

async function serviceWorker(context) {
  const [existing] = context.serviceWorkers();
  return existing || context.waitForEvent('serviceworker');
}

/** Point the extension at the mock and give it a token, as a real sign-in would. */
async function connectExtension(context, base, { withToken = true } = {}) {
  const worker = await serviceWorker(context);
  await worker.evaluate(async ({ base, withToken }) => {
    await chrome.storage.local.remove(['comicToken', 'comicTokenExpiresAt', 'comicAccountCache']);
    const values = { comicApiBase: base };
    if (withToken) {
      values.comicToken = 'test-token';
      values.comicTokenExpiresAt = Date.now() + 3600_000;
    }
    await chrome.storage.local.set(values);
  }, { base, withToken });
  return worker;
}

/** Stand in for the context-menu click, which is a native menu Playwright cannot open. */
async function triggerComicTranslation(worker, pageUrl, srcUrl) {
  await worker.evaluate(async ({ pageUrl, srcUrl }) => {
    const [tab] = await chrome.tabs.query({ url: pageUrl });
    await chrome.tabs.sendMessage(tab.id, {
      type: 'COMIC_TRANSLATE_IMAGE',
      srcUrl,
      pageUrl,
      targetLang: 'zh-CN',
    });
  }, { pageUrl, srcUrl });
}

test.describe('Comic page translation', () => {
  test('replaces the page in place and can flip back to the original', async ({ context, page }) => {
    const service = await startMockService('succeed');
    try {
      const worker = await connectExtension(context, service.base);
      await page.goto(`${service.base}/page`);
      await page.waitForSelector('#comic');

      await triggerComicTranslation(worker, `${service.base}/page`, `${service.base}/source.svg`);

      await expect(page.locator('.ai-translator-comic-overlay')).toBeVisible();

      // The swap is the whole feature: same element, new pixels.
      await expect(page.locator('#comic')).toHaveAttribute(
        'src', `${service.base}/result.svg`, { timeout: 20000 },
      );
      await expect(page.locator('.ai-translator-comic-overlay')).toHaveCount(0);

      const badge = page.locator('.ai-translator-comic-badge');
      await expect(badge).toBeVisible();

      await badge.click();
      await expect(page.locator('#comic')).toHaveAttribute('src', `${service.base}/source.svg`);
      await badge.click();
      await expect(page.locator('#comic')).toHaveAttribute('src', `${service.base}/result.svg`);

      // One user action must reserve exactly once, whatever the retries.
      expect(service.state.createBodies).toHaveLength(1);
      expect(service.state.createBodies[0].operationId).toBeTruthy();
      expect(service.state.createBodies[0].targetLang).toBe('zh-CN');
    } finally {
      await service.close();
    }
  });

  test('offers a top-up when the balance is short, and charges nothing', async ({ context, page }) => {
    const service = await startMockService('insufficient');
    try {
      const worker = await connectExtension(context, service.base);
      await page.goto(`${service.base}/page`);
      await page.waitForSelector('#comic');

      await triggerComicTranslation(worker, `${service.base}/page`, `${service.base}/source.svg`);

      const overlay = page.locator('.ai-translator-comic-overlay');
      await expect(overlay).toHaveClass(/is-error/);
      await expect(overlay.locator('.ai-translator-comic-btn.is-primary')).toBeVisible();
      // The original page is still what the reader sees. Read the resolved
      // property, not the attribute — an untouched src stays relative.
      expect(await page.locator('#comic').evaluate(img => img.src)).toBe(`${service.base}/source.svg`);
      expect(service.state.polls).toBe(0);
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

      await triggerComicTranslation(worker, `${service.base}/page`, `${service.base}/source.svg`);

      await expect.poll(() => service.state.createBodies.length, { timeout: 20000 }).toBe(1);
      const [created] = service.state.createBodies;
      // Acquisition happens before the post, not after a rejection: the worker
      // fetched the file itself, carrying the site's cookies and exempt from
      // CORS. Nothing in the body tells the service where the pixels came from.
      expect(created.imageUrl).toBeUndefined();
      expect(created.imageBase64).toBeTruthy();
      // Bare base64 is the signature of the worker fetch — the page-canvas rung
      // below sends a data: URL instead, which is how the two are told apart.
      expect(created.imageBase64.startsWith('data:')).toBe(false);
    } finally {
      await service.close();
    }
  });

  test('falls back to the pixels in the page when the worker is refused', async ({ context, page }) => {
    const service = await startMockService('succeed', { hotlinkGuard: true });
    try {
      const worker = await connectExtension(context, service.base);
      await page.goto(`${service.base}/page`);
      await page.waitForSelector('#comic');
      // The reader can see the page; only a request without a Referer is refused.
      await page.locator('#comic').evaluate(img => img.decode());

      await triggerComicTranslation(worker, `${service.base}/page`, `${service.base}/source.svg`);

      await expect(page.locator('#comic')).toHaveAttribute(
        'src', `${service.base}/result.svg`, { timeout: 20000 },
      );

      // The worker did try, and was turned away — that is what forced the canvas.
      expect(service.state.sourceDenied).toBeGreaterThan(0);
      // Still a single post: the failed acquisition never reached the service,
      // so no reservation was made and none had to be reused.
      expect(service.state.createBodies).toHaveLength(1);
      const [upload] = service.state.createBodies;
      expect(upload.imageUrl).toBeUndefined();
      // A data: URL rather than bare base64 is the signature of the canvas
      // path: the page re-encoded what it had already decoded.
      expect(upload.imageBase64.startsWith('data:image/')).toBe(true);
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

      await triggerComicTranslation(worker, `${service.base}/page`, `${service.base}/source.svg`);

      const overlay = page.locator('.ai-translator-comic-overlay');
      await expect(overlay.locator('.ai-translator-comic-btn.is-primary')).toBeVisible();
      // Without a token the request must not even be attempted.
      expect(service.state.createBodies).toHaveLength(0);
    } finally {
      await service.close();
    }
  });
});
