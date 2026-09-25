// Blab Translation — how long a flow document is, measured before it is sent.
//
// A PORT, line for line, of translator-saas packages/cli/src/measure/zip.ts and
// characters.ts (which themselves mirror server/lib/docs/measure.ts). The
// server bills a flow document by standard pages of 3000 characters; when the
// create says nothing, it reserves one page and, once it has counted the real
// number, stops to ask the user again. Declaring the count here up front is
// what spares almost every book that second question.
//
// The only differences from the CLI are the ones the platform forces:
//   - inflate is DecompressionStream('deflate-raw') instead of node:zlib, so
//     reading an entry is async;
//   - bytes are a Uint8Array read through a DataView instead of a Buffer;
//   - UTF-8 is decoded with TextDecoder({ignoreBOM: true}) so a BOM survives
//     decoding exactly as it does in Buffer#toString and is stripped by the
//     same explicit regex.
// Any rule change belongs in the saas file first; this one follows it.
//
// Dual-mode (module.exports + globalThis.DocMeasure) so unit tests can require
// it. Only the upload page loads it.
(function () {
  'use strict';

  // ---- zip.ts ----

  var EOCD_SIGNATURE = 0x06054b50;
  var EOCD64_LOCATOR_SIGNATURE = 0x07064b50;
  var CENTRAL_SIGNATURE = 0x02014b50;
  var LOCAL_SIGNATURE = 0x04034b50;
  /** The EOCD is 22 bytes plus a comment of at most 0xffff. */
  var MAX_EOCD_SCAN = 22 + 0xffff;

  function utf8(bytes) {
    return new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
  }

  function findEocd(view, length) {
    var start = Math.max(0, length - MAX_EOCD_SCAN);
    // Backwards: the signature can occur inside file data; the LAST one is real.
    for (var at = length - 22; at >= start; at -= 1) {
      if (view.getUint32(at, true) === EOCD_SIGNATURE) return at;
    }
    throw new Error('not a zip archive (no end-of-central-directory record)');
  }

  function readZip(bytes) {
    var length = bytes.byteLength;
    if (length < 22) throw new Error('file is too small to be a zip archive');
    var view = new DataView(bytes.buffer, bytes.byteOffset, length);
    var eocd = findEocd(view, length);

    // ZIP64 leaves truncated counts here; a partial archive would quote low.
    if (eocd >= 20 && view.getUint32(eocd - 20, true) === EOCD64_LOCATOR_SIGNATURE) {
      throw new Error('zip64 archives are not supported');
    }

    var entryCount = view.getUint16(eocd + 10, true);
    var directorySize = view.getUint32(eocd + 12, true);
    var directoryOffset = view.getUint32(eocd + 16, true);
    if (directoryOffset + directorySize > length) {
      throw new Error('central directory is outside the file');
    }

    var entries = [];
    var cursor = directoryOffset;
    for (var index = 0; index < entryCount; index += 1) {
      if (cursor + 46 > length || view.getUint32(cursor, true) !== CENTRAL_SIGNATURE) {
        throw new Error('corrupt central directory entry at ' + cursor);
      }
      var flags = view.getUint16(cursor + 8, true);
      var method = view.getUint16(cursor + 10, true);
      var compressedSize = view.getUint32(cursor + 20, true);
      var uncompressedSize = view.getUint32(cursor + 24, true);
      var nameLength = view.getUint16(cursor + 28, true);
      var extraLength = view.getUint16(cursor + 30, true);
      var commentLength = view.getUint16(cursor + 32, true);
      var localOffset = view.getUint32(cursor + 42, true);
      // Bit 0: encrypted. Noise measured as text is a wrong number, not a missing one.
      if (flags & 0x1) throw new Error('encrypted zip entries are not supported');
      var name = utf8(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
      entries.push(makeEntry(bytes, view, localOffset, method, compressedSize, uncompressedSize, name));
      cursor += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
  }

  function makeEntry(bytes, view, localOffset, method, compressedSize, uncompressedSize, name) {
    return {
      name: name,
      read: function () {
        return readEntry(bytes, view, localOffset, method, compressedSize, uncompressedSize, name);
      }
    };
  }

  async function inflateRaw(raw) {
    var stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function readEntry(bytes, view, localOffset, method, compressedSize, uncompressedSize, name) {
    if (localOffset + 30 > bytes.byteLength || view.getUint32(localOffset, true) !== LOCAL_SIGNATURE) {
      throw new Error('corrupt local header for ' + name);
    }
    // The LOCAL header's own name/extra lengths, not the central directory's.
    var nameLength = view.getUint16(localOffset + 26, true);
    var extraLength = view.getUint16(localOffset + 28, true);
    var start = localOffset + 30 + nameLength + extraLength;
    var end = start + compressedSize;
    if (end > bytes.byteLength) throw new Error('entry ' + name + ' runs past the end of the file');

    var raw = bytes.subarray(start, end);
    if (method === 0) return raw.slice();
    if (method !== 8) throw new Error('unsupported compression method ' + method + ' for ' + name);
    var inflated = await inflateRaw(raw);
    if (uncompressedSize && inflated.length !== uncompressedSize) {
      throw new Error('entry ' + name + ' decompressed to the wrong size');
    }
    return inflated;
  }

  function findEntry(entries, name) {
    return entries.find(function (entry) { return entry.name === name; });
  }

  // ---- characters.ts ----

  var STANDARD_PAGE_CHARACTERS = 3000;

  function standardPagesFromCharacters(charCount) {
    if (!Number.isFinite(charCount) || charCount <= 0) return 1;
    return Math.max(1, Math.ceil(charCount / STANDARD_PAGE_CHARACTERS));
  }

  /** Whitespace folded, ends trimmed — the normalization the container bills on. */
  function countCharacters(text) {
    return text.replace(/\s+/gu, ' ').trim().length;
  }

  function decodeEntities(text) {
    return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/gu, function (whole, body) {
      if (body.startsWith('#x') || body.startsWith('#X')) {
        var hex = Number.parseInt(body.slice(2), 16);
        return Number.isFinite(hex) ? String.fromCodePoint(hex) : whole;
      }
      if (body.startsWith('#')) {
        var dec = Number.parseInt(body.slice(1), 10);
        return Number.isFinite(dec) ? String.fromCodePoint(dec) : whole;
      }
      var named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
      // `?? whole`, verbatim: parity with the server matters more than tidiness.
      return named[body] ?? whole;
    });
  }

  function stripMarkup(xml) {
    return decodeEntities(xml.replace(/<[^>]*>/gu, ' '));
  }

  /** DOCX: run text per paragraph, each folded on its own, summed. */
  function docxCharacters(xml) {
    var total = 0;
    xml.split(/<\/w:p>/u).forEach(function (paragraph) {
      var text = '';
      for (var run of paragraph.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/gu)) {
        text += decodeEntities(run[1] || '');
      }
      total += countCharacters(text);
    });
    return total;
  }

  function isEpubChapter(name) {
    return /\.x?html?$/iu.test(name) && !/(^|\/)(toc|nav)\.x?html?$/iu.test(name);
  }

  /** Billed characters, or null when unmeasurable (never a throw). */
  async function measureFlowCharacters(bytes, format) {
    try {
      if (format === 'txt' || format === 'md') {
        return countCharacters(utf8(bytes).replace(/^\uFEFF/u, ''));
      }
      var entries = readZip(bytes);
      if (format === 'docx') {
        var document = findEntry(entries, 'word/document.xml');
        if (!document) return null;
        return docxCharacters(utf8(await document.read()));
      }
      if (format !== 'epub') return null;
      var total = 0;
      for (var i = 0; i < entries.length; i++) {
        var entry = entries[i];
        if (entry.name.endsWith('/') || !isEpubChapter(entry.name)) continue;
        total += countCharacters(stripMarkup(utf8(await entry.read())));
      }
      return total > 0 ? total : null;
    } catch (error) {
      return null;
    }
  }

  /** `{characters, units}` for a measurable format, else null. */
  async function measureFlowUnits(bytes, format) {
    var characters = await measureFlowCharacters(bytes, format);
    if (characters === null) return null;
    return { characters: characters, units: standardPagesFromCharacters(characters) };
  }

  var api = {
    STANDARD_PAGE_CHARACTERS: STANDARD_PAGE_CHARACTERS,
    standardPagesFromCharacters: standardPagesFromCharacters,
    countCharacters: countCharacters,
    measureFlowCharacters: measureFlowCharacters,
    measureFlowUnits: measureFlowUnits
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof globalThis !== 'undefined') {
    globalThis.DocMeasure = api;
  }
})();
