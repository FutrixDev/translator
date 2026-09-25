/**
 * Document fixtures, built at load time: docx, epub, txt and md, each with the
 * characters and standard pages the server would bill it at.
 *
 * Shared by the e2e journeys (test/e2e/document-formats.spec.js) and the unit
 * suite (test/unit/doc-measure.test.mjs, through createRequire), so the numbers
 * a journey expects in `declaredUnits` are the same numbers the measurement
 * unit tests pin. No Playwright in here: the unit suite has to be able to load
 * it.
 *
 * The expected counts are written out by hand from the text below, not computed
 * by the code under test — they are the oracle. The rule (server
 * lib/docs/measure.ts): whitespace folded to one space, ends trimmed; a docx
 * counts run text per paragraph; an epub counts every chapter's text with its
 * tags turned into spaces, never nav.xhtml or toc.xhtml; 3000 characters to a
 * standard page, at least one.
 */
const zlib = require('node:zlib');
// The measurement never checks the CRC, but `unzip -l` and the server's reader
// do, and a fixture only the code under test accepts proves nothing.
const { crc32 } = require('./crc32');

/**
 * A zip archive from `[{ name, data, method }]`. `method` is 'stored',
 * 'deflate' (the default) or a raw number, for the unknown-method case.
 * `options.zip64` plants a ZIP64 end-of-central-directory locator;
 * `entry.encrypted` sets general-purpose bit 0.
 */
function buildZip(entries, options = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const method = entry.method === 'stored' ? 0 : typeof entry.method === 'number' ? entry.method : 8;
    const body = method === 8 ? zlib.deflateRawSync(data) : data;
    const flags = entry.encrypted ? 0x1 : 0;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  const tail = [];
  if (options.zip64) {
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    tail.push(locator);
  }
  return Buffer.concat([...locals, directory, ...tail, eocd]);
}

// ---- docx ----------------------------------------------------------------

function docxFromParagraphs(paragraphXml) {
  const body = paragraphXml.map((runs) => `<w:p>${runs}</w:p>`).join('');
  return buildZip([
    { name: '[Content_Types].xml', data: '<?xml version="1.0"?><Types/>' },
    {
      name: 'word/document.xml',
      data: '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
        `<w:body>${body}</w:body></w:document>`
    }
  ]);
}

/**
 * report.docx: three paragraphs.
 *   "Quarterly report"            16  (two runs, one with xml:space)
 *   "Revenue & costs rose"        20  (&amp; decoded)
 *   "abcde abcde … abcde" (x700)  4199 (700 * 6 - 1)
 * = 4235 characters -> 2 standard pages.
 */
const REPORT_DOCX = docxFromParagraphs([
  '<w:r><w:t>Quarterly </w:t></w:r><w:r><w:t xml:space="preserve">report</w:t></w:r>',
  '<w:r><w:t>Revenue &amp; costs rose</w:t></w:r>',
  `<w:r><w:t>${'abcde '.repeat(700)}</w:t></w:r>`
]);

// ---- epub ----------------------------------------------------------------

const xhtml = (inner) => `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body>${inner}</body></html>`;

/**
 * novel.epub: two chapters and a nav big enough to matter.
 *   ch1: "One lorem … lorem" (x400)   2403 (3 + 1 + 400 * 6 - 1)
 *   ch2: "Two & done"                   10
 * = 2413 characters -> 1 standard page.
 * nav.xhtml holds 1199 characters of its own ("nav" x300); counted, the book
 * would be 3613 characters and 2 pages — so a declaredUnits of 1 proves the
 * nav was left out. The mimetype entry is stored, as the EPUB spec requires.
 */
const NOVEL_EPUB = buildZip([
  { name: 'mimetype', data: 'application/epub+zip', method: 'stored' },
  { name: 'META-INF/container.xml', data: '<?xml version="1.0"?><container/>' },
  { name: 'OEBPS/content.opf', data: '<?xml version="1.0"?><package/>' },
  { name: 'OEBPS/nav.xhtml', data: xhtml(`<nav><p>${'nav '.repeat(300)}</p></nav>`) },
  { name: 'OEBPS/ch1.xhtml', data: xhtml(`<h1>One</h1><p>${'lorem '.repeat(400)}</p>`) },
  { name: 'OEBPS/ch2.xhtml', data: xhtml('<p>Two &amp; done</p>') }
]);

// ---- plain text ----------------------------------------------------------

/** notes.txt: a BOM, then "Hello world again" once folded -> 17 characters, 1 page. */
const NOTES_TXT = Buffer.from('\uFEFFHello   world\n\n  again \n', 'utf8');

/** readme.md: "# Title " + 3000 x's -> 3008 characters, 2 pages. */
const README_MD = Buffer.from(`# Title\n\n${'x'.repeat(3000)}\n`, 'utf8');

/**
 * Every measurable fixture with its oracle. `fileName` is what the journeys
 * upload it as; the result names follow from it.
 */
const FIXTURES = {
  docx: { fileName: 'report.docx', bytes: REPORT_DOCX, characters: 4235, units: 2 },
  epub: { fileName: 'novel.epub', bytes: NOVEL_EPUB, characters: 2413, units: 1 },
  txt: { fileName: 'notes.txt', bytes: NOTES_TXT, characters: 17, units: 1 },
  md: { fileName: 'readme.md', bytes: README_MD, characters: 3008, units: 2 }
};

/**
 * A MOBI header the sniff accepts: "BOOKMOBI" at byte 60. Nothing measures a
 * MOBI, so the body is filler.
 */
function mobiBytes(size = 256) {
  const bytes = Buffer.alloc(size, 0x20);
  bytes.write('Novel', 0, 'latin1');
  bytes.write('BOOKMOBI', 60, 'latin1');
  return bytes;
}

module.exports = { buildZip, docxFromParagraphs, FIXTURES, mobiBytes };
