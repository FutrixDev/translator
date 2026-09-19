// A ratchet on the ten locales.
//
// getMessage() falls back to English for a key a locale does not have, so a
// missing translation is invisible: the settings page just quietly turns half
// English for everyone outside en/zh-CN. Today the Translation Engine section,
// the caption-style section and a handful of hints are in that state.
//
// This file does not demand they be fixed now. It demands the list not grow —
// a new English-only key fails here, in the PR that adds it, instead of being
// found by a user in Lisbon. PR-10 empties KNOWN_GAP; nothing may be added.
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';

await import('../../i18n/messages.js');
const { I18N_MESSAGES, UI_LANGUAGES, getMessage } = globalThis;

// Sent to the translation model, never shown to anyone. They are instructions
// in English because that is what they are written in — a Russian rendering of
// "reply with the translation only" is not a better instruction, and the text
// the model actually translates carries its own language. Deliberately English
// in every locale, so PR-10 must not "fill these in".
const MODEL_FACING = new Set(['promptStandard', 'promptLiteral', 'promptCreative']);

// Real UI strings that are English-only today. Every one of these is visible
// in options.html. This set may only shrink.
const KNOWN_GAP = new Set([
  // Translation Engine section — added with the built-in engine, en only
  'translationEngine', 'engineBuiltin', 'engineCustomAi', 'hintTranslationEngine',
  'builtinLanguagePack', 'downloadLanguagePack', 'builtinReady', 'builtinChecking',
  'builtinDownloadable', 'builtinDownloading', 'builtinDownloadComplete',
  'builtinDownloadFailed',
  // YouTube caption style section
  'youtubeCaptionStyle', 'captionFontColor', 'captionBgColor', 'captionBgOpacity',
  'captionPreviewOriginal', 'captionPreviewTranslated', 'closeCaption',
  'showYoutubeOriginalCaption', 'hintShowYoutubeOriginalCaption',
  'hintCaptionDragResize',
  // Selection hotkey and display
  'selectionTranslationHotkey', 'hintSelectionTranslationHotkey', 'hotkeyConflict',
  'showTranslationOnly', 'hintShowTranslationOnly'
]);

const englishKeys = Object.keys(I18N_MESSAGES.en);

test('no locale is missing a key that is not already on the list', () => {
  const added = [];
  for (const lang of UI_LANGUAGES) {
    if (lang === 'en') continue;
    for (const key of englishKeys) {
      if (key in I18N_MESSAGES[lang]) continue;
      if (MODEL_FACING.has(key) || KNOWN_GAP.has(key)) continue;
      added.push(`${lang}.${key}`);
    }
  }
  assert.deepEqual(added, [],
    'new English-only UI strings. Add the ten translations — do not add them to KNOWN_GAP.');
});

test('the list has no entries that are already translated', () => {
  // Keeps the ratchet honest in the other direction: once PR-10 translates a
  // key, it comes off the list, and the list reaches empty rather than rotting
  // into a set of names nobody can account for.
  const stale = [...KNOWN_GAP].filter(key =>
    UI_LANGUAGES.every(lang => key in I18N_MESSAGES[lang]));
  assert.deepEqual(stale, [], 'translated now — delete these from KNOWN_GAP');

  const unknown = [...KNOWN_GAP, ...MODEL_FACING].filter(key => !(key in I18N_MESSAGES.en));
  assert.deepEqual(unknown, [], 'no longer exist in en — delete these from the lists');
});

test('a locale never carries a key English does not have', () => {
  // The other direction is not a fallback, it is dead weight: nothing reads it,
  // and it usually means a key was renamed in en and left behind elsewhere.
  const orphans = [];
  for (const lang of UI_LANGUAGES) {
    if (lang === 'en') continue;
    for (const key of Object.keys(I18N_MESSAGES[lang])) {
      if (!(key in I18N_MESSAGES.en)) orphans.push(`${lang}.${key}`);
    }
  }
  assert.deepEqual(orphans, []);
});

test('the fallback chain ends at a sentence, never at a key name', () => {
  // getMessage() is the only reader, and the worst thing it can do is return
  // the key itself — 'hintTranslationEngine' rendered into the settings page.
  for (const lang of UI_LANGUAGES) {
    for (const key of englishKeys) {
      assert.equal(typeof getMessage(key, lang), 'string');
      assert.notEqual(getMessage(key, lang), key, `${lang}.${key} renders as its own name`);
    }
  }
  // Including for a locale we do not ship at all.
  assert.equal(getMessage('ready', 'nl-NL'), I18N_MESSAGES.en.ready);
  // And a key nobody defined is returned as-is rather than throwing, so a typo
  // in a template is visible instead of blanking the page.
  assert.equal(getMessage('noSuchKeyAnywhere', 'en'), 'noSuchKeyAnywhere');
});

test('zh-CN is complete, because it is the only locale with a live audience', () => {
  const missing = englishKeys.filter(key =>
    !(key in I18N_MESSAGES['zh-CN']) && !MODEL_FACING.has(key));
  assert.deepEqual(missing, []);
});
