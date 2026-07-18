const { test, expect } = require('./fixtures');
const { setExtensionSettings } = require('./helpers');

const html = `<!doctype html>
<html>
<head><meta charset="utf-8">
<style>.ytp-caption-window-container{position:relative;width:640px;height:360px;}</style>
</head>
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

test('applies saved caption position, width and scale', async ({ page, context }) => {
  await setExtensionSettings(page, {
    targetLang: 'zh-CN',
    targetLangSetByUser: true,
    apiKey: 'sk-test',
    apiEndpoint: 'https://api.openai.com/v1/chat/completions',
    modelName: 'gpt-4.1-mini',
    enableYoutubeCaptionTranslation: true,
    youtubeCaptionPosXPct: 30,
    youtubeCaptionPosYPct: 40,
    youtubeCaptionWidthPct: 60,
    youtubeCaptionScale: 1.5,
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
  await page.waitForTimeout(500);
  await simulatePlayerTimedtext(page, 'en');
  await page.evaluate(() => {
    const v = document.querySelector('video');
    v.currentTime = 0.5;
    v.dispatchEvent(new Event('timeupdate'));
  });
  await expect(page.locator('#ai-translator-youtube-caption-overlay')).toContainText('你好世界');

  const layout = await page.evaluate(() => {
    const o = document.getElementById('ai-translator-youtube-caption-overlay');
    const b = o.querySelector('.ai-translator-caption-block');
    return {
      scale: o.style.getPropertyValue('--ai-yt-caption-scale'),
      left: b.style.left,
      top: b.style.top,
      width: b.style.width,
    };
  });
  expect(layout.scale).toBe('1.5');
  expect(layout.left).toBe('30%');
  expect(layout.top).toBe('40%');
  expect(layout.width).toBe('60%');
});

test('resizing via the edge handle changes the caption width', async ({ page, context }) => {
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
  await page.waitForTimeout(500);
  await simulatePlayerTimedtext(page, 'en');
  await page.evaluate(() => {
    const v = document.querySelector('video');
    v.currentTime = 0.5;
    v.dispatchEvent(new Event('timeupdate'));
  });
  await expect(page.locator('#ai-translator-youtube-caption-overlay')).toContainText('你好世界');

  // The caption box is interactive and exposes 8 resize handles.
  const block = page.locator('#ai-translator-youtube-caption-overlay .ai-translator-caption-block');
  await expect(block).toHaveCSS('pointer-events', 'auto');
  await expect(block).toHaveCSS('cursor', 'move');
  await expect(page.locator('#ai-translator-youtube-caption-overlay .ai-translator-caption-handle')).toHaveCount(8);

  // Drag the east (right-edge) handle outward to widen the box.
  await page.evaluate(() => {
    const c = document.querySelector('.ytp-caption-window-container').getBoundingClientRect();
    const b = document.querySelector('#ai-translator-youtube-caption-overlay .ai-translator-caption-block');
    const h = b.querySelector('.ai-cap-h-e');
    const bRect = b.getBoundingClientRect();
    const cx = c.left + c.width / 2;
    const cy = bRect.top + bRect.height / 2;
    h.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: cx + 30, clientY: cy, bubbles: true, cancelable: true }));
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: cx + 220, clientY: cy, bubbles: true, cancelable: true }));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });

  await expect.poll(async () => page.evaluate(() => {
    const b = document.querySelector('#ai-translator-youtube-caption-overlay .ai-translator-caption-block');
    return parseInt(b.style.width, 10) || 0;
  })).toBeGreaterThan(50);
});

test('close button dismisses captions and restores native for the video', async ({ page, context }) => {
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
  await page.waitForTimeout(500);
  await simulatePlayerTimedtext(page, 'en');
  await page.evaluate(() => {
    const v = document.querySelector('video');
    v.currentTime = 0.5;
    v.dispatchEvent(new Event('timeupdate'));
  });

  const overlay = page.locator('#ai-translator-youtube-caption-overlay');
  await expect(overlay).toContainText('你好世界');
  await expect(overlay).toBeVisible();
  // native captions are hidden while our overlay is active
  await expect(page.locator('.ytp-caption-window-container')).toHaveClass(/ai-translator-hide-native/);

  // click the close (X) button
  await page.locator('#ai-translator-youtube-caption-overlay .ai-translator-caption-close').dispatchEvent('click');

  await expect(overlay).toBeHidden();
  // native captions restored (our override removed)
  await expect(page.locator('.ytp-caption-window-container')).not.toHaveClass(/ai-translator-hide-native/);

  // stays dismissed after further playback
  await page.evaluate(() => {
    const v = document.querySelector('video');
    v.currentTime = 1.2;
    v.dispatchEvent(new Event('timeupdate'));
  });
  await page.waitForTimeout(300);
  await expect(overlay).toBeHidden();
});
