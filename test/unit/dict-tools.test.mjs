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
import { cpSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
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
  return run('python3', ['-I', path.join(TOOLS, script), ...args]);
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
function check(out) {
  const r = python('check.py', [out, '--samples', path.join(FIXTURE, 'samples'), '--packs', PACK, '--jobs', '1']);
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
  assert.match(r.reasons[0], /^heads \d+ < 105696$/);
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
