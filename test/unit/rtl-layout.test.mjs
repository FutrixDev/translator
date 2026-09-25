// 从右往左的四门目标语言（ar fa he ur）落到页面上时的几件纯事：译文带自己的
// lang/dir、对齐跟着方向走、图标缩进和行内间隙开在原文的起始边、76 项的菜单打开时
// 已选项在可见区里。
//
// 函数本身都在 content/content-language.js 和 content/page/collect.js，这里把两份
// 真文件装进一个假 window 里跑，不塞替身：要证的就是扩展里那一份的行为。
// 页面上的整条旅程归 test/e2e/rtl-*.spec.js。
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');

await import('../../shared/lang-tags.js');
await import('../../shared/target-lang.js');

// 一个元素的替身：只有 getComputedStyle 和 style.setProperty 两件事被读写。
function fakeElement(computed = {}) {
  const written = {};
  return {
    computed,
    written,
    style: {
      setProperty(name, value, priority) { written[name] = { value, priority }; },
    },
  };
}

function loadLanguageHelpers({ getTextInset } = {}) {
  const ctx = { escapeHtml: (s) => s, getTextInset };
  const win = {
    AI_TRANSLATOR_CONTENT: ctx,
    getComputedStyle: (el) => el.computed,
  };
  new Function('window', 'globalThis', 'TargetLang', 'LangTags', read('content/content-language.js'))(
    win, { LangTags: globalThis.LangTags }, globalThis.TargetLang, globalThis.LangTags);
  return ctx;
}

const ctx = loadLanguageHelpers();

test('markLanguage writes both lang and dir, and writes ltr out loud', () => {
  const ar = {};
  ctx.markLanguage(ar, 'ar');
  assert.deepEqual(ar, { lang: 'ar', dir: 'rtl' });
  // LTR 也要明写：译文挂在方向相反的原文里时，靠继承就继承到了原文的方向。
  const en = {};
  ctx.markLanguage(en, 'en');
  assert.deepEqual(en, { lang: 'en', dir: 'ltr' });
  for (const code of ['fa', 'he', 'ur']) {
    const el = {};
    ctx.markLanguage(el, code);
    assert.equal(el.dir, 'rtl', code);
  }
  const zh = {};
  ctx.markLanguage(zh, 'zh-TW');
  assert.deepEqual(zh, { lang: 'zh-TW', dir: 'ltr' });
});

test('startSide is the side the source text starts from', () => {
  assert.equal(ctx.startSide({ direction: 'ltr' }), 'left');
  assert.equal(ctx.startSide({ direction: 'rtl' }), 'right');
});

test('translationTextAlign: same direction copies, opposite direction keeps only center and justify', () => {
  const ALIGNS = ['left', 'right', 'start', 'end', 'center', 'justify'];
  const OPPOSITE = { left: 'start', right: 'start', start: 'start', end: 'start', center: 'center', justify: 'justify' };
  for (const [source, target] of [['ltr', 'ltr'], ['rtl', 'rtl'], ['ltr', 'rtl'], ['rtl', 'ltr']]) {
    for (const align of ALIGNS) {
      const got = ctx.translationTextAlign({ direction: source, textAlign: align }, target);
      const want = source === target ? align : OPPOSITE[align];
      assert.equal(got, want, `${source} ${align} -> ${target}`);
    }
  }
  // Chrome 把 <center> 和 align=center 算成 -webkit-center。
  assert.equal(ctx.translationTextAlign({ direction: 'ltr', textAlign: '-webkit-center' }, 'rtl'), 'center');
});

test('applyTextInset pads the source start side, with !important, and only when there is an inset', () => {
  const calls = [];
  let inset = 24;
  const withInset = loadLanguageHelpers({
    getTextInset: (el, options) => { calls.push({ el, options }); return inset; },
  });

  const rtlSource = fakeElement({ direction: 'rtl' });
  const translation = fakeElement();
  withInset.applyTextInset(translation, rtlSource, { fromContentBox: true });
  assert.deepEqual(translation.written, { 'padding-right': { value: '24px', priority: 'important' } });
  assert.deepEqual(calls[0], { el: rtlSource, options: { fromContentBox: true } });

  const ltrSource = fakeElement({ direction: 'ltr' });
  const ltrTranslation = fakeElement();
  withInset.applyTextInset(ltrTranslation, ltrSource, { fromContentBox: false });
  assert.deepEqual(ltrTranslation.written, { 'padding-left': { value: '24px', priority: 'important' } });

  inset = 0;
  const none = fakeElement();
  withInset.applyTextInset(none, ltrSource, {});
  assert.deepEqual(none.written, {});
});

// ==================== getTextInset（collect.js） ====================

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

function loadGetTextInset() {
  const shelf = { constants: { MATH_CONTAINER_SELECTOR: '.math' } };
  const win = {
    AI_TRANSLATOR_CONTENT: shelf,
    getComputedStyle: (el) => el.computed,
  };
  const doc = {
    createRange() {
      return {
        selectNodeContents(node) { this.node = node; },
        getClientRects() { return [this.node.rect]; },
      };
    },
  };
  new Function('window', 'Node', 'document', read('content/page/collect.js'))(
    win, { TEXT_NODE, ELEMENT_NODE }, doc);
  return shelf.getTextInset;
}

const getTextInset = loadGetTextInset();

// 一个 left..right 的块，里面一段文字占 textLeft..textRight。
function block({ direction, left = 100, right = 500, textLeft, textRight, padding = {}, border = {} }) {
  return {
    getBoundingClientRect: () => ({ left, right, width: right - left }),
    computed: {
      direction,
      paddingLeft: `${padding.left || 0}px`,
      paddingRight: `${padding.right || 0}px`,
      borderLeftWidth: `${border.left || 0}px`,
      borderRightWidth: `${border.right || 0}px`,
    },
    childNodes: [{ nodeType: TEXT_NODE, textContent: 'text', rect: { left: textLeft, right: textRight } }],
  };
}

test('getTextInset measures an LTR block from its left edge', () => {
  const el = block({ direction: 'ltr', textLeft: 130, textRight: 480, padding: { left: 10 }, border: { left: 2 } });
  assert.equal(getTextInset(el), 30);
  assert.equal(getTextInset(el, { fromContentBox: true }), 18);
});

test('getTextInset measures an RTL block from its right edge', () => {
  // 左边的 padding 放大到 50：RTL 下它不该参与任何计算。
  const el = block({
    direction: 'rtl', textLeft: 150, textRight: 460,
    padding: { left: 50, right: 10 }, border: { left: 7, right: 2 },
  });
  assert.equal(getTextInset(el), 40);
  assert.equal(getTextInset(el, { fromContentBox: true }), 28);
});

test('getTextInset never answers a negative inset', () => {
  const el = block({ direction: 'rtl', textLeft: 150, textRight: 520 });
  assert.equal(getTextInset(el), 0);
});

// ==================== revealSelectedLanguage ====================

test('revealSelectedLanguage centres the selected item by moving only the menu', () => {
  let scrolledIntoView = false;
  const item = {
    getBoundingClientRect: () => ({ top: 900, height: 36 }),
    scrollIntoView() { scrolledIntoView = true; },
  };
  const menu = {
    scrollTop: 0,
    clientTop: 1,
    clientHeight: 260,
    querySelector: (selector) => (selector === '.is-selected' ? item : null),
    getBoundingClientRect: () => ({ top: 200 }),
  };
  ctx.revealSelectedLanguage(menu);
  // 项的顶边离菜单内容区顶边 699，再往回让出 (260 - 36) / 2 = 112，项就落在中间。
  assert.equal(menu.scrollTop, 699 - 112);
  assert.equal(scrolledIntoView, false, 'scrollIntoView also scrolls the host page');
});

test('revealSelectedLanguage leaves a menu with nothing selected alone', () => {
  const menu = { scrollTop: 40, querySelector: () => null };
  ctx.revealSelectedLanguage(menu);
  assert.equal(menu.scrollTop, 40);
});

// ==================== 每个落笔口都要知道译文是哪门语言 ====================

// 缺 textLang 就抛：一段不知道自己是哪门语言的译文只能靠继承拿到原文的 lang/dir，
// 在 RTL 页里就是一段方向错的中文，或者 LTR 页里一段方向错的阿拉伯语。静默兜底成
// 界面语言或英文会把这个错藏起来。
test('every place a translation lands requires the language of its text', () => {
  const insert = read('content/page/insert.js');
  assert.match(insert, /function insertTranslationBlock\(block, translation, \{ lang = null, textLang \} = \{\}\) \{\s*\n\s*if \(!textLang\) throw /);
  // 四种有节点的形态都经 finishTranslationInsert 打标，每一处都把 textLang 带进去。
  const finishes = insert.match(/finishTranslationInsert\([^)]*\);/g) || [];
  assert.equal(finishes.length, 4);
  for (const call of finishes) assert.match(call, /, textLang\);$/, call);
  assert.match(insert, /function finishTranslationInsert\([^)]*\) \{\s*\n[^\n]*\n\s*ctx\.markLanguage\(translationEl, textLang\);/);

  const managed = read('content/content-managed-translation.js');
  assert.match(managed, /if \(!textLang\) throw new Error\('renderManagedTranslation: textLang is required'\)/);
  assert.match(managed, /direction:\$\{layout\.dir\};unicode-bidi:isolate;/);

  // 悬停/划词：加载态和错误按界面语言打标，译文必须说出自己的语言。
  const render = read('content/hover/render.js');
  assert.match(render, /function textLangOf\(options\) \{\s*\n\s*if \(options\.loading \|\| options\.isError\) return ctx\.uiLanguage\(\);\s*\n\s*if \(!options\.textLang\) throw /);
});

// 划词卡和输入框对话框共用 content-popup.js 的语言下拉：打开时滚到已选项这一行在
// 那里，两处一起覆盖。卡片译文每次结算都按这次的目标语言打标，对齐取 start —— 不写
// 就继承宿主页面的 text-align，一段希伯来语会被 `body { text-align: left }` 压到左边。
// 整条旅程（几何、换语言后标记跟着变）在 test/e2e/target-languages.spec.js 的 J-B8/J-B9。
test('the card reveals the selected language and marks its translation', () => {
  const popup = read('content/content-popup.js');
  assert.match(popup, /const openMenu = \(\) => \{\s*\n\s*if \(!menu\.hidden\) return;\s*\n\s*menu\.hidden = false;\s*\n\s*ctx\.revealSelectedLanguage\(menu\);/);
  assert.match(popup, /parts\.text\.textContent = response\.translation \|\| '';[\s\S]{0,200}ctx\.markLanguage\(parts\.text, targetLang\);/);
  const css = read('content/css/popup.css');
  const rule = css.match(/\n\.ai-translator-translation-text \{[^}]*\}/);
  assert.ok(rule, '.ai-translator-translation-text rule not found');
  assert.match(rule[0], /text-align: start;/);
});
