// Blab Translation — offline dictionary packs in the service worker: read the
// manifest, download a pack, check it, seed it into chrome.storage.local, swap
// versions, delete (D-561, D-566).
//
// The storage layout and the checks are shared/dict-pack.js; this module owns
// only when a pack is fetched and the order of the writes. Lookups never come
// here: content/content-dict-lookup.js reads storage directly.
//
// Four ways a pack is fetched, all through one job (installPack):
//   - preinstall: onInstalled (install and update) fetches en -> the target
//     language when the manifest has it; never for an English target;
//   - want: a lookup found its pair missing from `dict:packs` and sent
//     DICT_PACK_WANT;
//   - check: the daily alarm compares each installed (or failed) pack's `ver`
//     with the manifest's, and fetches the preinstall pair when it is missing
//     (a preinstall that failed is retried here, D-609);
//   - redownload: the settings page's "Download again" on a deleted pair.
// With the offlineDictionary switch off none of the first three fetches
// anything; packs already seeded stay until the user deletes them on the
// settings page. A deleted pair is recorded in `dict:declined` and none of the
// first three fetches it again; only a redownload does, and clears it (D-609).
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
//
// A worker stopped mid-job leaves its pair `downloading` and, mid-seed, half
// its keys. The first check, lookup request or settings page in the next
// worker queues one recovery job that marks those pairs failed and removes
// the orphaned keys (D-609).
import '../shared/storage-writer.js';
import '../shared/dict-entry.js';
import '../shared/dict-pack.js';
import { defaultSettings, getEffectiveTargetLang } from './settings.js';
import { ensureDailyAlarm } from './daily-alarm.js';

const { DictPack, StorageWriter } = globalThis;

export const DICT_CHECK_ALARM = 'dict-packs-check';

// A manifest row's `url`, relative to DictPack.DOWNLOAD_ORIGIN. Nothing else is
// fetched: a row pointing anywhere else is a broken manifest, not a redirect.
const PACK_PATH = /^dict\/v1\/[A-Za-z0-9._/-]+\.json$/;

export function ensureDictAlarm() {
  return ensureDailyAlarm(DICT_CHECK_ALARM);
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

/**
 * The manifest's rows by pair. A malformed manifest throws.
 *
 * The manifest is served with max-age=3600. A lookup's request or an install
 * takes the HTTP cache: a pack nobody has yet can be an hour behind. The daily
 * check passes `fresh` and revalidates (no-cache), so a new version is not a
 * day and an hour late (D-609 N5). Pack files are immutable.
 */
async function readManifest({ fresh = false } = {}) {
  const response = await fetch(DictPack.MANIFEST_URL, fresh ? { cache: 'no-cache' } : undefined);
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

// Both maps and the declined list are written only by jobs on the queue below,
// so a read-modify-write here never races another.
async function writeMapItem(key, pair, value) {
  const map = await readMap(key);
  if (value === undefined) delete map[pair];
  else map[pair] = value;
  await chrome.storage.local.set({ [key]: map });
}

/** The pairs the reader deleted, as a sorted list of pairOf() names. */
async function readDeclined() {
  return (await chrome.storage.local.get(DictPack.DECLINED_KEY))[DictPack.DECLINED_KEY] || [];
}

async function setDeclined(pair, declined) {
  const list = (await readDeclined()).filter((p) => p !== pair);
  if (declined) list.push(pair);
  await chrome.storage.local.set({ [DictPack.DECLINED_KEY]: list.sort() });
}

/** Remove every `d:<pair>:` key: entries, form pointers, and any half-seeded leftovers. */
async function removePairKeys(pair) {
  const { src, tgt } = DictPack.splitPair(pair);
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
  await removePairKeys(pair);
  for (const chunk of DictPack.seedChunks(pack)) {
    await chrome.storage.local.set(chunk);
  }
  await writeMapItem(DictPack.PACKS_KEY, pair, DictPack.listItem(pack, row));
}

async function runInstall({ op, row }) {
  const pair = DictPack.pairOf(row.src, row.tgt);
  // A pair deleted after this job was asked for stays deleted; the reader's
  // own "Download again" is the one job that takes it off the list.
  if (op === 'redownload') await setDeclined(pair, false);
  else if ((await readDeclined()).includes(pair)) return { state: 'declined' };
  // The caller read the list before it queued this job; another job may have
  // seeded this version since (D-609 N4).
  const listed = (await readMap(DictPack.PACKS_KEY))[pair];
  if (listed && listed.ver === row.ver) return { state: 'installed' };
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

// Declined first: a worker stopped part way through still never fetches the
// pair again on its own (D-609).
async function deletePair({ src, tgt }) {
  const pair = DictPack.pairOf(src, tgt);
  await setDeclined(pair, true);
  await writeMapItem(DictPack.PACKS_KEY, pair, undefined);
  await writeMapItem(DictPack.STATUS_KEY, pair, undefined);
  await removePairKeys(pair);
  return { state: 'deleted' };
}

// Only a job on this queue writes `downloading`, and this runs on the queue,
// so every `downloading` it finds is from a worker that stopped mid-job. The
// pair is marked failed (the check retries it); a pair with no list item was
// being seeded from scratch or replaced, and its keys are orphans (D-609 N6).
async function recoverPairs() {
  const status = await readMap(DictPack.STATUS_KEY);
  const packs = await readMap(DictPack.PACKS_KEY);
  for (const [pair, { state, ver }] of Object.entries(status)) {
    if (state !== 'downloading') continue;
    console.warn('[Blab Translation] dictionary pack interrupted', { pair, ver });
    if (!packs[pair]) await removePairKeys(pair);
    await writeMapItem(DictPack.STATUS_KEY, pair, { state: 'failed', ver, reason: 'interrupted' });
  }
  return { state: 'recovered' };
}

// An installed pair the manifest no longer lists keeps working but gets no new
// version; `dict:status` says so for the settings page (D-609), and the mark
// goes when the manifest lists the pair again.
async function markUnlisted({ listed }) {
  const packs = await readMap(DictPack.PACKS_KEY);
  const status = await readMap(DictPack.STATUS_KEY);
  let changed = false;
  for (const pair of Object.keys(packs)) {
    const unlisted = !listed.includes(pair);
    const marked = Boolean(status[pair]) && status[pair].state === 'unlisted';
    if (unlisted === marked) continue;
    if (unlisted) status[pair] = { state: 'unlisted', ver: packs[pair].ver, reason: '' };
    else delete status[pair];
    changed = true;
  }
  if (changed) await chrome.storage.local.set({ [DictPack.STATUS_KEY]: status });
  return { state: 'listed' };
}

// Every job runs on this one queue, in the order queued. Only applyWrite is
// used: nothing outside the worker sends DICT_PACK_WRITE.
const packWriter = StorageWriter.create({
  type: 'DICT_PACK_WRITE',
  writes: { install: runInstall, delete: deletePair, recover: recoverPairs, listing: markUnlisted },
  errors: 'throw',
});

const joinable = new Map(); // pair -> the queued or running install job

/**
 * Queue the install of `row`, or join the install of its pair already
 * queued. A redownload never joins: a job asked for before the reader's
 * click finds the pair declined. Resolves when it is seeded
 * ({state:'installed'}), has failed ({state:'failed'}, already logged and
 * shown), or was declined.
 */
function queueInstall(op, row) {
  const pair = DictPack.pairOf(row.src, row.tgt);
  if (op !== 'redownload' && joinable.has(pair)) return joinable.get(pair);
  const job = packWriter.applyWrite({ kind: 'install', op, row });
  joinable.set(pair, job);
  const settle = () => {
    if (joinable.get(pair) === job) joinable.delete(pair);
  };
  job.then(settle, settle);
  return job;
}

// A job nobody awaits still has its storage writes to fail; that is the only
// thing that reaches here.
function detach(op, pair, job) {
  job.catch((error) => console.error('[Blab Translation] dictionary pack job failed', { op, pair }, error));
}

// One recovery per worker: a stopped worker's jobs are the only source of a
// stale `downloading`, and the queue is empty of them by the time this runs.
let recovery = null;

function recoverOnce() {
  if (!recovery) {
    recovery = packWriter.applyWrite({ kind: 'recover' });
    recovery.catch(() => { recovery = null; });
  }
  return recovery;
}

// en -> the effective target language (D-566); '' for an English target or a
// language with no packs.
async function preinstallPair() {
  const tgt = getEffectiveTargetLang(await chrome.storage.sync.get(defaultSettings));
  return tgt === 'en' || !DictPack.LANGS.includes(tgt) ? '' : DictPack.pairOf('en', tgt);
}

function needPair(type, message) {
  const { src, tgt } = message || {};
  if (!DictPack.LANGS.includes(src) || !DictPack.LANGS.includes(tgt)) {
    throw new Error(`${type}: unknown pair ${src}-${tgt}`);
  }
  return DictPack.pairOf(src, tgt);
}

// ---- the entry points -------------------------------------------------------

/**
 * onInstalled: set the daily alarm, and on install and update fetch en -> the
 * effective target language when the switch is on, the target is not English,
 * the reader has not deleted that pair, and the manifest has it at a version
 * not already seeded. Does not wait for the job.
 */
export async function onDictInstalled(details) {
  await ensureDictAlarm();
  if (!details || (details.reason !== 'install' && details.reason !== 'update')) return;
  if (!(await switchOn())) return;
  const pair = await preinstallPair();
  if (!pair || (await readDeclined()).includes(pair)) return;
  const row = (await readManifest()).get(pair);
  if (!row) return;
  const listed = (await readMap(DictPack.PACKS_KEY))[pair];
  if (listed && listed.ver === row.ver) return;
  detach('preinstall', pair, queueInstall('preinstall', row));
}

/**
 * DICT_PACK_WANT: a lookup found `src`-`tgt` missing from `dict:packs`. Fetch
 * it in the background when the switch is on, the reader has not deleted it,
 * and the manifest has it. A pack that already failed at the manifest's
 * version is left to the daily check, so a broken pack is not downloaded
 * again on every page.
 * @returns {Promise<{state: string}>} what was done: off, declined, absent,
 *   installed, failed, or queued (the job is not awaited)
 */
async function wantDictPack(message) {
  const pair = needPair('DICT_PACK_WANT', message);
  if (!(await switchOn())) return { state: 'off' };
  if ((await readDeclined()).includes(pair)) return { state: 'declined' };
  detach('recover', '', recoverOnce());
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
 * The daily alarm: every installed or failed pair, and the preinstall pair
 * when it is missing, is fetched when the manifest's version differs from the
 * seeded one; declined pairs are skipped. Installed pairs the manifest no
 * longer lists are marked unlisted. Resolves when every job it queued has
 * finished.
 */
export async function checkDictPacks() {
  if (!(await switchOn())) return;
  await recoverOnce();
  const manifest = await readManifest({ fresh: true });
  const packs = await readMap(DictPack.PACKS_KEY);
  const status = await readMap(DictPack.STATUS_KEY);
  const declined = await readDeclined();
  const pairs = new Set([...Object.keys(packs), ...Object.keys(status), await preinstallPair()].filter(Boolean));
  const jobs = [];
  for (const pair of pairs) {
    const row = manifest.get(pair);
    if (!row || declined.includes(pair)) continue;
    const listed = packs[pair];
    if (listed && listed.ver === row.ver) continue;
    jobs.push(queueInstall('check', row));
  }
  jobs.push(packWriter.applyWrite({ kind: 'listing', listed: [...manifest.keys()] }));
  await Promise.all(jobs);
}

/**
 * DICT_PACK_DELETE (settings page): after any job already queued, record the
 * pair as declined and remove its list item, its status and every
 * `d:<pair>:` key.
 */
async function deleteDictPack(message) {
  const { src, tgt } = DictPack.splitPair(needPair('DICT_PACK_DELETE', message));
  return packWriter.applyWrite({ kind: 'delete', src, tgt });
}

/**
 * DICT_PACK_INSTALL (settings page, "Download again" on a deleted pair): the
 * reader's own request, so neither the switch nor the declined list stops it.
 * @returns {Promise<{state: string}>} absent, or queued (not awaited)
 */
async function redownloadDictPack(message) {
  const pair = needPair('DICT_PACK_INSTALL', message);
  const row = (await readManifest()).get(pair);
  if (!row) return { state: 'absent' };
  detach('redownload', pair, queueInstall('redownload', row));
  return { state: 'queued' };
}

/** DICT_PACK_RECOVER (settings page, on load): the once-per-worker recovery. */
function recoverDictPacks() {
  return recoverOnce();
}

const MESSAGES = {
  DICT_PACK_WANT: wantDictPack,
  DICT_PACK_DELETE: deleteDictPack,
  DICT_PACK_INSTALL: redownloadDictPack,
  DICT_PACK_RECOVER: recoverDictPacks,
};

/**
 * One of the MESSAGES types (background.js routes exactly these), from this
 * extension's own pages and content scripts only (D-609 N13). Rejects for any
 * other sender.
 */
export async function handleDictMessage(message, sender) {
  if (!sender || sender.id !== chrome.runtime.id) throw new Error(`${message.type}: not from this extension`);
  return MESSAGES[message.type](message);
}
