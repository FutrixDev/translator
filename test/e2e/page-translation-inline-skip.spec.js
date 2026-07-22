const { test, expect } = require('./fixtures');
const { setExtensionSettings, triggerPageTranslation } = require('./helpers');
const http = require('http');

// Page translation uses the fast-batch path: blocks are joined with the DELIMITER constant
// from content/content-page-translation.js, and the model is told to separate the
// translations with that same delimiter (FAST_BATCH_PROMPT in background/background.js).
// The mock must honor that contract, so it recovers the delimiter from the system prompt of
// the request it actually receives instead of hardcoding a copy that can drift out of sync.
//
// Getting this wrong does NOT fail loudly: an unsegmented echo still carries the delimiters
// through, so the segment count still matches and background.js never falls back to the
// numbered format — but every segment after the first comes back byte-identical to its
// source, and shouldSkipTranslation() then silently drops it as "already translated".
const PROMPT_DELIMITER_RE = /segments are separated by "([^"]+)"/;

function startMockOpenAIServer() {
  // One entry per request that took the fast-batch path, so the test can assert the mock
  // really spoke the delimiter protocol rather than falling through to the single-text path.
  const fastBatchRequests = [];

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
        endpoint: `http://127.0.0.1:${port}/v1/chat/completions`
      });
    });
  });
}

test('page translation skips blocks with inline translation', async ({ page }) => {
  const { server, endpoint, fastBatchRequests } = await startMockOpenAIServer();

  try {
    await setExtensionSettings(page, {
      apiEndpoint: endpoint,
      apiKey: 'test-key',
      modelName: 'gpt-4.1-mini',
      targetLang: 'zh-CN',
      autoDetect: false,
      enableHoverTranslation: true,
      hoverTranslationHotkey: 'Shift'
    });

    await page.goto('https://example.com');
    await page.waitForSelector('#ai-translator-float-ball');

    await page.evaluate(() => {
      const container = document.createElement('div');
      container.id = 'inline-translation-test';
      container.innerHTML = `
        <p id="inline-para-one">Inline translation paragraph one.</p>
        <p id="inline-para-two">Inline translation paragraph two.</p>
      `;
      document.body.appendChild(container);
    });

    const paragraphOne = page.locator('#inline-para-one');
    const paragraphTwo = page.locator('#inline-para-two');

    await page.keyboard.down('Shift');
    await paragraphOne.hover();
    await page.waitForSelector('#inline-para-one + .ai-translator-hover-translation', { state: 'attached' });
    await page.keyboard.up('Shift');

    await triggerPageTranslation(page);

    // Fail fast if the prompt wording drifted and the delimiter could no longer be
    // recovered; the symptom would otherwise be an unexplained timeout on the wait below.
    await expect
      .poll(() => fastBatchRequests.length, {
        timeout: 15000,
        message: 'mock never recognized a fast-batch request (delimiter not found in system prompt)'
      })
      .toBeGreaterThan(0);

    await page.waitForFunction(() => {
      const el = document.getElementById('inline-para-two');
      return el && el.classList.contains('ai-translator-translated');
    });

    await expect(paragraphOne).not.toHaveClass(/ai-translator-translated/);
    await expect(page.locator('#inline-translation-test .ai-translator-inline-block')).toHaveCount(2);
  } finally {
    server.close();
  }
});
