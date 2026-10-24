// Blab Translation — what a used-up page allowance says beyond the refusal.
//
// A refusal for spent free pages (`insufficient_points`) reaches four surfaces:
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

  var api = { formatResetDate: formatResetDate, offerParts: offerParts };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof globalThis !== 'undefined') {
    globalThis.QuotaCopy = api;
  }
})();
