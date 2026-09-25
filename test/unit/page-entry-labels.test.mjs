// The whole-page entries say the same thing everywhere, and only the one that
// widens the scope says "whole".
//
// Page translation defaults to the main content (pageTranslateScope: 'main').
// Four entries start it:
//
//   - the float ball's first row       translatePage
//   - the context menu                 contextTranslatePage
//   - the popup button                 translateCurrentPage
//   - the float ball's second row      floatMenuTranslateWholePage
//
// The first three run the default scope; only the fourth sets the one-page
// override to 'page'. zh-CN, zh-TW, ja and ko used to label the context menu
// with the fourth entry's wording ("translate the whole page"), so the
// right-click item promised the wider scope and ran the narrower one.
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';

await import('../../i18n/messages.js');
const { I18N_MESSAGES, UI_LANGUAGES } = globalThis;

test('the context menu item reads exactly like the float ball item, in every locale', () => {
  assert.equal(UI_LANGUAGES.length, 10);
  for (const lang of UI_LANGUAGES) {
    const table = I18N_MESSAGES[lang];
    assert.ok(table.translatePage, `${lang}: translatePage is missing`);
    assert.equal(table.contextTranslatePage, table.translatePage, `${lang}: the context menu and the float ball name the same action differently`);
  }
});

test('no default-scope entry borrows the whole-page wording', () => {
  for (const lang of UI_LANGUAGES) {
    const table = I18N_MESSAGES[lang];
    const whole = table.floatMenuTranslateWholePage;
    assert.ok(whole, `${lang}: floatMenuTranslateWholePage is missing`);
    for (const key of ['translatePage', 'contextTranslatePage', 'translateCurrentPage']) {
      assert.ok(table[key], `${lang}: ${key} is missing`);
      assert.notEqual(table[key], whole, `${lang}: ${key} promises the whole page but runs the main-content scope`);
    }
  }
});
