/**
 * Image OCR — end to end, both engines.
 *
 * The feature is two steps and this spec keeps them apart, because that split
 * is the thing most easily broken by a later patch: step 1 recognises (locally
 * in the offscreen document, or with a vision model), step 2 is an ordinary
 * translation of the recognised text and is optional. So the local engine must
 * reach a popup with no vision request behind it, the vision engine must send
 * the image once and the *text* separately, and with the translate step off
 * neither engine may translate at all.
 *
 * Everything is real except the native context-menu click, which Playwright
 * cannot drive — the OCR_TRANSLATE_IMAGE message it would send is dispatched
 * directly instead, same as the comic spec.
 */
const http = require('node:http');
const zlib = require('node:zlib');
const { test, expect } = require('./fixtures');
const { setExtensionSettings, sendMessageToActiveTab } = require('./helpers');
const { startMockOpenAIServer } = require('./mock-openai-server');

// CRC-32 for PNG chunks; hand-rolled for the same runtime reason as the comic
// spec (zlib.crc32 needs Node 20.15/22.2).
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// A real PNG, solid colour: the worker sniffs nothing here, but the media type
// it fetches must be one the pass-through accepts or the spec would exercise
// the OffscreenCanvas rung instead of the direct one.
function makePng(width, height, [r, g, b]) {
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3);
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const p = row + 1 + x * 3;
      raw[p] = r; raw[p + 1] = g; raw[p + 2] = b;
    }
  }
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // 8 bits per channel
  ihdr[9] = 2;  // truecolour RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const SIGN_PNG = makePng(320, 120, [0xf0, 0xf0, 0xf0]);

const PAGE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>OCR</title></head>
<body style="margin:0">
  <img id="sign" src="/sign.png" width="320">
</body></html>`;

function startPageServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(PAGE_HTML);
      } else if (req.url === '/sign.png') {
        res.writeHead(200, { 'Content-Type': 'image/png' });
        res.end(SIGN_PNG);
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, origin: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

/**
 * Text the local engine has to read for itself. Drawn in the page rather than
 * hand-encoded here: a real font at a real size is what the engine was trained
 * on, and the result is a plain PNG data URL the worker can fetch like any
 * other image URL.
 */
async function drawTextImage(page, text) {
  return await page.evaluate((label) => {
    const canvas = document.createElement('canvas');
    canvas.width = 720;
    canvas.height = 200;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#000000';
    ctx.font = '110px serif';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, 40, canvas.height / 2);
    return canvas.toDataURL('image/png');
  }, text);
}

// The OCR round trip crosses the service worker twice (image fetch, then either
// the offscreen engine or a vision call); on a loaded machine the worker can
// wait tens of seconds for CPU, and the local engine also pays a one-off ~2s to
// start. So this spec gets a bigger test budget and the round-trip expects get
// 60s. A healthy machine is unaffected — expects return as soon as they pass.
test.describe.configure({ timeout: 180000 });

test.describe('image OCR', () => {
  let mock;
  let pageServer;

  const baseSettings = () => ({
    apiEndpoint: mock.endpoint,
    apiKey: 'test-key',
    modelName: 'gpt-4.1-mini',
    targetLang: 'zh-CN',
    targetLangSetByUser: true,
  });

  test.beforeEach(async ({ page }) => {
    mock = await startMockOpenAIServer();
    pageServer = await startPageServer();
    await setExtensionSettings(page, baseSettings());
  });

  test.afterEach(() => {
    mock?.server.close();
    pageServer?.server.close();
  });

  test('the local engine reads the image on-device, then the text is translated', async ({ page }) => {
    // The default engine, and the one thing no mock can stand in for: real
    // Tesseract, in the real offscreen document, over a real PNG.
    await page.goto(`${pageServer.origin}/`);
    await page.waitForSelector('#sign');
    const srcUrl = await drawTextImage(page, 'EXIT');

    await sendMessageToActiveTab(page, { type: 'OCR_TRANSLATE_IMAGE', srcUrl, targetLang: 'zh-CN' });

    const popup = page.locator('.ai-translator-popup');
    await expect(popup).toBeVisible({ timeout: 30000 });
    // Waits out engine start plus recognition.
    await expect(popup.locator('.ai-translator-text')).toContainText('EXIT', { timeout: 90000 });
    // Latin script, so the label names the language the heuristic settled on.
    // Language names are endonyms everywhere in the extension, so this one stays
    // "English" even though the surrounding UI is in Chinese.
    await expect(popup.locator('.ai-translator-label').first()).toContainText('原文 · English');
    // Step 2 ran, as an ordinary text translation — the mock's echo protocol,
    // not a vision reply.
    await expect(popup.locator('.ai-translator-translation-text')).toContainText('[T]', { timeout: 60000 });
    // The whole point of the local engine: nothing was billed to read it.
    expect(mock.visionRequests).toHaveLength(0);
  });

  test('the vision engine sends the image once, and the recognised text separately', async ({ page }) => {
    await setExtensionSettings(page, { ...baseSettings(), ocrEngine: 'vision' });
    await page.goto(`${pageServer.origin}/`);
    await page.waitForSelector('#sign');

    await sendMessageToActiveTab(page, {
      type: 'OCR_TRANSLATE_IMAGE',
      srcUrl: `${pageServer.origin}/sign.png`,
      targetLang: 'zh-CN',
    });

    const popup = page.locator('.ai-translator-popup');
    await expect(popup).toBeVisible({ timeout: 30000 });
    await expect(popup.locator('.ai-translator-text')).toContainText('HELLO WORLD', { timeout: 60000 });
    await expect(popup.locator('.ai-translator-label').first()).toContainText('原文 · English');
    await expect(popup.locator('.ai-translator-translation-text')).toContainText('[T] HELLO WORLD');
    await expect(popup.locator('.ai-translator-speak-source')).toBeVisible();
    await expect(popup.locator('.ai-translator-copy')).toBeVisible();

    // The image left the browser exactly once, as an OpenAI vision request:
    // text part first, then the data-URL image part, with the OCR system prompt.
    expect(mock.visionRequests).toHaveLength(1);
    expect(mock.visionRequests[0].partTypes).toEqual(['text', 'image_url']);
    expect(mock.visionRequests[0].imageUrlPrefix.startsWith('data:image/png;base64,')).toBe(true);
    expect(mock.visionRequests[0].systemPrompt).toContain('OCR');
    // And the translation was a second, image-free request — which is what lets
    // a free translator serve the vision path too.
    expect(mock.sentTexts).toContain('HELLO WORLD');
  });

  test('with the translate step off, the popup stops at the recognised text', async ({ page }) => {
    await setExtensionSettings(page, { ...baseSettings(), ocrEngine: 'vision', ocrTranslate: false });
    await page.goto(`${pageServer.origin}/`);
    await page.waitForSelector('#sign');

    await sendMessageToActiveTab(page, {
      type: 'OCR_TRANSLATE_IMAGE',
      srcUrl: `${pageServer.origin}/sign.png`,
      targetLang: 'zh-CN',
      // The real menu click reads ocrTranslate and puts it on the message; the
      // synthetic one has to carry it itself.
      translate: false,
    });

    const popup = page.locator('.ai-translator-popup');
    await expect(popup.locator('.ai-translator-text')).toContainText('HELLO WORLD', { timeout: 60000 });
    // Recognise-only is a finished state, not a half-drawn one: the translation
    // half is gone rather than sitting there empty.
    await expect(popup.locator('.ai-translator-result')).toBeHidden();
    // Give a step 2 that wrongly ran time to reach the server.
    await page.waitForTimeout(1000);
    expect(mock.sentTexts).not.toContain('HELLO WORLD');
  });

  test('an image that fails to load reports the localized error in the popup', async ({ page }) => {
    await page.goto(`${pageServer.origin}/`);
    await page.waitForSelector('#sign');

    await sendMessageToActiveTab(page, {
      type: 'OCR_TRANSLATE_IMAGE',
      srcUrl: `${pageServer.origin}/missing.png`,
      targetLang: 'zh-CN',
    });

    const popup = page.locator('.ai-translator-popup');
    await expect(popup).toBeVisible({ timeout: 30000 });
    // targetLang zh-CN drives the worker's message locale, so the failure copy
    // must come back in Chinese — this is the getMessage wiring, end to end.
    await expect(popup.locator('.ai-translator-error')).toContainText('图片加载失败', { timeout: 60000 });
    expect(mock.visionRequests).toHaveLength(0);
  });

  test('the switch actually gates the flow: off means no popup and no request', async ({ page }) => {
    // Set before goto so the content script loads with the flag already off.
    await setExtensionSettings(page, { ...baseSettings(), enableImageOcrTranslation: false });
    await page.goto(`${pageServer.origin}/`);
    await page.waitForSelector('#sign');

    await sendMessageToActiveTab(page, {
      type: 'OCR_TRANSLATE_IMAGE',
      srcUrl: `${pageServer.origin}/sign.png`,
      targetLang: 'zh-CN',
    });

    // Nothing should happen; give a wrongly-live flow time to render.
    await page.waitForTimeout(1000);
    await expect(page.locator('.ai-translator-popup')).toHaveCount(0);
    expect(mock.visionRequests).toHaveLength(0);
  });
});
