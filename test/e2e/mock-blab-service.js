/**
 * The Blab account service as the 'blab' engine sees it: design §2's contract,
 * stubbed on one mock-server origin that the extension's comicApiBase points
 * at (connectExtension).
 *
 *   GET  /api/billing/me      the account, with `blabTranslation` in one of its
 *                             two shapes (§2.2): {available, limit, used,
 *                             resetsAt} or {available:false}
 *   POST /api/blab/complete   {system, user, maxTokens, temperature?, image?} ->
 *                             200 {text, usage} or {error, ...} (§2.1); with
 *                             an image (D-740) the text reads it as OCR_TEXT
 *   GET  /ext/connect         the sign-in bounce (serveExtConnect), counted in
 *                             `state.connects` and held `state.connectDelayMs`
 *                             before it answers (a test may change both)
 *
 * The model's answer is the protocol every model mock here speaks
 * (answerPrompt in mock-openai-server.js), so the extension's own prompts and
 * parsing are what is under test, not a canned reply. A successful call adds
 * its tokens to `used`, so the settings page's "used today" can be seen to
 * move. The server meters what the model provider reports, prompt plus
 * completion (D-564); with no provider behind this stub, a token stands in
 * for every four characters of system, user and answer.
 *
 * `state.mode` says what the account is right now and can change mid-test:
 *   'available'      billing/me says available; complete answers 200
 *   'plan_required'  billing/me says {available:false}; complete answers 403
 *   'daily_limit'    billing/me says available with used == limit; complete
 *                    answers 429 {error:'daily_limit', limit, used, resetsAt}
 *                    with no Retry-After
 *   'unauthorized'   the token expired or was revoked server-side: billing/me
 *                    and complete both answer 401 `unauthorized` to any bearer
 * A request without a bearer token is 401 `unauthorized` whatever the mode.
 */
const { startMockServer, serveExtConnect } = require('./mock-server');
const { answerPrompt, sourceOf } = require('./mock-openai-server');
require('../../shared/dict-entry.js');

const RESETS_AT = '2099-01-02T00:00:00.000Z';
// What every image sent with /api/blab/complete is read as.
const OCR_TEXT = 'HELLO WORLD';
const quota = { limit: 40, used: 0, remaining: 40, applied: false, resetsAt: '2099-02-01T00:00:00.000Z' };

/**
 * @param {object} [options]
 * @param {'available'|'plan_required'|'daily_limit'|'unauthorized'} [options.mode]
 * @param {number} [options.limit] the daily allowance billing/me and 429 report
 * @param {number} [options.used] what has been spent today before the test
 * @param {(text: string) => (object|string)} [options.dictEntry] the answer to
 *   a word lookup; the default is a translation-only entry
 */
async function startMockBlabService({
  mode = 'available', limit = 1000000, used = 0,
  dictEntry = (text) => ({ translation: `[T] ${text}` }),
} = {}) {
  const state = {
    mode,
    used,
    meRequests: 0,
    // Sign-in tabs opened: one per /ext/connect the extension sent the user to.
    connects: 0,
    connectDelayMs: 0,
    // One entry per POST /api/blab/complete, in arrival order: the bearer it
    // carried and the body as parsed. "Only one request" and "zero requests"
    // are assertions on this list.
    completeRequests: [],
  };

  const { origin, close } = await startMockServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    const authorized = (req.headers.authorization || '').startsWith('Bearer ');

    if (url.pathname === '/ext/connect') {
      state.connects += 1;
      return serveExtConnect(url, res, { delayMs: state.connectDelayMs });
    }

    if (url.pathname === '/api/billing/me') {
      state.meRequests += 1;
      if (!authorized || state.mode === 'unauthorized') return send(401, { error: 'unauthorized', loginRequired: true });
      const blabTranslation = state.mode === 'plan_required'
        ? { available: false }
        : { available: true, limit, used: state.mode === 'daily_limit' ? limit : state.used, resetsAt: RESETS_AT };
      return send(200, {
        user: { email: 'reader@example.com', name: 'Reader' },
        freeQuotas: { comic_page: quota, pdf_page: quota },
        blabTranslation,
      });
    }

    if (url.pathname === '/api/blab/complete' && req.method === 'POST') {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        const body = JSON.parse(raw);
        state.completeRequests.push({ authorization: req.headers.authorization ?? null, body });
        if (!authorized || state.mode === 'unauthorized') return send(401, { error: 'unauthorized' });
        if (state.mode === 'plan_required') return send(403, { error: 'plan_required' });
        if (state.mode === 'daily_limit') {
          return send(429, { error: 'daily_limit', limit, used: limit, resetsAt: RESETS_AT });
        }
        // An image (OCR step 1) is answered in shared/ocr.js's JSON contract,
        // like mock-openai-server.js's vision branch; the prompts are not echoed.
        // A text request's user turn must be fenced, as that server checks too.
        const source = body.image ? null : sourceOf(body.system, body.user);
        if (!body.image && source === null) return send(500, { error: 'user turn is not fenced in <source>' });
        const { text } = body.image
          ? { text: JSON.stringify({ text: OCR_TEXT, language: 'en' }) }
          : answerPrompt(body.system, source, dictEntry);
        state.used += Math.ceil((body.system.length + body.user.length + text.length) / 4);
        return send(200, {
          text,
          usage: { used: state.used, limit, resetsAt: RESETS_AT },
        });
      });
      return undefined;
    }

    return send(404, { error: 'not_found' });
  });

  return { base: origin, state, close, RESETS_AT };
}

module.exports = { startMockBlabService, OCR_TEXT };
