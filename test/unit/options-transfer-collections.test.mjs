// 整份导入里「一条一个 sync 键」的集合那几行（options/options-transfer.js，设计 §12.4）。
//
// 集合抛的是写给自己卡片的 i18n 键（customRulesBudgetFull 之类）。整份导入有自己的
// 两种句式：校验时整份拒绝（TransferError → TRANSFER_ERROR_KEYS），写入中途停下
// （transferErrorApplyFailed 的 {message}）。collectionSection 在两处把表里的键换成
// 这两种句式，表外的错误原样往上抛。这里把设置页的两份脚本装进 vm，配上真的
// CustomRules / SettingsTransfer 和真的文案目录来跑。
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { messageCatalog, repoSource, sharedSource, workerSource } from './helpers/sources.mjs';

await import('../../shared/lang-tags.js');
await import('../../shared/site-rules-builtin.js');
await import('../../shared/storage-writer.js');
await import('../../shared/site-rules.js');
await import('../../shared/sync-collection.js');
await import('../../shared/custom-rules.js');
await import('../../shared/settings-transfer.js');
const { CustomRules, SettingsTransfer } = globalThis;
const catalog = messageCatalog();

const file = (rules) => ({ format: 'blab-site-rules', version: 1, exportedAt: 1, rules });

// 卡片脚本和整份导入脚本加载时都只 getElementById；预览只读 storage.sync。
// request 换成桩：这一层只管错误怎么转述，写入走 SW 队列那一跳由 custom-rules 的测试管。
function loadPage({ stored = {}, lang = 'en', request = async () => {} } = {}) {
  const requests = [];
  const sandbox = {
    CustomRules: Object.assign({}, CustomRules, {
      request: (kind, payload) => {
        requests.push({ kind, payload });
        return request(kind, payload);
      },
    }),
    SettingsTransfer,
    console,
    document: {
      getElementById: (id) => ({ id }),
      querySelector: () => null,
    },
    chrome: { storage: { sync: { get: async () => JSON.parse(JSON.stringify(stored)) } } },
    t: (key) => catalog[lang][key],
  };
  vm.createContext(sandbox);
  vm.runInContext(repoSource('options/options-custom-rules.js'), sandbox);
  vm.runInContext(repoSource('options/options-transfer.js'), sandbox);
  const get = (name) => vm.runInContext(name, sandbox);
  return { get, requests, sandbox };
}

const section = (page, key) => page.get('TRANSFER_SECTIONS').find((row) => row.key === key);

test('customRules row: after siteRules, validated by the card\'s one preview function', async () => {
  const page = loadPage({ stored: { 'customRule:aaaa1111': { v: 1, match: ['a.com'], exclude: ['.old'] } } });
  assert.deepEqual([...page.get('TRANSFER_SECTIONS').map((row) => row.key)], ['settings', 'siteRules', 'customRules']);
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
