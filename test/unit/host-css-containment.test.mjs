// Guards for the host-page containment reset in content/content.css.
//
// A content script's UI is a subtree of the host page's document, so any page
// rule written against a bare tag matches our own elements. example.com ships
// `div { opacity: .8 }`, and our panels are `div`s: it matched the dialog root,
// the modal and the header separately and the opacity compounded to 0.51, so
// page text showed through the header.
//
// That one mechanism produced three defects, each patched where it surfaced —
// the box model overflowing the textarea past the modal, the stacking context
// the same opacity built around the header (which sealed the language menu
// behind the textarea), and the visible washing-out. The reset is the fix at
// the boundary, and test/e2e/input-translation.spec.js proves it works against
// a hostile stylesheet.
//
// What is asserted here is the two things about *how it is written* that a
// browser test cannot see going wrong until it is too late, because both make
// the reset stronger rather than weaker:
//
//   - `!important` would outrank animations (important author declarations sort
//     above them), freezing ai-translator-fade-in and ai-translator-modal-in at
//     full opacity so the panels appear without ever fading in.
//   - an `#id` selector would weigh (1,0,0) and silently outrank every
//     deliberate opacity, transform and font-family of ours below it —
//     `.ai-translator-result-body` would never start hidden, the caret would
//     never rotate, the phonetic would lose its serif face.
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoFile = (rel) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');

const CSS = repoFile('content/content.css');
const MARKER = '/* ==================== Host-page containment ====================';
const END_MARKER = '/* ==================== end of host-page containment ==================== */';

/**
 * The reset block, bounded by its own markers — the sections around it are not
 * all `====` headers, so "up to the next header" would swallow half the popup.
 * Comments are stripped, so only the rules themselves are examined.
 */
function resetBlock() {
  const start = CSS.indexOf(MARKER);
  const end = CSS.indexOf(END_MARKER);
  assert.ok(
    start > 0 && end > start,
    'the containment reset is no longer delimited by its markers in content/content.css.\n'
    + 'If they were renamed, update MARKER/END_MARKER here; if the block was deleted, '
    + 'host pages can reach into our panels again.',
  );
  return CSS.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Split a selector list on its top-level commas, so `:is(a, b)` stays whole. */
function splitSelectorList(list) {
  const out = [];
  let depth = 0;
  let current = '';
  for (const character of list) {
    if (character === '(' || character === '[') depth += 1;
    else if (character === ')' || character === ']') depth -= 1;
    if (character === ',' && depth === 0) {
      out.push(current);
      current = '';
    } else {
      current += character;
    }
  }
  out.push(current);
  return out;
}

/** Every selector in the block, one per entry. */
function selectors(block) {
  return [...block.matchAll(/([^{}]+)\{[^{}]*\}/g)]
    .flatMap(([, group]) => splitSelectorList(group))
    .map((s) => s.trim())
    .filter(Boolean);
}

test('the reset covers both content-script roots', () => {
  const block = resetBlock();
  // The dialog is matched by attribute rather than by id on purpose — see
  // below — so this looks for the name, not the selector spelling.
  for (const root of ['.ai-translator-popup', 'ai-translator-input-dialog']) {
    assert.ok(block.includes(root), `${root} is not covered by the containment reset`);
  }
});

test('the reset covers the roots and their descendants', () => {
  const list = selectors(resetBlock());
  assert.ok(
    list.some((s) => !s.includes('*')),
    'the reset only reaches descendants; a page rule still matches the root itself',
  );
  assert.ok(
    list.some((s) => /\*$/.test(s)),
    'the reset only reaches the roots; opacity compounds on every div below them',
  );
});

test('the reset pins the properties that host pages actually leak', () => {
  const block = resetBlock();
  for (const property of [
    'box-sizing',      // patch 1: content-box overflowed the textarea past the modal
    'opacity',         // patch 3: compounded to 0.51 and made a stacking context
    'filter',          // same two failures as opacity, same one-line cost
    'transform',       // displaces the panel, and builds a stacking context
    'visibility',      // inherited: one `body { visibility: hidden }` hides all of it
    'line-height',     // inherited: `body { line-height: 1.8 }` is everywhere
    'letter-spacing',  // inherited, same shape
    'text-transform',  // `button { text-transform: uppercase }` hits our buttons directly
    'font-family',     // the UA gives form controls their own; so do host pages
  ]) {
    assert.match(block, new RegExp(`\\n\\s*${property}\\s*:`), `${property} is no longer pinned`);
  }
});

test('the reset is not important', () => {
  // The failure is silent and only visible in motion: the panels stop fading in
  // and simply appear.
  assert.doesNotMatch(
    resetBlock(),
    /!\s*important/,
    'the containment reset uses !important, which outranks the fade-in keyframes',
  );
});

test('no selector in the reset carries id weight', () => {
  // (1,0,0) here would beat every deliberate value of ours below it. The dialog
  // is matched as [id="…"] — (0,1,0), the same as a class — so a page rule on a
  // bare tag (0,0,1) still loses to the reset while our own rules win the tie on
  // source order.
  for (const selector of selectors(resetBlock())) {
    assert.doesNotMatch(
      selector,
      /#/,
      `"${selector}" uses an id, so the reset outranks our own opacity/transform/font rules`,
    );
  }
});

test('the reset is declared before the rules that have to beat it', () => {
  // Same specificity, so source order decides. Everything of ours that
  // deliberately sets one of these properties lives below the block.
  const start = CSS.indexOf(MARKER);
  assert.ok(start > 0);
  for (const rule of [
    '.ai-translator-result-body {',        // starts at opacity 0
    '.ai-translator-lang-caret {',         // transitions transform
    '.ai-translator-phonetic {',           // serif face
    '.ai-translator-input-phonetic {',     // serif face
    '.ai-translator-input-label {',        // 0.3px tracking
  ]) {
    const at = CSS.indexOf(rule);
    assert.ok(at > 0, `${rule} is gone; this guard needs updating`);
    assert.ok(at > start, `${rule} is declared above the containment reset, so the reset wins the tie`);
  }
});
