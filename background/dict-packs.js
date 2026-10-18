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
//     with the manifest's, and fetches the preinstall pair when it is missing;
//     it retries every failed pair, whatever its backoff (below);
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
// job that fails is caught in one place, runInstall(): one console.error with the
// operation, pair and ver, and `dict:status` marks the pair failed for the
// settings page, with the time (`at`). No old version is put back.
//
// A failed fetch (network, HTTP status, sha256, contract) is retried without
// the reader doing or seeing anything (D-719). Each refusal in a row at one
// version counts in `dict:status` (`refusals`, a new version starts at 0), and
// a lookup fetches that version again only once REFUSAL_BACKOFF has passed
// since `at`: 10 min after the first refusal, then 1 h, 4 h, 12 h, and 24 h
// from the fifth on. There is no giving up; the daily check retries anyway.
//
// A worker stopped mid-job leaves its pair `downloading` and, mid-seed, half
// its keys. The first check, lookup request or settings page in the next
// worker queues one recovery job that marks those pairs failed and removes
// the orphaned keys (D-609). Each such stop counts against that version in
// `dict:status` (`interrupts`), apart from the refusals; a lookup fetches an
// interrupted pair again at once, and after MAX_INTERRUPTS in a row no longer
// does, leaving it to the daily check (N2).
//
// A download holds the worker awake (keepalive.js) from the request to the
// last byte: Chrome stops an extension worker that has made no extension API
// call for 30 s, and a fetch in flight is not one. A pack is tens of MB, and
// a slow line or a response that is slow to start would otherwise never
// finish (N2).
import '../shared/storage-writer.js';
import '../shared/dict-entry.js';
import '../shared/dict-pack.js';
import { defaultSettings, getEffectiveTargetLang } from './settings.js';
import { ensureDailyAlarm } from './daily-alarm.js';
import { acquire as holdAwake, release as letSleep } from './keepalive.js';

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
  try {
    DictPack.needPair(row.src, row.tgt);
  } catch (error) {
    throw badRow(i, `.src/.tgt: ${error.message}`);
  }
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

/** The reader deleted `pair`: nothing but a redownload fetches it again. */
async function isDeclined(pair) {
  return (await readDeclined()).includes(pair);
}

// Seeded at the version `row` names: nothing to fetch.
function isCurrent(packs, pair, row) {
  return Boolean(packs[pair]) && packs[pair].ver === row.ver;
}

/**
 * A `dict:status` item, the only way one is built: what the settings page
 * shows for a pair; for a failure, when it happened (`at`); and how many times
 * in a row a worker stopped while fetching `ver` (`interrupts`) and a fetch of
 * `ver` was refused (`refusals`), each only when some did.
 */
function status(state, ver, reason = '', { interrupts = 0, refusals = 0 } = {}) {
  const item = { state, ver, reason };
  if (state === 'failed') item.at = Date.now();
  if (interrupts) item.interrupts = interrupts;
  if (refusals) item.refusals = refusals;
  return item;
}

// The reason a recovery writes: the pair was not refused, its worker stopped.
const INTERRUPTED = 'interrupted';

// Stops in a row at one version after which a lookup no longer fetches it.
const MAX_INTERRUPTS = 3;

// How long after its nth refusal in a row (index n - 1) a lookup waits before
// fetching that version again; the last wait holds from then on (D-719).
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const REFUSAL_BACKOFF = [10 * MINUTE, HOUR, 4 * HOUR, 12 * HOUR, 24 * HOUR];

/** The wait after `refusals` refusals in a row; none before the first. */
function backoff(refusals) {
  if (refusals < 1) return 0;
  return REFUSAL_BACKOFF[Math.min(refusals, REFUSAL_BACKOFF.length) - 1];
}

/** The stops in a row `last` records against `ver`; another version starts at 0. */
function interruptsOf(last, ver) {
  return last && last.ver === ver ? last.interrupts || 0 : 0;
}

/** The refusals in a row `last` records against `ver`; another version starts at 0. */
function refusalsOf(last, ver) {
  return last && last.ver === ver ? last.refusals || 0 : 0;
}

/**
 * Whether a lookup at `now` leaves `row` to the daily check: it was refused at
 * this version less than backoff(refusals) ago (a failure without `at` counts
 * as long past), or a worker stopped mid-job MAX_INTERRUPTS times in a row
 * while fetching it. A pair interrupted fewer times did not fail, and is
 * fetched again.
 */
function leftToCheck(last, row, now) {
  if (!last || last.state !== 'failed' || last.ver !== row.ver) return false;
  if (last.reason !== INTERRUPTED) return now - (last.at || 0) < backoff(refusalsOf(last, row.ver));
  return interruptsOf(last, row.ver) >= MAX_INTERRUPTS;
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

/** The body at `url`, the worker held awake from the request to the last byte. */
async function download(url) {
  holdAwake();
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.arrayBuffer();
  } finally {
    letSleep();
  }
}

/**
 * Download the pack in `row` and check it: HTTP status, the sha256 of the
 * bytes the browser handed over (already brotli-decoded), the v1 contract,
 * and that it is the pack the row names. Throws on the first failure.
 */
async function fetchPack(row) {
  const buffer = await download(DictPack.DOWNLOAD_ORIGIN + row.url);
  const sha256 = hex(await crypto.subtle.digest('SHA-256', buffer));
  if (sha256 !== row.sha256) throw new Error(`sha256 mismatch: manifest ${row.sha256}, downloaded ${sha256}`);
  const pack = DictPack.parsePack(new TextDecoder().decode(buffer));
  if (pack.src !== row.src || pack.tgt !== row.tgt || pack.ver !== row.ver) {
    const packPair = DictPack.pairOf(pack.src, pack.tgt);
    throw new Error(`pack is ${packPair} ${pack.ver}, manifest row is ${DictPack.pairOf(row.src, row.tgt)} ${row.ver}`);
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
  else if (await isDeclined(pair)) return { state: 'declined' };
  // The caller read the list before it queued this job; another job may have
  // seeded this version since (D-609 N4).
  if (isCurrent(await readMap(DictPack.PACKS_KEY), pair, row)) return { state: 'installed' };
  // Read again on the queue: the lookup's own read can come before the
  // recovery that counts the last stop.
  const last = (await readMap(DictPack.STATUS_KEY))[pair];
  if (op === 'want' && leftToCheck(last, row, Date.now())) return { state: 'failed' };
  // The counts so far ride on `downloading`, so the recovery of a stopped
  // worker and this job's own failure both count on from them.
  const started = status('downloading', row.ver, '', {
    interrupts: interruptsOf(last, row.ver),
    refusals: refusalsOf(last, row.ver),
  });
  await writeMapItem(DictPack.STATUS_KEY, pair, started);
  try {
    await installPack(row);
  } catch (error) {
    // The one place a pack's failure stops: logged once, shown on the
    // settings page through dict:status. No user data: the pair and ver only.
    console.error('[Blab Translation] dictionary pack failed', { op, pair, ver: row.ver }, error);
    const refusals = refusalsOf(started, row.ver) + 1;
    await writeMapItem(DictPack.STATUS_KEY, pair, status('failed', row.ver, String(error.message || error), { refusals }));
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
// The stop is counted on top of those before it at the same version, and the
// refusals so far are kept.
async function recoverPairs() {
  const statuses = await readMap(DictPack.STATUS_KEY);
  const packs = await readMap(DictPack.PACKS_KEY);
  for (const [pair, last] of Object.entries(statuses)) {
    const { state, ver } = last;
    if (state !== 'downloading') continue;
    console.warn('[Blab Translation] dictionary pack interrupted', { pair, ver });
    if (!packs[pair]) await removePairKeys(pair);
    const counts = { interrupts: interruptsOf(last, ver) + 1, refusals: refusalsOf(last, ver) };
    await writeMapItem(DictPack.STATUS_KEY, pair, status('failed', ver, INTERRUPTED, counts));
  }
  return { state: 'recovered' };
}

// An installed pair the manifest no longer lists keeps working but gets no new
// version; `dict:status` says so for the settings page (D-609), and the mark
// goes when the manifest lists the pair again.
async function markUnlisted({ listed }) {
  const packs = await readMap(DictPack.PACKS_KEY);
  const statuses = await readMap(DictPack.STATUS_KEY);
  let changed = false;
  for (const pair of Object.keys(packs)) {
    const unlisted = !listed.includes(pair);
    const marked = Boolean(statuses[pair]) && statuses[pair].state === 'unlisted';
    if (unlisted === marked) continue;
    if (unlisted) statuses[pair] = status('unlisted', packs[pair].ver);
    else delete statuses[pair];
    changed = true;
  }
  if (changed) await chrome.storage.local.set({ [DictPack.STATUS_KEY]: statuses });
  return { state: 'listed' };
}

// Every job runs on this one queue, in the order queued. Only applyWrite is
// used: nothing outside the worker sends DICT_PACK_WRITE.
const packWriter = StorageWriter.create({
  type: 'DICT_PACK_WRITE',
  writes: { install: runInstall, delete: deletePair, recover: recoverPairs, listing: markUnlisted },
  errors: 'throw',
});

const joinable = new Map(); // pair -> { op, ver, job }: the queued or running install

/**
 * Queue the install of `row`, or join the install of its pair already queued
 * at the same version. A job for another version is not joined: it carries
 * its own manifest row, and joining it would seed that version instead of
 * `row`'s. A redownload never joins: a job asked for before the reader's
 * click finds the pair declined. Only a lookup joins a lookup's job: that job
 * gives up on a version refused within its backoff or stopped MAX_INTERRUPTS
 * times (runInstall), and a check or preinstall must still fetch it. Resolves when it is seeded
 * ({state:'installed'}), has failed ({state:'failed'}, already logged and
 * shown), or was declined.
 */
function queueInstall(op, row) {
  const pair = DictPack.pairOf(row.src, row.tgt);
  const queued = joinable.get(pair);
  if (op !== 'redownload' && queued && queued.ver === row.ver && (queued.op !== 'want' || op === 'want')) {
    return queued.job;
  }
  const job = packWriter.applyWrite({ kind: 'install', op, row });
  const entry = { op, ver: row.ver, job };
  joinable.set(pair, entry);
  const settle = () => {
    if (joinable.get(pair) === entry) joinable.delete(pair);
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
  return tgt === 'en' || !DictPack.isPackLang(tgt) ? '' : DictPack.needPair('en', tgt);
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
  if (!pair || (await isDeclined(pair))) return;
  const row = (await readManifest()).get(pair);
  if (!row || isCurrent(await readMap(DictPack.PACKS_KEY), pair, row)) return;
  detach('preinstall', pair, queueInstall('preinstall', row));
}

/**
 * DICT_PACK_WANT: a lookup found `src`-`tgt` missing from `dict:packs`. Fetch
 * it in the background when the switch is on, the reader has not deleted it,
 * and the manifest has it. A pack refused at the manifest's version is
 * fetched again only once its backoff since that refusal has passed (10 min
 * after the first, up to 24 h, D-719), so a broken pack is not downloaded
 * again on every page; a pack whose worker was stopped mid-job (reason
 * 'interrupted') did not fail, and is fetched again now, up to
 * MAX_INTERRUPTS stops in a row at that version (N2).
 * @returns {Promise<{state: string}>} what was done: off, declined, absent,
 *   installed, failed, or queued (the job is not awaited)
 */
async function wantDictPack(message) {
  const pair = DictPack.needPair(message.src, message.tgt);
  if (!(await switchOn())) return { state: 'off' };
  if (await isDeclined(pair)) return { state: 'declined' };
  detach('recover', '', recoverOnce());
  const row = (await readManifest()).get(pair);
  if (!row) return { state: 'absent' };
  if (isCurrent(await readMap(DictPack.PACKS_KEY), pair, row)) return { state: 'installed' };
  if (leftToCheck((await readMap(DictPack.STATUS_KEY))[pair], row, Date.now())) return { state: 'failed' };
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
  const statuses = await readMap(DictPack.STATUS_KEY);
  const pairs = new Set([...Object.keys(packs), ...Object.keys(statuses), await preinstallPair()].filter(Boolean));
  const jobs = [];
  for (const pair of pairs) {
    const row = manifest.get(pair);
    // A declined pair is turned away by runInstall, the one place that also
    // catches a delete made while the job waited in the queue.
    if (!row || isCurrent(packs, pair, row)) continue;
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
  DictPack.needPair(message.src, message.tgt);
  return packWriter.applyWrite({ kind: 'delete', src: message.src, tgt: message.tgt });
}

/**
 * DICT_PACK_INSTALL (settings page, "Download again" on a deleted pair): the
 * reader's own request, so neither the switch nor the declined list stops it.
 * @returns {Promise<{state: string}>} absent, or queued (not awaited)
 */
async function redownloadDictPack(message) {
  const pair = DictPack.needPair(message.src, message.tgt);
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
