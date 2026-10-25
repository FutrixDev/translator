// Blab Translation — shared helpers for the document surfaces (popup, upload page, settings).
//
// A classic script on purpose: both pages load it with a plain <script> tag,
// the same way i18n/messages.js is shared. The error map and the status line
// live in shared/pdf-errors.js (loaded before this file), so the service worker
// and the pages read the SAME table instead of two copies that drift.
(function () {
  'use strict';

  const { pdfErrorMessageKey, pdfErrorMessage, pdfStatusKey, pdfStatusLine, isRetryablePdfFailure } =
    globalThis.AI_TRANSLATOR_PDF_ERRORS;
  // Formats and the status sets have one owner, shared/doc-jobs.js, loaded
  // before shared/pdf-errors.js on every page that loads this file.
  if (!globalThis.DocJobs) throw new Error('pdf-ui.js needs shared/doc-jobs.js loaded first');
  // 网址那两问的唯一实现（shared/pdf-url.js，装在这个文件之前）。这里曾经
  // 各抄了一份，其中一份还注着「Mirrors … in background/background.js」——
  // 指的函数早搬走了。
  if (!globalThis.PdfUrl) throw new Error('pdf-ui.js 要先装 shared/pdf-url.js');
  const { isLikelyPdfUrl, pdfFileNameFromUrl } = globalThis.PdfUrl;

  globalThis.AI_TRANSLATOR_PDF_UI = {
    pdfErrorMessageKey,
    pdfErrorMessage,
    pdfStatusKey,
    pdfStatusLine,
    isRetryablePdfFailure,
    isLikelyPdfUrl,
    pdfFileNameFromUrl
  };
})();
