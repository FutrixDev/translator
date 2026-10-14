// Guards for tools/dict/ — the offline dictionary pack pipeline (design
// ext-offline-dictionary.md, pack format tools/dict/FORMAT.md).
//
// The pipeline is Python run as `python3 -I`; these tests build the es-en pack
// from the small real excerpt in test/fixtures/dict/ (provenance in its README)
// with pairs.py, then hold check.py — the acceptance gate — to its word: the
// shipped pack passes every rule except the heads floor (an excerpt cannot reach
// 0.95 x the full dictionary), and each broken copy (licence deleted, readings
// nulled, a bad example inserted) adds exactly its own reason and keeps the exit
// status non-zero. Without python3 or brotli on PATH these tests fail; they never
// skip, because a gate nobody runs is no gate.
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TOOLS = path.join(ROOT, 'tools/dict');
const FIXTURE = path.join(ROOT, 'test/fixtures/dict');
const PACK = 'es-en';
const VER = '2026.10.13';

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.error) throw new Error(`${cmd} could not run (${r.error.code}): the dict tools need it on PATH`);
  return r;
}

function python(script, args) {
  return run('python3', ['-I', '-B', path.join(TOOLS, script), ...args]);
}

/** Run `code` with tools/dict importable (sys.argv[1] is that dir, the rest are `args`) and
 *  parse the JSON it prints. */
function pyJson(code, ...args) {
  const r = run('python3', ['-I', '-B', '-c', `import sys, json\nsys.path.insert(0, sys.argv[1])\n${code}`,
    TOOLS, ...args]);
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

const tmp = mkdtempSync(path.join(tmpdir(), 'dict-tools-'));
process.on('exit', () => rmSync(tmp, { recursive: true, force: true }));

test('python3 and brotli are on PATH (the tests fail rather than skip without them)', () => {
  assert.equal(run('python3', ['-I', '-c', 'import sys; assert sys.version_info >= (3, 9)']).status, 0);
  assert.equal(run('brotli', ['--version']).status, 0);
});

// Build once; every test below reads this output or a copy of it.
const OUT = path.join(tmp, 'out');
const built = python('pairs.py', [
  path.join(FIXTURE, 'norm'), OUT, '--work', path.join(tmp, 'work'), '--stats', path.join(tmp, 'stats'),
  '--ver', VER, '--license', path.join(TOOLS, 'cc-by-sa-4.0.txt'), '--packs', PACK, '--jobs', '2',
]);
const packFile = (out) => path.join(out, PACK, `${PACK}.json`);
const readPack = (out = OUT) => JSON.parse(readFileSync(packFile(out), 'utf8'));

/** check.py on one out dir: its exit status and the reasons on the pack's FAIL line. */
function check(out, norm = path.join(FIXTURE, 'norm')) {
  const r = python('check.py', [
    out, '--samples', path.join(FIXTURE, 'samples'), '--norm', norm,
    '--work', path.join(tmp, 'work'), '--packs', PACK, '--jobs', '1',
  ]);
  const fail = r.stdout.split('\n').find((l) => l.startsWith(`FAIL ${PACK}: `));
  const reasons = fail ? fail.slice(`FAIL ${PACK}: `.length).split('; ') : [];
  return { status: r.status, reasons, stdout: r.stdout, stderr: r.stderr };
}

/** A copy of the built pack directory, changed by `mutate(dir, pack)`. */
function mutant(name, mutate) {
  const out = path.join(tmp, `mutant-${name}`);
  cpSync(OUT, out, { recursive: true });
  const pack = readPack(out);
  mutate(path.join(out, PACK), pack);
  writeFileSync(packFile(out), JSON.stringify(pack));
  return out;
}

test('pairs.py builds the es-en pack in the v1 shape', () => {
  assert.equal(built.status, 0, built.stdout + built.stderr);
  assert.match(built.stdout, /pairs: 1\/1 packs/);
  const pack = readPack();
  assert.deepEqual(Object.keys(pack), ['v', 'src', 'tgt', 'ver', 'lic', 'sources', 'credits', 'e', 'x', 'm', 'f']);
  assert.equal(pack.v, 1);
  assert.equal(pack.src, 'es');
  assert.equal(pack.tgt, 'en');
  assert.equal(pack.ver, VER);
  assert.equal(pack.lic, 'CC-BY-SA-4.0');
  const records = Object.values(pack.e).flat();
  assert.ok(records.length > 0);
  for (const rec of records) {
    assert.equal(rec.length, 4);
    // An English target's reading is "/UK/|/US/" with a missing side empty, or null.
    if (rec[2] !== null) assert.match(rec[2], /^(\/[^/|]+\/)?\|(\/[^/|]+\/)?$/);
  }
  assert.ok(records.some((rec) => rec[2] !== null), 'some record has a reading');
  // Inflected forms resolve through `f` only, and every value is a head.
  assert.ok(Object.keys(pack.f).length > 0);
  for (const head of Object.values(pack.f)) assert.ok(head in pack.e);
  // Examples are human translations with their Tatoeba ids, at most two per head.
  const rows = Object.values(pack.x);
  assert.ok(rows.length > 0, 'the fixture yields examples');
  assert.ok(rows.every((r) => r.length <= 2));
  assert.ok(rows.flat().some((r) => Number.isInteger(r[2]) && Number.isInteger(r[3])));
});

test('the pack directory carries the licence and an attribution naming only what it used', () => {
  const dir = path.join(OUT, PACK);
  assert.deepEqual(readFileSync(path.join(dir, 'LICENSE.txt')), readFileSync(path.join(TOOLS, 'cc-by-sa-4.0.txt')));
  const att = readFileSync(path.join(dir, 'ATTRIBUTION.txt'), 'utf8');
  assert.match(att, /2026-10-13/);
  assert.match(att, /https:\/\/tatoeba\.org\/sentences\/show\//);
  const used = readPack().sources.map((s) => s.id);
  assert.ok(!used.includes('jmdict') && !used.includes('cedict'), `es-en uses neither: ${used}`);
  assert.doesNotMatch(att, /JMdict|CC-CEDICT/);
});

test('check.py passes the fixture pack on every rule but the heads floor', () => {
  const r = check(OUT);
  assert.notEqual(r.status, 0);
  assert.equal(r.reasons.length, 1, r.stdout + r.stderr);
  assert.match(r.reasons[0], /^entries \d+ < 105696$/);
});

test('heads floor of a form-table source counts entries: a form-of entry f resolves counts once', () => {
  // es-en: a word whose gloss text made it form-of (normalize marks it `lt`) left e for f and
  // still answers a lookup, so it counts beside the heads of e; a word kaikki itself marks
  // form_of does not (it was f in the spike too), and an f key that is a head of e counts once.
  // The excerpt has no `lt` row (the full es-en norm has 3, none in the top 160 tokens), so a
  // copy of its norm marks two real rows: "años: plural of año" and "son", form of "ser".
  const norm = path.join(tmp, 'norm-lt');
  cpSync(path.join(FIXTURE, 'norm'), norm, { recursive: true });
  const kaikki = path.join(norm, 'kaikki/es-en.jsonl');
  const marked = readFileSync(kaikki, 'utf8').split('\n').map((line) => {
    if (!line) return line;
    const r = JSON.parse(line);
    return (r.w === 'años' || r.w === 'son') && r.lo.length ? JSON.stringify({ ...r, lt: 1 }) : line;
  });
  writeFileSync(kaikki, marked.join('\n'));
  const pack = readPack();
  const counted = (out, n = norm) => {
    const { reasons } = check(out, n);
    return Number(/^entries (\d+) < /.exec(reasons.find((x) => x.startsWith('entries ')))[1]);
  };
  const heads = Object.keys(pack.e).length;
  assert.ok('años' in pack.f && !('años' in pack.e));
  assert.equal(counted(OUT), heads + 1);
  assert.equal(counted(OUT, path.join(FIXTURE, 'norm')), heads, 'a kaikki form_of row is not counted');
  assert.equal(counted(mutant('heads-entries', (_dir, p) => { delete p.f['años']; })), heads,
    'a moved word f cannot resolve is a loss');
  // "son" is a head of e and also a form of "ser": an f row for it adds nothing.
  assert.ok('son' in pack.e && !('son' in pack.f));
  assert.equal(counted(mutant('heads-entries-dup', (_dir, p) => { p.f.son = 'ser'; })), heads + 1);
  // Size cut 4 keeps the same set the floor counts (an en target too), so the floor's words
  // stay in f: formtab's moved keys take the lt words from common.form_of_entries.
  const moved = pyJson(`
import entries, formtab
b = entries.Builder(sys.argv[2], sys.argv[3], 'es', 'en')
b.build()
_f, _m, moved, _s = formtab.build(sys.argv[2], sys.argv[3], b)
print(json.dumps(sorted(moved)))`, norm, path.join(tmp, 'work'));
  assert.ok(moved.includes('años'), 'a word the floor counts survives size cut 4');
});

test('check.py fails a pack whose LICENSE.txt is gone', () => {
  const r = check(mutant('license', (dir) => unlinkSync(path.join(dir, 'LICENSE.txt'))));
  assert.notEqual(r.status, 0);
  assert.ok(r.reasons.includes('LICENSE.txt missing or not the CC BY-SA 4.0 text'), r.stdout);
});

test('check.py fails a pack whose readings are all null', () => {
  const r = check(mutant('readings', (_dir, pack) => {
    for (const recs of Object.values(pack.e)) for (const rec of recs) rec[2] = null;
  }));
  assert.notEqual(r.status, 0);
  assert.ok(r.reasons.some((x) => /^reading 0\.0% < 93\.8%$/.test(x)), r.stdout);
});

test('check.py fails an English reading with a phonetic [..] side', () => {
  const r = check(mutant('enreading', (_dir, pack) => {
    const rec = Object.values(pack.e).flat().find((x) => x[2] !== null);
    rec[2] = `${rec[2].split('|')[0]}|[x]`;
  }));
  assert.notEqual(r.status, 0);
  assert.ok(r.reasons.includes('1 bad e entries'), r.stdout);
});

test('check.py fails an example whose sentence does not contain its head', () => {
  const r = check(mutant('example', (_dir, pack) => {
    const head = Object.keys(pack.x)[0];
    pack.x[head] = [['Zzz qqq.', 'Zzz qqq.', null, null]];
  }));
  assert.notEqual(r.status, 0);
  assert.ok(r.reasons.some((x) => /^1 x heads fail containment\/order/.test(x)), r.stdout);
});

test('check.py fails an x head with more than two rows', () => {
  const r = check(mutant('x3', (_dir, pack) => {
    const head = Object.keys(pack.x).find((h) => /^[a-zñáéíóú]+$/.test(h));
    pack.x[head] = [`${head}.`, `${head} ${head}.`, `${head} ${head} ${head}.`]
      .map((text) => [text, 'Three.', null, null]);
  }));
  assert.notEqual(r.status, 0);
  assert.ok(r.reasons.includes('1 bad x entries'), r.stdout);
});

test('check.py fails an example sentence over 80 characters, even one containing its head', () => {
  const r = check(mutant('x80', (_dir, pack) => {
    const head = Object.keys(pack.x).find((h) => /^[a-zñáéíóú]+$/.test(h));
    pack.x[head] = [[`${head} ${'casa '.repeat(16)}`.trim(), 'Long.', null, null]];
  }));
  assert.notEqual(r.status, 0);
  assert.ok(r.reasons.some((x) => /^1 x heads fail containment\/order/.test(x)), r.stdout);
});

test('D-578: a zh-source f key must be a same-length Han fold of its head', () => {
  const run578 = (f) => pyJson(`
import check
err = []
check.check_d578({'f': json.loads(sys.argv[2])}, lambda s: {'書': '书'}.get(s, s), err)
print(json.dumps(err))`, JSON.stringify(f));
  assert.deepEqual(run578({ '書': '书' }), []);
  const err = run578({ '書': '书', '书本': '书' });
  assert.ok(err.includes('D-578: 1 f keys are not a Han script fold of their value'), err);
});

// The per-record rules, one hand-made record each: the rule fires on the bad record and not
// on its corrected twin.
function recordRules(pack, s, t, candidates) {
  return pyJson(`
import check
pack, s, t, cand = json.loads(sys.argv[2]), sys.argv[3], sys.argv[4], set(json.loads(sys.argv[5]))
class Reads:
    def candidates(self, word):
        return cand
err = []
check.check_records(pack, s, t, Reads(), err)
print(json.dumps(err))`, JSON.stringify(pack), s, t, JSON.stringify(candidates));
}

test('G1: a reading the tables do not give for the translation word fails', () => {
  const pack = { e: { dog: [['noun', ['狗'], 'gǒu', 'wiktionary']] } };
  assert.deepEqual(recordRules(pack, 'en', 'zh', ['gǒu']), []);
  assert.deepEqual(recordRules(pack, 'en', 'zh', ['gōu']), ["G1: 1 records (e.g. 'dog')"]);
});

test('G2: a Cantonese marker or Cyrillic in a zh first gloss fails', () => {
  const ok = { e: { give: [['verb', ['给'], null, 'wiktionary']] } };
  assert.deepEqual(recordRules(ok, 'en', 'zh', []), []);
  for (const bad of ['畀', 'дать']) {
    const pack = { e: { give: [['verb', [bad, '给'], null, 'wiktionary']] } };
    assert.deepEqual(recordRules(pack, 'en', 'zh', []), ["G2: 1 records (e.g. 'give')"], bad);
  }
});

test('G3: a Wiktionary form-of first gloss fails; JMdict, CC-CEDICT and "form of X" pass', () => {
  const pack = (gloss, origin) => ({ e: { perros: [['noun', [gloss], null, origin]] } });
  assert.deepEqual(recordRules(pack('plural of perro', 'wiktionary'), 'es', 'en', []),
    ["G3: 1 records (e.g. 'perros')"]);
  assert.deepEqual(recordRules(pack('form of government', 'wiktionary'), 'es', 'en', []), []);
  assert.deepEqual(recordRules(pack('dogs', 'wiktionary'), 'es', 'en', []), []);
  // JMdict 連珠 "variant of gobang" and CC-CEDICT meta are content, not `f` rows.
  assert.deepEqual(recordRules(pack('variant of gobang', 'jmdict'), 'ja', 'en', []), []);
  assert.deepEqual(recordRules(pack('variant of 叫[jiao4]', 'cedict'), 'zh', 'en', []), []);
});

test('form-of detection sees the gloss the card shows: leading punctuation is no disguise', () => {
  // zh-CN-fr 呌 came as ", variante de 叫 (jiào)": normalize missed the form-of and the
  // pack showed it cleaned (D-614 G3). One prefix rule serves both (common.GLOSS_LEAD).
  const out = pyJson(`
import common as C
print(json.dumps([C.form_of_lemma(g, l) for g, l in json.loads(sys.argv[2])]))`,
    JSON.stringify([[', variante de 叫 (jiào)', 'fr'], ['• Plural von Hund', 'de'],
      [':Template:廢 ache的過去分詞', 'zh'], ['dog', 'en']]));
  assert.deepEqual(out, ['叫', 'Hund', 'ache', null]);
});

// Real CC-CEDICT and OpenCC rows (tools/dict/sources.json snapshot), written to a scratch
// normalized dir for the Builder.
const CEDICT_ROWS = [
  { s: '狗', t: '狗', p: 'gǒu', g: ['dog', 'CL:隻|只[zhi1],條|条[tiao2]'] },
  { s: '獢', t: '獢', p: 'xiāo', g: ['dog'] },
  { s: '戏台', t: '戲臺', p: 'xì tái', g: ['stage'] },
  { s: '前台', t: '前臺', p: 'qián tái', g: ['stage', 'proscenium', 'foreground in politics etc (sometimes derog.)', 'front desk', 'reception desk', '(computing) front-end', 'foreground'] },
  { s: '书', t: '書', p: 'Shū', g: ['abbr. for 書經|书经[Shu1 jing1]'] },
  { s: '书', t: '書', p: 'shū', g: ['book', 'letter', 'document', 'CL:本[ben3],冊|册[ce4],部[bu4]', 'to write'] },
  { s: '年', t: '秊', p: 'nián', g: ['grain', 'harvest (old)', 'variant of 年[nian2]'] },
  { s: '年', t: '年', p: 'nián', g: ['year', 'CL:個|个[ge4]'] },
];
const ZH_NORM = path.join(tmp, 'zh-norm');
{
  const dir = path.join(ZH_NORM, 'opencc');
  mkdirSync(dir, { recursive: true });
  const tables = { 'TSCharacters.txt': '書\t书\n臺\t台\n戲\t戏\n', 'TSPhrases.txt': '' };
  for (const f of ['STPhrases.txt', 'STCharacters.txt', 'TWPhrases.txt', 'TWVariants.txt']) tables[f] = '';
  for (const [f, text] of Object.entries(tables)) writeFileSync(path.join(dir, f), text);
  writeFileSync(path.join(ZH_NORM, 'cedict.jsonl'), CEDICT_ROWS.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

test('en->zh reverse lookup keeps a CC-CEDICT gloss only when it names one head', () => {
  const e = pyJson(`
import entries
b = entries.Builder(sys.argv[2], sys.argv[3], 'en', 'zh-CN')
b.cedict_reverse()
print(json.dumps({h: [r[:4] for r in recs] for h, recs in b.e.items()}, ensure_ascii=False))`,
  ZH_NORM, path.join(tmp, 'zh-work'));
  assert.deepEqual(e.proscenium, [['', ['前台'], 'qián tái', 'cedict']]);
  assert.deepEqual(e['front desk'], [['', ['前台'], 'qián tái', 'cedict']]);
  assert.equal(e.dog, undefined, 'dog names 狗 and 獢');
  assert.equal(e.stage, undefined, 'stage names 戏台 and 前台');
  assert.equal(e['foreground in politics etc'], undefined);
});

test('zh source: Traditional spellings fold to the Simplified head and meta records go last (G4)', () => {
  const out = pyJson(`
import entries, check
b = entries.Builder(sys.argv[2], sys.argv[3], 'zh-CN', 'en')
fold = b.head_of('書')
b.read_cedict(sys.argv[2] + '/cedict.jsonl')
b.order_records()
class Reads:
    def candidates(self, word):
        return set()
def g4(e):
    err = []
    check.check_records({'e': e}, 'zh', 'en', Reads(), err)
    return err
flipped = {h: recs[::-1] for h, recs in b.e.items()}
print(json.dumps({'fold': fold, 'trad': b.trad_heads, 'shu': b.e['书'], 'nian': b.e['年'],
                  'ok': g4(b.e), 'flipped': g4(flipped)}, ensure_ascii=False))`,
  ZH_NORM, path.join(tmp, 'zh-work'));
  assert.equal(out.fold, '书');
  assert.deepEqual(out.trad, [['書', '书']]);
  assert.deepEqual(out.shu.map((r) => r[1][0]), ['book', 'abbr. for 书经']);
  assert.deepEqual(out.nian.map((r) => r[1][0]), ['year', 'grain'], 'the variant spelling 秊 goes after 年');
  assert.deepEqual(out.ok, []);
  assert.deepEqual(out.flipped, ["G4: 1 records (e.g. '书')"]);
});

test('ja forms: polite and plain rows for ichidan and godan verbs', () => {
  const f = pyJson(`
import ja_forms
print(json.dumps({w: ja_forms.forms(w, c) for w, c in (('食べる', 'v1'), ('書く', 'v5k'))}, ensure_ascii=False))`);
  assert.ok(f['食べる'].some(([w, k]) => w === '食べます' && k === 'masu'));
  const godan = Object.fromEntries(f['書く'].map(([w, k]) => [k, w]));
  assert.deepEqual([godan.masu, godan.ta, godan.te, godan.nai], ['書きます', '書いた', '書いて', '書かない']);
});

test('f votes: marked rows count after plain ones; a weak head yields only to a plain inflection row', () => {
  const out = pyJson(`
import formtab
e = {h: [['', [h], None, 'wiktionary']] for h in ('go', 'wend', 'the', 'thee', 'is', 'be')}
fm = formtab.Forms(e, 'en', 'de', weak_heads={'the', 'is'})
fm.put('went', 'go', 0, ('past',))
for _ in range(2):
    fm.put('went', 'wend', 0, ('archaic', 'past'))
fm.put('the', 'thee', 0, ('alternative', 'obsolete'))
fm.put('the', 'thee', 0, ('form-of',))
fm.put('is', 'be', 0, ('present', 'singular', 'third-person'))
f, _m = fm.finish()
print(json.dumps({'f': f, 'heads': sorted(e), 'kept': fm.kept_weak, 'moved': sorted(fm.moved)}))`);
  assert.equal(out.f.went, 'go');
  assert.equal(out.f.is, 'be');
  assert.equal(out.f.the, undefined, 'the keeps its own entry');
  assert.ok(out.heads.includes('the') && !out.heads.includes('is'));
  assert.equal(out.kept, 1);
  assert.deepEqual(out.moved, ['is'], 'the key that left e is what size cut 4 must keep');
});

test('f chain: a gloss-slice form-of word whose lemma is only a key follows it one hop', () => {
  const out = pyJson(`
import formtab
from entries import FORM_ROWS_RANK as SLICE
e = {h: [['', [h], None, 'wiktionary']] for h in ('stepping stone', 'glomerulus')}
fm = formtab.Forms(e, 'en', 'ja')
fm.put('steppingstone', 'stepping stone', 0, ('form-of',))
fm.put('steppingstones', 'steppingstone', SLICE, ('form-of',))
fm.put('glom', 'glomerulus', 0, ('form-of',))
fm.put('glommed', 'glom', 0, ('form-of',))
fm.put('nowheres', 'nowhere', SLICE, ('form-of',))
f, _m = fm.finish()
print(json.dumps({'f': f, 'chained': fm.chained, 'moved': sorted(fm.moved)}))`);
  assert.equal(out.f.steppingstones, 'stepping stone');
  // kaikki's own form-of rows do not chain: glom (to grab) is not glomerulus
  assert.equal(out.f.glommed, undefined);
  assert.equal(out.f.nowheres, undefined, 'a lemma that is no key is still lost');
  assert.equal(out.chained, 1);
  assert.ok(out.moved.includes('steppingstones') && !out.moved.includes('steppingstone'));
});

test('records: of two with the same glosses the one that sorts first stays', () => {
  const recs = pyJson(`
import entries
b = entries.Builder(sys.argv[2], sys.argv[2], 'en', 'de')
b.add('still', 'adj', ['noch'], 'wiktionary', order=5)
b.add('still', 'adv', ['noch'], 'wiktionary', order=1)
b.add('still', 'adj', ['noch'], 'wiktionary', order=7)
print(json.dumps([r[:4] for r in b.e['still']]))`, tmp);
  assert.deepEqual(recs, [['adv', ['noch'], null, 'wiktionary']]);
});

test('translation tables: another variety of the target, and an affix under a word, are dropped', () => {
  const by = pyJson(`
import normalize
item = lambda word, code='de', lang='German', **kw: dict(word=word, lang_code=code, lang=lang, **kw)
e = {'word': 'child', 'senses': [{'glosses': ['a young person'], 'translations': [
    item('Kind'), item('Chind', tags=['Alemannic-German']), item('kindl', lang='Bavarian German'),
    item('Kind', lang='Austrian German'), item('孩子', 'cmn', 'Chinese Mandarin'),
    item('細路', 'yue', 'Cantonese'), item('仔', 'cmn', 'Chinese', tags=['Cantonese'])]}]}
will = {'word': 'will', 'senses': [{'glosses': ['future'], 'translations': [
    item('-ra', 'fr', 'French'), item('vouloir', 'fr', 'French')]}]}
suffix = {'word': '-ness', 'senses': [{'glosses': ['state'], 'translations': [item('-heit')]}]}
codes = {'de': 'de', 'fr': 'fr', 'cmn': 'zh', 'yue': 'zh'}
print(json.dumps({w['word']: {t: v[0] for t, v in normalize.kaikki_senses_tr(w, codes)[0].items()}
                  for w in (e, will, suffix)}, ensure_ascii=False))`);
  assert.deepEqual(by.child, { de: [['Kind']], zh: [['孩子']] });
  assert.deepEqual(by.will, { fr: [['vouloir']] });
  assert.deepEqual(by['-ness'], { de: [['-heit']] });
});

test('translation items: a one-word head keeps a long translation, not a sentence', () => {
  const out = pyJson(`
import normalize
w = lambda word: normalize.tr_item_word({'word': word, 'lang': 'French'}, 'fr', False, False)
print(json.dumps([w('agent de la police des frontières'), w('il fait beau aujourd hui.')]))`);
  assert.deepEqual(out, ['agent de la police des frontières', null]);
});

test('size cut 4: f-attested keeps a key R8 moved out of e, even under an unattested head', () => {
  const out = pyJson(`
import formtab
f = {'curios': 'curio', 'curioz': 'curio', 'went': 'go'}
f2, _m = formtab.cut('f-attested', f, {}, {'go'}, set(), frozenset({'curios'}))
print(json.dumps(f2))`);
  assert.deepEqual(out, { curios: 'curio', went: 'go' });
});
