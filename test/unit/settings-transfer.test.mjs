// 设置导入 / 导出（shared/settings-transfer.js + options/options-transfer.js）。
//
// 这一套守三件事：
//   1. 一份坏文件一个字节都不写 —— 先全部校验，任何一块不过就整份拒绝；
//   2. 写的时候按表的顺序，第一个失败就停，并且如实说出哪几块已经进去了；
//   3. 凭证默认不出门，设备几何和本机计数永远不出门。
//
// 站点规则那一块走服务工作者的单写者队列（SiteRules.importUserRules），这里把
// 那一跳接回来测整条路。
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoFile = (rel) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');

await import('../../shared/api-compat.js');
await import('../../shared/default-settings.js');
await import('../../shared/ocr.js');
await import('../../shared/lang-tags.js');
await import('../../shared/target-lang.js');
await import('../../shared/translation-display.js');
await import('../../shared/site-rules-builtin.js');
await import('../../shared/site-rules.js');
await import('../../i18n/messages.js');
await import('../../shared/settings-transfer.js');
const { SettingsTransfer: ST, SiteRules, APICompat, TargetLang, TranslationDisplay, DefaultSettings, UI_LANGUAGES } = globalThis;

/**
 * 设置页那张 defaultSettings 读不成模块（经典脚本，顶层就去 getElementById），
 * 把对象字面量抠出来求值 —— 和 default-settings-agree.test.mjs 同一个做法。
 */
function optionsDefaults() {
  const source = repoFile('options/options.js');
  const start = source.indexOf('const defaultSettings = {');
  assert.notEqual(start, -1, 'options.js has no defaultSettings');
  const literal = source.slice(source.indexOf('{', start), source.indexOf('\n};', start) + 2);
  const make = new Function('DEFAULT_SELECTION_HOTKEY', 'OCRCore', `return (${literal});`);
  return make(DefaultSettings.DEFAULT_SELECTION_HOTKEY, globalThis.OCRCore);
}

// 和 options-transfer.js 的 transferSchema() / transferEnums() 同一套入参。
const schema = ST.settingsSchema(DefaultSettings.contentDefaults(), optionsDefaults());
const enums = ST.buildEnums({
  providers: Object.keys(APICompat.PROVIDERS),
  uiLanguages: UI_LANGUAGES,
  targetLangs: TargetLang.SUPPORTED,
  cloudTargets: TargetLang.CLOUD_TARGETS,
  styles: TranslationDisplay.STYLES,
});

// ------------------------------------------------------------ 文件本身

test('a file that is not ours is refused before anything is read out of it', () => {
  const code = (text) => {
    try {
      ST.parseFile(text);
    } catch (error) {
      assert.ok(error instanceof ST.TransferError);
      return error.code;
    }
    return 'accepted';
  };
  assert.equal(code('{not json'), 'notJson');
  assert.equal(code(''), 'notJson');
  assert.equal(code('[]'), 'wrongFormat');
  assert.equal(code('null'), 'wrongFormat');
  assert.equal(code('{"format":"something-else","version":1}'), 'wrongFormat');
  assert.equal(code('{"version":1,"settings":{}}'), 'wrongFormat');
  assert.equal(code('{"format":"blab-settings","version":2}'), 'wrongVersion');
  assert.equal(code('{"format":"blab-settings","version":"1"}'), 'wrongVersion');
  assert.equal(code('{"format":"blab-settings","version":1}'), 'accepted');
});

test('the file name carries the local date, and the file its format and version', () => {
  const now = new Date(2026, 0, 5, 23, 59);
  assert.equal(ST.fileName(now), 'blab-settings-20260105.json');
  const file = ST.buildFile({ settings: { theme: 'dark' }, siteRules: {} }, now);
  assert.equal(file.format, 'blab-settings');
  assert.equal(file.version, 1);
  assert.equal(file.exportedAt, now.toISOString());
  assert.deepEqual(file.settings, { theme: 'dark' });
  // 写出去的东西自己读得回来。
  assert.deepEqual(ST.parseFile(JSON.stringify(file)), JSON.parse(JSON.stringify(file)));
});

// ------------------------------------------------------------ 什么出门

test('device geometry, the local ask counter and the site rules never ride in settings', () => {
  for (const key of Object.keys(ST.EXCLUDED)) {
    assert.ok(!(key in schema), `${key} is excluded but still in the settings schema`);
  }
  // 排除表里的名字都得是真的键 —— 改了名却没改这张表，被排除的就只剩一个空名字。
  const every = Object.assign({}, DefaultSettings.contentDefaults(), optionsDefaults());
  for (const key of Object.keys(ST.EXCLUDED)) {
    assert.ok(key in every || key === 'siteRules' || key === 'siteAskCount', `${key} is in no default table`);
  }
  // 反过来，确实是设置的那些键都在。
  for (const key of ['translationEngine', 'autoTranslateEngine', 'engineFallback', 'targetLang',
    'apiEndpoint', 'modelName', 'provider', 'apiKey', 'theme', 'uiLanguage']) {
    assert.ok(key in schema, `${key} is missing from the settings schema`);
  }
});

test('the API key leaves only when the box is ticked', () => {
  const stored = Object.assign({}, schema, {
    apiKey: 'placeholder-not-a-key',
    theme: 'dark',
    youtubeCaptionPosXPct: 12,
    siteAskCount: { 'example.com': 2 },
    comicToken: 'never-exported',
  });
  const plain = ST.pickExport(stored, schema, { includeApiKey: false });
  assert.ok(!('apiKey' in plain));
  assert.equal(plain.theme, 'dark');
  for (const key of [...Object.keys(ST.EXCLUDED), 'comicToken']) assert.ok(!(key in plain), `${key} was exported`);

  const withKey = ST.pickExport(stored, schema, { includeApiKey: true });
  assert.equal(withKey.apiKey, 'placeholder-not-a-key');
  for (const key of [...Object.keys(ST.EXCLUDED), 'comicToken']) assert.ok(!(key in withKey), `${key} was exported`);
});

// ------------------------------------------------------------ 键级校验

test('a value of the wrong kind is dropped by name, the rest still comes in', () => {
  const result = ST.validateSettings({
    theme: 'dark',                                   // ok
    translationEngine: 'quantum',                    // enum outside
    autoTranslate: 'yes',                            // wrong type
    notARealSetting: true,                           // unknown key
    youtubeCaptionFontColor: 'red',                  // not #rrggbb
    youtubeCaptionBgColor: '#00FF7f',                // ok
    apiEndpoint: 'javascript:alert(1)',              // not http(s)
    autoAiDailyBudget: -1,                           // out of range
    youtubeCaptionBgOpacity: Number.NaN,             // not finite
    autoTranslateLangs: ['en', 'EN-us'],             // item not a base code
    siteAskCount: { 'x.com': 1 },                    // excluded
  }, schema, enums);
  assert.deepEqual(result.value, { theme: 'dark', youtubeCaptionBgColor: '#00FF7f' });
  assert.equal(result.accepted, 2);
  assert.deepEqual(result.dropped.sort(), [
    'apiEndpoint', 'autoAiDailyBudget', 'autoTranslate', 'autoTranslateLangs', 'notARealSetting',
    'siteAskCount', 'translationEngine', 'youtubeCaptionBgOpacity', 'youtubeCaptionFontColor',
  ]);

  const good = ST.validateSettings({
    apiEndpoint: 'http://localhost:11434/v1/chat/completions',
    autoTranslateLangs: ['en', 'ja'],
    autoAiDailyBudget: 0,
    targetLang: '',
    uiLanguage: 'zh-TW',
  }, schema, enums);
  assert.deepEqual(good.dropped, []);
  assert.equal(good.accepted, 5);
});

test('an import value the selection-trigger dropdown does not offer is dropped', () => {
  const result = ST.validateSettings({ selectionTrigger: 'quantum' }, schema, enums);
  assert.deepEqual(result.dropped, ['selectionTrigger']);
  assert.equal(result.accepted, 0);
  for (const value of ['icon', 'modifier', 'both']) {
    const ok = ST.validateSettings({ selectionTrigger: value }, schema, enums);
    assert.deepEqual(ok.value, { selectionTrigger: value });
    assert.deepEqual(ok.dropped, []);
  }
});

test('a settings section that is not an object is refused as a whole', () => {
  for (const raw of [null, [], 'theme=dark', 3]) {
    assert.throws(() => ST.validateSettings(raw, schema, enums),
      (error) => error instanceof ST.TransferError && error.code === 'notObject' && error.detail === 'settings');
  }
});

test('every enum names a real setting, and agrees with the choices on the settings page', () => {
  for (const key of Object.keys(enums)) assert.ok(key in schema, `enum for ${key}, which is not a setting`);
  // 下拉里能选到的每一个值都得导得进来，枚举里的每一个（除「未设」的 ''）也都得
  // 是下拉里真有的。选项由脚本现生成的那几个（语言、样式）按它们的来源比。
  const html = repoFile('options/options.html');
  const staticOptions = (id) => {
    const start = html.indexOf(`<select id="${id}"`);
    if (start === -1) return null;
    const block = html.slice(start, html.indexOf('</select>', start));
    return [...block.matchAll(/<option value="([^"]*)"/g)].map((m) => m[1]).filter((v) => v !== '');
  };
  let compared = 0;
  for (const [key, values] of Object.entries(enums)) {
    const options = staticOptions(key);
    if (!options || options.length === 0) continue;
    compared += 1;
    assert.deepEqual([...options].sort(), values.filter((v) => v !== '').sort(), `${key} drifted from its <select>`);
  }
  assert.ok(compared >= 8, `only ${compared} selects compared — the lookup is broken`);
  // 反方向：设置页上每一个是设置键的 <select> 都得有枚举，否则导入文件里随便写个值
  // （selectionTrigger: 'quantum'）也会被收下，写进去之后下拉一项都对不上。
  // modelSelect 这类不是设置键的下拉不算。下一个新加的下拉漏不过这里。
  const selects = [...html.matchAll(/<select id="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(selects.length >= 10, `only ${selects.length} selects found — the lookup is broken`);
  for (const id of selects) {
    if (!(id in schema)) continue;
    assert.ok(id in enums, `<select id="${id}"> is a setting with no enum: an import would take any value for it`);
  }
  assert.deepEqual(enums.translationStyle, [...TranslationDisplay.STYLES]);
  assert.deepEqual(enums.uiLanguage, ['', ...UI_LANGUAGES]);
  assert.deepEqual(enums.provider, Object.keys(APICompat.PROVIDERS));
  // 每个默认值都得过得了自己的校验，否则一份刚导出的新装配置导不回来。
  const roundTrip = ST.validateSettings(ST.pickExport(schema, schema, { includeApiKey: true }), schema, enums);
  assert.deepEqual(roundTrip.dropped, []);
});

test('site rules are keyed the way decide() looks them up', () => {
  const result = ST.validateSiteRules({
    'www.Example.com': 'always',
    'news.ycombinator.com': 'never',
    'bad.test': 'sometimes',
    '': 'always',
  }, SiteRules.normalizeHost);
  assert.deepEqual(result.value, {
    [SiteRules.normalizeHost('www.Example.com')]: 'always',
    [SiteRules.normalizeHost('news.ycombinator.com')]: 'never',
  });
  assert.deepEqual(result.dropped.sort(), ['', 'bad.test']);
  assert.throws(() => ST.validateSiteRules(['x.com'], SiteRules.normalizeHost), (e) => e.code === 'notObject');
});

// ------------------------------------------------------------ 编排

function section(key, { accept = 1, fails = false, log = [] } = {}) {
  return {
    key,
    validate(raw) {
      if (raw === 'broken') throw new ST.TransferError('notObject', key);
      return { value: raw, accepted: accept, dropped: [] };
    },
    async apply(value) {
      log.push([key, value]);
      if (fails) throw new Error(`${key} write failed`);
    },
  };
}

test('every known section is checked before anything is written; one bad block refuses the file', async () => {
  const log = [];
  const sections = [section('settings', { log }), section('siteRules', { log })];
  await assert.rejects(ST.validateAll({ format: 'blab-settings', version: 1, settings: {}, siteRules: 'broken' }, sections),
    (error) => error.code === 'notObject' && error.detail === 'siteRules');
  assert.deepEqual(log, [], 'a write happened before validation finished');
});

test('sections this build does not know are listed, sections the file lacks are skipped', async () => {
  const sections = [section('settings'), section('siteRules')];
  const validated = await ST.validateAll({
    format: 'blab-settings', version: 1, exportedAt: 'x',
    settings: { theme: 'dark' },
    glossary: 'source,target\nfoo,bar',
    customRules: { rules: [] },
  }, sections);
  assert.deepEqual(validated.sections.map((s) => s.key), ['settings']);
  assert.deepEqual(validated.unknown, ['glossary', 'customRules']);
});

test('a section value is passed through untouched, whatever its shape', async () => {
  // 后面会有值是一段 CSV 的 section；编排层不能假设值是对象。
  const csv = 'source,target\nfoo,bar';
  const validated = await ST.validateAll({ format: 'blab-settings', version: 1, glossary: csv }, [section('glossary')]);
  assert.equal(validated.sections[0].value, csv);
  const log = [];
  await ST.applyAll(validated, [section('glossary', { log })]);
  assert.deepEqual(log, [['glossary', csv]]);
});

test('a file with nothing usable is an error, not a silent success', async () => {
  const sections = [section('settings', { accept: 0 }), section('siteRules', { accept: 0 })];
  await assert.rejects(ST.validateAll({ format: 'blab-settings', version: 1, settings: {}, siteRules: {} }, sections),
    (error) => error.code === 'nothingValid');
  await assert.rejects(ST.validateAll({ format: 'blab-settings', version: 1, other: 1 }, sections),
    (error) => error.code === 'nothingValid');
});

test('writes go in table order and stop at the first failure, naming what already landed', async () => {
  const log = [];
  const sections = [section('settings', { log }), section('siteRules', { log, fails: true }), section('glossary', { log })];
  // 文件里的顺序和表不一样：写入按表。
  const validated = await ST.validateAll(
    { format: 'blab-settings', version: 1, glossary: 'g', siteRules: { 'x.com': 'always' }, settings: { theme: 'dark' } },
    sections);
  await assert.rejects(ST.applyAll(validated, sections), (error) => {
    assert.ok(error instanceof ST.TransferApplyError);
    assert.deepEqual(error.written, ['settings']);
    assert.equal(error.failed, 'siteRules');
    assert.match(error.cause.message, /siteRules write failed/);
    return true;
  });
  // 没有回滚，也没有越过失败接着写。
  assert.deepEqual(log.map(([key]) => key), ['settings', 'siteRules']);
});

test('a section with nothing accepted is not written at all', async () => {
  const log = [];
  const sections = [section('settings', { log, accept: 0 }), section('siteRules', { log })];
  const validated = await ST.validateAll({ format: 'blab-settings', version: 1, settings: {}, siteRules: {} }, sections);
  assert.deepEqual(await ST.applyAll(validated, sections), ['siteRules']);
  assert.deepEqual(log.map(([key]) => key), ['siteRules']);
});

// ------------------------------------------------------------ 站点规则的写入

// 写入在调用时才看 globalThis.chrome。runtime.sendMessage 接回 applyWrite，测到
// 的就是页面 → 服务工作者队列 → 存储的整条路。
function fakeChrome(initial = {}) {
  const store = JSON.parse(JSON.stringify(initial));
  const sets = [];
  return {
    store,
    sets,
    chrome: {
      runtime: {
        sendMessage: async (message) => {
          try {
            return { value: await SiteRules.applyWrite(message) };
          } catch (error) {
            return { error: error.message };
          }
        },
      },
      storage: {
        sync: {
          get: async (defaults) => {
            const out = {};
            for (const key of Object.keys(defaults)) out[key] = key in store ? store[key] : defaults[key];
            return JSON.parse(JSON.stringify(out));
          },
          set: async (patch) => {
            sets.push(patch);
            Object.assign(store, JSON.parse(JSON.stringify(patch)));
          },
        },
      },
    },
  };
}

test('an import merges into the rule table under normalised keys, in one write', async () => {
  const fake = fakeChrome({ siteRules: { 'keep.test': 'never', 'x.com': 'never' } });
  globalThis.chrome = fake.chrome;
  try {
    const accepted = await SiteRules.importUserRules({ 'www.example.com': 'always', 'x.com': 'always' });
    assert.equal(accepted, 2);
    assert.deepEqual(fake.store.siteRules, {
      'keep.test': 'never',
      'x.com': 'always',
      [SiteRules.normalizeHost('www.example.com')]: 'always',
    });
    assert.equal(fake.sets.length, 1);
  } finally {
    delete globalThis.chrome;
  }
});

test('an import that cannot fit the sync budget writes nothing and says so', async () => {
  const fake = fakeChrome({ siteRules: { 'keep.test': 'never' } });
  globalThis.chrome = fake.chrome;
  try {
    const huge = {};
    for (let i = 0; i < 400; i++) huge[`host-${i}.example-${i}.test`] = 'always';
    await assert.rejects(SiteRules.importUserRules(huge), /budget/);
    assert.deepEqual(fake.store.siteRules, { 'keep.test': 'never' });
    assert.equal(fake.sets.length, 0);
  } finally {
    delete globalThis.chrome;
  }
});

test('an import and a click on another tab both land — they share the one queue', async () => {
  const fake = fakeChrome({ siteRules: {} });
  const set = fake.chrome.storage.sync.set;
  // 慢一点的 set 才照得出读和写之间的空档。
  fake.chrome.storage.sync.set = async (patch) => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return set(patch);
  };
  globalThis.chrome = fake.chrome;
  try {
    await Promise.all([
      SiteRules.importUserRules({ 'a.test': 'always', 'b.test': 'never' }),
      SiteRules.writeUserRule('c.test', 'always'),
    ]);
    assert.deepEqual(Object.keys(fake.store.siteRules).sort(), ['a.test', 'b.test', 'c.test']);
  } finally {
    delete globalThis.chrome;
  }
});

// ------------------------------------------------------------ 设置页接线

test('the settings page loads the transfer card after everything it reads by name', () => {
  const html = repoFile('options/options.html');
  const at = (file) => html.indexOf(`<script src="${file}"></script>`);
  const card = at('options-transfer.js');
  assert.ok(card > 0, 'options.html does not load options-transfer.js');
  assert.ok(at('../shared/settings-transfer.js') > 0 && at('../shared/settings-transfer.js') < card);
  for (const dep of ['../shared/api-compat.js', '../shared/default-settings.js', '../shared/target-lang.js',
    '../i18n/messages.js', '../shared/site-rules.js', '../shared/tab-broadcast.js', '../shared/translation-display.js']) {
    assert.ok(at(dep) >= 0 && at(dep) < card, `${dep} must load before options-transfer.js`);
  }
  // options.js 的 DOMContentLoaded 才调用 setupTransfer，所以它在后面。
  assert.ok(card < at('options.js'));
  assert.match(repoFile('options/options.js'), /setupTransfer\(\);/);
});

test('the import path reuses the page rules instead of restating them', () => {
  const card = repoFile('options/options-transfer.js');
  // 热键冲突、零点击 AI 的三条路、广播的消息形状：各自只有一个答案。
  assert.match(card, /hasHotkeyConflict\(/);
  assert.match(card, /unattendedAiReachable\(/);
  assert.match(card, /TabBroadcast\.settingsUpdated\(/);
  assert.match(card, /SiteRules\.importUserRules\(/);
  assert.doesNotMatch(card, /selectionTranslationHotkey\s*===/);
  assert.doesNotMatch(card, /type:\s*'SETTINGS_UPDATED'/);
  assert.doesNotMatch(card, /storage\.local/);
});
