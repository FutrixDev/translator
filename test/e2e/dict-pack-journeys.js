/**
 * Steps the offline dictionary pack journeys share (dict-packs.spec.js,
 * dict-packs-lifecycle.spec.js): open a page whose content script can look
 * words up, ask for a pack the way a lookup does, read what the service worker
 * stored, fire its alarms, open the settings page.
 */
const { expect } = require('./fixtures');
const { evaluateInContentScript, getServiceWorker, waitForContentReady, writeSyncSettings } = require('./helpers');
const { fixturePack } = require('./dict-pack-server');
require('../../shared/dict-pack.js');

// The storage keys and pair names come from the production module, so a test
// cannot drift from what the service worker writes.
const { DictPack } = globalThis;

const EN_ZH = 'en-zh-CN';
const DICT_CHECK_ALARM = 'dict-packs-check';
const optionsUrl = (extensionId) => `chrome-extension://${extensionId}/options/options.html`;

// en-zh-CN at a new version: colour and its form are gone, apple's gloss changed.
function enZhV2() {
  const pack = fixturePack(EN_ZH);
  pack.ver = '2026.11.01';
  delete pack.e.colour;
  delete pack.f.colours;
  pack.e.apple = [['n.', ['苹果果实'], 'píngguǒ', 'wiktionary']];
  return pack;
}

/** The size the settings page shows for a pack of `bytes` bytes under 1 MB. */
function kbLabel(bytes) {
  return `${Math.ceil(bytes / 1024)} KB`;
}

async function openExample(context, page) {
  await writeSyncSettings(context, { translationStyle: 'underline', targetLang: 'zh-CN' });
  await page.goto('https://example.com/');
  await waitForContentReady(page, 'underline');
}

function lookup(context, page, text, targetLang, options = {}) {
  return evaluateInContentScript(context, page,
    `window.AI_TRANSLATOR_CONTENT.dictLookup(${JSON.stringify(text)}, ${JSON.stringify(targetLang)}, ${JSON.stringify(options)})`);
}

/** Send a dictionary message from the page's content script, as a lookup does. */
function sendFromPage(context, page, message) {
  return evaluateInContentScript(context, page, `chrome.runtime.sendMessage(${JSON.stringify(message)})`);
}

/**
 * One chrome.storage.local value, read through `target`: the service worker or
 * any extension page (a page answers after a worker restart without waking it).
 */
function localValue(target, key) {
  return target.evaluate(async (k) => (await chrome.storage.local.get(k))[k], key);
}

/** How many keys start with `prefix`, by key name only, read through `target`. */
function countKeys(target, prefix) {
  return target.evaluate(async (p) => (await chrome.storage.local.getKeys()).filter((k) => k.startsWith(p)).length, prefix);
}

async function packItem(context, pair) {
  return ((await localValue(await getServiceWorker(context), DictPack.PACKS_KEY)) || {})[pair];
}

async function statusOf(context, pair) {
  return ((await localValue(await getServiceWorker(context), DictPack.STATUS_KEY)) || {})[pair];
}

/** Wait until `pair` is listed at `ver`. */
async function listedAt(context, pair, ver) {
  await expect.poll(async () => (await packItem(context, pair) || {}).ver, { timeout: 15000 }).toBe(ver);
}

/**
 * Ask for a pack the way a lookup does, and wait until it is listed: at `ver`
 * when given, at any version otherwise.
 */
async function install(context, page, src, tgt, ver) {
  expect(await sendFromPage(context, page, { type: 'DICT_PACK_WANT', src, tgt })).toEqual({ state: 'queued' });
  const pair = DictPack.pairOf(src, tgt);
  if (ver) {
    await listedAt(context, pair, ver);
    return;
  }
  await expect.poll(async () => Boolean(await packItem(context, pair)), { timeout: 15000 }).toBe(true);
}

/** Count the DICT_PACK_WANT messages the worker receives from now on. */
async function countWants(context) {
  const worker = await getServiceWorker(context);
  await worker.evaluate(() => {
    self.__dictWants = 0;
    chrome.runtime.onMessage.addListener((message) => {
      if (message && message.type === 'DICT_PACK_WANT') self.__dictWants += 1;
    });
  });
  return () => worker.evaluate(() => self.__dictWants);
}

/** Fire an alarm now, through chrome.alarms itself (unpacked: no minimum delay). */
async function fireAlarm(context, name) {
  const worker = await getServiceWorker(context);
  await worker.evaluate((n) => chrome.alarms.create(n, { when: Date.now() }), name);
}

async function openOptions(context, extensionId) {
  const options = await context.newPage();
  await options.goto(optionsUrl(extensionId));
  return options;
}

/** The settings page's row for `pair`. */
function packRow(options, pair) {
  return options.locator(`#dictPackList .dict-pack[data-pair="${pair}"]`);
}

module.exports = {
  DICT_CHECK_ALARM,
  DictPack,
  EN_ZH,
  countKeys,
  countWants,
  enZhV2,
  fireAlarm,
  install,
  kbLabel,
  listedAt,
  localValue,
  lookup,
  openExample,
  openOptions,
  packItem,
  packRow,
  sendFromPage,
  statusOf,
};
