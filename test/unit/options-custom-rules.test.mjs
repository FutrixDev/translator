// 设置页的站点翻译规则卡片（options/options-custom-rules.js），设计 §4。
//
// 导入预览只由一个函数算（D-306）：previewCustomRulesImport(file)。卡片自己的导入
// 和整份导入的规则小节都调它，合并和额度只在 CustomRules.mergeImport 里算一次。
// 这里把卡片脚本装进 vm，配上真的 CustomRules 和一个假的 storage.sync，直接跑它。
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { optionsSource, repoSource } from './helpers/sources.mjs';

await import('../../shared/lang-tags.js');
await import('../../shared/site-rules-builtin.js');
await import('../../shared/storage-writer.js');
await import('../../shared/site-rules.js');
await import('../../shared/sync-collection.js');
await import('../../shared/custom-rules.js');
const { CustomRules } = globalThis;

const file = (rules, over = {}) => Object.assign({ format: 'blab-site-rules', version: 1, exportedAt: 1, rules }, over);

// 卡片脚本加载时只 getElementById；预览只读 storage.sync、只用 querySelector 查选择器。
function loadCard(stored) {
  const reads = [];
  const sandbox = {
    CustomRules,
    console,
    document: {
      getElementById: (id) => ({ id }),
      querySelector: (selector) => {
        if (selector.includes('!')) throw new SyntaxError(`bad selector ${selector}`);
        return null;
      },
    },
    chrome: {
      storage: {
        sync: {
          get: async (keys) => {
            reads.push(keys);
            return JSON.parse(JSON.stringify(stored));
          },
        },
      },
    },
    t: (key) => key,
    fill: (template, values) => template.replace(/\{(\w+)\}/g, (_, name) => String(values[name])),
  };
  vm.createContext(sandbox);
  vm.runInContext(repoSource('options/options-custom-rules.js'), sandbox);
  return { card: sandbox, reads };
}

test('import preview: counts added, replaced and AI rules against what storage holds now', async () => {
  const { card, reads } = loadCard({
    'customRule:aaaa1111': { v: 1, match: ['a.com'], exclude: ['.old'] },
    theme: 'dark',
  });
  // 卡片还没读回来（customRulesList 是空的）：预览照样按存储里的算，替换数对。
  const preview = await card.previewCustomRulesImport(file([
    { id: 'aaaa1111', match: ['a.com'], exclude: ['.new'] },
    { match: ['b.com'], engine: 'ai' },
  ]));
  assert.deepEqual({ ...preview }, { added: 1, replaced: 1, aiCount: 1 });
  assert.deepEqual(reads, [null], '现读整个 sync 区，不用卡片手里那份');
});

test('import preview: throws the collection error keys, never a second quota check', async () => {
  const { card } = loadCard({});
  await assert.rejects(card.previewCustomRulesImport({ format: 'nope' }), { message: 'customRulesImportInvalid' });
  // 选择器语法在这一侧查（SW 写入时不查），所以预览只会比写入严。
  await assert.rejects(
    card.previewCustomRulesImport(file([{ match: ['a.com'], exclude: ['div!'] }])),
    (error) => error.message === 'customRulesImportInvalid' && error.cause.message === 'customRuleSelectorInvalid',
  );
  const full = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [
    `customRule:r${String(i).padStart(7, '0')}`, { v: 1, match: ['a.com'], engine: 'ai' },
  ]));
  await assert.rejects(
    loadCard(full).card.previewCustomRulesImport(file([{ match: ['b.com'], engine: 'ai' }])),
    { message: 'customRulesBudgetFull' },
  );
});

test('import preview: the one place in the settings page that merges or checks the quota', () => {
  const options = optionsSource();
  const merges = options.split('CustomRules.mergeImport(').length - 1;
  assert.equal(merges, 1, '设置页只能有一处 mergeImport');
  const preview = options.match(/async function previewCustomRulesImport\(file\) \{[\s\S]*?\n\}/);
  assert.ok(preview, 'previewCustomRulesImport 不见了');
  assert.ok(preview[0].includes('CustomRules.mergeImport('), 'mergeImport 只在预览函数里');
  // 额度在 mergeImport 里面查（CustomRules.assertFits），设置页不再查第二遍。
  assert.doesNotMatch(options, /assertFits\(/);
});

test('userErrorKey: the collection keys and customRuleSaveFailed, nothing else', () => {
  for (const key of CustomRules.ERROR_KEYS) assert.equal(CustomRules.userErrorKey(new Error(key)), key);
  assert.equal(CustomRules.userErrorKey(new Error('customRuleSaveFailed')), 'customRuleSaveFailed');
  assert.equal(CustomRules.userErrorKey(new Error('Extension context invalidated.')), null);
  assert.equal(CustomRules.userErrorKey(null), null);
  // 拾取器和卡片都问它，不各自拼一张表。
  assert.doesNotMatch(optionsSource(), /CustomRules\.ERROR_KEYS/);
  assert.doesNotMatch(repoSource('content/picker/picker.js'), /CustomRules\.ERROR_KEYS/);
});
