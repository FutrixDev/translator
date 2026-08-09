// The target-language list is written out in four places, and they have to
// agree. They drifted once already: `pt` was offered by the settings page and
// by the in-page picker, was accepted as a valid target, and then reached the
// prompt builder — which had no name for it and asked the model to "Translate
// the given text to pt".
//
// Nothing at runtime notices that; the model usually guesses right. So the
// four lists are compared here instead.
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoFile = (rel) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');

/** Pull one array-of-string-literals assignment out of a source file. */
function readStringArray(source, declaration) {
  const start = source.indexOf(declaration);
  assert.notEqual(start, -1, `could not find ${declaration}`);
  const body = source.slice(start + declaration.length);
  const literal = body.slice(0, body.indexOf(']'));
  return [...literal.matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

/** The in-page picker: content/content-bootstrap.js. */
function pickerLanguages() {
  const source = repoFile('content/content-bootstrap.js');
  const start = source.indexOf('TARGET_LANGUAGE_OPTIONS: [');
  assert.notEqual(start, -1, 'could not find TARGET_LANGUAGE_OPTIONS');
  const block = source.slice(start, source.indexOf(']', start));
  return [...block.matchAll(/value: '([^']+)'/g)].map((m) => m[1]);
}

/** The settings page dropdown: options/options.html. */
function settingsLanguages() {
  const source = repoFile('options/options.html');
  const start = source.indexOf('<select id="targetLang">');
  assert.notEqual(start, -1, 'could not find the targetLang select');
  const block = source.slice(start, source.indexOf('</select>', start));
  return [...block.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]);
}

/** The names the service worker puts in the prompt. */
function promptLanguageNames() {
  const source = repoFile('background/background.js');
  const start = source.indexOf('const languageNames = {');
  assert.notEqual(start, -1, 'could not find languageNames');
  const block = source.slice(start, source.indexOf('};', start));
  return Object.fromEntries([...block.matchAll(/'([^']+)':\s*'([^']+)'/g)].map((m) => [m[1], m[2]]));
}

test('every language the pickers offer is a language the prompt can name', () => {
  const names = promptLanguageNames();
  for (const lang of new Set([...pickerLanguages(), ...settingsLanguages()])) {
    assert.ok(names[lang], `no prompt name for target language '${lang}'`);
    // A bare tag is what the bug looked like: 'pt' → "Translate ... to pt".
    assert.notEqual(names[lang], lang, `prompt name for '${lang}' is just the tag`);
  }
});

test('the settings page and the in-page picker offer the same languages', () => {
  assert.deepEqual(pickerLanguages().slice().sort(), settingsLanguages().slice().sort());
});

test('both surfaces agree with the list of accepted targets', () => {
  // Normalization in the service worker and the options page decides what
  // counts as a supported target; anything offered has to survive it.
  const accepted = readStringArray(repoFile('background/background.js'), 'const supportedLangs = [');
  const acceptedInOptions = readStringArray(repoFile('options/options.js'), 'const supportedLangs = [');
  assert.deepEqual(accepted, acceptedInOptions);
  assert.deepEqual(accepted.slice().sort(), settingsLanguages().slice().sort());
});
