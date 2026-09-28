// 用户站点规则在收块里的两处落点（P1-B 设计 §3.3）：
//   - 行内：exclude 命中的元素整个不读、不送；keepOriginal 命中的元素当占位符原样
//     带回（getTextWithMathPlaceholders 的 exclude / keep 两个选项，只有整页收块传）；
//   - 块级：keepOriginal 命中整块就不收，排在作者声明 translate="yes" 之前，所以它连
//     重新打开的子树一起关掉。块级这一条的行为由 e2e J-2（`.code-name` 带
//     translate="yes"）走一遍，这里钉住先后顺序。
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoFile = (rel) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');

globalThis.Node = { ELEMENT_NODE: 1, TEXT_NODE: 3 };
globalThis.window = {
  AI_TRANSLATOR_CONTENT: {
    constants: { MATH_CONTAINER_SELECTOR: '.katex' },
    settings: {},
    state: {},
    t: (key) => key,
  },
  getComputedStyle: () => ({ display: 'inline' }),
};
globalThis.document = {};
globalThis.chrome = {};

await import('../../shared/block-identity.js');
// 收集、落笔、比对原文都在调用时读 globalThis.TextMarkers（占位符与标记的语法）。
await import('../../shared/text-markers.js');
await import('../../shared/lang-tags.js');
await import('../../shared/site-rules-builtin.js');
await import('../../shared/storage-writer.js');
await import('../../shared/site-rules.js');
await import('../../content/page/custom-rule.js');
await import('../../content/page/shadow.js');
await import('../../content/page/notranslate.js');
await import('../../content/page/scope.js');
await import('../../content/page/collect.js');

const ctx = globalThis.window.AI_TRANSLATOR_CONTENT;

// 只认「.类名」和逗号并起来的几条 —— 规则选择器在这里就是这个形状。
function el(tag, classes, children) {
  const classSet = new Set(classes);
  const node = {
    nodeType: 1,
    tagName: tag,
    localName: tag.toLowerCase(),
    childNodes: children,
    classList: { contains: (c) => classSet.has(c), [Symbol.iterator]: () => classSet.values() },
    getAttribute: (name) => (name === 'class' && classSet.size ? [...classSet].join(' ') : null),
    hasAttribute: () => false,
    matches: (selector) => selector.split(',').some((one) => classSet.has(one.trim().replace(/^\./, ''))),
    closest: () => null,
    getRootNode: () => globalThis.document,
  };
  return node;
}
const text = (data) => ({ nodeType: 3, textContent: data });

function paragraph() {
  const brand = el('SPAN', ['brand'], [text('BrandX')]);
  const votes = el('SPAN', ['votes'], [text('12 points')]);
  const p = el('P', [], [text('Buy '), brand, text(' today '), votes]);
  return { p, brand, votes };
}

test('page collection: an inline exclude is dropped, an inline keepOriginal travels as a placeholder', () => {
  const { p, brand } = paragraph();
  const out = ctx.getTextWithMathPlaceholders(p, { preserveMarkup: true, exclude: '.votes', keep: '.brand' });
  assert.equal(out.text, 'Buy {{1}} today');
  assert.equal(out.mathElements.length, 1);
  assert.equal(out.mathElements[0].type, 'element');
  assert.equal(out.mathElements[0].element, brand, 'the kept element is cloned back as it is');
  assert.doesNotMatch(out.text, /12 points|BrandX/);
});

test('without the rule selectors (hover, selection) both inline elements are read as usual', () => {
  const { p } = paragraph();
  const out = ctx.getTextWithMathPlaceholders(p, { preserveMarkup: true });
  assert.match(out.text, /BrandX/);
  assert.match(out.text, /12 points/);
  assert.equal(out.mathElements.length, 0);
});

test('a block keepOriginal is checked before the author translate="yes" can reopen it', () => {
  const source = repoFile('content/page/collect.js');
  const body = source.slice(source.indexOf('    function processElement(element) {'));
  const rule = body.indexOf('if (ruleBlocksElement(element, adapter)) return;');
  const judge = body.indexOf('if (!allowed(element)) {');
  assert.ok(rule > 0, 'the block rule check moved');
  assert.ok(judge > rule, 'translate="yes" is judged before the keepOriginal rule');
  // 谓词里先 exclude 后保留原文。
  const predicate = source.slice(source.indexOf('  function ruleBlocksElement(el, adapter) {'));
  const exclude = predicate.indexOf('closestAcross(el, adapter.exclude)');
  const keep = predicate.indexOf('closestAcross(el, adapter.keepOriginal)');
  assert.ok(exclude > 0 && keep > exclude, 'exclude is judged before keepOriginal');
  // 整页收块把两串选择器都交给行内读法。
  assert.match(source, /const textOptions = \{ preserveMarkup: true, exclude: excludeSelector, keep: keepSelector \};/);
});

// ---------------------------------------------------------------- 块级「不翻」只有一份判法（F10）

// 收块和清扫共用 ruleBlocksElement；清扫（ctx.ruleForbids）另外再问 include 范围。
// 一棵带父指针的小树：closest / contains 顺着 parent 走，getRootNode 回 document。
function tree() {
  const make = (classes, parent) => {
    const node = el('DIV', classes, []);
    node.parent = parent;
    node.closest = (selector) => {
      for (let at = node; at; at = at.parent) if (at.matches(selector)) return at;
      return null;
    };
    node.contains = (other) => {
      for (let at = other; at; at = at.parent) if (at === node) return true;
      return false;
    };
    return node;
  };
  const body = make([], null);
  const main = make(['main'], body);
  const promo = make(['promo'], main);
  const promoLine = make([], promo);
  const byline = make(['byline'], main);
  const bylineName = make([], byline);
  const para = make([], main);
  const side = make(['side'], body);
  return { body, main, promo, promoLine, byline, bylineName, para, side };
}

function forbids(el, { adapter, scope }) {
  const previous = ctx.resolveSiteAdapter;
  ctx.resolveSiteAdapter = () => adapter;
  try {
    return ctx.ruleForbids(el, scope);
  } finally {
    ctx.resolveSiteAdapter = previous;
  }
}

test('ruleForbids: an element under the exclude selector is forbidden', () => {
  const t = tree();
  const adapter = { atomic: '', exclude: '.promo', keepOriginal: '' };
  assert.equal(forbids(t.promoLine, { adapter, scope: null }), true);
  assert.equal(forbids(t.para, { adapter, scope: null }), false);
});

test('ruleForbids: an element under the keepOriginal selector is forbidden', () => {
  const t = tree();
  const adapter = { atomic: '', exclude: '.promo', keepOriginal: '.byline' };
  assert.equal(forbids(t.bylineName, { adapter, scope: null }), true);
  assert.equal(forbids(t.byline, { adapter, scope: null }), true);
});

test('ruleForbids: an element outside the include scope is forbidden', () => {
  const t = tree();
  const scope = { mode: 'include', roots: [t.main] };
  assert.equal(forbids(t.side, { adapter: null, scope }), true);
  assert.equal(forbids(t.para, { adapter: null, scope }), false);
});

test('ruleForbids: none of the three answers false', () => {
  const t = tree();
  const adapter = { atomic: '', exclude: '.promo', keepOriginal: '.byline' };
  const scope = { mode: 'include', roots: [t.main] };
  assert.equal(forbids(t.para, { adapter, scope }), false);
  assert.equal(forbids(t.para, { adapter: null, scope: null }), false);
});

// ---------------------------------------------------------------- 原样占位符不算公式（RJ-5）

// translate="no" 与「保留原文」的占位符和公式同一种形状（{type: 'element'}），只多一个
// verbatim。插入层、悬停层按 hasRealMath 决定样式：只有原样元素时译文照样套原文排版。
test('placeholder entries: translate="no" and keepOriginal are verbatim, math and LaTeX text are not', () => {
  const noTranslate = el('SPAN', [], [text('Acme')]);
  noTranslate.getAttribute = (name) => (name === 'translate' ? 'no' : null);
  const brand = el('SPAN', ['brand'], [text('BrandX')]);
  const math = el('MATH', [], [text('x')]);
  const p = el('P', [], [
    text('Use '), noTranslate, text(' with '), brand, text(' when '), math,
    text(' holds and $a^2$ is small'),
  ]);
  const out = ctx.getTextWithMathPlaceholders(p, { preserveMarkup: true, keep: '.brand' });
  const byElement = (node) => out.mathElements.find((entry) => entry.element === node);
  assert.equal(byElement(noTranslate).verbatim, true);
  assert.equal(byElement(brand).verbatim, true);
  assert.equal('verbatim' in byElement(math), false, 'a math element is not verbatim');
  const latex = out.mathElements.find((entry) => entry.type === 'text');
  assert.equal(latex.text, '$a^2$');
  assert.equal('verbatim' in latex, false, 'a LaTeX text placeholder is not verbatim');
  // 其余形状不动。
  assert.deepEqual(Object.keys(byElement(brand)).sort(), ['element', 'placeholder', 'type', 'verbatim']);
  assert.equal(byElement(brand).type, 'element');
});

test('hasRealMath: true only when some placeholder is not verbatim', () => {
  const verbatim = { placeholder: '{{1}}', type: 'element', verbatim: true };
  const mathEl = { placeholder: '{{2}}', type: 'element' };
  const latex = { placeholder: '{{3}}', type: 'text', text: '$x$' };
  assert.equal(ctx.hasRealMath(undefined), false);
  assert.equal(ctx.hasRealMath([]), false);
  assert.equal(ctx.hasRealMath([verbatim]), false);
  assert.equal(ctx.hasRealMath([verbatim, verbatim]), false);
  assert.equal(ctx.hasRealMath([mathEl]), true);
  assert.equal(ctx.hasRealMath([latex]), true);
  assert.equal(ctx.hasRealMath([verbatim, mathEl]), true);
});

// 防重复：样式分支只问这一个谓词。哪天有人在插入层或悬停层重新写一遍「有占位符
// 就只写 opacity」，原样元素的段落又会丢页面排版。
test('the style branches in insert.js and hover/render.js ask hasRealMath, not the placeholder count', () => {
  const insert = repoFile('content/page/insert.js');
  const hover = repoFile('content/hover/render.js');
  const opacityBranches = (source) => [...source.matchAll(/if \(([^\n]*)\) \{\n(?:\s*\/\/[^\n]*\n)*\s*\w+\.style\.opacity = '0\.85';/g)]
    .map((m) => m[1]);
  const insertBranches = opacityBranches(insert);
  const hoverBranches = opacityBranches(hover);
  assert.equal(insertBranches.length, 1, insertBranches.join(' | '));
  assert.equal(hoverBranches.length, 2, hoverBranches.join(' | '));
  for (const condition of [...insertBranches, ...hoverBranches]) {
    assert.match(condition, /ctx\.hasRealMath\(/);
    assert.doesNotMatch(condition, /mathElements\.length|hasMathElements/);
  }
});

// ---------------------------------------------------------------- 行内元素之间的空白（B2 第 20 条）

// 两段行内内容之间只含空白的文本节点，送出时是一个空格。D-315 之后 Hacker News 评论头
// 的时间原样带回，这个空格丢了，译文里用户名和时间就连成一个词（someonethree hours ago）。
const link = (label) => el('A', [], [text(label)]);

function commentHead() {
  const age = el('SPAN', ['age'], [link('three hours ago')]);
  const navs = el('SPAN', ['navs'], [text(' | '), link('parent')]);
  const head = el('SPAN', ['comhead'], [link('someone'), text(' '), age, navs]);
  return { head, age };
}

test('whitespace between two inline elements travels as one space (HN comment header)', () => {
  const { head, age } = commentHead();
  const out = ctx.getTextWithMathPlaceholders(head, { preserveMarkup: true, keep: '.age' });
  assert.equal(out.text, '<a1>someone</a1> {{1}}<span2> | <a3>parent</a3></span2>');
  assert.equal(out.mathElements[0].element, age);
  // 悬停、划词不带规则选择器：时间照常读成字，名字和它之间同样是一个空格。
  const plain = ctx.getTextWithMathPlaceholders(head, {});
  assert.equal(plain.text, 'someone three hours ago | parent');
});

test('the space is never at either end, never doubled, and sits before a markup that opens after it', () => {
  const lead = el('P', [], [text('\n  '), link('x'), text('\n    '), link('y'), text('\n')]);
  assert.equal(ctx.getTextWithMathPlaceholders(lead, { preserveMarkup: true }).text, '<a1>x</a1> <a2>y</a2>');
  assert.equal(ctx.getTextWithMathPlaceholders(lead, {}).text, 'x y');
  // 后面的字自己带空白、或空格前已经是空白：不补第二个。
  const own = el('P', [], [link('x'), text(' '), text(' next'), text(' '), text('  '), link('y')]);
  assert.equal(ctx.getTextWithMathPlaceholders(own, { preserveMarkup: true }).text, '<a1>x</a1> next <a2>y</a2>');
  // 两个空白节点挨着：还是一个空格。
  const twice = el('P', [], [link('x'), text(' '), text('\n'), link('y')]);
  assert.equal(ctx.getTextWithMathPlaceholders(twice, { preserveMarkup: true }).text, '<a1>x</a1> <a2>y</a2>');
  // 只含空白的链接回滚掉，它那个空格留在两段字之间。
  const blank = el('P', [], [text('a'), link(' '), text('b')]);
  assert.equal(ctx.getTextWithMathPlaceholders(blank, { preserveMarkup: true }).text, 'a b');
  // 占位符前后同样。
  const kept = el('SPAN', ['brand'], [text('BrandX')]);
  const around = el('P', [], [link('x'), text(' '), kept, text(' '), link('y')]);
  assert.equal(
    ctx.getTextWithMathPlaceholders(around, { preserveMarkup: true, keep: '.brand' }).text,
    '<a1>x</a1> {{1}} <a2>y</a2>',
  );
});
