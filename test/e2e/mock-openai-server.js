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
const http = require('http');

const PROMPT_DELIMITER_RE = /segments are separated by "([^"]+)"/;

function startMockOpenAIServer() {
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

  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
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
            systemPrompt
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            choices: [{
              message: {
                content: JSON.stringify({
                  text: 'HELLO WORLD',
                  language: 'en',
                  languageName: '英语',
                  translation: '你好，世界'
                })
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

    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        server,
        fastBatchRequests,
        sentTexts,
        visionRequests,
        endpoint: `http://127.0.0.1:${port}/v1/chat/completions`
      });
    });
  });
}

module.exports = { startMockOpenAIServer };
