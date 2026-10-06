/**
 * Mock OpenAI-compatible chat-completions server for page-translation E2E tests.
 *
 * Page translation uses the fast-batch path: blocks are joined with the DELIMITER constant
 * from content/content-page-translation.js, and the model is told to separate the
 * translations with that same delimiter (FAST_BATCH_PROMPT in background/background.js).
 * The mock must honor that contract, so it recovers the delimiter from the system prompt of
 * the request it actually receives instead of hardcoding a copy that can drift out of sync.
 *
 * Getting this wrong does NOT fail loudly: an unsegmented echo still carries the delimiters
 * through, so the segment count still matches and background.js never falls back to the
 * numbered format — but every segment after the first comes back byte-identical to its
 * source, and shouldSkipTranslation() then silently drops it as "already translated".
 */
const { startMockServer } = require('./mock-server');
// A word lookup asks for a dictionary entry (shared/dict-entry.js), and the
// service worker rejects anything that is not one. The mock recognises that
// request by the rules' first line, the same constant the prompt is built from.
require('../../shared/dict-entry.js');

const PROMPT_DELIMITER_RE = /segments are separated by "([^"]+)"/;

/**
 * The pixel size of a PNG data URL, straight out of its IHDR chunk.
 *
 * The picture that arrives is the only proof of what the worker did to it: a
 * region crop is a different picture from the whole image, and its dimensions
 * are what say so. Null for anything that is not a PNG data URL.
 */
function pngDataUrlSize(dataUrl) {
  const base64 = /^data:image\/png;base64,(.+)$/s.exec(String(dataUrl || ''));
  if (!base64) return null;
  const bytes = Buffer.from(base64[1], 'base64');
  // 8-byte signature, then the IHDR chunk: 4 length + 4 type + width + height.
  if (bytes.length < 24 || bytes.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/**
 * @param {object} [options]
 * @param {number} [options.failRequests]
 *   让最前面这么多次翻译请求失败（状态码见 failStatus），之后恢复正常。
 *
 *   偶发失败和接口不可用是两回事：一轮里失败不到 MAX_BATCH_FAILURES 次时这一轮
 *   **不报错**（content/page/batch.js），那几块只是一个字都没翻。要证「下一次
 *   还会再试一次」，就得能造出这种一半成一半败的一轮 —— 整台服务器一直 500 造
 *   不出来，那是另一条路（整体故障）。
 *
 *   失败的那几次照样记进 sentTexts：文字确实发出去了，钱也确实花了。
 * @param {?number} [options.failAfter]
 *   反过来的那一半：前这么多次翻译请求正常作答，之后**一直**失败。
 *
 *   「出错之前页面上已经有译文了」这个局面只有这一头造得出来 —— 而它正是出错那
 *   条路上最要紧的一个：一个字都没翻成的页面，用户连「隐藏译文」都点不到。
 * @param {?(text: string) => boolean} [options.failWhen]
 *   按**内容**决定这一次答不答：命中就失败（状态码见 failStatus）。
 *
 *   failRequests / failAfter 数的是「第几次请求」，而整页翻译是 8 个并发在跑，
 *   哪一批先到是赛跑出来的。要造「这几块翻成了、那几块崩了」这种确定的一轮，
 *   就只能按内容挑 —— 按次数挑的话，同一份测试今天证的是 A 成了，明天证的是
 *   A 崩了，而两种结局里只有一种在测那件事。
 *
 *   和上面两个不叠加使用：这一条先判，命中就不再数次数。
 * @param {?number} [options.status]
 *   Answer every request with this HTTP status and an empty body, whatever it
 *   asked. A local model server that refuses the extension looks exactly like
 *   this: Ollama answers a chrome-extension:// origin missing from
 *   OLLAMA_ORIGINS with a bare 403 and nothing to parse.
 * @param {number} [options.delayMs]
 *   每次作答前先拖这么久。整页翻译在真实页面上要跑几十秒，一批批往回落 ——
 *   「翻到一半用户按了显示原文」这类旅程，只有在一轮还没跑完的时候才存在，
 *   而答得太快的服务器把那个窗口压成了零。
 * @param {number} [options.failStatus]
 *   failRequests / failAfter / failWhen 失败时回的状态码，缺省 500。
 *
 *   SW 会自动重试 429、5xx 和网络错误（background/model-client.js，最多 3 次）。
 *   要证「这一批就是失败了」的测试，挑一个不会被重试的码（400、401、403、404），
 *   否则 500 被重试吃掉，失败根本到不了页面；要证「重试会自己恢复」的测试才用 500。
 * @param {?{count: number, retryAfter: (number|string)}} [options.rateLimit]
 *   前 count 次请求回 429，带 `Retry-After: retryAfter`（秒数或 HTTP 日期），之后
 *   照常作答。在其余失败选项之前判，命中就不再往下走。
 * @param {(text: string) => object} [options.dictEntry]
 *   A word lookup (the system prompt carries DictEntry.PROMPT_MARK) is answered
 *   with this entry, as JSON. The default is a translation-only entry,
 *   `{ translation: '[T] ' + text }`, so a lookup reads like every other reply.
 */
async function startMockOpenAIServer({
  failRequests = 0, failAfter = null, failWhen = null, status = null, delayMs = 0,
  failStatus = 500, rateLimit = null,
  dictEntry = (text) => ({ translation: `[T] ${text}` })
} = {}) {
  let remainingFailures = failRequests;
  let remainingRateLimited = rateLimit ? rateLimit.count : 0;
  let served = 0;
  // 运行中可以换：setFailWhen(fn) 之后的请求按新的判断答（D-J10 先让一段失败、
  // 再修好它）。
  let failWhenNow = failWhen;
  // 每次 POST 到达的时刻（Date.now()），按到达顺序：重试的间隔只能在这里量。
  const requestTimes = [];
  // 同一时刻还没答完的 POST 数，和它到过的最大值：限速的并发上限只能在这里量。
  let inFlight = 0;
  let maxInFlight = 0;
  // One entry per request that took the fast-batch path, so tests can assert the mock
  // really spoke the delimiter protocol rather than falling through to the single-text path.
  const fastBatchRequests = [];
  // The raw user-message text of EVERY request, whichever path it took. A "this text must
  // never be translated" assertion has to check what actually left the browser: asserting on
  // the DOM instead only proves no translation was rendered, which also passes when the text
  // was shipped to the API and the reply merely failed to land.
  const sentTexts = [];
  // The system prompt of each of those requests, index for index with sentTexts:
  // systemPrompts[i] is the prompt that carried sentTexts[i]. What the model was
  // told about the page (the prompt addenda: register, domain, glossary, page
  // context) only exists here: the page sees the translation, never the
  // instructions that shaped it.
  const systemPrompts = [];
  // One entry per vision (image OCR) request — content arrived as an array of parts rather
  // than a string. Recorded so specs can assert the image really left the browser in the
  // OpenAI shape, not just that a popup rendered something.
  const visionRequests = [];
  // The credentials each POST carried, in arrival order: `null` where a header
  // was not sent at all. A request with no key must leave with no auth header —
  // an empty `Bearer ` is still a header, and some servers reject it.
  const authHeaders = [];
  // The path of every POST, in arrival order. The mock answers on any path, so
  // two AI profiles pointed at `${origin}/a/...` and `${origin}/b/...` are two
  // endpoints on one server, and this is what says which one a request hit.
  const requestPaths = [];

  const { origin, close } = await startMockServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(404);
      res.end();
      return;
    }

    requestTimes.push(Date.now());
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      inFlight -= 1;
    };
    res.on('finish', settle);
    res.on('close', settle);

    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      requestPaths.push(req.url);
      authHeaders.push({
        authorization: req.headers.authorization ?? null,
        xApiKey: req.headers['x-api-key'] ?? null,
      });
      if (status !== null) {
        res.writeHead(status);
        res.end();
        return;
      }

      let content = '';
      let systemPrompt = '';
      try {
        const data = JSON.parse(body);
        const messages = data?.messages || [];
        content = messages[messages.length - 1]?.content || '';
        systemPrompt = messages.find((m) => m?.role === 'system')?.content || '';
      } catch {
        content = '';
      }

      // A vision request: [{type:'text'},{type:'image_url'}]. Answer with the JSON
      // contract from shared/ocr.js instead of the echo protocol below.
      if (Array.isArray(content)) {
        const imagePart = content.find((part) => part?.type === 'image_url');
        visionRequests.push({
          partTypes: content.map((part) => part?.type),
          // Enough of the data URL to assert the media type without dumping megabytes
          // of base64 into a test failure message.
          imageUrlPrefix: String(imagePart?.image_url?.url || '').slice(0, 40),
          // What the worker actually sent, for specs that assert on the crop.
          imageSize: pngDataUrlSize(imagePart?.image_url?.url),
          systemPrompt
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{
            message: {
              // Recognition only: the translation is a second, ordinary
              // request, which the echo protocol below answers.
              content: JSON.stringify({ text: 'HELLO WORLD', language: 'en' })
            }
          }]
        }));
        return;
      }

      if (content) {
        sentTexts.push(content);
        systemPrompts.push(systemPrompt);
      }

      if (remainingRateLimited > 0) {
        remainingRateLimited -= 1;
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(rateLimit.retryAfter) });
        res.end(JSON.stringify({ error: { message: 'mock: rate limited' } }));
        return;
      }

      if (failWhenNow && typeof content === 'string' && failWhenNow(content)) {
        res.writeHead(failStatus, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'mock: upstream refused this batch' } }));
        return;
      }

      if (remainingFailures > 0) {
        remainingFailures -= 1;
        res.writeHead(failStatus, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'mock: upstream hiccup' } }));
        return;
      }

      if (failAfter !== null && served >= failAfter) {
        res.writeHead(failStatus, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'mock: upstream down' } }));
        return;
      }
      served += 1;

      const delimiter = systemPrompt.match(PROMPT_DELIMITER_RE)?.[1];
      if (systemPrompt.includes(globalThis.DictEntry.PROMPT_MARK)) {
        content = JSON.stringify(dictEntry(content));
      } else if (delimiter) {
        const segments = content.split(delimiter);
        fastBatchRequests.push({ delimiter, segmentCount: segments.length });
        content = segments
          .map((segment) => (segment ? `[T] ${segment}` : segment))
          .join(delimiter);
      } else if (content) {
        content = `[T] ${content}`;
      }

      const response = JSON.stringify({
        choices: [{ message: { content } }]
      });
      const reply = () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(response);
      };
      if (delayMs > 0) setTimeout(reply, delayMs);
      else reply();
    });
  });

  return {
    fastBatchRequests,
    sentTexts,
    systemPrompts,
    visionRequests,
    authHeaders,
    requestPaths,
    requestTimes,
    get maxInFlight() {
      return maxInFlight;
    },
    setFailWhen(fn) {
      failWhenNow = fn;
    },
    origin,
    endpoint: `${origin}/v1/chat/completions`,
    close
  };
}

module.exports = { startMockOpenAIServer };
