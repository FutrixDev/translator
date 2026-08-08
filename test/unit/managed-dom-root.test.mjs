// Guards for the "managed DOM root" rule in content/content-utils.js.
//
// Rich-text editors (Lexical, ProseMirror, Slate, …) reconcile their subtree
// against an internal EditorState: a MutationObserver notices a node they did
// not create and rebuilds that part of the DOM from state, deleting it. Every
// insertion strategy the extension has was measured against a read-only Lexical
// root (Higgsfield's article body, `div.rde-content`):
//
//   block.after(el)               -> removed within 1s
//   block.appendChild(el)         -> removed
//   shadow host inside the block  -> removed
//   inline style / attribute      -> survives (attributes are not observed)
//   ::after generated content     -> survives, and takes real layout space
//
// So no *node* can be inserted inside such a root, and the two surfaces that
// insert translations (hover and whole-page) must both ask before inserting.
// The failure this prevents is silent: the translation is deleted, the source
// block keeps its `ai-translator-inline-source` marker, the extension believes
// it already translated that block, and no retry ever happens — the user sees
// nothing at all and gets no error.
//
// Generated content is what both surfaces fall back to (see
// content/content-managed-translation.js): a MutationObserver never sees it,
// and unlike the document-level overlay this replaced, it pushes the next
// paragraph down instead of covering it.
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
  // into the generated-content path instead of skipping it.
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

test('every render entry point in the hover file routes managed blocks', () => {
  // Four functions can put a translation into the page (hover/selection ×
  // loading/result). Each has several early-returning branches — horizontal
  // flex, <slot>, a Range-based insert — and a branch that returns before the
  // managed check inserts a node that a managed root deletes on sight, which is
  // exactly the silent failure this whole change exists to fix.
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
    assert.match(
      body,
      /renderManaged\(|shouldUseManagedRendering\(/,
      `${fn} inserts a translation without routing managed blocks to generated content`,
    );
  }
});

test('the runtime fallback recognises both insertion shapes', () => {
  // A translation is inserted either beside the block (parent is
  // block.parentElement) or inside it (Range.insertNode, appendChild). The
  // runtime "this host ate my node" fallback has to answer for both, or an
  // unknown framework keeps failing silently on the shapes it misses.
  const src = repoFile('content/content-hover-translation.js');
  const start = src.indexOf('function shouldUseManagedRendering');
  const body = src.slice(start, src.indexOf('\n  function ', start + 10));
  assert.match(body, /hostileNodes\.has\(block\)/, 'a block whose own subtree ate the node is ignored');
  assert.match(body, /hostileNodes\.has\(block\.parentElement\)/, 'a hostile sibling host is ignored');
});

test('nothing renders a translation as an absolutely positioned overlay', () => {
  // The mechanism this replaced. An overlay is out of flow, so it can only sit
  // on top of the paragraph that follows — which is precisely what users
  // reported. Generated content takes real layout space instead.
  for (const file of [
    'content/content-hover-translation.js',
    'content/content-page-translation.js',
    'content/content-managed-translation.js',
    'content/content.css',
  ]) {
    assert.doesNotMatch(repoFile(file), /ai-translator-anchor|mountAnchored/, `${file} grew an overlay path again`);
  }
});

test('whole-page translation reaches into managed roots', () => {
  // The first version of this fix skipped managed roots outright, which on a
  // site whose whole article body is a read-only Lexical root means "translate
  // page" translates the nav and nothing else. It must collect those blocks and
  // render them the same way hover does.
  const src = repoFile('content/content-page-translation.js');
  assert.match(src, /ctx\.isInsideManagedDomRoot/);
  assert.match(src, /ctx\.renderManagedTranslation\(/, 'page translation collects managed blocks but never renders them');
  // The remaining skip is narrow: only blocks generated content cannot carry.
  assert.match(src, /canRenderManagedTranslation/, 'page translation must not skip a managed root wholesale');
  assert.match(src, /pageContentNotTranslatable/, 'skipping the body silently is the bug, not the fix');
});

test('the generated-content module is the only place that owns the mechanism', () => {
  // One owner for the stylesheet, the block attribute and the CSS string
  // escaping. A second copy is how the attribute name and the escaping drift
  // apart, and a mis-escaped translation silently drops the whole rule.
  //
  // Matches the moving parts, not the word "::after": saying in a comment that
  // the translation becomes generated content is how a reader finds out why the
  // code detours, and that is worth keeping. Writing the attribute name or
  // touching the stylesheet is a second copy of the rule, and that is not.
  const owner = 'content/content-managed-translation.js';
  assert.match(repoFile(owner), /data-ai-translator-managed/);
  for (const file of [
    'content/content-hover-translation.js',
    'content/content-page-translation.js',
    'content/content-float-ball.js',
  ]) {
    assert.doesNotMatch(
      repoFile(file),
      /data-ai-translator-managed|insertRule|cssRules|deleteRule/,
      `${file} restates the generated-content mechanism; it belongs only in ${owner}`,
    );
  }
});

test('a translation is escaped before it becomes a CSS string', () => {
  // `content` is a CSS string literal. An unescaped quote or backslash in a
  // translation ends the literal and invalidates the rule, so the paragraph
  // silently renders nothing.
  // Lifted out of the module and run, rather than pattern-matched: what matters
  // is what comes out, not how it is spelled.
  const src = repoFile('content/content-managed-translation.js');
  const start = src.indexOf('function cssString');
  assert.ok(start > 0, 'cssString is gone; translations reach CSS unescaped');
  const body = src.slice(start, src.indexOf('\n  function ', start + 10));
  // eslint-disable-next-line no-new-func
  const cssString = new Function(`${body}\nreturn cssString;`)();

  assert.equal(cssString('plain'), '"plain"');
  assert.equal(cssString('say "hi"'), '"say \\"hi\\""');
  assert.equal(cssString('a\\b'), '"a\\\\b"');
  // A raw newline is not allowed inside a CSS string; \A needs a terminating
  // space or the next character gets swallowed into the escape.
  assert.equal(cssString('a\nb'), '"a\\A b"');
  assert.equal(cssString('a\r\nb'), '"a\\A b"');
  assert.equal(cssString(null), '""');
});

test('every managed translation can be released', () => {
  // Generated content lives in a stylesheet rule, not in the handle element the
  // callers hold. Calling .remove() on the handle leaves the rule and the
  // block's attribute behind — the translation stays on screen forever — so
  // both disposal paths in the hover file must release first.
  const src = repoFile('content/content-hover-translation.js');
  const removals = src.match(/^\s*\w+\.remove\(\);$/gm) || [];
  assert.ok(removals.length >= 2, 'expected the replace and the teardown paths');
  assert.equal(
    (src.match(/releaseManaged\(/g) || []).length,
    removals.length + 1, // +1 for the helper's own definition
    'a translation element is removed without releasing its generated content first',
  );
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

  // The renderer hangs its helpers off the same ctx object, so it has to run
  // before anything calls them.
  const renderer = at('content/content-managed-translation.js');
  assert.ok(renderer > 0, 'content-managed-translation.js is not in the bundle');
  assert.ok(renderer < at('content/content-hover-translation.js'));
  assert.ok(renderer < at('content/content-page-translation.js'));
  assert.ok(renderer < at('content/content-float-ball.js'));
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
