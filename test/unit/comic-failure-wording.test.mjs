// What a failed comic page says, by the code the job's poll names.
//
// The card under the page and the chapter card's reason are the same sentence
// (summary.js reads it back off the overlay), so this one function decides
// both. Two codes the service sends for pages nothing can be done about get
// words of their own; one this build does not know falls back to the general
// sentence and names itself once on the console, so it can be given words.
//
// Runs the REAL content/comic/prompts.js in a vm with a stub content context.
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const read = (path) => fs.readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
const SOURCE = read('../../content/comic/prompts.js');
// Loaded before prompts.js by the manifest; it owns the allowance's codes.
const QUOTA_COPY = read('../../shared/quota-copy.js');

/** The sentence a page shows for `error`, and every console.warn it raised. */
function failureText(error) {
  const warnings = [];
  const ctx = { t: key => key, escapeHtml: s => s, comic: { summaryShown: () => false } };
  const sandbox = vm.createContext({ window: { AI_TRANSLATOR_CONTENT: ctx }, console: { warn: (...args) => warnings.push(args) } });
  vm.runInContext(QUOTA_COPY, sandbox);
  vm.runInContext(SOURCE, sandbox);
  let shown = null;
  ctx.comic.showJobError({ setError: (text) => { shown = text; }, setActions() {} }, error);
  return { shown, warnings };
}

test('a script the service cannot read yet and a page with no text each say so', () => {
  assert.deepEqual(failureText({ code: 'comic_unsupported_script' }), { shown: 'comicUnsupportedScript', warnings: [] });
  assert.deepEqual(failureText({ code: 'comic_no_text' }), { shown: 'comicNoText', warnings: [] });
  assert.deepEqual(failureText({ code: 'comic_source_unreadable' }), { shown: 'comicImageUnavailable', warnings: [] });
});

test('both allowance refusals read as spent pages', () => {
  for (const code of ['insufficient_points', 'insufficient_credits']) {
    assert.deepEqual(failureText({ code }), { shown: 'comicInsufficientPoints', warnings: [] }, code);
  }
});

test('our own failures read as the general sentence, without a console line', () => {
  for (const code of ['comic_translate_unparsable', 'comic_internal', 'failed']) {
    assert.deepEqual(failureText({ code }), { shown: 'comicFailed', warnings: [] }, code);
  }
});

test('a code this build does not know: the general sentence, and the code on the console once', () => {
  const { shown, warnings } = failureText({ code: 'comic_something_new' });
  assert.equal(shown, 'comicFailed');
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes('comic_something_new'), JSON.stringify(warnings));
});
