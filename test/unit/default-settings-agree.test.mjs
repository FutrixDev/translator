// 四张默认值表，重叠的键必须给同一个值。
//
// 内容脚本（shared/default-settings.js 的 CONTENT_DEFAULTS）、service worker
// （background/settings.js 的 defaultSettings）、设置页和弹窗（各自
// options.js / popup.js 里的 defaultSettings）各有一张表，而且**应该**各有一张：
// 四边要的键不是同一批，合成一张就会有一多半条目对某一个读者是错的。
//
// 但凡两张表都写了同一个键，它们就是在回答同一个问题「用户没设过的时候算什么」，
// 两个答案里必有一个是用户看到的、另一个是用户看不到却在生效的。这件事真发生
// 过：CONTENT_DEFAULTS 写 targetLang: 'zh-CN'，worker 那张写 ''，于是全新安装的
// 法语用户，右键菜单写着「译成 Français」，整页翻译却是中文。
//
// 所以这里不谈风格，只做一件事：把三张表读出来，重叠的键逐个比。
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoFile = (rel) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');

// background/settings.js 顶层就读 globalThis.OCRCore 和 getUILanguage。
globalThis.chrome = { i18n: { getUILanguage: () => 'en' } };

await import('../../shared/default-settings.js');
await import('../../shared/ocr.js');
const { defaultSettings: workerDefaults } = await import('../../background/settings.js');
const contentDefaults = globalThis.DefaultSettings.contentDefaults();

/**
 * 设置页和弹窗那两张表读不成模块 —— 都是经典脚本，顶层就去 getElementById。
 * 所以把对象字面量单独抠出来求值，两个标识符绑到它们在浏览器里拿到的同一份共享
 * 常量上（这正是要验的东西之一：几边引用的是同一个来源）。
 */
function pageDefaults(rel) {
  const source = repoFile(rel);
  const start = source.indexOf('const defaultSettings = {');
  assert.notEqual(start, -1, `could not find the defaults in ${rel}`);
  const end = source.indexOf('\n};', start);
  const literal = source.slice(source.indexOf('{', start), end + 2);
  const make = new Function('DEFAULT_SELECTION_HOTKEY', 'OCRCore', `return (${literal});`);
  return make(globalThis.DefaultSettings.DEFAULT_SELECTION_HOTKEY, globalThis.OCRCore);
}

const TABLES = [
  ['content scripts (shared/default-settings.js)', contentDefaults],
  ['the service worker (background/settings.js)', workerDefaults],
  ['the options page (options/options.js)', pageDefaults('options/options.js')],
  ['the popup (popup/popup.js)', pageDefaults('popup/popup.js')],
];

test('every key two default tables share gets the same default', () => {
  const disagreements = [];
  for (let i = 0; i < TABLES.length; i += 1) {
    for (let j = i + 1; j < TABLES.length; j += 1) {
      const [leftName, left] = TABLES[i];
      const [rightName, right] = TABLES[j];
      for (const key of Object.keys(left)) {
        if (!Object.prototype.hasOwnProperty.call(right, key)) continue;
        const a = JSON.stringify(left[key]);
        const b = JSON.stringify(right[key]);
        if (a !== b) disagreements.push(`${key}: ${leftName} says ${a}, ${rightName} says ${b}`);
      }
    }
  }
  assert.deepEqual(disagreements, [], `default tables disagree:\n  ${disagreements.join('\n  ')}`);
});

test('the tables really do overlap, so the comparison above means something', () => {
  // 一个只挑重叠键比的断言，在重叠为空时永远是绿的。这条是它的保险丝。
  const shared = Object.keys(contentDefaults).filter((key) => key in workerDefaults);
  assert.ok(shared.length >= 8, `only ${shared.length} keys overlap; the assertion above may be vacuous`);
  assert.ok(shared.includes('translationEngine'));
  assert.ok(shared.includes('targetLang'));
});

test('empty targetLang is what "follow the browser" is written as, wherever it appears', () => {
  // 空串是哨兵，不是「还没填」。但凡有一张表写了具体语言，那张表的读者就会绕过
  // shared/target-lang.js 的解析，直接把它当成用户的选择。没列这个键的表（弹窗
  // 从不读它）不在此列。
  for (const [name, table] of TABLES) {
    if (!('targetLang' in table)) continue;
    assert.equal(table.targetLang, '', `${name} gives targetLang a concrete default`);
  }
  // 而那个曾经用来区分「存的是用户选的还是浏览器回显的」的布尔量已经退休：
  // targetLang 非空本身就是那个信号。留着它等于留下第二个会和第一个吵架的答案。
  for (const [name, table] of TABLES) {
    assert.equal('targetLangSetByUser' in table, false, `${name} still carries targetLangSetByUser`);
  }
});
