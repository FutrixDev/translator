/**
 * A stand-in for the document translation service, shared by every journey
 * that uploads a document (pdf-translation.spec.js, document-formats.spec.js).
 *
 * It speaks the real contract (translator-saas server/app/api/pdf/...): a
 * ticket that answers the declared `sourceFormat` and an uploadUrl pointing
 * back at this server, a PUT sink standing in for the presigned storage URL, a
 * 202 create, a GET that walks a scripted sequence of views, `POST /confirm`,
 * `POST /abandon`, the account's list, and the result files themselves.
 *
 * It records what the journeys assert on: every ticket body, what each PUT
 * carried (its content type, its length, its first bytes), every create body,
 * every confirm. Built on startMockServer — a spec that starts its own server
 * is refused by the unit guard.
 */
const { startMockServer } = require('./mock-server');

const DEFAULT_ACCOUNT = {
  email: 'reader@example.com',
  balancePoints: 0,
  freeQuota: { pdf_page: { limit: 20, remaining: 18 }, comic_page: { limit: 40, remaining: 40 } },
};

/**
 * A minimal PDF as a static byte template. Nothing renders it: the extension
 * sniffs the "%PDF-" magic and the PUT sink re-checks it, so a one-page
 * skeleton is exactly as load-bearing as a real paper. Also served at
 * /paper.pdf, the "remote" PDF of the URL flow.
 */
const TINY_PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
  '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n' +
  '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>\nendobj\n' +
  'trailer\n<< /Root 1 0 R >>\n%%EOF\n',
  'latin1',
);

/**
 * The create answers the journeys name rather than write: `'succeed'` (the
 * default), `'flaky-create'` — the first create is accepted by the server but
 * answered with a 500, so from the client's side it may or may not have landed
 * (a dropped socket is no good: Chrome silently re-sends a request that dies on
 * a reused keep-alive connection) — and `'insufficient'`, the 402.
 */
const CREATE_BEHAVIOURS = {
  succeed: () => null,
  'flaky-create': (body, state) => (state.createBodies.length === 1 ? [500, { error: 'internal_error' }] : null),
  insufficient: () => [402, {
    error: 'insufficient_points', message: 'Not enough points', balance: 0, required: 3, rechargeUrl: '/billing',
  }],
};

const EXTENSIONS = { pdf: 'pdf', docx: 'docx', epub: 'epub', txt: 'txt', md: 'md', mobi: 'mobi' };

/** How the object store types a result, so a PDF opened in a tab is shown, not saved. */
const RESULT_TYPES = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  epub: 'application/epub+zip',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
};

/** The views a job walks by default: one poll still running, then done. */
function defaultViews() {
  return [
    { status: 'running', progress: 40, stage: 'translate' },
    { status: 'succeeded', progress: 100, pointsCharged: 3 },
  ];
}

/** After "Continue": back in the queue for one poll, then done. */
function defaultAfterConfirm() {
  return [
    { status: 'running', progress: 60, stage: 'translate' },
    { status: 'succeeded', progress: 100 },
  ];
}

/**
 * @param {object} [options]
 * @param {(body: object, state: object) => ([number, object] | null)} [options.ticket]
 *   Overrides the ticket answer (e.g. a 413); null keeps the default.
 * @param {string | ((body: object, state: object) => ([number, object] | null))} [options.create]
 *   A CREATE_BEHAVIOURS name, or an override of the create answer; null keeps the default.
 * @param {(body: object) => object[]} [options.views] The GET sequence for a new job.
 * @param {() => object[]} [options.afterConfirm] The GET sequence once confirmed.
 * @param {Record<string, {bytes: Buffer, type: string}>} [options.files] Static files.
 */
async function startDocService(options = {}) {
  const state = {
    apiHits: [],
    uploadTickets: [],
    uploadPuts: [],
    createBodies: [],
    confirms: [],
    polls: 0,
    // jobId → { facts, views, at }
    jobs: new Map(),
  };
  const createOverride = typeof options.create === 'string'
    ? CREATE_BEHAVIOURS[options.create]
    : (options.create || CREATE_BEHAVIOURS.succeed);
  if (!createOverride) throw new Error(`unknown create behaviour ${options.create}`);
  let created = 0;
  let origin = '';

  const resultPath = (jobId, which, format) => `/result/${jobId}/${which}.${EXTENSIONS[format] || 'bin'}`;
  /** The bytes a non-PDF result download must equal. */
  const resultBytes = (jobId, which) => Buffer.from(`translated ${which} of ${jobId}\n`, 'utf8');

  /** The job's current view, with the facts every view carries and fresh signatures. */
  function viewOf(job, step) {
    const view = { ...job.facts, ...step };
    if (view.status === 'succeeded' && !('results' in step) && job.facts.sourceFormat !== 'mobi') {
      const sig = `?sig=${state.polls}`;
      view.results = {
        dualUrl: `${origin}${resultPath(job.facts.jobId, 'dual', job.facts.sourceFormat)}${sig}`,
        monoUrl: `${origin}${resultPath(job.facts.jobId, 'mono', job.facts.sourceFormat)}${sig}`,
      };
    }
    return view;
  }

  const current = job => viewOf(job, job.views[Math.min(job.at, job.views.length - 1)]);

  const server = await startMockServer((req, res) => {
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
    const json = raw => JSON.parse(raw.toString() || '{}');
    const reply = override => send(override[0], override[1]);

    const files = { '/paper.pdf': { bytes: TINY_PDF, type: 'application/pdf' }, ...options.files };
    const file = files[url.pathname];
    if (file && req.method === 'GET') return send(200, file.bytes, file.type);

    // The presigned PUT carries no bearer token: the signature in the URL is
    // the authorization.
    if (url.pathname === '/upload-sink' && req.method === 'PUT') {
      return readBody((bytes) => {
        state.uploadPuts.push({
          key: url.searchParams.get('key'),
          contentType: req.headers['content-type'],
          authorization: req.headers.authorization || null,
          byteLength: bytes.length,
          head: bytes.subarray(0, 8).toString('latin1'),
          isPdf: bytes.subarray(0, 5).toString('latin1') === '%PDF-',
        });
        send(200, '');
      });
    }

    const result = /^\/result\/([^/]+)\/(dual|mono)\.([a-z]+)$/.exec(url.pathname);
    if (result && req.method === 'GET') {
      const type = RESULT_TYPES[result[3]] || 'application/octet-stream';
      // A PDF result is a real PDF, so Chrome's viewer takes it when a tab opens it.
      const bytes = result[3] === 'pdf' ? TINY_PDF : resultBytes(result[1], result[2]);
      return send(200, bytes, type);
    }

    if (!url.pathname.startsWith('/api/')) return send(404, { error: 'not_found' });
    // Only the document API counts: pdf-prompt.spec.js asserts no job request
    // leaves before a click, and the account lookup is not one.
    if (url.pathname.startsWith('/api/pdf/')) state.apiHits.push(`${req.method} ${url.pathname}`);
    if (!(req.headers.authorization || '').startsWith('Bearer ')) {
      return send(401, { error: 'unauthorized', loginRequired: true });
    }

    if (url.pathname === '/api/billing/me') return send(200, DEFAULT_ACCOUNT);

    if (url.pathname === '/api/pdf/uploads' && req.method === 'POST') {
      return readBody((raw) => {
        const body = json(raw);
        state.uploadTickets.push(body);
        const override = options.ticket && options.ticket(body, state);
        if (override) return reply(override);
        // The real key embeds the user id and the operation id, and ends in the
        // declared format's extension; the create checks both.
        const format = body.sourceFormat;
        const sourceKey = `pdf/u1/${body.operationId}/source.${EXTENSIONS[format]}`;
        send(200, {
          sourceKey,
          uploadUrl: `${origin}/upload-sink?key=${encodeURIComponent(sourceKey)}`,
          maxBytes: 30 * 1024 * 1024,
          sourceFormat: format,
        });
      });
    }

    if (url.pathname === '/api/pdf/jobs' && req.method === 'POST') {
      return readBody((raw) => {
        const body = json(raw);
        state.createBodies.push(body);
        const override = createOverride(body, state);
        if (override) return reply(override);
        // Idempotent under the operation id, as the real create is.
        for (const job of state.jobs.values()) {
          if (job.operationId === body.operationId) return send(200, current(job));
        }
        created += 1;
        const jobId = `pdf_job_${created}`;
        const job = {
          operationId: body.operationId,
          facts: {
            jobId,
            fileName: body.fileName,
            sourceFormat: body.sourceFormat,
            targetLang: body.targetLang,
            pageCount: body.declaredUnits || 1,
            createdAt: Date.now(),
          },
          views: (options.views || defaultViews)(body),
          at: 0,
        };
        state.jobs.set(jobId, job);
        send(202, viewOf(job, { status: 'queued', progress: 0, quote: { points: 3 } }));
      });
    }

    if (url.pathname === '/api/pdf/jobs' && req.method === 'GET') {
      return send(200, { jobs: [...state.jobs.values()].reverse().map(current) });
    }

    const action = /^\/api\/pdf\/jobs\/([^/]+)(?:\/(confirm|abandon))?$/.exec(url.pathname);
    if (action) {
      const job = state.jobs.get(decodeURIComponent(action[1]));
      if (!job) return send(404, { error: 'not_found' });
      if (req.method === 'GET' && !action[2]) {
        state.polls += 1;
        const view = current(job);
        job.at += 1;
        return send(200, view);
      }
      if (req.method === 'POST' && action[2] === 'confirm') {
        state.confirms.push(job.facts.jobId);
        if (current(job).status !== 'awaiting_confirm') {
          return send(409, { error: 'not_awaiting_confirm' });
        }
        job.views = (options.afterConfirm || defaultAfterConfirm)();
        job.at = 0;
        return send(200, current(job));
      }
      if (req.method === 'POST' && action[2] === 'abandon') {
        job.views = [{ status: 'abandoned', progress: 0, error: { code: 'abandoned', refunded: true } }];
        job.at = 0;
        return send(200, current(job));
      }
    }

    send(404, { error: 'not_found' });
  });
  origin = server.origin;

  return {
    base: origin,
    state,
    close: server.close,
    resultBytes,
    /** Replace what a job's polls answer from now on. */
    script(jobId, views) {
      const job = state.jobs.get(jobId);
      if (!job) throw new Error(`no job ${jobId}`);
      job.views = views;
      job.at = 0;
    },
  };
}

module.exports = { startDocService, DEFAULT_ACCOUNT, TINY_PDF };
