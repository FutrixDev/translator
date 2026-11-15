// Guards for how a caption looks before the viewer has touched anything: its
// size follows the box the video occupies, and its plate is transparent.
//
// Both rules are pure functions in shared/caption-core.js (captionFontPx,
// captionPaint) because two surfaces draw from them — the overlay on the video
// and the sample on the settings page. What rots here is a second copy: a
// viewport unit creeping back into the stylesheet, a colour helper of its own
// in one of the two surfaces, a default restated as a fallback.
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { captionEngineSource, contentCss, optionsSource, repoSource } from './helpers/sources.mjs';

await import('../../shared/lang-tags.js');
await import('../../shared/caption-core.js');
// default-settings.js spreads AccountGate.FEATURE_DEFAULTS at load.
await import('../../shared/account-gate.js');
await import('../../shared/default-settings.js');
const core = globalThis.CaptionCore;
const defaults = globalThis.DefaultSettings.contentDefaults();

/** The caption overlay's own rules, cut out of the content stylesheet. */
function overlayCss() {
  const css = contentCss();
  const start = css.indexOf('/* Video subtitle translation overlay');
  const end = css.indexOf('.ytp-caption-window-container.ai-translator-hide-native');
  assert.ok(start >= 0 && end > start, 'the overlay rules are where this test expects them');
  return css.slice(start, end);
}

// ---------------------------------------------------------------- font size
test('a 16:9 player gets the size YouTube gives its own captions: height / 22.5', () => {
  // Heights measured on the live player (default layout, theater, a large
  // window), with the native caption size read beside each.
  for (const [height, nativePx] of [[360, 16], [562, 24.98], [720, 32], [1271, 56.49]]) {
    const width = Math.round(height * 16 / 9);
    assert.ok(
      Math.abs(core.captionFontPx(width, height) - nativePx) < 0.01,
      `${width}x${height} should give ${nativePx}px, got ${core.captionFontPx(width, height)}`,
    );
  }
});

test('the size has no ceiling: a larger player keeps getting larger text', () => {
  assert.equal(core.captionFontPx(3840, 2160), 96);
  assert.ok(core.captionFontPx(2560, 1440) > core.captionFontPx(1920, 1080));
});

test('a box taller than 16:9 is sized by its width, not its height', () => {
  // A page-filling fullscreen box or a portrait embed: the picture inside is
  // letterboxed, and the text is sized for the picture.
  assert.equal(core.captionFontPx(1280, 1600), 32);
  assert.equal(core.captionFontPx(1280, 720), 32);
});

test('a box wider than 16:9 is sized by its height', () => {
  assert.equal(core.captionFontPx(2560, 720), 32);
});

test('a small player stops shrinking at the readable floor', () => {
  assert.equal(core.captionFontPx(320, 180), core.CAPTION_MIN_FONT_PX);
  assert.equal(core.captionFontPx(400, 800), core.CAPTION_MIN_FONT_PX);
  assert.equal(core.CAPTION_MIN_FONT_PX, 14);
});

test('a frame with no size is an error, not a guess', () => {
  for (const [w, h] of [[0, 360], [640, 0], [NaN, 360], [undefined, undefined], [-640, -360]]) {
    assert.throws(() => core.captionFontPx(w, h), TypeError);
  }
});

// -------------------------------------------------------------------- paint
test('the shipped caption style is white text on a fully transparent plate', () => {
  assert.equal(defaults.youtubeCaptionBgOpacity, 0);
  const paint = core.captionPaint({
    fontColor: defaults.youtubeCaptionFontColor,
    bgColor: defaults.youtubeCaptionBgColor,
    bgOpacity: defaults.youtubeCaptionBgOpacity,
  });
  assert.equal(paint.fg, 'rgb(255, 255, 255)');
  assert.equal(paint.bg, 'rgba(8, 8, 8, 0)');
});

test('the plate takes the chosen colour at the chosen opacity', () => {
  const paint = core.captionPaint({ fontColor: '#ffffff', bgColor: '#102030', bgOpacity: 82 });
  assert.equal(paint.bg, 'rgba(16, 32, 48, 0.82)');
});

test('the text edge is the opposite of the text: dark around light, light around dark', () => {
  const light = core.captionPaint({ fontColor: '#ffffff', bgColor: '#080808', bgOpacity: 0 });
  const yellow = core.captionPaint({ fontColor: '#ffff00', bgColor: '#080808', bgOpacity: 0 });
  const dark = core.captionPaint({ fontColor: '#101010', bgColor: '#ffffff', bgOpacity: 0 });
  assert.match(light.edge, /rgba\(0, 0, 0, /);
  assert.doesNotMatch(light.edge, /rgba\(255, 255, 255, /);
  assert.match(yellow.edge, /rgba\(0, 0, 0, /);
  assert.match(dark.edge, /rgba\(255, 255, 255, /);
  assert.doesNotMatch(dark.edge, /rgba\(0, 0, 0, /);
});

test('the text edge is in em, so it scales with the text it surrounds', () => {
  const { edge } = core.captionPaint({ fontColor: '#ffffff', bgColor: '#080808', bgOpacity: 0 });
  assert.match(edge, /em/);
  assert.doesNotMatch(edge, /\dpx/);
});

test('a colour or opacity that is not one is an error, not a fallback', () => {
  const ok = { fontColor: '#ffffff', bgColor: '#080808', bgOpacity: 0 };
  for (const bad of [
    { fontColor: '' }, { fontColor: 'white' }, { fontColor: '#fff' }, { fontColor: undefined },
    { bgColor: null }, { bgColor: 'rgb(0,0,0)' },
    { bgOpacity: NaN }, { bgOpacity: -1 }, { bgOpacity: 101 }, { bgOpacity: 'opaque' },
  ]) {
    assert.throws(() => core.captionPaint({ ...ok, ...bad }), TypeError, JSON.stringify(bad));
  }
  assert.throws(() => core.captionPaint(), TypeError);
});

// ----------------------------------------------------- one copy of each rule
test('the overlay stylesheet sizes nothing against the viewport', () => {
  const css = overlayCss().replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(css, /\d(vh|vw|vmin|vmax)\b/, 'a viewport unit ignores how big the video is');
  assert.match(css, /font-size:\s*calc\(var\(--ai-caption-size\) \* var\(--ai-caption-scale, 1\)\)/);
});

test('the overlay stylesheet restates no colour default', () => {
  const css = overlayCss().replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(css, /var\(--ai-caption-(fg|bg|edge),/, 'a fallback here is a second default');
  assert.match(css, /text-shadow:\s*var\(--ai-caption-edge\)/);
});

test('neither surface converts colours on its own', () => {
  for (const [name, source] of [['captions', captionEngineSource()], ['options', optionsSource()]]) {
    assert.doesNotMatch(source, /hexToRgba/i, `${name}: colours go through CaptionCore.captionPaint`);
    assert.match(source, /captionPaint\(/, `${name} draws from the shared paint`);
  }
});

test('the settings page fills the caption controls from stored settings, not from markup', () => {
  const html = repoSource('options/options.html');
  for (const id of ['youtubeCaptionFontColor', 'youtubeCaptionBgColor', 'youtubeCaptionBgOpacity']) {
    const tag = new RegExp(`<input[^>]*id="${id}"[^>]*>`).exec(html);
    assert.ok(tag, `${id} is on the settings page`);
    assert.doesNotMatch(tag[0], /\svalue=/, `${id}: a value in the markup is a second default`);
  }
});

test('the control bar is measured, not assumed to be a fixed height', () => {
  const providers = repoSource('content/content-caption-providers.js');
  assert.doesNotMatch(providers, /liftPx/);
  assert.match(providers, /clearPx/);
  assert.doesNotMatch(captionEngineSource() + contentCss(), /--ai-caption-(lift|unit)/);
});
