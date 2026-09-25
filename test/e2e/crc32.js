/**
 * CRC-32 (the zip/PNG polynomial), the one copy every fixture builder uses:
 * PNG chunks in comic-fixtures.js and image-ocr.spec.js, zip headers in
 * doc-fixtures.js.
 *
 * Hand-rolled rather than `zlib.crc32`, which landed in Node 20.15/22.2. The
 * fixture modules build their bytes at load time, so on an older runtime a
 * whole spec file would die on import with a TypeError — before a single test
 * reports, and looking nothing like the missing-API problem it is.
 *
 * Requires nothing, Playwright least of all: doc-fixtures.js is also loaded by
 * the unit tests through createRequire, with no browser around.
 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** @param {Uint8Array} buf */
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

module.exports = { crc32 };
