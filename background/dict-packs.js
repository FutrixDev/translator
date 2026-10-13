// Blab Translation — offline dictionary packs in the service worker: read the
// manifest, download a pack, check it, seed it into chrome.storage.local, swap
// versions, delete (D-561, D-566).
//
// The storage layout and the checks are shared/dict-pack.js; this module owns
// only when a pack is fetched and the order of the writes. Lookups never come
// here: content/content-dict-lookup.js reads storage directly.
//
// Three ways a pack is fetched, all through one job (installPack):
//   - preinstall: onInstalled (install and update) fetches en -> the target
//     language when the manifest has it; never for an English target;
//   - want: a lookup found its pair missing from `dict:packs` and sent
//     DICT_PACK_WANT;
//   - check: the daily alarm compares each installed (or failed) pack's `ver`
//     with the manifest's.
// With the offlineDictionary switch off none of them fetches anything; packs
// already seeded stay until the user deletes them on the settings page.
//
// One job at a time, whatever its pair: a pack is held whole in memory between
// its download and its last write, and two at once would double that. The
// queue is the shared single-writer queue (shared/storage-writer.js), not one
// of our own. A request for a pair whose job is still queued or running joins
// that job.
//
// A job's writes, in order: download and check everything first (a pack that
// fails its check never touches storage), then remove the pair's `dict:packs`
// item (from here on lookups see no pack), remove every old `d:<pair>:` key,
// write the new keys chunk by chunk, and write the `dict:packs` item last. A
// job that fails is caught in one place, runJob(): one console.error with the
// operation, pair and ver, and `dict:status` marks the pair failed for the
// settings page. Nothing is retried there and no old version is put back.
import '../shared/storage-writer.js';
import '../shared/dict-entry.js';
import '../shared/dict-pack.js';
import { defaultSettings, getEffectiveTargetLang } from './settings.js';

const { DictPack, StorageWriter } = globalThis;

export const DICT_CHECK_ALARM = 'dict-packs-check';

// A manifest row's `url`, relative to DictPack.DOWNLOAD_ORIGIN. Nothing else is
// fetched: a row pointing anywhere else is a broken manifest, not a redirect.
const PACK_PATH = /^dict\/v1\/[A-Za-z0-9._/-]+\.json$/;

export function ensureDictAlarm() {
  chrome.alarms.create(DICT_CHECK_ALARM, { periodInMinutes: 24 * 60 });
}

async function switchOn() {
  const { offlineDictionary } = await chrome.storage.sync.get({
    offlineDictionary: defaultSettings.offlineDictionary,
  });
  return offlineDictionary;
}

// ---- the manifest -----------------------------------------------------------

function badRow(i, why) {
  return new Error(`dictionary manifest packs[${i}] ${why}`);
}

function checkRow(row, i) {
  if (!row || typeof row !== 'object') throw badRow(i, 'is not an object');
  if (!DictPack.LANGS.includes(row.src) || !DictPack.LANGS.includes(row.tgt)) throw badRow(i, 'has an unknown pair');
  for (const key of ['ver', 'url', 'sha256']) {
    if (typeof row[key] !== 'string' || !row[key]) throw badRow(i, `.${key} is not a string`);
  }
  if (!PACK_PATH.test(row.url) || row.url.includes('..')) throw badRow(i, '.url is not a pack path');
  if (!/^[0-9a-f]{64}$/.test(row.sha256)) throw badRow(i, '.sha256 is not a sha256');
  for (const key of ['bytes', 'rawBytes', 'heads']) {
    if (!Number.isInteger(row[key]) || row[key] < 0) throw badRow(i, `.${key} is not a count`);
  }
  return row;
}

/** The manifest's rows by pair. A malformed manifest throws. */
async function readManifest() {
  // no-cache: the manifest is served with max-age=3600, and a new version must
  // not wait an hour behind the HTTP cache. Pack files are immutable.
  const response = await fetch(DictPack.MANIFEST_URL, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`dictionary manifest: HTTP ${response.status}`);
  const manifest = await response.json();
  if (!manifest || manifest.v !== 1 || !Array.isArray(manifest.packs)) {
    throw new Error('dictionary manifest is not v1');
  }
  return new Map(manifest.packs.map((row, i) => {
    checkRow(row, i);
    return [DictPack.pairOf(row.src, row.tgt), row];
  }));
}

// ---- storage ----------------------------------------------------------------

async function readMap(key) {
  return (await chrome.storage.local.get(key))[key] || {};
}

// Both maps are written only by jobs on the queue below, so a read-modify-write
// here never races another.
async function writeMapItem(key, pair, value) {
  const map = await readMap(key);
  if (value === undefined) delete map[pair];
  else map[pair] = value;
  await chrome.storage.local.set({ [key]: map });
}

/** Remove every `d:<pair>:` key: entries, form pointers, and any half-seeded leftovers. */
async function removePairKeys(src, tgt) {
  const prefix = DictPack.prefixOf(src, tgt);
  const keys = (await chrome.storage.local.getKeys()).filter((key) => key.startsWith(prefix));
  for (let i = 0; i < keys.length; i += DictPack.CHUNK_KEYS) {
    await chrome.storage.local.remove(keys.slice(i, i + DictPack.CHUNK_KEYS));
  }
}

// ---- the job ----------------------------------------------------------------

function hex(buffer) {
  return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Download the pack in `row` and check it: HTTP status, the sha256 of the
 * bytes the browser handed over (already brotli-decoded), the v1 contract,
 * and that it is the pack the row names. Throws on the first failure.
 */
async function fetchPack(row) {
  const response = await fetch(DictPack.DOWNLOAD_ORIGIN + row.url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const buffer = await response.arrayBuffer();
  const sha256 = hex(await crypto.subtle.digest('SHA-256', buffer));
  if (sha256 !== row.sha256) throw new Error(`sha256 mismatch: manifest ${row.sha256}, downloaded ${sha256}`);
  const pack = DictPack.parsePack(new TextDecoder().decode(buffer));
  if (pack.src !== row.src || pack.tgt !== row.tgt || pack.ver !== row.ver) {
    throw new Error(`pack is ${pack.src}-${pack.tgt} ${pack.ver}, manifest row is ${row.src}-${row.tgt} ${row.ver}`);
  }
  return pack;
}

async function installPack(row) {
  const pair = DictPack.pairOf(row.src, row.tgt);
  const pack = await fetchPack(row);
  // From here the old version is gone for lookups; the new one appears with
  // the list item, after its last key.
  await writeMapItem(DictPack.PACKS_KEY, pair, undefined);
  await removePairKeys(row.src, row.tgt);
  for (const chunk of DictPack.seedChunks(pack)) {
    await chrome.storage.local.set(chunk);
  }
  await writeMapItem(DictPack.PACKS_KEY, pair, DictPack.listItem(pack, row));
}

async function runInstall({ op, row }) {
  const pair = DictPack.pairOf(row.src, row.tgt);
  await writeMapItem(DictPack.STATUS_KEY, pair, { state: 'downloading', ver: row.ver, reason: '' });
  try {
    await installPack(row);
  } catch (error) {
    // The one place a pack's failure stops: logged once, shown on the
    // settings page through dict:status. No user data: the pair and ver only.
    console.error('[Blab Translation] dictionary pack failed', { op, pair, ver: row.ver }, error);
    await writeMapItem(DictPack.STATUS_KEY, pair, { state: 'failed', ver: row.ver, reason: String(error.message || error) });
    return { state: 'failed' };
  }
  await writeMapItem(DictPack.STATUS_KEY, pair, undefined);
  return { state: 'installed' };
}

async function deletePair({ src, tgt }) {
  const pair = DictPack.pairOf(src, tgt);
  await writeMapItem(DictPack.PACKS_KEY, pair, undefined);
  await writeMapItem(DictPack.STATUS_KEY, pair, undefined);
  await removePairKeys(src, tgt);
  return { state: 'deleted' };
}

// Every job, install or delete, runs on this one queue, in the order queued.
// Only applyWrite is used: nothing outside the worker sends DICT_PACK_WRITE.
const packWriter = StorageWriter.create({
  type: 'DICT_PACK_WRITE',
  writes: { install: runInstall, delete: deletePair },
  errors: 'throw',
});

const joinable = new Map(); // pair -> the queued or running install job

/**
 * Queue the install of `row`, or join the install of its pair already
 * queued. Resolves when it is seeded ({state:'installed'}) or has failed
 * ({state:'failed'}, already logged and shown).
 */
function queueInstall(op, row) {
  const pair = DictPack.pairOf(row.src, row.tgt);
  if (joinable.has(pair)) return joinable.get(pair);
  const job = packWriter.applyWrite({ kind: 'install', op, row });
  joinable.set(pair, job);
  job.then(() => joinable.delete(pair), () => joinable.delete(pair));
  return job;
}

// A job nobody awaits (preinstall, want, check) still has its status write to
// fail; that is the only thing that reaches here.
function detach(op, pair, job) {
  job.catch((error) => console.error('[Blab Translation] dictionary pack job failed', { op, pair }, error));
}

// ---- the entry points -------------------------------------------------------

/**
 * onInstalled: set the daily alarm, and on install and update fetch en -> the
 * effective target language when the switch is on, the target is not English
 * and the manifest has that pack at a version not already seeded. Does not
 * wait for the job.
 */
export async function onDictInstalled(details) {
  ensureDictAlarm();
  if (!details || (details.reason !== 'install' && details.reason !== 'update')) return;
  if (!(await switchOn())) return;
  const settings = await chrome.storage.sync.get(defaultSettings);
  const tgt = getEffectiveTargetLang(settings);
  if (tgt === 'en' || !DictPack.LANGS.includes(tgt)) return;
  const pair = DictPack.pairOf('en', tgt);
  const row = (await readManifest()).get(pair);
  if (!row) return;
  const listed = (await readMap(DictPack.PACKS_KEY))[pair];
  if (listed && listed.ver === row.ver) return;
  detach('preinstall', pair, queueInstall('preinstall', row));
}

/**
 * DICT_PACK_WANT: a lookup found `src`-`tgt` missing from `dict:packs`. Fetch
 * it in the background when the switch is on and the manifest has it. A pack
 * that already failed at the manifest's version is left to the daily check,
 * so a broken pack is not downloaded again on every page.
 * @returns {Promise<{state: string}>} what was done: off, absent, installed,
 *   failed, or queued (the job is not awaited)
 */
export async function wantDictPack({ src, tgt }) {
  if (!(await switchOn())) return { state: 'off' };
  const pair = DictPack.pairOf(src, tgt);
  const row = (await readManifest()).get(pair);
  if (!row) return { state: 'absent' };
  const listed = (await readMap(DictPack.PACKS_KEY))[pair];
  if (listed && listed.ver === row.ver) return { state: 'installed' };
  const status = (await readMap(DictPack.STATUS_KEY))[pair];
  if (status && status.state === 'failed' && status.ver === row.ver) return { state: 'failed' };
  detach('want', pair, queueInstall('want', row));
  return { state: 'queued' };
}

/**
 * The daily alarm: every installed or failed pair whose manifest version
 * differs is fetched again. A pair the manifest no longer lists is left as
 * it is. Resolves when every job it queued has finished.
 */
export async function checkDictPacks() {
  if (!(await switchOn())) return;
  const manifest = await readManifest();
  const packs = await readMap(DictPack.PACKS_KEY);
  const status = await readMap(DictPack.STATUS_KEY);
  const jobs = [];
  for (const pair of new Set([...Object.keys(packs), ...Object.keys(status)])) {
    const row = manifest.get(pair);
    if (!row) continue;
    const listed = packs[pair];
    if (listed && listed.ver === row.ver) continue;
    jobs.push(queueInstall('check', row));
  }
  await Promise.all(jobs);
}

/**
 * DICT_PACK_DELETE (settings page): after any job already queued, remove the
 * pair's list item, its status and every `d:<pair>:` key.
 */
export function deleteDictPack({ src, tgt }) {
  if (!DictPack.LANGS.includes(src) || !DictPack.LANGS.includes(tgt)) {
    return Promise.reject(new Error(`DICT_PACK_DELETE: unknown pair ${src}-${tgt}`));
  }
  return packWriter.applyWrite({ kind: 'delete', src, tgt });
}
