// The generic side of caption translation: any page whose <video> exposes
// subtitle cues through the standard TextTrack API, with no per-site code.
//
// The YouTube half is covered separately in youtube-caption-translation.spec.js
// — it goes through a provider that observes the player's network traffic,
// where this one reads cues the browser has already parsed.
const { test, expect } = require('./fixtures');
const { setExtensionSettings, expectCaptionMenuAnchoredAboveButton } = require('./helpers');

const ORIGIN = 'https://video.test';

// Pinned to the mocked API for the same reason the YouTube spec is: this is a
// test about captions, not about which translation backend gets picked.
const BASE_SETTINGS = {
  targetLang: 'zh-CN',
  apiKey: 'sk-test',
  apiEndpoint: 'https://api.openai.com/v1/chat/completions',
  modelName: 'gpt-4.1-mini',
};

// 「把字幕关掉」有两条路，因为字幕没有自己的开关了：它跟着主开关加站点规则走
// （content/content-video-captions.js 的 siteRefused，PRD §5.4.1）。这一条是关主
// 开关——GLOBAL_OFF 是 REFUSALS 的第一档。站点规则那条在文件末尾单独守。
const GATE_SHUT = { ...BASE_SETTINGS, autoTranslate: false };

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

// A second foreign track, so "which one did we pick" has a visible answer.
const VTT_DE = `WEBVTT

00:00:00.000 --> 00:00:04.000
Hallo Welt
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

// Two subtitle languages, neither turned on, and a <video lang> that says what
// the audio is. The page offers German first — order is not a preference.
const TWO_OFF_EN_AUDIO = page(`
  <video id="v" lang="en" width="640" height="360">
    <track kind="subtitles" srclang="de" label="Deutsch" src="/subs-de.vtt">
    <track kind="subtitles" srclang="en" label="English" src="/subs.vtt">
  </video>`);

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
  await context.route(`${ORIGIN}/subs-de.vtt`, (route) => {
    route.fulfill({ status: 200, contentType: 'text/vtt', body: VTT_DE });
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
  await setExtensionSettings(p, GATE_SHUT);
  await p.waitForTimeout(600);
  expect(await p.evaluate(() => document.querySelector('video').textTracks[0].mode)).toBe('disabled');
});

test('shutting the gate puts the page back the way it was', async ({ page: p, context }) => {
  await setExtensionSettings(p, BASE_SETTINGS);
  await serve(context, WITH_TRACK);
  await mockTranslation(context);

  await p.goto(`${ORIGIN}/page.html`);
  await seekIntoFirstCue(p);
  await expect(p.locator('#ai-translator-caption-overlay')).toContainText('你好世界');

  await setExtensionSettings(p, GATE_SHUT);
  await p.waitForTimeout(600);

  await expect(p.locator('.ai-translator-caption-host')).toHaveCount(0);
  // The track goes back to the mode the page had it in, not to ours.
  const mode = await p.evaluate(() => document.querySelector('video').textTracks[0].mode);
  expect(mode).toBe('showing');
});

// ---------------------------------------------------------------- F17
// A6 — with no control bar of ours to dock into, the button becomes a badge in
// the video's bottom-right corner. And a page with no subtitle track at all
// gets nothing: an icon there would be litter on someone else's <video>.

test('with no player control bar the button sits in the video corner', async ({ page: p, context }) => {
  await setExtensionSettings(p, BASE_SETTINGS);
  await serve(context, WITH_TRACK);
  await mockTranslation(context);

  await p.goto(`${ORIGIN}/page.html`);
  await p.waitForTimeout(600);

  const button = p.locator('#ai-translator-caption-btn');
  await expect(button).toHaveCount(1);

  // Nudge the pointer over the video: the badge follows a player's own rhythm
  // and only shows while there is activity.
  await p.mouse.move(320, 180);

  const gaps = await p.evaluate(() => {
    const v = document.querySelector('video').getBoundingClientRect();
    const b = document.getElementById('ai-translator-caption-btn').getBoundingClientRect();
    return { right: v.right - b.right, bottom: v.bottom - b.bottom };
  });
  expect(gaps.right).toBeLessThanOrEqual(16);
  expect(gaps.bottom).toBeLessThanOrEqual(16);
  expect(gaps.right).toBeGreaterThanOrEqual(0);
  expect(gaps.bottom).toBeGreaterThanOrEqual(0);

  // The menu's status line names the track it found, read without adopting it.
  await button.click();
  await expect(p.locator('#ai-translator-caption-menu .ai-translator-caption-menu-status'))
    .toContainText('English');

  // And the menu is a popover on the badge: just above it, right-aligned with
  // it, at its own height, inside the floating box pinned to the video.
  await expectCaptionMenuAnchoredAboveButton(p, '#ai-translator-caption-controls');
});

test('a page with no subtitle track gets no button', async ({ page: p, context }) => {
  await setExtensionSettings(p, BASE_SETTINGS);
  await serve(context, NO_TRACK);
  await mockTranslation(context);

  await p.goto(`${ORIGIN}/page.html`);
  // Long enough for the controls heartbeat to have run more than once.
  await p.waitForTimeout(2500);
  await p.mouse.move(320, 180);

  await expect(p.locator('#ai-translator-caption-btn')).toHaveCount(0);
  await expect(p.locator('#ai-translator-caption-controls')).toHaveCount(0);
});

// The generic provider has no site code to hide the native line, so "original
// only" has to hand the track back at the mode the page had it in.
test('original-only gives the page its own captions back', async ({ page: p, context }) => {
  await setExtensionSettings(p, { ...BASE_SETTINGS, captionDisplayMode: 'original' });
  await serve(context, WITH_TRACK);
  await mockTranslation(context);

  await p.goto(`${ORIGIN}/page.html`);
  await p.waitForTimeout(600);
  await seekIntoFirstCue(p);
  await p.waitForTimeout(400);

  await expect(p.locator('#ai-translator-caption-overlay')).toBeHidden();
  expect(await p.evaluate(() => document.querySelector('video').textTracks[0].mode)).toBe('showing');
});

// ------------------------------------------------------------------- PR-9
// 「没开原字幕的视频，替我把原字幕点开」—— autoEnableCaptions。本轮唯一会改动播放
// 器自己状态的自动化，所以它单独一个开关、默认关，而且只合不开。

/** The track modes as the page sees them, e.g. ['de:disabled', 'en:hidden']. */
function trackModes(p) {
  return p.evaluate(() => Array.from(document.querySelector('video').textTracks)
    .map((t) => `${t.language}:${t.mode}`));
}

test('turning subtitles on picks the language the audio is in, not the first listed', async ({ page: p, context }) => {
  await setExtensionSettings(p, { ...BASE_SETTINGS, autoEnableCaptions: true });
  await serve(context, TWO_OFF_EN_AUDIO);
  await mockTranslation(context);

  await p.goto(`${ORIGIN}/page.html`);

  // German is listed first; the audio is English. Picking by list order would
  // put a German translation of English speech on screen.
  await expect.poll(() => trackModes(p), { timeout: 8000 }).toEqual(['de:disabled', 'en:hidden']);

  await seekIntoFirstCue(p);
  await expect(p.locator('#ai-translator-caption-overlay')).toContainText('你好世界');
});

test('with the setting off, subtitles the page only offers stay off', async ({ page: p, context }) => {
  // The same page as above, minus the one setting. This is the default install.
  await setExtensionSettings(p, BASE_SETTINGS);
  await serve(context, TWO_OFF_EN_AUDIO);
  await mockTranslation(context);

  await p.goto(`${ORIGIN}/page.html`);
  // Two heartbeats' worth: long enough that "nothing happened" means it.
  await p.waitForTimeout(3500);

  expect(await trackModes(p)).toEqual(['de:disabled', 'en:disabled']);
  await expect(p.locator('#ai-translator-caption-overlay')).toHaveCount(0);
});

test('hiding the player button does not stop subtitles being turned on', async ({ page: p, context }) => {
  // Two settings, two things. Hiding our icon says "keep your button off the
  // control bar"; turning subtitles on is what the other switch is for. Both
  // run off the same heartbeat, which is how they came to be tangled once.
  await setExtensionSettings(p, {
    ...BASE_SETTINGS,
    autoEnableCaptions: true,
    captionPlayerButton: false,
  });
  await serve(context, TWO_OFF_EN_AUDIO);
  await mockTranslation(context);

  await p.goto(`${ORIGIN}/page.html`);

  await expect.poll(() => trackModes(p), { timeout: 8000 }).toEqual(['de:disabled', 'en:hidden']);
  await seekIntoFirstCue(p);
  await expect(p.locator('#ai-translator-caption-overlay')).toContainText('你好世界');
  // And the button really is gone — otherwise this passes for the wrong reason.
  await expect(p.locator('#ai-translator-caption-btn')).toHaveCount(0);
});

test('the viewer switching subtitles off outlasts the heartbeat', async ({ page: p, context }) => {
  // The whole risk of this feature in one test: we re-check every 1.5s, so a
  // viewer who switches subtitles off and sees them come back cannot switch
  // them off at all. Seeing them on and then off is the latch, whoever put
  // them on — from his side those are the same event.
  await setExtensionSettings(p, { ...BASE_SETTINGS, autoEnableCaptions: true });
  await serve(context, WITH_TRACK);
  await mockTranslation(context);

  await p.goto(`${ORIGIN}/page.html`);
  await seekIntoFirstCue(p);
  await expect(p.locator('#ai-translator-caption-overlay')).toContainText('你好世界');

  await p.evaluate(() => { document.querySelector('video').textTracks[0].mode = 'disabled'; });
  // Four heartbeats with the video still playing under them: the first latches,
  // and none of the rest may undo it.
  for (let i = 0; i < 4; i += 1) {
    await p.evaluate((t) => {
      const v = document.querySelector('video');
      v.currentTime = 1 + t * 0.2;
      v.dispatchEvent(new Event('timeupdate'));
    }, i);
    await p.waitForTimeout(1600);
    expect(await p.evaluate(() => document.querySelector('video').textTracks[0].mode)).toBe('disabled');
  }

  await expect(p.locator('#ai-translator-caption-overlay')).toBeHidden();
});

test('changing the reader language re-translates the lines already cached', async ({ page: p, context }) => {
  // The cache holds *translations*, so the language they are in is part of what
  // identifies them. Without that, switching from Chinese to Japanese mid-video
  // leaves every line already translated keyed exactly as before: the Chinese
  // stays on screen, and because the keys are valid it is never re-translated.
  await setExtensionSettings(p, BASE_SETTINGS);
  await serve(context, WITH_TRACK);
  let calls = 0;
  await context.route('https://api.openai.com/**', (route) => {
    calls += 1;
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ choices: [{ message: { content: `译文${calls}` } }] }),
    });
  });

  await p.goto(`${ORIGIN}/page.html`);
  await seekIntoFirstCue(p);
  const overlay = p.locator('#ai-translator-caption-overlay');
  await expect(overlay).toContainText('译文1');

  await setExtensionSettings(p, { ...BASE_SETTINGS, targetLang: 'ja' });
  // A pass is debounced, so keep the video running under it until one comes
  // round; every reply after the first carries a different number.
  await expect.poll(async () => {
    await seekIntoFirstCue(p);
    return (await overlay.textContent()) || '';
  }, { timeout: 15000 }).toMatch(/译文[2-9]/);
});

test('after the viewer switches subtitles off, the menu can switch them back on', async ({ page: p, context }) => {
  // The latch is deliberate — we never re-open subtitles the viewer closed —
  // so this row is the only way back, and it has to work on the track we were
  // holding when he closed it. Two things used to stand in the way: the menu
  // still named that track ("Subtitles: English") and so never showed the row,
  // and the pick behind the row saw the track it already held and returned
  // "already on it" without re-opening anything.
  await setExtensionSettings(p, BASE_SETTINGS);
  await serve(context, WITH_TRACK);
  await mockTranslation(context);

  await p.goto(`${ORIGIN}/page.html`);
  await seekIntoFirstCue(p);
  const overlay = p.locator('#ai-translator-caption-overlay');
  await expect(overlay).toContainText('你好世界');

  await p.evaluate(() => { document.querySelector('video').textTracks[0].mode = 'disabled'; });
  // Keep the video running under it: hiding the overlay happens on the next
  // frame we are asked about, not on the mode change itself.
  for (let i = 0; i < 4; i += 1) {
    await p.evaluate((t) => {
      const v = document.querySelector('video');
      v.currentTime = 1 + t * 0.2;
      v.dispatchEvent(new Event('timeupdate'));
    }, i);
    await p.waitForTimeout(150);
  }
  expect(await trackModes(p)).toEqual(['en:disabled']);
  await expect(overlay).toBeHidden();

  await p.mouse.move(320, 180);
  await p.locator('#ai-translator-caption-btn').click();
  await expect(p.locator('#ai-translator-caption-menu .ai-translator-caption-menu-status'))
    .toContainText(/subtitles are off/i);
  await p.locator('#ai-translator-caption-menu [data-action="native"]').click();

  await expect.poll(() => trackModes(p), { timeout: 8000 }).toEqual(['en:hidden']);
  await seekIntoFirstCue(p);
  await expect(overlay).toContainText('你好世界');

  // And the track he asked for is handed back *on*. Restoring the mode it had
  // when we took it would mean turning subtitles off as a parting act — for a
  // track we only ever held because he pressed "turn subtitles on".
  await setExtensionSettings(p, GATE_SHUT);
  await expect.poll(() => trackModes(p), { timeout: 8000 }).toEqual(['en:showing']);
});

test('the menu offers to turn subtitles on even with the setting off', async ({ page: p, context }) => {
  // The setting is for "do it without asking". Pressing the item in the menu
  // *is* asking, so it goes through whatever the setting says — and through the
  // latch, because this is the viewer changing his mind.
  await setExtensionSettings(p, BASE_SETTINGS);
  await serve(context, TWO_OFF_EN_AUDIO);
  await mockTranslation(context);

  await p.goto(`${ORIGIN}/page.html`);
  await p.waitForTimeout(2000);
  expect(await trackModes(p)).toEqual(['de:disabled', 'en:disabled']);

  await p.mouse.move(320, 180);
  await p.locator('#ai-translator-caption-btn').click();

  // Not "this video has no subtitles" — that is a sentence we cannot say. The
  // menu says what is actually true and gives him the button.
  await expect(p.locator('#ai-translator-caption-menu .ai-translator-caption-menu-status'))
    .toContainText(/subtitles are off/i);
  await p.locator('#ai-translator-caption-menu [data-action="native"]').click();

  await expect.poll(() => trackModes(p), { timeout: 8000 }).toEqual(['de:disabled', 'en:hidden']);
  await seekIntoFirstCue(p);
  await expect(p.locator('#ai-translator-caption-overlay')).toContainText('你好世界');
});

// ---------------------------------------------------------------- 闸门
// 字幕翻不翻由主开关加站点规则说了算。上面用主开关关闸，这两条守另外半边：一条
// 站点规则同样关得掉，而且**规则一落地字幕当场就停**，不必刷新页面 —— 用户在
// popup 上把这个站点关掉，是因为他此刻就不想要，而这一页正在播。

test('一条 never 规则同样把字幕关掉', async ({ page: p, context }) => {
  await setExtensionSettings(p, { ...BASE_SETTINGS, siteRules: { 'video.test': 'never' } });
  await serve(context, WITH_TRACK);
  await mockTranslation(context);

  await p.goto(`${ORIGIN}/page.html`);
  await p.waitForTimeout(1500);
  await seekIntoFirstCue(p);

  // 字幕没上，而页面自己的那条轨也没被我们动过。
  await expect(p.locator('#ai-translator-caption-overlay')).toHaveCount(0);
  expect(await p.evaluate(() => document.querySelector('video').textTracks[0].mode)).toBe('showing');
  // 按钮还在：它是把这个站点重新打开的地方，不能自己也跟着消失。
  await expect(p.locator('#ai-translator-caption-btn')).toHaveCount(1);
});

test('规则改在播放当中：字幕当场停，不必刷新', async ({ page: p, context }) => {
  await setExtensionSettings(p, BASE_SETTINGS);
  await serve(context, WITH_TRACK);
  await mockTranslation(context);

  await p.goto(`${ORIGIN}/page.html`);
  await seekIntoFirstCue(p);
  await expect(p.locator('#ai-translator-caption-overlay')).toContainText('你好世界');

  await setExtensionSettings(p, { ...BASE_SETTINGS, siteRules: { 'video.test': 'never' } });

  await expect(p.locator('.ai-translator-caption-host')).toHaveCount(0);
  // 轨照旧还给页面，和主开关那条路一个交法。
  await expect
    .poll(() => p.evaluate(() => document.querySelector('video').textTracks[0].mode), { timeout: 8000 })
    .toBe('showing');
});
