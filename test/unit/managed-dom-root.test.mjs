// Guards for the "managed DOM root" rule in content/content-utils.js.
//
// Rich-text editors (Lexical, ProseMirror, Slate, …) reconcile their subtree
// against an internal EditorState: a MutationObserver notices a node they did
// not create and rebuilds that part of the DOM from state, deleting it. Every
// insertion strategy the extension has was measured against a read-only Lexical
// root (Higgsfield's article body, `div.rde-content`):
//
//   block.after(el)              -> removed within 1s
//   block.appendChild(el)        -> removed
//   shadow host inside the block -> removed
//   sibling of the editor root   -> survives
//   position:absolute on body    -> survives
//
// So nothing can be inserted inside such a root, and the two surfaces that
// insert translations (hover and whole-page) must both ask before inserting.
// The failure this prevents is silent: the translation is deleted, the source
// block keeps its `ai-translator-inline-source` marker, the extension believes
// it already translated that block, and no retry ever happens — the user sees
// nothing at all and gets no error.
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoFile = (rel) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');

// content-utils.js is a classic script that hangs its helpers off
// window.AI_TRANSLATOR_CONTENT. Give it just enough of a DOM to run.
globalThis.window = { AI_TRANSLATOR_CONTENT: {} };
globalThis.Node = { ELEMENT_NODE: 1 };
globalThis.document = {
  createElement: () => ({
    set textContent(value) { this._text = String(value); },
    get innerHTML() { return this._text; },
  }),
};
await import('../../content/content-utils.js');
const ctx = globalThis.window.AI_TRANSLATOR_CONTENT;

/**
 * An element whose `closest` matches only the exact selectors in `ancestors`.
 * Crude, but it answers the question the selector list actually has to get
 * right: is this hook in the list or not.
 */
function elementUnder(ancestors) {
  const root = { nodeType: 1, name: 'root' };
  return {
    nodeType: 1,
    closest(selector) {
      const parts = selector.split(',').map((s) => s.trim());
      return parts.some((s) => ancestors.includes(s)) ? root : null;
    },
  };
}

test('the frameworks that revert foreign nodes are all covered', () => {
  for (const hook of [
    '[data-lexical-editor]',
    '.ProseMirror',
    '[data-slate-editor]',
    '.ql-editor',
    '.cm-content',
    '.CodeMirror-code',
    '.monaco-editor',
  ]) {
    assert.equal(ctx.isInsideManagedDomRoot(elementUnder([hook])), true, `${hook} is not covered`);
  }
});

test('a read-only editor is still managed', () => {
  // The whole point: Lexical in read-only mode is contenteditable="false", so
  // `element.isContentEditable` is false and the pre-existing editable guards
  // let it through. It reverts foreign nodes exactly the same.
  assert.equal(ctx.isInsideManagedDomRoot(elementUnder(['[data-lexical-editor]'])), true);
});

test('plain content is not managed', () => {
  assert.equal(ctx.isInsideManagedDomRoot(elementUnder([])), false);
  assert.equal(ctx.getManagedDomRoot(elementUnder([])), null);
});

test('contenteditable is deliberately not in the list', () => {
  // A genuinely editable surface is a different rule: it must not be translated
  // at all, and each caller's own isContentEditable / isEditableTarget check
  // rejects it earlier. Folding it in here would route the user's own text box
  // into the anchored-overlay path instead of skipping it.
  for (const hook of ['[contenteditable="true"]', '[contenteditable=""]', '[contenteditable="plaintext-only"]']) {
    assert.equal(ctx.isInsideManagedDomRoot(elementUnder([hook])), false, `${hook} should not be managed`);
  }
});

test('non-elements are answered without throwing', () => {
  assert.equal(ctx.getManagedDomRoot(null), null);
  assert.equal(ctx.getManagedDomRoot(undefined), null);
  assert.equal(ctx.getManagedDomRoot({ nodeType: 3 }), null); // text node
  assert.equal(ctx.getManagedDomRoot({ nodeType: 1 }), null); // no closest()
});

test('the root is returned, not just a boolean', () => {
  // Callers need the root itself to decide where an overlay may live.
  const root = ctx.getManagedDomRoot(elementUnder(['.ProseMirror']));
  assert.equal(root.name, 'root');
});

test('both inserting surfaces consult the shared rule', () => {
  for (const file of ['content/content-hover-translation.js', 'content/content-page-translation.js']) {
    assert.match(
      repoFile(file),
      /ctx\.isInsideManagedDomRoot/,
      `${file} inserts translations into the page but never asks whether the target is a managed root`,
    );
  }
});

test('every render entry point in the hover file consults shouldAnchor', () => {
  // Four functions can put a translation into the page (hover/selection ×
  // loading/result). Each has several early-returning branches — horizontal
  // flex, <slot>, a Range-based insert — and a branch that returns before the
  // shouldAnchor check inserts a node that a managed root deletes on sight,
  // which is exactly the silent failure this whole change exists to fix.
  const src = repoFile('content/content-hover-translation.js');
  for (const fn of [
    'function renderInlineLoading',
    'function renderInlineTranslation',
    'function renderSelectionLoading',
    'function renderSelectionTranslation',
  ]) {
    const start = src.indexOf(fn);
    assert.ok(start > 0, `${fn} is gone; this guard needs updating`);
    // Up to the next top-level function declaration.
    const next = src.indexOf('\n  function ', start + fn.length);
    const body = src.slice(start, next === -1 ? src.length : next);
    assert.match(body, /shouldAnchor\(/, `${fn} inserts a translation without asking shouldAnchor()`);
  }
});

test('the anchored fallback recognises both insertion shapes', () => {
  // A translation is inserted either beside the block (parent is
  // block.parentElement) or inside it (Range.insertNode, appendChild). The
  // runtime "this host ate my node" fallback has to answer for both, or an
  // unknown framework keeps failing silently on the shapes it misses.
  const src = repoFile('content/content-hover-translation.js');
  const start = src.indexOf('function shouldAnchor');
  const body = src.slice(start, src.indexOf('\n  function ', start + 10));
  assert.match(body, /hostileNodes\.has\(block\)/, 'shouldAnchor ignores a block whose own subtree ate the node');
  assert.match(body, /hostileNodes\.has\(block\.parentElement\)/, 'shouldAnchor ignores a hostile sibling host');
});

test('page translation skips managed roots instead of anchoring them', () => {
  // Deliberate asymmetry: hover shows one block at a time, so an overlay that
  // covers the next paragraph is fine. Whole-page would stack hundreds of
  // overlays over the text they are meant to explain, so it skips and says so.
  const src = repoFile('content/content-page-translation.js');
  assert.match(src, /ctx\.isInsideManagedDomRoot/);
  assert.doesNotMatch(src, /ai-translator-anchor|mountAnchored/, 'page translation must not grow its own anchored path');
  assert.match(src, /pageContentNotTranslatable/, 'skipping the body silently is the bug, not the fix');
});

test('the framework list is not restated outside content-utils.js', () => {
  // One list, one place. A second copy drifts the moment a framework is added
  // to one and not the other.
  //
  // Matches the selector spelling, not the bare product name: naming Lexical or
  // ProseMirror in a comment is how a reader finds out why the code detours,
  // and that is worth keeping. Writing `.ProseMirror` is a second copy of the
  // rule, and that is not.
  const owner = 'content/content-utils.js';
  const hooks = /\[data-lexical-editor\]|\.ProseMirror\b|\[data-slate-editor\]|\.ql-editor\b|\.cm-content\b|\.CodeMirror-code\b|\.monaco-editor\b/;
  for (const file of [
    'content/content-hover-translation.js',
    'content/content-page-translation.js',
    'content/content-selection.js',
    'content/content-popup.js',
  ]) {
    assert.doesNotMatch(
      repoFile(file),
      hooks,
      `${file} restates the editor list; it belongs only in ${owner}`,
    );
  }
  assert.match(repoFile(owner), hooks);
});

test('content-utils.js loads before the surfaces that use it', () => {
  const manifest = JSON.parse(repoFile('manifest.json'));
  const bundle = manifest.content_scripts.find((entry) => entry.js.includes('content/content-utils.js'));
  assert.ok(bundle, 'content-utils.js is not in any content script bundle');
  const at = (file) => bundle.js.indexOf(file);
  assert.ok(at('content/content-utils.js') < at('content/content-hover-translation.js'));
  assert.ok(at('content/content-utils.js') < at('content/content-page-translation.js'));
});

test('the "content is not translatable here" notice exists in every locale', () => {
  // A missing key renders the key name into the progress toast.
  const messages = loadMessages();
  assert.ok(Object.keys(messages).length >= 10, 'expected the full locale table');
  for (const [locale, table] of Object.entries(messages)) {
    assert.equal(typeof table.pageContentNotTranslatable, 'string', `${locale} is missing pageContentNotTranslatable`);
    assert.ok(table.pageContentNotTranslatable.length > 0, `${locale} has an empty pageContentNotTranslatable`);
  }
});

function loadMessages() {
  // messages.js is a classic script; run it for its globalThis side effect.
  const source = repoFile('i18n/messages.js');
  // eslint-disable-next-line no-new-func
  new Function(source)();
  return globalThis.I18N_MESSAGES;
}
