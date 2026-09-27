// Guard for the hint under a built-in "never" site in Settings (R33 D-360 F2).
//
// SiteRules.blockReason() answers BUILTIN_NEVER only for automatic translation:
// "Translate Page" in the popup and Alt+A still translate such a page when the
// reader asks. The hint used to say these pages are never translated, full
// stop, which reads as if the popup button would not work either. Pin that
// every language says "automatically" in its own words by naming its own
// popup button, and pin the English wording.
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';

await import('../../i18n/messages.js');
const MESSAGES = globalThis.I18N_MESSAGES;
const LANGS = globalThis.UI_LANGUAGES;

test('the built-in never hint says automatic only and points at "Translate Page" (R33 D-360 F2)', () => {
  const en = MESSAGES.en.siteRulesBuiltinNeverHint;
  assert.match(en, /never translated automatically/);
  assert.ok(en.includes(`"${MESSAGES.en.translatePage}"`), en);
  assert.doesNotMatch(en, /never translated in place/);
  for (const lang of LANGS) {
    const hint = MESSAGES[lang].siteRulesBuiltinNeverHint;
    assert.ok(hint, `${lang} has no siteRulesBuiltinNeverHint`);
    assert.ok(hint.includes(MESSAGES[lang].translatePage), `${lang}: ${hint}`);
  }
});
