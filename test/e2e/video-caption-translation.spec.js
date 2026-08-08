// The generic side of caption translation: any page whose <video> exposes
// subtitle cues through the standard TextTrack API, with no per-site code.
//
// The YouTube half is covered separately in youtube-caption-translation.spec.js
// — it goes through a provider that observes the player's network traffic,
// where this one reads cues the browser has already parsed.
const { test, expect } = require('./fixtures');
const { setExtensionSettings } = require('./helpers');

const ORIGIN = 'https://video.test';

// Pinned to the mocked API for the same reason the YouTube spec is: this is a
// test about captions, not about which translation backend gets picked.
const BASE_SETTINGS = {
  targetLang: 'zh-CN',
  targetLangSetByUser: true,
  apiKey: 'sk-test',
  apiEndpoint: 'https://api.openai.com/v1/chat/completions',
  modelName: 'gpt-4.1-mini',
  enableYoutubeCaptionTranslation: true,
  translationEngine: 'ai',
};

const VTT = `WEBVTT

00:00:00.000 --> 00:00:04.000
Hello world

00:00:05.000 --> 00:00:09.000
A second line.
`;

// A Chinese track, to check we do not translate into the language we are
// already reading.
const VTT_ZH = `WEBVTT

00:00:00.000 --> 00:00:04.000
你好世界
`;

function page(body, head = '') {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body { margin: 0; }
    video { width: 640px; height: 360px; background: #123; }
  </style>${head}</head><body>${body}</body></html>`;
}

const WITH_TRACK = page(`
  <video id="v" width="640" height="360">
    <track id="t" default kind="subtitles" srclang="en" label="English" src="/subs.vtt">
  </video>`);

const NO_TRACK = page('<video id="v" width="640" height="360"></video>');

const TWO_TRACKS = page(`
  <video id="v" width="640" height="360">
    <track kind="subtitles" srclang="zh" label="中文" src="/subs-zh.vtt">
    <track default kind="subtitles" srclang="en" label="English" src="/subs.vtt">
  </video>`);

/**
 * Serve the fixture page plus its subtitle files from one origin, so the
 * <track> is same-origin and the browser will actually parse it.
 */
async function serve(context, html) {
  await context.route(`${ORIGIN}/page.html`, (route) => {
    route.fulfill({ status: 200, contentType: 'text/html', body: html });
  });
  await context.route(`${ORIGIN}/subs.vtt`, (route) => {
    route.fulfill({ status: 200, contentType: 'text/vtt', body: VTT });
  });
  await context.route(`${ORIGIN}/subs-zh.vtt`, (route) => {
    route.fulfill({ status: 200, contentType: 'text/vtt', body: VTT_ZH });
  });
}

async function mockTranslation(context, onCall) {
  await context.route('https://api.openai.com/**', (route) => {
    if (onCall) onCall(route.request().postDataJSON());
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ choices: [{ message: { content: '你好世界' } }] }),
    });
  });
}

/** Put the playhead inside the first cue. */
async function seekIntoFirstCue(p) {
  await p.evaluate(() => {
    const video = document.querySelector('video');
    video.currentTime = 1;
    video.dispatchEvent(new Event('timeupdate'));
  });
}

test('translates a plain <video> with a <track>, with no site-specific code', async ({ page: p, context }) => {
  await setExtensionSettings(p, BASE_SETTINGS);
  await serve(context, WITH_TRACK);
  await mockTranslation(context);

  await p.goto(`${ORIGIN}/page.html`);
  await seekIntoFirstCue(p);

  const overlay = p.locator('#ai-translator-caption-overlay');
  await expect(overlay).toContainText('你好世界');
  // Bilingual: the original line stays above the translation.
  await expect(overlay).toContainText('Hello world');
});

test('the page keeps its own captions off screen while ours are up', async ({ page: p, context }) => {
  await setExtensionSettings(p, BASE_SETTINGS);
  await serve(context, WITH_TRACK);
  await mockTranslation(context);

  await p.goto(`${ORIGIN}/page.html`);
  await seekIntoFirstCue(p);
  await expect(p.locator('#ai-translator-caption-overlay')).toContainText('你好世界');

  // 'hidden' — not 'disabled'. The cues have to keep loading and firing; it is
  // only the browser's own rendering of them we are turning off.
  const mode = await p.evaluate(() => document.querySelector('video').textTracks[0].mode);
  expect(mode).toBe('hidden');
});

test('the overlay is anchored to the video box, not to the page', async ({ page: p, context }) => {
  await setExtensionSettings(p, BASE_SETTINGS);
  // Push the video down and give the page room to scroll under it.
  await serve(context, page(`
    <div style="height:300px"></div>
    <video id="v" width="640" height="360">
      <track default kind="subtitles" srclang="en" label="English" src="/subs.vtt">
    </video>
    <div style="height:2000px"></div>`));
  await mockTranslation(context);

  await p.goto(`${ORIGIN}/page.html`);
  await seekIntoFirstCue(p);
  await expect(p.locator('#ai-translator-caption-overlay')).toContainText('你好世界');

  const boxes = () => p.evaluate(() => {
    const host = document.querySelector('.ai-translator-caption-host');
    const video = document.querySelector('video');
    const h = host.getBoundingClientRect();
    const v = video.getBoundingClientRect();
    return { host: { top: h.top, left: h.left, w: h.width, h: h.height }, video: { top: v.top, left: v.left, w: v.width, h: v.height } };
  });

  const before = await boxes();
  expect(Math.abs(before.host.top - before.video.top)).toBeLessThan(2);
  expect(Math.abs(before.host.left - before.video.left)).toBeLessThan(2);
  expect(Math.abs(before.host.w - before.video.w)).toBeLessThan(2);
  expect(Math.abs(before.host.h - before.video.h)).toBeLessThan(2);

  // The host is fixed-position, so it only stays on the video because we keep
  // moving it there. Scrolling is the cheapest way to prove that we do.
  await p.evaluate(() => window.scrollTo(0, 200));
  await p.waitForTimeout(200);
  const after = await boxes();
  expect(after.video.top).toBeLessThan(before.video.top);
  expect(Math.abs(after.host.top - after.video.top)).toBeLessThan(2);
});

test('a <track> added after load still gets picked up', async ({ page: p, context }) => {
  await setExtensionSettings(p, BASE_SETTINGS);
  await serve(context, NO_TRACK);
  await mockTranslation(context);

  await p.goto(`${ORIGIN}/page.html`);
  // Nothing to translate yet: no track, so no overlay text.
  await p.waitForTimeout(500);
  await seekIntoFirstCue(p);
  await expect(p.locator('#ai-translator-caption-overlay')).toHaveCount(0);

  // A player that fetches its subtitle list and only then adds the element —
  // the common shape for a JS player.
  await p.evaluate(() => {
    const el = document.createElement('track');
    el.kind = 'subtitles';
    el.srclang = 'en';
    el.label = 'English';
    el.default = true;
    el.src = '/subs.vtt';
    document.querySelector('video').appendChild(el);
  });
  await p.evaluate(() => document.querySelector('video').dispatchEvent(new Event('loadedmetadata')));
  await seekIntoFirstCue(p);

  await expect(p.locator('#ai-translator-caption-overlay')).toContainText('你好世界');
});

test('the track language travels with the request, so nothing has to guess it', async ({ page: p, context }) => {
  // A caption line is a handful of words — too short to identify. Left to
  // detection it falls back to the language of the *page*, which describes the
  // interface and not the audio.
  let sent = null;
  await setExtensionSettings(p, BASE_SETTINGS);
  await serve(context, WITH_TRACK);
  await mockTranslation(context, (body) => { sent = body; });

  await p.goto(`${ORIGIN}/page.html`);
  await seekIntoFirstCue(p);
  await expect(p.locator('#ai-translator-caption-overlay')).toContainText('你好世界');

  expect(sent).toBeTruthy();
  expect(JSON.stringify(sent)).toContain('Hello world');
});

test('a track already in the reader language is left alone', async ({ page: p, context }) => {
  let apiCalls = 0;
  await setExtensionSettings(p, BASE_SETTINGS);
  await serve(context, page(`
    <video id="v" width="640" height="360">
      <track default kind="subtitles" srclang="zh-CN" label="中文" src="/subs-zh.vtt">
    </video>`));
  await mockTranslation(context, () => { apiCalls += 1; });

  await p.goto(`${ORIGIN}/page.html`);
  await p.waitForTimeout(500);
  await seekIntoFirstCue(p);
  await p.waitForTimeout(1000);

  expect(apiCalls).toBe(0);
});

test('with several tracks, the one the page marked default is translated', async ({ page: p, context }) => {
  await setExtensionSettings(p, BASE_SETTINGS);
  await serve(context, TWO_TRACKS);
  await mockTranslation(context);

  await p.goto(`${ORIGIN}/page.html`);
  await seekIntoFirstCue(p);

  await expect(p.locator('#ai-translator-caption-overlay')).toContainText('Hello world');
  const modes = await p.evaluate(() => Array.from(document.querySelector('video').textTracks).map((t) => `${t.language}:${t.mode}`));
  // Only the chosen track is held hidden; the other is left as the page had it.
  expect(modes).toContain('en:hidden');
});

test('subtitles the page only offers are left off until the viewer asks', async ({ page: p, context }) => {
  // Vimeo's player lists four languages and shows none until asked. Choosing
  // one there would put subtitles on screen that nobody turned on — in
  // whichever language the page listed first, German for an English video.
  let apiCalls = 0;
  await setExtensionSettings(p, BASE_SETTINGS);
  await serve(context, page(`
    <video id="v" width="640" height="360">
      <track kind="subtitles" srclang="de" label="Deutsch" src="/subs.vtt">
      <track kind="subtitles" srclang="en" label="English" src="/subs.vtt">
    </video>`));
  await mockTranslation(context, () => { apiCalls += 1; });

  await p.goto(`${ORIGIN}/page.html`);
  await seekIntoFirstCue(p);
  await p.waitForTimeout(800);

  await expect(p.locator('#ai-translator-caption-overlay')).toHaveCount(0);
  expect(apiCalls).toBe(0);
  const modes = await p.evaluate(() => Array.from(document.querySelector('video').textTracks).map((t) => t.mode));
  expect(modes).toEqual(['disabled', 'disabled']);

  // ...and the moment they do ask, we are there.
  await p.evaluate(() => { document.querySelector('video').textTracks[1].mode = 'showing'; });
  await seekIntoFirstCue(p);
  await expect(p.locator('#ai-translator-caption-overlay')).toContainText('你好世界');
});

test('turning subtitles off in the page turns ours off, and they stay off', async ({ page: p, context }) => {
  await setExtensionSettings(p, BASE_SETTINGS);
  await serve(context, WITH_TRACK);
  await mockTranslation(context);

  await p.goto(`${ORIGIN}/page.html`);
  await seekIntoFirstCue(p);
  const overlay = p.locator('#ai-translator-caption-overlay');
  await expect(overlay).toContainText('你好世界');

  // The player's own control switches subtitles off: it sets the track we are
  // holding to 'disabled'. Handing that track back in the mode it had when we
  // adopted it would turn subtitles on again, and we would read that as the
  // viewer wanting them — off and on for as long as the video played.
  await p.evaluate(() => { document.querySelector('video').textTracks[0].mode = 'disabled'; });
  for (let i = 0; i < 4; i += 1) {
    await p.evaluate((t) => {
      const v = document.querySelector('video');
      v.currentTime = 1 + t * 0.2;
      v.dispatchEvent(new Event('timeupdate'));
    }, i);
    await p.waitForTimeout(150);
  }

  await expect(overlay).toBeHidden();
  expect(await p.evaluate(() => document.querySelector('video').textTracks[0].mode)).toBe('disabled');

  // Detaching is the other path that hands the track back, and it has to answer
  // the same way: the mode we recorded is from before the viewer switched
  // subtitles off, so restoring it here would switch them on as a parting act.
  await setExtensionSettings(p, { ...BASE_SETTINGS, enableYoutubeCaptionTranslation: false });
  await p.waitForTimeout(600);
  expect(await p.evaluate(() => document.querySelector('video').textTracks[0].mode)).toBe('disabled');
});

test('turning the feature off puts the page back the way it was', async ({ page: p, context }) => {
  await setExtensionSettings(p, BASE_SETTINGS);
  await serve(context, WITH_TRACK);
  await mockTranslation(context);

  await p.goto(`${ORIGIN}/page.html`);
  await seekIntoFirstCue(p);
  await expect(p.locator('#ai-translator-caption-overlay')).toContainText('你好世界');

  await setExtensionSettings(p, { ...BASE_SETTINGS, enableYoutubeCaptionTranslation: false });
  await p.waitForTimeout(600);

  await expect(p.locator('.ai-translator-caption-host')).toHaveCount(0);
  // The track goes back to the mode the page had it in, not to ours.
  const mode = await p.evaluate(() => document.querySelector('video').textTracks[0].mode);
  expect(mode).toBe('showing');
});
