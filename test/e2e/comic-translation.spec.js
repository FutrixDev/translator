/**
 * Comic page translation — end-to-end against a mock of the translation service.
 *
 * The real service spends the monthly free allowance and calls an image model,
 * so the API is
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
  return encodePng(width, height, raw);
}

/**
 * A page that does NOT compress, so its `data:` URL is megabyte-scale.
 *
 * Readers that decode their own artwork hand the <img> an inline `data:` URL,
 * and the size of that string is the whole point of the fixture: it is what
 * makes keeping the raw src around as a lookup key — in memory, and in
 * chrome.storage — the wrong design. A deterministic LCG rather than
 * Math.random so a failure reproduces.
 */
function noisePng(width, height, seed) {
  let state = seed >>> 0 || 1;
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3);
    raw[row] = 0;
    for (let x = 0; x < width * 3; x++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      raw[row + 1 + x] = (state >>> 24) & 0xff;
    }
  }
  return encodePng(width, height, raw);
}

function encodePng(width, height, raw) {
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
// Tiny, as the real ones are: a decoy is a spacer stretched over the artwork,
// not a copy of it.
const DECOY_PNG = makePng(58, 65, [0x00, 0x00, 0x00]);

const PAGE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Comic</title></head>
<body style="margin:0">
  <img id="comic" src="/source.png" width="400">
</body></html>`;

/**
 * The anti-copy layout: a small image stretched to exactly cover the page.
 *
 * Sites that do this also cancel `contextmenu`, so the only thing that reaches
 * us is a right-click forced past the handler — and it reports the decoy's
 * src, because the decoy is what hit-testing lands on. Whatever the entry
 * point, the artwork underneath is what has to be translated.
 */
const DECOY_PAGE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Comic</title></head>
<body style="margin:0">
  <div style="position:relative;width:400px;height:600px">
    <img id="comic" src="/source.png" style="position:absolute;top:0;left:0;width:400px;height:600px">
    <img id="decoy" src="/decoy.png" style="position:absolute;top:0;left:0;width:400px;height:600px">
  </div>
  <script>document.addEventListener('contextmenu', e => e.preventDefault());</script>
</body></html>`;

/**
 * How a real online reader turns a page: no navigation at all.
 *
 * A small pool of <img> elements is recycled — the element that showed page 1
 * shows page 3 a moment later — and the URL moves by pushState, so the document
 * never reloads and the content script never runs again. Both halves matter.
 * Tracking a translation by its element hands page 3 the badge, the swap and
 * the "already translated" shortcut that were bought for page 1; and nothing
 * re-runs on a turn, so coming back has to be noticed from inside the page.
 *
 * Two slots is the smallest pool that recycles: pages 1 and 3 share one.
 */
const READER_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Reader</title></head>
<body style="margin:0">
  <img class="page_img" width="400">
  <img class="page_img" width="400">
  <script>
    const pool = Array.from(document.querySelectorAll('.page_img'));
    window.turnTo = (n) => {
      const slot = n % pool.length;
      pool[slot].src = '/source.png?page=' + n;
      pool.forEach((img, i) => { img.style.display = i === slot ? '' : 'none'; });
      history.pushState({}, '', '/reader?page=' + n);
    };
    turnTo(1);
  </script>
</body></html>`;

/**
 * The same reader, wearing the responsive markup a real one ships.
 *
 * `srcset` and a parent `<picture>` both outrank `src`, so swapping in a result
 * means stripping them — and a slot that is handed to the next page has to get
 * them back. The site rewrites `src` and `srcset` on every turn but never
 * touches `sizes` or the `<source>`, which is exactly why those two are what
 * this asserts on: they are the attributes only the extension can put back.
 *
 * The `<source>` deliberately never matches, so `currentSrc` stays the <img>'s
 * own URL and the page's identity is not the thing under test here.
 */
const PICTURE_READER_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Reader</title></head>
<body style="margin:0">
  <picture><source media="(max-width: 1px)" srcset="/decoy.png"><img class="page_img" width="400" sizes="400px"></picture>
  <picture><source media="(max-width: 1px)" srcset="/decoy.png"><img class="page_img" width="400" sizes="400px"></picture>
  <script>
    const pool = Array.from(document.querySelectorAll('.page_img'));
    window.turnTo = (n) => {
      const slot = n % pool.length;
      pool[slot].src = '/source.png?page=' + n;
      pool[slot].srcset = '/source.png?page=' + n + ' 1x';
      pool.forEach((img, i) => { img.style.display = i === slot ? '' : 'none'; });
      history.pushState({}, '', '/picture-reader?page=' + n);
    };
    turnTo(1);
  </script>
</body></html>`;

/**
 * The reader that has no URLs at all.
 *
 * Sites that decrypt their pages in the browser hand the <img> a multi-megabyte
 * `data:` URL, which is the hardest case for every piece of state this feature
 * keeps: nothing about the page is short, and nothing about it survives being
 * treated as a key. Three distinct pages, none of which compress.
 */
const DATA_PAGES = [0, 1, 2, 3].map(
  n => `data:image/png;base64,${noisePng(320, 400, n * 7919 + 1).toString('base64')}`,
);

const DATA_READER_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Reader</title></head>
<body style="margin:0">
  <img class="page_img" width="400">
  <img class="page_img" width="400">
  <script>
    const pages = ${JSON.stringify(DATA_PAGES)};
    const pool = Array.from(document.querySelectorAll('.page_img'));
    window.turnTo = (n) => {
      const slot = n % pool.length;
      pool[slot].src = pages[n];
      pool.forEach((img, i) => { img.style.display = i === slot ? '' : 'none'; });
      history.pushState({}, '', '/data-reader?page=' + n);
    };
    turnTo(1);
  </script>
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
 *
 * `succeedAfterMs` keeps the job `running` for a wall-clock stretch rather than
 * a poll count, which is what it takes to still be in flight after the reader
 * has navigated. A count cannot express that: the reload resets nothing
 * server-side, so a job held for two polls is already done by the time the new
 * document asks.
 */
function startMockService(
  behaviour = 'succeed',
  { hotlinkGuard = false, guardStatus = 403, resultFailures = 0, succeedAfterMs = 0 } = {},
) {
  const state = {
    polls: 0, createBodies: [], sourceHits: 0, sourceDenied: 0, resultHits: 0, firstPollAt: 0,
  };

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
    if (url.pathname === '/decoy-page') return send(200, DECOY_PAGE_HTML, 'text/html; charset=utf-8');
    if (url.pathname === '/reader') return send(200, READER_HTML, 'text/html; charset=utf-8');
    if (url.pathname === '/picture-reader') return send(200, PICTURE_READER_HTML, 'text/html; charset=utf-8');
    if (url.pathname === '/data-reader') return send(200, DATA_READER_HTML, 'text/html; charset=utf-8');
    if (url.pathname === '/decoy.png') return send(200, DECOY_PNG, 'image/png');
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
      if (!state.firstPollAt) state.firstPollAt = Date.now();
      const held = succeedAfterMs > 0 && Date.now() - state.firstPollAt < succeedAfterMs;
      // First poll still running, second one done: the UI has to survive at
      // least one non-terminal answer or the progress states are never seen.
      if (held || state.polls < 2) {
        return send(200, { jobId: 'job_test_1', status: 'running', progress: 0.4 });
      }
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
        // Drop the keep-alive sockets Chrome is holding. Without this, close()
        // waits for the browser to time them out on its own — tens of seconds
        // of dead time inside each test's budget, which is what turned a slow
        // test into an intermittently failing one.
        close: () => new Promise((done) => {
          server.close(done);
          server.closeAllConnections?.();
        }),
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
    // The feature ships off, and the worker refuses a create while it is: these
    // tests stand in for a context-menu click, which only exists when the
    // switch is on, so the switch has to be on for them too.
    await chrome.storage.sync.set({ enableComicTranslation: true });
    // comicJobs too: it is the cross-page memory, and a record left behind by
    // the previous test would have the next one silently resume a job whose
    // mock service is already closed.
    await chrome.storage.local.remove([
      'comicToken', 'comicTokenExpiresAt', 'comicAccountCache', 'comicJobs',
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

/** Stand in for the context-menu click, which is a native menu Playwright cannot open. */
async function triggerComicTranslation(worker, pageUrl, srcUrl, mode) {
  await worker.evaluate(async ({ pageUrl, srcUrl, mode }) => {
    const [tab] = await chrome.tabs.query({ url: pageUrl });
    await chrome.tabs.sendMessage(tab.id, {
      type: 'COMIC_TRANSLATE_IMAGE',
      srcUrl,
      pageUrl,
      targetLang: 'zh-CN',
      ...(mode ? { mode } : {}),
    });
  }, { pageUrl, srcUrl, mode: mode || null });
}

/** The popup's entry point: no srcUrl, the page picks its own image. */
async function triggerComicPageTranslation(worker, pageUrl) {
  await worker.evaluate(async ({ pageUrl }) => {
    const [tab] = await chrome.tabs.query({ url: pageUrl });
    await chrome.tabs.sendMessage(tab.id, { type: 'COMIC_TRANSLATE_PAGE', pageUrl, targetLang: 'zh-CN' });
  }, { pageUrl });
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
      // No mode was sent, and the default must stay the original product.
      expect(service.state.createBodies[0].mode).toBe('translate');
    } finally {
      await service.close();
    }
  });

  test('reports a used-up allowance with nothing to buy, and spends nothing', async ({ context, page }) => {
    const service = await startMockService('insufficient');
    try {
      const worker = await connectExtension(context, service.base);
      await page.goto(`${service.base}/page`);
      await page.waitForSelector('#comic');

      await triggerComicTranslation(worker, `${service.base}/page`, `${service.base}/source.png`);

      const overlay = page.locator('.ai-translator-comic-overlay');
      await expect(overlay).toHaveClass(/is-error/);
      // Dismiss is the only way out: the free pages refill next month and there
      // is no top-up to offer.
      await expect(overlay.locator('.ai-translator-comic-btn')).toHaveCount(1);
      await expect(overlay.locator('.ai-translator-comic-btn.is-primary')).toHaveCount(0);
      // The original page is still what the reader sees. Read the resolved
      // property, not the attribute — an untouched src stays relative.
      expect(await page.locator('#comic').evaluate(img => img.src)).toBe(`${service.base}/source.png`);
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

  test('translates the artwork under a decoy overlay, not the decoy', async ({ context, page }) => {
    // srcUrl names the placeholder, because that is what the browser hit-tested.
    // Translating it would spend a free page redrawing a 58×65 spacer and leave the
    // page the reader is looking at untouched.
    const service = await startMockService('succeed');
    try {
      const worker = await connectExtension(context, service.base);
      await page.goto(`${service.base}/decoy-page`);
      await page.locator('#comic').evaluate(img => img.decode());

      await triggerComicTranslation(worker, `${service.base}/decoy-page`, `${service.base}/decoy.png`);

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
      await page.goto(`${service.base}/decoy-page`);
      await page.locator('#comic').evaluate(img => img.decode());

      await triggerComicPageTranslation(worker, `${service.base}/decoy-page`);

      await expect(page.locator('#comic')).toHaveAttribute(
        'src', /\/result\.png\?sig=/, { timeout: 20000 },
      );
      expect(service.state.createBodies).toHaveLength(1);
    } finally {
      await service.close();
    }
  });

  /**
   * The pointer buys nothing and offers nothing.
   *
   * An earlier build floated Translate/Colorize onto whatever image the cursor
   * crossed. The test that "is this a comic page?" can honestly answer is only
   * "is this a reasonably large image", which describes every article photo on
   * the web, so the two paid buttons appeared everywhere. Asking is now the
   * user's move: right-click, or the float ball.
   */
  test('shows nothing on hover, even with the feature on', async ({ context, page }) => {
    const service = await startMockService('succeed');
    const worker = await connectExtension(context, service.base);
    try {
      await worker.evaluate(() => chrome.storage.sync.set({ enableComicTranslation: true }));
      await page.goto(`${service.base}/decoy-page`);
      await page.locator('#comic').evaluate(img => img.decode());

      // Move, don't just land: the old trigger was mousemove-driven, so a
      // single hover point would not have fired it either.
      const box = await page.locator('#decoy').boundingBox();
      for (const fraction of [0.3, 0.5, 0.7]) {
        await page.mouse.move(box.x + box.width * fraction, box.y + box.height * fraction);
      }
      await page.waitForTimeout(600);

      expect(await page.locator('.ai-translator-comic-hover-btn').count()).toBe(0);
      // Nothing of ours at all — a differently-named affordance is the same bug.
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

      await triggerComicTranslation(worker, `${service.base}/page`, `${service.base}/source.png`);
      await expect(page.locator('#comic')).toHaveAttribute(
        'src', /\/result\.png\?sig=/, { timeout: 20000 },
      );
      expect(service.state.createBodies).toHaveLength(1);
      expect(service.state.createBodies[0].mode).toBe('translate');

      await triggerComicTranslation(worker, `${service.base}/page`, `${service.base}/source.png`, 'colorize');
      await expect.poll(() => service.state.createBodies.length, { timeout: 20000 }).toBe(2);
      // The whole point: not 'colorize', which would have redrawn the original
      // and thrown the translation away.
      expect(service.state.createBodies[1].mode).toBe('translate_colorize');
      // And from the original bytes, not from the translated result.
      expect(service.state.createBodies[1].imageBase64)
        .toBe(service.state.createBodies[0].imageBase64);

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

      await triggerComicTranslation(worker, `${service.base}/page`, `${service.base}/source.png`);
      await expect(page.locator('#comic')).toHaveAttribute(
        'src', /\/result\.png\?sig=/, { timeout: 20000 },
      );
      expect(service.state.createBodies).toHaveLength(1);

      // The other product on the same page: a second paid job, by design.
      await badge.click();
      await expect(page.locator('#comic')).toHaveAttribute('src', /\/source\.png/);
      await triggerComicTranslation(worker, `${service.base}/page`, `${service.base}/source.png`, 'colorize');
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
      await triggerComicTranslation(worker, `${service.base}/page`, `${service.base}/source.png`, 'translate');
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
      await page.goto(`${service.base}/decoy-page`);
      await page.locator('#comic').evaluate(img => img.decode());

      // The decoy is what the right-click reports, and it still has to resolve
      // to the artwork behind it — the same job the translate entry does.
      await triggerComicTranslation(
        worker, `${service.base}/decoy-page`, `${service.base}/decoy.png`, 'colorize',
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
