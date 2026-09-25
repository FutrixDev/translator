/**
 * 漫画翻译 e2e 的共用夹具：合成的 PNG、几份读者页、以及那台模拟翻译服务。
 *
 * 真服务要花掉每月的免费额度并调用图像模型，所以这里把 API 整个模拟掉，别的都是
 * 真的：service worker 的 HTTP 客户端、chrome.storage.local 里的 bearer token、
 * 轮询循环、以及 <img> 的原地替换。唯一测不到的是系统右键菜单那一下点击（Playwright
 * 驱动不了），所以改成直接派发它会发的那条消息。
 *
 * 用这些夹具的几份 spec：comic-translation.spec.js（下单、计费、上传）、
 * comic-reader.spec.js（读者翻页、页位复用、跨次访问）。
 */
const zlib = require('node:zlib');
const { getServiceWorker } = require('./helpers');
const { startMockServer } = require('./mock-server');
const { crc32 } = require('./crc32');

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
async function startMockService(
  behaviour = 'succeed',
  { hotlinkGuard = false, guardStatus = 403, resultFailures = 0, succeedAfterMs = 0 } = {},
) {
  const state = {
    polls: 0, createBodies: [], sourceHits: 0, sourceDenied: 0, resultHits: 0, firstPollAt: 0,
  };

  const { origin, close } = await startMockServer((req, res, base) => {
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
        resultUrl: `${base}/result.png?sig=${state.polls}`,
        width: 800,
        height: 1200,
        pointsCharged: 10,
      });
    }

    send(404, { error: 'not_found' });
  });

  return { base: origin, state, close };
}

/** Point the extension at the mock and give it a token, as a real sign-in would. */
async function connectExtension(context, base, { withToken = true } = {}) {
  const worker = await getServiceWorker(context);
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

module.exports = {
  makePng,
  noisePng,
  encodePng,
  SOURCE_PNG,
  RESULT_PNG,
  DECOY_PNG,
  PAGE_HTML,
  DECOY_PAGE_HTML,
  READER_HTML,
  PICTURE_READER_HTML,
  DATA_PAGES,
  DATA_READER_HTML,
  startMockService,
  connectExtension,
  triggerComicTranslation,
  triggerComicPageTranslation,
};
