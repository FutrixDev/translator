// A local model server takes no API key, and a failed request is told in the
// reader's language.
//
// Before this, every surface asked `!settings.apiKey` on its own, so an Ollama
// or LM Studio setup with the key box left empty (as both vendors document it)
// was refused before a request ever left the browser; and when a request did
// fail, the reason came back as a Chinese sentence whatever the UI language.
// The rule now lives in one place, APICompat.isApiKeyMissing
// (shared/api-compat.js), and every error is worded at the boundary through
// APICompat.describeAPIFailure. These are the journeys a user walks through it:
//
//   J-A1  selection translation against a local server, no key
//   J-A2  whole-page translation against a local server, no key
//   J-A3  a remote endpoint with no key is still refused, in Japanese, with
//         nothing sent
//   J-A4  a local server that refuses the extension (Ollama's bare 403)
//   J-A5  a local server that is not running
//   J-A6  the popup and the settings page agree the local setup is ready
//
// Every mock is test/e2e/mock-openai-server.js on 127.0.0.1 with port 0, which
// is loopback, so it is the local case by definition.
const { test, expect } = require('./fixtures');
const { getMessage } = require('../../i18n/messages');
const {
  setExtensionSettings,
  openFloatBallMenu,
  triggerPageTranslation,
  getServiceWorker,
} = require('./helpers');
const { startMockOpenAIServer } = require('./mock-openai-server');

const en = (key) => getMessage(key, 'en');
const popupUrl = (extensionId) => `chrome-extension://${extensionId}/popup/popup.html`;
const optionsUrl = (extensionId) => `chrome-extension://${extensionId}/options/options.html`;

// A local setup exactly as the Ollama and LM Studio guides describe it: an
// OpenAI-compatible endpoint on this machine and no key at all.
const localSettings = (endpoint, extra = {}) => ({
  provider: 'custom',
  apiEndpoint: endpoint,
  apiKey: '',
  modelName: 'llama3.2',
  targetLang: 'zh-CN',
  enableSelection: true,
  selectionTranslationMode: 'popup',
  ...extra,
});

/** Select the page heading and ask for its translation from the float ball. */
async function translateHeadingSelection(page) {
  await page.goto('https://example.com');
  await page.waitForSelector('#ai-translator-float-ball');

  const heading = await page.locator('h1').boundingBox();
  await page.mouse.move(heading.x + 2, heading.y + heading.height / 2);
  await page.mouse.down();
  await page.mouse.move(heading.x + heading.width - 2, heading.y + heading.height / 2, { steps: 12 });
  await page.mouse.up();

  await openFloatBallMenu(page);
  await page.click('.ai-translator-menu-item[data-action="translate-selection"]');
  return page.locator('.ai-translator-popup');
}

/** The card is on screen: visible, with a real size, and inside the viewport. */
async function expectCardOnScreen(page, card) {
  await expect(card).toBeVisible();
  const box = await card.boundingBox();
  const viewport = page.viewportSize();
  expect(box.width).toBeGreaterThan(0);
  expect(box.height).toBeGreaterThan(0);
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
}

const noAuth = { authorization: null, xApiKey: null };

test('J-A1: selection translation works against a local server with no key', async ({ page }) => {
  const mock = await startMockOpenAIServer();
  try {
    await setExtensionSettings(page, localSettings(mock.endpoint));

    const card = await translateHeadingSelection(page);
    await expect(card.locator('.ai-translator-translation-text')).toContainText('[T]');
    await expect(card.locator('.ai-translator-error')).toHaveCount(0);
    await expectCardOnScreen(page, card);

    // It really went to the server, and with no credentials at all: an empty
    // key must not turn into an empty `Bearer ` header.
    expect(mock.authHeaders.length).toBeGreaterThan(0);
    for (const headers of mock.authHeaders) expect(headers).toEqual(noAuth);
  } finally {
    await mock.close();
  }
});

test('J-A2: whole-page translation works against a local server with no key', async ({ page }) => {
  const mock = await startMockOpenAIServer();
  // Text no other run could have cached, so every block has to be asked for.
  const nonce = Math.random().toString(36).slice(2, 10);
  const paragraphs = [
    `Local probe one ${nonce}: a model on this machine needs no key.`,
    `Local probe two ${nonce}: nothing is sent to anyone else.`,
  ];
  try {
    await setExtensionSettings(page, localSettings(mock.endpoint, { skipTargetLanguageText: false }));
    await page.goto('https://example.com');
    await page.waitForSelector('#ai-translator-float-ball');
    await page.evaluate((texts) => {
      const container = document.createElement('div');
      container.id = 'local-probe';
      for (const text of texts) {
        const p = document.createElement('p');
        p.textContent = text;
        container.appendChild(p);
      }
      document.body.appendChild(container);
    }, paragraphs);

    await triggerPageTranslation(page);
    const translated = page.locator('#local-probe .ai-translator-inline-block');
    await expect(translated).toHaveCount(paragraphs.length, { timeout: 30000 });
    await expect(translated.first()).toContainText('[T]');
    await page.waitForSelector('#ai-translator-progress', { state: 'hidden', timeout: 30000 });

    expect(mock.authHeaders.length).toBeGreaterThan(0);
    for (const headers of mock.authHeaders) expect(headers).toEqual(noAuth);
  } finally {
    await mock.close();
  }
});

test('J-A3: a remote endpoint with no key is refused in the reader\'s language, and nothing is sent', async ({ page }) => {
  await setExtensionSettings(page, {
    provider: 'openai',
    apiEndpoint: 'https://api.openai.com/v1/chat/completions',
    apiKey: '',
    modelName: 'gpt-4.1-mini',
    targetLang: 'zh-CN',
    enableSelection: true,
    selectionTranslationMode: 'popup',
    uiLanguage: 'ja',
  });

  // A remote endpoint cannot be pointed at a mock, so the worker's own fetch
  // is watched instead: every URL it is asked for, from here on.
  const worker = await getServiceWorker(page.context());
  await worker.evaluate(() => {
    globalThis.__fetchedUrls = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      globalThis.__fetchedUrls.push(String(input && input.url ? input.url : input));
      return realFetch(input, init);
    };
  });

  const card = await translateHeadingSelection(page);
  const expected = getMessage('configureApiKeyFirst', 'ja');
  expect(expected).not.toBe('configureApiKeyFirst');
  await expect(card.locator('.ai-translator-error')).toHaveText(expected);
  await expectCardOnScreen(page, card);

  const fetched = await worker.evaluate(() => globalThis.__fetchedUrls);
  expect(fetched.filter((url) => url.includes('api.openai.com'))).toEqual([]);
});

test('J-A4: a local server that refuses the extension says how to let it in', async ({ page }) => {
  // Ollama's answer to an origin missing from OLLAMA_ORIGINS: 403, empty body.
  const mock = await startMockOpenAIServer({ status: 403 });
  try {
    await setExtensionSettings(page, localSettings(mock.endpoint));

    const card = await translateHeadingSelection(page);
    await expect(card.locator('.ai-translator-error')).toHaveText(en('apiErrorLocalRefused'));
    await expect(card.locator('.ai-translator-error')).toContainText('OLLAMA_ORIGINS=chrome-extension://*');
    await expect(card.locator('.ai-translator-error')).toContainText('lms server start --cors');
    await expectCardOnScreen(page, card);
    expect(mock.authHeaders.length).toBeGreaterThan(0);
  } finally {
    await mock.close();
  }
});

test('J-A5: a local server that is not running is named, with how to start it', async ({ page }) => {
  // A port that was just ours and now has nobody listening on it.
  const mock = await startMockOpenAIServer();
  const { endpoint } = mock;
  await mock.close();
  const origin = new URL(endpoint).origin;

  await setExtensionSettings(page, localSettings(endpoint));

  const card = await translateHeadingSelection(page);
  const expected = en('apiErrorLocalUnreachable').replace('{endpoint}', origin);
  await expect(card.locator('.ai-translator-error')).toHaveText(expected);
  await expect(card.locator('.ai-translator-error')).not.toContainText('{endpoint}');
  await expectCardOnScreen(page, card);
});

test('J-A6: the popup and the settings page both call a keyless local setup ready', async ({ context, extensionId }) => {
  const mock = await startMockOpenAIServer();
  try {
    const page = await context.newPage();
    await setExtensionSettings(page, localSettings(mock.endpoint));

    // The popup footer: not "API not configured".
    await page.goto(popupUrl(extensionId));
    const status = page.locator('#statusText');
    await expect(status).toHaveText(en('ready'));
    await expect(status).not.toHaveText(en('apiNotConfigured'));
    await expect(page.locator('body')).not.toHaveClass(/status-error/);

    // The settings page: the key box says it is optional here, and the
    // connection test goes through to the server instead of asking for a key.
    await page.goto(optionsUrl(extensionId));
    const apiKey = page.locator('#apiKey');
    await expect(apiKey).toHaveAttribute('placeholder', en('placeholderApiKeyOptional'));
    await expect(page.locator('#apiEndpoint')).toHaveValue(mock.endpoint);

    await page.click('#testConnection');
    await expect(page.locator('#statusMessage')).toContainText(en('connectionSuccess'), { timeout: 10000 });
    expect(mock.authHeaders.length).toBeGreaterThan(0);
    for (const headers of mock.authHeaders) expect(headers).toEqual(noAuth);

    // A remote preset asks for the key again.
    await page.selectOption('#provider', 'openai');
    await expect(apiKey).toHaveAttribute('placeholder', en('placeholderApiKey'));
  } finally {
    await mock.close();
  }
});
