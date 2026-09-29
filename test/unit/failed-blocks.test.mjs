// Failed-block markers (P1-D batch D2, design §4; content/page/failed-blocks.js).
//
// A marker borrows the translation block's class name, so collect, discovery,
// selection and hover skip it for free. That makes every place that *counts* a
// translation a place that must exclude it, and a browser test only notices
// the one it happens to look at. This file pins down all of them:
//
//   - the one page-translation selector and every translation-style selector
//     in translation.css carry :not(.ai-translator-failed);
//   - "translation only" never pairs a hidden source with a marker, so the
//     source of a failed block is released instead of vanishing;
//   - the file loads after insert.js (placeFailureMarker) and before
//     visibility.js (which reads ctx.failedBlocks.SELECTOR), in the manifest
//     and in the e2e harness, exactly once each.
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoFile = (rel) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');

const FAILED_NOT = ':not(.ai-translator-failed)';
const HOVER_NOT = ':not(.ai-translator-hover-translation)';

// ------------------------------------------------------- 1. selectors

test('the page-translation selector excludes failed markers', () => {
  const source = repoFile('content/page/visibility.js');
  const match = source.match(/const PAGE_TRANSLATION_SELECTOR =\s*'([^']+)';/);
  assert.ok(match, 'PAGE_TRANSLATION_SELECTOR is no longer a single-quoted literal');
  assert.ok(match[1].startsWith('.ai-translator-inline-block'));
  assert.ok(match[1].includes(FAILED_NOT), `${match[1]}\n  is missing ${FAILED_NOT}`);
});

/** Every selector in a stylesheet, comments stripped, split on top-level commas. */
function cssSelectors(css) {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  // The prelude of every block is what follows the last `}` or `;` before its `{`;
  // at-rule preludes (@media, @layer) are not selectors.
  const preludes = bare.split('{').slice(0, -1).map((piece) => piece.split(/[};]/).pop().trim());
  for (const prelude of preludes.filter((text) => text && !text.startsWith('@'))) {
    let depth = 0;
    let current = '';
    for (const character of prelude) {
      if (character === '(') depth += 1;
      if (character === ')') depth -= 1;
      if (character === ',' && depth === 0) {
        out.push(current.trim());
        current = '';
      } else {
        current += character;
      }
    }
    out.push(current.trim());
  }
  return out;
}

test('every page-only translation style selector in translation.css excludes failed markers', () => {
  const selectors = cssSelectors(repoFile('content/css/translation.css')).filter((s) => s.includes(HOVER_NOT));
  // underline, dashed, highlight, quote, and blur's five (base, hover, focus,
  // revealed, reduced motion). A new one is fine; the count only proves the
  // parser still reads the file.
  assert.equal(selectors.length, 9, `found ${selectors.length}:\n${selectors.join('\n')}`);
  for (const selector of selectors) {
    assert.ok(selector.includes(FAILED_NOT), `${selector}\n  is missing ${FAILED_NOT}: a marker would be drawn as a translation`);
  }
});

test('the selector scan fails the mutation it exists for', () => {
  const css = `html[x="a"] .b${HOVER_NOT}${FAILED_NOT} { color: red; }\nhtml[x="b"] .b${HOVER_NOT} { color: red; }`;
  const selectors = cssSelectors(css).filter((s) => s.includes(HOVER_NOT));
  assert.equal(selectors.length, 2);
  assert.equal(selectors.filter((s) => !s.includes(FAILED_NOT)).length, 1);
});

// ------------------------------------------------------- 2. pairedTranslation

/** A tiny element with just what pairedTranslation touches. */
function el(...classes) {
  const node = {
    classList: {
      contains: (name) => classes.includes(name),
    },
    parentElement: null,
    nextElementSibling: null,
    children: [],
    // `:scope > .a:not(.b)` only: a direct child with every positive class and none of the negated ones.
    querySelector(selector) {
      const match = selector.match(/^:scope > ((?:\.[\w-]+)+)((?::not\(\.[\w-]+\))*)$/);
      if (!match) throw new Error(`fake querySelector does not read ${selector}`);
      const want = match[1].split('.').filter(Boolean);
      const not = [...match[2].matchAll(/:not\(\.([\w-]+)\)/g)].map((m) => m[1]);
      return node.children.find((child) =>
        want.every((name) => child.classList.contains(name))
        && not.every((name) => !child.classList.contains(name))) || null;
    },
  };
  return node;
}

function adopt(parent, ...children) {
  parent.children = children;
  children.forEach((child, i) => {
    child.parentElement = parent;
    child.nextElementSibling = children[i + 1] || null;
  });
}

const pairedTranslation = (() => {
  const source = repoFile('content/page/visibility.js');
  const match = source.match(/function pairedTranslation\(hiddenEl\) \{[\s\S]*?\n {2}\}\n/);
  assert.ok(match, 'pairedTranslation is no longer in content/page/visibility.js');
  return new Function(`${match[0]}; return pairedTranslation;`)();
})();

test('pairedTranslation: a hidden source block pairs with the translation after it, never a failed marker', () => {
  const source = el('ai-translator-source-hidden');
  const translation = el('ai-translator-inline-block');
  adopt(el(), source, translation);
  assert.equal(pairedTranslation(source), translation);

  const failedSource = el('ai-translator-source-hidden');
  const marker = el('ai-translator-inline-block', 'ai-translator-failed');
  adopt(el(), failedSource, marker);
  assert.equal(pairedTranslation(failedSource), null, 'a marker is not a translation: the source must be released');
});

test('pairedTranslation: a source wrap pairs with its sibling translation, skipping a failed marker', () => {
  const wrap = el('ai-translator-source-wrap', 'ai-translator-source-hidden');
  const marker = el('ai-translator-inline-block', 'ai-translator-failed');
  adopt(el(), wrap, marker);
  assert.equal(pairedTranslation(wrap), null);

  const wrap2 = el('ai-translator-source-wrap', 'ai-translator-source-hidden');
  const translation = el('ai-translator-inline-block');
  adopt(el(), wrap2, translation);
  assert.equal(pairedTranslation(wrap2), translation);
});

// ------------------------------------------------------- 3. load order

const FILE = 'content/page/failed-blocks.js';

function assertOrder(list, where) {
  const count = (file) => list.filter((entry) => entry === file).length;
  for (const file of ['content/page/insert.js', FILE, 'content/page/visibility.js']) {
    assert.equal(count(file), 1, `${where} lists ${file} ${count(file)} times`);
  }
  assert.ok(list.indexOf('content/page/insert.js') < list.indexOf(FILE), `${where}: failed-blocks.js must load after insert.js`);
  assert.ok(list.indexOf(FILE) < list.indexOf('content/page/visibility.js'), `${where}: failed-blocks.js must load before visibility.js`);
}

test('the manifest loads failed-blocks.js once, after insert.js and before visibility.js', () => {
  const manifest = JSON.parse(repoFile('manifest.json'));
  const lists = manifest.content_scripts.map((cs) => cs.js || []).filter((js) => js.includes('content/page/insert.js'));
  assert.equal(lists.length, 1);
  assertOrder(lists[0], 'manifest.json');
  for (const cs of manifest.content_scripts) {
    if (!(cs.js || []).includes('content/page/insert.js')) assert.ok(!(cs.js || []).includes(FILE));
  }
});

test('the e2e page-translation harness loads failed-blocks.js in manifest order', () => {
  const helpers = repoFile('test/e2e/helpers.js');
  const start = helpers.indexOf('const PAGE_TRANSLATION_MODULES = Object.freeze([');
  assert.notEqual(start, -1);
  const list = [...helpers.slice(start, helpers.indexOf('])', start)).matchAll(/'([^']+\.js)'/g)].map((m) => m[1]);
  assertOrder(list, 'PAGE_TRANSLATION_MODULES');
});
