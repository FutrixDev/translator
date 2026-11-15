const { test, expect } = require('./fixtures');
const {
  html,
  BASE_SETTINGS,
  timedtextBody,
  simulatePlayerTimedtext,
  openPlayer,
  playCue,
  ccOff,
} = require('./youtube-caption-fixtures');

// An ad plays inside the same player and the same <video>, with no navigation,
// and the player fetches the ad's own caption track through the same endpoint.
// The tests below reproduce exactly that: another video's track arriving on a
// page whose player still says it is showing `abc123`.

/** json3 with one two-second cue per [startMs, text] pair. */
const json3 = (...cues) => JSON.stringify({
  events: cues.map(([tStartMs, text]) => ({ tStartMs, dDurationMs: 2000, segs: [{ utf8: text }] })),
});

/**
 * Answer each caption request with the body for its video (and track kind:
 * keys are `<v>` or `<v>|<kind>`), and collect everything the model is asked to
 * translate. Registered after openPlayer, so these routes win.
 */
async function routeTracks(context, bodies) {
  const asked = [];
  await context.route('https://www.youtube.com/api/timedtext**', (route) => {
    const params = new URL(route.request().url()).searchParams;
    const kind = params.get('kind');
    const body = bodies[kind ? `${params.get('v')}|${kind}` : params.get('v')];
    route.fulfill({ status: 200, contentType: 'application/json', body });
  });
  await context.route('https://api.openai.com/**', (route) => {
    asked.push(route.request().postData() || '');
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ choices: [{ message: { content: '你好世界' } }] }),
    });
  });
  return asked;
}

async function seek(page, seconds) {
  await page.evaluate((t) => {
    const v = document.querySelector('video');
    v.currentTime = t;
    v.dispatchEvent(new Event('timeupdate'));
  }, seconds);
}

const setAdShowing = (page, on) => page.evaluate((showing) => {
  document.getElementById('movie_player').classList.toggle('ad-showing', showing);
}, on);

test('an ad’s captions never join the video’s timeline', async ({ page, context }) => {
  await openPlayer(page, context, BASE_SETTINGS);
  const asked = await routeTracks(context, {
    abc123: timedtextBody,
    adxyz: json3([0, 'Try the sample app today'], [2500, 'Zero setup needed']),
  });
  const overlay = page.locator('#ai-translator-caption-overlay');

  // Pre-roll: the ad's track comes first, in the same language as the video's.
  await simulatePlayerTimedtext(page, 'en', { v: 'adxyz' });
  await playCue(page);
  await expect(overlay.locator('.ai-translator-caption-original')).toHaveText('Hello world');
  await expect(overlay.locator('.ai-translator-caption-line')).toHaveText('你好世界');

  // Mid-roll: the same thing the other way round, and then the interceptor's
  // replay, which hands back everything it has buffered — the ad's track too.
  await simulatePlayerTimedtext(page, 'en', { v: 'adxyz' });
  await page.evaluate(() => window.postMessage({ source: 'ai-translator', type: 'YT_TIMEDTEXT_REPLAY' }, '*'));
  await page.waitForTimeout(300);
  await seek(page, 0.5);
  await expect(overlay.locator('.ai-translator-caption-original')).toHaveText('Hello world');

  // 3.0 s is inside the ad's second cue and past the video's only one.
  await seek(page, 3);
  await expect(overlay.locator('.ai-translator-caption-original')).toHaveText('');

  expect(asked.join('\n')).toContain('Hello world');
  expect(asked.join('\n')).not.toContain('sample app');
  expect(asked.join('\n')).not.toContain('Zero setup');
});

test('while an ad is showing the engine stands aside, and the playhead stays on the video', async ({ page, context }) => {
  await openPlayer(page, context, BASE_SETTINGS);
  // The second cue is ten minutes in: outside the translate-ahead window from
  // 0.5 s, so it is only asked for once the playhead really gets there.
  const asked = await routeTracks(context, {
    abc123: json3([0, 'Hello world'], [600000, 'Far away line']),
  });
  const overlay = page.locator('#ai-translator-caption-overlay');
  const nativeLayer = page.locator('.ytp-caption-window-container');

  await playCue(page);
  await expect(overlay.locator('.ai-translator-caption-line')).toHaveText('你好世界');
  await expect(nativeLayer).toHaveClass(/ai-translator-hide-native/);
  // Past the translate-ahead throttle, so the next beat is free to translate.
  await page.waitForTimeout(2200);

  // The ad borrows the <video>: currentTime is now the ad's clock.
  await setAdShowing(page, true);
  await seek(page, 600.5);
  await expect(overlay).toBeHidden();
  await expect(nativeLayer).not.toHaveClass(/ai-translator-hide-native/);
  await page.waitForTimeout(2200);
  expect(asked.join('\n')).not.toContain('Far away line');

  // Ad over: back on the video, exactly where it was.
  await setAdShowing(page, false);
  await seek(page, 0.5);
  await expect(overlay).toBeVisible();
  await expect(overlay.locator('.ai-translator-caption-original')).toHaveText('Hello world');
  await expect(nativeLayer).toHaveClass(/ai-translator-hide-native/);

  // The control for the assertion above: the same seek on the video's own
  // clock does ask for that line.
  await page.waitForTimeout(2200);
  await seek(page, 600.5);
  await expect.poll(() => asked.join('\n'), { timeout: 8000 }).toContain('Far away line');
});

test('switching to another track of the same language starts a fresh timeline', async ({ page, context }) => {
  await openPlayer(page, context, BASE_SETTINGS);
  await routeTracks(context, {
    abc123: timedtextBody,
    'abc123|asr': json3([0, 'machine heard this']),
  });
  const original = page.locator('#ai-translator-caption-overlay .ai-translator-caption-original');

  await playCue(page);
  await expect(original).toHaveText('Hello world');

  // English → English (auto-generated): same `lang`, a different track.
  await simulatePlayerTimedtext(page, 'en', { kind: 'asr' });
  await seek(page, 0.5);
  await expect(original).toHaveText('machine heard this');
});

test('the CC button is not pressed for an ad, and is once the video is back', async ({ page, context }) => {
  const adFirst = ccOff().replace('class="html5-video-player"', 'class="html5-video-player ad-showing"');
  await openPlayer(page, context, { ...BASE_SETTINGS, autoEnableCaptions: true }, adFirst);

  await page.waitForTimeout(3 * 1500 + 300);
  expect(await page.evaluate(() => window.__ccClicks)).toBe(0);

  await setAdShowing(page, false);
  await expect.poll(() => page.evaluate(() => window.__ccClicks), { timeout: 8000 }).toBe(1);
});

test('an ad with captions off is not read as the viewer switching captions off', async ({ page, context }) => {
  // Captions are on for the video. The fixture's button answers a press by
  // turning on, and counts it.
  const body = ccOff().replace('aria-pressed="false"', 'aria-pressed="true"');
  await openPlayer(page, context, { ...BASE_SETTINGS, autoEnableCaptions: true }, body);
  const setPressed = (on) => page.evaluate((value) => {
    document.querySelector('.ytp-subtitles-button').setAttribute('aria-pressed', value);
  }, String(on));
  await page.waitForTimeout(1500 + 300);

  // The ad has no captions: for its duration the bar's button reads "off".
  await setAdShowing(page, true);
  await setPressed(false);
  await page.waitForTimeout(2 * 1500 + 300);
  await setPressed(true);
  await setAdShowing(page, false);
  await page.waitForTimeout(1500 + 300);
  expect(await page.evaluate(() => window.__ccClicks)).toBe(0);

  // Next video, captions off there. Had the ad been read as "he switched them
  // off", auto-enable would be shut for the whole session.
  await setPressed(false);
  await page.evaluate(() => window.dispatchEvent(new Event('yt-navigate-finish')));
  await expect.poll(() => page.evaluate(() => window.__ccClicks), { timeout: 8000 }).toBe(1);
});

test('when the ad ends before the button is back on, the video’s captions still return', async ({ page, context }) => {
  // A real player takes `ad-showing` off and turns the button back on in one
  // step. This is the other order: a whole heartbeat reads "off" on the video
  // itself. Nothing is pressed for the viewer then, and nothing is lost either.
  const body = ccOff().replace('aria-pressed="false"', 'aria-pressed="true"');
  await openPlayer(page, context, { ...BASE_SETTINGS, autoEnableCaptions: true }, body);
  const overlay = page.locator('#ai-translator-caption-overlay');
  const setPressed = (on) => page.evaluate((value) => {
    document.querySelector('.ytp-subtitles-button').setAttribute('aria-pressed', value);
  }, String(on));

  await playCue(page);
  await expect(overlay.locator('.ai-translator-caption-line')).toHaveText('你好世界');
  await page.waitForTimeout(1500 + 300);

  await setAdShowing(page, true);
  await setPressed(false);
  await seek(page, 0.5);
  await expect(overlay).toBeHidden();
  await page.waitForTimeout(1500 + 300);

  await setAdShowing(page, false);
  await page.waitForTimeout(1500 + 300);
  await setPressed(true);
  await seek(page, 0.5);

  await expect(overlay).toBeVisible();
  await expect(overlay.locator('.ai-translator-caption-original')).toHaveText('Hello world');
  await expect(overlay.locator('.ai-translator-caption-line')).toHaveText('你好世界');
  expect(await page.evaluate(() => window.__ccClicks)).toBe(0);
});

test('a track fetched while the player still names the last video is taken once the navigation finishes', async ({ page, context }) => {
  await openPlayer(page, context, BASE_SETTINGS);
  const overlay = page.locator('#ai-translator-caption-overlay');
  const nameVideo = (id) => page.evaluate((videoId) => {
    document.getElementById('movie_player').getVideoData = () => ({ video_id: videoId });
  }, id);

  // Mid-navigation: the request is already for this page's video, the player
  // has not caught up. Turned away, as any other video's track is.
  await nameVideo('last999');
  await playCue(page);
  await page.waitForTimeout(500);
  await expect(overlay).toHaveCount(0);

  // The player catches up and the navigation finishes. Nothing is fetched
  // again: the track has to come from what was already captured.
  await nameVideo('abc123');
  await page.evaluate(() => window.dispatchEvent(new Event('yt-navigate-finish')));
  await page.waitForTimeout(300);
  await seek(page, 0.5);
  await expect(overlay.locator('.ai-translator-caption-original')).toHaveText('Hello world');
  await expect(overlay.locator('.ai-translator-caption-line')).toHaveText('你好世界');
});

test('a player that does not say which video it shows gets no captions, and one warning', async ({ page, context }) => {
  const warnings = [];
  page.on('console', (message) => {
    if (message.text().includes('did not say which video')) warnings.push(message.text());
  });
  const silentPlayer = html.replace(/\s*<script>[\s\S]*?getVideoData[\s\S]*?<\/script>/, '');
  expect(silentPlayer).not.toContain('getVideoData');
  await openPlayer(page, context, BASE_SETTINGS, silentPlayer);

  await playCue(page);
  await playCue(page);
  await page.waitForTimeout(500);

  await expect(page.locator('#ai-translator-caption-overlay')).toHaveCount(0);
  expect(warnings).toHaveLength(1);
});
