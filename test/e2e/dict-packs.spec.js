/**
 * Offline dictionary packs, batch B1 (design ext-offline-dictionary §4.2, §4.3,
 * §5.2, §5.5, §6; task book offline-dict-b1-runtime.md): the service worker
 * fetches, checks, seeds, swaps and deletes packs; ctx.dictLookup answers from
 * storage; the settings page lists the packs; the cache sweep reads only its
 * own keys.
 *
 * Every pack comes from test/fixtures/dict-runtime through DictPackServer
 * (context.route on https://dl.blab-translation.com/); the real host never
 * resolves in a test browser (fixtures.js). Nothing calls ctx.dictLookup but
 * these tests: the card and the input box are wired in batch B2.
 */
const { test, expect } = require('./fixtures');
const { evaluateInContentScript, getServiceWorker, writeSyncSettings } = require('./helpers');
const { DictPackServer, MANIFEST_PATH, packBytes } = require('./dict-pack-server');
const {
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
  statusOf,
} = require('./dict-pack-journeys');

const EN_ZH_KEYS = DictPack.prefixOf('en', 'zh-CN');
const EN_JA_KEYS = DictPack.prefixOf('en', 'ja');

test.describe('offline dictionary packs (B1)', () => {
  test('J-B1.1 install fetches en -> target and the settings page lists it', async ({ context, page, extensionId }) => {
    const server = new DictPackServer();
    const row = server.publishFixture(EN_ZH);
    await server.attach(context);
    await openExample(context, page);

    const worker = await getServiceWorker(context);
    // onInstalled as Chrome fires it on a fresh install; the fixture's own
    // install ran before the target language and the route were in place.
    await worker.evaluate(() => chrome.runtime.onInstalled.dispatch({ reason: 'install' }));
    await listedAt(context, EN_ZH, row.ver);
    expect(server.hitsOf(row.url)).toBe(1);
    const item = await packItem(context, EN_ZH);
    expect(item).toMatchObject({ src: 'en', tgt: 'zh-CN', ver: row.ver, sha256: row.sha256, heads: 3, bytes: row.bytes });
    expect(await statusOf(context, EN_ZH)).toBeUndefined();

    const options = await openOptions(context, extensionId);
    const pack = packRow(options, EN_ZH);
    await expect(pack.locator('.dict-pack-name')).toHaveText('English → Simplified Chinese');
    // Under 1 MB the size is in KB, rounded up (D-609 L2 N5).
    expect(row.bytes).toBeLessThan(1024 * 1024);
    await expect(pack.locator('.dict-pack-meta')).toHaveText(`${kbLabel(row.bytes)} · 3 words · version 2026.10.13`);
    await expect(pack.locator('.dict-pack-delete')).toHaveText('Delete');
    await options.close();
  });

  test('J-B1.2 an English form finds its head, with the pinyin of the translation', async ({ context, page }) => {
    const server = new DictPackServer();
    server.publishFixture(EN_ZH);
    await server.attach(context);
    await openExample(context, page);
    await install(context, page, 'en', 'zh-CN', '2026.10.13');

    const response = await lookup(context, page, 'ran', 'zh-CN');
    expect(response).toMatchObject({ translation: '跑', engine: 'dict' });
    expect(response.entry.phonetics).toEqual([{ label: '', ipa: 'pǎo' }]);
    expect(response.entry.senses).toEqual([
      { pos: 'v.', defs: ['跑', '奔跑', '经营'] },
      { pos: 'n.', defs: ['跑步', '一段路程'] },
    ]);
    expect(response.entry.forms).toEqual([
      { label: '过去式', value: 'ran' }, { label: '过去分词', value: 'run' }, { label: '现在分词', value: 'running' },
    ]);
    // An example with Tatoeba ids credits Tatoeba.
    expect(response.credits).toEqual([{ label: 'Tatoeba', href: 'https://tatoeba.org/' }]);

    // The answer passes the one gate every entry goes through before it is drawn.
    const entry = await evaluateInContentScript(context, page,
      `DictEntry.entryFor('word', ${JSON.stringify(response)})`);
    expect(entry.translation).toBe('跑');
    expect(entry.credits).toEqual([{ label: 'Tatoeba', href: 'https://tatoeba.org/' }]);

    // A word with no Tatoeba example credits nothing; a word not in the pack is null.
    expect((await lookup(context, page, 'Apple', 'zh-CN')).credits).toEqual([]);
    expect(await lookup(context, page, 'banana', 'zh-CN')).toBeNull();
  });

  test('J-B1.3 a Korean word with a particle, into English: UK and US', async ({ context, page }) => {
    const server = new DictPackServer();
    server.publishFixture('ko-en');
    await server.attach(context);
    await openExample(context, page);
    await install(context, page, 'ko', 'en', '2026.10.13');

    const response = await lookup(context, page, '학교에서', 'en');
    expect(response).toMatchObject({ translation: 'school', engine: 'dict', credits: [] });
    expect(response.entry.phonetics).toEqual([{ label: 'UK', ipa: '/skuːl/' }, { label: 'US', ipa: '/skul/' }]);
  });

  test('J-B1.4 a Japanese inflection finds its head and credits JMdict', async ({ context, page }) => {
    const server = new DictPackServer();
    server.publishFixture('ja-zh-CN');
    await server.attach(context);
    await openExample(context, page);
    await install(context, page, 'ja', 'zh-CN', '2026.10.13');

    // 食べました is five characters with Han in them: not a lookup for the
    // engines (DictEntry.isLookup), but a dictionary candidate
    // (DictEntry.isDictCandidate: Han and kana, up to eight, D-609).
    expect(await evaluateInContentScript(context, page, "DictEntry.isLookup('食べました')")).toBe(false);
    const response = await lookup(context, page, '食べました', 'zh-CN');
    expect(response).toMatchObject({ translation: '吃', engine: 'dict' });
    expect(response.credits).toEqual([{ label: 'JMdict © EDRDG', href: 'https://www.edrdg.org/edrdg/licence.html' }]);
    expect(response.entry.phonetics).toEqual([{ label: '', ipa: 'chī' }]);
  });

  test('J-B1.5 a pair not installed answers null and is fetched once', async ({ context, page }) => {
    const server = new DictPackServer();
    const row = server.publishFixture('ja-zh-CN');
    await server.attach(context);
    await openExample(context, page);
    const wants = await countWants(context);

    // The pack is held until both lookups have answered: without the hold a
    // fast install could land between them and the second would hit (D-609).
    const held = server.hold(row.url);
    try {
      expect(await lookup(context, page, 'たべる', 'zh-CN')).toBeNull();
      await held.hit;
      expect(await lookup(context, page, 'たべる', 'zh-CN')).toBeNull();
    } finally {
      held.release();
    }
    await listedAt(context, 'ja-zh-CN', row.ver);
    expect(await wants()).toBe(1);
    expect(server.hitsOf(row.url)).toBe(1);

    expect(await lookup(context, page, 'たべる', 'zh-CN')).toMatchObject({ translation: '吃', engine: 'dict' });
    expect(await wants()).toBe(1);
  });

  test('J-B1.6 the daily check swaps in a new version and leaves no old key', async ({ context, page }) => {
    const server = new DictPackServer();
    server.publishFixture(EN_ZH);
    await server.attach(context);
    await openExample(context, page);
    await install(context, page, 'en', 'zh-CN', '2026.10.13');
    expect((await lookup(context, page, 'colours', 'zh-CN')).translation).toBe('颜色');

    const v2 = enZhV2();
    const row = server.publish(packBytes(v2));
    await fireAlarm(context, DICT_CHECK_ALARM);
    await listedAt(context, EN_ZH, row.ver);

    const worker = await getServiceWorker(context);
    expect(await localValue(worker, DictPack.entryKey('en', 'zh-CN', 'colour'))).toBeUndefined();
    expect(await localValue(worker, DictPack.formKey('en', 'zh-CN', 'colours'))).toBeUndefined();
    expect(await countKeys(worker, EN_ZH_KEYS)).toBe(Object.keys(v2.e).length + Object.keys(v2.f).length);
    expect((await packItem(context, EN_ZH)).heads).toBe(2);
    expect(await lookup(context, page, 'colour', 'zh-CN')).toBeNull();
    expect((await lookup(context, page, 'apples', 'zh-CN')).translation).toBe('苹果果实');
  });

  test('J-B1.7 a pack whose bytes do not match the manifest is refused and the old one kept', async ({ context, page, extensionId }) => {
    const server = new DictPackServer();
    server.publishFixture(EN_ZH);
    await server.attach(context);
    await openExample(context, page);
    await install(context, page, 'en', 'zh-CN', '2026.10.13');
    const before = await packItem(context, EN_ZH);
    const worker = await getServiceWorker(context);
    const keysBefore = await countKeys(worker, EN_ZH_KEYS);

    const failures = [];
    worker.on('console', (message) => {
      if (message.type() === 'error' && message.text().includes('dictionary pack failed')) failures.push(message);
    });

    // The manifest lists v2's real bytes; the host serves a different, valid v2.
    const v2 = enZhV2();
    const tampered = enZhV2();
    tampered.e.apple = [['n.', ['被换掉的释义'], 'píngguǒ', 'wiktionary']];
    const row = server.publish(packBytes(v2), { serve: packBytes(tampered) });
    await fireAlarm(context, DICT_CHECK_ALARM);

    await expect.poll(async () => (await statusOf(context, EN_ZH) || {}).state, { timeout: 15000 }).toBe('failed');
    expect(await statusOf(context, EN_ZH)).toMatchObject({ state: 'failed', ver: row.ver });
    expect(server.hitsOf(row.url)).toBe(1);
    expect(failures).toHaveLength(1);
    expect(await failures[0].args()[1].jsonValue()).toEqual({ op: 'check', pair: EN_ZH, ver: row.ver });
    expect(failures[0].text()).not.toContain('苹果');

    expect(await packItem(context, EN_ZH)).toEqual(before);
    expect(await countKeys(await getServiceWorker(context), EN_ZH_KEYS)).toBe(keysBefore);
    expect((await lookup(context, page, 'apple', 'zh-CN')).translation).toBe('苹果');

    const options = await openOptions(context, extensionId);
    const pack = packRow(options, EN_ZH);
    // The failed row names the version that failed, not the one still in use (D-609 L2 N6).
    await expect(pack.locator('.dict-pack-failed')).toHaveText('Version 2026.11.01 failed to download. It will be tried again later.');
    await expect(pack.locator('.dict-pack-meta')).toHaveText(`${kbLabel(before.bytes)} · 3 words · version 2026.10.13`);
    await options.close();
  });

  test('J-B1.8 delete on the settings page removes the pack and every key, and leaves the pair declined', async ({ context, page, extensionId }) => {
    const server = new DictPackServer();
    server.publishFixture(EN_ZH);
    await server.attach(context);
    await openExample(context, page);
    await install(context, page, 'en', 'zh-CN', '2026.10.13');
    expect(await countKeys(await getServiceWorker(context), EN_ZH_KEYS)).toBeGreaterThan(0);

    const options = await openOptions(context, extensionId);
    const pack = packRow(options, EN_ZH);
    await pack.locator('.dict-pack-delete').click();
    // The row stays, saying it was deleted, with the one way back (D-609).
    await expect(pack.locator('.dict-pack-declined')).toHaveText('Deleted');
    await expect(pack.locator('.dict-pack-redownload')).toHaveText('Download again');
    await expect(pack.locator('.dict-pack-meta')).toHaveCount(0);
    await expect(pack.locator('.dict-pack-delete')).toHaveCount(0);
    await options.close();

    const worker = await getServiceWorker(context);
    expect(await countKeys(worker, EN_ZH_KEYS)).toBe(0);
    expect(await packItem(context, EN_ZH)).toBeUndefined();
    expect(await statusOf(context, EN_ZH)).toBeUndefined();
    expect(await localValue(worker, DictPack.DECLINED_KEY)).toEqual([EN_ZH]);
  });

  test('J-B1.9 with the switch off nothing is looked up or fetched', async ({ context, page }) => {
    const server = new DictPackServer();
    server.publishFixture(EN_ZH);
    server.publishFixture('ja-zh-CN');
    await server.attach(context);
    await openExample(context, page);
    await install(context, page, 'en', 'zh-CN', '2026.10.13');
    expect((await lookup(context, page, 'apple', 'zh-CN')).translation).toBe('苹果');

    const wants = await countWants(context);
    await writeSyncSettings(context, { offlineDictionary: false });
    await expect.poll(() => lookup(context, page, 'apple', 'zh-CN')).toBeNull();

    const manifestHits = server.hitsOf(MANIFEST_PATH);
    expect(await lookup(context, page, 'たべる', 'zh-CN')).toBeNull();
    // The daily check does nothing either.
    await fireAlarm(context, DICT_CHECK_ALARM);
    await page.waitForTimeout(2000);
    expect(await wants()).toBe(0);
    expect(server.hitsOf(MANIFEST_PATH)).toBe(manifestHits);
    expect(await packItem(context, 'ja-zh-CN')).toBeUndefined();
    // Packs already seeded stay until deleted.
    expect((await packItem(context, EN_ZH)).ver).toBe('2026.10.13');
  });

  test('J-B1.10 the settings footer links to the data sources of every pack', async ({ context, page, extensionId }) => {
    const server = new DictPackServer();
    server.publishFixture(EN_ZH);
    await server.attach(context);
    await openExample(context, page);
    await install(context, page, 'en', 'zh-CN', '2026.10.13');

    const options = await openOptions(context, extensionId);
    const link = options.locator('a.footer-link[href="dict-attribution.html"]');
    await expect(link).toHaveText('Dictionary data sources');
    const [attribution] = await Promise.all([context.waitForEvent('page'), link.click()]);
    await attribution.waitForLoadState();
    expect(attribution.url()).toBe(`chrome-extension://${extensionId}/options/dict-attribution.html`);

    const section = attribution.locator(`section.dict-attribution-pack[data-pair="${EN_ZH}"]`);
    await expect(section.locator('h2')).toHaveText('English → Simplified Chinese · 2026.10.13');
    await expect(section.locator('li.dict-attribution-source')).toHaveText([
      'Wiktionary (kaikki.org) · CC BY-SA 4.0',
      'Tatoeba · CC BY 2.0 FR',
    ]);
    await expect(section.locator('li.dict-attribution-source a').first()).toHaveAttribute('href', 'https://kaikki.org/');
    const files = section.locator('p.dict-attribution-files a');
    await expect(files.first()).toHaveText('Licence: CC-BY-SA-4.0');
    await expect(files.first()).toHaveAttribute('href', 'https://dl.blab-translation.com/dict/v1/en-zh-CN/2026.10.13/LICENSE.txt');
    await expect(files.nth(1)).toHaveAttribute('href', 'https://dl.blab-translation.com/dict/v1/en-zh-CN/2026.10.13/ATTRIBUTION.txt');
    await attribution.close();
    await options.close();
  });

  test('J-B1.11 the translation cache sweep reads only tc: keys beside 50,000 dictionary keys', async ({ context }) => {
    const worker = await getServiceWorker(context);
    await worker.evaluate(async (prefix) => {
      for (let start = 0; start < 50000; start += 5000) {
        const chunk = {};
        for (let i = start; i < start + 5000; i++) chunk[`${prefix}w${i}`] = { e: [['n.', [`w${i}`], null, 'wiktionary']] };
        await chrome.storage.local.set(chunk);
      }
      await chrome.storage.local.set({ 'tc:old': { t: 'x', ts: 1 }, 'tc:live': { t: 'y', ts: Date.now() } });
    }, EN_JA_KEYS);
    expect(await countKeys(worker, EN_JA_KEYS)).toBe(50000);

    const wrapped = await worker.evaluate(() => {
      const area = chrome.storage.local;
      const original = area.get;
      self.__dictSweepGets = [];
      area.get = function (keys, ...rest) {
        const list = keys == null ? null : [].concat(typeof keys === 'object' && !Array.isArray(keys) ? Object.keys(keys) : keys);
        self.__dictSweepGets.push(list);
        return original.call(this, keys, ...rest);
      };
      self.__dictSweepRestore = () => { area.get = original; };
      return area.get !== original;
    });
    expect(wrapped).toBe(true);

    try {
      await fireAlarm(context, 'translation-cache-sweep');
      await expect.poll(() => worker.evaluate(async () => (await chrome.storage.local.getKeys()).includes('tc:old')), { timeout: 15000 }).toBe(false);
      const gets = await worker.evaluate(() => self.__dictSweepGets);
      expect(gets.filter((keys) => keys === null)).toEqual([]);
      const sweepRead = gets.find((keys) => keys.includes('tc:old'));
      expect(sweepRead).toBeTruthy();
      expect(sweepRead.every((key) => key.startsWith('tc:'))).toBe(true);
      expect(sweepRead).toContain('tc:live');
    } finally {
      await worker.evaluate(() => self.__dictSweepRestore());
    }
    expect(await localValue(worker, 'tc:live')).toMatchObject({ t: 'y' });
    expect(await countKeys(worker, EN_JA_KEYS)).toBe(50000);
  });
});
