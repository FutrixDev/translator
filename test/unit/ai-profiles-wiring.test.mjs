// AI 配置档（P1-D）的接线：请求字面量、旧四键、装载顺序、文案。
//
// 选档、校验、写队列、迁移在 ai-profiles.test.mjs / ai-profiles-host.test.mjs 里测，
// 本 frame 的镜像在 content-ai-profiles.test.mjs 里测；这一组扫产品源码，守的是
// 「只有一条路」：
//   - 每条发给引擎的翻译请求都标明 feature —— 选档按功能走，没标的请求在
//     AIProfiles.resolve 里抛，但那要等到有人真的用那条路才红；
//   - 迁移之后没有谁再读、写、监听四个旧键（provider / apiEndpoint / apiKey /
//     modelName），也没有缺省值把它们塞回设置；
//   - 三份装载清单（manifest、设置页、e2e 夹具）和 Node 夹具都在引擎之前装好
//     shared/ai-profiles.js 与本页镜像；
//   - D1 的文案十门语言都有、占位符一个不少、产品代码真的读它。
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { contentBundle, familyPaths, messageCatalog, productSourceFiles, repoSource } from './helpers/sources.mjs';

await import('../../shared/lang-tags.js');
await import('../../shared/site-rules-builtin.js');
await import('../../shared/storage-writer.js');
await import('../../shared/site-rules.js');
await import('../../shared/sync-collection.js');
await import('../../shared/api-compat.js');
await import('../../shared/ai-profiles.js');
const { AIProfiles } = globalThis;

const OLD_KEYS = ['provider', 'apiEndpoint', 'apiKey', 'modelName'];

// 准许提到旧键的产品文件：迁移与旧文件转换的唯一住处，以及收一个配置档当参数
// 的两处（导出去掉 Key、判 Key 缺没缺 —— 那里的 settings 是一档，不是设置）。
const OLD_KEY_OWNERS = new Set([
  'shared/ai-profiles.js',
  'background/ai-profiles-host.js',
  'shared/settings-transfer.js',
  'shared/api-compat.js',
]);

// 去掉整行注释：注释里讲历史（「以前按 !settings.apiKey 判」）不算读旧键。
const code = (source) => source.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');

// ------------------------------------------------------------ 请求字面量

test('ai-profiles wiring: every translate request literal names a known feature', () => {
  const found = [];
  for (const rel of productSourceFiles()) {
    if (!rel.startsWith('content/') && !rel.startsWith('shared/')) continue;
    const source = repoSource(rel);
    for (const match of source.matchAll(/type:\s*'(TRANSLATE[A-Z_]*)'/g)) {
      const rest = source.slice(match.index);
      const end = rest.search(/\n\s*}/);
      assert.ok(end > 0, `${rel}: the ${match[1]} literal has no closing brace`);
      const feature = /feature:\s*'(\w+)'/.exec(rest.slice(0, end));
      const line = source.slice(0, match.index).split('\n').length;
      assert.ok(feature, `${rel}:${line} ${match[1]} 没标 feature：选档按功能走，没标的请求在 resolve 里抛`);
      assert.ok(AIProfiles.FEATURES.includes(feature[1]),
        `${rel}:${line} feature '${feature[1]}' 不在 AIProfiles.FEATURES 里`);
      found.push(`${rel}:${line}`);
    }
  }
  // 扫描真的扫到了东西：整页三处、字幕一处、悬停/划选/卡片/输入框各一处。
  assert.ok(found.length >= 9, `only ${found.length} request literals found: ${found.join(', ')}`);
});

test('ai-profiles wiring: resolving without a feature throws instead of picking the default', () => {
  const profiles = [{ id: 'main', default: true, features: [] }];
  assert.throws(() => AIProfiles.resolve(profiles, {}), TypeError);
  assert.throws(() => AIProfiles.resolve(profiles, { feature: 'everything' }), TypeError);
  assert.equal(AIProfiles.resolve(profiles, { feature: 'page' }).profile.id, 'main');
});

// ------------------------------------------------------------ 旧四键

test('ai-profiles wiring: no product code reads the four old settings off a settings object', () => {
  const offenders = [];
  const re = new RegExp(`\\bsettings\\??\\.(${OLD_KEYS.join('|')})\\b`);
  for (const rel of productSourceFiles()) {
    if (OLD_KEY_OWNERS.has(rel)) continue;
    const hit = re.exec(code(repoSource(rel)));
    if (hit) offenders.push(`${rel}: ${hit[0]}`);
  }
  assert.deepEqual(offenders, [], '迁移之后四个旧键不再有人读：连接信息来自选中的配置档');
});

test('ai-profiles wiring: no storage call names an old key, and no listener watches one', () => {
  const offenders = [];
  const quoted = new RegExp(`['"](${OLD_KEYS.join('|')})['"]`);
  const entry = new RegExp(`\\b(${OLD_KEYS.join('|')})\\s*:`);
  const watched = new RegExp(`changes(\\.(${OLD_KEYS.join('|')})\\b|\\[['"](${OLD_KEYS.join('|')})['"]\\])` +
    `|['"](${OLD_KEYS.join('|')})['"]\\s+in\\s+changes`);
  const destructured = new RegExp(`\\{[^}]*\\b(${OLD_KEYS.join('|')})\\b[^}]*\\}\\s*=\\s*(await\\s+)?chrome\\.storage`);
  for (const rel of productSourceFiles()) {
    if (OLD_KEY_OWNERS.has(rel)) continue;
    const source = code(repoSource(rel));
    for (const call of source.matchAll(/storage\.(sync|local)\.(get|set|remove)\(/g)) {
      const end = source.indexOf(');', call.index);
      const args = source.slice(call.index, end === -1 ? undefined : end);
      if (quoted.test(args) || entry.test(args)) offenders.push(`${rel}: ${args.slice(0, 80)}`);
    }
    const hit = watched.exec(source) || destructured.exec(source);
    if (hit) offenders.push(`${rel}: ${hit[0].slice(0, 80)}`);
  }
  assert.deepEqual(offenders, [], '旧四键只在迁移里读一次、删一次（background/ai-profiles-host.js）');
});

test('ai-profiles wiring: the default settings no longer carry the four old keys', () => {
  const line = new RegExp(`^\\s*(${OLD_KEYS.join('|')})\\s*:`, 'm');
  for (const rel of ['background/settings.js', 'shared/default-settings.js']) {
    const hit = line.exec(code(repoSource(rel)));
    assert.equal(hit, null, `${rel} 还有旧键的缺省值 ${hit && hit[0]}：没有配置档就是没有配置档`);
  }
  assert.deepEqual(AIProfiles.LEGACY_KEYS, OLD_KEYS, '扫描用的四个键就是迁移认的那四个');
});

// ------------------------------------------------------------ 装载顺序

const ENGINE_FAMILY = familyPaths('content/engine', 'content/content-translation-engine.js');

test('ai-profiles wiring: the manifest loads the profiles and the page mirror before the engine family', () => {
  const order = contentBundle('content/content-ai-profiles.js');
  assert.equal(new Set(order).size, order.length, 'manifest 的内容脚本清单里有重复');
  const at = (rel) => {
    const index = order.indexOf(rel);
    assert.notEqual(index, -1, `manifest does not load ${rel}`);
    return index;
  };
  const mirror = at('content/content-ai-profiles.js');
  assert.ok(at('shared/sync-collection.js') < at('shared/ai-profiles.js'));
  assert.ok(at('shared/api-compat.js') < at('shared/ai-profiles.js'));
  assert.ok(at('shared/ai-profiles.js') < mirror, '镜像在加载时取走 AIProfiles');
  for (const rel of ENGINE_FAMILY) assert.ok(mirror < at(rel), `${rel} 排在 content-ai-profiles.js 前面`);
});

test('ai-profiles wiring: the settings page loads shared/ai-profiles.js before the engine family', () => {
  const html = repoSource('options/options.html');
  const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
  const at = (src) => {
    const index = scripts.indexOf(src);
    assert.notEqual(index, -1, `options.html does not load ${src}`);
    return index;
  };
  const profiles = at('../shared/ai-profiles.js');
  assert.ok(at('../shared/sync-collection.js') < profiles);
  assert.ok(at('../shared/api-compat.js') < profiles);
  for (const rel of ENGINE_FAMILY) assert.ok(profiles < at(`../${rel}`), `${rel} 排在 ai-profiles.js 前面`);
  assert.ok(profiles < at('options-ai-profiles.js'));
});

test('ai-profiles wiring: the Node engine harness imports the profiles before the engine', () => {
  const harness = repoSource('test/unit/helpers/engine-harness.mjs');
  const at = (rel) => {
    const index = harness.indexOf(`import('../../../${rel}')`);
    assert.notEqual(index, -1, `engine-harness.mjs does not import ${rel}`);
    return index;
  };
  const profiles = at('shared/ai-profiles.js');
  assert.ok(at('shared/api-compat.js') < profiles);
  assert.ok(at('shared/sync-collection.js') < profiles);
  assert.ok(profiles < at('content/content-translation-engine.js'));
});

test('ai-profiles wiring: the e2e DOM harness loads shared/ai-profiles.js between what it takes and what takes it', () => {
  // 这串清单只按加载期依赖排，不是 manifest 的全序；守的是 ai-profiles.js 这一环的边：
  // 它加载时取走 APICompat / SyncCollection / StorageWriter，custom-rules.js 加载时
  // 取走它。
  const helpers = repoSource('test/e2e/helpers.js');
  const start = helpers.indexOf('const PAGE_TRANSLATION_MODULES = Object.freeze([');
  assert.notEqual(start, -1, 'PAGE_TRANSLATION_MODULES moved or changed shape');
  const list = [...helpers.slice(start, helpers.indexOf('])', start)).matchAll(/'([^']+\.js)'/g)].map((m) => m[1]);
  const at = (rel) => {
    const index = list.indexOf(rel);
    assert.notEqual(index, -1, `PAGE_TRANSLATION_MODULES does not load ${rel}`);
    return index;
  };
  const profiles = at('shared/ai-profiles.js');
  for (const rel of ['shared/api-compat.js', 'shared/sync-collection.js', 'shared/storage-writer.js']) {
    assert.ok(at(rel) < profiles, `${rel} 要排在 shared/ai-profiles.js 前面`);
  }
  assert.ok(profiles < at('shared/custom-rules.js'), 'custom-rules.js 加载时取走 AIProfiles');
});

// ------------------------------------------------------------ 文案

const D1_KEYS = [
  'aiProfileRpm', 'aiProfileConcurrency', 'aiProfileTimeout', 'hintAiProfileZeroUnlimited',
  'hintAiProfileTimeout', 'aiProfileMissing', 'aiProfileInvalid', 'aiProfileTooLarge',
  'aiProfilesBudgetFull', 'aiProfileInUse', 'aiProfileDefaultInUse', 'aiProfileSaveFailed',
  'aiProfileKeyMissing', 'apiErrorTimeout', 'apiErrorEmpty', 'customRuleProfileMissing',
  'customRuleProfileWithBuiltin', 'transferSectionAiProfiles', 'transferPreviewAiProfiles',
];

test('ai-profiles wiring: every D1 string exists in all ten languages with the same placeholders', async () => {
  const { UI_LANGUAGES } = await import('../../i18n/messages.js');
  const catalog = messageCatalog();
  assert.equal(UI_LANGUAGES.length, 10);
  for (const key of D1_KEYS) {
    const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    const english = catalog.en[key];
    assert.equal(typeof english, 'string', `en has no ${key}`);
    for (const lang of UI_LANGUAGES) {
      const text = catalog[lang][key];
      assert.ok(typeof text === 'string' && text.trim(), `${lang} has no ${key}`);
      assert.deepEqual(placeholders(text), placeholders(english), `${lang}.${key} 丢了或多了占位符`);
    }
  }
});

test('ai-profiles wiring: product code reads every D1 string', () => {
  const product = productSourceFiles()
    .filter((rel) => !rel.startsWith('i18n/'))
    .map((rel) => repoSource(rel))
    .join('\n');
  const unread = D1_KEYS.filter((key) => !product.includes(`'${key}'`) && !product.includes(`"${key}"`));
  assert.deepEqual(unread, [], '文案表里有 D1 的键没有产品代码读');
});
