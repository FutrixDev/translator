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
 *   让最前面这么多次翻译请求以 HTTP 500 作答，之后恢复正常。
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
 *   按**内容**决定这一次答不答：命中就 500。
 *
 *   failRequests / failAfter 数的是「第几次请求」，而整页翻译是 8 个并发在跑，
 *   哪一批先到是赛跑出来的。要造「这几块翻成了、那几块崩了」这种确定的一轮，
 *   就只能按内容挑 —— 按次数挑的话，同一份测试今天证的是 A 成了，明天证的是
 *   A 崩了，而两种结局里只有一种在测那件事。
 *
 *   和上面两个不叠加使用：这一条先判，命中就不再数次数。
 * @param {number} [options.delayMs]
 *   每次作答前先拖这么久。整页翻译在真实页面上要跑几十秒，一批批往回落 ——
 *   「翻到一半用户按了显示原文」这类旅程，只有在一轮还没跑完的时候才存在，
 *   而答得太快的服务器把那个窗口压成了零。
 */
async function startMockOpenAIServer({ failRequests = 0, failAfter = null, failWhen = null, delayMs = 0 } = {}) {
  let remainingFailures = failRequests;
  let served = 0;
  // One entry per request that took the fast-batch path, so tests can assert the mock
  // really spoke the delimiter protocol rather than falling through to the single-text path.
  const fastBatchRequests = [];
  // The raw user-message text of EVERY request, whichever path it took. A "this text must
  // never be translated" assertion has to check what actually left the browser: asserting on
  // the DOM instead only proves no translation was rendered, which also passes when the text
  // was shipped to the API and the reply merely failed to land.
  const sentTexts = [];
  // One entry per vision (image OCR) request — content arrived as an array of parts rather
  // than a string. Recorded so specs can assert the image really left the browser in the
  // OpenAI shape, not just that a popup rendered something.
  const visionRequests = [];

  const { origin, close } = await startMockServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(404);
      res.end();
      return;
    }

    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
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

      if (content) sentTexts.push(content);

      if (failWhen && typeof content === 'string' && failWhen(content)) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'mock: upstream refused this batch' } }));
        return;
      }

      if (remainingFailures > 0) {
        remainingFailures -= 1;
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'mock: upstream hiccup' } }));
        return;
      }

      if (failAfter !== null && served >= failAfter) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'mock: upstream down' } }));
        return;
      }
      served += 1;

      const delimiter = systemPrompt.match(PROMPT_DELIMITER_RE)?.[1];
      if (delimiter) {
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
    visionRequests,
    endpoint: `${origin}/v1/chat/completions`,
    close
  };
}

module.exports = { startMockOpenAIServer };
