// 术语表的 CSV（shared/glossary-csv.js）：导出的字节、RFC 4180 读法、全有或全无的
// 导入和它报的行号、导入预览的两个数。SW 那一跳（GLOSSARY_WRITE 的 import）在
// glossary.test.mjs 里测。
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';

await import('../../shared/lang-tags.js');
await import('../../shared/site-rules-builtin.js');
await import('../../shared/storage-writer.js');
await import('../../shared/site-rules.js');
await import('../../shared/sync-collection.js');
await import('../../shared/target-lang.js');
await import('../../shared/glossary.js');
await import('../../shared/glossary-csv.js');
const { Glossary, GlossaryCsv } = globalThis;

const BOM = String.fromCharCode(0xfeff);
const HEADER = 'source,target,case_sensitive,site,target_lang';

function invalidAt(run, row) {
  assert.throws(run, (error) => {
    assert.equal(error.message, 'glossaryImportInvalid');
    assert.equal(error.row, row);
    return true;
  });
}

// ------------------------------------------------------------ 导出

test('glossary csv serialize: BOM, five-column header, CRLF, fields quoted only when they must be', () => {
  const text = GlossaryCsv.serialize([
    { id: 'aaaa0002', s: 'Transformer', c: 1, h: 'arxiv.org', l: 'zh-CN', u: 9 },
    { id: 'aaaa0001', s: 'attention', t: '注意力, 关注', l: '*', u: 8 },
    { id: 'aaaa0003', s: 'say "hi"', t: 'line one\nline two', l: 'ja', u: 7 },
  ]);
  assert.equal(text.charCodeAt(0), 0xfeff, 'starts with the UTF-8 BOM');
  const body = text.slice(1);
  assert.ok(body.endsWith('\r\n'));
  assert.ok(!/[^\r]\n/.test(body.replace(/"[^"]*(""[^"]*)*"/g, '')), 'every record ends in CRLF');
  assert.deepEqual(body.split('\r\n'), [
    HEADER,
    'attention,"注意力, 关注",0,,*',
    '"say ""hi""","line one\nline two",0,,ja',
    'Transformer,,1,arxiv.org,zh-CN',
    '',
  ]);
  // id 和 u 不导出
  assert.ok(!text.includes('aaaa000') && !text.includes(',9'));
  assert.equal(GlossaryCsv.serialize([]), `${BOM}${HEADER}\r\n`);
});

test('glossary csv: serialize then parse gives the same entries back, field for field', () => {
  const entries = [
    { s: 'attention', t: '注意力', l: 'zh-CN' },
    { s: 'LLM', c: 1, l: '*' },
    { s: 'a, "quoted"\nterm', t: 'x', h: 'example.com', l: 'fr' },
  ].map((entry) => Glossary.validateEntry(entry));
  const back = GlossaryCsv.parse(GlossaryCsv.serialize(entries));
  const order = (list) => list.slice().sort((a, b) => (a.s < b.s ? -1 : 1));
  assert.deepEqual(order(back), order(entries));
});

test('glossary csv fileName: blab-glossary-YYYYMMDD.csv from the local date', () => {
  assert.equal(GlossaryCsv.fileName(new Date(2026, 0, 5, 23, 59)), 'blab-glossary-20260105.csv');
  assert.match(GlossaryCsv.fileName(), /^blab-glossary-\d{8}\.csv$/);
});

// ------------------------------------------------------------ 读

test('glossary csv parse: BOM optional, LF or CRLF, two or five columns, header skipped', () => {
  const five = `${BOM}${HEADER}\r\nattention,注意力,0,,zh-CN\r\nApple,,true,WWW.Apple.com,*\r\n`;
  assert.deepEqual(GlossaryCsv.parse(five), [
    { s: 'attention', t: '注意力', l: 'zh-CN' },
    { s: 'Apple', c: 1, h: 'apple.com', l: '*' },
  ]);
  // 两列：其余取缺省（不区分大小写、所有网站、所有目标语言），没有 BOM、LF 结尾
  assert.deepEqual(GlossaryCsv.parse('source,target\nGPU,\nattention,注意力'), [
    { s: 'GPU', l: '*' },
    { s: 'attention', t: '注意力', l: '*' },
  ]);
  // 没有表头也行；原文恰好叫 source 的词条不会被当表头吞掉
  assert.deepEqual(GlossaryCsv.parse('source,源'), [{ s: 'source', t: '源', l: '*' }]);
  assert.deepEqual(GlossaryCsv.parse(''), []);
  assert.deepEqual(GlossaryCsv.parse(`${BOM}${HEADER}\r\n`), []);
  // BOM 后面紧跟带引号的字段：只有先剥掉 BOM，这个引号才是字段开头
  assert.deepEqual(GlossaryCsv.parse(`${BOM}"attention","注意力"\r\n`), [{ s: 'attention', t: '注意力', l: '*' }]);
});

test('glossary csv parse: the header is the first non-blank record, even after leading blank lines', () => {
  assert.deepEqual(GlossaryCsv.parse('\r\nsource,target\r\nattention,注意力\r\n'), [
    { s: 'attention', t: '注意力', l: '*' },
  ]);
  assert.deepEqual(GlossaryCsv.parse(`\n,,,,\n${HEADER}\nGPU,,1,,*\n`), [{ s: 'GPU', c: 1, l: '*' }]);
  // 行号照旧按记录数：1、2 是空行，3 是表头，4 坏
  invalidAt(() => GlossaryCsv.parse(`\r\n\r\n${HEADER}\r\nbad,x,maybe,,*\r\n`), 4);
  // 第一条非空记录是词条时，后面长得像表头的那一行就是一条原文叫 source 的词条
  assert.deepEqual(GlossaryCsv.parse('\nattention,注意力\nsource,target\n'), [
    { s: 'attention', t: '注意力', l: '*' },
    { s: 'source', t: 'target', l: '*' },
  ]);
});

test('glossary csv parse: quoted commas, doubled quotes and line breaks inside a field', () => {
  const text = 'source,target\r\n"a, b","say ""yes"""\r\n"two\r\nlines",x\r\n';
  assert.deepEqual(GlossaryCsv.parse(text), [
    { s: 'a, b', t: 'say "yes"', l: '*' },
    { s: 'two lines', t: 'x', l: '*' },
  ]);
});

test('glossary csv parse: blank records are skipped but keep their row number', () => {
  const text = 'source,target\n\nok,1\n,,,,\nbad,2,maybe,,*\n';
  // 1 表头、2 空行、3 ok、4 全空、5 坏
  invalidAt(() => GlossaryCsv.parse(text), 5);
  assert.equal(GlossaryCsv.parse('source,target\n\nok,1\n,,,,\n').length, 1);
});

test('glossary csv parse: all or nothing, the first bad row is the one reported', () => {
  const at3 = (line) => `${HEADER}\r\ngood,好,0,,*\r\n${line}\r\nalso good,x,0,,*\r\n`;
  invalidAt(() => GlossaryCsv.parse(at3('only-one-column')), 3);
  invalidAt(() => GlossaryCsv.parse(at3('a,b,c')), 3);
  invalidAt(() => GlossaryCsv.parse(at3('a,b,0,,*,extra')), 3);
  invalidAt(() => GlossaryCsv.parse(at3(',empty source,0,,*')), 3);
  invalidAt(() => GlossaryCsv.parse(at3(`${'x'.repeat(81)},y,0,,*`)), 3);
  invalidAt(() => GlossaryCsv.parse(at3('a,b,yes,,*')), 3);
  invalidAt(() => GlossaryCsv.parse(at3('a,b,0,,xx-YY')), 3);
  invalidAt(() => GlossaryCsv.parse(at3('a,b,0,not a host/path,*')), 3);
  // 站点写了、规范化后却什么都不剩：整份拒绝，不悄悄变成「所有网站」
  invalidAt(() => GlossaryCsv.parse(at3('a,b,0,...,*')), 3);
  invalidAt(() => GlossaryCsv.parse(at3('a,b,0, . ,*')), 3);
  invalidAt(() => GlossaryCsv.parse(at3('a"b,c')), 3);
  invalidAt(() => GlossaryCsv.parse(at3('"a"b,c')), 3);
  invalidAt(() => GlossaryCsv.parse(`${HEADER}\r\ngood,x\r\n"never closed,x\r\nmore,y\r\n`), 3);
  // 列数对、引号没收口（收了的话就是 {bad, unclosed} 这一条）
  invalidAt(() => GlossaryCsv.parse('source,target\r\nbad,"unclosed\r\n'), 2);
  // 不带引号的字段中间出现一对收得好好的引号：照样是坏行
  invalidAt(() => GlossaryCsv.parse('source,target\r\na"b",c\r\n'), 2);
  // 同一份文件里两行是同一条（不区分大小写的原文、同站点、同语言）：后一行算坏行
  invalidAt(() => GlossaryCsv.parse(`${HEADER}\r\nGPU,a,0,,*\r\ngpu,b,0,,*\r\n`), 3);
  // 区分大小写的两条各是各的
  assert.equal(GlossaryCsv.parse(`${HEADER}\r\nGPU,a,1,,*\r\ngpu,b,1,,*\r\n`).length, 2);
  // 原因带在 cause 上
  assert.throws(() => GlossaryCsv.parse(at3(',x')), (error) => error.cause && error.cause.message === 'glossaryEntryInvalid');
  invalidAt(() => GlossaryCsv.parse(null), 1);
});

// ------------------------------------------------------------ 预览与合并

test('glossary csv previewImport: a same-dedupeKey row is a replacement, anything else an addition', () => {
  const current = Glossary.collect({
    'glossary:aaaa0001': { s: 'attention', t: '关注', l: 'zh-CN', u: 1 },
    'glossary:aaaa0002': { s: 'Apple', c: 1, l: '*', u: 1 },
  });
  const snapshot = JSON.stringify(current);
  const text = `${HEADER}\r\nATTENTION,注意力,0,,zh-CN\r\napple,苹果,1,,*\r\nattention,x,0,,ja\r\n`;
  assert.deepEqual(GlossaryCsv.previewImport(current, text), { added: 2, replaced: 1 });
  assert.equal(JSON.stringify(current), snapshot, 'preview does not touch the current entries');
});

test('glossary csv mergeImport: replacements keep the id, every imported entry gets u = now, the rest are the same objects', () => {
  const current = Glossary.collect({
    'glossary:aaaa0001': { s: 'attention', t: '关注', l: 'zh-CN', u: 1 },
    'glossary:aaaa0002': { s: 'kept', l: '*', u: 2 },
  });
  const { entries, added, replaced } = GlossaryCsv.mergeImport(current, 'attention,注意力,0,,zh-CN\nnew,新,0,,*', 42);
  assert.deepEqual({ added, replaced }, { added: 1, replaced: 1 });
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  assert.deepEqual(byId.get('aaaa0001'), { id: 'aaaa0001', s: 'attention', t: '注意力', l: 'zh-CN', u: 42 });
  assert.equal(byId.get('aaaa0002'), current.find((entry) => entry.id === 'aaaa0002'), 'untouched entry is the same object');
  const fresh = entries.find((entry) => entry.s === 'new');
  assert.ok(fresh.id && fresh.id !== 'aaaa0001' && fresh.u === 42);
});

test('glossary csv previewImport: over the budget is refused, not truncated', () => {
  const current = Glossary.collect({ 'glossary:aaaa0001': { s: 'one', l: '*', u: 1 } });
  const rows = Array.from({ length: 300 }, (_, i) => `term${i},t`).join('\r\n');
  assert.throws(() => GlossaryCsv.previewImport(current, rows), { message: 'glossaryBudgetFull' });
  const huge = `${'中'.repeat(80)},${'文'.repeat(160)},0,${'h'.repeat(300)}.test,*`;
  assert.throws(() => GlossaryCsv.previewImport([], huge), { message: 'glossaryEntryTooLarge' });
});
