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
const {
  evaluateInContentScript,
  getServiceWorker,
  waitForContentReady,
  writeSyncSettings,
} = require('./helpers');
const { DictPackServer, MANIFEST_PATH, fixturePack, packBytes } = require('./dict-pack-server');

const EN_ZH = 'en-zh-CN';
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

async function openExample(context, page) {
  await writeSyncSettings(context, { translationStyle: 'underline', targetLang: 'zh-CN' });
  await page.goto('https://example.com/');
  await waitForContentReady(page, 'underline');
}

function lookup(context, page, text, targetLang, options = {}) {
  return evaluateInContentScript(context, page,
    `window.AI_TRANSLATOR_CONTENT.dictLookup(${JSON.stringify(text)}, ${JSON.stringify(targetLang)}, ${JSON.stringify(options)})`);
}

async function localValue(context, key) {
  const worker = await getServiceWorker(context);
  return worker.evaluate(async (k) => (await chrome.storage.local.get(k))[k], key);
}

async function packItem(context, pair) {
  return ((await localValue(context, 'dict:packs')) || {})[pair];
}

async function statusOf(context, pair) {
  return ((await localValue(context, 'dict:status')) || {})[pair];
}

/** How many keys start with `prefix`, by key name only. */
async function countKeys(context, prefix) {
  const worker = await getServiceWorker(context);
  return worker.evaluate(async (p) => (await chrome.storage.local.getKeys()).filter((k) => k.startsWith(p)).length, prefix);
}

/** Ask for a pack the way a lookup does, and wait until it is listed. */
async function install(context, page, src, tgt, ver) {
  const reply = await evaluateInContentScript(context, page,
    `chrome.runtime.sendMessage({ type: 'DICT_PACK_WANT', src: ${JSON.stringify(src)}, tgt: ${JSON.stringify(tgt)} })`);
  expect(reply).toEqual({ state: 'queued' });
  await expect.poll(async () => (await packItem(context, `${src}-${tgt}`) || {}).ver, { timeout: 15000 }).toBe(ver);
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
    await expect.poll(async () => (await packItem(context, EN_ZH) || {}).ver, { timeout: 15000 }).toBe(row.ver);
    expect(server.hitsOf(row.url)).toBe(1);
    const item = await packItem(context, EN_ZH);
    expect(item).toMatchObject({ src: 'en', tgt: 'zh-CN', ver: row.ver, sha256: row.sha256, heads: 3, bytes: row.bytes });
    expect(await statusOf(context, EN_ZH)).toBeUndefined();

    const options = await openOptions(context, extensionId);
    const pack = options.locator(`#dictPackList .dict-pack[data-pair="${EN_ZH}"]`);
    await expect(pack.locator('.dict-pack-name')).toHaveText('English → Simplified Chinese');
    await expect(pack.locator('.dict-pack-meta')).toHaveText('0 MB · 3 words · version 2026.10.13');
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

    // 食べた, not 食べました: five characters with Han in them is not a lookup
    // (DictEntry.isLookup, 1-4 characters when any Han is in it).
    const response = await lookup(context, page, '食べた', 'zh-CN');
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

    expect(await lookup(context, page, 'たべる', 'zh-CN')).toBeNull();
    expect(await lookup(context, page, 'たべる', 'zh-CN')).toBeNull();
    await expect.poll(async () => (await packItem(context, 'ja-zh-CN') || {}).ver, { timeout: 15000 }).toBe(row.ver);
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
    await fireAlarm(context, 'dict-packs-check');
    await expect.poll(async () => (await packItem(context, EN_ZH) || {}).ver, { timeout: 15000 }).toBe(row.ver);

    const prefix = `d:${EN_ZH}:`;
    expect(await localValue(context, `${prefix}colour`)).toBeUndefined();
    expect(await localValue(context, `${prefix}~colours`)).toBeUndefined();
    expect(await countKeys(context, prefix)).toBe(Object.keys(v2.e).length + Object.keys(v2.f).length);
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
    const keysBefore = await countKeys(context, `d:${EN_ZH}:`);

    const worker = await getServiceWorker(context);
    const failures = [];
    worker.on('console', (message) => {
      if (message.type() === 'error' && message.text().includes('dictionary pack failed')) failures.push(message);
    });

    // The manifest lists v2's real bytes; the host serves a different, valid v2.
    const v2 = enZhV2();
    const tampered = enZhV2();
    tampered.e.apple = [['n.', ['被换掉的释义'], 'píngguǒ', 'wiktionary']];
    const row = server.publish(packBytes(v2), { serve: packBytes(tampered) });
    await fireAlarm(context, 'dict-packs-check');

    await expect.poll(async () => (await statusOf(context, EN_ZH) || {}).state, { timeout: 15000 }).toBe('failed');
    expect(await statusOf(context, EN_ZH)).toMatchObject({ state: 'failed', ver: row.ver });
    expect(server.hitsOf(row.url)).toBe(1);
    expect(failures).toHaveLength(1);
    expect(await failures[0].args()[1].jsonValue()).toEqual({ op: 'check', pair: EN_ZH, ver: row.ver });
    expect(failures[0].text()).not.toContain('苹果');

    expect(await packItem(context, EN_ZH)).toEqual(before);
    expect(await countKeys(context, `d:${EN_ZH}:`)).toBe(keysBefore);
    expect((await lookup(context, page, 'apple', 'zh-CN')).translation).toBe('苹果');

    const options = await openOptions(context, extensionId);
    const pack = options.locator(`#dictPackList .dict-pack[data-pair="${EN_ZH}"]`);
    await expect(pack.locator('.dict-pack-failed')).toHaveText('Download failed. It will be tried again later.');
    await expect(pack.locator('.dict-pack-meta')).toHaveText('0 MB · 3 words · version 2026.10.13');
    await options.close();
  });

  test('J-B1.8 delete on the settings page removes the pack and every key', async ({ context, page, extensionId }) => {
    const server = new DictPackServer();
    server.publishFixture(EN_ZH);
    await server.attach(context);
    await openExample(context, page);
    await install(context, page, 'en', 'zh-CN', '2026.10.13');
    expect(await countKeys(context, `d:${EN_ZH}:`)).toBeGreaterThan(0);

    const options = await openOptions(context, extensionId);
    const pack = options.locator(`#dictPackList .dict-pack[data-pair="${EN_ZH}"]`);
    await pack.locator('.dict-pack-delete').click();
    await expect(pack).toHaveCount(0);
    await expect(options.locator('#dictPackList .dict-pack-empty')).toBeVisible();
    await options.close();

    expect(await countKeys(context, `d:${EN_ZH}:`)).toBe(0);
    expect(await packItem(context, EN_ZH)).toBeUndefined();
    expect(await statusOf(context, EN_ZH)).toBeUndefined();
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
    await fireAlarm(context, 'dict-packs-check');
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
    await worker.evaluate(async () => {
      const prefix = 'd:en-ja:';
      for (let start = 0; start < 50000; start += 5000) {
        const chunk = {};
        for (let i = start; i < start + 5000; i++) chunk[`${prefix}w${i}`] = { e: [['n.', [`w${i}`], null, 'wiktionary']] };
        await chrome.storage.local.set(chunk);
      }
      await chrome.storage.local.set({ 'tc:old': { t: 'x', ts: 1 }, 'tc:live': { t: 'y', ts: Date.now() } });
    });
    expect(await countKeys(context, 'd:en-ja:')).toBe(50000);

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
    expect(await localValue(context, 'tc:live')).toMatchObject({ t: 'y' });
    expect(await countKeys(context, 'd:en-ja:')).toBe(50000);
  });
});
