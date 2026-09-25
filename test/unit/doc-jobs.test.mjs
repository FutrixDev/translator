// shared/doc-jobs.js — the one place the extension knows what a document job is.
//
// The format half is a port of translator-saas server/lib/pdf/format.ts; the
// server decides what it accepts, so drift here is a file the page lets through
// and the server refuses a round trip later (or the reverse). The MIME table
// below is copied from format.ts:133–138 as a constant on purpose: a test that
// read it from doc-jobs.js would agree with any typo.
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const DocJobs = require('../../shared/doc-jobs.js');

// translator-saas server/lib/pdf/format.ts:133–138, verbatim.
const SAAS_CONTENT_TYPES = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  epub: 'application/epub+zip',
  txt: 'text/plain',
  md: 'text/markdown',
  mobi: 'application/x-mobipocket-ebook'
};
const MIB = 1024 * 1024;

test('the format table is the server\'s: six formats, their MIME types and limits', () => {
  assert.deepEqual([...DocJobs.DOCUMENT_FORMATS], ['pdf', 'docx', 'epub', 'txt', 'md', 'mobi']);
  for (const [format, mime] of Object.entries(SAAS_CONTENT_TYPES)) {
    assert.equal(DocJobs.contentTypeFor(format), mime, format);
  }
  assert.equal(DocJobs.contentTypeFor('exe'), '');
  assert.deepEqual(
    Object.fromEntries(DocJobs.DOCUMENT_FORMATS.map((f) => [f, DocJobs.maxBytesFor(f) / MIB])),
    { pdf: 30, docx: 50, epub: 50, txt: 10, md: 10, mobi: 50 }
  );
  assert.equal(DocJobs.maxBytesFor('exe'), 0);
  assert.equal(DocJobs.familyOf('pdf'), 'fixed');
  for (const f of ['docx', 'epub', 'txt', 'md', 'mobi']) assert.equal(DocJobs.familyOf(f), 'flow');
  assert.equal(DocJobs.writesBackDocument('mobi'), false);
  for (const f of ['pdf', 'docx', 'epub', 'txt', 'md']) assert.equal(DocJobs.writesBackDocument(f), true);
  assert.deepEqual(DocJobs.DOCUMENT_FORMATS.filter(DocJobs.isMeasurable), ['docx', 'epub', 'txt', 'md']);
});

test('formatFromFileName: the last extension, case-insensitive, two aliases', () => {
  const cases = {
    'report.docx': 'docx',
    'REPORT.DOCX': 'docx',
    'book.v2.EPUB': 'epub',
    'notes.markdown': 'md',
    'novel.azw3': 'mobi',
    'novel.mobi': 'mobi',
    'a.txt': 'txt',
    'paper.pdf': 'pdf',
    'archive.docx.zip': null,
    'no-extension': null,
    '': null,
    'doc.': null
  };
  for (const [name, expected] of Object.entries(cases)) {
    assert.equal(DocJobs.formatFromFileName(name), expected, name);
  }
  assert.equal(DocJobs.formatFromFileName(undefined), null);
});

test('the sniff reads what the server reads, per format', () => {
  const head = (text, size = 68) => {
    const bytes = new Uint8Array(size);
    bytes.set(new TextEncoder().encode(text));
    return bytes;
  };
  const pdf = head('%PDF-1.7');
  const zip = head('PK\u0003\u0004');
  const mobi = head('');
  mobi.set(new TextEncoder().encode('BOOKMOBI'), 60);
  const plain = head('Hello');

  assert.equal(DocJobs.SNIFF_BYTES, 68);
  assert.equal(DocJobs.matchesDeclaredFormat(pdf, 'pdf'), true);
  assert.equal(DocJobs.matchesDeclaredFormat(zip, 'pdf'), false);
  for (const f of ['docx', 'epub']) {
    assert.equal(DocJobs.matchesDeclaredFormat(zip, f), true, f);
    assert.equal(DocJobs.matchesDeclaredFormat(plain, f), false, `${f} that is not a zip`);
  }
  assert.equal(DocJobs.matchesDeclaredFormat(mobi, 'mobi'), true);
  assert.equal(DocJobs.matchesDeclaredFormat(plain, 'mobi'), false);
  // A MOBI header too short to reach byte 60 is not a MOBI.
  assert.equal(DocJobs.matchesDeclaredFormat(head('', 64), 'mobi'), false);
  for (const f of ['txt', 'md']) {
    assert.equal(DocJobs.matchesDeclaredFormat(plain, f), true, f);
    // A PDF, zip or MOBI renamed to .txt is caught here, not billed as text.
    for (const disguised of [pdf, zip, mobi]) assert.equal(DocJobs.matchesDeclaredFormat(disguised, f), false);
  }
  assert.equal(DocJobs.matchesDeclaredFormat(plain, 'exe'), false);
});

test('megabyteLabel is format.ts\'s: one decimal, none when whole', () => {
  assert.equal(DocJobs.megabyteLabel(30 * MIB), '30 MB');
  assert.equal(DocJobs.megabyteLabel(10 * MIB), '10 MB');
  assert.equal(DocJobs.megabyteLabel(1.5 * MIB), '1.5 MB');
  assert.equal(DocJobs.megabyteLabel(1.26 * MIB), '1.3 MB');
});

test('acceptList offers every extension of every format, dotted', () => {
  assert.equal(DocJobs.acceptList(), '.pdf,.docx,.epub,.mobi,.azw3,.txt,.md,.markdown');
  for (const ext of DocJobs.acceptList().split(',')) {
    assert.ok(DocJobs.formatFromFileName(`x${ext}`), `${ext} is offered but not recognised`);
  }
});

test('the status sets partition every status the server sends', () => {
  const all = ['queued', 'running', 'awaiting_confirm', 'succeeded', 'failed', 'abandoned'];
  const row = (s) => [DocJobs.isActiveStatus(s), DocJobs.isAwaitingStatus(s), DocJobs.isTerminalStatus(s)];
  assert.deepEqual(all.map(row), [
    [true, false, false],
    [true, false, false],
    [false, true, false],
    [false, false, true],
    [false, false, true],
    [false, false, true]
  ]);
  // Exactly one answer each: awaiting is neither running nor over.
  for (const s of all) assert.equal(row(s).filter(Boolean).length, 1, s);
  assert.deepEqual(all.filter(DocJobs.isUnsettledStatus), ['queued', 'running', 'awaiting_confirm']);
  assert.equal(DocJobs.isTerminalStatus(undefined), false);
});

test('jobFormat: the record\'s own format, then its file name, then pdf', () => {
  assert.equal(DocJobs.jobFormat({ sourceFormat: 'epub', fileName: 'x.docx' }), 'epub');
  assert.equal(DocJobs.jobFormat({ fileName: 'x.docx' }), 'docx');
  assert.equal(DocJobs.jobFormat({ fileName: 'arxiv.org/abs/1' }), 'pdf');
  assert.equal(DocJobs.jobFormat(null), 'pdf');
});

test('resultFileName is safe on every OS and keeps the format\'s extension', () => {
  assert.equal(DocJobs.resultFileName('report.docx', 'docx', 'bilingual'), 'report (bilingual).docx');
  assert.equal(DocJobs.resultFileName('Novel.EPUB', 'epub', 'translated'), 'Novel (translated).epub');
  assert.equal(DocJobs.resultFileName('notes.markdown', 'md', 'bilingual'), 'notes (bilingual).md');
  assert.equal(DocJobs.resultFileName('a/b:c*?"<>|.txt', 'txt', 'bilingual'), 'a_b_c______ (bilingual).txt');
  assert.equal(DocJobs.resultFileName('tab\there\u0000.txt', 'txt', 'bilingual'), 'tab_here_ (bilingual).txt');
  assert.equal(DocJobs.resultFileName('', 'docx', 'bilingual'), 'document (bilingual).docx');
  assert.equal(DocJobs.resultFileName('.docx', 'docx', 'bilingual'), 'document (bilingual).docx');
  assert.equal(DocJobs.resultFileName(undefined, 'pdf', 'bilingual'), 'document (bilingual).pdf');
  // Only a known extension is stripped; "v1.2" is part of the name.
  assert.equal(DocJobs.resultFileName('draft v1.2', 'docx', 'bilingual'), 'draft v1.2 (bilingual).docx');
});

test('jobPagePath is the upload page, taking over one job', () => {
  assert.equal(DocJobs.jobPagePath('job-1'), 'pdf/upload.html#job=job-1');
  assert.equal(DocJobs.jobPagePath('a b/c'), 'pdf/upload.html#job=a%20b%2Fc');
});

test('openTargetFor: only a finished PDF with a URL opens its file', () => {
  const results = { dualUrl: 'https://r.test/dual', monoUrl: 'https://r.test/mono' };
  const statuses = ['queued', 'running', 'awaiting_confirm', 'succeeded', 'failed', 'abandoned'];
  for (const format of DocJobs.DOCUMENT_FORMATS) {
    for (const status of statuses) {
      for (const withUrls of [true, false]) {
        for (const which of ['dual', 'mono']) {
          const job = { format, status, results: withUrls ? results : {} };
          const target = DocJobs.openTargetFor(job, which);
          const opensFile = format === 'pdf' && status === 'succeeded' && withUrls;
          const label = `${format}/${status}/${withUrls ? 'urls' : 'none'}/${which}`;
          if (opensFile) {
            assert.deepEqual(target, { kind: 'result', url: which === 'mono' ? results.monoUrl : results.dualUrl }, label);
          } else {
            assert.deepEqual(target, { kind: 'page' }, label);
          }
        }
      }
    }
  }
  // One URL missing: the other one, not the job page.
  const dualOnly = { format: 'pdf', status: 'succeeded', results: { dualUrl: 'https://r.test/dual' } };
  assert.deepEqual(DocJobs.openTargetFor(dualOnly, 'mono'), { kind: 'result', url: 'https://r.test/dual' });
  const monoOnly = { format: 'pdf', status: 'succeeded', results: { monoUrl: 'https://r.test/mono' } };
  assert.deepEqual(DocJobs.openTargetFor(monoOnly, 'dual'), { kind: 'result', url: 'https://r.test/mono' });
  assert.deepEqual(DocJobs.openTargetFor(null), { kind: 'page' });
});
