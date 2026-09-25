// 输入框上那颗「译成 X」芯片（PRD FR-8）。
//
// 这颗芯片贴在用户正在写字的框旁边，所以它最要紧的三条性质都是「它**不**做什么」：
// 不改写输入、不在点击前发请求、判不准就不出声。三条都能在源码这一层守住，而
// 「点下去之后真的能译」那一半是旅程，归 test/e2e/input-chip.spec.js。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { contentBundle, contentCss, engineSource, messageCatalog } from './helpers/sources.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
const strip = (source) => source
  .replace(/^[ \t]*\/\/.*$/gm, '')
  .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '');

const CHIP = strip(read('content/content-input-chip.js'));
const ENGINE = strip(engineSource());

test('芯片装进了 manifest，也接进了初始化链', () => {
  assert.ok(contentBundle().includes('content/content-input-chip.js'),
    'content/content-input-chip.js 没装进内容脚本');
  assert.match(strip(read('content/content-bootstrap.js')),
    /ctx\.setupInputTranslateChip\(\)/,
    'ctx.init 里没人叫醒这颗芯片，它永远不会出现');
});

// FR-8 的那一句：**永不自动改写用户输入。**
//
// 这是整颗芯片唯一不能出错的地方 —— 用户正在写的东西被替换掉，是这个扩展能对
// 一个人做的最糟的事。所以这里不问「有没有 bug」，问的是「有没有那一类语句」。
test('芯片不往用户的输入框里写任何东西', () => {
  const writes = CHIP.match(/\b(field|el|chipField)\s*\.\s*(value|innerText|textContent|innerHTML)\s*=/g);
  assert.equal(writes, null, `芯片写了输入框：${writes}`);
  assert.ok(!/execCommand|insertText/.test(CHIP), '芯片在往编辑区里插内容');
});

test('点击前不发请求：语言判断走本地的 detectLanguage，翻译只由点击触发', () => {
  // 芯片自己不调翻译，它只是把文字交给对话框 —— 对话框是用户看得见、还能改目标
  // 语言的那一层。少了这一跳，点一下就等于直接花钱。
  assert.ok(!/requestTranslation|translateText/.test(CHIP),
    '芯片自己发起了翻译，那就不是「点击才译」而是「点击就扣钱」');
  assert.match(CHIP, /ctx\.showInputTranslateDialog\(\s*\{\s*text,\s*targetLang\s*\}\s*\)/,
    '芯片没有把文字和目标语言一起交给对话框');
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

// 对话框原本不接参数，只有悬浮球菜单一个调用方。芯片给它加了第二个入口，而那
// 个入口带着一次性的目标语言 —— 它不能变成「以后都往这边译」。
test('芯片给的目标语言只算这一次，不写进对话框的记忆', () => {
  const dialog = strip(read('content/content-input-dialog.js'));
  assert.match(dialog, /function showInputTranslateDialog\(options = \{\}\)/);
  assert.match(dialog, /const initialLang = options\.targetLang/);
  const remembers = dialog.match(/rememberTargetLang\(/g) || [];
  // 定义一次，设置变化时清一次，用户在下拉里亲手挑时记一次。没有第四次。
  assert.equal(remembers.length, 3, `rememberTargetLang 被调用了 ${remembers.length} 次`);
  assert.ok(!/rememberTargetLang\(initialLang\)/.test(dialog),
    '芯片带来的目标语言被记成了默认值');
});

test('带着文字进来的那一次，不用再按一次「翻译」', () => {
  const dialog = strip(read('content/content-input-dialog.js'));
  assert.match(dialog, /if \(initialText\) translateInputText\(initialLang\);/);
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
