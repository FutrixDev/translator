const { test, expect } = require('./fixtures');
const { setExtensionSettings } = require('./helpers');

const html = `<!doctype html>
<html>
<head><meta charset="utf-8"></head>
<body>
  <div class="ytp-caption-window-container">
    <div class="ytp-caption-window">
      <span class="captions-text">Hello world</span>
    </div>
  </div>
  <button class="ytp-subtitles-button" aria-pressed="true"></button>
  <video id="video"></video>
</body>
</html>`;

const timedtextBody = JSON.stringify({
  events: [{ tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: 'Hello world' }] }],
});

// The real YouTube player is the only party that can fetch /api/timedtext (its
// request carries a valid proof-of-origin token). The extension observes that
// request via a MAIN-world interceptor. In tests there is no player, so we
// reproduce the player's XHR from the page to exercise the same capture path.
async function simulatePlayerTimedtext(page, lang) {
  await page.evaluate((l) => new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', `https://www.youtube.com/api/timedtext?fmt=json3&v=abc123&lang=${l}&pot=TESTPOT`);
    xhr.onload = () => resolve();
    xhr.onerror = () => resolve();
    xhr.send();
  }), lang);
}

test('renders translated line when captions on and language differs', async ({ page, context }) => {
  await setExtensionSettings(page, {
    targetLang: 'zh-CN',
    targetLangSetByUser: true,
    apiKey: 'sk-test',
    apiEndpoint: 'https://api.openai.com/v1/chat/completions',
    modelName: 'gpt-4.1-mini',
    enableYoutubeCaptionTranslation: true,
  });

  await context.route('https://www.youtube.com/watch**', (route) => {
    route.fulfill({ status: 200, contentType: 'text/html', body: html });
  });

  await context.route('https://www.youtube.com/api/timedtext**', (route) => {
    route.fulfill({ status: 200, contentType: 'application/json', body: timedtextBody });
  });

  await context.route('https://api.openai.com/**', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ choices: [{ message: { content: '你好世界' } }] }),
    });
  });

  await page.goto('https://www.youtube.com/watch?v=abc123');
  // Let the content script initialize and attach its capture listener.
  await page.waitForTimeout(500);
  await simulatePlayerTimedtext(page, 'en');

  await page.evaluate(() => {
    const video = document.querySelector('video');
    video.currentTime = 0.5;
    video.dispatchEvent(new Event('timeupdate'));
  });

  await expect(page.locator('#ai-translator-youtube-caption-overlay')).toContainText('你好世界');
});

test('skips translation when track language matches target', async ({ page, context }) => {
  let apiCalls = 0;

  await setExtensionSettings(page, {
    targetLang: 'en',
    targetLangSetByUser: true,
    apiKey: 'sk-test',
    apiEndpoint: 'https://api.openai.com/v1/chat/completions',
    modelName: 'gpt-4.1-mini',
    enableYoutubeCaptionTranslation: true,
  });

  await context.route('https://www.youtube.com/watch**', (route) => {
    route.fulfill({ status: 200, contentType: 'text/html', body: html });
  });

  await context.route('https://www.youtube.com/api/timedtext**', (route) => {
    route.fulfill({ status: 200, contentType: 'application/json', body: timedtextBody });
  });

  await context.route('https://api.openai.com/**', (route) => {
    apiCalls += 1;
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ choices: [{ message: { content: 'ignored' } }] }),
    });
  });

  await page.goto('https://www.youtube.com/watch?v=abc123');
  await page.waitForTimeout(500);
  await simulatePlayerTimedtext(page, 'en');

  await page.evaluate(() => {
    const video = document.querySelector('video');
    video.currentTime = 0.5;
    video.dispatchEvent(new Event('timeupdate'));
  });
  await page.waitForTimeout(1000);

  expect(apiCalls).toBe(0);
});

test('does not render when no caption request is observed', async ({ page, context }) => {
  await setExtensionSettings(page, {
    targetLang: 'zh-CN',
    targetLangSetByUser: true,
    apiKey: 'sk-test',
    apiEndpoint: 'https://api.openai.com/v1/chat/completions',
    modelName: 'gpt-4.1-mini',
    enableYoutubeCaptionTranslation: true,
  });

  await context.route('https://www.youtube.com/watch**', (route) => {
    route.fulfill({ status: 200, contentType: 'text/html', body: html });
  });

  await page.goto('https://www.youtube.com/watch?v=abc123');
  await page.waitForTimeout(800);

  await page.evaluate(() => {
    const video = document.querySelector('video');
    video.currentTime = 0.5;
    video.dispatchEvent(new Event('timeupdate'));
  });
  await page.waitForTimeout(300);

  // With no observed timedtext response there are no cues, so no overlay text.
  const overlayText = await page.evaluate(() => {
    const el = document.querySelector('#ai-translator-youtube-caption-overlay');
    return el ? el.textContent : null;
  });
  expect(overlayText).toBeFalsy();
});
