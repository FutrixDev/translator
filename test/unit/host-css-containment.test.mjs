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
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoFile = (rel) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');
const repoDir = (rel) => readdirSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)));

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
    '.ai-translator-label {',              // 0.3px tracking
  ]) {
    const at = CSS.indexOf(rule);
    assert.ok(at > 0, `${rule} is gone; this guard needs updating`);
    assert.ok(at > start, `${rule} is declared above the containment reset, so the reset wins the tie`);
  }
});

// ---------------------------------------------------------------------------
// Form controls
//
// A theme does not write `button { … }`. It writes `.elementor-kit-6 button`,
// from a class it puts on <body> — (0,1,1), one type selector heavier than the
// single-class rules our own controls were written with. azulle.com renders
// every panel we have as a stack of lime pills that way: the float menu, the
// popup, the input dialog and the progress toast all lost their background,
// padding, border-radius and font to the page's button style at once.
//
// The fix is a specificity band, and both edges of it are asserted here
// because a browser only shows you the failure on a site that happens to ship
// the rule:
//
//   theme (0,1,1)  <  the control reset (0,1,2)  <  our own rules (0,2,0)
//
// The reset gets its extra type selector from a leading `body`; our own rules
// get their second class from the panel root they are scoped to. A new rule
// for a control written the old way, with one class, silently drops back
// underneath the theme — that is what the last test catches.

/** Rough CSS specificity: [ids, classes, types]. `:is()`/`:not()` take the max of their arguments. */
function specificity(selector) {
  let s = selector.replace(/::[a-z-]+/g, '');
  const total = [0, 0, 0];
  // Functional pseudo-classes contribute the specificity of their heaviest argument.
  const functional = /:(is|not|has|where)\(/;
  let match;
  while ((match = functional.exec(s))) {
    let depth = 0;
    let end = match.index + match[0].length - 1;
    for (; end < s.length; end += 1) {
      if (s[end] === '(') depth += 1;
      else if (s[end] === ')' && (depth -= 1) === 0) break;
    }
    const inner = s.slice(match.index + match[0].length, end);
    if (match[1] !== 'where') {
      const best = splitSelectorList(inner)
        .map((part) => specificity(part.trim()))
        .reduce((a, b) => (compare(b, a) > 0 ? b : a), [0, 0, 0]);
      for (let i = 0; i < 3; i += 1) total[i] += best[i];
    }
    s = s.slice(0, match.index) + ' ' + s.slice(end + 1);
  }
  total[0] += (s.match(/#[\w-]+/g) || []).length;
  total[1] += (s.match(/\.[\w-]+/g) || []).length
    + (s.match(/\[[^\]]*\]/g) || []).length
    + (s.match(/:[a-z-]+(?![\w-]*\()/g) || []).length;
  total[2] += (s.match(/(^|[\s>+~])([a-z][\w-]*)/g) || []).length;
  return total;
}

/** > 0 when a outranks b. */
function compare(a, b) {
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/** The class names we render on real form controls, read off the markup rather than listed here. */
function controlClasses() {
  const classes = new Set();
  for (const file of repoDir('content').filter((f) => f.endsWith('.js'))) {
    const js = repoFile(`content/${file}`);
    for (const [, , attr] of js.matchAll(/<(button|textarea|input|select)\b[^>]*\bclass="([^"]*)"/g)) {
      for (const name of attr.replace(/\$\{[^}]*\}/g, ' ').split(/\s+/)) {
        if (name.startsWith('ai-translator-')) classes.add(name);
      }
    }
  }
  return classes;
}

/** Every rule in the sheet as {selector, specificity}, one entry per selector in a list. */
function allSelectors() {
  return [...CSS.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{[^{}]*\}/g)]
    .flatMap(([, group]) => splitSelectorList(group))
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('@') && !s.startsWith('from') && !s.startsWith('to'));
}

test('the markup still renders controls we have to defend', () => {
  // If this ever empties out, the guard below passes vacuously.
  const classes = controlClasses();
  assert.ok(classes.size >= 8, `only found ${classes.size} control classes; the markup scan has stopped matching`);
  assert.ok(classes.has('ai-translator-menu-item'), 'the float menu items are no longer buttons with that class');
});

test('the control reset outranks a theme rule but not our own', () => {
  const reset = selectors(resetBlock()).filter((s) => /\b(button|textarea|select)\b/.test(s));
  assert.equal(reset.length, 1, 'expected exactly one form-control rule in the containment block');
  const weight = specificity(reset[0]);
  assert.ok(
    compare(weight, [0, 1, 1]) > 0,
    `the control reset weighs ${weight} and no longer beats a theme's \`.kit button\` (0,1,1); `
    + 'the panels go back to the page\'s button style',
  );
  assert.ok(
    compare(weight, [0, 2, 0]) < 0,
    `the control reset weighs ${weight} and now outranks our own control rules (0,2,0); `
    + 'it would flatten every background, padding and radius we set',
  );
});

test('every rule for one of our controls is scoped to its panel root', () => {
  const classes = controlClasses();
  const offenders = [];
  for (const selector of allSelectors()) {
    // Only rules whose *subject* is the control: `… .ai-translator-btn svg` styles the icon.
    const subject = selector.split(/[\s>+~]+/).filter(Boolean).pop() || '';
    if (![...classes].some((name) => subject.includes(`.${name}`))) continue;
    // `!important` throughout is its own defence — .ai-translator-inline-block is a page
    // element, not a panel child, and cannot be scoped to a root.
    if (new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{[^{}]*!\\s*important`).test(CSS)) continue;
    if (compare(specificity(selector), [0, 1, 1]) <= 0) offenders.push(selector);
  }
  assert.deepEqual(
    offenders,
    [],
    'these control rules weigh (0,1,0) and lose to a theme\'s `.kit button` (0,1,1).\n'
    + 'Prefix each with the panel root it lives in, e.g.\n'
    + '  :is(.ai-translator-popup, [id="ai-translator-input-dialog"]) .ai-translator-btn { … }',
  );
});
