// Copy feedback exists once: ctx.copyWithFeedback in content/content-utils.js,
// with its button drawn by ctx.copyButtonContent.
//
// It used to be written out twice — once in content/content-popup.js, shared
// by the selection card and the image OCR card, and once in the input dialog —
// and both saved the button's innerHTML at click time, showed "Copied", and
// put the saved HTML back 1.5 s later. A second click inside that window saved
// "Copied" as the thing to go back to, so the button stayed on "Copied" for
// good; and the label change moved the button's width, which reflowed the
// card's wrapping action row under the pointer. The shared helper reads the
// idle label off the button's own data-fit and sizes the button for both
// labels. This file fails when a surface writes its own "Copied" or its own
// clipboard call again.
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoFile = (rel) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');

const HOME = 'content/content-utils.js';
// A lookup of the "copied" message, however the lookup is spelled.
const COPIED_LOOKUP = /\(\s*['"`]copied['"`]\s*[,)]/;
// A write to the clipboard, by any of the ways a page can make one.
const CLIPBOARD_WRITE = /\bcopyToClipboard\s*\(|\bclipboard\.write(?:Text)?\s*\(|execCommand\(\s*['"`]copy['"`]/;

test('the scan sees a "copied" lookup and a clipboard write however they are spelled (self-check)', () => {
  for (const line of [
    "copyBtn.innerHTML = `${icon} ${t('copied')}`;",
    'const label = ctx.t("copied");',
    "getMessage( 'copied', lang )",
  ]) assert.match(line, COPIED_LOOKUP, line);
  // The message's own entry in a string table is not a lookup.
  assert.doesNotMatch("  copied: 'Copied',", COPIED_LOOKUP);

  for (const line of [
    'await copyToClipboard(text);',
    'await ctx.copyToClipboard(wanted);',
    'navigator.clipboard.writeText(text)',
    'await navigator.clipboard.write([item])',
    "document.execCommand('copy')",
  ]) assert.match(line, CLIPBOARD_WRITE, line);
  // Defining the one writer is not a second one.
  assert.doesNotMatch('ctx.copyToClipboard = async function(text) {', CLIPBOARD_WRITE);
});

test('only content/content-utils.js says "Copied" or writes to the clipboard', () => {
  const dirs = ['background', 'content', 'i18n', 'offscreen', 'onboarding', 'options', 'popup', 'pdf', 'shared'];
  const jsFiles = (dir) => readdirSync(fileURLToPath(new URL(`../../${dir}/`, import.meta.url)), { withFileTypes: true })
    .flatMap((entry) => entry.isDirectory() ? jsFiles(`${dir}/${entry.name}`)
      : entry.name.endsWith('.js') ? [`${dir}/${entry.name}`] : []);
  const files = dirs.flatMap(jsFiles);
  assert.ok(files.length > 50, `only ${files.length} files scanned; the scan may be looking in the wrong place`);
  assert.ok(files.includes(HOME), `${HOME} is not among the scanned files`);

  const offenders = files.filter((rel) => rel !== HOME).flatMap((rel) => repoFile(rel).split('\n')
    .map((line, index) => COPIED_LOOKUP.test(line) || CLIPBOARD_WRITE.test(line) ? `${rel}:${index + 1}` : null)
    .filter(Boolean));
  assert.deepEqual(offenders, [],
    'draw a copy button with ctx.copyButtonContent(label) and copy with ctx.copyWithFeedback(button, text)');

  // The one home still does both, so an empty offender list means something.
  const home = repoFile(HOME);
  assert.match(home, COPIED_LOOKUP);
  assert.match(home, CLIPBOARD_WRITE);
});
