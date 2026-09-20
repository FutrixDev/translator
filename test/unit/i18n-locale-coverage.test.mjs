// A ratchet on the ten locales.
//
// getMessage() falls back to English for a key a locale does not have, so a
// missing translation is invisible: the settings page just quietly turns half
// English for everyone outside en/zh-CN. The Translation Engine section, the
// caption-style section and a handful of hints used to be in that state.
//
// KNOWN_GAP is empty now — PR-10 translated the last twenty-seven. It stays
// empty: a new English-only key fails here, in the PR that adds it, instead of
// being found by a user in Lisbon. Adding a name back to the set is not how a
// failure here gets fixed; the ten translations are.
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

// Empty, and meant to stay that way: every string visible in options.html is
// translated in all ten locales. It is kept as a set rather than deleted
// because the two tests below are what hold the line, and a future gap that
// genuinely cannot be closed in its own PR has somewhere honest to be listed
// — visible, countable, and failing the moment it is translated.
const KNOWN_GAP = new Set([]);

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
