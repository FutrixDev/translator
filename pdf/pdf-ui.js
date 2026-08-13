// AI Translator — shared helpers for the PDF surfaces (popup + upload page).
//
// A classic script on purpose: both pages load it with a plain <script> tag,
// the same way i18n/messages.js is shared. The error map itself lives in
// shared/pdf-errors.js (loaded before this file), so the service worker and
// the pages read the SAME table instead of two copies that drift.
(function () {
  'use strict';

  const { pdfErrorMessageKey, pdfErrorMessage } = globalThis.AI_TRANSLATOR_PDF_ERRORS;

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

  /**
   * The web library's URL for a job — the page that renders the document
   * itself, original and translation side by side, which the extension cannot
   * do (Chrome's PDF viewer is an out-of-process iframe with a closed shadow
   * DOM).
   *
   * Empty string rather than a broken link when there is nowhere to point:
   *
   * - no base yet (the service worker has not answered), or one that is not
   *   http(s) — the base comes out of chrome.storage, so a value that could
   *   turn an <a href> into `javascript:` never gets built into one;
   * - a pending record, whose `local:<operationId>` id names no server job.
   *   The library treats an unknown `?job=` as a hint and falls back to the
   *   newest document, so such a link would silently open the wrong one.
   */
  function pdfLibraryUrl(base, jobId) {
    let origin;
    try {
      origin = new URL(String(base || ''));
    } catch {
      return '';
    }
    if (!/^https?:$/.test(origin.protocol)) return '';
    const path = `${origin.origin}/settings/pdf`;
    if (jobId === undefined || jobId === null || jobId === '') return path;
    const id = String(jobId);
    if (id.startsWith('local:')) return '';
    return `${path}?job=${encodeURIComponent(id)}`;
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
    pdfErrorMessage,
    pdfStatusKey,
    isPdfJobActive,
    isLikelyPdfUrl,
    pdfLibraryUrl,
    pdfFileNameFromUrl
  };
})();
