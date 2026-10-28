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
const { startMockServer, serveExtConnect } = require('./mock-server');
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
 * A spread: two pages side by side, which is the one layout the whole-page
 * entry translates more than one image of (pickComicImages).
 */
const SPREAD_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Spread</title></head>
<body style="margin:0;display:flex">
  <img id="left" src="/source.png?page=1" width="300">
  <img id="right" src="/source.png?page=2" width="300">
</body></html>`;

/**
 * A chapter: three pages stacked in reading order on one document, so the
 * order a reader clicks them in is not the order they are read in.
 */
const CHAPTER_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Chapter</title></head>
<body style="margin:0">
  <img class="page" src="/source.png?page=1" width="200" style="display:block">
  <img class="page" src="/source.png?page=2" width="200" style="display:block">
  <img class="page" src="/source.png?page=3" width="200" style="display:block">
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
 * A reader that scrolls inside its own box rather than the window.
 *
 * The page is inside an `overflow: auto` box that starts 100 px down, so an
 * image scrolled half out of it is still on screen as far as the viewport is
 * concerned — only the box hides it. Anything we pin to the image's corner has
 * to follow the box's edge, not the window's, and vanish with the image.
 */
const SCROLLER_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Scroller</title></head>
<body style="margin:0">
  <div style="height:100px">toolbar</div>
  <div id="box" style="height:400px;width:500px;overflow:auto">
    <img id="comic" src="/source.png" width="400" style="display:block">
    <div style="height:1200px"></div>
  </div>
</body></html>`;

/**
 * A whole chapter on one screen: twelve pages in a grid, all in the viewport,
 * so the page entry (pickComicImages) starts every one of them at once. A
 * fixed button sits in the viewport's top-right corner, where a reader keeps
 * its own toolbar, and the chapter pill has to step around it.
 */
const CHAPTER12_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Chapter 12</title></head>
<body style="margin:0">
  <button id="native" type="button" style="position:fixed;top:8px;right:8px;width:120px;height:40px;margin:0">Menu</button>
  <div style="display:flex;flex-wrap:wrap;width:960px">
    ${Array.from({ length: 12 }, (_, i) => `<img class="page" src="/source.png?page=${i + 1}" width="150" style="display:block;margin:0 10px 10px 0">`).join('\n    ')}
  </div>
</body></html>`;

/** One page taller than the window, below a 100 px header. */
const TALL_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Tall</title></head>
<body style="margin:0">
  <div style="height:100px">header</div>
  <img id="comic" src="/source.png" width="800" style="display:block">
  <div style="height:1200px"></div>
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
 *
 * The page reaches the service the way the real one takes it: a ticket from
 * POST /api/comic/uploads, a PUT of the bytes to the ticket's presigned URL
 * (here `/upload/<sourceKey>` on this origin), then the create naming that
 * `sourceKey`. `tickets` and `puts` record the first two; `chapters` files each
 * create under its pageUrl, `{ [pageId]: pageIndex }`, which is how the real
 * service groups a chapter's pages. `uploadDelayMs` holds the PUT's answer
 * back; `Infinity` never answers it, which is what a stalled storage upload
 * looks like from the worker. `resultDelayMs` holds the finished page's
 * download back the same way, which is the stretch between a job that has
 * succeeded and the result on screen. `putStatus` is the status the PUT answers with,
 * so a storage refusal can be played. `runningProgress` is the figure a
 * running job reports. `abandoned` records the job id of every abandon.
 *
 * `notice` is put on the succeeded job, `{ code }`, with nothing charged: a page
 * the service handed back as it was (no text on it, say) and did not bill.
 *
 * `chapter` turns the one shared job into one job per create, which is what a
 * whole chapter needs: `job_<n>`, finishing `stepMs × (pageIndex + 1)` after
 * it was created, so the pages land one batch of polls at a time. A page in
 * `failPages` fails its first job, with `failCode` (default `failed`), and
 * succeeds when it is asked again. A page in `noticePages` succeeds with
 * `noticeCode` (default `comic_no_text`) as its notice. A
 * succeeded job names the chapter's document (`assetId`) and its page, as the
 * real job view does. `jobs` records every one, `{ pageIndex, createdAt,
 * attempt }`.
 */
async function startMockService(
  behaviour = 'succeed',
  { hotlinkGuard = false, guardStatus = 403, resultFailures = 0, succeedAfterMs = 0, uploadDelayMs = 0,
    resultDelayMs = 0, putStatus = 200, runningProgress = 0.4, chapter = null, notice = null } = {},
) {
  const state = {
    polls: 0, abandoned: [], createBodies: [], sourceHits: 0, sourceDenied: 0, resultHits: 0, firstPollAt: 0, connects: 0,
    tickets: [], puts: [], chapters: {}, jobs: {},
    // Document API requests, which this mock does not serve: a comic spec
    // asserts none was made.
    pdfHits: [],
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
    // A URL that looks like a PDF but serves the comic page as HTML: the
    // popup offers "Translate this PDF" on it, and that click must not become
    // a comic job (popup-media-entries.spec.js).
    if (url.pathname === '/comic.pdf') return send(200, PAGE_HTML, 'text/html; charset=utf-8');
    if (url.pathname === '/scroller') return send(200, SCROLLER_HTML, 'text/html; charset=utf-8');
    if (url.pathname === '/tall') return send(200, TALL_HTML, 'text/html; charset=utf-8');
    if (url.pathname === '/spread') return send(200, SPREAD_HTML, 'text/html; charset=utf-8');
    if (url.pathname === '/chapter') return send(200, CHAPTER_HTML, 'text/html; charset=utf-8');
    if (url.pathname === '/chapter12') return send(200, CHAPTER12_HTML, 'text/html; charset=utf-8');
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
      return setTimeout(() => send(200, RESULT_PNG, 'image/png'), resultDelayMs);
    }

    if (url.pathname === '/ext/connect') {
      state.connects += 1;
      return serveExtConnect(url, res);
    }

    const authorized = (req.headers.authorization || '').startsWith('Bearer ');

    // A sign-in ends by reading the account (comic-client.js signIn()).
    if (url.pathname === '/api/billing/me') {
      if (!authorized) return send(401, { error: 'unauthorized', loginRequired: true });
      return send(200, {
        email: 'reader@example.com',
        balancePoints: 0,
        freeQuota: { comic_page: { limit: 40, remaining: 40 } },
        freeQuotas: { comic_page: { limit: 40, used: 40, remaining: 0, resetsAt: '2026-11-01T12:00:00.000Z' } },
      });
    }

    // The public price list: what each plan raises the monthly pages to.
    if (url.pathname === '/api/billing/rates') {
      return send(200, { version: 'test', planQuotas: { pro_monthly: { pdf_page: 1000, comic_page: 300 } } });
    }

    if (url.pathname === '/api/comic/uploads' && req.method === 'POST') {
      return readJson(req, (body) => {
        state.tickets.push(body);
        if (!authorized) return send(401, { error: 'unauthorized', loginRequired: true });
        const pages = Array.isArray(body.pages) ? body.pages : [];
        if (!body.operationId || pages.length !== 1) return send(400, { error: 'invalid_request' });
        const [{ index, format }] = pages;
        if (!UPLOAD_TYPES[format]) return send(400, { error: 'unsupported_format' });
        const sourceKey = `comic-src/${body.operationId}/${index}.${format}`;
        send(200, {
          operationId: body.operationId,
          maxBytes: 20 * 1024 * 1024,
          tickets: [{ index, sourceKey, uploadUrl: `${base}/upload/${sourceKey}?sig=test`, contentType: UPLOAD_TYPES[format] }],
        });
      });
    }

    if (url.pathname.startsWith('/upload/') && req.method === 'PUT') {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        state.puts.push({
          sourceKey: url.pathname.slice('/upload/'.length),
          contentType: req.headers['content-type'] || '',
          bytes: Buffer.concat(chunks),
          authorization: req.headers.authorization || '',
        });
        // Infinity leaves it open: the worker's own deadline is the only way out.
        if (uploadDelayMs === Infinity) return;
        setTimeout(() => send(putStatus, '', 'text/plain'), uploadDelayMs);
      });
      return;
    }

    if (url.pathname === '/api/comic/jobs' && req.method === 'POST') {
      return readJson(req, (body) => {
        state.createBodies.push(body);
        if (!authorized) return send(401, { error: 'unauthorized', loginRequired: true });
        // The service reads the page from its own storage and nowhere else —
        // no URL to dereference, no bytes in the body. A create naming a key
        // nobody uploaded is refused, as the real one is.
        if (!body.sourceKey || !state.puts.some(put => put.sourceKey === body.sourceKey)) {
          return send(400, { error: 'source_missing' });
        }
        const pages = state.chapters[body.pageUrl] || (state.chapters[body.pageUrl] = {});
        pages[body.pageId] = body.pageIndex;
        // The service prices a job before creating anything and refuses one the
        // balance cannot cover with `insufficient_credits` and the shortfall —
        // not the `insufficient_points` a page that failed mid-run carries.
        if (behaviour === 'insufficient') {
          return send(402, {
            error: 'insufficient_credits',
            message: 'This job costs 2 credits and the balance is 0; 2 short',
            balance: 0,
            required: 2,
            quote: { operation: 'comic_page', pages: 1, freePages: 0, paidPages: 1, pointsPerPage: 2, points: 2, balancePoints: 0 },
          });
        }
        // Credits beyond the allowance: refused until the reader says yes, then
        // the same operation goes through (shared/comic-charge.js).
        if (behaviour === 'confirm' && body.confirmCharge !== true) {
          return send(409, {
            error: 'QUOTE_CONFIRM_REQUIRED',
            quote: { operation: 'comic_page', pages: 1, freePages: 0, paidPages: 1, pointsPerPage: 10, points: 10, balancePoints: 120 },
          });
        }
        let jobId = 'job_test_1';
        if (chapter) {
          const jobs = Object.values(state.jobs);
          jobId = `job_${jobs.length + 1}`;
          const attempt = jobs.filter(job => job.pageIndex === body.pageIndex).length;
          state.jobs[jobId] = { pageIndex: body.pageIndex, createdAt: Date.now(), attempt };
        }
        send(202, { jobId, status: 'queued', progress: 0.05, quote: { points: 10 } });
      });
    }

    if (/^\/api\/comic\/jobs\/[^/]+\/abandon$/.test(url.pathname) && req.method === 'POST') {
      if (!authorized) return send(401, { error: 'unauthorized', loginRequired: true });
      const jobId = decodeURIComponent(url.pathname.split('/')[4]);
      state.abandoned.push(jobId);
      return send(200, { jobId, status: 'abandoned' });
    }

    if (url.pathname.startsWith('/api/comic/jobs/') && req.method === 'GET') {
      if (!authorized) return send(401, { error: 'unauthorized', loginRequired: true });
      state.polls += 1;
      if (!state.firstPollAt) state.firstPollAt = Date.now();
      if (chapter) return send(...chapterPoll(chapter, state, decodeURIComponent(url.pathname.split('/')[4]), base));
      const held = succeedAfterMs > 0 && Date.now() - state.firstPollAt < succeedAfterMs;
      // First poll still running, second one done: the UI has to survive at
      // least one non-terminal answer or the progress states are never seen.
      if (held || state.polls < 2) {
        return send(200, { jobId: 'job_test_1', status: 'running', progress: runningProgress });
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
        ...(notice ? { pointsCharged: 0, notice } : { pointsCharged: 10 }),
      });
    }

    if (url.pathname.startsWith('/api/pdf/')) state.pdfHits.push(`${req.method} ${url.pathname}`);
    send(404, { error: 'not_found' });
  });

  return { base: origin, state, close };
}

/** A chapter job's poll answer: `[status, body]`. */
function chapterPoll({ failPages = [], failCode = 'failed', noticePages = [], noticeCode = 'comic_no_text', stepMs = 600 }, state, jobId, base) {
  const job = state.jobs[jobId];
  if (!job) return [404, { error: 'not_found' }];
  if (Date.now() - job.createdAt < stepMs * (job.pageIndex + 1)) {
    return [200, { jobId, status: 'running', progress: 0.4 }];
  }
  if (failPages.includes(job.pageIndex) && job.attempt === 0) {
    return [200, { jobId, status: 'failed', progress: 0, error: { code: failCode } }];
  }
  return [200, {
    jobId,
    status: 'succeeded',
    progress: 1,
    resultUrl: `${base}/result.png?sig=${jobId}`,
    width: 800,
    height: 1200,
    ...(noticePages.includes(job.pageIndex) ? { pointsCharged: 0, notice: { code: noticeCode } } : { pointsCharged: 10 }),
    assetId: 'asset_chapter_1',
    pageIndex: job.pageIndex,
  }];
}

const UPLOAD_TYPES = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };

function readJson(req, then) {
  let raw = '';
  req.on('data', chunk => { raw += chunk; });
  req.on('end', () => then(JSON.parse(raw || '{}')));
}

/**
 * Every image on the page loaded and decoded, or failed for good.
 *
 * The content script picks a page by its decoded size, so a trigger that lands
 * while an image is still decoding finds no page and orders nothing. Settled,
 * not resolved: a refused source and a reader's empty slot reject `decode()`,
 * and that is an answer too. No fixture page lazy-loads, so nothing here waits
 * on an image that is never fetched.
 */
async function imagesDecoded(page) {
  await page.evaluate(() => Promise.allSettled(Array.from(document.images, img => img.decode())));
}

/** Opens a fixture page with every image decoded; resolves to its URL. */
async function openComicPage(page, service, path = '/page') {
  const pageUrl = `${service.base}${path}`;
  await page.goto(pageUrl);
  await imagesDecoded(page);
  return pageUrl;
}

/** Stand in for the context-menu click, which is a native menu Playwright cannot open. */
async function triggerComicTranslation(worker, page, pageUrl, srcUrl, mode) {
  await imagesDecoded(page);
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
async function triggerComicPageTranslation(worker, page, pageUrl = page.url()) {
  await imagesDecoded(page);
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
  SPREAD_HTML,
  CHAPTER_HTML,
  CHAPTER12_HTML,
  READER_HTML,
  PICTURE_READER_HTML,
  DATA_PAGES,
  DATA_READER_HTML,
  startMockService,
  imagesDecoded,
  openComicPage,
  triggerComicTranslation,
  triggerComicPageTranslation,
};
