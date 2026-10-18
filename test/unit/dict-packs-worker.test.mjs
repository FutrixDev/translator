// The offline dictionary's service-worker half, background/dict-packs.js, run
// for real over an in-memory chrome.storage and a fake fetch (D-686):
//
//   - L1: a pair a stopped worker left failed with reason 'interrupted' did
//     not fail, so the next lookup's DICT_PACK_WANT fetches it again at once;
//     a pair that really failed at the manifest's version is left to the
//     daily check;
//   - L2: an install queued at one version is joined only by a request for
//     that same version; a request for a newer version queues its own job,
//     and that version is the one left seeded;
//   - L3 (N2): a download holds the worker awake until its last byte and
//     carries the version's count of stopped workers; a lookup stops fetching
//     a version after three in a row, and a new version starts again from 0;
//   - L4 (N2): in a new worker, a lookup that reads the count before the
//     recovery adds the third stop is still refused on the queue; a daily
//     check or preinstall does not join that lookup's job, and fetches.
//
// The module is imported once more for each new worker (newWorker()): its
// once-per-worker recovery and its queue start over, the storage stays.
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const local = {};
const sync = { offlineDictionary: true };
const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const heldWrites = []; // { matches(values), gate }: a local.set that waits once
let syncReads = 0;

/** Hold the next chrome.storage.local.set that `matches` until the returned release(). */
function holdWrite(matches) {
  let release;
  heldWrites.push({ matches, gate: new Promise((resolve) => { release = resolve; }) });
  return release;
}

globalThis.chrome = {
  runtime: { id: 'self' },
  alarms: { get: async () => null, create: async () => {} },
  storage: {
    sync: {
      get: async (defaults) => {
        syncReads += 1;
        return { ...clone(defaults), ...clone(sync) };
      },
    },
    local: {
      get: async (keys) => {
        if (keys === null || keys === undefined) return clone(local);
        const names = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
        const out = typeof keys === 'object' && !Array.isArray(keys) ? clone(keys) : {};
        for (const key of names) if (key in local) out[key] = clone(local[key]);
        return out;
      },
      set: async (values) => {
        const held = heldWrites.findIndex((hold) => hold.matches(values));
        if (held >= 0) await heldWrites.splice(held, 1)[0].gate;
        Object.assign(local, clone(values));
      },
      remove: async (keys) => { for (const key of [].concat(keys)) delete local[key]; },
      getKeys: async () => Object.keys(local),
    },
  },
};

const { handleDictMessage } = await import('../../background/dict-packs.js');
let workers = 0;
const newWorker = () => import(`../../background/dict-packs.js?worker=${(workers += 1)}`);
const { keepaliveState } = await import('../../background/keepalive.js');
const { DictPack } = globalThis;
const SELF = { id: 'self' };

const fixtureText = (name) =>
  readFileSync(new URL(`../fixtures/dict-runtime/${name}.json`, import.meta.url), 'utf8');

// The pack files the fake server holds, by URL, and the manifest rows naming them.
const files = new Map();
const rows = new Map();
const fetched = [];
const gates = new Map(); // url -> a promise the response waits on
const bodyGates = new Map(); // url -> a promise the body's second half waits on
const bodyPending = new Set(); // urls whose reader is waiting on that second half

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
  if (!bodyGates.has(url)) return new Response(files.get(url));
  // The headers now, the body in two halves; the second is asked for only
  // once the reader has taken the first.
  const bytes = new TextEncoder().encode(files.get(url));
  const half = bytes.length >> 1;
  let pulls = 0;
  return new Response(new ReadableStream({
    async pull(controller) {
      pulls += 1;
      if (pulls === 1) return controller.enqueue(bytes.slice(0, half));
      bodyPending.add(url);
      await bodyGates.get(url);
      bodyPending.delete(url);
      controller.enqueue(bytes.slice(half));
      controller.close();
    },
  }, { highWaterMark: 0 }));
};

const wantIn = (worker, pair) =>
  worker.handleDictMessage({ type: 'DICT_PACK_WANT', ...DictPack.splitPair(pair) }, SELF);
const want = (pair) => wantIn({ handleDictMessage }, pair);

// Resolves once every job `worker` queued before it has run: a delete of a
// pair no test fetches, through the same queue, and then put back.
async function drained(worker) {
  const pair = 'ja-en';
  await worker.handleDictMessage({ type: 'DICT_PACK_DELETE', ...DictPack.splitPair(pair) }, SELF);
  local[DictPack.DECLINED_KEY] = (local[DictPack.DECLINED_KEY] || []).filter((p) => p !== pair);
}

// The recovery's write of `pair` as stopped once more.
const recoveryOf = (pair) => (values) => values[DictPack.STATUS_KEY]?.[pair]?.reason === 'interrupted';

function gate() {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release };
}

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

test('L3: a download holds the worker awake and carries the count of stopped workers', async () => {
  const pair = 'en-zh-CN';
  const row = publish(pair, '2026.10.16');
  local[DictPack.STATUS_KEY] = { [pair]: { state: 'failed', ver: row.ver, reason: 'interrupted', interrupts: 2 } };
  const url = DictPack.DOWNLOAD_ORIGIN + row.url;
  const headers = gate();
  const body = gate();
  gates.set(url, headers.promise);
  bodyGates.set(url, body.promise);
  assert.deepEqual(keepaliveState(), { holders: 0, running: false });
  assert.deepEqual(await want(pair), { state: 'queued' });
  await until(() => fetched.includes(url), 'the download to start');
  assert.deepEqual(keepaliveState(), { holders: 1, running: true }, 'held awake while the response is awaited');
  assert.deepEqual(local[DictPack.STATUS_KEY][pair], { state: 'downloading', ver: row.ver, reason: '', interrupts: 2 });
  headers.release();
  await until(() => bodyPending.has(url), 'the first half of the body to be read');
  assert.deepEqual(keepaliveState(), { holders: 1, running: true }, 'still held while the body arrives');
  body.release();
  await until(() => seededVer(pair) === row.ver, 'the pack to be seeded');
  bodyGates.delete(url);
  assert.deepEqual(keepaliveState(), { holders: 0, running: false }, 'let go after the last byte');
  assert.equal((local[DictPack.STATUS_KEY] || {})[pair], undefined, 'a seeded pack clears the count');
});

test('L3: a version stopped three times in a row is left to the daily check; the next version is fetched', async () => {
  const pair = 'ja-zh-CN';
  const row = publish(pair, '2026.10.16');
  local[DictPack.STATUS_KEY] = { [pair]: { state: 'failed', ver: row.ver, reason: 'interrupted', interrupts: 3 } };
  const before = fetched.length;
  assert.deepEqual(await want(pair), { state: 'failed' });
  assert.equal(fetched.length, before, 'nothing is downloaded');

  const next = publish(pair, '2026.10.17');
  assert.deepEqual(await want(pair), { state: 'queued' });
  await until(() => seededVer(pair) === next.ver, 'the next version to be seeded');
});

test('L4: a lookup that reads the count before the recovery adds the third stop is refused on the queue', async () => {
  const worker = await newWorker();
  const pair = 'ko-en';
  const row = publish(pair, '2026.10.18');
  const seeded = seededVer(pair);
  local[DictPack.STATUS_KEY] = { [pair]: { state: 'downloading', ver: row.ver, reason: '', interrupts: 2 } };
  const recovered = holdWrite(recoveryOf(pair));
  // The lookup wakes the worker and reads `downloading`: the third stop is
  // not counted yet, so it queues, behind the recovery.
  assert.deepEqual(await wantIn(worker, pair), { state: 'queued' });
  recovered();
  await drained(worker);
  assert.deepEqual(local[DictPack.STATUS_KEY][pair], {
    state: 'failed', ver: row.ver, reason: 'interrupted', interrupts: 3,
  }, 'the job gave up without writing downloading');
  assert.ok(!fetched.includes(DictPack.DOWNLOAD_ORIGIN + row.url), 'the pack was never fetched');
  assert.equal(seededVer(pair), seeded, 'the version seeded before is kept');
  assert.deepEqual(await wantIn(worker, pair), { state: 'failed' }, 'the next lookup is refused at once');
});

test('L4: a preinstall does not join a lookup job refused on the queue; it fetches the pack', async () => {
  const worker = await newWorker();
  const pair = 'en-zh-CN';
  const row = publish(pair, '2026.10.18');
  sync.targetLang = 'zh-CN';
  local[DictPack.STATUS_KEY] = { [pair]: { state: 'downloading', ver: row.ver, reason: '', interrupts: 2 } };
  const recovered = holdWrite(recoveryOf(pair));
  assert.deepEqual(await wantIn(worker, pair), { state: 'queued' });
  await worker.onDictInstalled({ reason: 'update' });
  recovered();
  await drained(worker);
  delete sync.targetLang;
  assert.equal(seededVer(pair), row.ver);
  assert.deepEqual(fetched.filter((url) => url.endsWith(row.url)), [DictPack.DOWNLOAD_ORIGIN + row.url]);
  assert.equal((local[DictPack.STATUS_KEY] || {})[pair], undefined, 'a seeded pack clears the count');
});

test('L4: a daily check does not join a lookup job refused on the queue; it fetches the pack', async () => {
  const worker = await newWorker();
  const pair = 'ja-zh-CN';
  const blocker = 'zh-CN-ja';
  const row = publish(pair, '2026.10.18');
  const blockerRow = publish(blocker, '2026.10.18');
  const blockerUrl = DictPack.DOWNLOAD_ORIGIN + blockerRow.url;
  local[DictPack.STATUS_KEY] = { [pair]: { state: 'downloading', ver: row.ver, reason: '', interrupts: 2 } };
  const recovered = holdWrite(recoveryOf(pair));
  // A download ahead of the lookup's job keeps that job queued while the
  // check, which waits for the recovery first, asks for the same version.
  const blocking = gate();
  gates.set(blockerUrl, blocking.promise);
  assert.deepEqual(await wantIn(worker, blocker), { state: 'queued' });
  assert.deepEqual(await wantIn(worker, pair), { state: 'queued' });
  const reads = syncReads;
  const check = worker.checkDictPacks();
  recovered();
  // The check's second settings read (the preinstall pair) is the last await
  // before it queues its jobs.
  await until(() => syncReads >= reads + 2 && fetched.includes(blockerUrl), 'the check to queue its jobs');
  blocking.release();
  await check;
  assert.equal(seededVer(pair), row.ver);
  assert.deepEqual(fetched.filter((url) => url.endsWith(row.url)), [DictPack.DOWNLOAD_ORIGIN + row.url]);
  assert.equal(seededVer(blocker), blockerRow.ver);
});
