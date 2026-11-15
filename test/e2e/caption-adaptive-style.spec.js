// What a caption looks like before the viewer has touched anything: sized for
// the box the video occupies, placed on the player's own caption line, and
// drawn with no plate behind it.
//
// The size rule is the page's own — YouTube sets its captions at 1/22.5 of the
// player's height at every player size — so a translated line reads at the
// size the viewer was already reading. The fixture player is 640x360 with a
// 36px control bar; the numbers below follow from those.
const { test, expect } = require('./fixtures');
const { setExtensionSettings } = require('./helpers');
const { html, BASE_SETTINGS, openPlayer, playCue } = require('./youtube-caption-fixtures');

const OVERLAY = '#ai-translator-caption-overlay';

/** Font sizes, paint and where the block sits inside the player, in px. */
async function readCaption(page) {
  return page.evaluate(() => {
    const overlay = document.querySelector('#ai-translator-caption-overlay');
    const block = overlay.querySelector('.ai-translator-caption-block');
    const original = overlay.querySelector('.ai-translator-caption-original');
    const translated = overlay.querySelector('.ai-translator-caption-line');
    const frame = overlay.getBoundingClientRect();
    const box = block.getBoundingClientRect();
    const px = (el) => parseFloat(getComputedStyle(el).fontSize);
    return {
      translatedPx: px(translated),
      originalPx: px(original),
      plate: getComputedStyle(block).backgroundColor,
      color: getComputedStyle(translated).color,
      translatedEdge: getComputedStyle(translated).textShadow,
      originalEdge: getComputedStyle(original).textShadow,
      frameHeight: frame.height,
      gapBelow: frame.bottom - box.bottom,
      centre: (box.left + box.right) / 2 - (frame.left + frame.right) / 2,
    };
  });
}

/** Resize the fixture player the way theater mode or a window resize does. */
async function resizePlayer(page, width, height) {
  await page.evaluate(([w, h]) => {
    const player = document.querySelector('#movie_player');
    player.style.width = `${w}px`;
    player.style.height = `${h}px`;
  }, [width, height]);
}

/** One more frame of playback: the beat on which the engine re-reads the player. */
async function tick(page) {
  await page.evaluate(() => {
    document.querySelector('video').dispatchEvent(new Event('timeupdate'));
  });
}

async function showCaption(page, context, settings = BASE_SETTINGS, body = html) {
  await openPlayer(page, context, settings, body);
  await playCue(page);
  await expect(page.locator(`${OVERLAY} .ai-translator-caption-line`)).toHaveText('你好世界');
}

test('an untouched caption is the size the player gives its own, with no plate', async ({ page, context }) => {
  await showCaption(page, context);

  const caption = await readCaption(page);
  // 360 / 22.5
  expect(caption.translatedPx).toBeCloseTo(16, 1);
  expect(caption.originalPx).toBeCloseTo(12.8, 1);
  expect(caption.plate).toBe('rgba(8, 8, 8, 0)');
  expect(caption.color).toBe('rgb(255, 255, 255)');
  // With no plate, the edge is all that separates the text from the picture.
  expect(caption.translatedEdge).toContain('rgba(0, 0, 0');
  expect(caption.originalEdge).toContain('rgba(0, 0, 0');
  expect(Math.abs(caption.centre)).toBeLessThan(1);
});

test('the caption grows with the player, with nothing playing', async ({ page, context }) => {
  await showCaption(page, context);
  expect((await readCaption(page)).translatedPx).toBeCloseTo(16, 1);

  // No timeupdate from here on: a paused video going into theater mode or
  // fullscreen has to be noticed from the box itself.
  await resizePlayer(page, 1280, 720);
  await expect.poll(async () => (await readCaption(page)).translatedPx).toBeCloseTo(32, 1);
  expect((await readCaption(page)).originalPx).toBeCloseTo(25.6, 1);

  await resizePlayer(page, 320, 180);
  // 180 / 22.5 is 8px; the floor keeps it readable.
  await expect.poll(async () => (await readCaption(page)).translatedPx).toBeCloseTo(14, 1);
});

test('a box taller than the picture is sized by the picture', async ({ page, context }) => {
  await showCaption(page, context);
  // A 16:9 picture letterboxed in a 1280x1600 box is 1280x720: 32px. Sized by
  // the box's height it would be 71px.
  await resizePlayer(page, 1280, 1600);
  await expect.poll(async () => (await readCaption(page)).translatedPx).toBeCloseTo(32, 1);
});

test('the control bar measured is the one in the player the caption sits in', async ({ page, context }) => {
  // A second player earlier in the document, with a much taller bar.
  const twoPlayers = html.replace('<div id="movie_player"', `<div class="html5-video-player" style="position:relative;width:640px;height:360px;">
    <div class="ytp-chrome-bottom" style="height:200px;"></div>
  </div>
  <div id="movie_player"`);
  await showCaption(page, context, BASE_SETTINGS, twoPlayers);
  await expect.poll(async () => (await readCaption(page)).gapBelow).toBeCloseTo(44, 0);
});

test('on a small player the caption steps up exactly clear of the control bar', async ({ page, context }) => {
  await showCaption(page, context);

  // Bar showing: 36px of bar plus half a line (8px) of air.
  await expect.poll(async () => (await readCaption(page)).gapBelow).toBeCloseTo(44, 0);

  // Bar hidden: back on the caption line, 8% of 360.
  await page.evaluate(() => document.querySelector('#movie_player').classList.add('ytp-autohide'));
  await tick(page);
  await expect.poll(async () => (await readCaption(page)).gapBelow).toBeCloseTo(28.8, 0);
});

test('on a large player the caption line already clears the bar, so nothing moves', async ({ page, context }) => {
  await showCaption(page, context);
  await resizePlayer(page, 1280, 720);
  // 8% of 720 is 57.6px, above the 36px bar plus half a 32px line.
  await expect.poll(async () => (await readCaption(page)).gapBelow).toBeCloseTo(57.6, 0);

  await page.evaluate(() => document.querySelector('#movie_player').classList.add('ytp-autohide'));
  await tick(page);
  await page.waitForTimeout(300);
  expect((await readCaption(page)).gapBelow).toBeCloseTo(57.6, 0);
});

test('a control bar of any height is cleared, not a fixed guess', async ({ page, context }) => {
  // Fullscreen and newer player skins draw a taller bar.
  const tallBar = html.replace('bottom:0;height:36px;', 'bottom:0;height:72px;');
  await showCaption(page, context, BASE_SETTINGS, tallBar);
  await expect.poll(async () => (await readCaption(page)).gapBelow).toBeCloseTo(80, 0);
});

test("the viewer's own scale multiplies the adaptive size", async ({ page, context }) => {
  await showCaption(page, context, { ...BASE_SETTINGS, youtubeCaptionScale: 1.5 });
  expect((await readCaption(page)).translatedPx).toBeCloseTo(24, 1);

  await resizePlayer(page, 1280, 720);
  await expect.poll(async () => (await readCaption(page)).translatedPx).toBeCloseTo(48, 1);
});

test('a plate the viewer has asked for is still drawn', async ({ page, context }) => {
  await showCaption(page, context, {
    ...BASE_SETTINGS,
    youtubeCaptionBgColor: '#102030',
    youtubeCaptionBgOpacity: 82,
  });
  expect((await readCaption(page)).plate).toBe('rgba(16, 32, 48, 0.82)');
});

test('a plain <video> is sized from its own box', async ({ page, context }) => {
  const origin = 'https://video.test';
  const doc = (height) => `<!doctype html><html><head><meta charset="utf-8"><style>
    body { margin: 0; }
    video { width: ${height * 16 / 9}px; height: ${height}px; background: #123; }
  </style></head><body>
    <video id="v">
      <track default kind="subtitles" srclang="en" label="English" src="/subs.vtt">
    </video>
  </body></html>`;

  await setExtensionSettings(page, BASE_SETTINGS);
  await context.route(`${origin}/page.html`, (route) => {
    route.fulfill({ status: 200, contentType: 'text/html', body: doc(540) });
  });
  await context.route(`${origin}/subs.vtt`, (route) => {
    route.fulfill({
      status: 200,
      contentType: 'text/vtt',
      body: 'WEBVTT\n\n00:00:00.000 --> 00:00:04.000\nHello world\n',
    });
  });
  await context.route('https://api.openai.com/**', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ choices: [{ message: { content: '你好世界' } }] }),
    });
  });

  await page.goto(`${origin}/page.html`);
  await page.evaluate(() => {
    const video = document.querySelector('video');
    video.currentTime = 1;
    video.dispatchEvent(new Event('timeupdate'));
  });
  await expect(page.locator(`${OVERLAY} .ai-translator-caption-line`)).toHaveText('你好世界');

  const caption = await readCaption(page);
  // 540 / 22.5
  expect(caption.translatedPx).toBeCloseTo(24, 1);
  expect(caption.plate).toBe('rgba(8, 8, 8, 0)');
  // No player chrome to measure: 6% up from the bottom edge.
  expect(caption.gapBelow).toBeCloseTo(540 * 0.06, 0);
});

test('the settings page shows the same untouched caption: no plate, 0%', async ({ page, extensionId }) => {
  await page.goto(`chrome-extension://${extensionId}/options/options.html`);
  await expect(page.locator('#youtubeCaptionBgOpacityValue')).toHaveText('0%', { timeout: 15000 });
  await expect(page.locator('#youtubeCaptionBgOpacity')).toHaveValue('0');
  await expect(page.locator('#youtubeCaptionFontColor')).toHaveValue('#ffffff');
  await expect(page.locator('#youtubeCaptionBgColor')).toHaveValue('#080808');

  const preview = await page.evaluate(() => {
    const block = document.querySelector('#youtubeCaptionPreview .caption-preview-block');
    const line = block.querySelector('.caption-preview-translated');
    return {
      plate: getComputedStyle(block).backgroundColor,
      color: getComputedStyle(line).color,
      edge: getComputedStyle(line).textShadow,
    };
  });
  expect(preview.plate).toBe('rgba(8, 8, 8, 0)');
  expect(preview.color).toBe('rgb(255, 255, 255)');
  expect(preview.edge).toContain('rgba(0, 0, 0');
});
