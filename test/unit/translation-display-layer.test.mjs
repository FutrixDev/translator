// The display of our translation nodes lives in one cascade layer (content/css/translation.css).
//
// A page can override display on our nodes with a heavier !important rule. reddit's
// feed-card preview does it to every descendant:
//
//   shreddit-post .feed-card-text-preview :not(ol,ul,li,h1) { display: inline !important }
//
// At (0,2,2) that rule outweighed `.ai-translator-inline-block` (0,1,0) and the hide rule
// (0,2,0). Every translation ran on inline after its source, and neither "hide
// translations" nor translation-only could set display:none. Inside a layer, an
// !important declaration beats every unlayered !important declaration, whatever the
// specificity, so that page loses.
//
// This test pins both halves of the rule:
//   - every `display … !important` in the file is inside `@layer ai-translator-display`.
//     One left outside can be outweighed again;
//   - the layer holds nothing else. A layered !important also beats OUR OWN unlayered
//     !important rules. The translation styles (0,4,1) and the source-hidden margin
//     reset beat the base rule on specificity alone, and would lose to it if the base
//     rule's margin, padding or border moved into the layer.
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { toShadowCss } from '../../background/page-coverage.js';

const CSS = readFileSync(fileURLToPath(new URL('../../content/css/translation.css', import.meta.url)), 'utf8');
const LAYER = '@layer ai-translator-display';

/** Every style rule as { head, declarations, within: [enclosing at-rule headers] }. */
function rulesOf(css) {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  const open = [];
  let mark = 0;
  for (let i = 0; i < bare.length; i += 1) {
    const character = bare[i];
    if (character === '{') {
      open.push({ head: bare.slice(mark, i).replace(/\s+/g, ' ').trim(), start: i + 1 });
      mark = i + 1;
    } else if (character === '}') {
      const block = open.pop();
      const within = open.map((o) => o.head);
      if (!block.head.startsWith('@') && !within.some((h) => h.startsWith('@keyframes'))) {
        const declarations = bare.slice(block.start, i).split(';').map((d) => d.trim()).filter(Boolean).map((d) => {
          const colon = d.indexOf(':');
          const value = d.slice(colon + 1).trim();
          return { property: d.slice(0, colon).trim(), value, important: /!\s*important$/i.test(value) };
        });
        rules.push({ head: block.head, declarations, within });
      }
      mark = i + 1;
    } else if (character === ';' && !(open.length && !open[open.length - 1].head.startsWith('@'))) {
      // a statement at-rule (`@layer a, b;`) outside a style rule is not part of the next head
      mark = i + 1;
    }
  }
  assert.equal(open.length, 0, 'unbalanced braces in translation.css');
  return rules;
}

const rules = rulesOf(CSS);
const layered = rules.filter((rule) => rule.within.includes(LAYER));

test('every display !important of the translation stylesheet is inside the display layer', () => {
  const outside = rules
    .filter((rule) => !rule.within.includes(LAYER))
    .filter((rule) => rule.declarations.some((d) => d.property === 'display' && d.important))
    .map((rule) => rule.head);
  assert.deepEqual(outside, [], 'a display !important outside the layer can be outweighed by the page again');
});

test('the display layer holds display !important and nothing else', () => {
  const strays = layered.flatMap((rule) => rule.declarations
    .filter((d) => !(d.property === 'display' && d.important))
    .map((d) => `${rule.head} { ${d.property}: ${d.value} }`));
  assert.deepEqual(strays, [], 'a layered !important also beats our own unlayered !important rules');
});

test('the layer is one layer, never nested and never inside a condition', () => {
  const heads = [...CSS.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/@layer\b[^{;]*/g)].map((m) => m[0].trim());
  assert.ok(heads.length > 0);
  assert.deepEqual([...new Set(heads)], [LAYER]);
  for (const rule of layered) {
    assert.deepEqual(rule.within, [LAYER], `${rule.head} sits in ${rule.within.join(' > ')}`);
  }
});

test('the layer carries the rules the reddit feed card used to beat', () => {
  // A parser that saw nothing would pass the three tests above on any file.
  const displayOf = (head) => layered.find((rule) => rule.head === head)?.declarations[0].value;
  assert.equal(displayOf('.ai-translator-inline-block'), 'block !important');
  assert.equal(displayOf('.ai-translator-inline-block.ai-translator-hidden'), 'none !important');
  assert.equal(displayOf('.ai-translator-source-hidden'), 'none !important');
  assert.equal(displayOf('span.ai-translator-text-run'), 'inline !important');
});

test('inline-right comes after the base rule inside the layer', () => {
  // A horizontal-nav translation carries both classes. At equal specificity the later rule
  // wins, and it has to be inline. The hide rule (0,2,0) still outweighs both.
  const at = (head) => layered.findIndex((rule) => rule.head === head);
  assert.ok(at('.ai-translator-inline-block') >= 0 && at('.ai-translator-inline-right') >= 0);
  assert.ok(at('.ai-translator-inline-right') > at('.ai-translator-inline-block'));
});

test('the shadow-root copy keeps the layer', () => {
  const shadow = toShadowCss(CSS);
  const count = (text) => text.split(LAYER).length - 1;
  assert.equal(count(shadow), count(CSS));
  assert.ok(rulesOf(shadow).filter((rule) => rule.within.includes(LAYER)).length === layered.length);
});
