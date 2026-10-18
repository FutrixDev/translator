// The offline dictionary's pack layer, shared/dict-pack.js (D-561, D-566):
//
//   - parsePack() accepts the v1 contract and refuses anything else with the
//     field path in the message, including a record with no gloss (D-576 N4);
//   - seedChunks() writes every head before any form pointer, 5000 keys a
//     chunk, and never the `dict:packs` item;
//   - toResponse() turns a stored head into an answer DictEntry.entryFor()
//     accepts, with the translation's phonetics (D-487) and only the credits
//     this entry uses (JMdict for a JMdict record, Tatoeba for a Tatoeba
//     example);
//   - foldCandidates() is exact, lower case, NFKC, and the Korean particle
//     strip — the one fold made at lookup time (D-578).
//
// The three packs are the hand-made v1 fixtures the e2e spec serves too.
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

await import('../../shared/lang-tags.js');
await import('../../shared/engines.js');
await import('../../shared/dict-entry.js');
await import('../../shared/dict-pack.js');
const { DictPack, DictEntry } = globalThis;

const fixtureText = (name) =>
  readFileSync(new URL(`../fixtures/dict-runtime/${name}.json`, import.meta.url), 'utf8');
const fixture = (name) => JSON.parse(fixtureText(name));
const metaOf = (pack) => DictPack.listItem(pack, { sha256: 'x', bytes: 1, rawBytes: 1 });

test('keys: entries, forms and the list item', () => {
  assert.equal(DictPack.PACKS_KEY, 'dict:packs');
  assert.equal(DictPack.DECLINED_KEY, 'dict:declined');
  assert.equal(DictPack.MANIFEST_URL, 'https://dl.blab-translation.com/dict/v1/manifest.json');
  assert.equal(DictPack.entryKey('en', 'zh-CN', 'run'), 'd:en-zh-CN:run');
  assert.equal(DictPack.formKey('en', 'zh-CN', 'ran'), 'd:en-zh-CN:~ran');
  assert.equal(DictPack.prefixOf('ko', 'en'), 'd:ko-en:');
  assert.equal(DictPack.pairOf('ja', 'zh-CN'), 'ja-zh-CN');
});

test('splitPair splits at a known language code, either side may carry a hyphen', () => {
  assert.deepEqual(DictPack.splitPair('en-zh-CN'), { src: 'en', tgt: 'zh-CN' });
  assert.deepEqual(DictPack.splitPair('zh-CN-en'), { src: 'zh-CN', tgt: 'en' });
  assert.deepEqual(DictPack.splitPair('zh-TW-ja'), { src: 'zh-TW', tgt: 'ja' });
  for (const bad of ['en', 'en-it', 'it-en', 'en-', '', 'zh-CN']) {
    assert.throws(() => DictPack.splitPair(bad), /is not a language pair/, bad);
  }
});

test('parsePack accepts the three fixture packs', () => {
  for (const name of ['en-zh-CN', 'ja-zh-CN', 'ko-en']) {
    const pack = DictPack.parsePack(fixtureText(name));
    assert.equal(DictPack.pairOf(pack.src, pack.tgt), name);
  }
});

// Each mutation breaks the contract in one place; the message must name it.
const REFUSALS = [
  ['not JSON', () => '{', /\(root\) is not JSON/],
  ['v is not 1', (p) => { p.v = 2; }, /v is not 1/],
  ['unknown source language', (p) => { p.src = 'it'; }, /it-zh-CN is not a language pair/],
  ['unknown target language', (p) => { p.tgt = 'it'; }, /en-it is not a language pair/],
  ['src equals tgt', (p) => { p.tgt = 'en'; }, /en-en is not a language pair/],
  ['no ver', (p) => { delete p.ver; }, /ver is not a non-empty string/],
  ['a source without a url', (p) => { delete p.sources[0].url; }, /sources\[0\]\.url/],
  ['a source url that is not https', (p) => { p.sources[0].url = 'javascript:alert(1)'; }, /sources\[0\]\.url is not an https URL/],
  ['a credit href that is not https', (p) => { p.credits.tatoeba.href = 'http://tatoeba.org/'; }, /credits\.tatoeba\.href is not an https URL/],
  ['a credit href on a host the card drops (D-609 N7)', (p) => { p.credits.tatoeba.href = 'https://kaikki.org/'; }, /credits\.tatoeba\.href is not an https URL on tatoeba\.org/],
  ['a credit href with a port (D-609 N7)', (p) => { p.credits.tatoeba.href = 'https://tatoeba.org:8443/'; }, /credits\.tatoeba\.href is not an https URL/],
  // Every credit refusal entryFor used to make (D-686 moved them all here).
  ...[
    ['javascript:', 'javascript:alert(1)'],
    ['data:', 'data:text/html,<b>x</b>'],
    ['a look-alike host', 'https://tatoeba.org.evil.example/'],
    ['a host suffix', 'https://eviltatoeba.org/'],
    ['a subdomain', 'https://en.tatoeba.org/'],
    ['a user', 'https://someone@tatoeba.org/'],
    ['no scheme', 'tatoeba.org'],
    ['a leading no-break space', '\u00A0https://tatoeba.org/'],
    ['a leading em space', '\u2003https://tatoeba.org/'],
    ['the other credit\'s host', 'https://www.edrdg.org/edrdg/licence.html'],
  ].map(([what, href]) => [`a credit href: ${what}`, (p) => { p.credits.tatoeba.href = href; },
    /credits\.tatoeba\.href is not an https URL on tatoeba\.org/]),
  ['a credit href that is not a string', (p) => { p.credits.tatoeba.href = 42; }, /credits\.tatoeba\.href is not a non-empty string/],
  ['a credit that is not an object', (p) => { p.credits.tatoeba = 'Tatoeba'; }, /credits\.tatoeba is not an object/],
  ['an empty credit label', (p) => { p.credits.tatoeba.label = ''; }, /credits\.tatoeba\.label is not a non-empty string/],
  ['a blank credit label', (p) => { p.credits.tatoeba.label = '   '; }, /credits\.tatoeba\.label has no visible characters/],
  ['a zero-width credit label', (p) => { p.credits.tatoeba.label = ' \u200B\u2060 '; }, /credits\.tatoeba\.label has no visible characters/],
  ['an overlong credit label', (p) => { p.credits.tatoeba.label = 'x'.repeat(DictPack.LIMITS.MAX_LABEL + 1); }, /credits\.tatoeba\.label is over 80 characters/],
  ['an unknown credit', (p) => { p.credits.wiktionary = { label: 'W', href: 'https://kaikki.org/' }; }, /credits\.wiktionary is not jmdict or tatoeba/],
  ['seven records', (p) => { p.e.apple = Array(7).fill(p.e.apple[0]); }, /e\["apple"\] has 7 items/],
  ['five glosses', (p) => { p.e.apple[0][1] = ['a', 'b', 'c', 'd', 'e']; }, /e\["apple"\]\[0\]\[1\] has 5 items/],
  ['no non-empty gloss (D-576 N4)', (p) => { p.e.apple[0][1] = ['', '']; }, /e\["apple"\]\[0\]\[1\] has no non-empty gloss/],
  ['only whitespace glosses (D-609 N8)', (p) => { p.e.apple[0][1] = [' ', '\u3000']; }, /e\["apple"\]\[0\]\[1\] has no non-empty gloss/],
  ['an overlong gloss', (p) => { p.e.apple[0][1] = ['x'.repeat(DictPack.LIMITS.MAX_TEXT + 1)]; }, /e\["apple"\]\[0\]\[1\]\[0\] is over 500 characters/],
  // The L4 caps (D-686), one refusal each.
  ['an overlong part of speech', (p) => { p.e.apple[0][0] = 'x'.repeat(DictPack.LIMITS.MAX_LABEL + 1); }, /e\["apple"\]\[0\]\[0\] is over 80 characters/],
  ['an overlong head', (p) => { p.e['x'.repeat(DictPack.LIMITS.MAX_KEY + 1)] = p.e.apple; }, /e\["x{201}"\] is over 200 characters/],
  ['an overlong form', (p) => { p.f['x'.repeat(DictPack.LIMITS.MAX_KEY + 1)] = 'apple'; }, /f\["x{201}"\] is over 200 characters/],
  ['an overlong form label', (p) => { p.m.run[0][0] = 'x'.repeat(DictPack.LIMITS.MAX_LABEL + 1); }, /m\["run"\]\[0\]\[0\] is over 80 characters/],
  ['an overlong form value', (p) => { p.m.run[0][1] = 'x'.repeat(DictPack.LIMITS.MAX_TEXT + 1); }, /m\["run"\]\[0\]\[1\] is over 500 characters/],
  ['an overlong example sentence', (p) => { p.x.run[0][0] = 'x'.repeat(DictPack.LIMITS.MAX_TEXT + 1); }, /x\["run"\]\[0\]\[0\] is over 500 characters/],
  ['an overlong example translation', (p) => { p.x.run[0][1] = 'x'.repeat(DictPack.LIMITS.MAX_TEXT + 1); }, /x\["run"\]\[0\]\[1\] is over 500 characters/],
  ['nine sources', (p) => { p.sources = [...p.sources, ...Array.from({ length: 7 }, (_, i) => ({ ...p.sources[0], id: `s${i}` }))]; }, /sources has 9 items/],
  ['an empty reading', (p) => { p.e.apple[0][2] = ''; }, /e\["apple"\]\[0\]\[2\]/],
  ['an origin not in sources', (p) => { p.e.apple[0][3] = 'ecdict'; }, /e\["apple"\]\[0\]\[3\] is not an id in sources/],
  ['a head that looks like a form key', (p) => { p.e['~apple'] = p.e.apple; }, /e\["~apple"\] starts with "~"/],
  ['an example for a missing head', (p) => { p.x.pear = p.x.apple; }, /x\["pear"\] has no head in e/],
  ['three examples', (p) => { p.x.run = [...p.x.run, p.x.run[0]]; }, /x\["run"\] has 3 items/],
  ['a bad Tatoeba id', (p) => { p.x.run[0][2] = '1234'; }, /x\["run"\]\[0\]\[2\]/],
  ['a Tatoeba example without the Tatoeba credit', (p) => { delete p.credits.tatoeba; }, /credits\.tatoeba is missing/],
  ['nine forms', (p) => { p.m.run = Array(9).fill(['a', 'b']); }, /m\["run"\] has 9 items/],
  ['a form pointing nowhere', (p) => { p.f.went = 'go'; }, /f\["went"\] does not name a head in e/],
  ['no heads', (p) => { p.e = {}; p.x = {}; p.m = {}; p.f = {}; }, /e has no heads/],
];

for (const [name, mutate, message] of REFUSALS) {
  test(`parsePack refuses: ${name}`, () => {
    const pack = fixture('en-zh-CN');
    const text = mutate(pack) ?? JSON.stringify(pack);
    assert.throws(() => DictPack.parsePack(text), message);
  });
}

test('parsePack refuses a JMdict record without the JMdict credit', () => {
  const pack = fixture('ja-zh-CN');
  delete pack.credits.jmdict;
  assert.throws(() => DictPack.parsePack(JSON.stringify(pack)), /credits\.jmdict is missing/);
});

test('parsePack holds the JMdict credit to www.edrdg.org alone', () => {
  for (const href of ['https://edrdg.org/', 'https://tatoeba.org/', 'http://www.edrdg.org/']) {
    const pack = fixture('ja-zh-CN');
    pack.credits.jmdict.href = href;
    assert.throws(() => DictPack.parsePack(JSON.stringify(pack)),
      /credits\.jmdict\.href is not an https URL on www\.edrdg\.org/, href);
  }
});

test('LIMITS is one frozen table, and its text cap is the entry\'s', () => {
  assert.ok(Object.isFrozen(DictPack.LIMITS));
  assert.deepEqual(Object.keys(DictPack.LIMITS), [
    'MAX_RECORDS', 'MAX_GLOSSES', 'MAX_EXAMPLES', 'MAX_FORMS', 'MAX_TEXT',
    'MAX_LABEL', 'MAX_KEY', 'MAX_SOURCES', 'MAX_CREDITS',
  ]);
  // The first gloss is the answer's translation, which the entry refuses
  // past DictEntry.MAX_TEXT: the two caps are one number.
  assert.equal(DictPack.LIMITS.MAX_TEXT, DictEntry.MAX_TEXT);
  assert.equal(DictPack.LIMITS.MAX_CREDITS, 2);
});

test('needPair and isPackLang: the one check on a language pair', () => {
  assert.equal(DictPack.needPair('en', 'zh-CN'), 'en-zh-CN');
  assert.equal(DictPack.needPair('zh-TW', 'ja'), 'zh-TW-ja');
  for (const [src, tgt] of [['it', 'en'], ['en', 'it'], ['en', 'en'], ['', 'en'], [undefined, 'en'], ['EN', 'zh-CN']]) {
    assert.throws(() => DictPack.needPair(src, tgt), /is not a language pair/, `${src}-${tgt}`);
  }
  assert.equal(DictPack.isPackLang('pt'), true);
  for (const lang of ['it', 'zh', '', null, 'en-US']) assert.equal(DictPack.isPackLang(lang), false, String(lang));
});

test('seedChunks: heads first, then forms, 5000 keys a chunk, no list item', () => {
  const pack = fixture('en-zh-CN');
  for (let i = 0; i < 12000; i += 1) pack.e[`w${i}`] = [['n.', [`词${i}`], null, 'wiktionary']];
  for (let i = 0; i < 3000; i += 1) pack.f[`f${i}`] = `w${i}`;
  const chunks = [...DictPack.seedChunks(DictPack.parsePack(JSON.stringify(pack)))];
  const total = Object.keys(pack.e).length + Object.keys(pack.f).length;
  const full = Math.floor(total / DictPack.CHUNK_KEYS);
  assert.equal(full, 3, 'the fixture fills three chunks and starts a fourth');
  assert.deepEqual(chunks.map((c) => Object.keys(c).length),
    [...Array(full).fill(DictPack.CHUNK_KEYS), total - full * DictPack.CHUNK_KEYS]);
  const keys = chunks.flatMap((c) => Object.keys(c));
  assert.equal(new Set(keys).size, total);
  assert.ok(!keys.includes(DictPack.PACKS_KEY));
  const firstForm = keys.findIndex((k) => k.startsWith('d:en-zh-CN:~'));
  assert.equal(firstForm, Object.keys(pack.e).length, 'every head is written before any form');
  const merged = Object.assign({}, ...chunks);
  assert.deepEqual(merged['d:en-zh-CN:run'], { e: pack.e.run, x: pack.x.run, m: pack.m.run });
  assert.deepEqual(merged['d:en-zh-CN:colour'], { e: pack.e.colour });
  assert.deepEqual(merged['d:en-zh-CN:~ran'], { h: 'run' });
});

test('listItem keeps what the settings page and the credits need', () => {
  const pack = fixture('en-zh-CN');
  const url = 'dict/v1/en-zh-CN/2026.10.13/en-zh-CN.json';
  const item = DictPack.listItem(pack, { sha256: 'abc', bytes: 10, rawBytes: 20, url, heads: 99 });
  assert.deepEqual(item, {
    src: 'en', tgt: 'zh-CN', ver: '2026.10.13', url, sha256: 'abc', heads: 3, bytes: 10, rawBytes: 20,
    lic: 'CC-BY-SA-4.0', sources: pack.sources, credits: pack.credits,
  });
  assert.deepEqual(DictPack.docUrls(item), {
    license: 'https://dl.blab-translation.com/dict/v1/en-zh-CN/2026.10.13/LICENSE.txt',
    attribution: 'https://dl.blab-translation.com/dict/v1/en-zh-CN/2026.10.13/ATTRIBUTION.txt',
  }, 'the two files published beside the pack (D-570)');
});

function storedRecord(pack, head) {
  const chunk = Object.assign({}, ...DictPack.seedChunks(pack));
  return chunk[DictPack.entryKey(pack.src, pack.tgt, head)];
}

test('toResponse: en→zh-CN — one unlabelled reading, Tatoeba credited, entryFor accepts it', () => {
  const pack = fixture('en-zh-CN');
  const response = DictPack.toResponse(metaOf(pack), storedRecord(pack, 'run'), 'zh-CN');
  assert.equal(response.engine, DictEntry.DICT_ENGINE);
  assert.equal(response.translation, '跑');
  assert.deepEqual(response.entry.phonetics, [{ label: '', ipa: 'pǎo' }]);
  assert.deepEqual(response.entry.senses, [
    { pos: 'v.', defs: ['跑', '奔跑', '经营'] },
    { pos: 'n.', defs: ['跑步', '一段路程'] },
  ]);
  assert.deepEqual(response.entry.examples, [
    { source: 'I run every morning.', target: '我每天早上跑步。' },
    { source: 'She runs a small shop.', target: '她经营一家小店。' },
  ]);
  assert.deepEqual(response.entry.forms[0], { label: '过去式', value: 'ran' });
  assert.deepEqual(response.credits, [pack.credits.tatoeba]);
  const entry = DictEntry.entryFor('word', response);
  assert.equal(entry.translation, '跑');
  assert.deepEqual(entry.credits, [{ label: 'Tatoeba', href: 'https://tatoeba.org/' }]);
});

test('toResponse: an entry with no Tatoeba example credits nothing', () => {
  const pack = fixture('en-zh-CN');
  const response = DictPack.toResponse(metaOf(pack), storedRecord(pack, 'apple'), 'zh-CN');
  assert.deepEqual(response.credits, []);
  assert.equal(DictEntry.entryFor('word', response).credits, undefined);
  const colour = DictPack.toResponse(metaOf(pack), storedRecord(pack, 'colour'), 'zh-CN');
  assert.deepEqual(colour.entry.examples, []);
  assert.deepEqual(colour.entry.forms, []);
});

test('toResponse: ja→zh-CN — a JMdict record credits JMdict', () => {
  const pack = fixture('ja-zh-CN');
  const response = DictPack.toResponse(metaOf(pack), storedRecord(pack, '食べる'), 'zh-CN');
  assert.deepEqual(response.credits, [pack.credits.jmdict]);
  const entry = DictEntry.entryFor('word', response);
  assert.equal(entry.translation, '吃');
  assert.deepEqual(entry.credits, [{ label: 'JMdict © EDRDG', href: 'https://www.edrdg.org/edrdg/licence.html' }]);
  const cat = DictPack.toResponse(metaOf(pack), storedRecord(pack, '猫'), 'zh-CN');
  assert.deepEqual(cat.credits, [], 'a Wiktionary record in a JMdict pack credits nothing');
});

test('toResponse: ko→en — UK and US, an empty side dropped, null is none', () => {
  const pack = fixture('ko-en');
  const meta = metaOf(pack);
  const response = DictPack.toResponse(meta, storedRecord(pack, '학교'), 'en');
  assert.deepEqual(response.entry.phonetics, [{ label: 'UK', ipa: '/skuːl/' }, { label: 'US', ipa: '/skul/' }]);
  assert.deepEqual(DictEntry.entryFor('word', response).phonetics, response.entry.phonetics);
  const usOnly = { e: [['noun', ['school'], '|/skul/', 'wiktionary']] };
  assert.deepEqual(DictPack.toResponse(meta, usOnly, 'en').entry.phonetics, [{ label: 'US', ipa: '/skul/' }]);
  const none = { e: [['noun', ['school'], null, 'wiktionary']] };
  assert.deepEqual(DictPack.toResponse(meta, none, 'en').entry.phonetics, []);
});

test('toResponse: the translation is the first non-empty gloss, and empty or blank glosses are no defs (D-609 N8)', () => {
  const pack = fixture('en-zh-CN');
  const record = { e: [['v.', [' ', '跑'], null, 'wiktionary'], ['n.', ['跑步', ''], null, 'wiktionary']] };
  const response = DictPack.toResponse(metaOf(pack), record, 'zh-CN');
  assert.equal(response.translation, '跑');
  assert.deepEqual(response.entry.senses, [{ pos: 'v.', defs: ['跑'] }, { pos: 'n.', defs: ['跑步'] }]);
  DictEntry.entryFor('word', response);
});

test('foldCandidates: exact, lower case, NFKC', () => {
  assert.deepEqual(DictPack.foldCandidates(' Ran ', 'en'), ['Ran', 'ran']);
  assert.deepEqual(DictPack.foldCandidates('run', 'en'), ['run']);
  assert.deepEqual(DictPack.foldCandidates('ＲＵＮ', 'en'), ['ＲＵＮ', 'ｒｕｎ', 'RUN', 'run']);
  assert.deepEqual(DictPack.foldCandidates('', 'en'), []);
});

test('foldCandidates: one trailing sentence stop is tried kept, then dropped', () => {
  assert.deepEqual(DictPack.foldCandidates('Apple.', 'en'), ['Apple.', 'apple.', 'Apple', 'apple']);
  assert.deepEqual(DictPack.foldCandidates('猫。', 'ja'), ['猫。', '猫']);
  assert.deepEqual(DictPack.foldCandidates('학교에서?', 'ko').at(-1), '학교');
});

test('foldCandidates: Korean particles — longest first, once, at least one character left', () => {
  const strip = (word) => DictPack.foldCandidates(word, 'ko').slice(1);
  assert.deepEqual(strip('학교에서'), ['학교'], '에서 before 에');
  assert.deepEqual(strip('친구이랑'), ['친구'], '이랑 before 랑');
  assert.deepEqual(strip('학교로'), ['학교']);
  assert.deepEqual(strip('친구으로'), ['친구']);
  assert.deepEqual(strip('학교는은'), ['학교는'], 'only one particle is stripped');
  assert.deepEqual(strip('에서'), [], 'a particle alone is not stripped to nothing');
  assert.deepEqual(strip('이나'), ['이'], '이나 would leave nothing, so 나 is tried next (D-609 N9)');
  assert.deepEqual(strip('이랑'), ['이'], '이랑 would leave nothing, so 랑 is tried next');
  assert.deepEqual(strip('가'), []);
  assert.deepEqual(strip('학교'), []);
  assert.deepEqual(DictPack.foldCandidates('학교에서', 'ja'), ['학교에서'], 'only for a Korean source');
  // Every particle in the list strips, the two-syllable ones before their tails.
  const particles = [
    '은', '는', '이', '가', '을', '를', '에', '에서', '에게', '한테', '께서', '의', '와', '과', '도',
    '로', '으로', '만', '부터', '까지', '보다', '처럼', '이나', '나', '랑', '이랑',
  ];
  for (const particle of particles) assert.deepEqual(strip(`학교${particle}`), ['학교'], particle);
  assert.deepEqual(strip('학교하고'), [], 'a word ending in no particle of the 26 is not stripped');
  assert.equal('KO_PARTICLES' in DictPack, false, 'tested through foldCandidates, not exported');
});
