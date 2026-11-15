// The player page every YouTube caption spec drives, and the handful of moves
// they all make on it: load it, feed it the player's caption request, put the
// playhead on a cue.
const { setExtensionSettings } = require('./helpers');

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
  <div id="movie_player" class="html5-video-player">
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
  <script>
    // The player's own answer to "which video is this page for". It keeps
    // naming the content video while an ad plays in the same element.
    document.getElementById('movie_player').getVideoData = () => ({ video_id: 'abc123' });
  </script>
</body>
</html>`;

// These tests are about the caption pipeline, not about engine selection, so
// they pin the backend to the mocked API. Left on the default the run would
// hinge on whether this machine happens to hold the browser's on-device
// language pack for the pair — a fresh profile does not, so it falls back to
// the API, but that is an accident of the profile and not something to assert
// through.
//
// The menu's labels are drawn in the UI language, which is a setting of its own
// and no longer inherited from targetLang — so a spec that asserts Chinese rows
// has to ask for Chinese.
const BASE_SETTINGS = {
  targetLang: 'zh-CN',
  uiLanguage: 'zh-CN',
  apiKey: 'sk-test',
  apiEndpoint: 'https://api.openai.com/v1/chat/completions',
  modelName: 'gpt-4.1-mini',
};

const timedtextBody = JSON.stringify({
  events: [{ tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: 'Hello world' }] }],
});

// The real YouTube player is the only party that can fetch /api/timedtext (its
// request carries a valid proof-of-origin token). The extension observes that
// request via a MAIN-world interceptor. In tests there is no player, so we
// reproduce the player's XHR from the page to exercise the same capture path.
async function simulatePlayerTimedtext(page, lang, { v = 'abc123', kind = '' } = {}) {
  await page.evaluate((query) => new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', `https://www.youtube.com/api/timedtext?fmt=json3&${query}&pot=TESTPOT`);
    xhr.onload = () => resolve();
    xhr.onerror = () => resolve();
    xhr.send();
  }), `v=${v}&lang=${lang}${kind ? `&kind=${kind}` : ''}`);
}

/** Load the fixture with routes in place and let the content script settle. */
async function openPlayer(page, context, settings, body = html) {
  await setExtensionSettings(page, settings);
  await context.route('https://www.youtube.com/watch**', (route) => {
    route.fulfill({ status: 200, contentType: 'text/html', body });
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

/** The player as it looks with captions off, plus a CC button that records presses. */
function ccOff(attrs = '') {
  return html.replace(
    '<button class="ytp-subtitles-button" aria-pressed="true"></button>',
    `<button class="ytp-subtitles-button" aria-pressed="false" ${attrs}></button>
     <script>
       window.__ccClicks = 0;
       const b = document.querySelector('.ytp-subtitles-button');
       b.addEventListener('click', () => {
         window.__ccClicks += 1;
         if (!b.disabled) b.setAttribute('aria-pressed', 'true');
       });
     </script>`
  );
}

module.exports = {
  html,
  BASE_SETTINGS,
  timedtextBody,
  simulatePlayerTimedtext,
  openPlayer,
  playCue,
  ccOff,
};
