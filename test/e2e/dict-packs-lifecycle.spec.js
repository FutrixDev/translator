/**
 * Offline dictionary packs, fix round 1 of batch B1 (D-609): what happens to a
 * pack over its life after the first download — a deleted pair stays deleted
 * until the reader asks for it again, the daily check is set once and catches
 * a preinstall that failed, a worker stopped mid-job is cleaned up after, two
 * requests for one pack fetch it once, a swap never shows a half-seeded pack,
 * a pack that is not the one its row names is refused, a pair the manifest
 * drops says so, and the manifest is revalidated only by the daily check.
 *
 * Packs come from test/fixtures/dict-runtime through DictPackServer, as in
 * dict-packs.spec.js; the real host never resolves in a test browser.
 */
const { test, expect } = require('./fixtures');
const { getServiceWorker, recycleWorker, waitForContentReady, writeSyncSettings } = require('./helpers');
const { DictPackServer, MANIFEST_PATH, fixturePack, packBytes } = require('./dict-pack-server');
const {
  DICT_CHECK_ALARM,
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
} = require('./dict-pack-journeys');

const JA_ZH = 'ja-zh-CN';
const CACHE_SWEEP_ALARM = 'translation-cache-sweep';

async function openSecondTab(context) {
  const second = await context.newPage();
  await second.goto('https://example.com/');
  await waitForContentReady(second, 'underline');
  return second;
}

/** Console messages of `type` from the worker whose text includes `needle`. */
function collectConsole(worker, type, needle) {
  const found = [];
  worker.on('console', (message) => {
    if (message.type() === type && message.text().includes(needle)) found.push(message);
  });
  return found;
}

/** Storage as an extension page sees it (works across a worker restart). */
function pageLocal(page, key) {
  return page.evaluate(async (k) => (await chrome.storage.local.get(k))[k], key);
}

function pageCountKeys(page, prefix) {
  return page.evaluate(async (p) => (await chrome.storage.local.getKeys()).filter((k) => k.startsWith(p)).length, prefix);
}

/** A worker stopped mid-job, as the next worker finds it: `downloading`, keys, maybe a list item. */
async function leaveInterrupted(context, pairs) {
  const worker = await getServiceWorker(context);
  await worker.evaluate(async (list) => {
    const status = {};
    const packs = {};
    const keys = {};
    for (const { pair, ver, listed, heads } of list) {
      status[pair] = { state: 'downloading', ver, reason: '' };
      const [src, ...rest] = pair.split('-');
      if (listed) packs[pair] = { src, tgt: rest.join('-'), ver: listed, heads: heads.length, bytes: 1 };
      for (const head of heads) keys[`d:${pair}:${head}`] = { e: [['n.', ['x'], null, 'wiktionary']] };
    }
    await chrome.storage.local.set({ 'dict:status': status, 'dict:packs': packs, ...keys });
  }, pairs);
}

test.describe('offline dictionary packs over their life (B1 fix round 1, D-609)', () => {
  test('J-B1.12 a deleted pair is not fetched again by a lookup or the daily check until "Download again"', async ({ context, page, extensionId }) => {
    const server = new DictPackServer();
    const row = server.publishFixture(EN_ZH);
    await server.attach(context);
    await openExample(context, page);
    await install(context, page, 'en', 'zh-CN', row.ver);

    const options = await openOptions(context, extensionId);
    const pack = packRow(options, EN_ZH);
    await pack.locator('.dict-pack-delete').click();
    await expect(pack.locator('.dict-pack-declined')).toHaveText('Deleted');
    expect(await localValue(context, 'dict:declined')).toEqual([EN_ZH]);

    // A fresh page has sent no request yet: only the declined list stops it.
    const second = await openSecondTab(context);
    const wants = await countWants(context);
    const manifestHits = server.hitsOf(MANIFEST_PATH);
    expect(await lookup(context, second, 'apple', 'zh-CN')).toBeNull();
    await second.waitForTimeout(1000);
    expect(await wants()).toBe(0);
    // Asked directly, the worker refuses it too, before reading the manifest.
    expect(await sendFromPage(context, second, { type: 'DICT_PACK_WANT', src: 'en', tgt: 'zh-CN' })).toEqual({ state: 'declined' });
    expect(server.hitsOf(MANIFEST_PATH)).toBe(manifestHits);

    // The daily check reads the manifest and leaves the pair alone.
    await fireAlarm(context, DICT_CHECK_ALARM);
    await expect.poll(() => server.hitsOf(MANIFEST_PATH), { timeout: 15000 }).toBe(manifestHits + 1);
    await second.waitForTimeout(1000);
    expect(server.hitsOf(row.url)).toBe(1);
    expect(await packItem(context, EN_ZH)).toBeUndefined();

    // An extension update preinstalls the target pair, but not a declined one:
    // it does not even read the manifest.
    const checkedHits = server.hitsOf(MANIFEST_PATH);
    const worker = await getServiceWorker(context);
    await worker.evaluate(() => chrome.runtime.onInstalled.dispatch({ reason: 'update' }));
    await second.waitForTimeout(1000);
    expect(server.hitsOf(MANIFEST_PATH)).toBe(checkedHits);
    expect(server.hitsOf(row.url)).toBe(1);

    await pack.locator('.dict-pack-redownload').click();
    await listedAt(context, EN_ZH, row.ver);
    expect(server.hitsOf(row.url)).toBe(2);
    expect(await localValue(context, 'dict:declined')).toEqual([]);
    await expect(pack.locator('.dict-pack-meta')).toHaveText(`${kbLabel(row.bytes)} · 3 words · version ${row.ver}`);
    await expect(pack.locator('.dict-pack-delete')).toHaveText('Delete');
    expect((await lookup(context, second, 'apple', 'zh-CN')).translation).toBe('苹果');
    await options.close();
    await second.close();
  });

  test('J-B1.13 a preinstall that could not read the manifest is fetched by the daily check', async ({ context, page }) => {
    const server = new DictPackServer();
    const row = server.publishFixture(EN_ZH);
    await server.attach(context);
    await openExample(context, page);
    const worker = await getServiceWorker(context);
    const failures = collectConsole(worker, 'error', 'dictionary preinstall failed');

    server.fail(MANIFEST_PATH);
    await worker.evaluate(() => chrome.runtime.onInstalled.dispatch({ reason: 'install' }));
    await expect.poll(() => failures.length, { timeout: 15000 }).toBe(1);
    expect(await packItem(context, EN_ZH)).toBeUndefined();
    expect(server.hitsOf(row.url)).toBe(0);

    server.restore(MANIFEST_PATH);
    await fireAlarm(context, DICT_CHECK_ALARM);
    await listedAt(context, EN_ZH, row.ver);
    expect(server.hitsOf(row.url)).toBe(1);
    expect(await statusOf(context, EN_ZH)).toBeUndefined();
  });

  test('J-B1.14 starting the worker again leaves both daily alarms where they were', async ({ context }) => {
    const worker = await getServiceWorker(context);
    const names = [DICT_CHECK_ALARM, CACHE_SWEEP_ALARM];
    const scheduled = () => worker.evaluate(async (list) => {
      const out = {};
      for (const name of list) out[name] = ((await chrome.alarms.get(name)) || {}).scheduledTime || null;
      return out;
    }, names);
    await expect.poll(async () => Object.values(await scheduled()).every(Boolean), { timeout: 15000 }).toBe(true);
    const before = await scheduled();

    // Record what the next start asks of chrome.alarms; `gets` fills only once
    // each read has answered, so a create that would follow it has had its turn.
    await worker.evaluate(() => {
      const { alarms } = chrome;
      const get = alarms.get;
      const create = alarms.create;
      self.__alarmGets = [];
      self.__alarmCreates = [];
      alarms.get = function (name, ...rest) {
        const read = get.call(this, name, ...rest);
        read.then(() => self.__alarmGets.push(name));
        return read;
      };
      alarms.create = function (name, ...rest) {
        self.__alarmCreates.push(name);
        return create.call(this, name, ...rest);
      };
      self.__alarmRestore = () => { alarms.get = get; alarms.create = create; };
    });
    try {
      await worker.evaluate(() => new Promise((resolve) => setTimeout(resolve, 50)));
      await worker.evaluate(() => chrome.runtime.onStartup.dispatch());
      await expect.poll(() => worker.evaluate((list) => list.every((n) => self.__alarmGets.includes(n)), names)).toBe(true);
      await worker.evaluate(() => new Promise((resolve) => setTimeout(resolve, 300)));
      expect(await worker.evaluate((list) => self.__alarmCreates.filter((n) => list.includes(n)), names)).toEqual([]);
      expect(await scheduled()).toEqual(before);

      // With no alarm set, the same start sets each one.
      await worker.evaluate((list) => Promise.all(list.map((n) => chrome.alarms.clear(n))), names);
      await worker.evaluate(() => chrome.runtime.onStartup.dispatch());
      await expect.poll(async () => Object.values(await scheduled()).every(Boolean), { timeout: 15000 }).toBe(true);
      expect((await worker.evaluate((list) => self.__alarmCreates.filter((n) => list.includes(n)), names)).sort())
        .toEqual([...names].sort());
    } finally {
      await worker.evaluate(() => self.__alarmRestore());
    }
  });

  test('J-B1.15 a worker stopped mid-seed: the settings page has it cleaned up and names the version', async ({ context, page, extensionId }) => {
    const server = new DictPackServer();
    const row = server.publishFixture(EN_ZH);
    await server.attach(context);
    await openExample(context, page);

    // The job writes every key, then never gets to write its list item.
    const worker = await getServiceWorker(context);
    await worker.evaluate((pair) => {
      const area = chrome.storage.local;
      const set = area.set;
      area.set = function (items, ...rest) {
        if (items && items['dict:packs'] && items['dict:packs'][pair]) {
          self.__dictSeedStopped = true;
          return new Promise(() => {});
        }
        return set.call(this, items, ...rest);
      };
    }, EN_ZH);
    expect(await sendFromPage(context, page, { type: 'DICT_PACK_WANT', src: 'en', tgt: 'zh-CN' })).toEqual({ state: 'queued' });
    await expect.poll(() => worker.evaluate(() => self.__dictSeedStopped === true), { timeout: 15000 }).toBe(true);
    expect(await countKeys(context, `d:${EN_ZH}:`)).toBeGreaterThan(0);
    expect(await statusOf(context, EN_ZH)).toMatchObject({ state: 'downloading', ver: row.ver });

    await recycleWorker(context, page);

    const options = await openOptions(context, extensionId);
    await expect.poll(async () => (await pageLocal(options, 'dict:status') || {})[EN_ZH], { timeout: 15000 })
      .toEqual({ state: 'failed', ver: row.ver, reason: 'interrupted' });
    expect(await pageCountKeys(options, `d:${EN_ZH}:`)).toBe(0);
    expect((await pageLocal(options, 'dict:packs') || {})[EN_ZH]).toBeUndefined();
    const pack = packRow(options, EN_ZH);
    await expect(pack.locator('.dict-pack-failed')).toHaveText(`Version ${row.ver} failed to download. It will be tried again later.`);
    await expect(pack.locator('.dict-pack-delete')).toHaveText('Delete');
    await options.close();
  });

  test('J-B1.16 a lookup request after a stopped worker cleans up first', async ({ context, page }) => {
    const server = new DictPackServer();
    server.publishFixture(JA_ZH); // the manifest answers, but does not list en-zh-CN
    await server.attach(context);
    await openExample(context, page);
    const worker = await getServiceWorker(context);
    const warnings = collectConsole(worker, 'warning', 'dictionary pack interrupted');
    await leaveInterrupted(context, [{ pair: EN_ZH, ver: '2026.10.13', listed: null, heads: ['apple', '~apples'] }]);

    expect(await sendFromPage(context, page, { type: 'DICT_PACK_WANT', src: 'en', tgt: 'zh-CN' })).toEqual({ state: 'absent' });
    await expect.poll(() => statusOf(context, EN_ZH), { timeout: 15000 })
      .toEqual({ state: 'failed', ver: '2026.10.13', reason: 'interrupted' });
    expect(await countKeys(context, `d:${EN_ZH}:`)).toBe(0);
    expect(warnings).toHaveLength(1);
    expect(await warnings[0].args()[1].jsonValue()).toEqual({ pair: EN_ZH, ver: '2026.10.13' });
  });

  test('J-B1.17 the daily check after a stopped worker cleans up first, and keeps a pack still listed', async ({ context, page }) => {
    const server = new DictPackServer();
    const koRow = server.publishFixture('ko-en'); // en-zh-CN is not listed
    await server.attach(context);
    await openExample(context, page);
    await leaveInterrupted(context, [
      // Stopped while seeding a new pair: no list item, orphaned keys.
      { pair: EN_ZH, ver: '2026.10.13', listed: null, heads: ['apple'] },
      // Stopped while downloading an update: the old version is still listed and whole.
      { pair: 'ko-en', ver: '2026.12.01', listed: koRow.ver, heads: ['학교'] },
    ]);

    await fireAlarm(context, DICT_CHECK_ALARM);
    await expect.poll(() => statusOf(context, EN_ZH), { timeout: 15000 })
      .toEqual({ state: 'failed', ver: '2026.10.13', reason: 'interrupted' });
    expect(await countKeys(context, `d:${EN_ZH}:`)).toBe(0);
    await expect.poll(() => statusOf(context, 'ko-en'))
      .toEqual({ state: 'failed', ver: '2026.12.01', reason: 'interrupted' });
    expect(await countKeys(context, 'd:ko-en:')).toBe(1);
    expect((await packItem(context, 'ko-en')).ver).toBe(koRow.ver);
  });

  test('J-B1.18 two tabs asking for one pack fetch it once', async ({ context, page }) => {
    const server = new DictPackServer();
    const row = server.publishFixture(JA_ZH);
    await server.attach(context);
    await openExample(context, page);
    const second = await openSecondTab(context);
    const wants = await countWants(context);

    const held = server.hold(row.url);
    try {
      expect(await lookup(context, page, 'たべる', 'zh-CN')).toBeNull();
      await held.hit;
      expect(await lookup(context, second, 'たべる', 'zh-CN')).toBeNull();
      await expect.poll(() => wants()).toBe(2);
    } finally {
      held.release();
    }
    await listedAt(context, JA_ZH, row.ver);
    // A barrier: a delete queued now runs after every job queued before it.
    expect(await sendFromPage(context, page, { type: 'DICT_PACK_DELETE', src: 'ko', tgt: 'en' })).toEqual({ state: 'deleted' });
    expect(server.hitsOf(row.url)).toBe(1);
    expect((await lookup(context, second, 'たべる', 'zh-CN')).translation).toBe('吃');
    await second.close();
  });

  test('J-B1.19 a request that read the list before another job seeded it does not fetch again', async ({ context, page }) => {
    const server = new DictPackServer();
    const row = server.publishFixture(JA_ZH);
    await server.attach(context);
    await openExample(context, page);
    const worker = await getServiceWorker(context);

    const held = server.hold(row.url);
    let second;
    try {
      expect(await sendFromPage(context, page, { type: 'DICT_PACK_WANT', src: 'ja', tgt: 'zh-CN' })).toEqual({ state: 'queued' });
      await held.hit;
      // The next read of dict:status in the worker waits: that is the second
      // request, past its list read, about to decide to queue.
      await worker.evaluate(() => {
        const area = chrome.storage.local;
        const get = area.get;
        let gate;
        self.__statusGate = new Promise((resolve) => { gate = resolve; });
        self.__statusHeld = false;
        self.__statusRelease = () => gate();
        area.get = function (keys, ...rest) {
          if (keys === 'dict:status' && !self.__statusHeld) {
            self.__statusHeld = true;
            area.get = get;
            return self.__statusGate.then(() => get.call(this, keys, ...rest));
          }
          return get.call(this, keys, ...rest);
        };
      });
      second = sendFromPage(context, page, { type: 'DICT_PACK_WANT', src: 'ja', tgt: 'zh-CN' });
      await expect.poll(() => worker.evaluate(() => self.__statusHeld), { timeout: 15000 }).toBe(true);
    } finally {
      held.release();
    }
    await listedAt(context, JA_ZH, row.ver);
    await expect.poll(() => statusOf(context, JA_ZH)).toBeUndefined();
    await worker.evaluate(() => self.__statusRelease());
    expect(await second).toEqual({ state: 'queued' });
    expect(await sendFromPage(context, page, { type: 'DICT_PACK_DELETE', src: 'ko', tgt: 'en' })).toEqual({ state: 'deleted' });
    expect(server.hitsOf(row.url)).toBe(1);
    expect(await statusOf(context, JA_ZH)).toBeUndefined();
  });

  test('J-B1.20 a swap takes the list item away before it touches any key of the pair', async ({ context, page }) => {
    const server = new DictPackServer();
    server.publishFixture(EN_ZH);
    await server.attach(context);
    await openExample(context, page);
    await install(context, page, 'en', 'zh-CN', '2026.10.13');

    const worker = await getServiceWorker(context);
    await worker.evaluate((pair) => {
      const area = chrome.storage.local;
      const { set, remove } = area;
      const prefix = `d:${pair}:`;
      self.__dictWrites = [];
      area.set = function (items, ...rest) {
        const keys = Object.keys(items);
        self.__dictWrites.push({
          op: 'set',
          touchesPair: keys.some((k) => k.startsWith(prefix)),
          packsHasPair: 'dict:packs' in items ? Boolean(items['dict:packs'][pair]) : null,
        });
        return set.call(this, items, ...rest);
      };
      area.remove = function (keys, ...rest) {
        self.__dictWrites.push({ op: 'remove', touchesPair: [].concat(keys).some((k) => k.startsWith(prefix)), packsHasPair: null });
        return remove.call(this, keys, ...rest);
      };
      self.__dictWritesRestore = () => { area.set = set; area.remove = remove; };
    }, EN_ZH);

    const row = server.publish(packBytes(enZhV2()));
    try {
      await fireAlarm(context, DICT_CHECK_ALARM);
      await listedAt(context, EN_ZH, row.ver);
    } finally {
      await worker.evaluate(() => self.__dictWritesRestore());
    }
    const writes = await worker.evaluate(() => self.__dictWrites);
    let listed = true; // v1 was listed when recording began
    const touchedWhileListed = [];
    for (const write of writes) {
      if (write.touchesPair && listed) touchedWhileListed.push(write);
      if (write.packsHasPair !== null) listed = write.packsHasPair;
    }
    expect(writes.filter((w) => w.touchesPair).length).toBeGreaterThan(1);
    expect(touchedWhileListed).toEqual([]);
    expect(listed).toBe(true);
  });

  test('J-B1.21 a pack whose own version differs from its manifest row is refused', async ({ context, page }) => {
    const server = new DictPackServer();
    server.publishFixture(EN_ZH);
    await server.attach(context);
    await openExample(context, page);
    await install(context, page, 'en', 'zh-CN', '2026.10.13');
    const before = await packItem(context, EN_ZH);

    // The row names 2026.12.01 and carries the real checksum of the 2026.10.13 bytes.
    const row = server.publish(packBytes(fixturePack(EN_ZH)), { row: { ver: '2026.12.01' } });
    await fireAlarm(context, DICT_CHECK_ALARM);
    await expect.poll(async () => (await statusOf(context, EN_ZH) || {}).state, { timeout: 15000 }).toBe('failed');
    const status = await statusOf(context, EN_ZH);
    expect(status.ver).toBe('2026.12.01');
    expect(status.reason).toContain('2026.10.13');
    expect(status.reason).toContain('2026.12.01');
    expect(server.hitsOf(row.url)).toBe(2);
    expect(await packItem(context, EN_ZH)).toEqual(before);
    expect((await lookup(context, page, 'apple', 'zh-CN')).translation).toBe('苹果');
  });

  test('J-B1.22 a pair the manifest drops says "No longer updated" and keeps answering', async ({ context, page, extensionId }) => {
    const server = new DictPackServer();
    const row = server.publishFixture(EN_ZH);
    server.publishFixture(JA_ZH);
    await server.attach(context);
    await openExample(context, page);
    await install(context, page, 'en', 'zh-CN', row.ver);

    server.rows.delete(EN_ZH);
    await fireAlarm(context, DICT_CHECK_ALARM);
    await expect.poll(() => statusOf(context, EN_ZH), { timeout: 15000 }).toEqual({ state: 'unlisted', ver: row.ver, reason: '' });
    const options = await openOptions(context, extensionId);
    const pack = packRow(options, EN_ZH);
    await expect(pack.locator('.dict-pack-unlisted')).toHaveText('No longer updated');
    await expect(pack.locator('.dict-pack-meta')).toHaveText(`${kbLabel(row.bytes)} · 3 words · version ${row.ver}`);
    expect((await lookup(context, page, 'apple', 'zh-CN')).translation).toBe('苹果');

    // Listed again: the mark goes.
    server.publishFixture(EN_ZH);
    await fireAlarm(context, DICT_CHECK_ALARM);
    await expect.poll(() => statusOf(context, EN_ZH), { timeout: 15000 }).toBeUndefined();
    await expect(pack.locator('.dict-pack-unlisted')).toHaveCount(0);
    await options.close();
  });

  test('J-B1.23 only the daily check revalidates the manifest', async ({ context, page }) => {
    const server = new DictPackServer();
    const row = server.publishFixture(JA_ZH);
    await server.attach(context);
    await openExample(context, page);

    const worker = await getServiceWorker(context);
    await worker.evaluate(() => {
      const original = self.fetch;
      self.__dictFetches = [];
      self.fetch = function (input, init) {
        self.__dictFetches.push({ url: String(input), cache: (init && init.cache) || null });
        return original.call(self, input, init);
      };
      self.__dictFetchRestore = () => { self.fetch = original; };
    });
    try {
      await install(context, page, 'ja', 'zh-CN', row.ver);
      await fireAlarm(context, DICT_CHECK_ALARM);
      await expect.poll(() => worker.evaluate(() => self.__dictFetches.filter((f) => f.url.endsWith('/manifest.json')).length),
        { timeout: 15000 }).toBe(2);
    } finally {
      await worker.evaluate(() => self.__dictFetchRestore());
    }
    const fetches = (await worker.evaluate(() => self.__dictFetches)).filter((f) => f.url.includes('dl.blab-translation.com'));
    expect(fetches.map((f) => [new URL(f.url).pathname, f.cache])).toEqual([
      [`/${MANIFEST_PATH}`, null], // the lookup's request: the HTTP cache may answer
      [`/${row.url}`, null], // pack files never change
      [`/${MANIFEST_PATH}`, 'no-cache'], // the daily check
    ]);
  });

  test('J-B1.24 the settings and data sources pages follow the interface language', async ({ context, page, extensionId }) => {
    const server = new DictPackServer();
    server.publishFixture(EN_ZH);
    await server.attach(context);
    await openExample(context, page);
    await install(context, page, 'en', 'zh-CN', '2026.10.13');
    await writeSyncSettings(context, { uiLanguage: 'zh-CN' });

    const options = await openOptions(context, extensionId);
    await expect(options.locator('html')).toHaveAttribute('lang', 'zh-CN');
    const attribution = await context.newPage();
    await attribution.goto(`chrome-extension://${extensionId}/options/dict-attribution.html`);
    await expect(attribution.locator('html')).toHaveAttribute('lang', 'zh-CN');
    const section = attribution.locator(`section.dict-attribution-pack[data-pair="${EN_ZH}"]`);
    await expect(section.locator('p.dict-attribution-files a').first()).toHaveText('许可：CC-BY-SA-4.0');
    await attribution.close();
    await options.close();
  });
});
