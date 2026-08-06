// AI Translator — shared helpers for the PDF surfaces (popup + upload page).
//
// A classic script on purpose: both pages load it with a plain <script> tag,
// the same way i18n/messages.js is shared. The service worker has its own
// module-side copy of the error map in background/pdf-client.js.
(function () {
  'use strict';

  /** Server/client error codes → i18n message keys (see i18n/messages.js). */
  function pdfErrorMessageKey(code) {
    switch (code) {
      case 'insufficient_points': return 'pdfErrInsufficientPoints';
      case 'too_many_pages': return 'pdfErrTooManyPages';
      case 'encrypted_pdf': return 'pdfErrEncrypted';
      case 'invalid_pdf':
      case 'invalid_source_key':
      case 'invalid_output':
      case 'missing_source': return 'pdfErrInvalid';
      case 'scanned_unsupported': return 'pdfErrScanned';
      case 'pdf_too_large': return 'pdfErrTooLarge';
      case 'source_fetch_failed': return 'pdfErrSourceFetch';
      case 'engine_error': return 'pdfErrEngine';
      case 'budget_exceeded': return 'pdfErrBudget';
      case 'container_unavailable':
      case 'gateway_unavailable':
      case 'storage_unavailable': return 'pdfErrUnavailable';
      case 'unauthorized': return 'pdfSignInRequired';
      case 'feature_disabled': return 'featureDisabled';
      case 'upload_failed':
      case 'network_error':
      case 'no_response': return 'pdfErrNetwork';
      default: return 'pdfFailed';
    }
  }

  /**
   * A job view/record → the i18n key of what to show for it.
   *
   * The engine's stage names are internal strings (pdf2zh event stages), so
   * they are matched loosely and never shown raw: layout detection, then
   * translation, then retypesetting is the whole visible story.
   */
  function pdfStatusKey(view) {
    // The local pending record: the click has landed, the bytes are still on
    // their way up, and there is no server job yet to have a status.
    if (view && view.pending && (!view.status || view.status === 'queued')) {
      return 'pdfStatusUploading';
    }
    switch (view && view.status) {
      case 'queued': return 'pdfStatusQueued';
      case 'running': {
        const stage = String(view.stage || '').toLowerCase();
        if (/layout|parse|detect|analy/.test(stage)) return 'pdfStageLayout';
        if (/typeset|render|assemble|compose|write|export|merge|save/.test(stage)) return 'pdfStageTypesetting';
        return 'pdfStageTranslating';
      }
      case 'succeeded': return 'pdfStatusSucceeded';
      case 'failed': return 'pdfStatusFailed';
      case 'abandoned': return 'pdfStatusAbandoned';
      default: return 'pdfStatusQueued';
    }
  }

  function isPdfJobActive(view) {
    return !!view && (view.status === 'queued' || view.status === 'running');
  }

  /** Mirrors isLikelyPdfUrl in background/background.js. */
  function isLikelyPdfUrl(url) {
    if (!url) return false;
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    if (!/^(https?|file):$/.test(parsed.protocol)) return false;
    if (/\.pdf$/i.test(parsed.pathname)) return true;
    if (/(^|\.)arxiv\.org$/i.test(parsed.hostname) && /^\/pdf\//.test(parsed.pathname)) return true;
    return false;
  }

  function pdfFileNameFromUrl(url) {
    try {
      const parsed = new URL(url);
      const segment = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() || '');
      if (segment) return /\.pdf$/i.test(segment) ? segment : `${segment}.pdf`;
    } catch {
      // Fall through to the generic name.
    }
    return 'document.pdf';
  }

  globalThis.AI_TRANSLATOR_PDF_UI = {
    pdfErrorMessageKey,
    pdfStatusKey,
    isPdfJobActive,
    isLikelyPdfUrl,
    pdfFileNameFromUrl
  };
})();
