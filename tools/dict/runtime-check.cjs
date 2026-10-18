#!/usr/bin/env node
// Read every built pack with the extension's own code (npm run dict:runtime-check).
//
//   node tools/dict/runtime-check.cjs [--runtime <dir>] [--packs a,b] [--samples <dir>]
//                                     [--report <dir>] <outDir>
//
// check.py states the pack contract in Python; this gate asks the code that ships it.
// shared/lang-tags.js, shared/dict-entry.js and shared/dict-pack.js are loaded from
// <dir> (default: this repository) in that order, as the extension's service worker
// loads them. Three things are checked against them:
//
//   contract  the constants tools/dict/common.py builds to (MAX_RECS, MAX_GLOSS, MAX_EX,
//             MAX_FORMS_M, FORM_MARK, GLOSS_MAX, LANGS, CREDIT_HOSTS, CREDITS) against
//             DictPack.LIMITS, DictPack.LANGS, DictEntry.MAX_TEXT, the form-key mark
//             DictPack.formKey writes, and the credit hosts parsePack accepts (probed
//             with a minimal pack, since the runtime keeps that table private). Every
//             difference is one `contract FAIL` line.
//   parse     DictPack.parsePack reads each <outDir>/<pack>/<pack>.json. parsePack refuses
//             a whole pack over one bad record and the reader then sees "download failed",
//             so one FAIL here is one dictionary nobody can install.
//   coverage  every token of the sample tables (<samples>/tokens.<lang>.tsv, default
//             <outDir>/../samples) is looked up as content-dict-lookup.js looks a word up:
//             each DictPack.foldCandidates spelling as an entry key first, then each as a
//             form key. A pack whose reading rate on its own source sample (word forms
//             found whose first translation record has a reading) is under
//             common.reading_floor fails. The reading half (which record the card shows
//             first, whether it has a reading) is common.first_word_record, the same rule
//             pairs.py and check.py use, asked once per pack through python3.
//
// Prints one line per pack (`<pack> ok ...` or `<pack> FAIL ...`) and exits 1 unless the
// contract held and every pack passed, 2 on a usage error. The pack list is common.PACKS
// (all 30); --packs narrows it for a partial build, and every pack it names must pass.
// --report writes coverage.csv (one row per pack and sample) into <dir>.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const HERE = __dirname;
const RUNTIME_FILES = ['shared/lang-tags.js', 'shared/dict-entry.js', 'shared/dict-pack.js'];
const OPTIONS = ['--runtime', '--packs', '--samples', '--report'];
const COVERAGE_CSV = ['pair', 'sample', 'sample_types', 'sample_tokens', 'hit_types_pct',
  'hit_tokens_pct', 'reading_word_forms', 'reading_found', 'reading_rate', 'reading_floor',
  'record_reading_rate', 'example_hit_types_pct', 'example_hit_tokens_pct',
  'cedict_reverse_heads', 'hit_types_pct_without_reverse', 'hit_tokens_pct_without_reverse'];

function usage(msg) {
  console.error(`runtime-check: ${msg}\nusage: runtime-check.cjs [--runtime <dir>] [--packs a,b] `
    + '[--samples <dir>] [--report <dir>] <outDir>');
  process.exit(2);
}

function parseArgs(argv) {
  const args = { runtime: path.resolve(HERE, '../..'), packs: null, samples: null, report: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (OPTIONS.includes(a)) {
      const v = argv[++i];
      if (!v) usage(`${a} needs a value`);
      if (a === '--packs') args.packs = v.split(',').filter(Boolean);
      else args[a.slice(2)] = path.resolve(v);
    } else if (a.startsWith('--')) usage(`unknown option ${a}`);
    else if (args.out) usage(`one outDir only (got ${args.out} and ${a})`);
    else args.out = path.resolve(a);
  }
  if (!args.out) usage('outDir is required');
  args.samples = args.samples || path.join(args.out, '..', 'samples');
  return args;
}

/** Run `code` with tools/dict/common.py imported as C; stdin is `input` as JSON, stdout JSON. */
function py(code, input) {
  const head = 'import json, sys\nsys.path.insert(0, sys.argv[1])\nimport common as C\n'
    + 'a = json.load(sys.stdin)\n';
  const r = spawnSync('python3', ['-I', '-B', '-c', head + code, HERE],
    { input: JSON.stringify(input), encoding: 'utf8', maxBuffer: 1 << 30 });
  if (r.error) throw new Error(`python3 could not run (${r.error.code}): it reads tools/dict/common.py`);
  if (r.status !== 0) throw new Error(`python3 failed: ${r.stderr.trim()}`);
  return JSON.parse(r.stdout);
}

// The packs, their floors, common's contract constants, and the sample tables the
// chosen packs are measured on: everything this gate reads from the build side.
const BUILD_SIDE = `
packs = []
for s, t in C.PACKS:
    name = C.pack_name(s, t)
    langs = [s] + [o for o, _ in C.SERVES.get((s, t), ())]
    packs.append({'name': name, 'src': s, 'tgt': t, 't': C.iso(t), 'samples': langs,
                  'floor': C.reading_floor(name)})
chosen = [p for p in packs if a is None or p['name'] in a['packs']]
want = sorted({lang for p in chosen for lang in p['samples']})
samples = {lang: C.read_samples(a['samples'], lang) for lang in want} if a and a['samples'] else {}
contract = {k: getattr(C, k) for k in ('MAX_RECS', 'MAX_GLOSS', 'MAX_EX', 'MAX_FORMS_M',
                                       'FORM_MARK', 'GLOSS_MAX', 'LANGS', 'CREDIT_HOSTS',
                                       'CREDITS')}
print(json.dumps({'packs': packs, 'contract': contract, 'samples': samples}, ensure_ascii=False))
`;

// One pack's reading side: for each head a sample token reached, whether the record the
// card shows first has a reading (null when no record has a translation word), and the
// pack-wide record reading rate.
const READINGS = `
with open(a['path'], encoding='utf-8') as fh:
    e = json.load(fh)['e']
den, num = C.reading_rate(e, a['t'])
heads = {}
for h in a['heads']:
    rec = C.first_word_record(e[h], a['t'])
    heads[h] = None if rec is None else rec[2] is not None
print(json.dumps({'den': den, 'num': num, 'heads': heads}, ensure_ascii=False))
`;

function loadRuntime(runtime) {
  for (const f of RUNTIME_FILES) {
    const file = path.join(runtime, f);
    vm.runInThisContext(fs.readFileSync(file, 'utf8'), { filename: file });
  }
  const { DictPack, DictEntry } = globalThis;
  if (!DictPack || typeof DictPack.parsePack !== 'function') {
    throw new Error(`${runtime}: shared/dict-pack.js defines no DictPack.parsePack`);
  }
  return { DictPack, DictEntry };
}

// ---------------- contract ----------------

/** Whether parsePack takes a minimal pack carrying `credits`. */
function takesCredits(DictPack, credits) {
  const pack = {
    v: 1, src: 'en', tgt: 'ja', ver: 'probe', lic: 'probe',
    sources: [{ id: 'probe', name: 'probe', license: 'probe', url: 'https://example.org/' }],
    credits, e: { probe: [['', ['probe'], null, 'probe']] }, x: {}, m: {}, f: {},
  };
  try {
    DictPack.parsePack(JSON.stringify(pack));
    return true;
  } catch {
    return false;
  }
}

/** One message per constant common.py holds that the runtime does not. */
function contractErrors({ DictPack, DictEntry }, c) {
  const L = DictPack.LIMITS;
  const errors = [];
  const same = (name, value, rtName, rtValue) => {
    if (JSON.stringify(value) !== JSON.stringify(rtValue)) {
      errors.push(`common.${name}=${JSON.stringify(value)} != ${rtName}=${JSON.stringify(rtValue)}`);
    }
  };
  same('MAX_RECS', c.MAX_RECS, 'DictPack.LIMITS.MAX_RECORDS', L.MAX_RECORDS);
  same('MAX_GLOSS', c.MAX_GLOSS, 'DictPack.LIMITS.MAX_GLOSSES', L.MAX_GLOSSES);
  same('MAX_EX', c.MAX_EX, 'DictPack.LIMITS.MAX_EXAMPLES', L.MAX_EXAMPLES);
  same('MAX_FORMS_M', c.MAX_FORMS_M, 'DictPack.LIMITS.MAX_FORMS', L.MAX_FORMS);
  same('GLOSS_MAX', c.GLOSS_MAX, 'DictPack.LIMITS.MAX_TEXT', L.MAX_TEXT);
  same('GLOSS_MAX', c.GLOSS_MAX, 'DictEntry.MAX_TEXT', DictEntry.MAX_TEXT);
  same('LANGS', c.LANGS, 'DictPack.LANGS', [...DictPack.LANGS]);
  // The mark is private to dict-pack.js; formKey is the one place it is written.
  const mark = DictPack.formKey('en', 'ja', '').slice(DictPack.prefixOf('en', 'ja').length);
  same('FORM_MARK', c.FORM_MARK, 'the mark DictPack.formKey writes', mark);

  // Credits: parsePack's id -> host table is private, so it is probed. The minimal pack
  // must parse with no credits, or nothing below would mean anything.
  if (!takesCredits(DictPack, {})) {
    errors.push('the credit probe pack does not parse with no credits; the probe is out of date');
    return errors;
  }
  const ids = Object.keys(c.CREDITS);
  same('CREDIT_HOSTS (count)', c.CREDIT_HOSTS.length, 'DictPack.LIMITS.MAX_CREDITS', L.MAX_CREDITS);
  same('CREDITS (count)', ids.length, 'DictPack.LIMITS.MAX_CREDITS', L.MAX_CREDITS);
  for (const id of ids) {
    if (!takesCredits(DictPack, { [id]: c.CREDITS[id] })) {
      errors.push(`common.CREDITS.${id} ${JSON.stringify(c.CREDITS[id])} is refused by parsePack`);
    }
  }
  for (const host of c.CREDIT_HOSTS) {
    const href = `https://${host}/`;
    const under = ids.filter((id) => takesCredits(DictPack, { [id]: { label: 'probe', href } }));
    if (under.length !== 1) {
      errors.push(`common.CREDIT_HOSTS ${host}: parsePack takes ${href} under ${under.length} credit ids `
        + `(${under.join(', ') || 'none'}), not exactly one`);
    }
  }
  return errors;
}

// ---------------- coverage ----------------

const pct = (a, b) => (b ? Number((100 * a / b).toFixed(1)) : 0);

/**
 * The head `tok` reaches in `pack` the way content-dict-lookup.js looks it up: the first
 * fold that is an entry key, else the first that is a form key (its head). Heads in
 * `skip` are taken out of the pack first, with the form keys that point at them.
 */
function lookup(DictPack, pack, tok, lang, skip) {
  const folds = DictPack.foldCandidates(tok, lang);
  for (const c of folds) if (Object.hasOwn(pack.e, c) && !skip.has(c)) return c;
  for (const c of folds) if (Object.hasOwn(pack.f, c) && !skip.has(pack.f[c])) return pack.f[c];
  return null;
}

/** The heads each sample token reaches: [[head|null, count], ...]. */
function hits(DictPack, pack, sample, lang, skip) {
  return sample.map(([tok, n]) => [lookup(DictPack, pack, tok, lang, skip), n]);
}

function coverage(DictPack, meta, pack, file, samples) {
  // en-zh carries CC-CEDICT read backwards; the report also shows the hit rate without it.
  const reverse = new Set(meta.src === 'en' && meta.t === 'zh'
    ? Object.keys(pack.e).filter((h) => pack.e[h].every((r) => r[3] === 'cedict')) : []);
  const none = new Set();
  const runs = meta.samples.map((lang) => ({
    lang, sample: samples[lang],
    hit: hits(DictPack, pack, samples[lang], lang, none),
    without: reverse.size ? hits(DictPack, pack, samples[lang], lang, reverse) : null,
  }));
  const reached = new Set(runs.flatMap((r) => r.hit.map(([h]) => h)).filter((h) => h !== null));
  const rd = py(READINGS, { path: file, t: meta.t, heads: [...reached] });
  return runs.map(({ lang, sample, hit, without }) => {
    let hitT = 0, hitN = 0, exT = 0, exN = 0, wf = 0, found = 0;
    for (const [h, n] of hit) {
      if (h === null) continue;
      hitT++;
      hitN += n;
      if (Object.hasOwn(pack.x, h)) {
        exT++;
        exN += n;
      }
      const reading = rd.heads[h];
      if (reading !== null) {
        wf++;
        found += reading ? 1 : 0;
      }
    }
    const types = sample.length;
    const tokens = sample.reduce((sum, [, n]) => sum + n, 0);
    const row = {
      pair: meta.name, sample: lang, sample_types: types, sample_tokens: tokens,
      hit_types_pct: pct(hitT, types), hit_tokens_pct: pct(hitN, tokens),
      reading_word_forms: wf, reading_found: found, reading_rate: pct(found, wf),
      reading_floor: meta.floor, record_reading_rate: pct(rd.num, rd.den),
      example_hit_types_pct: pct(exT, hitT), example_hit_tokens_pct: pct(exN, hitN),
      cedict_reverse_heads: '', hit_types_pct_without_reverse: '', hit_tokens_pct_without_reverse: '',
    };
    if (without) {
      const kept = without.filter(([h]) => h !== null);
      row.cedict_reverse_heads = reverse.size;
      row.hit_types_pct_without_reverse = pct(kept.length, types);
      row.hit_tokens_pct_without_reverse = pct(kept.reduce((sum, [, n]) => sum + n, 0), tokens);
    }
    return row;
  });
}

function writeReport(dir, rows) {
  fs.mkdirSync(dir, { recursive: true });
  const cell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const lines = [COVERAGE_CSV.join(','), ...rows.map((r) => COVERAGE_CSV.map((k) => cell(r[k])).join(','))];
  fs.writeFileSync(path.join(dir, 'coverage.csv'), `${lines.join('\n')}\n`);
}

// ---------------- main ----------------

function checkPack(runtime, meta, out, samples) {
  const file = path.join(out, meta.name, `${meta.name}.json`);
  let pack;
  try {
    pack = runtime.DictPack.parsePack(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return { line: `${meta.name} FAIL ${e.code === 'ENOENT' ? `missing ${file}` : e.message}`, rows: [] };
  }
  const heads = Object.keys(pack.e).length;
  const rows = coverage(runtime.DictPack, meta, pack, file, samples);
  const own = rows[0];
  const f1 = (v) => `${v.toFixed(1)}%`;
  const reading = `reading_rate ${f1(own.reading_rate)} (sample ${own.sample}, floor ${f1(meta.floor)})`;
  if (own.reading_rate < meta.floor) {
    return { line: `${meta.name} FAIL ${reading}: under common.reading_floor`, rows };
  }
  const hit = rows.map((r) => `${r.sample} ${f1(r.hit_types_pct)}/${f1(r.hit_tokens_pct)}`).join(', ');
  return { line: `${meta.name} ok heads=${heads} ${reading} hits(types/tokens) ${hit}`, rows, ok: true };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const known = py(BUILD_SIDE, null).packs.map((p) => p.name);
  const names = args.packs || known;
  const unknown = names.filter((p) => !known.includes(p));
  if (unknown.length) usage(`not a v1 pack: ${unknown.join(', ')}`);
  const build = py(BUILD_SIDE, { packs: names, samples: args.samples });
  const runtime = loadRuntime(args.runtime);
  console.log(`runtime ${args.runtime}`);

  const broken = contractErrors(runtime, build.contract);
  for (const msg of broken) console.log(`contract FAIL ${msg}`);
  if (!broken.length) console.log('contract ok');

  const byName = new Map(build.packs.map((p) => [p.name, p]));
  const rows = [];
  let ok = 0;
  for (const name of names) {
    const result = checkPack(runtime, byName.get(name), args.out, build.samples);
    console.log(result.line);
    rows.push(...result.rows);
    if (result.ok) ok++;
  }
  if (args.report) writeReport(args.report, rows);
  console.log(`runtime-check: contract ${broken.length ? 'FAIL' : 'ok'}, ${ok}/${names.length} packs pass`);
  process.exit(ok === names.length && !broken.length ? 0 : 1);
}

main();
