// 输入框上那颗「译成 X」芯片（PRD FR-8，写回见 D-352）。
//
// 点下去，译文直接写回那个框：多行的框在原文后换一行接上，单行的框整段换掉，
// 一步撤回。这里守的是源码这一层能守住的性质 —— 写只有一条路、点击才译、判不准
// 就不出声 —— 外加写回模块在 Node 里对着一个假 DOM 跑的行为。「真的写进了
// Draft/Lexical 那类编辑器的模型」是旅程，归 test/e2e/input-chip.spec.js。
import test from 'node:test';
import assert from 'node:assert/strict';
import { contentBundle, contentCss, engineSource, inputChipSource, messageCatalog, repoSource } from './helpers/sources.mjs';

const read = repoSource;
const strip = (source) => source
  .replace(/^[ \t]*\/\/.*$/gm, '')
  .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '');

const CHIP = strip(inputChipSource());
const CHIP_ONLY = strip(read('content/content-input-chip.js'));
const WRITEBACK = strip(read('content/content-input-writeback.js'));
const ENGINE = strip(engineSource());

test('芯片和写回模块装进了 manifest，写回排在芯片前面，也接进了初始化链', () => {
  const bundle = contentBundle();
  const chipAt = bundle.indexOf('content/content-input-chip.js');
  const writebackAt = bundle.indexOf('content/content-input-writeback.js');
  assert.ok(chipAt >= 0, 'content/content-input-chip.js 没装进内容脚本');
  assert.ok(writebackAt >= 0, 'content/content-input-writeback.js 没装进内容脚本');
  assert.ok(writebackAt < chipAt, '写回模块排在了芯片后面');
  assert.match(strip(read('content/content-bootstrap.js')),
    /ctx\.setupInputTranslateChip\(\)/,
    'ctx.init 里没人叫醒这颗芯片，它永远不会出现');
});

// 写只有一条路：写回模块。芯片自己一个字都不往框里写，写回模块也只递 paste 给
// 编辑器、或者用浏览器的编辑命令，从不直接改 DOM —— 直接改的字会被 Draft、
// Lexical 下一次重画抹掉，发帖时模型里也没有。合成 beforeinput 和原生 value setter
// 那两条旧路（c5d37ea）在 D-357 删掉了，不许回来。
test('写只有一条路：芯片交给写回模块，写回模块不直接改 DOM', () => {
  // 芯片给自己那颗节点写字（chip.textContent）不算。
  const chipWrites = CHIP_ONLY.match(/(?<!\bchip)\.\s*(value|innerText|textContent|innerHTML|outerHTML)\s*=[^=]/g);
  assert.equal(chipWrites, null, `芯片自己写了输入框：${chipWrites}`);
  assert.ok(!/execCommand|insertText|setRangeText/.test(CHIP_ONLY), '芯片绕过写回模块往编辑区里插内容');
  assert.match(CHIP_ONLY, /ctx\.inputWriteback\.write\(field, response\.translation\)/,
    '芯片没把译文交给写回模块');

  const direct = WRITEBACK.match(/\.\s*(value|innerText|textContent|innerHTML|outerHTML)\s*=[^=]|insertAdjacent|appendChild|\.append\(|replaceChildren|setRangeText/g);
  assert.equal(direct, null, `写回模块直接改了 DOM：${direct}`);
  assert.match(WRITEBACK, /document\.execCommand\('insertText', false, data\)/);
  assert.match(WRITEBACK, /new ClipboardEvent\('paste', \{/);
  assert.ok(!/new InputEvent|getOwnPropertyDescriptor/.test(WRITEBACK),
    '写回模块又在合成 beforeinput / input，或者绕过编辑命令用 value setter');
});

test('不替用户提交：不发 Enter、不发 submit、不挪焦点', () => {
  assert.ok(!/KeyboardEvent|requestSubmit|\.submit\(|\.focus\(|\.blur\(/.test(CHIP),
    '芯片或写回模块里出现了按键、提交或挪焦点');
});

test('点击才译：翻译请求只在点击处理里发，而且声明是独立文字', () => {
  const calls = CHIP.match(/ctx\.requestTranslation\(/g) || [];
  assert.equal(calls.length, 1, `芯片发翻译请求的地方有 ${calls.length} 处`);
  const click = CHIP_ONLY.slice(CHIP_ONLY.indexOf('async function onChipClick('));
  const body = click.slice(0, click.indexOf('\n  function onFocusIn('));
  assert.match(body, /ctx\.requestTranslation\(\{[\s\S]*type: 'TRANSLATE'[\s\S]*mode: 'text'[\s\S]*standaloneText: true[\s\S]*\}\)/,
    '请求不在点击处理里，或者没声明 standaloneText');
  assert.ok(!/showInputTranslateDialog/.test(CHIP), '芯片还在开对话框');
});

// 译文回来时的核对（同一请求、字没变、焦点还在、不在组合里）、shadow root 里的框、
// 只发 beforeinput 的模型编辑器，都由跑着的测试问：input-chip-behaviour.test.mjs 和
// test/e2e/input-chip.spec.js（Lexical / open shadow root / 译文回来之前字变了）。

test('芯片的三种状态用的是现成的文案', () => {
  assert.match(CHIP_ONLY, /t\(state === 'busy' \? 'translating' : 'translationFailed'\)/);
  const css = contentCss();
  assert.match(css, /#ai-translator-input-chip\[data-state="busy"\]/);
  assert.match(css, /#ai-translator-input-chip\[data-state="error"\]/);
  const catalog = messageCatalog();
  for (const tag of Object.keys(catalog)) {
    assert.ok(catalog[tag].translating, `${tag} 没有 translating`);
    assert.ok(catalog[tag].translationFailed, `${tag} 没有 translationFailed`);
  }
});

// 语言判断的两档门槛（非拉丁两字、拉丁八字且要 isReliable）只能有一份。两处各写
// 一遍的结果不是「两份一样的代码」，是同一段文字在两个地方得到两个答案。
test('判语言只有一个主人', () => {
  assert.ok(!/chrome\.i18n\.detectLanguage/.test(CHIP),
    '芯片自己调了检测器，门槛就有了第二份');
  assert.match(CHIP, /ctx\.builtinTranslator\?\.detectStandaloneLang/,
    '芯片没走引擎导出的那一份判断');
  assert.match(ENGINE, /function detectStandaloneLang\(/, '引擎里没有 detectStandaloneLang');
  assert.match(ENGINE, /detectStandaloneLang: \(text\) => eng\.detectStandaloneLang\(text\),/,
    'detectStandaloneLang 没挂上 builtinTranslator');
  const thresholds = ENGINE.match(/minChars: nonLatinText \? 2 : DETECT_MIN_CHARS/g) || [];
  assert.equal(thresholds.length, 1, '那两档门槛被写了不止一遍');
});

test('判不准就不出声：空答案和同语言都不画芯片', () => {
  assert.match(CHIP, /if \(!inputLang \|\| ctx\.isSameLanguage\(inputLang, page\.pageLang\)\)/,
    '芯片没有在「判不出来」和「本来就是这一页的语言」两种情况下闭嘴');
});

// normalizeTargetLang 对认不出的语言一律回落 'en'。不回头核对，一个瑞典语页面
// 就会长出一颗「译成 English」的芯片 —— 一个我们根本没打算提供的方向。
test('页面语言不在我们能译的十种里，就没有芯片', () => {
  assert.match(CHIP, /if \(!ctx\.isSameLanguage\(target, pageLang\)\) return null;/,
    '芯片没核对 normalizeTargetLang 的回落');
});

test('页面语言取引擎那一份缓存，不另开一份', () => {
  assert.ok(!/document\.body\.innerText/.test(CHIP), '芯片自己又判了一遍整页语言');
  assert.match(CHIP, /ctx\.builtinTranslator\?\.pageSourceLang\?\.\(\)/);
});

// 密码、邮箱、网址、电话、数字框里的内容没有语言可言，一颗「译成英语」挂在密码
// 框边上只会吓人。所以这里是**白名单**，不是黑名单：新出现的 input type 默认不长
// 芯片，而不是默认长。
test('只在写「话」的框上出现，而且是白名单', () => {
  const list = CHIP.match(/const TEXTUAL_INPUT_TYPES = new Set\(\[([^\]]*)\]\)/);
  assert.ok(list, '没有可认的输入类型白名单');
  const types = list[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
  assert.deepEqual(types.sort(), ['search', 'text']);
  assert.match(CHIP, /el\.disabled \|\| el\.readOnly/, '只读和禁用的框也长了芯片');
});

test('芯片不长在我们自己的面板上', () => {
  assert.match(CHIP, /\[id\^="ai-translator"\]/,
    '芯片会长在我们自己的对话框的输入区旁边');
});

// 芯片是我们挂进宿主页面的又一个根节点，页面那条 `div { opacity: .8 }` 照样打得
// 到它。新根节点没进复位清单，是这套样式最容易漏的一步。
test('芯片进了宿主页容纳复位的清单', () => {
  const css = contentCss();
  const reset = css.slice(css.indexOf('==================== Host-page containment'));
  assert.ok(reset.includes('[id="ai-translator-input-chip"]'),
    '芯片的根节点没加进容纳复位的 :is() 清单');
  assert.match(css, /#ai-translator-input-chip \{/, '芯片没有自己的样式');
});

// getMessage 不支持占位符，整个代码库的约定是 t(key).replace('{x}', …)。哪一门
// 语言的串里漏掉 {lang}，那门语言下的芯片就是一句不说语言的「译成」。
test('十门语言的芯片文案都留着 {lang}', () => {
  const catalog = messageCatalog();
  const tags = Object.keys(catalog);
  assert.ok(tags.length >= 10, `只有 ${tags.length} 门语言`);
  for (const tag of tags) {
    const value = catalog[tag].inputChipTranslateTo;
    assert.ok(value, `${tag} 没有 inputChipTranslateTo`);
    assert.ok(value.includes('{lang}'), `${tag} 的 inputChipTranslateTo 漏了 {lang}：${value}`);
  }
  assert.match(CHIP, /t\('inputChipTranslateTo'\)\.replace\('\{lang\}'/);
});

test('开关关掉时，正显示的那一颗立刻被收走', () => {
  assert.match(CHIP, /ctx\.hideInputTranslateChip = hideChip;/);
  assert.match(strip(read('content/content-bootstrap.js')),
    /changes\.showInputTranslateChip[\s\S]{0,200}ctx\.hideInputTranslateChip\(\)/);
});

// 芯片不再开对话框，对话框又回到只有悬浮球菜单一个调用方、不接参数。
test('对话框只剩悬浮球一个入口，不再接芯片带来的文字', () => {
  const dialog = strip(read('content/content-input-dialog.js'));
  assert.match(dialog, /function showInputTranslateDialog\(\) \{/);
  assert.ok(!/initialText|options\.targetLang/.test(dialog), '对话框里还留着芯片那条入口');
});

// 繁体页面上的「译成中文」不能译成简体 —— 那正好是用户要的转换反过来做一遍。
test('zh-Hant 归一到繁体，不是简体', async () => {
  // 真的把 shared/ 那两份装进来，不塞替身：这一条要证的就是内容脚本这一侧和
  // 别的界面读的是同一个答案，而替身正好会把那件事盖掉。
  await import('../../shared/lang-tags.js');
  await import('../../shared/target-lang.js');
  const ctx = { escapeHtml: (s) => s };
  const stub = {
    AI_TRANSLATOR_CONTENT: ctx,
    TargetLang: globalThis.TargetLang,
    LangTags: globalThis.LangTags,
  };
  const source = read('content/content-language.js');
  new Function('window', 'globalThis', 'TargetLang', 'LangTags', `
    const self = window;
    ${source}
  `)(stub, stub, stub.TargetLang, stub.LangTags);
  assert.equal(ctx.normalizeTargetLang('zh-Hant'), 'zh-TW');
  assert.equal(ctx.normalizeTargetLang('zh-HK'), 'zh-TW');
  assert.equal(ctx.normalizeTargetLang('zh-Hans'), 'zh-CN');
  // 76 门之内的语言原样保留；只有不在表上的才落到英文。
  assert.equal(ctx.normalizeTargetLang('sv'), 'sv');
  assert.equal(ctx.normalizeTargetLang('xh'), 'en');
});
