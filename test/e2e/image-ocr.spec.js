/**
 * Image OCR translation — end-to-end against the mock chat-completions server.
 *
 * The right-click flow: the service worker fetches the image, base64s it into a
 * vision request, and the content script shows the extracted text + translation
 * in the standard popup. Everything is real except the native context-menu
 * click, which Playwright cannot drive — the OCR_TRANSLATE_IMAGE message it
 * would send is dispatched directly instead, same as the comic spec.
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

// The OCR round trip crosses the service worker twice (image fetch, vision
// call); on a loaded machine the worker can wait tens of seconds for CPU, so
// this spec gets a bigger test budget and the round-trip expects get 60s. A
// healthy machine is unaffected — expects return as soon as they pass.
test.describe.configure({ timeout: 180000 });

test.describe('image OCR translation', () => {
  let mock;
  let pageServer;

  test.beforeEach(async ({ page }) => {
    mock = await startMockOpenAIServer();
    pageServer = await startPageServer();
    await setExtensionSettings(page, {
      apiEndpoint: mock.endpoint,
      apiKey: 'test-key',
      modelName: 'gpt-4.1-mini',
      targetLang: 'zh-CN',
      targetLangSetByUser: true,
    });
  });

  test.afterEach(() => {
    mock?.server.close();
    pageServer?.server.close();
  });

  test('right-click OCR shows extracted text, detected language, and translation', async ({ page }) => {
    await page.goto(`${pageServer.origin}/`);
    await page.waitForSelector('#sign');

    await sendMessageToActiveTab(page, {
      type: 'OCR_TRANSLATE_IMAGE',
      srcUrl: `${pageServer.origin}/sign.png`,
      targetLang: 'zh-CN',
    });

    const popup = page.locator('.ai-translator-popup');
    await expect(popup).toBeVisible({ timeout: 30000 });

    // The finished popup is the standard one: extracted text in the source
    // slot, the detected-language line where a phonetic would sit, the
    // translation below, and the speech/copy controls wired. The first expect
    // waits out the whole round trip.
    await expect(popup.locator('.ai-translator-text')).toContainText('HELLO WORLD', { timeout: 60000 });
    await expect(popup.locator('.ai-translator-translation-text')).toContainText('你好，世界');
    await expect(popup.locator('.ai-translator-phonetic')).toContainText('英语');
    await expect(popup.locator('.ai-translator-speak-source')).toBeVisible();
    await expect(popup.locator('.ai-translator-copy')).toBeVisible();

    // The image itself must have left the browser as an OpenAI vision request:
    // text part first, then the data-URL image part, with the OCR system prompt.
    expect(mock.visionRequests).toHaveLength(1);
    expect(mock.visionRequests[0].partTypes).toEqual(['text', 'image_url']);
    expect(mock.visionRequests[0].imageUrlPrefix.startsWith('data:image/png;base64,')).toBe(true);
    expect(mock.visionRequests[0].systemPrompt).toContain('OCR');
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
    await setExtensionSettings(page, {
      apiEndpoint: mock.endpoint,
      apiKey: 'test-key',
      modelName: 'gpt-4.1-mini',
      targetLang: 'zh-CN',
      targetLangSetByUser: true,
      enableImageOcrTranslation: false,
    });
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
