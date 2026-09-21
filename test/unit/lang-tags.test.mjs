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
    'content/content-translation-engine.js',
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

  // 而且喂进去的得是**补过书写系统的**整码。只要这里退回 topLang.language，
  // 中文那一侧就永远是个 zh，上面那一句又会答「本来就是你的语言」——实现换掉
  // 了，缺陷还在。
  assert.match(
    repoFile('content/page/batch.js'),
    /return refineScriptTag\(topLang\.language, detectText\) \|\| null;/,
    'detectReliableLanguage 要交出补过简繁的整码',
  );

  // 第四条路：内置引擎自己判源语言。上游的闸门放行了不等于译得出来——引擎在
  // 下游又问了一次「这段文字是什么语言」，问到的要是个光秃秃的 zh，它自己的
  // 「源语言等于目标语言就原样返回」那一档照样会把整页吃掉。
  assert.match(
    repoFile('content/content-translation-engine.js'),
    /return LangTags\.refineScript\(top\.language, sample\);/,
    'detectLanguageOf 要交出补过简繁的整码',
  );
});

test('简繁只能从字里数：检测器对两套字都只答 zh', () => {
  // 这不是猜的。真实 Chrome（e2e 里的那一个）对下面这两段都回答
  // {language:'zh', percentage:100, isReliable:true}，一个子标签都不给。
  // 所以标签这条路到此为止，剩下的只能看字。
  assert.equal(L.detectHanScript('這是一段繁體中文的文字，用來測試偵測器。'), 'hant');
  assert.equal(L.detectHanScript('这是一段简体中文的文字，用来测试检测器。'), 'hans');

  // 一个字也作数：表里每个字都只在一侧存在。
  assert.equal(L.detectHanScript('東'), 'hant');
  assert.equal(L.detectHanScript('东'), 'hans');

  // 两侧都没有、或者数目相等，就是「看不出来」。
  assert.equal(L.detectHanScript('Hello world'), '');
  assert.equal(L.detectHanScript('天山日月'), '');   // 简繁同形，分不出
  assert.equal(L.detectHanScript('東东'), '');
  assert.equal(L.detectHanScript(''), '');

  // 混着两套字的时候按多数派：繁体站引一段简体原文，这一页仍然是繁体的。
  assert.equal(L.detectHanScript('這個網站說：「这个」，後面還有很多繁體的字。'), 'hant');
});

test('陷阱字不能进表：后、几、台、里在繁体文本里也是合法的字', () => {
  // 这四个的简体一侧在繁体里本来就用（皇后、茶几、台北、公里）。收了它们，
  // 一页繁体正文只要出现一次「台灣的公里數」，就会被数成简体。
  for (const ch of ['后', '几', '台', '里', '干', '只', '面', '松', '丑', '表']) {
    assert.equal(L.detectHanScript(ch), '', `${ch} 不该被当成简繁的证据`);
  }
});

test('补书写系统是补充，不是改写', () => {
  assert.equal(L.refineScript('zh', '這是繁體'), 'zh-Hant');
  assert.equal(L.refineScript('zh', '这是简体'), 'zh-Hans');

  // 标签自己说了的，压过数出来的——哪怕数出来的相反。
  assert.equal(L.refineScript('zh-TW', '这是简体'), 'zh-TW');
  assert.equal(L.refineScript('zh-CN', '這是繁體'), 'zh-CN');

  // 看不出来就原样留着 zh，别编一个出来。
  assert.equal(L.refineScript('zh', '天山日月'), 'zh');
  // 别的语言不碰。
  assert.equal(L.refineScript('en', '这是简体'), 'en');
  assert.equal(L.refineScript('', '这'), '');
  assert.equal(L.refineScript(null, '这'), null);

  // 补完才接得上那一问：繁体的一页配简体的目标，不是同一门语言。
  assert.equal(L.isSameLanguage(L.refineScript('zh', '這是繁體的一段話'), 'zh-CN'), false);
  assert.equal(L.isSameLanguage(L.refineScript('zh', '这是简体的一段话'), 'zh-CN'), true);
  // 补不出来时回到那条花钱的闸：宁可算同语言，不替用户买一次多半没变的翻译。
  assert.equal(L.isSameLanguage(L.refineScript('zh', '天山日月'), 'zh-CN'), true);
});

test('简繁对照表两侧一一对应，且没有一个字站两边', () => {
  // 表是写成一条长字符串的，偶数位简体、奇数位繁体。错开一个字，整张表就从
  // 那里起全反了，而症状是「某些页面翻反了」——没有报错。
  const src = repoFile('shared/lang-tags.js');
  const pairs = /const HAN_PAIRS = '([^']+)'/.exec(src);
  assert.ok(pairs, '表还在吗');
  const table = pairs[1];
  assert.equal(table.length % 2, 0, '长度是奇数：有一对只写了一半');

  const hans = new Set();
  const hant = new Set();
  for (let i = 0; i < table.length; i += 2) {
    hans.add(table[i]);
    hant.add(table[i + 1]);
    assert.notEqual(table[i], table[i + 1], `${table[i]} 和自己配了对`);
  }
  assert.equal(hans.size * 2, table.length, '简体一侧有重复');
  assert.equal(hant.size * 2, table.length, '繁体一侧有重复');
  for (const ch of hans) assert.ok(!hant.has(ch), `${ch} 同时站在两侧`);
});
