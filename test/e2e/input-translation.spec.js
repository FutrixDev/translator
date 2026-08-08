const { test, expect } = require('./fixtures');
const { setExtensionSettings, openFloatBallMenu } = require('./helpers');
const http = require('http');

function startInputDictionaryMockServer() {
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
        let systemPrompt = '';
        let text = '';

        try {
          const data = JSON.parse(body);
          systemPrompt = data?.messages?.[0]?.content || '';
          text = data?.messages?.[1]?.content || '';
        } catch (error) {
          systemPrompt = '';
          text = '';
        }

        const isDictionaryMode = /"translation"\s+and\s+"phonetic"/i.test(systemPrompt);
        const content = isDictionaryMode
          ? JSON.stringify({ translation: `[DICT] ${text}`, phonetic: '/ɒn ðə flaɪ/' })
          : `[TEXT] ${text}`;

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{ message: { content } }]
        }));
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        server,
        endpoint: `http://127.0.0.1:${port}/v1/chat/completions`
      });
    });
  });
}

test('input translation shows phonetic and pronunciation for short phrase', async ({ page }) => {
  const { server, endpoint } = await startInputDictionaryMockServer();

  try {
    await setExtensionSettings(page, {
      // Dictionary mode only exists on the AI path — the built-in engine gives
      // back no phonetic and reports isWord: false — and the assertions below
      // are on this mock's replies, so the backend has to be pinned. See
      // setExtensionSettings in ./helpers.
      apiEndpoint: endpoint,
      apiKey: 'test-key',
      modelName: 'gpt-4.1-mini',
      targetLang: 'zh-CN',
      targetLangSetByUser: true,
    });

    await page.goto('https://example.com');
    await page.waitForSelector('#ai-translator-float-ball');

    await openFloatBallMenu(page);
    await page.click('.ai-translator-menu-item[data-action="translate-input"]');

    await page.waitForSelector('#ai-translator-input-dialog', { state: 'visible' });
    await page.fill('#ai-translator-input-text', 'on the fly');
    await page.click('#ai-translator-do-translate');

    await expect(page.locator('#ai-translator-result-section')).toBeVisible();
    await expect(page.locator('#ai-translator-result-text')).toContainText('[DICT] on the fly');
    await expect(page.locator('#ai-translator-input-phonetic')).toHaveText('/ɒn ðə flaɪ/');
    await expect(page.locator('#ai-translator-input-speak')).toBeVisible();

    await page.fill('#ai-translator-input-text', 'this is a full sentence for translation');
    await page.click('#ai-translator-do-translate');
    await expect(page.locator('#ai-translator-result-text')).toContainText('[TEXT] this is a full sentence for translation');
    await expect(page.locator('#ai-translator-input-phonetic')).toBeHidden();
    await expect(page.locator('#ai-translator-input-speak')).toBeHidden();
  } finally {
    server.close();
  }
});
