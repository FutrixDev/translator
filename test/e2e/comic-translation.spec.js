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
const zlib = require('node:zlib');
const { test, expect } = require('./fixtures');

/**
 * CRC-32 of a PNG chunk.
 *
 * Hand-rolled rather than `zlib.crc32`, which landed in Node 20.15/22.2. This
 * module builds its fixtures at load time, so on an older runtime the whole
 * spec file dies on import with a TypeError — before a single test reports, and
 * looking nothing like the missing-API problem it is.
 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * A real PNG, because the format is now load-bearing.
 *
 * The service accepts png/jpeg/webp only, and the extension sniffs the magic
 * bytes before uploading so that an SVG — or a hotlink guard's HTML error page
 * served with a 200 — falls through to the canvas rung instead of costing a
 * multi-megabyte POST and a confusing rejection. An SVG fixture therefore no
 * longer exercises the worker-fetch rung at all: it takes the fallback, and the
 * two rungs stop being distinguishable.
 *
 * Solid colour, so it deflates to a couple of hundred bytes; nothing here reads
 * the pixels, only the header and the bytes' identity as a PNG.
 */
function makePng(width, height, [r, g, b]) {
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3);
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const p = row + 1 + x * 3;
      raw[p] = r; raw[p + 1] = g; raw[p + 2] = b;
    }
  }

  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // 8 bits per channel
  ihdr[9] = 2;  // truecolour RGB
  // 10..12 stay 0: deflate, adaptive filtering, no interlace.

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const SOURCE_PNG = makePng(800, 1200, [0xe9, 0xe4, 0xd8]);
const RESULT_PNG = makePng(800, 1200, [0xd8, 0xe4, 0xe9]);

const PAGE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Comic</title></head>
<body style="margin:0">
  <img id="comic" src="/source.png" width="400">
</body></html>`;

/**
 * A stand-in for the translation service.
 *
 * `behaviour` decides what POST /api/comic/jobs does, so one server covers the
 * happy path and each failure the UI has a distinct answer for.
 *
 * `hotlinkGuard` makes /source.png answer only requests that carry a Referer,
 * which is what a real hotlink-protected CDN does — and, incidentally, the one
 * thing the service worker cannot fake, since Referer is a forbidden header for
 * fetch. That is precisely the case that has to fall through to the page.
 *
 * `guardStatus` is how that refusal is phrased. A 403 is the polite version;
 * plenty of CDNs instead answer **200 with an HTML interstitial**, which is the
 * nastier case — the fetch "succeeds" and only the bytes give it away.
 *
 * `resultFailures` makes the first N downloads of the finished page fail, which
 * is what a presigned URL that expired between the poll and the download looks
 * like. The redraw is done and charged for at that point, so what the client
 * does next is a money question.
 */
function startMockService(
  behaviour = 'succeed',
  { hotlinkGuard = false, guardStatus = 403, resultFailures = 0 } = {},
) {
  const state = { polls: 0, createBodies: [], sourceHits: 0, sourceDenied: 0, resultHits: 0 };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const send = (status, body, type = 'application/json') => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
      // Buffers go out as-is. Stringifying one yields `{"type":"Buffer",…}`,
      // which is a 200 that is not an image — exactly the failure the magic-byte
      // sniff exists to catch, and it would be caught here as a decode error
      // several layers away from the cause.
      if (Buffer.isBuffer(body) || typeof body === 'string') return res.end(body);
      res.end(JSON.stringify(body));
    };

    if (url.pathname === '/page') return send(200, PAGE_HTML, 'text/html; charset=utf-8');
    if (url.pathname === '/source.png') {
      state.sourceHits += 1;
      if (hotlinkGuard && !req.headers.referer) {
        state.sourceDenied += 1;
        return guardStatus === 200
          ? send(200, '<html><body>Hotlinking is not allowed</body></html>', 'text/html')
          : send(guardStatus, 'forbidden', 'text/plain');
      }
      return send(200, SOURCE_PNG, 'image/png');
    }
    if (url.pathname === '/result.png') {
      state.resultHits += 1;
      if (state.resultHits <= resultFailures) return send(403, 'expired', 'text/plain');
      return send(200, RESULT_PNG, 'image/png');
    }

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
        // A fresh signature per poll, as the real presign does. It also keeps
        // the two downloads in the expiry test from being one cached response.
        resultUrl: `http://localhost:${server.address().port}/result.png?sig=${state.polls}`,
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

      await triggerComicTranslation(worker, `${service.base}/page`, `${service.base}/source.png`);

      await expect(page.locator('.ai-translator-comic-overlay')).toBeVisible();

      // The swap is the whole feature: same element, new pixels.
      await expect(page.locator('#comic')).toHaveAttribute(
        'src', /\/result\.png\?sig=/, { timeout: 20000 },
      );
      await expect(page.locator('.ai-translator-comic-overlay')).toHaveCount(0);

      const badge = page.locator('.ai-translator-comic-badge');
      await expect(badge).toBeVisible();

      await badge.click();
      await expect(page.locator('#comic')).toHaveAttribute('src', `${service.base}/source.png`);
      await badge.click();
      await expect(page.locator('#comic')).toHaveAttribute('src', /\/result\.png\?sig=/);

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

      await triggerComicTranslation(worker, `${service.base}/page`, `${service.base}/source.png`);

      const overlay = page.locator('.ai-translator-comic-overlay');
      await expect(overlay).toHaveClass(/is-error/);
      await expect(overlay.locator('.ai-translator-comic-btn.is-primary')).toBeVisible();
      // The original page is still what the reader sees. Read the resolved
      // property, not the attribute — an untouched src stays relative.
      expect(await page.locator('#comic').evaluate(img => img.src)).toBe(`${service.base}/source.png`);
      expect(service.state.polls).toBe(0);
    } finally {
      await service.close();
    }
  });

  test('retrying an undelivered result re-polls the job instead of buying another', async ({ context, page }) => {
    // The redraw succeeded and the points are spent; only the download of the
    // finished page failed. A retry that fell through to POST /jobs would order
    // a second redraw of the same page and charge for it — the user's money,
    // lost to a transient 403 on a presigned URL.
    const service = await startMockService('succeed', { resultFailures: 1 });
    try {
      const worker = await connectExtension(context, service.base);
      await page.goto(`${service.base}/page`);
      await page.waitForSelector('#comic');

      await triggerComicTranslation(worker, `${service.base}/page`, `${service.base}/source.png`);

      const overlay = page.locator('.ai-translator-comic-overlay');
      await expect(overlay).toHaveClass(/is-error/, { timeout: 20000 });
      // The unreadable result was NOT swapped in over a page the reader can see.
      expect(await page.locator('#comic').evaluate(img => img.src)).toBe(`${service.base}/source.png`);
      expect(service.state.createBodies).toHaveLength(1);

      await triggerComicTranslation(worker, `${service.base}/page`, `${service.base}/source.png`);

      await expect(page.locator('#comic')).toHaveAttribute(
        'src', /\/result\.png\?sig=/, { timeout: 20000 },
      );
      await expect(page.locator('.ai-translator-comic-badge')).toBeVisible();
      // The crux: still one job, so still one charge.
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

      await triggerComicTranslation(worker, `${service.base}/page`, `${service.base}/source.png`);

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

      await triggerComicTranslation(worker, `${service.base}/page`, `${service.base}/source.png`);

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
      // A data: URL rather than bare base64 is the signature of the canvas
      // path: the page re-encoded what it had already decoded.
      expect(upload.imageBase64.startsWith('data:image/')).toBe(true);
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
      await page.goto(`${service.base}/page`);
      await page.waitForSelector('#comic');
      await page.locator('#comic').evaluate(img => img.decode());

      await triggerComicTranslation(worker, `${service.base}/page`, `${service.base}/source.png`);

      await expect(page.locator('#comic')).toHaveAttribute(
        'src', /\/result\.png\?sig=/, { timeout: 20000 },
      );

      expect(service.state.sourceDenied).toBeGreaterThan(0);
      expect(service.state.createBodies).toHaveLength(1);
      const [upload] = service.state.createBodies;
      // Recovered by the canvas, exactly as a 403 does — the point is that the
      // HTML never became an upload.
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
