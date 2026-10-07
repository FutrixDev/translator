// 整份导入里「一条一个 sync 键」的集合那几行（options/options-transfer.js，设计 §12.4）。
//
// 集合抛的是写给自己卡片的 i18n 键（customRulesBudgetFull 之类）。整份导入有自己的
// 两种句式：校验时整份拒绝（TransferError → TRANSFER_ERROR_KEYS），写入中途停下
// （transferErrorApplyFailed 的 {message}）。collectionSection 在两处把表里的键换成
// 这两种句式，表外的错误原样往上抛。这里把设置页的三份脚本（站点翻译规则卡、
// 术语表卡、整份导入）装进 vm，配上真的 CustomRules / Glossary / GlossaryCsv /
// SettingsTransfer 和真的文案目录来跑。
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { messageCatalog, optionsSource, repoSource, sharedSource, workerSource } from './helpers/sources.mjs';

await import('../../shared/lang-tags.js');
await import('../../shared/site-rules-builtin.js');
await import('../../shared/storage-writer.js');
await import('../../shared/site-rules.js');
await import('../../shared/sync-collection.js');
await import('../../shared/prompt-addenda.js');
await import('../../shared/api-compat.js');
// custom-rules.js 在加载时取走 AIProfiles（规则 v3 的 profile，P1-D）。
await import('../../shared/ai-profiles.js');
await import('../../shared/engines.js');
await import('../../shared/custom-rules.js');
await import('../../shared/target-lang.js');
// glossary.js 在加载时取走 TextMarkers（词条不许含占位符和标记，D-387）。
await import('../../shared/text-markers.js');
// glossary.js 在加载时取走 BATCH_DELIMITER（词条里不许有批量分隔符，P1-D）。
await import('../../shared/batch-delimiter.js');
await import('../../shared/glossary.js');
await import('../../shared/glossary-csv.js');
await import('../../shared/settings-transfer.js');
const { AIProfiles, APICompat, CustomRules, Glossary, GlossaryCsv, SettingsTransfer } = globalThis;
const catalog = messageCatalog();

const file = (rules) => ({ format: 'blab-site-rules', version: 1, exportedAt: 1, rules });

// 卡片脚本和整份导入脚本加载时都只 getElementById（术语表卡还往挂载点里填一次
// innerHTML）；预览只读 storage.sync。两个 request 都换成桩，记下是谁收到的：这一层
// 只管错误怎么转述，写入走 SW 队列那一跳由 custom-rules / glossary 的测试管。
function loadPage({ stored = {}, lang = 'en', request = async () => {} } = {}) {
  const requests = [];
  const stub = (owner) => (kind, payload) => {
    requests.push({ owner, kind, payload });
    return request(kind, payload);
  };
  const sandbox = {
    AIProfiles: Object.assign({}, AIProfiles, { request: stub('aiProfiles') }),
    APICompat,
    CustomRules: Object.assign({}, CustomRules, { request: stub('customRules') }),
    Glossary: Object.assign({}, Glossary, { request: stub('glossary') }),
    GlossaryCsv,
    SettingsTransfer,
    console,
    document: {
      getElementById: (id) => ({ id }),
      querySelector: () => null,
    },
    chrome: { storage: { sync: { get: async () => JSON.parse(JSON.stringify(stored)) } } },
    t: (key) => catalog[lang][key],
  };
  // readAiProfiles 在 options-ai-profiles.js 里，那份脚本加载时要画卡片；这里只取它
  // 的那一行（源码断言见 aiProfiles 那一行的测试）。
  sandbox.readAiProfiles = async () => AIProfiles.collection.collect(await sandbox.chrome.storage.sync.get(null));
  vm.createContext(sandbox);
  vm.runInContext(repoSource('options/options-custom-rules.js'), sandbox);
  vm.runInContext(repoSource('options/options-glossary.js'), sandbox);
  vm.runInContext(repoSource('options/options-transfer.js'), sandbox);
  const get = (name) => vm.runInContext(name, sandbox);
  return { get, requests, sandbox };
}

const section = (page, key) => page.get('TRANSFER_SECTIONS').find((row) => row.key === key);

test('customRules row: after siteRules, validated by the card\'s one preview function', async () => {
  const page = loadPage({ stored: { 'customRule:aaaa1111': { v: 1, match: ['a.com'], exclude: ['.old'] } } });
  assert.deepEqual([...page.get('TRANSFER_SECTIONS').map((row) => row.key)], ['settings', 'aiProfiles', 'siteRules', 'customRules', 'glossary']);
  const raw = file([
    { id: 'aaaa1111', match: ['a.com'], exclude: ['.new'] },
    { match: ['b.com'], engine: 'ai' },
  ]);
  const result = await section(page, 'customRules').validate(raw);
  assert.equal(result.value, raw, '值原样带给 apply，不 stringify');
  // dropped 是 vm 里造的数组，跨 realm 比较先展开。
  assert.deepEqual({ ...result, value: null, dropped: [...result.dropped] },
    { value: null, accepted: 2, dropped: [], added: 1, replaced: 1, aiCount: 1 });
  const shown = await section(page, 'customRules').preview(result);
  assert.deepEqual([...shown.lines], ['Site translation rules: 1 will be added, 1 replaced.']);
  assert.deepEqual([...shown.warnings], [page.get('customRulesAiNote(1)')], 'AI 提示和卡片是同一句');

  // 源码层面：validate 调的就是卡片那个函数，不自己合并。
  const source = repoSource('options/options-transfer.js');
  assert.match(source, /await previewCustomRulesImport\(raw\)/);
  assert.doesNotMatch(source, /mergeImport\(/);

  await section(page, 'customRules').apply(raw);
  assert.equal(page.requests.length, 1);
  assert.equal(page.requests[0].owner, 'customRules');
  assert.equal(page.requests[0].kind, 'import');
  assert.equal(page.requests[0].payload.file, raw);
});

test('customRules row: export is the card\'s export file, the section value unwrapped', async () => {
  const page = loadPage({ stored: { 'customRule:aaaa1111': { v: 1, match: ['a.com'], exclude: ['.x'] }, theme: 'dark' } });
  const value = await section(page, 'customRules').collect({ includeApiKey: false });
  assert.equal(value.format, 'blab-site-rules');
  assert.deepEqual(value.rules.map((rule) => rule.id), ['aaaa1111']);
});

test('every collection refusal has a sentence in all ten languages and is thrown somewhere', () => {
  const page = loadPage();
  const refusals = page.get('COLLECTION_REFUSALS');
  const errorKeys = page.get('TRANSFER_ERROR_KEYS');
  const reasonKeys = page.get('TRANSFER_REASON_KEYS');
  const thrown = sharedSource() + workerSource();
  for (const [key, code] of Object.entries(refusals)) {
    assert.match(thrown, new RegExp(`'${key}'`), `${key} 不是 shared/ 或 background/ 抛的键`);
    assert.ok(reasonKeys[code], `${code} 没有原因短语`);
    // sectionSaveFailed 只在写入时出现，所以没有校验时的整句。
    const keys = [key, reasonKeys[code]].concat(code === 'sectionSaveFailed' ? [] : [errorKeys[code]]);
    for (const lang of Object.keys(catalog)) {
      for (const k of keys) assert.ok(k && catalog[lang][k], `${lang} 缺 ${k}`);
    }
  }
});

test('validate: a table key becomes TransferError(code, section key); anything else is rethrown as is', async () => {
  const page = loadPage();
  const refusals = page.get('COLLECTION_REFUSALS');
  const factory = page.get('collectionSection');
  for (const [key, code] of Object.entries(refusals)) {
    const row = factory({ key: 'customRules', validate: async () => { throw new Error(key); }, apply() {} });
    await assert.rejects(row.validate({}), (error) => {
      assert.ok(error instanceof SettingsTransfer.TransferError);
      assert.equal(error.code, code);
      assert.equal(error.detail, 'customRules');
      return true;
    });
  }
  const odd = new Error('Extension context invalidated.');
  const row = factory({ key: 'customRules', validate: async () => { throw odd; }, apply() {} });
  await assert.rejects(row.validate({}), (error) => error === odd);

  // 真的那一行：坏文件和额度满两条路走到底。
  const real = section(page, 'customRules');
  await assert.rejects(real.validate({ format: 'nope' }),
    (error) => error.code === 'sectionInvalid' && error.detail === 'customRules');
  const full = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [
    `customRule:r${String(i).padStart(7, '0')}`, { v: 1, match: ['a.com'], exclude: ['.x'] },
  ]));
  const fullPage = loadPage({ stored: full });
  await assert.rejects(section(fullPage, 'customRules').validate(file([{ match: ['b.com'], exclude: ['.x'] }])),
    (error) => error.code === 'sectionBudgetFull' && error.detail === 'customRules');
});

test('apply: a table key becomes the reason phrase with the original as cause; anything else is rethrown', async () => {
  const page = loadPage({ lang: 'zh-CN' });
  const refusals = page.get('COLLECTION_REFUSALS');
  const reasonKeys = page.get('TRANSFER_REASON_KEYS');
  const factory = page.get('collectionSection');
  for (const [key, code] of Object.entries(refusals)) {
    const original = new Error(key);
    const row = factory({ key: 'customRules', validate() {}, apply: async () => { throw original; } });
    await assert.rejects(row.apply({}), (error) => {
      assert.equal(error.message, catalog['zh-CN'][reasonKeys[code]]);
      assert.equal(error.cause, original);
      return true;
    });
  }
  const odd = new Error('Extension context invalidated.');
  const row = factory({ key: 'customRules', validate() {}, apply: async () => { throw odd; } });
  await assert.rejects(row.apply({}), (error) => error === odd);

  // 真的那一行：SW 回的是 customRulesBudgetFull。
  const budget = new Error('customRulesBudgetFull');
  const failing = loadPage({ lang: 'zh-CN', request: async () => { throw budget; } });
  await assert.rejects(section(failing, 'customRules').apply(file([])),
    (error) => error.message === '超出同步空间' && error.cause === budget);
});

test('what the user reads: no key names, the section named in the UI language', async () => {
  for (const lang of ['zh-CN', 'en']) {
    const page = loadPage({ lang, request: async () => { throw new Error('customRuleSaveFailed'); } });
    const text = page.get('transferErrorText');
    const sectionText = catalog[lang].transferSectionCustomRules;
    const sentences = [];
    await assert.rejects(section(page, 'customRules').validate({ format: 'nope' }), (error) => {
      sentences.push(text(error));
      return true;
    });
    const validated = { sections: [
      { key: 'siteRules', value: {}, accepted: 1 },
      { key: 'customRules', value: file([]), accepted: 1 },
    ], unknown: [] };
    const rows = page.get('TRANSFER_SECTIONS').map((row) => (row.key === 'siteRules' ? Object.assign({}, row, { apply: async () => {} }) : row));
    await assert.rejects(SettingsTransfer.applyAll(validated, rows), (error) => {
      sentences.push(text(error));
      return true;
    });
    for (const sentence of sentences) {
      assert.ok(sentence.includes(sectionText), `${lang}: ${sentence}`);
      assert.doesNotMatch(sentence, /customRule|section[A-Z]|transfer[A-Z]|undefined/, `${lang}: ${sentence}`);
    }
    assert.ok(sentences[1].includes(catalog[lang].transferReasonSaveFailed), sentences[1]);
  }
});

test('transferDesc names every section the file carries', () => {
  const names = loadPage().get('TRANSFER_SECTION_NAMES');
  for (const lang of ['zh-CN', 'en']) {
    const desc = catalog[lang].transferDesc.toLowerCase();
    for (const key of Object.values(names)) {
      assert.ok(desc.includes(catalog[lang][key].toLowerCase()), `${lang} transferDesc 没提 ${catalog[lang][key]}`);
    }
  }
});

// ------------------------------------------------------------ AI 配置档那一行（P1-D）

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const storedProfile = (fields) => Object.assign({
  v: 1, provider: 'openai', apiEndpoint: OPENAI_URL, modelName: 'gpt-4.1-mini', features: [], default: false,
}, fields);

test('aiProfiles row: second, the key leaves only when the box is ticked, the preview counts and warns', async () => {
  const stored = {
    'aiProfile:legacy': storedProfile({ name: 'Default', apiKey: 'sk-local', default: true }),
    theme: 'dark',
  };
  const page = loadPage({ stored, lang: 'zh-CN' });
  assert.equal(page.get('TRANSFER_SECTIONS')[1].key, 'aiProfiles', '在 customRules 之前：规则的 profile 要先有档');
  assert.equal(page.get('TRANSFER_SECTION_NAMES').aiProfiles, 'transferSectionAiProfiles');

  const without = await section(page, 'aiProfiles').collect({ includeApiKey: false });
  assert.deepEqual(without.map((profile) => [profile.id, 'apiKey' in profile]), [['legacy', false]]);
  const withKey = await section(page, 'aiProfiles').collect({ includeApiKey: true });
  assert.deepEqual(withKey.map((profile) => [profile.id, profile.apiKey]), [['legacy', 'sk-local']]);

  // 同 id 一档（不带 Key，本机有 Key 可沿用）+ 新的一档（不带 Key，也没得沿用）。
  const raw = [
    Object.assign({}, without[0]),
    { id: 'second01', name: 'Second', provider: 'openai', apiEndpoint: OPENAI_URL, modelName: 'gpt-4.1', features: ['hover'] },
  ];
  const result = await section(page, 'aiProfiles').validate(raw);
  assert.equal(result.value, raw, '值原样带给 apply');
  assert.deepEqual({ accepted: result.accepted, dropped: [...result.dropped], added: result.added, replaced: result.replaced },
    { accepted: 2, dropped: [], added: 1, replaced: 1 });
  const shown = await section(page, 'aiProfiles').preview(result);
  assert.deepEqual([...shown.lines], ['AI 配置档：将新增 1 个 AI 配置档、替换 1 个。']);
  assert.deepEqual([...shown.warnings], ['「Second」未填 Key，导入后请到设置里补上。'],
    '沿用本机 Key 的那一档不警告，没 Key 的新档警告一次');

  // 换了接口地址又没带 Key：本机那把 Key 会发去新地址。
  const moved = [Object.assign({}, without[0], { apiEndpoint: 'https://example.test/v1/chat/completions' })];
  const movedShown = await section(page, 'aiProfiles').preview(await section(page, 'aiProfiles').validate(moved));
  assert.deepEqual([...movedShown.warnings],
    [catalog['zh-CN'].transferEndpointKeyWarning.replace('{endpoint}', 'https://example.test/v1/chat/completions')]);

  await section(page, 'aiProfiles').apply(raw);
  const [{ owner, kind, payload }] = page.requests;
  assert.deepEqual({ owner, kind, keepKeys: payload.keepKeys, profiles: payload.profiles },
    { owner: 'aiProfiles', kind: 'import', keepKeys: true, profiles: raw });

  // 源码层面：readAiProfiles 就是这里桩的那一行。
  assert.match(repoSource('options/options-ai-profiles.js'),
    /async function readAiProfiles\(\) \{\n {2}return AIProfiles\.collection\.collect\(await chrome\.storage\.sync\.get\(null\)\);\n\}/);
});

test('aiProfiles row: a bad profile, two defaults, a feature twice or a repeated id refuse the whole section', async () => {
  const page = loadPage();
  // 没配过 AI 的设备导出的是空数组：收下 0 档，不拒整份（applyAll 跳过 accepted 0 的一节）。
  const empty = await section(page, 'aiProfiles').validate([]);
  assert.deepEqual({ accepted: empty.accepted, added: empty.added, replaced: empty.replaced }, { accepted: 0, added: 0, replaced: 0 });
  const good = (id, fields) => Object.assign({ id, name: id, provider: 'openai', apiEndpoint: OPENAI_URL, modelName: 'm' }, fields);
  const bad = [
    'nope',
    [good('aaaa0001', { apiEndpoint: 'ftp://x' })],
    [good('bad id')],
    [good('aaaa0001', { default: true }), good('aaaa0002', { default: true })],
    [good('aaaa0001', { features: ['page'] }), good('aaaa0002', { features: ['page'] })],
    [good('aaaa0001'), good('aaaa0001')],
    Array.from({ length: AIProfiles.LIMITS.maxItems + 1 }, (_, i) => good(`aaaa${String(i).padStart(4, '0')}`)),
  ];
  for (const raw of bad) {
    await assert.rejects(section(page, 'aiProfiles').validate(raw),
      (error) => error instanceof SettingsTransfer.TransferError && error.code === 'sectionInvalid' && error.detail === 'aiProfiles',
      JSON.stringify(raw).slice(0, 80));
  }
});

// ------------------------------------------------------------ 术语表那一行

const GLOSSARY_HEADER = 'source,target,case_sensitive,site,target_lang';

test('glossary row: last, carries the card\'s CSV export, validated by the card\'s one preview function', async () => {
  const stored = {
    'glossary:aaaa0001': { s: 'attention', t: '注意力', l: 'zh-CN', u: 1 },
    'glossary:aaaa0002': { s: 'GPU', l: '*', u: 2 },
    theme: 'dark',
  };
  const page = loadPage({ stored });
  const keys = [...page.get('TRANSFER_SECTIONS').map((row) => row.key)];
  assert.equal(keys[keys.length - 1], 'glossary', '术语表排在 customRules 后面');
  assert.equal(page.get('TRANSFER_SECTION_NAMES').glossary, 'transferSectionGlossary');

  const exported = await section(page, 'glossary').collect({ includeApiKey: false });
  assert.equal(exported, GlossaryCsv.serialize(Glossary.collect(stored)), '整份导出里就是卡片导出的那份 CSV');

  // 改一条（同 dedupeKey）、加一条：和卡片的预览同一对数。
  const raw = `${GLOSSARY_HEADER}\r\nattention,关注,0,,zh-CN\r\nLLM,,1,,*\r\n`;
  const result = await section(page, 'glossary').validate(raw);
  assert.equal(result.value, raw, 'CSV 原文带给 apply，SW 重新解析');
  assert.deepEqual({ ...result, dropped: [...result.dropped] },
    { value: raw, accepted: 2, dropped: [], added: 1, replaced: 1 });
  assert.deepEqual(GlossaryCsv.previewImport(Glossary.collect(stored), raw), { added: 1, replaced: 1 });
  const shown = await section(page, 'glossary').preview(result);
  assert.deepEqual([...shown.lines], ['Glossary: 1 will be added, 1 replaced.']);
  assert.deepEqual([...shown.warnings], []);

  // 源码层面：validate 调的就是卡片那个函数，apply 走 SW 的 import。
  const source = repoSource('options/options-transfer.js');
  assert.match(source, /await previewGlossaryImport\(raw\)/);
  assert.match(repoSource('options/options-glossary.js'), /GlossaryCsv\.previewImport\(await readGlossary\(\), text\)/);

  await section(page, 'glossary').apply(raw);
  assert.equal(page.requests.length, 1);
  // payload 是 vm 里造的对象，跨 realm 比较先逐项取。
  const [{ owner, kind, payload }] = page.requests;
  assert.deepEqual({ owner, kind, keys: Object.keys(payload), csv: payload.csv },
    { owner: 'glossary', kind: 'import', keys: ['csv'], csv: raw });
});

test('glossary row: a bad file, a full glossary and a failed write are named as the glossary section', async () => {
  const page = loadPage({ lang: 'zh-CN' });
  const text = page.get('transferErrorText');
  for (const raw of [42, `${GLOSSARY_HEADER}\r\ngood,好\r\n,empty source\r\n`]) {
    await assert.rejects(section(page, 'glossary').validate(raw), (error) => {
      assert.ok(error instanceof SettingsTransfer.TransferError);
      assert.equal(error.code, 'sectionInvalid');
      assert.equal(error.detail, 'glossary');
      assert.ok(text(error).includes(catalog['zh-CN'].transferSectionGlossary), text(error));
      return true;
    });
  }
  const full = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [
    `glossary:g${String(i).padStart(7, '0')}`, { s: `term${i}`, l: '*', u: 1 },
  ]));
  await assert.rejects(section(loadPage({ stored: full }), 'glossary').validate('one more,x'),
    (error) => error.code === 'sectionBudgetFull' && error.detail === 'glossary');

  const budget = new Error('glossaryBudgetFull');
  const failing = loadPage({ lang: 'zh-CN', request: async () => { throw budget; } });
  await assert.rejects(section(failing, 'glossary').apply('a,b'),
    (error) => error.message === catalog['zh-CN'].transferReasonBudgetFull && error.cause === budget);
});

test('the five glossary refusals are in the table, and each is a key Glossary throws', () => {
  const refusals = loadPage().get('COLLECTION_REFUSALS');
  assert.deepEqual(
    Object.fromEntries(Object.entries(refusals).filter(([key]) => key.startsWith('glossary'))),
    {
      glossaryImportInvalid: 'sectionInvalid',
      glossaryEntryInvalid: 'sectionInvalid',
      glossaryEntryTooLarge: 'sectionInvalid',
      glossaryBudgetFull: 'sectionBudgetFull',
      glossarySaveFailed: 'sectionSaveFailed',
    });
  for (const key of Object.keys(refusals).filter((k) => k.startsWith('glossary'))) {
    assert.equal(Glossary.userErrorKey(new Error(key)), key, `${key} 不是 Glossary 回给界面的键`);
  }
});

test('every export on the settings page downloads through the one downloadFile', () => {
  const options = optionsSource();
  // 整份设置、站点规则、术语表三处导出只有一种交给浏览器的方式；第二份 Blob URL
  // 下载代码回来，就是又多了一条要单独维护的路。
  assert.equal(options.split('URL.createObjectURL(').length - 1, 1, '设置页只能有一处 createObjectURL');
  assert.equal(options.split('function downloadFile(').length - 1, 1);
  for (const exporter of ['exportSettings', 'exportCustomRules', 'exportGlossary']) {
    const body = options.match(new RegExp(`function ${exporter}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
    assert.ok(body, `${exporter} 不见了`);
    assert.match(body[0], /downloadFile\(/, `${exporter} 没走 downloadFile`);
  }
});
