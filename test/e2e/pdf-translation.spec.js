/**
 * PDF translation — end-to-end against a mock of the translation service.
 *
 * The real service costs credits and runs a retypeset engine for minutes, so
 * the API is stubbed here and everything else is real: the upload page's file
 * intake, the base64 hop through runtime messaging, the service worker's
 * ticket → presigned PUT → job creation sequence in pdf-client.js, and the
 * poll loop that draws progress and finally offers the result.
 *
 * The mock speaks the real contract (see translator-saas
 * app/api/pdf/{uploads,jobs}/...): an upload ticket whose uploadUrl points
 * back at this server, a PUT sink that checks it was truly handed a PDF, a
 * 202 job creation, and a poll that goes running → succeeded.
 */
const http = require('node:http');
const { test, expect } = require('./fixtures');

/**
 * A minimal PDF as a static byte template.
 *
 * Nothing in this suite renders it: the extension sniffs the "%PDF-" magic
 * and the mock's PUT sink re-checks it, so a one-page skeleton document is
 * exactly as load-bearing as a real paper — and a few hundred bytes.
 */
const TINY_PDF = Buffer.from(
  `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>
endobj
trailer
<< /Root 1 0 R >>
%%EOF
`,
  'latin1',
);

/**
 * A stand-in for the translation service.
 *
 * `behaviour` decides what POST /api/pdf/jobs does — the happy path and the
 * 402 the UI has a distinct answer for. The 401 case needs no behaviour at
 * all: without a token the client must refuse before any request is made.
 */
function startMockService(behaviour = 'succeed') {
  const state = {
    uploadTickets: [],
    uploadPuts: [],
    createBodies: [],
    polls: 0,
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const send = (status, body, type = 'application/json') => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
      if (Buffer.isBuffer(body) || typeof body === 'string') return res.end(body);
      res.end(JSON.stringify(body));
    };
    const readBody = (cb) => {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => cb(Buffer.concat(chunks)));
    };

    const authorized = (req.headers.authorization || '').startsWith('Bearer ');
    const base = () => `http://localhost:${server.address().port}`;

    if (url.pathname === '/api/pdf/uploads' && req.method === 'POST') {
      return readBody((raw) => {
        if (!authorized) return send(401, { error: 'unauthorized', loginRequired: true });
        const body = JSON.parse(raw.toString() || '{}');
        state.uploadTickets.push(body);
        // The real ticket embeds the caller's user id and operation id; job
        // creation later verifies the prefix, so the shape matters.
        const sourceKey = `pdf/u1/${body.operationId}/source.pdf`;
        return send(200, {
          sourceKey,
          uploadUrl: `${base()}/upload-sink?key=${encodeURIComponent(sourceKey)}`,
          maxBytes: 30 * 1024 * 1024,
        });
      });
    }

    if (url.pathname === '/upload-sink' && req.method === 'PUT') {
      // The presigned PUT carries no bearer token — the signature in the URL
      // is the authorization. What it must carry is an actual PDF.
      return readBody((bytes) => {
        state.uploadPuts.push({
          key: url.searchParams.get('key'),
          contentType: req.headers['content-type'],
          byteLength: bytes.length,
          isPdf: bytes.subarray(0, 5).toString('latin1') === '%PDF-',
        });
        send(200, '');
      });
    }

    if (url.pathname === '/api/pdf/jobs' && req.method === 'POST') {
      return readBody((raw) => {
        if (!authorized) return send(401, { error: 'unauthorized', loginRequired: true });
        const body = JSON.parse(raw.toString() || '{}');
        state.createBodies.push(body);
        if (behaviour === 'insufficient') {
          return send(402, {
            error: 'insufficient_points',
            message: 'Not enough points',
            balance: 0,
            required: 3,
            rechargeUrl: '/billing',
          });
        }
        send(202, {
          jobId: 'pdf_job_1',
          status: 'queued',
          progress: 0,
          pageCount: 1,
          quote: { points: 3 },
        });
      });
    }

    if (url.pathname.startsWith('/api/pdf/jobs/') && req.method === 'GET') {
      if (!authorized) return send(401, { error: 'unauthorized', loginRequired: true });
      state.polls += 1;
      // First poll still running: the UI has to survive a non-terminal answer
      // or the progress state is never seen.
      if (state.polls < 2) {
        return send(200, {
          jobId: 'pdf_job_1', status: 'running', progress: 40, stage: 'translate', pageCount: 1,
        });
      }
      return send(200, {
        jobId: 'pdf_job_1',
        status: 'succeeded',
        progress: 100,
        pageCount: 1,
        pointsCharged: 3,
        // A fresh signature per poll, as the real presign does.
        results: {
          dualUrl: `${base()}/result-dual.pdf?sig=${state.polls}`,
          monoUrl: `${base()}/result-mono.pdf?sig=${state.polls}`,
        },
      });
    }

    if (url.pathname.startsWith('/result-')) {
      return send(200, TINY_PDF, 'application/pdf');
    }

    send(404, { error: 'not_found' });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        base: `http://localhost:${server.address().port}`,
        state,
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

/**
 * Point the extension at the mock and give it a token, as a real sign-in
 * would. comicApiBase on purpose: PDF and comics are one account on one
 * origin, and the pdf client reads the same override (see pdf-client.js
 * importing getApiBase's machinery from comic-client.js).
 */
async function connectExtension(context, base, { withToken = true } = {}) {
  const worker = await serviceWorker(context);
  await worker.evaluate(async ({ base, withToken }) => {
    await chrome.storage.sync.set({ enablePdfTranslation: true });
    // pdfJobs too: a record left behind by a previous test would surface in
    // the next one's popup list and confuse its assertions.
    await chrome.storage.local.remove([
      'comicToken', 'comicTokenExpiresAt', 'comicAccountCache', 'pdfJobs',
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

      // The job names the key the ticket issued, and asks for the default
      // product: bilingual, side-by-side, no watermark.
      const [created] = service.state.createBodies;
      expect(created.operationId).toBeTruthy();
      expect(created.sourceKey).toBe(`pdf/u1/${created.operationId}/source.pdf`);
      expect(created.output).toEqual({ kind: 'dual', dualLayout: 'side-by-side', watermark: false });
      expect(created.targetLang).toBeTruthy();

      // The service worker mirrored the job for the popup's task list.
      const worker = await serviceWorker(context);
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

  test('offers a top-up when the balance is short, and uploads only once', async ({ context, page, extensionId }) => {
    const service = await startMockService('insufficient');
    try {
      await connectExtension(context, service.base);
      await openUploadPage(page, extensionId);

      // The 402 lands after the upload but before any polling.
      await expect(page.locator('#pdfError')).toBeVisible({ timeout: 15000 });
      await expect(page.locator('#pdfError')).not.toBeEmpty();
      await expect(page.locator('#pdfRecharge')).toBeVisible();
      // Not a retryable failure: retrying without credits buys nothing.
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
