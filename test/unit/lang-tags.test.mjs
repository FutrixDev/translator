// shared/lang-tags.js —— 「这两门语言是同一门吗」的唯一出处。
//
// 这一问在扩展里被四处问过：字幕引擎（声道语言 vs 目标语言）、整页翻译（某一段
// 正文 vs 目标语言）、自动翻译的决策层（页面语言 vs 目标语言）、界面层（哪个选项
// 该标成选中）。它们曾经各写各的，于是同一对语言在不同地方得到不同答案——而这种
// 不一致只会以「有时候翻、有时候不翻」的形式被用户看见。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

await import('../../shared/lang-tags.js');
const L = globalThis.LangTags;

const root = fileURLToPath(new URL('../../', import.meta.url));
const repoFile = (rel) => readFileSync(root + rel, 'utf8');

test('基码就是第一段，小写，空输入答空串', () => {
  assert.equal(L.getLangBase('zh-Hant-TW'), 'zh');
  assert.equal(L.getLangBase('EN-GB'), 'en');
  assert.equal(L.getLangBase('ja'), 'ja');
  assert.equal(L.getLangBase(''), '');
  assert.equal(L.getLangBase(null), '');
  assert.equal(L.getLangBase(undefined), '');
});

test('书写系统：中文才有答案，而且地区码也算数', () => {
  // 标签很少自己带书写系统：YouTube 发 zh-Hans/zh-Hant，野生的 <track> 和
  // <html lang> 写 zh-CN/zh-TW 的多得多，所以地区码必须认。
  assert.equal(L.getScriptVariant('zh-TW'), 'hant');
  assert.equal(L.getScriptVariant('zh-HK'), 'hant');
  assert.equal(L.getScriptVariant('zh-Hant'), 'hant');
  assert.equal(L.getScriptVariant('zh-CN'), 'hans');
  assert.equal(L.getScriptVariant('zh-SG'), 'hans');
  assert.equal(L.getScriptVariant('ZH-HANS'), 'hans');

  // 「这个标签没说」和「这不是中文」是同一个答案：空串。调用方只该拿它去比，
  // 不该拿它去展示。
  assert.equal(L.getScriptVariant('zh'), '');
  assert.equal(L.getScriptVariant('en-GB'), '');
  assert.equal(L.getScriptVariant(''), '');
});

test('简体和繁体不是同一门语言，别的语言的地区码则是', () => {
  // 一条繁体的原文配简体的目标，正是用户要的那一件事。按基码判，两边都是 zh，
  // 「本来就是你的语言」就成立了——字幕在那道闸门上返回，整页翻译把整页跳过。
  assert.equal(L.isSameLanguage('zh-TW', 'zh-CN'), false);
  assert.equal(L.isSameLanguage('zh-Hant', 'zh-Hans'), false);
  assert.equal(L.isSameLanguage('zh-HK', 'zh-CN'), false);
  assert.equal(L.isSameLanguage('zh-Hant-TW', 'zh-SG'), false);

  // 同一套字就是同一门语言，大小写和写法都不算数。
  assert.equal(L.isSameLanguage('zh-TW', 'zh-hant'), true);
  assert.equal(L.isSameLanguage('ZH-CN', 'zh-Hans'), true);

  // 说不准的那一边按「同语言」算：这是一道花钱的闸，猜「不同」是替用户买一次
  // 多半什么也没变的翻译。
  assert.equal(L.isSameLanguage('zh', 'zh-CN'), true);
  assert.equal(L.isSameLanguage('zh-TW', 'zh'), true);

  // 别的语言，地区码不分家——en-GB 配 en 去译一遍才是 bug。
  assert.equal(L.isSameLanguage('en-GB', 'en'), true);
  assert.equal(L.isSameLanguage('pt-BR', 'pt-PT'), true);
  assert.equal(L.isSameLanguage('en', 'ja'), false);
  assert.equal(L.isSameLanguage('', 'en'), false);
  assert.equal(L.isSameLanguage('en', ''), false);
  assert.equal(L.isSameLanguage(null, null), false);
});

test('全仓只有这一份实现：别处不许再写一遍 split(\'-\')[0]', () => {
  // 这条测试守的是**不要有第二份**。四个地方各写一遍不会报错，只会在某一对
  // 语言上静静地给出两个答案。
  const sources = [
    'shared/caption-core.js',
    'shared/site-rules.js',
    'content/content-language.js',
    'content/page/batch.js',
    'content/content-video-captions.js',
  ];
  for (const rel of sources) {
    const text = repoFile(rel);
    assert.ok(
      !/function getLangBase\s*\(/.test(text),
      `${rel} 里又长出一份 getLangBase —— 它的主人是 shared/lang-tags.js`,
    );
    assert.ok(
      !/function (isSameLanguage|getScriptVariant)\s*\(/.test(text),
      `${rel} 里又长出一份同语言判定 —— 它的主人是 shared/lang-tags.js`,
    );
  }

  // normalizeTargetLang 里那一句 split('-')[0] 是另一件事（把目标语言映射到设置
  // 页那张选项表），留着；它不参与「这两门语言一样吗」。
  assert.match(repoFile('content/content-language.js'), /ctx\.getLangBase = globalThis\.LangTags\.getLangBase;/);
});

test('三条路问的是同一句：字幕、整页正文、自动翻译的决策层', () => {
  // 这一条守的是「同一个问题只有一个答案」。上一条守的是别处没有第二份实现，
  // 这一条守的是**调用方真的去问了**——一个没人调的共用模块，和没有是一样的。
  assert.match(
    repoFile('content/content-video-captions.js'),
    /langTags\.isSameLanguage\(/,
    '字幕的 sameLanguage() 要走共用判定',
  );
  assert.match(
    repoFile('shared/site-rules.js'),
    /LangTags\.isSameLanguage\(pageLang, targetLang\)/,
    'decide() 的 SAME_LANGUAGE 那一档要走共用判定',
  );
  assert.match(
    repoFile('content/page/batch.js'),
    /isSameLanguage\(await detectReliableLanguage\(text\), targetLang\)/,
    '整页翻译的「这一段已经是目标语言了」要走共用判定',
  );

  // 而且喂进去的得是整码。detectReliableLanguage 一旦把 zh-TW 削成 zh，
  // 上面那一句比的就又是基码了——实现换掉了，缺陷还在。
  assert.match(
    repoFile('content/page/batch.js'),
    /return topLang\.language \|\| null;/,
    'detectReliableLanguage 要交出整码，削成基码等于把缺陷搬了个家',
  );
});
