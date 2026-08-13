// AI Translator — the ONE PDF error-code → user-facing message map.
//
// Dual-mode on purpose, exactly like i18n/messages.js: the popup, the upload
// page and the options page load it with a plain <script> tag, while the
// service worker imports it as a module for its globalThis side effect
// (re-exported from background/pdf-client.js). It contains no import/export
// syntax so both loaders accept it.
//
// This file exists because the map used to live twice — once in
// background/pdf-client.js and once in pdf/pdf-ui.js — and two copies of a
// code table drift: the day the server grew a new error code, both copies
// missed it and every surface fell back to a generic "PDF translation failed".
(function () {
  'use strict';

  // The server cap today, used only when an old server answers without a
  // maxPages field. The real number always comes from the error payload
  // (server/lib/pdf/source.ts sends { maxPages, pageCount }), so this constant
  // going stale costs one wrong number in one message, not a wrong refusal.
  var FALLBACK_MAX_PAGES = 32;

  /** Server/client error codes → i18n message keys (see i18n/messages.js). */
  function pdfErrorMessageKey(code) {
    switch (code) {
      case 'insufficient_points': return 'pdfErrInsufficientPoints';
      case 'too_many_pages': return 'pdfErrTooManyPages';
      case 'encrypted_pdf': return 'pdfErrEncrypted';
      case 'invalid_pdf':
      case 'invalid_source_key':
      case 'invalid_output':
      case 'invalid_operation_id':
      case 'missing_operation_id':
      case 'invalid_byte_size':
      case 'missing_source': return 'pdfErrInvalid';
      case 'scanned_unsupported': return 'pdfErrScanned';
      case 'pdf_too_large': return 'pdfErrTooLarge';
      case 'source_fetch_failed': return 'pdfErrSourceFetch';
      case 'engine_error':
      case 'delivery_unreadable': return 'pdfErrEngine';
      case 'budget_exceeded': return 'pdfErrBudget';
      case 'container_unavailable':
      case 'gateway_unavailable':
      case 'source_download_failed':
      case 'storage_unavailable': return 'pdfErrUnavailable';
      // The container refused the hand-off (busy, restarting). The job was
      // refunded and the operation id released — a later click starts clean.
      case 'dispatch_rejected': return 'pdfErrBusy';
      // The replayed operation id names a job that already ended (or a billing
      // reservation already settled — e.g. the job row was deleted from the
      // web history). The client releases the id on seeing this, so "try
      // again" is literally the fix.
      case 'operation_already_finished':
      case 'job_conflict': return 'pdfErrRetry';
      // Same operation id, different settings (target language changed since
      // the first attempt). Also releases the id; the next click is a new job.
      case 'output_conflict': return 'pdfErrOutputConflict';
      case 'unauthorized': return 'pdfSignInRequired';
      case 'feature_disabled': return 'featureDisabled';
      case 'upload_failed':
      case 'network_error':
      case 'no_response': return 'pdfErrNetwork';
      default:
        // apiFetch mints http_<status> for bodies that carry no error code.
        if (/^http_5\d\d$/.test(String(code || ''))) return 'pdfErrUnavailable';
        return 'pdfFailed';
    }
  }

  /**
   * The rendered message for an error-like object, in one step.
   *
   * `error` is any of the shapes this codebase passes around: a ComicApiError
   * (`details.maxPages`), its toMessage() flattening (`maxPages` at top level),
   * or a stored record error (`{code, message}` — no details, hence the
   * fallback). `translate` is the page's `t` / the worker's key→string lookup.
   */
  function pdfErrorMessage(error, translate) {
    var code = error && error.code;
    var text = String(translate(pdfErrorMessageKey(code)) || '');
    if (text.indexOf('{maxPages}') !== -1) {
      var max = error && (error.maxPages ||
        (error.details && error.details.maxPages));
      text = text.replace('{maxPages}', String(max || FALLBACK_MAX_PAGES));
    }
    return text;
  }

  var api = { pdfErrorMessageKey: pdfErrorMessageKey, pdfErrorMessage: pdfErrorMessage };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof globalThis !== 'undefined') {
    globalThis.AI_TRANSLATOR_PDF_ERRORS = api;
  }
})();
