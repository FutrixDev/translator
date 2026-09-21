// Guards for where a translation is inserted — the rule behind
// github.com/FutrixDev/translator#71.
//
// Two surfaces build a translation element next to a source block: full-page
// translation (content/page/insert.js) and hover/selection translation
// (content-hover-translation.js). They used to each decide "sibling or child?"
// on their own, and they disagreed: the hover path had no table-cell case at
// all. The rule now lives in one place, `getTranslationPlacement`, and this
// file fails if a caller starts restating it.
//
// It also pins the two cross-file couplings the fix introduced, both of which
// are silent when broken: the wrapper class that carries a block's stray text
// nodes must be styled by content.css, and content.css must not strip the
// marker off a list item that now holds its own translation.
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { contentCss } from './helpers/sources.mjs';

const repoUrl = (rel) => new URL(`../../${rel}`, import.meta.url);
const repoFile = (rel) => readFileSync(fileURLToPath(repoUrl(rel)), 'utf8');

const pageInsert = repoFile('content/page/insert.js');
const pageCollect = repoFile('content/page/collect.js');
const hoverTranslation = repoFile('content/content-hover-translation.js');
// Comments in content.css quote the rules that were removed, so strip them before
// asserting on what the stylesheet actually declares.
const contentCssText = contentCss().replace(/\/\*[\s\S]*?\*\//g, '');

test('the placement rule is declared once and published on ctx', () => {
  // content/ 和 content/page/ 都要扫：规则搬进子目录之后，只扫一层等于不扫。
  const contentFiles = ['content', 'content/page'].flatMap((dir) =>
    readdirSync(fileURLToPath(repoUrl(dir)))
      .filter((name) => name.endsWith('.js'))
      .map((name) => `${dir}/${name}`));
  const owners = contentFiles
    .filter((rel) => /function\s+getTranslationPlacement\s*\(/.test(repoFile(rel)));
  assert.deepEqual(owners, ['content/page/insert.js']);
  assert.match(pageInsert, /ctx\.getTranslationPlacement\s*=\s*getTranslationPlacement/);
});

test('the tables the rule is made of are not copied into another file', () => {
  // Each of these encodes part of "does this element paint its own box, and may
  // a translation live inside it?" — a second copy is a second answer.
  for (const token of ['INSIDE_ONLY_TAGS', 'PHRASING_CONTENT_TAGS', 'IN_FLOW_DISPLAYS', 'paintsOwnBox']) {
    assert.equal(hoverTranslation.includes(token), false,
      `${token} is restated in content-hover-translation.js; call ctx.getTranslationPlacement instead`);
  }
});

test('hover/selection translation asks the shared rule where to insert', () => {
  // Both render paths (the loading placeholder and the translation itself).
  const uses = hoverTranslation.match(/ctx\.getTranslationPlacement\(/g) || [];
  assert.equal(uses.length, 2);
  assert.match(hoverTranslation, /ctx\.getTextOffsetLeft\(block,\s*\{\s*fromContentBox:\s*placement\.inside\s*\}\)/);
});

test('the stray-text-node wrapper class is the one content.css styles', () => {
  const declared = pageCollect.match(/const TEXT_RUN_CLASS = '([^']+)'/);
  assert.ok(declared, 'TEXT_RUN_CLASS is gone from content/page/collect.js');
  assert.match(pageCollect, /ctx\.TEXT_RUN_CLASS\s*=\s*TEXT_RUN_CLASS/);
  // The wrapper is injected into the page's own markup, so it has to render as
  // if it were not there — no box, no font of its own.
  assert.ok(contentCssText.includes(`span.${declared[1]}`),
    `content/css/ has no rule for .${declared[1]}; the wrapper would inherit the page's span styling`);
});

test('a list item keeps its marker when it holds its own translation', () => {
  // `li.ai-translator-inline-block { list-style: none; margin-left: 0 }` existed
  // for the old sibling-<li> layout. With the translation inside the item the
  // same rule strips the bullet off the source item.
  const rule = contentCssText.match(/li\.ai-translator-inline-block\s*\{([^}]*)\}/);
  if (rule) {
    assert.doesNotMatch(rule[1], /list-style\s*:\s*none/);
    assert.doesNotMatch(rule[1], /margin-left\s*:\s*0/);
  }
});
