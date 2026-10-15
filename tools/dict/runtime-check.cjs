#!/usr/bin/env node
// Read every built pack with the extension's own parser (npm run dict:runtime-check).
//
//   node tools/dict/runtime-check.cjs [--runtime <dir>] [--packs a,b] <outDir>
//
// check.py states the pack contract in Python; this gate asks the code that ships it.
// shared/lang-tags.js, shared/dict-entry.js and shared/dict-pack.js are loaded from
// <dir> (default: this repository) in that order, as the extension's service worker
// loads them, and DictPack.parsePack reads each <outDir>/<pack>/<pack>.json. parsePack
// refuses a whole pack over one bad record and the reader then sees "download failed",
// so one FAIL here is one dictionary nobody can install.
//
// Prints `<pack> ok heads=N` or `<pack> FAIL <message>` per pack and exits non-zero
// unless every pack passed. The pack list is common.PACKS (all 30); --packs narrows it
// for a partial build, and every pack it names must still pass.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const HERE = __dirname;
const RUNTIME_FILES = ['shared/lang-tags.js', 'shared/dict-entry.js', 'shared/dict-pack.js'];

function usage(msg) {
  console.error(`runtime-check: ${msg}\nusage: runtime-check.cjs [--runtime <dir>] [--packs a,b] <outDir>`);
  process.exit(2);
}

function parseArgs(argv) {
  const args = { runtime: path.resolve(HERE, '../..'), packs: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--runtime' || a === '--packs') {
      const v = argv[++i];
      if (!v) usage(`${a} needs a value`);
      if (a === '--runtime') args.runtime = path.resolve(v);
      else args.packs = v.split(',').filter(Boolean);
    } else if (a.startsWith('--')) usage(`unknown option ${a}`);
    else if (args.out) usage(`one outDir only (got ${args.out} and ${a})`);
    else args.out = path.resolve(a);
  }
  if (!args.out) usage('outDir is required');
  return args;
}

/** The 30 pack names, from common.PACKS so the list lives in one place. */
function allPacks() {
  const code = 'import sys\nsys.path.insert(0, sys.argv[1])\nimport common as C\n'
    + "print('\\n'.join(C.pack_name(s, t) for s, t in C.PACKS))";
  const r = spawnSync('python3', ['-I', '-B', '-c', code, HERE], { encoding: 'utf8' });
  if (r.error) throw new Error(`python3 could not run (${r.error.code}): it reads the pack list`);
  if (r.status !== 0) throw new Error(`reading common.PACKS failed: ${r.stderr.trim()}`);
  return r.stdout.split('\n').filter(Boolean);
}

function loadParser(runtime) {
  for (const f of RUNTIME_FILES) {
    const file = path.join(runtime, f);
    vm.runInThisContext(fs.readFileSync(file, 'utf8'), { filename: file });
  }
  const parsePack = globalThis.DictPack && globalThis.DictPack.parsePack;
  if (typeof parsePack !== 'function') throw new Error(`${runtime}: shared/dict-pack.js defines no DictPack.parsePack`);
  return parsePack;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const known = allPacks();
  const packs = args.packs || known;
  const unknown = packs.filter((p) => !known.includes(p));
  if (unknown.length) usage(`not a v1 pack: ${unknown.join(', ')}`);
  const parsePack = loadParser(args.runtime);
  console.log(`runtime ${args.runtime}`);
  let ok = 0;
  for (const pack of packs) {
    const file = path.join(args.out, pack, `${pack}.json`);
    let line;
    try {
      const parsed = parsePack(fs.readFileSync(file, 'utf8'));
      line = `${pack} ok heads=${Object.keys(parsed.e).length}`;
      ok++;
    } catch (e) {
      line = `${pack} FAIL ${e.code === 'ENOENT' ? `missing ${file}` : e.message}`;
    }
    console.log(line);
  }
  console.log(`runtime-check: ${ok}/${packs.length} packs parse`);
  process.exit(ok === packs.length ? 0 : 1);
}

main();
