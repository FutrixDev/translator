// shared/doc-measure.js — the port of the CLI's flow-document measurement.
//
// What the server bills a docx/epub/txt/md at is standard pages of 3000
// characters; declaring that number up front is what spares a book the second
// "this is longer than we reserved" question. So the property under test is
// exact agreement with the server's rule, and the fixtures carry hand-written
// oracles (test/e2e/doc-fixtures.js) rather than numbers the code produced.
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const DocMeasure = require('../../shared/doc-measure.js');
const { buildZip, docxFromParagraphs, FIXTURES } = require('../e2e/doc-fixtures.js');

const bytesOf = (buffer) => new Uint8Array(buffer);
const text = (value) => new TextEncoder().encode(value);

test('every fixture measures to its hand-written oracle', async () => {
  for (const [format, fixture] of Object.entries(FIXTURES)) {
    assert.deepEqual(
      await DocMeasure.measureFlowUnits(bytesOf(fixture.bytes), format),
      { characters: fixture.characters, units: fixture.units },
      `${fixture.fileName}`
    );
  }
});

test('a docx reads stored and deflated document.xml alike', async () => {
  const xml = '<w:document><w:body><w:p><w:r><w:t>Stored text</w:t></w:r></w:p></w:body></w:document>';
  for (const method of ['stored', 'deflate']) {
    const zip = buildZip([{ name: 'word/document.xml', data: xml, method }]);
    assert.equal(await DocMeasure.measureFlowCharacters(bytesOf(zip), 'docx'), 11, method);
  }
});

test('a docx folds each paragraph on its own, then sums', async () => {
  // Two paragraphs of "a b": folded apart they are 3 + 3; folded together
  // they would be 7 with the joining space.
  const zip = docxFromParagraphs(['<w:r><w:t>  a   b </w:t></w:r>', '<w:r><w:t>a\tb</w:t></w:r>']);
  assert.equal(await DocMeasure.measureFlowCharacters(bytesOf(zip), 'docx'), 6);
});

test('a docx without word/document.xml is unmeasurable, not zero', async () => {
  const zip = buildZip([{ name: 'word/other.xml', data: '<w:t>x</w:t>' }]);
  assert.equal(await DocMeasure.measureFlowUnits(bytesOf(zip), 'docx'), null);
});

test('an epub never counts nav.xhtml or toc.xhtml', async () => {
  const chapter = '<html><body><p>abc</p></body></html>';
  const noise = `<html><body>${'nav '.repeat(1000)}</body></html>`;
  const zip = buildZip([
    { name: 'mimetype', data: 'application/epub+zip', method: 'stored' },
    { name: 'OEBPS/nav.xhtml', data: noise },
    { name: 'OEBPS/toc.xhtml', data: noise },
    { name: 'toc.html', data: noise },
    { name: 'OEBPS/chapter.xhtml', data: chapter },
    { name: 'OEBPS/Images/', data: '' }
  ]);
  assert.equal(await DocMeasure.measureFlowCharacters(bytesOf(zip), 'epub'), 3);
});

test('an epub with no chapter text is unmeasurable', async () => {
  const zip = buildZip([{ name: 'mimetype', data: 'application/epub+zip', method: 'stored' }]);
  assert.equal(await DocMeasure.measureFlowUnits(bytesOf(zip), 'epub'), null);
});

test('txt drops a leading BOM and md is counted as written', async () => {
  const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...text('ab')]);
  assert.equal(await DocMeasure.measureFlowCharacters(bom, 'txt'), 2);
  assert.equal(await DocMeasure.measureFlowCharacters(text('# Head\n\n*x*'), 'md'), 10);
});

test('ZIP64, encryption and unknown methods come back null, never a throw', async () => {
  const xml = '<w:p><w:r><w:t>abc</w:t></w:r></w:p>';
  const cases = {
    zip64: buildZip([{ name: 'word/document.xml', data: xml }], { zip64: true }),
    encrypted: buildZip([{ name: 'word/document.xml', data: xml, encrypted: true }]),
    'method 12': buildZip([{ name: 'word/document.xml', data: xml, method: 12 }]),
    'not a zip': Buffer.from('PK\u0003\u0004 and nothing else'),
    'too short': Buffer.from('PK')
  };
  for (const [name, zip] of Object.entries(cases)) {
    assert.equal(await DocMeasure.measureFlowUnits(bytesOf(zip), 'docx'), null, name);
  }
});

test('formats it cannot measure answer null', async () => {
  assert.equal(await DocMeasure.measureFlowUnits(text('%PDF-1.7'), 'pdf'), null);
  assert.equal(await DocMeasure.measureFlowUnits(text('BOOKMOBI'), 'mobi'), null);
});

test('3000 characters is one page, 3001 is two, and nothing is zero pages', async () => {
  assert.deepEqual(await DocMeasure.measureFlowUnits(text('x'.repeat(3000)), 'txt'), { characters: 3000, units: 1 });
  assert.deepEqual(await DocMeasure.measureFlowUnits(text('x'.repeat(3001)), 'txt'), { characters: 3001, units: 2 });
  assert.deepEqual(await DocMeasure.measureFlowUnits(text('   \n\t '), 'txt'), { characters: 0, units: 1 });
  assert.equal(DocMeasure.standardPagesFromCharacters(6000), 2);
  assert.equal(DocMeasure.standardPagesFromCharacters(Number.NaN), 1);
});

test('whitespace of every kind folds to one space and the ends are trimmed', () => {
  assert.equal(DocMeasure.countCharacters('  a \n\n\t b\u00a0\u3000c  '), 5);
});
