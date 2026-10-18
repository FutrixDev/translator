// The offline dictionary's service-worker half, background/dict-packs.js, run
// for real over an in-memory chrome.storage and a fake fetch (D-686):
//
//   - L1: a pair a stopped worker left failed with reason 'interrupted' did
//     not fail, so the next lookup's DICT_PACK_WANT fetches it again at once;
//     a pair that really failed at the manifest's version is left to the
//     daily check;
//   - L2: an install queued at one version is joined only by a request for
//     that same version; a request for a newer version queues its own job,
//     and that version is the one left seeded.
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const local = {};
const sync = { offlineDictionary: true };
const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
globalThis.chrome = {
  runtime: { id: 'self' },
  alarms: { get: async () => null, create: async () => {} },
  storage: {
    sync: { get: async (defaults) => ({ ...clone(defaults), ...clone(sync) }) },
    local: {
      get: async (keys) => {
        if (keys === null || keys === undefined) return clone(local);
        const names = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
        const out = typeof keys === 'object' && !Array.isArray(keys) ? clone(keys) : {};
        for (const key of names) if (key in local) out[key] = clone(local[key]);
        return out;
      },
      set: async (values) => { Object.assign(local, clone(values)); },
      remove: async (keys) => { for (const key of [].concat(keys)) delete local[key]; },
      getKeys: async () => Object.keys(local),
    },
  },
};

const { handleDictMessage } = await import('../../background/dict-packs.js');
const { DictPack } = globalThis;
const SELF = { id: 'self' };

const fixtureText = (name) =>
  readFileSync(new URL(`../fixtures/dict-runtime/${name}.json`, import.meta.url), 'utf8');

// The pack files the fake server holds, by URL, and the manifest rows naming them.
const files = new Map();
const rows = new Map();
const fetched = [];
const gates = new Map(); // url -> a promise the download waits on

function publish(name, ver) {
  const pack = JSON.parse(fixtureText(name));
  pack.ver = ver;
  const text = JSON.stringify(pack);
  const url = `dict/v1/${ver}/${name}.json`;
  files.set(DictPack.DOWNLOAD_ORIGIN + url, text);
  const row = {
    src: pack.src, tgt: pack.tgt, ver, url,
    sha256: createHash('sha256').update(text).digest('hex'),
    bytes: text.length, rawBytes: text.length, heads: Object.keys(pack.e).length,
  };
  rows.set(DictPack.pairOf(pack.src, pack.tgt), row);
  return row;
}

globalThis.fetch = async (url) => {
  if (url === DictPack.MANIFEST_URL) {
    return new Response(JSON.stringify({ v: 1, packs: [...rows.values()] }));
  }
  fetched.push(url);
  if (gates.has(url)) await gates.get(url);
  if (!files.has(url)) return new Response('', { status: 404 });
  return new Response(files.get(url));
};

const want = (pair) => handleDictMessage({ type: 'DICT_PACK_WANT', ...DictPack.splitPair(pair) }, SELF);

async function until(predicate, what) {
  for (let i = 0; i < 500; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail(`timed out waiting for ${what}`);
}

const seededVer = (pair) => (local[DictPack.PACKS_KEY] || {})[pair]?.ver;

test('L1: an interrupted pack is fetched again by the next lookup', async () => {
  const pair = 'en-zh-CN';
  const row = publish(pair, '2026.10.14');
  local[DictPack.STATUS_KEY] = { [pair]: { state: 'failed', ver: row.ver, reason: 'interrupted' } };
  assert.deepEqual(await want(pair), { state: 'queued' });
  await until(() => seededVer(pair) === row.ver, 'the interrupted pack to be seeded');
  assert.deepEqual(fetched.filter((url) => url.endsWith(row.url)), [DictPack.DOWNLOAD_ORIGIN + row.url]);
  assert.equal((local[DictPack.STATUS_KEY] || {})[pair], undefined, 'the failed mark is cleared');
  assert.ok(local[DictPack.entryKey('en', 'zh-CN', 'run')], 'its heads are in storage');
});

test('L1: a pack that really failed at this version waits for the daily check', async () => {
  const pair = 'ko-en';
  const row = publish(pair, '2026.10.14');
  local[DictPack.STATUS_KEY] = { [pair]: { state: 'failed', ver: row.ver, reason: 'HTTP 500' } };
  const before = fetched.length;
  assert.deepEqual(await want(pair), { state: 'failed' });
  assert.equal(fetched.length, before, 'nothing is downloaded');
  assert.equal(seededVer(pair), undefined);
});

test('L2: a request for a newer version does not join the queued older install', async () => {
  const pair = 'ja-zh-CN';
  const older = publish(pair, '2026.10.13');
  let release;
  gates.set(DictPack.DOWNLOAD_ORIGIN + older.url, new Promise((resolve) => { release = resolve; }));
  assert.deepEqual(await want(pair), { state: 'queued' });
  await until(() => fetched.includes(DictPack.DOWNLOAD_ORIGIN + older.url), 'the older download to start');

  // The manifest moves on while the older job is still downloading.
  const newer = publish(pair, '2026.10.14');
  assert.deepEqual(await want(pair), { state: 'queued' });
  release();
  await until(() => seededVer(pair) === newer.ver, 'the newer version to be seeded');
  assert.ok(fetched.includes(DictPack.DOWNLOAD_ORIGIN + newer.url), 'the newer pack was downloaded');
});

test('L2: a request for the version already queued joins it: one download', async () => {
  const pair = 'ko-en';
  delete local[DictPack.STATUS_KEY];
  const row = publish(pair, '2026.10.15');
  const url = DictPack.DOWNLOAD_ORIGIN + row.url;
  let release;
  gates.set(url, new Promise((resolve) => { release = resolve; }));
  assert.deepEqual(await want(pair), { state: 'queued' });
  assert.deepEqual(await want(pair), { state: 'queued' });
  release();
  await until(() => seededVer(pair) === row.ver, 'the pack to be seeded');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fetched.filter((u) => u === url).length, 1);
});
