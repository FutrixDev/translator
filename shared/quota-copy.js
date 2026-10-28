// Blab Translation — the page allowance's refusals, and what they say beyond
// the refusal itself.
//
// The allowance refuses with two codes, written once here as REFUSALS:
// `insufficient_points` (the free pages are spent and the account has no
// credits; a page that did not run) and `insufficient_credits` (a comic job
// priced up front and refused before anything was created, with the
// shortfall). background/account-actions.js maps both to "View plans" and
// fetches their numbers; the comic overlay words both the same.
//
// Such a refusal reaches four surfaces:
// the document upload page, the popup, the PDF notification and the comic
// overlay. Each prints the same two extra sentences — when the free pages come
// back and what a plan holds — and the same "Translate again after {date}"
// label for the button that only closes the prompt. The numbers arrive on the
// error (`resetsAt`, `planPages`, filled in by background/account-actions.js);
// none is written here.
//
// Dual-mode like shared/pdf-errors.js: pages and content scripts load it with a
// plain <script>, the service worker imports it for its globalThis side effect.
(function () {
  'use strict';

  /** A reset date in the UI language ("Nov 1"), or null when there is none to read. */
  function formatResetDate(iso, lang) {
    if (!iso) return null;
    var at = new Date(iso);
    if (Number.isNaN(at.getTime())) return null;
    return at.toLocaleDateString(lang || undefined, { month: 'short', day: 'numeric' });
  }

  /**
   * The sentences and labels a surface adds to a refusal: `reset` and `plan`
   * ('' when the error does not carry that number), and `later`, the label of
   * the button that dismisses — "Translate again after {date}", or the plain
   * dismiss label when the date is unknown.
   */
  function offerParts(error, t, lang) {
    var date = formatResetDate(error && error.resetsAt, lang);
    var pages = error && error.planPages;
    return {
      reset: date ? t('quotaResetsOn').replace('{date}', date) : '',
      plan: Number.isFinite(pages) ? t('quotaPlanPages').replace('{pages}', String(pages)) : '',
      later: date ? t('quotaTryAfter').replace('{date}', date) : t('comicDismiss')
    };
  }

  /** The allowance's refusal codes. */
  var REFUSALS = Object.freeze(['insufficient_points', 'insufficient_credits']);

  /** Whether `code` is one of the allowance's refusals. */
  function isRefusal(code) {
    return REFUSALS.indexOf(code) !== -1;
  }

  var api = { REFUSALS: REFUSALS, formatResetDate: formatResetDate, isRefusal: isRefusal, offerParts: offerParts };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof globalThis !== 'undefined') {
    globalThis.QuotaCopy = api;
  }
})();
