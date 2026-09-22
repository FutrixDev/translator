// 「译成哪门语言」只有一个答案 —— shared/target-lang.js。
//
// 曾经有三个：background/settings.js 和 options/options.js 各抄了一份
// getBrowserLanguage()，content/content-language.js 写的第三种连映射都没做，直接
// 把 navigator.language 原样交出去。三份实现只要不一致，同一次安装里两个界面就
// 会对同一件事各说各话；它也真的不一致过，见 default-settings-agree.test.mjs。
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const repoFile = (rel) => readFileSync(root + rel, 'utf8');

function withBrowserLanguage(tag, run) {
  const before = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { language: tag }, configurable: true });
  try {
    return run();
  } finally {
    if (before) Object.defineProperty(globalThis, 'navigator', before);
    else delete globalThis.navigator;
  }
}

await import('../../shared/target-lang.js');
const TargetLang = globalThis.TargetLang;

test('存过的语言就是答案，不再归一化', () => {
  // 归一化存下来的值等于替用户改设置：他在 storage 里写的 zh-TW 不该变成 zh-CN。
  assert.equal(TargetLang.effective({ targetLang: 'zh-TW' }), 'zh-TW');
  assert.equal(TargetLang.effective({ targetLang: 'ja' }), 'ja');
});

test('空 = 跟随浏览器，而且永远答得出一门语言', () => {
  withBrowserLanguage('fr-FR', () => {
    assert.equal(TargetLang.effective({ targetLang: '' }), 'fr');
    assert.equal(TargetLang.effective({}), 'fr');
    assert.equal(TargetLang.effective(null), 'fr');
    assert.equal(TargetLang.effective(undefined), 'fr');
  });
  // 一门谁也认不出的语言落到英文，而不是落到空串 —— 空串发给引擎是个坏请求。
  withBrowserLanguage('wo-SN', () => assert.equal(TargetLang.effective({}), 'en'));
  withBrowserLanguage('', () => assert.equal(TargetLang.effective({}), 'en'));
});

test('中文的两种字形不能靠前缀匹配', () => {
  // zh-Hant 的前缀是 zh，前缀匹配给出的是 zh-CN —— 正好是这个用户不要的那一种。
  assert.equal(TargetLang.fromTag('zh-Hant'), 'zh-TW');
  assert.equal(TargetLang.fromTag('zh-TW'), 'zh-TW');
  assert.equal(TargetLang.fromTag('zh-HK'), 'zh-TW');
  assert.equal(TargetLang.fromTag('zh-Hans'), 'zh-CN');
  assert.equal(TargetLang.fromTag('zh'), 'zh-CN');
  assert.equal(TargetLang.fromTag('zh-SG'), 'zh-CN');
});

test('地区变体落到它的语言上', () => {
  assert.equal(TargetLang.fromTag('pt-BR'), 'pt');
  assert.equal(TargetLang.fromTag('en-AU'), 'en');
  assert.equal(TargetLang.fromTag('de-CH'), 'de');
  assert.equal(TargetLang.fromTag('es-419'), 'es');
});

test('没有第二处地方再写一遍这套映射', () => {
  // 一份新的 getBrowserLanguage() 不会报错，它只会在某一个界面上悄悄给出另一个
  // 答案；只有把它挡在这里，「三处实现」才不会长回来。
  for (const rel of ['background/settings.js', 'options/options.js', 'content/content-language.js', 'popup/popup.js']) {
    // 注释里提得起这两样东西 —— 解释「以前这里是怎么错的」正需要写出它们。
    const source = repoFile(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.equal(/langMap\s*=/.test(source), false, `${rel} 又抄了一份语言映射表`);
    assert.equal(/navigator\.(userL|l)anguage/.test(source), false,
      `${rel} 直接读了 navigator.language，应当走 TargetLang`);
  }
});

test('四份装载清单里，解析器排在读它的人前面', () => {
  // 经典脚本按顺序加载，谁在谁前面就是依赖关系本身。漏一处不报错 —— 那一处的
  // TargetLang 是 undefined，整个文件在加载时抛错，然后静静地什么都不做。
  const manifest = JSON.parse(repoFile('manifest.json'));
  const readers = ['content/content-language.js', 'content/content-translation-engine.js'];
  for (const cs of manifest.content_scripts) {
    const order = cs.js || [];
    for (const reader of readers) {
      const at = order.indexOf(reader);
      if (at < 0) continue;
      const dep = order.indexOf('shared/target-lang.js');
      assert.ok(dep >= 0, `${cs.matches} 装了 ${reader} 却没装 shared/target-lang.js`);
      assert.ok(dep < at, `${cs.matches} 里 shared/target-lang.js 必须排在 ${reader} 之前`);
    }
  }

  const html = repoFile('options/options.html');
  const dep = html.indexOf('<script src="../shared/target-lang.js"></script>');
  assert.notEqual(dep, -1, 'options.html 没装 shared/target-lang.js');
  assert.ok(dep < html.indexOf('<script src="options.js"></script>'),
    'options.html 里 shared/target-lang.js 要排在 options.js 之前');

  assert.match(repoFile('background/settings.js'), /import '\.\.\/shared\/target-lang\.js';/,
    'background/settings.js 没 import shared/target-lang.js');
});
