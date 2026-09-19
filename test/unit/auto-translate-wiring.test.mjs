// 自动翻译这条链路由五个文件拼起来，彼此之间靠的是「装载顺序」和「同一个全局
// 对象」——两样都不是 import，编辑器不会提醒，跑起来才发现少了一块。这一组测试
// 守的就是这些接缝：没有一条在测翻译本身，测的是「零件都在，而且只有一份」。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
// 这些断言问的是「代码里有没有这一句」，而这些文件的注释里恰恰把该规则原原本本
// 讲了一遍 —— 不剥注释，每一条都会被自己的说明文字匹配上。
//
// 先剥行注释再剥块注释，顺序不能反：行注释里出现的 `content/page/*` 会被当成一个
// 块注释的开头，一路吃到下一个真正的 `*/`，中间的代码就此消失。
const code = (rel) => read(rel)
  .replace(/^[ \t]*\/\/.*$/gm, '')
  .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '');

const manifest = JSON.parse(read('manifest.json'));
const isolated = manifest.content_scripts.find((entry) => (entry.world || 'ISOLATED') === 'ISOLATED').js;

await import('../../shared/default-settings.js');
const { DefaultSettings } = globalThis;

test('两个新模块都装进了 manifest', () => {
  assert.ok(isolated.includes('content/content-auto-discover.js'));
  assert.ok(isolated.includes('content/content-auto-translate.js'));
});

test('调度层读的全局，都由排在它前面的文件提供', () => {
  const source = read('content/content-auto-translate.js');
  const providers = {
    SessionGuard: 'shared/session-guard.js',
    BlockIdentity: 'shared/block-identity.js',
    SiteRules: 'shared/site-rules.js',
    SpaNavigation: 'shared/spa-navigation.js'
  };
  const at = isolated.indexOf('content/content-auto-translate.js');
  for (const [name, file] of Object.entries(providers)) {
    assert.match(source, new RegExp(`globalThis\\.${name}`), `${name} 应当是调度层用到的`);
    const provided = isolated.indexOf(file);
    assert.ok(provided >= 0, `${file} 不在装载清单里`);
    assert.ok(provided < at, `${file} 必须排在调度层之前`);
  }
});

test('默认设置里有自动翻译的三个键，而且总开关默认开', () => {
  const defaults = DefaultSettings.contentDefaults();
  assert.equal(defaults.autoTranslate, true);
  assert.deepEqual(defaults.siteRules, {});
  assert.deepEqual(defaults.autoTranslateLangs, []);
});

test('容器型默认值每次给一份新的：一处记下站点规则不会污染下一处', () => {
  const a = DefaultSettings.contentDefaults();
  const b = DefaultSettings.contentDefaults();
  assert.notEqual(a.siteRules, b.siteRules);
  assert.notEqual(a.autoTranslateLangs, b.autoTranslateLangs);
  a.siteRules['example.com'] = 'always';
  a.autoTranslateLangs.push('en');
  assert.deepEqual(b.siteRules, {});
  assert.deepEqual(b.autoTranslateLangs, []);
  // 源头本身是冻的，谁想就地改它都会当场抛，而不是悄悄改掉所有人的默认值。
  assert.throws(() => { DefaultSettings.CONTENT_DEFAULTS.siteRules['x.com'] = 'never'; }, TypeError);
});

test('译文写回页面只有一个入口 —— 迟到校验才不会漏在某一条路径上', () => {
  const source = code('content/page/batch.js');
  const calls = source.match(/ctx\.insertTranslationBlock\(/g) || [];
  assert.equal(calls.length, 1, '三条插入路径都要走 insertTranslation()');
  assert.match(source, /function insertTranslation\(block, translation, accept\)/);
  assert.match(source, /if \(accept && !accept\(block\)\) return;/);
});

test('语言判定的阈值只有一处，且调度层用的是同一个函数', () => {
  const batch = code('content/page/batch.js');
  assert.equal((batch.match(/LANGUAGE_CONFIDENCE_MIN/g) || []).length, 2, '一处定义一处使用');
  assert.match(batch, /ctx\.detectReliableLanguage = detectReliableLanguage;/);

  const scheduler = code('content/content-auto-translate.js');
  assert.match(scheduler, /ctx\.detectReliableLanguage\(/);
  assert.doesNotMatch(scheduler, /detectLanguage\s*\(/, '调度层不该自己再探一次语言');
  assert.doesNotMatch(scheduler, /\b85\b/, '调度层不该有第二套把握程度阈值');
});

test('该不该翻只由 SiteRules.decide 回答，调度层不自己搭一条阶梯', () => {
  const scheduler = code('content/content-auto-translate.js');
  assert.match(scheduler, /SiteRules\.decide\(/);
  // 有人图省事在这里补一条「黑名单也拦一下」，两处判断就开始各说各话。
  assert.doesNotMatch(scheduler, /blocklist|isBlocked/i);
});

test('发现层只回答「轮到谁了」：不发请求，也不碰页面状态', () => {
  const discover = code('content/content-auto-discover.js');
  assert.doesNotMatch(discover, /runTranslationPass|requestTranslation|insertTranslationBlock/);
  assert.doesNotMatch(discover, /ctx\.state\b/);
});

test('自己插的译文不算页面变了 —— 否则翻译会把自己再触发一遍', () => {
  const discover = code('content/content-auto-discover.js');
  assert.match(discover, /ai-translator-inline-block/);
  assert.match(discover, /function ownMutation\(record\)/);
  // 文本裹套用的 class 挂在页面自己的文字上，认作我们的就会让页面后续的改动
  // 全部失声。见该文件 OWN_UI_SELECTOR 上方的注释。
  assert.doesNotMatch(discover, /ai-translator-text-run/);
});

test('管控容器的漏收计数，读的那一行紧挨着收集，中间没有 await', () => {
  const source = code('content/content-page-translation.js');
  const collect = source.indexOf('ctx.collectTranslatableBlocks(document.body)');
  const skip = source.indexOf('ctx.getManagedSkipCount()');
  assert.ok(collect >= 0 && skip > collect);
  assert.doesNotMatch(source.slice(collect, skip), /await/, '中间夹一次 await，读到的就可能是发现层那次收集的结果');
});

test('「已经是目标语言就别翻」这条设置，自动这一轮也认', () => {
  const scheduler = code('content/content-auto-translate.js');
  // 手动整页翻译在发请求前会先过这道滤网。自动这一轮绕过去，就是把用户明确说过
  // 不必发的文字，一屏一屏地替他发出去 —— 页面上还看不出任何异样。
  assert.match(scheduler, /ctx\.filterBlocksByLanguage\(/);
  assert.match(code('content/page/batch.js'), /ctx\.filterBlocksByLanguage = filterBlocksByLanguage;/);
});
