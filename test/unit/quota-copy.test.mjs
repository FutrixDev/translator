// A used-up page allowance: what the refusal says and which entry it offers.
//
// shared/quota-copy.js prints the two sentences every surface adds (reset
// date, plan allowance) and the dismiss label; background/account-actions.js
// is the one table that maps the refusal to "View plans". The numbers come from
// the server, so the tests check that a missing one is left out, never guessed.
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { popupSource, uploadPageSource, comicSource, workerSource, repoSource } from './helpers/sources.mjs';

await import('../../i18n/messages.js');
await import('../../shared/quota-copy.js');
await import('../../shared/doc-jobs.js');
await import('../../shared/pdf-errors.js');
await import('../../shared/site-links.js');
const { QuotaCopy, AI_TRANSLATOR_PDF_ERRORS: errors, SiteLinks } = globalThis;
const t = (key) => globalThis.getMessage(key, 'en');
const RESET = '2026-11-01T12:00:00Z';

test('the reset date is read in the UI language, and a missing or broken one is no date', () => {
  assert.equal(QuotaCopy.formatResetDate(RESET, 'en'), 'Nov 1');
  assert.equal(QuotaCopy.formatResetDate(RESET, 'de'), '1. Nov.');
  for (const iso of [undefined, null, '', 'not a date']) {
    assert.equal(QuotaCopy.formatResetDate(iso, 'en'), null, String(iso));
  }
});

test('the offer prints each number it was given and leaves out each one it was not', () => {
  assert.deepEqual(QuotaCopy.offerParts({ resetsAt: RESET, planPages: 1000 }, t, 'en'), {
    reset: 'Free pages reset on Nov 1.',
    plan: 'Plans include 1000 pages a month.',
    later: 'Translate again after Nov 1',
  });
  assert.deepEqual(QuotaCopy.offerParts({}, t, 'en'), { reset: '', plan: '', later: t('comicDismiss') });
  assert.deepEqual(QuotaCopy.offerParts({ planPages: '1000' }, t, 'en').plan, '', 'a string is not a count');
});

test('the refusal counts the document against what was left, when the quote says both', () => {
  assert.equal(
    errors.pdfErrorMessage({ code: 'insufficient_points', quote: { pages: 250, freePages: 113 } }, t),
    'This document is 250 pages; 113 free pages left this month');
  assert.equal(
    errors.pdfErrorMessage({ code: 'insufficient_points', details: { quote: { pages: 250, freePages: 0 } } }, t),
    'This document is 250 pages; 0 free pages left this month');
  assert.equal(errors.pdfErrorMessageKey('insufficient_points', { quote: { pages: 250 } }), 'pdfErrInsufficientPoints');
  assert.equal(errors.pdfErrorMessageKey('insufficient_points'), 'pdfErrInsufficientPoints');
});

test('every locale renders the offer with no placeholder left over', () => {
  const holes = (text) => [...new Set(String(text).match(/\{[a-zA-Z]+\}/g) || [])].sort().join(',');
  const en = globalThis.I18N_MESSAGES.en;
  for (const [lang, table] of Object.entries(globalThis.I18N_MESSAGES)) {
    for (const key of ['pdfErrInsufficientPages', 'quotaResetsOn', 'quotaPlanPages', 'quotaTryAfter', 'quotaViewPlans']) {
      assert.ok(table[key], `${lang} is missing ${key}`);
      assert.equal(holes(table[key]), holes(en[key]), `${lang}.${key} placeholders differ from en`);
    }
    const tr = (key) => globalThis.getMessage(key, lang);
    for (const text of Object.values(QuotaCopy.offerParts({ resetsAt: RESET, planPages: 1000 }, tr, lang))) {
      assert.ok(text, `${lang} rendered an empty offer part`);
      assert.doesNotMatch(text, /\{[a-zA-Z]+\}/, `${lang}: ${text}`);
    }
  }
});

test('one table maps a refusal to its entry; spent pages offer the plans', () => {
  const worker = workerSource();
  assert.match(worker, /const ACCOUNT_ACTIONS = Object\.freeze\(\{[^}]*insufficient_points: 'subscribe'/);
  assert.equal([...worker.matchAll(/ACCOUNT_ACTIONS = /g)].length, 1, 'a second action table');
  // The plan allowance is read from the public rates, never written down.
  assert.match(worker, /apiFetch\('\/api\/billing\/rates'\)/);
  assert.match(worker, /planQuotas/);
});

test('each surface tags the plans link with the feature that ran out', () => {
  assert.ok(SiteLinks.MEDIUMS.includes('pdf_quota') && SiteLinks.MEDIUMS.includes('comic_quota'));
  for (const [name, source, via] of [
    ['popup', popupSource(), 'pdf_quota'],
    ['upload page', uploadPageSource(), 'pdf_quota'],
    ['comic overlay', comicSource(), 'comic_quota'],
  ]) {
    assert.match(source, new RegExp(`action: 'subscribe', via: '${via}'`), name);
  }
  assert.match(workerSource(), /runAccountAction\(action, 'pdf_quota'\)/, 'the notification button');
});

test('every surface that shows the offer loads quota-copy.js', () => {
  for (const page of ['pdf/upload.html', 'popup/popup.html', 'options/options.html']) {
    assert.match(repoSource(page), /<script src="\.\.\/shared\/quota-copy\.js"><\/script>/, page);
  }
  assert.ok(JSON.parse(repoSource('manifest.json')).content_scripts
    .some((entry) => entry.js?.includes('shared/quota-copy.js')), 'manifest content scripts');
  assert.match(repoSource('background/pdf-notify.js'), /^import '\.\.\/shared\/quota-copy\.js';$/m);
});
