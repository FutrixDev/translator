/**
 * Image OCR — end to end, both engines.
 *
 * The feature is two steps and this spec keeps them apart, because that split
 * is the thing most easily broken by a later patch: step 1 recognises (locally
 * in the offscreen document, or with a vision model), step 2 is an ordinary
 * translation the user asks for with the popup's Translate button. Every real
 * entry point sends translate: false — recognise-first is the flow, not a
 * preference. So the local engine must reach a popup with no vision request
 * behind it, the vision engine must send the image once and the *text*
 * separately, and a recognise-first run may not translate at all.
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
// Displayed at its own size at the origin of the page, so a drag in client
// coordinates is a drag in image coordinates and the crop is checkable.
const WIDE_PNG = makePng(400, 100, [0xe8, 0xe8, 0xe8]);
// Big enough for the hover shortcut button (its threshold is 200×200 CSS px);
// the two images above are both under it, which the hover spec relies on.
const BIG_PNG = makePng(300, 300, [0xdd, 0xdd, 0xdd]);

const PAGE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>OCR</title></head>
<body style="margin:0">
  <img id="wide" src="/wide.png" width="400" height="100" style="display:block">
  <img id="sign" src="/sign.png" width="320">
  <img id="big" src="/big.png" width="300" height="300" style="display:block">
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
      } else if (req.url === '/wide.png') {
        res.writeHead(200, { 'Content-Type': 'image/png' });
        res.end(WIDE_PNG);
      } else if (req.url === '/big.png') {
        res.writeHead(200, { 'Content-Type': 'image/png' });
        res.end(BIG_PNG);
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
    // The one thing no mock can stand in for: real Tesseract, in the real
    // offscreen document, over a real PNG. Chosen explicitly — the default
    // engine is 'vision' now.
    await setExtensionSettings(page, { ...baseSettings(), ocrEngine: 'local' });
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

  test('oversized Chinese glyphs are rescaled and read correctly by the local engine', async ({ page }) => {
    // Regression for the 江雪 poem card: ~110px glyphs sit far above the
    // LSTM's comfort band, and before the scale-retry ladder chi_sim answered
    // Latin garbage which the popup then labelled English. The target language
    // is zh-CN, so the 'auto' plan runs chi_sim first — this exercises the
    // whole ladder: native pass, oversized verdict from the line boxes, and
    // the rescaled pass whose answer must win. Chosen explicitly — the
    // default engine is 'vision' now.
    await setExtensionSettings(page, { ...baseSettings(), ocrEngine: 'local' });
    await page.goto(`${pageServer.origin}/`);
    await page.waitForSelector('#sign');
    const srcUrl = await page.evaluate(() => {
      const lines = ['千山鸟飞绝，', '万径人踪灭。'];
      const canvas = document.createElement('canvas');
      canvas.width = 960;
      canvas.height = 400;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#000000';
      ctx.font = '110px serif';
      ctx.textBaseline = 'middle';
      lines.forEach((line, i) => ctx.fillText(line, 60, 110 + i * 180));
      return canvas.toDataURL('image/png');
    });

    await sendMessageToActiveTab(page, {
      type: 'OCR_TRANSLATE_IMAGE',
      srcUrl,
      targetLang: 'zh-CN',
      translate: false,
    });

    const popup = page.locator('.ai-translator-popup');
    await expect(popup).toBeVisible({ timeout: 30000 });
    // The ladder is up to three passes, so this gets the long budget. The
    // assertions are about the failure class, not every glyph: near-twin
    // characters (千/干, 鸟/乌) genuinely flip with the renderer's font
    // choices, so a full-sentence match would pin this test to one Chromium
    // build. What must never come back is the old behaviour — Latin garbage
    // presented as English.
    const text = popup.locator('.ai-translator-text');
    await expect(text).toContainText('万径人踪灭', { timeout: 120000 });
    await expect(text).not.toContainText(/[A-Za-z]{3,}/);
    // And the language followed the text: Han codepoints plus the chi_sim
    // hint, not the English the garbage used to be labelled as.
    await expect(popup.locator('.ai-translator-label').first()).toContainText('简体中文');
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
    await setExtensionSettings(page, { ...baseSettings(), ocrEngine: 'vision' });
    await page.goto(`${pageServer.origin}/`);
    await page.waitForSelector('#sign');

    await sendMessageToActiveTab(page, {
      type: 'OCR_TRANSLATE_IMAGE',
      srcUrl: `${pageServer.origin}/sign.png`,
      targetLang: 'zh-CN',
      // What the real menu click always sends now: recognise-first.
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

  test('the recognise-only popup offers a Translate button that runs step 2 on demand', async ({ page }) => {
    await setExtensionSettings(page, { ...baseSettings(), ocrEngine: 'vision' });
    await page.goto(`${pageServer.origin}/`);
    await page.waitForSelector('#sign');

    await sendMessageToActiveTab(page, {
      type: 'OCR_TRANSLATE_IMAGE',
      srcUrl: `${pageServer.origin}/sign.png`,
      targetLang: 'zh-CN',
      translate: false,
    });

    const popup = page.locator('.ai-translator-popup');
    await expect(popup.locator('.ai-translator-text')).toContainText('HELLO WORLD', { timeout: 60000 });
    // Recognise-only, but not a dead end: the button is the second step held
    // out, and nothing has been translated yet.
    const translateBtn = popup.locator('.ai-translator-translate-btn');
    await expect(translateBtn).toBeVisible();
    await expect(popup.locator('.ai-translator-result')).toBeHidden();
    expect(mock.sentTexts).not.toContain('HELLO WORLD');

    await translateBtn.click();

    // The click ran the ordinary translation path over the recognised text and
    // the popup became the bilingual view — button gone, both halves shown.
    await expect(popup.locator('.ai-translator-translation-text')).toContainText('[T] HELLO WORLD', { timeout: 60000 });
    await expect(popup.locator('.ai-translator-result')).toBeVisible();
    await expect(translateBtn).toBeHidden();
    expect(mock.sentTexts).toContain('HELLO WORLD');
  });

  test('the hover button appears on large images by default, and runs recognise-first', async ({ page }) => {
    // enableImageOcrHoverButton is deliberately NOT set: the button is the
    // flow's front door and must be there out of the box. The click lands on
    // the recognise-only popup — the same terminal state the menu click
    // reaches — with the Translate button as step 2.
    await setExtensionSettings(page, { ...baseSettings(), ocrEngine: 'vision' });
    await page.goto(`${pageServer.origin}/`);
    await page.waitForSelector('#big');

    const hoverBtn = page.locator('#ai-translator-ocr-hover-btn');
    await page.locator('#big').hover();
    await expect(hoverBtn).toBeVisible();

    // A 400×100 image is below the 200×200 threshold: moving there is the
    // mouseleave of #big, and no new button takes its place.
    await page.locator('#wide').hover();
    await expect(hoverBtn).toHaveCount(0);

    await page.locator('#big').hover();
    await expect(hoverBtn).toBeVisible();
    await hoverBtn.click();

    const popup = page.locator('.ai-translator-popup');
    await expect(popup.locator('.ai-translator-text')).toContainText('HELLO WORLD', { timeout: 60000 });
    await expect(popup.locator('.ai-translator-translate-btn')).toBeVisible();
    expect(mock.visionRequests).toHaveLength(1);
  });

  test('with the hover switch turned off, hovering shows no button', async ({ page }) => {
    await setExtensionSettings(page, { ...baseSettings(), enableImageOcrHoverButton: false });
    await page.goto(`${pageServer.origin}/`);
    await page.waitForSelector('#big');

    await page.locator('#big').hover();
    // Give a wrongly-live listener time to render one.
    await page.waitForTimeout(500);
    await expect(page.locator('#ai-translator-ocr-hover-btn')).toHaveCount(0);
  });

  test('multi-line text keeps its line structure in the popup', async ({ page }) => {
    // Selection results default to inline display, which needs a live DOM
    // selection; the popup path is the one the OCR flow shares.
    await setExtensionSettings(page, { ...baseSettings(), selectionTranslationMode: 'popup' });
    await page.goto(`${pageServer.origin}/`);
    await page.waitForSelector('#sign');

    // The OCR popup and the selection popup are the same surface
    // (showTranslationResult); SHOW_TRANSLATION is the shortest real path to
    // render it with multi-line content — a poem read out of an image.
    await sendMessageToActiveTab(page, {
      type: 'SHOW_TRANSLATION',
      text: '江雪\n千山鸟飞绝，\n万径人踪灭。',
      translation: 'River Snow\nNo birds over a thousand hills,\nNo footprints on ten thousand paths.',
    });

    const popup = page.locator('.ai-translator-popup');
    await expect(popup).toBeVisible({ timeout: 30000 });
    // innerText reflects rendering: if the popup collapsed the newlines, each
    // side would come back as one long line instead of three.
    const sourceLines = (await popup.locator('.ai-translator-text').innerText()).split('\n').filter(Boolean);
    const translationLines = (await popup.locator('.ai-translator-translation-text').innerText()).split('\n').filter(Boolean);
    expect(sourceLines).toHaveLength(3);
    expect(translationLines).toHaveLength(3);
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

  test('a drawn region is the only part of the image that is recognised', async ({ page }) => {
    // The picker is the one half of this feature that only the page can do, and
    // the proof is the picture the worker ends up sending: a crop is a
    // different image, and its shape says which rectangle was read.
    await setExtensionSettings(page, { ...baseSettings(), ocrEngine: 'vision' });
    await page.goto(`${pageServer.origin}/`);
    await page.waitForSelector('#wide');

    await sendMessageToActiveTab(page, {
      type: 'OCR_TRANSLATE_IMAGE',
      srcUrl: `${pageServer.origin}/wide.png`,
      targetLang: 'zh-CN',
      translate: false,
      selectRegion: true,
    });

    const picker = page.locator('#ai-translator-ocr-region');
    await expect(picker).toBeVisible({ timeout: 30000 });
    // The right half, inset from the edges: 200×80 of a 400×100 image.
    await page.mouse.move(200, 10);
    await page.mouse.down();
    await page.mouse.move(340, 60, { steps: 5 });
    await page.mouse.move(400, 90, { steps: 5 });
    await page.mouse.up();
    // The picker is a modal step: it goes away as soon as it has its answer.
    await expect(picker).toHaveCount(0);

    const popup = page.locator('.ai-translator-popup');
    await expect(popup.locator('.ai-translator-text')).toContainText('HELLO WORLD', { timeout: 60000 });

    expect(mock.visionRequests).toHaveLength(1);
    const sent = mock.visionRequests[0].imageSize;
    // Not the whole image (4:1) but the 200×80 rectangle that was drawn (2.5:1),
    // scaled up on the way out because a crop is small and both engines read
    // small type badly.
    expect(sent.width / sent.height).toBeGreaterThan(2.2);
    expect(sent.width / sent.height).toBeLessThan(2.8);
    expect(sent.width).toBeGreaterThan(400);
  });

  test('backing out of the picker recognises nothing at all', async ({ page }) => {
    // Escape is a real answer, not a failure: "the whole image" was the other
    // menu entry, so nothing should run and nothing should be billed.
    await setExtensionSettings(page, { ...baseSettings(), ocrEngine: 'vision' });
    await page.goto(`${pageServer.origin}/`);
    await page.waitForSelector('#wide');

    await sendMessageToActiveTab(page, {
      type: 'OCR_TRANSLATE_IMAGE',
      srcUrl: `${pageServer.origin}/wide.png`,
      targetLang: 'zh-CN',
      selectRegion: true,
    });

    const picker = page.locator('#ai-translator-ocr-region');
    await expect(picker).toBeVisible({ timeout: 30000 });
    await page.keyboard.press('Escape');
    await expect(picker).toHaveCount(0);

    await page.waitForTimeout(1000);
    await expect(page.locator('.ai-translator-popup')).toHaveCount(0);
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
