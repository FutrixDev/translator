const { test, expect } = require('./fixtures');
const { setExtensionSettings, getSyncSetting, writeSyncSettings } = require('./helpers');

const html = `<!doctype html>
<html>
<head><meta charset="utf-8">
<style>
  #movie_player{position:relative;width:640px;height:360px;}
  .ytp-caption-window-container{position:absolute;inset:0;}
  .ytp-chrome-bottom{position:absolute;left:0;right:0;bottom:0;height:36px;}
  .ytp-right-controls{position:absolute;right:0;bottom:0;display:flex;}
</style>
</head>
<body>
  <div id="movie_player">
    <video id="video"></video>
    <div class="ytp-caption-window-container">
      <div class="ytp-caption-window">
        <span class="captions-text">Hello world</span>
      </div>
    </div>
    <div class="ytp-chrome-bottom">
      <div class="ytp-right-controls">
        <button class="ytp-settings-button ytp-button"></button>
        <button class="ytp-fullscreen-button ytp-button"></button>
      </div>
    </div>
  </div>
  <button class="ytp-subtitles-button" aria-pressed="true"></button>
</body>
</html>`;

// These tests are about the caption pipeline, not about engine selection, so
// they pin the backend to the mocked API. Left on the default the run would
// hinge on whether this machine happens to hold the browser's on-device
// language pack for the pair — a fresh profile does not, so it falls back to
// the API, but that is an accident of the profile and not something to assert
// through.
const BASE_SETTINGS = {
  targetLang: 'zh-CN',
  targetLangSetByUser: true,
  apiKey: 'sk-test',
  apiEndpoint: 'https://api.openai.com/v1/chat/completions',
  modelName: 'gpt-4.1-mini',
  enableYoutubeCaptionTranslation: true,
};

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
  await setExtensionSettings(page, BASE_SETTINGS);

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

  await expect(page.locator('#ai-translator-caption-overlay')).toContainText('你好世界');
});

test('skips translation when track language matches target', async ({ page, context }) => {
  let apiCalls = 0;

  await setExtensionSettings(page, { ...BASE_SETTINGS, targetLang: 'en' });

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
  await setExtensionSettings(page, BASE_SETTINGS);

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
    const el = document.querySelector('#ai-translator-caption-overlay');
    return el ? el.textContent : null;
  });
  expect(overlayText).toBeFalsy();
});

test('applies saved caption position, width and scale', async ({ page, context }) => {
  await setExtensionSettings(page, {
    ...BASE_SETTINGS,
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
  await expect(page.locator('#ai-translator-caption-overlay')).toContainText('你好世界');

  const layout = await page.evaluate(() => {
    const o = document.getElementById('ai-translator-caption-overlay');
    const b = o.querySelector('.ai-translator-caption-block');
    return {
      scale: o.style.getPropertyValue('--ai-caption-scale'),
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
  await setExtensionSettings(page, BASE_SETTINGS);

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
  await expect(page.locator('#ai-translator-caption-overlay')).toContainText('你好世界');

  // The caption box is interactive and exposes 8 resize handles.
  const block = page.locator('#ai-translator-caption-overlay .ai-translator-caption-block');
  await expect(block).toHaveCSS('pointer-events', 'auto');
  await expect(block).toHaveCSS('cursor', 'move');
  await expect(page.locator('#ai-translator-caption-overlay .ai-translator-caption-handle')).toHaveCount(8);

  // Drag the east (right-edge) handle outward to widen the box.
  await page.evaluate(() => {
    const c = document.querySelector('.ytp-caption-window-container').getBoundingClientRect();
    const b = document.querySelector('#ai-translator-caption-overlay .ai-translator-caption-block');
    const h = b.querySelector('.ai-cap-h-e');
    const bRect = b.getBoundingClientRect();
    const cx = c.left + c.width / 2;
    const cy = bRect.top + bRect.height / 2;
    h.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: cx + 30, clientY: cy, bubbles: true, cancelable: true }));
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: cx + 220, clientY: cy, bubbles: true, cancelable: true }));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });

  await expect.poll(async () => page.evaluate(() => {
    const b = document.querySelector('#ai-translator-caption-overlay .ai-translator-caption-block');
    return parseInt(b.style.width, 10) || 0;
  })).toBeGreaterThan(50);
});

test('close button dismisses captions and restores native for the video', async ({ page, context }) => {
  await setExtensionSettings(page, BASE_SETTINGS);

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

  const overlay = page.locator('#ai-translator-caption-overlay');
  await expect(overlay).toContainText('你好世界');
  await expect(overlay).toBeVisible();
  // native captions are hidden while our overlay is active
  await expect(page.locator('.ytp-caption-window-container')).toHaveClass(/ai-translator-hide-native/);

  // click the close (X) button
  await page.locator('#ai-translator-caption-overlay .ai-translator-caption-close').dispatchEvent('click');

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

// ---------------------------------------------------------------- F17
// The in-player control. Everything below drives the same fixture, so the
// helpers here set the page up once and then assert on the button and menu.

/** Load the fixture with routes in place and let the content script settle. */
async function openPlayer(page, context, settings) {
  await setExtensionSettings(page, settings);
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
}

/** Feed the player's captions in and advance the playhead onto the first cue. */
async function playCue(page) {
  await simulatePlayerTimedtext(page, 'en');
  await page.evaluate(() => {
    const v = document.querySelector('video');
    v.currentTime = 0.5;
    v.dispatchEvent(new Event('timeupdate'));
  });
}

// A1 — the provider hands back the leftmost slot in the player's right-hand
// cluster, and the button lands in it rather than floating over the picture.
test('the button docks into the player control bar, first in the right cluster', async ({ page, context }) => {
  await openPlayer(page, context, BASE_SETTINGS);

  await expect.poll(async () => page.evaluate(() => {
    const bar = document.querySelector('.ytp-right-controls');
    const first = bar && bar.firstElementChild;
    return !!first && first.classList.contains('ai-translator-caption-btn');
  })).toBe(true);

  // It wears the player's own button class, so it inherits that bar's sizing.
  await expect(page.locator('.ytp-right-controls > .ai-translator-caption-btn')).toHaveClass(/ytp-button/);
  // Docked means docked: no floating box over the video as well.
  await expect(page.locator('#ai-translator-caption-controls')).toHaveCount(0);
});

// The whole point of watching with the feature off: the button is how you
// turn it on, so it cannot itself depend on the feature being on.
test('the button is there with the feature off, and turns it on', async ({ page, context }) => {
  await openPlayer(page, context, { ...BASE_SETTINGS, enableYoutubeCaptionTranslation: false });

  const button = page.locator('#ai-translator-caption-btn');
  await expect(button).toHaveCount(1);

  await button.click();
  await page.locator('#ai-translator-caption-menu .ai-translator-caption-switch').click();

  await expect.poll(() => getSyncSetting(context, 'enableYoutubeCaptionTranslation')).toBe(true);
});

// A2 — the menu's five rows, in order, in the reader's language.
test('the menu lists the five rows in order', async ({ page, context }) => {
  await openPlayer(page, context, BASE_SETTINGS);
  await page.locator('#ai-translator-caption-btn').click();

  const menu = page.locator('#ai-translator-caption-menu');
  await expect(menu).toBeVisible();
  const labels = await menu.locator('[role="menuitem"] .ai-translator-caption-menu-label').allTextContents();
  expect(labels).toEqual([
    '开启字幕翻译',
    '字幕显示类型',
    '译文位置',
    '字幕样式',
    '不再显示该快捷方式',
  ]);
});

// A3 — a player reads a click on itself as play/pause and a key as a shortcut.
// Ours are neither, and the player must never see them.
test('clicking the button and the menu never reaches the player', async ({ page, context }) => {
  await openPlayer(page, context, BASE_SETTINGS);

  await page.evaluate(() => {
    window.__playerClicks = 0;
    const count = () => { window.__playerClicks += 1; };
    document.getElementById('movie_player').addEventListener('click', count);
    document.querySelector('video').addEventListener('click', count);
    document.querySelector('video').play = () => {};
  });

  const paused = await page.evaluate(() => document.querySelector('video').paused);
  await page.locator('#ai-translator-caption-btn').click();
  await page.locator('#ai-translator-caption-menu .ai-translator-caption-menu-item').first().click();

  expect(await page.evaluate(() => window.__playerClicks)).toBe(0);
  expect(await page.evaluate(() => document.querySelector('video').paused)).toBe(paused);
});

// A4 — the three display types, read off the lines that are actually on screen.
test('the display type decides which lines are drawn', async ({ page, context }) => {
  await openPlayer(page, context, BASE_SETTINGS);
  await playCue(page);

  const original = page.locator('#ai-translator-caption-overlay .ai-translator-caption-original');
  const translated = page.locator('#ai-translator-caption-overlay .ai-translator-caption-line');
  await expect(translated).toHaveText('你好世界');
  await expect(original).toBeVisible();

  const pick = async (mode) => {
    await page.locator('#ai-translator-caption-btn').click();
    await page.selectOption('#ai-translator-caption-menu .ai-translator-caption-select', mode);
    await page.keyboard.press('Escape');
  };

  await pick('translation');
  await expect(original).toBeHidden();
  await expect(translated).toBeVisible();

  // "Original only" hands the picture back to the player: our overlay goes
  // away and the native caption windows come back out of hiding.
  await pick('original');
  await expect(page.locator('#ai-translator-caption-overlay')).toBeHidden();
  await expect(page.locator('.ytp-caption-window-container')).not.toHaveClass(/ai-translator-hide-native/);

  await pick('bilingual');
  await expect(original).toBeVisible();
  await expect(translated).toBeVisible();
});

// A5 — position flips which line is on top, and it flips live: the setting is
// a CSS `order`, so the box under the pointer is never rebuilt.
test('the translation can be put above the original', async ({ page, context }) => {
  await openPlayer(page, context, { ...BASE_SETTINGS, captionTranslationPosition: 'above' });
  await playCue(page);

  const tops = () => page.evaluate(() => {
    const o = document.querySelector('#ai-translator-caption-overlay .ai-translator-caption-original');
    const t = document.querySelector('#ai-translator-caption-overlay .ai-translator-caption-line');
    return { original: o.getBoundingClientRect().top, translated: t.getBoundingClientRect().top };
  });

  await expect(page.locator('#ai-translator-caption-overlay .ai-translator-caption-line')).toHaveText('你好世界');
  const above = await tops();
  expect(above.translated).toBeLessThan(above.original);

  await writeSyncSettings(context, { captionTranslationPosition: 'below' });
  await expect.poll(async () => {
    const t = await tops();
    return t.translated > t.original;
  }).toBe(true);
});

// A7 — "don't show this again" takes the button off every player, and the
// options page switch brings it back without a reload.
test('hiding the shortcut removes the button, and restoring it brings it back', async ({ page, context }) => {
  await openPlayer(page, context, BASE_SETTINGS);
  await expect(page.locator('#ai-translator-caption-btn')).toHaveCount(1);

  await page.locator('#ai-translator-caption-btn').click();
  await page.locator('#ai-translator-caption-menu .ai-translator-caption-menu-item').last().click();
  await expect(page.locator('#ai-translator-caption-btn')).toHaveCount(0);

  await writeSyncSettings(context, { captionPlayerButton: true });
  await expect(page.locator('#ai-translator-caption-btn')).toHaveCount(1);
});
