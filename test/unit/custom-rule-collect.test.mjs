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
  const keep = body.indexOf('if (keepSelector && closestAcross(element, keepSelector)) return;');
  const exclude = body.indexOf('if (excludeSelector && closestAcross(element, excludeSelector)) return;');
  const judge = body.indexOf('if (!allowed(element)) {');
  assert.ok(exclude > 0 && keep > exclude, 'the block exclude check moved');
  assert.ok(judge > keep, 'translate="yes" is judged before the keepOriginal rule');
  // 整页收块把两串选择器都交给行内读法。
  assert.match(source, /const textOptions = \{ preserveMarkup: true, exclude: excludeSelector, keep: keepSelector \};/);
});
