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

test('input translation shows phonetic for words and read-aloud for anything typed', async ({ page }) => {
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

    // The source is readable before anything has been translated — hearing how
    // the word you just typed is pronounced is the whole point of the button.
    await expect(page.locator('#ai-translator-input-speak')).toBeHidden();
    await page.fill('#ai-translator-input-text', 'on the fly');
    await expect(page.locator('#ai-translator-input-speak')).toBeVisible();
    await expect(page.locator('#ai-translator-input-speak-result')).toBeHidden();

    await page.click('#ai-translator-do-translate');

    await expect(page.locator('#ai-translator-result-section')).toBeVisible();
    await expect(page.locator('#ai-translator-result-text')).toContainText('[DICT] on the fly');
    await expect(page.locator('#ai-translator-input-phonetic')).toHaveText('/ɒn ðə flaɪ/');
    await expect(page.locator('#ai-translator-input-speak-result')).toBeVisible();

    await page.fill('#ai-translator-input-text', 'this is a full sentence for translation');
    await page.click('#ai-translator-do-translate');
    await expect(page.locator('#ai-translator-result-text')).toContainText('[TEXT] this is a full sentence for translation');
    // Only the phonetic is dictionary-only; both speakers stay available because
    // a sentence can be read aloud just as well as a word.
    await expect(page.locator('#ai-translator-input-phonetic')).toBeHidden();
    await expect(page.locator('#ai-translator-input-speak')).toBeVisible();
    await expect(page.locator('#ai-translator-input-speak-result')).toBeVisible();

    // Nothing typed, nothing to read.
    await page.fill('#ai-translator-input-text', '');
    await expect(page.locator('#ai-translator-input-speak')).toBeHidden();
  } finally {
    server.close();
  }
});

/**
 * A backend that reports which target language the request asked for, plus a
 * page to run it on.
 *
 * The page's stylesheet is the point of the fixture. Host pages style bare
 * tags, and a plain `div { opacity: .8 }` — which is what example.com serves —
 * turns every one of our own containers into a stacking context. That used to
 * seal the language menu inside the dialog header so it painted under the body
 * and every click on a language landed on the textarea: the picker looked
 * decorative and the settings page was the only way to change the target.
 */
function startTargetLangFixture() {
  const LANGUAGE_NAMES = {
    'zh-CN': '简体中文',
    'ja': '日本語',
    'fr': 'Français',
  };

  return new Promise((resolve) => {
    const api = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        let systemPrompt = '';
        let text = '';
        try {
          const data = JSON.parse(body);
          systemPrompt = data?.messages?.[0]?.content || '';
          text = data?.messages?.[1]?.content || '';
        } catch (error) {
          systemPrompt = '';
        }
        // The prompt names the target in that language's own words — see
        // languageNames in background/background.js.
        const asked = Object.entries(LANGUAGE_NAMES)
          .find(([, name]) => systemPrompt.includes(name));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{ message: { content: `[${asked ? asked[0] : 'unknown'}] ${text}` } }]
        }));
      });
    });

    const site = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><head><style>div { opacity: 0.8; }</style></head>'
        + '<body><h1>Stacking context page</h1><p>Body text.</p></body></html>');
    });

    api.listen(0, '127.0.0.1', () => {
      site.listen(0, '127.0.0.1', () => {
        resolve({
          api,
          site,
          endpoint: `http://127.0.0.1:${api.address().port}/v1/chat/completions`,
          url: `http://127.0.0.1:${site.address().port}/`,
          close() { api.close(); site.close(); },
        });
      });
    });
  });
}

async function openInputDialog(page) {
  await openFloatBallMenu(page);
  await page.click('.ai-translator-menu-item[data-action="translate-input"]');
  await page.waitForSelector('#ai-translator-input-dialog', { state: 'visible' });
}

async function pickInputTargetLang(page, lang) {
  await page.click('#ai-translator-input-dialog .ai-translator-lang-trigger');
  await page.click(`#ai-translator-input-dialog .ai-translator-lang-item[data-lang="${lang}"]`);
}

test('the input dialog translates into the language picked in it, not the one in settings', async ({ page }) => {
  const fixture = await startTargetLangFixture();

  try {
    await setExtensionSettings(page, {
      apiEndpoint: fixture.endpoint,
      apiKey: 'test-key',
      modelName: 'gpt-4.1-mini',
      targetLang: 'zh-CN',
      targetLangSetByUser: true,
    });

    await page.goto(fixture.url);
    await page.waitForSelector('#ai-translator-float-ball');
    await openInputDialog(page);

    // Clicking through to a language is the assertion here: on a page like this
    // one the menu used to be unreachable behind the textarea.
    await pickInputTargetLang(page, 'ja');
    await expect(page.locator('#ai-translator-input-dialog .ai-translator-lang-label')).toHaveText('日本語');

    await page.fill('#ai-translator-input-text', 'a full sentence for translation');
    await page.click('#ai-translator-do-translate');
    await expect(page.locator('#ai-translator-result-text')).toContainText('[ja]');

    // Reopening keeps the dialog's own target: the whole point is not having to
    // re-pick, or go to the settings page, for the next paste.
    await page.click('#ai-translator-input-dialog .ai-translator-close');
    await openInputDialog(page);
    await expect(page.locator('#ai-translator-input-dialog .ai-translator-lang-label')).toHaveText('日本語');

    await page.fill('#ai-translator-input-text', 'another sentence');
    await page.click('#ai-translator-do-translate');
    await expect(page.locator('#ai-translator-result-text')).toContainText('[ja]');
  } finally {
    fixture.close();
  }
});

test('setting a target language in settings overrides what the input dialog remembers', async ({ page }) => {
  const fixture = await startTargetLangFixture();

  try {
    await setExtensionSettings(page, {
      apiEndpoint: fixture.endpoint,
      apiKey: 'test-key',
      modelName: 'gpt-4.1-mini',
      targetLang: 'zh-CN',
      targetLangSetByUser: true,
    });

    await page.goto(fixture.url);
    await page.waitForSelector('#ai-translator-float-ball');
    await openInputDialog(page);
    await pickInputTargetLang(page, 'ja');
    await page.click('#ai-translator-input-dialog .ai-translator-close');

    // An explicit choice on the settings page is the stronger signal — a dialog
    // that quietly kept translating into Japanese would be the same complaint
    // the dialog's own picker exists to answer.
    await setExtensionSettings(page, { targetLang: 'fr', targetLangSetByUser: true });

    await openInputDialog(page);
    await expect(page.locator('#ai-translator-input-dialog .ai-translator-lang-label')).toHaveText('Français');

    await page.fill('#ai-translator-input-text', 'a full sentence for translation');
    await page.click('#ai-translator-do-translate');
    await expect(page.locator('#ai-translator-result-text')).toContainText('[fr]');
  } finally {
    fixture.close();
  }
});
