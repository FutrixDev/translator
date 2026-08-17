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

async function startMockOpenAIServer() {
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
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(response);
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
