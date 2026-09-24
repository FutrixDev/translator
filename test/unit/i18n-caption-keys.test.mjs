// Guard for the in-player caption control's copy.
//
// Every string the button and its menu draw comes from i18n/messages.js, and
// that file is ten sibling object literals — one per UI language — with no
// schema between them. A key added to the English block and forgotten in the
// other nine does not fail anything: getMessage() falls back to English, so the
// menu simply renders in English for a reader who set the extension to Korean,
// and nothing says so until somebody looks at it in Korean.
//
// The older caption keys are in exactly that state (`showYoutubeOriginalCaption`
// exists in three blocks of ten), which is what this test exists to stop
// happening again to the new ones. It is deliberately scoped to the caption
// control keys rather than the whole file: making it whole-file today would
// mean either translating several hundred pre-existing gaps or an allowlist
// long enough to hide the next one.
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';

// No `export` — messages.js is a classic script that publishes onto globalThis.
await import('../../i18n/messages.js');
await import('../../shared/lang-tags.js');
await import('../../shared/caption-core.js');
const MESSAGES = globalThis.I18N_MESSAGES;
const core = globalThis.CaptionCore;

// Every UI language getUILanguage() can return. Read from the module rather
// than restated here: a language added to messages.js has to be covered by this
// guard on the same commit, not whenever someone remembers this list exists.
const LANGS = globalThis.UI_LANGUAGES;

// The button's label, the five menu rows, the select options and the status
// line — everything F17 draws inside a video player — plus the options-page
// controls that reach the same settings.
const CAPTION_KEYS = [
  'captionControlsLabel',
  'captionDisplayMode',
  'captionModeBilingual',
  'captionModeTranslation',
  'captionModeOriginal',
  'captionTranslationPosition',
  'captionPositionBelow',
  'captionPositionAbove',
  'captionMenuStyle',
  'captionMenuHide',
  'captionStatusTrack',
  'captionStatusNoTrack',
  'captionStatusSameLang',
  'captionPlayerButton',
  'hintCaptionPlayerButton',
  // 「原字幕还没开」那条路：菜单里的那一项、它的状态行，和设置页那个开关。
  'captionMenuEnableNative',
  'captionStatusNeedsNative',
  'autoEnableCaptions',
  'hintAutoEnableCaptions',
  // The popup row and the options card that were already there and had to move
  // with the feature — they name the same thing the button does now.
  'youtubeCaptions',
  // 字幕并进主开关之后，菜单第一行写的就是站点规则，和 popup 上那一行同一句话
  // 同一个 key；设置页那张卡剩下的是一句「跟着主开关走」的说明。
  'popupSiteAuto',
  'captionFollowsAutoTranslate',
  // 没设过规则的站点上字幕照翻、第一行却印着「关」：菜单和 popup 都多一行「不
  // 再自动翻译 {site}」，和悬浮球那一行同一个 key。
  'autoStopSite',
  // 字幕的 AI 花费算进自动翻译那一份日额度，花完那一刻菜单要说得出原因。
  'captionStatusBudgetSpent',
];

test('every UI language block exists', () => {
  for (const lang of LANGS) {
    assert.ok(MESSAGES[lang], `i18n/messages.js has no '${lang}' block`);
  }
});

test('the caption control copy is complete in all ten languages', () => {
  const missing = [];
  for (const lang of LANGS) {
    for (const key of CAPTION_KEYS) {
      const value = MESSAGES[lang][key];
      if (typeof value !== 'string' || !value.trim()) missing.push(`${lang}.${key}`);
    }
  }
  assert.deepEqual(missing, [], `caption strings missing from i18n/messages.js:\n  ${missing.join('\n  ')}`);
});

test('a translated block is not just the English string copied over', () => {
  // A block that "has" every key by holding English is the same failure with a
  // green test. The menu rows are short enough that a real translation of at
  // least a few of them must differ from English in every non-Latin block.
  for (const lang of ['zh-CN', 'zh-TW', 'ja', 'ko', 'ru']) {
    const differing = CAPTION_KEYS.filter((key) => MESSAGES[lang][key] !== MESSAGES.en[key]);
    assert.ok(
      differing.length >= CAPTION_KEYS.length - 1,
      `'${lang}' still holds the English string for ${CAPTION_KEYS.length - differing.length} caption keys`,
    );
  }
});

test('the display modes and positions the menu offers are the ones the core resolves', () => {
  // The select is built from these keys; resolveCaptionDisplay() answers for
  // these values. A mode added on one side and not the other renders a row the
  // engine ignores.
  const labelled = {
    bilingual: 'captionModeBilingual',
    translation: 'captionModeTranslation',
    original: 'captionModeOriginal',
  };
  assert.deepEqual(core.CAPTION_DISPLAY_MODES.slice().sort(), Object.keys(labelled).sort());
  for (const key of Object.values(labelled)) {
    assert.ok(MESSAGES.en[key], `${key} has no label`);
  }
});
