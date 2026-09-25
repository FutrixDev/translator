// Blab Translation — the ONE place the extension knows what a document job is.
//
// Six formats, their limits and MIME types, the 68-byte sniff, the job status
// sets, and where "open this job" leads. The upload page, the popup, the
// settings page and the service worker all ask this module; none of them keeps
// a copy. The format half is a line-for-line port of translator-saas
// server/lib/pdf/format.ts (DOCUMENT_FORMATS, CONTENT_TYPES, megabyteLabel,
// formatFromFileName, SNIFF_BYTES, matchesDeclaredFormat); the byte limits
// mirror server/lib/pdf/env.ts, because the server has no endpoint that
// publishes them.
//
// Dual-mode like shared/pdf-errors.js: pages load it with a <script> tag, the
// service worker imports it for its globalThis side effect. No import/export
// syntax, so both loaders accept it.
(function () {
  'use strict';

  var MIB = 1048576;

  // format.ts:52 — the order is the server's.
  var DOCUMENT_FORMATS = Object.freeze(['pdf', 'docx', 'epub', 'txt', 'md', 'mobi']);

  // format.ts:133–138, verbatim.
  var CONTENT_TYPES = Object.freeze({
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    epub: 'application/epub+zip',
    txt: 'text/plain',
    md: 'text/markdown',
    mobi: 'application/x-mobipocket-ebook'
  });

  // env.ts: e-books 50 MiB, plain text 10 MiB. PDF is 30 MiB rather than the
  // server's 300 because the server only counts pages itself up to
  // pdfInspectMaxBytes (30 MiB); a larger PDF would need a page count from
  // here, and counting PDF pages locally is out of scope.
  var MAX_BYTES = Object.freeze({
    pdf: 30 * MIB,
    docx: 50 * MIB,
    epub: 50 * MIB,
    mobi: 50 * MIB,
    txt: 10 * MIB,
    md: 10 * MIB
  });

  // Every extension the picker offers, canonical first per format.
  var EXTENSIONS = Object.freeze({
    pdf: ['pdf'],
    docx: ['docx'],
    epub: ['epub'],
    mobi: ['mobi', 'azw3'],
    txt: ['txt'],
    md: ['md', 'markdown']
  });

  var MEASURABLE = Object.freeze(['docx', 'epub', 'txt', 'md']);

  /** env.ts: the flow-document cap, in standard pages of 3000 characters. */
  var FLOW_MAX_STANDARD_PAGES = 800;

  function isDocumentFormat(value) {
    return typeof value === 'string' && DOCUMENT_FORMATS.indexOf(value) !== -1;
  }

  /** format.ts familyOf: a PDF has real pages, everything else reflows. */
  function familyOf(format) {
    return format === 'pdf' ? 'fixed' : 'flow';
  }

  /** format.ts:105 — MOBI is read on the website only; nothing is written back. */
  function writesBackDocument(format) {
    return format !== 'mobi';
  }

  function contentTypeFor(format) {
    return CONTENT_TYPES[format] || '';
  }

  function extensionFor(format) {
    return EXTENSIONS[format] ? EXTENSIONS[format][0] : '';
  }

  function maxBytesFor(format) {
    return MAX_BYTES[format] || 0;
  }

  function isMeasurable(format) {
    return MEASURABLE.indexOf(format) !== -1;
  }

  /** For <input accept>: every extension of every format, with its dot. */
  function acceptList() {
    var out = [];
    ['pdf', 'docx', 'epub', 'mobi', 'txt', 'md'].forEach(function (format) {
      EXTENSIONS[format].forEach(function (ext) { out.push('.' + ext); });
    });
    return out.join(',');
  }

  /** format.ts:192, verbatim: one decimal, none when it is whole. */
  function megabyteLabel(bytes) {
    var mb = Math.round((bytes / 1048576) * 10) / 10;
    return (Number.isInteger(mb) ? mb : mb.toFixed(1)) + ' MB';
  }

  /** format.ts:238, verbatim: the last extension, two aliases, else null. */
  function formatFromFileName(fileName) {
    if (!fileName) return null;
    var ext = String(fileName).toLowerCase().split('.').pop() || '';
    if (ext === 'markdown') return 'md';
    if (ext === 'azw3') return 'mobi';
    return isDocumentFormat(ext) ? ext : null;
  }

  // format.ts:257 onward — the sniff, verbatim.
  var SNIFF_BYTES = 68;
  var PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d];
  var ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];
  var MOBI_MAGIC = [0x42, 0x4f, 0x4f, 0x4b, 0x4d, 0x4f, 0x42, 0x49];
  var MOBI_OFFSET = 60;

  function startsWith(bytes, magic, offset) {
    var at = offset || 0;
    if (bytes.byteLength < at + magic.length) return false;
    return magic.every(function (b, i) { return bytes[at + i] === b; });
  }

  /** Does the head of the file (a Uint8Array) look like what its name says? */
  function matchesDeclaredFormat(bytes, format) {
    var pdf = startsWith(bytes, PDF_MAGIC);
    var zip = startsWith(bytes, ZIP_MAGIC);
    var mobi = startsWith(bytes, MOBI_MAGIC, MOBI_OFFSET);
    switch (format) {
      case 'pdf': return pdf;
      case 'docx':
      case 'epub': return zip;
      case 'mobi': return mobi;
      case 'txt':
      case 'md': return !pdf && !zip && !mobi;
      default: return false;
    }
  }

  // ---- job status: the only definition of these sets in the extension ----

  function isActiveStatus(status) {
    return status === 'queued' || status === 'running';
  }

  function isAwaitingStatus(status) {
    return status === 'awaiting_confirm';
  }

  function isTerminalStatus(status) {
    return status === 'succeeded' || status === 'failed' || status === 'abandoned';
  }

  /** Not over yet: running, or waiting on the user. */
  function isUnsettledStatus(status) {
    return isActiveStatus(status) || isAwaitingStatus(status);
  }

  // ---- jobs ----

  /** A record's format. The server's view carries none, so pdf is the floor. */
  function jobFormat(record) {
    var r = record || {};
    return r.sourceFormat || formatFromFileName(r.fileName) || 'pdf';
  }

  /** "<base> (<suffix>).<ext>", safe as a download name on every OS. */
  function resultFileName(fileName, format, suffix) {
    var name = String(fileName || '');
    var lower = name.toLowerCase();
    var all = [];
    DOCUMENT_FORMATS.forEach(function (f) { all = all.concat(EXTENSIONS[f]); });
    for (var i = 0; i < all.length; i++) {
      var dotted = '.' + all[i];
      if (lower.length >= dotted.length && lower.slice(-dotted.length) === dotted) {
        name = name.slice(0, -dotted.length);
        break;
      }
    }
    // eslint-disable-next-line no-control-regex
    var base = name.replace(/[\/\\:*?"<>|\u0000-\u001f]/g, '_').trim() || 'document';
    return base + ' (' + suffix + ').' + extensionFor(format);
  }

  /** The extension page that shows one job: the upload page, taking it over. */
  function jobPagePath(jobId) {
    return 'pdf/upload.html#job=' + encodeURIComponent(jobId);
  }

  /**
   * Where "open" leads. Only a finished PDF opens its file directly (Chrome
   * shows it); every other format, and every job not finished, goes to the
   * job page, which knows how to save a file or ask for a confirmation.
   */
  function openTargetFor(job, which) {
    var j = job || {};
    var results = j.results || {};
    if (j.status === 'succeeded' && j.format === 'pdf') {
      var url = which === 'mono'
        ? (results.monoUrl || results.dualUrl)
        : (results.dualUrl || results.monoUrl);
      if (url) return { kind: 'result', url: url };
    }
    return { kind: 'page' };
  }

  var api = {
    DOCUMENT_FORMATS: DOCUMENT_FORMATS,
    SNIFF_BYTES: SNIFF_BYTES,
    FLOW_MAX_STANDARD_PAGES: FLOW_MAX_STANDARD_PAGES,
    isDocumentFormat: isDocumentFormat,
    familyOf: familyOf,
    writesBackDocument: writesBackDocument,
    contentTypeFor: contentTypeFor,
    extensionFor: extensionFor,
    maxBytesFor: maxBytesFor,
    isMeasurable: isMeasurable,
    acceptList: acceptList,
    megabyteLabel: megabyteLabel,
    formatFromFileName: formatFromFileName,
    matchesDeclaredFormat: matchesDeclaredFormat,
    isActiveStatus: isActiveStatus,
    isAwaitingStatus: isAwaitingStatus,
    isTerminalStatus: isTerminalStatus,
    isUnsettledStatus: isUnsettledStatus,
    jobFormat: jobFormat,
    resultFileName: resultFileName,
    jobPagePath: jobPagePath,
    openTargetFor: openTargetFor
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof globalThis !== 'undefined') {
    globalThis.DocJobs = api;
  }
})();
