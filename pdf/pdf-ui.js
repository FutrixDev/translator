// Blab Translation — shared helpers for the document surfaces (popup, upload page, settings).
//
// A classic script on purpose: both pages load it with a plain <script> tag,
// the same way i18n/messages.js is shared. The error map itself lives in
// shared/pdf-errors.js (loaded before this file), so the service worker and
// the pages read the SAME table instead of two copies that drift.
(function () {
  'use strict';

  const { pdfErrorMessageKey, pdfErrorMessage, pdfAbandonedKey, isRetryablePdfFailure } =
    globalThis.AI_TRANSLATOR_PDF_ERRORS;
  // Formats and the status sets have one owner, shared/doc-jobs.js, loaded
  // before shared/pdf-errors.js on every page that loads this file.
  if (!globalThis.DocJobs) throw new Error('pdf-ui.js needs shared/doc-jobs.js loaded first');
  // 网址那两问的唯一实现（shared/pdf-url.js，装在这个文件之前）。这里曾经
  // 各抄了一份，其中一份还注着「Mirrors … in background/background.js」——
  // 指的函数早搬走了。
  if (!globalThis.PdfUrl) throw new Error('pdf-ui.js 要先装 shared/pdf-url.js');
  const { isLikelyPdfUrl, pdfFileNameFromUrl } = globalThis.PdfUrl;

  /**
   * A running job's stage word → the i18n key of the phase it belongs to.
   *
   * The words are the engine's, looked up exactly, never shown raw:
   * - translator-saas server/containers/pdf-worker/worker/engine/pipeline.py
   *   `STAGES` (PDF: parse, structure, translate, typeset, emit) and
   *   `FLOW_STAGES` (Word/EPUB/MOBI/TXT/Markdown: normalize, translate,
   *   rewrite, emit);
   * - translator-saas server/containers/pdf-worker/worker/server.py, the
   *   `names` pass that builds the glossary before translation;
   * - translator-saas server/lib/pdf-copy.ts `PDF_MERGING_STAGE` ("merging",
   *   the split parts being joined back into one file).
   * Layout, then translation, then writing the result is the whole visible
   * story, and it only ever moves forward: `emit` writes the result file, so
   * it reads as the last phase, not as translation again.
   *
   * A word missing here (none yet, or one the engine adds later) reads as the
   * neutral "Translating…": the stage is display-only — the Worker forwards it
   * without reading its meaning — so a new word on the server must not break
   * the page.
   */
  const PDF_STAGE_KEYS = new Map([
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
    const status = view && view.status;
    if (status === 'failed') {
      return { text: pdfErrorMessage(view.error || {}, t), isError: true };
    }
    if (status === 'abandoned') {
      return { text: t(pdfAbandonedKey(view.error || {})), isError: false };
    }
    return { text: t(pdfStatusKey(view)), isError: false };
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
    const path = `${origin.origin}/app/settings/pdf`;
    if (jobId === undefined || jobId === null || jobId === '') return path;
    const id = String(jobId);
    if (id.startsWith('local:')) return '';
    return `${path}?job=${encodeURIComponent(id)}`;
  }

  globalThis.AI_TRANSLATOR_PDF_UI = {
    pdfErrorMessageKey,
    pdfErrorMessage,
    pdfStatusKey,
    pdfStatusLine,
    isRetryablePdfFailure,
    isLikelyPdfUrl,
    pdfLibraryUrl,
    pdfFileNameFromUrl
  };
})();
