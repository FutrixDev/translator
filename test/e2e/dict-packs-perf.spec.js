/**
 * Offline dictionary packs, batch B1: the numeric acceptance lines of task
 * book offline-dict-b1-runtime.md ("验收线").
 *
 *   - seeding 20,000 heads takes at most 1 s;
 *   - a 100,000-key pack installs (download, check, seed) within 60 s, and
 *     lookups on a pack already installed keep answering while it seeds;
 *   - a lookup that hits, from the content script with the service worker
 *     stopped, has a p95 of at most 20 ms over 50 lookups.
 *
 * Each test writes what it measured as JSON into the directory named by
 * DICT_PERF_OUT when that is set (the evidence folder), else into its own
 * Playwright output folder, and prints it as one `DICT_PERF` line.
 */
const fs = require('fs');
const path = require('path');
const { test, expect } = require('./fixtures');
const {
  evaluateInContentScript,
  getServiceWorker,
  recycleWorker,
  waitForContentReady,
  writeSyncSettings,
} = require('./helpers');
const { DictPackServer, packBytes } = require('./dict-pack-server');

const EN_ZH = 'en-zh-CN';

/** A synthetic v1 pack: `heads` heads with two glosses, one example every tenth head, `forms` form pointers. */
function bigPack(src, tgt, heads, forms) {
  const pack = {
    v: 1, src, tgt, ver: '2026.10.13', lic: 'CC-BY-SA-4.0',
    sources: [{ id: 'wiktionary', name: 'Wiktionary (kaikki.org)', license: 'CC BY-SA 4.0', url: 'https://kaikki.org/' }],
    credits: {}, e: {}, x: {}, m: {}, f: {},
  };
  for (let i = 0; i < heads; i++) {
    pack.e[`w${i}`] = [['n.', [`語${i}`, `意味${i}`], `go${i}`, 'wiktionary']];
    if (i % 10 === 0) pack.x[`w${i}`] = [[`An example with w${i}.`, `w${i}の例文。`, null, null]];
  }
  for (let i = 0; i < forms; i++) pack.f[`w${i % heads}s${i}`] = `w${i % heads}`;
  return pack;
}

function record(name, data) {
  const dir = process.env.DICT_PERF_OUT || test.info().outputPath();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.json`), `${JSON.stringify(data, null, 2)}\n`);
  console.log(`DICT_PERF ${name} ${JSON.stringify(data)}`);
}

function percentile(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

function summary(latencies) {
  const sorted = [...latencies].sort((a, b) => a - b);
  const round = (n) => Math.round(n * 100) / 100;
  return {
    count: sorted.length,
    p50: round(percentile(sorted, 50)),
    p95: round(percentile(sorted, 95)),
    max: round(sorted[sorted.length - 1]),
  };
}

async function openExample(context, page) {
  await writeSyncSettings(context, { translationStyle: 'underline', targetLang: 'zh-CN' });
  await page.goto('https://example.com/');
  await waitForContentReady(page, 'underline');
}

async function install(context, page, src, tgt) {
  const reply = await evaluateInContentScript(context, page,
    `chrome.runtime.sendMessage({ type: 'DICT_PACK_WANT', src: ${JSON.stringify(src)}, tgt: ${JSON.stringify(tgt)} })`);
  expect(reply).toEqual({ state: 'queued' });
  const worker = await getServiceWorker(context);
  await expect.poll(() => worker.evaluate(async (pair) => {
    const packs = (await chrome.storage.local.get('dict:packs'))['dict:packs'] || {};
    return Boolean(packs[pair]);
  }, `${src}-${tgt}`), { timeout: 15000 }).toBe(true);
}

test.describe('offline dictionary packs: acceptance numbers (B1)', () => {
  test('seeding 20,000 heads takes at most 1 s', async ({ context }) => {
    const pack = bigPack('en', 'ko', 20000, 0);
    const worker = await getServiceWorker(context);
    const measured = await worker.evaluate(async (packJson) => {
      const pack = JSON.parse(packJson);
      const start = performance.now();
      let writes = 0;
      for (const chunk of DictPack.seedChunks(pack)) {
        await chrome.storage.local.set(chunk);
        writes += 1;
      }
      const ms = performance.now() - start;
      const prefix = DictPack.prefixOf(pack.src, pack.tgt);
      const keys = (await chrome.storage.local.getKeys()).filter((k) => k.startsWith(prefix));
      await chrome.storage.local.remove(keys);
      return { ms, writes, keys: keys.length };
    }, JSON.stringify(pack));

    record('seed-20k', { heads: 20000, ...measured, ms: Math.round(measured.ms) });
    expect(measured.keys).toBe(20000);
    expect(measured.writes).toBe(4);
    expect(measured.ms).toBeLessThanOrEqual(1000);
  });

  test('a 100,000-key pack installs within 60 s while lookups keep answering', async ({ context, page }) => {
    test.setTimeout(180000);
    const server = new DictPackServer();
    server.publishFixture(EN_ZH);
    const big = bigPack('en', 'ja', 70000, 30000);
    const bytes = packBytes(big);
    const row = server.publish(bytes);
    await server.attach(context);
    await openExample(context, page);
    await install(context, page, 'en', 'zh-CN');

    const measured = await evaluateInContentScript(context, page, `(async () => {
      const start = performance.now();
      const reply = await chrome.runtime.sendMessage({ type: 'DICT_PACK_WANT', src: 'en', tgt: 'ja' });
      const latencies = [];
      let misses = 0;
      for (;;) {
        const packs = (await chrome.storage.local.get('dict:packs'))['dict:packs'] || {};
        if (packs['en-ja'] || performance.now() - start > 120000) break;
        const t = performance.now();
        const answer = await window.AI_TRANSLATOR_CONTENT.dictLookup('apple', 'zh-CN');
        latencies.push(performance.now() - t);
        if (!answer || answer.translation !== '苹果') misses += 1;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return { reply, ms: performance.now() - start, latencies, misses };
    })()`);

    const worker = await getServiceWorker(context);
    const keys = await worker.evaluate(async () => (await chrome.storage.local.getKeys()).filter((k) => k.startsWith('d:en-ja:')).length);
    const lookups = summary(measured.latencies);
    record('seed-100k', {
      keys, heads: 70000, forms: 30000, packBytes: row.bytes,
      installMs: Math.round(measured.ms), lookupsDuringSeeding: lookups, misses: measured.misses,
    });

    expect(measured.reply).toEqual({ state: 'queued' });
    expect(keys).toBe(100000);
    expect(measured.ms).toBeLessThanOrEqual(60000);
    expect(measured.misses).toBe(0);
    expect(lookups.count).toBeGreaterThan(0);
  });

  test('a hit, with the service worker stopped, has a p95 of at most 20 ms over 50 lookups', async ({ context, page }) => {
    const server = new DictPackServer();
    server.publishFixture(EN_ZH);
    await server.attach(context);
    await openExample(context, page);
    await install(context, page, 'en', 'zh-CN');
    await recycleWorker(context, page);

    const words = ['apple', 'ran', 'running', 'colours', 'run'];
    const measured = await evaluateInContentScript(context, page, `(async () => {
      const words = ${JSON.stringify(words)};
      const latencies = [];
      const answers = [];
      for (let i = 0; i < 50; i++) {
        const t = performance.now();
        const answer = await window.AI_TRANSLATOR_CONTENT.dictLookup(words[i % words.length], 'zh-CN');
        latencies.push(performance.now() - t);
        answers.push(answer && answer.engine === 'dict' ? answer.translation : null);
      }
      return { latencies, answers };
    })()`);

    const lookups = summary(measured.latencies);
    record('latency', {
      what: 'ctx.dictLookup hit path, content script, after recycleWorker (CDP ServiceWorker.stopAllWorkers)',
      pack: EN_ZH, words, ...lookups, latenciesMs: measured.latencies.map((n) => Math.round(n * 100) / 100),
    });
    expect(measured.answers.every((answer) => typeof answer === 'string' && answer.length > 0)).toBe(true);
    expect(lookups.count).toBe(50);
    expect(lookups.p95).toBeLessThanOrEqual(20);
  });
});
