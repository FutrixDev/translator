// 首装引导页（onboarding/）和它与设置页共用的两块：语言包状态
// （shared/language-pack.js）、对所有标签页的广播（shared/tab-broadcast.js）。
//
// 引导页只在第一次安装时打开 —— 更新扩展、更新 Chrome 都不该再弹一次，那是
// 每个月白白打断一次用户。
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { workerSource } from './helpers/sources.mjs';

const repoPath = (rel) => fileURLToPath(new URL(`../../${rel}`, import.meta.url));
const repoFile = (rel) => readFileSync(repoPath(rel), 'utf8');

await import('../../shared/api-compat.js');
await import('../../shared/engine-status.js');
await import('../../shared/lang-tags.js');
await import('../../shared/target-lang.js');
await import('../../i18n/messages.js');
await import('../../shared/tab-broadcast.js');
await import('../../shared/language-pack.js');
const { LanguagePack, TabBroadcast, APICompat, getMessage } = globalThis;
const { openOnboardingOnInstall, ONBOARDING_PATH } = await import('../../background/install.js');

// ------------------------------------------------------------ 什么时候打开

function fakeTabsChrome() {
  const created = [];
  return {
    created,
    chrome: {
      runtime: { getURL: (path) => `chrome-extension://test-id/${path}` },
      tabs: { create: async (options) => { created.push(options); return { id: 1 }; } },
    },
  };
}

test('the onboarding page opens on a fresh install and on nothing else', async () => {
  const fake = fakeTabsChrome();
  globalThis.chrome = fake.chrome;
  try {
    await openOnboardingOnInstall({ reason: 'install' });
    assert.deepEqual(fake.created, [{ url: 'chrome-extension://test-id/onboarding/onboarding.html' }]);
    for (const details of [{ reason: 'update', previousVersion: '1.0.0' }, { reason: 'chrome_update' },
      { reason: 'shared_module_update' }, {}, undefined]) {
      assert.equal(openOnboardingOnInstall(details), undefined);
    }
    assert.equal(fake.created.length, 1);
  } finally {
    delete globalThis.chrome;
  }
});

test('the service worker hands onInstalled details to it, and the page it names exists', () => {
  const worker = workerSource();
  assert.match(worker, /onInstalled\.addListener\(\(details\) =>[\s\S]*?openOnboardingOnInstall\(details\)/);
  assert.ok(existsSync(repoPath(ONBOARDING_PATH)), `${ONBOARDING_PATH} is missing`);
});

// ------------------------------------------------------------ 语言包

function fakeEngine(over = {}) {
  return Object.assign({
    isSupported: () => true,
    unsupportedReason: () => '',
    supportsLang: (lang) => ['en', 'ja', 'zh'].includes(lang),
    toApiLang: (lang) => ({ 'zh-CN': 'zh', en: 'en', ja: 'ja', 'zu-ZA': 'zu' }[lang] || lang),
    availability: async () => 'available',
    ensureDownloaded: async () => {},
  }, over);
}

test('what is known without asking the browser is answered without asking it', () => {
  const unsupported = LanguagePack.describe(fakeEngine({ isSupported: () => false, unsupportedReason: () => 'oldBrowser' }),
    { targetLang: 'ja', engineFallback: 'local-only' });
  assert.deepEqual(unsupported, { key: 'builtinReasonOldBrowser', downloadable: false });
  assert.equal(LanguagePack.describe(null, { targetLang: 'ja' }).key, 'builtinUnsupportedEnv');

  const aiOnly = (engineFallback) => LanguagePack.describe(fakeEngine(), { targetLang: 'zu-ZA', engineFallback });
  assert.deepEqual(aiOnly('local-only'), { key: 'builtinTargetUnsupportedLocalOnly', lang: 'zu-ZA', downloadable: false });
  assert.equal(aiOnly('allow-ai').key, 'builtinTargetUnsupportedAllowAi');

  assert.deepEqual(LanguagePack.describe(fakeEngine(), { targetLang: 'en' }), { key: 'builtinReady', downloadable: false });
  assert.equal(LanguagePack.describe(fakeEngine(), { targetLang: 'ja' }), null);
});

test('only a downloadable pair offers the download button', async () => {
  const answer = (status) => LanguagePack.probe(fakeEngine({ availability: async () => status }), 'ja');
  assert.deepEqual(await answer('available'), { key: 'builtinReady', downloadable: false });
  assert.deepEqual(await answer('downloading'), { key: 'builtinDownloading', downloadable: false });
  assert.deepEqual(await answer('downloadable'), { key: 'builtinDownloadable', downloadable: true });
  assert.deepEqual(await answer('unavailable'), { key: 'builtinUnsupportedPair', downloadable: false });
  // 探测的是 en → 目标语言那一对。
  const asked = [];
  await LanguagePack.probe(fakeEngine({ availability: async (...pair) => { asked.push(pair); return 'available'; } }), 'ja');
  assert.deepEqual(asked, [[LanguagePack.PROBE_SOURCE, 'ja']]);
});

test('a status names the language in the reader own language', () => {
  const t = (key) => getMessage(key, 'en');
  const text = LanguagePack.message({ key: 'builtinTargetUnsupportedLocalOnly', lang: 'ja' }, t, 'en');
  assert.ok(!text.includes('{lang}'), text);
  assert.ok(text.includes('Japanese'), text);
  assert.equal(LanguagePack.message({ key: 'builtinReady' }, t, 'en'), t('builtinReady'));
});

test('a finished download tells every tab which pair just landed; a failed one throws', async () => {
  const sent = [];
  globalThis.chrome = {
    tabs: {
      query: async () => [{ id: 1 }, { id: 2 }],
      sendMessage: async (id, message) => { sent.push([id, message]); },
    },
  };
  try {
    const percents = [];
    await LanguagePack.download(fakeEngine({
      ensureDownloaded: async (source, target, onProgress) => { onProgress(0.123); onProgress(1.7); onProgress(undefined); },
    }), 'zh-CN', (p) => percents.push(p));
    assert.deepEqual(percents, [12, 100, 0]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(sent, [
      [1, { type: 'LANGUAGE_PACK_READY', sourceLang: 'en', targetLang: 'zh' }],
      [2, { type: 'LANGUAGE_PACK_READY', sourceLang: 'en', targetLang: 'zh' }],
    ]);

    sent.length = 0;
    await assert.rejects(LanguagePack.download(fakeEngine({
      ensureDownloaded: async () => { throw new Error('user activation required'); },
    }), 'ja', () => {}), /user activation/);
    assert.deepEqual(sent, [], 'a failed download announced itself as ready');
  } finally {
    delete globalThis.chrome;
  }
});

// ------------------------------------------------------------ 广播

test('a tab without a content script does not stop the broadcast to the others', async () => {
  const sent = [];
  globalThis.chrome = {
    tabs: {
      query: async () => [{ id: 1 }, { id: 2 }, { id: 3 }],
      sendMessage: async (id, message) => {
        if (id === 2) throw new Error('Could not establish connection. Receiving end does not exist.');
        sent.push([id, message]);
      },
    },
  };
  try {
    await TabBroadcast.settingsUpdated({ targetLang: 'ja' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(sent, [
      [1, { type: 'SETTINGS_UPDATED', settings: { targetLang: 'ja' } }],
      [3, { type: 'SETTINGS_UPDATED', settings: { targetLang: 'ja' } }],
    ]);
  } finally {
    delete globalThis.chrome;
  }
});

test('a broadcast that cannot list tabs is logged, not thrown at the save that caused it', async () => {
  const warned = [];
  const warn = console.warn;
  console.warn = (...args) => warned.push(args);
  globalThis.chrome = { tabs: { query: async () => { throw new Error('no tabs API'); } } };
  try {
    await TabBroadcast.settingsUpdated({ theme: 'dark' });
    assert.equal(warned.length, 1);
    assert.match(String(warned[0][0]), /SETTINGS_UPDATED/);
  } finally {
    console.warn = warn;
    delete globalThis.chrome;
  }
});

test('the two extension pages broadcast through the shared module, not a copy of it', () => {
  for (const rel of ['options/options.js', 'options/options-builtin.js', 'options/options-transfer.js', 'onboarding/onboarding.js']) {
    const source = repoFile(rel);
    assert.doesNotMatch(source, /type:\s*'(SETTINGS_UPDATED|LANGUAGE_PACK_READY)'/, `${rel} builds a broadcast by hand`);
    assert.doesNotMatch(source, /tabs\.query\(/, `${rel} walks the tabs itself`);
  }
});

// ------------------------------------------------------------ 引导页本身

test('every string on the onboarding page exists in English', () => {
  const html = repoFile('onboarding/onboarding.html');
  const js = repoFile('onboarding/onboarding.js');
  const keys = new Set([
    ...[...html.matchAll(/data-i18n="([^"]+)"/g)].map((m) => m[1]),
    ...[...js.matchAll(/\bt\('([A-Za-z]+)'\)/g)].map((m) => m[1]),
  ]);
  assert.ok(keys.size > 15, `only ${keys.size} keys found — the scan is broken`);
  const catalog = globalThis.I18N_MESSAGES.en;
  for (const key of keys) assert.ok(key in catalog, `onboarding uses ${key}, which en.js does not define`);
});

test('the shortcut list names the manifest commands by keys that exist', () => {
  const js = repoFile('onboarding/onboarding.js');
  const block = js.slice(js.indexOf('const COMMAND_LABELS = {'), js.indexOf('};', js.indexOf('const COMMAND_LABELS = {')));
  const labels = Object.fromEntries([...block.matchAll(/'([^']+)':\s*'([^']+)'/g)].map((m) => [m[1], m[2]]));
  const commands = Object.keys(JSON.parse(repoFile('manifest.json')).commands || {});
  assert.deepEqual(Object.keys(labels).sort(), commands.sort(), 'COMMAND_LABELS drifted from manifest.json commands');
  for (const key of Object.values(labels)) assert.ok(key in globalThis.I18N_MESSAGES.en, `${key} is not a message key`);
});

test('the AI buttons name providers the connection card knows', () => {
  const js = repoFile('onboarding/onboarding.js');
  const block = js.slice(js.indexOf('const AI_BUTTONS = {'), js.indexOf('};', js.indexOf('const AI_BUTTONS = {')));
  const providers = [...block.matchAll(/:\s*'([a-z]+)'/g)].map((m) => m[1]);
  assert.deepEqual(providers, ['ollama', 'lmstudio']);
  for (const key of providers) {
    assert.ok(APICompat.PROVIDERS[key], `${key} is not in APICompat.PROVIDERS`);
    // 本机的两个不需要 Key —— 所以引导页可以替用户把它们配好。
    assert.equal(APICompat.requiresApiKey({ provider: key, apiEndpoint: APICompat.PROVIDERS[key].endpoint }), false);
  }
  // 选了 AI 的去处是设置页的 API 卡片，那个锚点得真的在。
  assert.match(js, /options\/options\.html#apiSettingsCard/);
  assert.match(repoFile('options/options.html'), /id="apiSettingsCard"/);
});

test('the onboarding page writes settings in one place, and broadcasts every write', () => {
  const js = repoFile('onboarding/onboarding.js');
  assert.equal(js.match(/storage\.sync\.set\(/g).length, 1, 'more than one write path on the onboarding page');
  const save = js.slice(js.indexOf('async function save('), js.indexOf('\n  }\n', js.indexOf('async function save(')));
  assert.match(save, /storage\.sync\.set\(patch\)[\s\S]*TabBroadcast\.settingsUpdated\(patch\)/);
  // 语言包下载必须由点击触发，不在打开页面时自动跑。
  const init = js.slice(js.indexOf('async function init('));
  assert.doesNotMatch(init.slice(0, init.indexOf('addEventListener')), /downloadLanguagePack\(/);
});
