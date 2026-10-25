// Blab Translation — the ONE document error-code → user-facing message map.
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

  // Read at call time, not load time: unit tests require this file on its own,
  // and every page loads shared/doc-jobs.js before it.
  function docJobs() {
    return globalThis.DocJobs || null;
  }

  // Codes whose answer is the same the second time: the file, the account or
  // the user's own decision is what is wrong, so a "Try again" would only
  // repeat the refusal.
  var NOT_RETRYABLE = [
    'unsupported_format', 'empty_document', 'file_too_large', 'pdf_too_large',
    'too_many_pages', 'page_count_unknown', 'encrypted_pdf', 'scanned_unsupported',
    'invalid_pdf', 'insufficient_points', 'feature_disabled', 'abandoned'
  ];

  /** A field of an error in any shape: flattened by toMessage(), or under details. */
  function field(error, name) {
    if (!error) return undefined;
    if (error[name] !== undefined && error[name] !== null) return error[name];
    return error.details ? error.details[name] : undefined;
  }

  /**
   * Server/client error codes → i18n message keys (see i18n/lang/*.js).
   *
   * `error` is optional: with only a code this answers the base key; with the
   * error it tells apart what the fields say (which format, whether the pages
   * were refunded, whether the server named its cap).
   */
  function pdfErrorMessageKey(code, error) {
    switch (code) {
      case 'insufficient_points': {
        // The refusal's quote says how long the document is and how many free
        // pages were left for it; without one there is nothing to count.
        var quote = error ? field(error, 'quote') : null;
        return quote && Number.isFinite(quote.pages) && Number.isFinite(quote.freePages)
          ? 'pdfErrInsufficientPages' : 'pdfErrInsufficientPoints';
      }
      case 'too_many_pages': {
        if (!error) return 'pdfErrTooManyPages';
        if (!field(error, 'maxPages')) return 'docErrTooManyPagesNoMax';
        var jobs = docJobs();
        var format = field(error, 'format');
        if (field(error, 'pageCount') && format && jobs && jobs.familyOf(format) === 'flow') {
          return 'docErrTooLongFlow';
        }
        return 'pdfErrTooManyPages';
      }
      case 'encrypted_pdf': return 'pdfErrEncrypted';
      case 'invalid_pdf':
      case 'invalid_source_key':
      case 'invalid_output':
      case 'invalid_operation_id':
      case 'missing_operation_id':
      case 'invalid_byte_size': return 'pdfErrInvalid';
      // The upload never arrived. The page re-uploads on retry, so this is a
      // network story, not a broken file.
      case 'missing_source': return 'pdfErrNetwork';
      case 'scanned_unsupported': return 'pdfErrScanned';
      case 'file_too_large':
      case 'pdf_too_large': return 'pdfErrTooLarge';
      case 'unsupported_format': {
        var known = docJobs();
        return known && known.isDocumentFormat(field(error, 'format'))
          ? 'docErrMismatch' : 'docErrUnsupported';
      }
      case 'empty_document': return 'docErrEmpty';
      case 'page_count_unknown': return 'docErrPageCountUnknown';
      case 'not_awaiting_confirm': return 'docErrNotAwaiting';
      case 'queue_timeout': return 'docErrQueueTimeout';
      case 'abandoned':
        return field(error, 'refunded') ? 'docErrAbandonedRefunded' : 'docErrAbandoned';
      case 'source_fetch_failed': return 'pdfErrSourceFetch';
      case 'engine_error':
      case 'delivery_unreadable': return 'pdfErrEngine';
      case 'budget_exceeded': return 'pdfErrBudget';
      case 'create_timeout':
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
      // The account's site base is not an http(s) address, so there is no
      // reader to open a finished job in.
      case 'invalid_site_base': return 'docErrSiteBase';
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
   * (fields under `details`), its toMessage() flattening (fields at the top
   * level), or a stored record error (`{code, message, maxPages?, ...}`).
   * `translate` is the page's `t` / the worker's key→string lookup.
   *
   * A placeholder whose number is unknown is never printed raw: the key choice
   * above already avoids the `{maxPages}` sentence when there is no cap.
   */
  function pdfErrorMessage(error, translate) {
    var code = error && error.code;
    var text = String(translate(pdfErrorMessageKey(code, error || {})) || '');
    if (text.indexOf('{max}') !== -1) {
      var jobs = docJobs();
      var bytes = field(error, 'maxBytes') ||
        (jobs ? jobs.maxBytesFor(field(error, 'format') || 'pdf') : 0);
      text = text.split('{max}').join(jobs && bytes ? jobs.megabyteLabel(bytes) : '');
    }
    ['maxPages', 'pageCount'].forEach(function (name) {
      var value = field(error, name);
      if (value !== undefined && value !== null) {
        text = text.split('{' + name + '}').join(String(value));
      }
    });
    var quote = field(error, 'quote');
    if (quote) {
      text = text.split('{pages}').join(String(quote.pages)).split('{left}').join(String(quote.freePages));
    }
    return text;
  }

  /**
   * What to say about a cancelled job. Not an error key: a cancellation is the
   * user's decision or the server handing the pages back, so every surface
   * words it without painting it red. One answer for the status line and the
   * notification alike.
   */
  function pdfAbandonedKey(error) {
    if (field(error, 'code') === 'queue_timeout') return 'docErrQueueTimeout';
    if (field(error, 'refunded')) return 'docErrAbandonedRefunded';
    return 'pdfStatusAbandoned';
  }

  /** Is "Try again" worth offering for this failure? */
  function isRetryablePdfFailure(error) {
    var code = error && error.code;
    return NOT_RETRYABLE.indexOf(code) === -1;
  }

  /**
   * A running job's stage word → the i18n key of the phase it belongs to.
   *
   * The words are the server's pipeline stage names, looked up exactly,
   * never shown raw: PDF runs parse, structure, (names,) translate, typeset,
   * emit; Word/EPUB/MOBI/TXT/Markdown run normalize, translate, rewrite, emit;
   * a document split into parts adds "merging" while they are joined back.
   * Layout, then translation, then writing the result is the whole visible
   * story, and it only ever moves forward: `emit` writes the result file, so
   * it reads as the last phase, not as translation again.
   *
   * No word yet still reads as queued (pdfStatusKey). A word missing here
   * (one the engine adds later) reads as the neutral "Translating…": the
   * stage is display-only — the service passes it through without reading its
   * meaning — so a new word on the server must not break the page.
   */
  var PDF_STAGE_KEYS = new Map([
    ['parse', 'pdfStageLayout'],
    ['structure', 'pdfStageLayout'],
    ['names', 'pdfStageTranslating'],
    ['normalize', 'pdfStageTranslating'],
    ['translate', 'pdfStageTranslating'],
    ['typeset', 'pdfStageTypesetting'],
    ['rewrite', 'pdfStageTypesetting'],
    ['emit', 'pdfStageTypesetting'],
    ['merging', 'pdfStageTypesetting']
  ]);

  /** A job view/record → the i18n key of what to show for it. */
  function pdfStatusKey(view) {
    // The local pending record: the click has landed, the bytes are still on
    // their way up, and there is no server job yet to have a status.
    if (view && view.pending && (!view.status || view.status === 'queued')) {
      return 'pdfStatusUploading';
    }
    switch (view && view.status) {
      case 'queued': return 'pdfStatusQueued';
      case 'running':
        // Started but no stage reported yet: the server has taken the job and
        // no worker has said what it is doing (while capacity is short the
        // server itself says `queued`). Reading this as "Translating…" would
        // step back to "Analyzing layout…" on the first report.
        if (!view.stage) return 'pdfStatusQueued';
        return PDF_STAGE_KEYS.get(view.stage) || 'pdfStageTranslating';
      // Waiting on the user, not on us: the document was longer than the
      // pages reserved for it, and nothing moves until they answer.
      case 'awaiting_confirm': return 'docStatusAwaitingConfirm';
      case 'succeeded': return 'pdfStatusSucceeded';
      case 'failed': return 'pdfStatusFailed';
      case 'abandoned': return 'pdfStatusAbandoned';
      default: return 'pdfStatusQueued';
    }
  }

  /**
   * The one status line every surface draws for a job: `{text, isError}`.
   *
   * Only a failure is an error. A cancelled task is the user's decision (or
   * the server giving the pages back), so it is worded but never painted red;
   * the popup, the settings page and the job card all ask this instead of each
   * deciding what is red.
   */
  function pdfStatusLine(view, t) {
    var status = view && view.status;
    if (status === 'failed') {
      return { text: pdfErrorMessage(view.error || {}, t), isError: true };
    }
    if (status === 'abandoned') {
      return { text: t(pdfAbandonedKey(view.error || {})), isError: false };
    }
    return { text: t(pdfStatusKey(view)), isError: false };
  }

  var api = {
    pdfErrorMessageKey: pdfErrorMessageKey,
    pdfErrorMessage: pdfErrorMessage,
    pdfAbandonedKey: pdfAbandonedKey,
    isRetryablePdfFailure: isRetryablePdfFailure,
    pdfStatusKey: pdfStatusKey,
    pdfStatusLine: pdfStatusLine
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof globalThis !== 'undefined') {
    globalThis.AI_TRANSLATOR_PDF_ERRORS = api;
  }
})();
