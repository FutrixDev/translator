// A function wired straight to a DOM event is called with the event as its
// first argument. One that also takes an argument of its own (a default, a
// message, an id) gets the event in its place: D-501 B-2 was the settings
// page's Sign in sending a PointerEvent to the worker as its message, because
// comicSignIn(message = {...}) was the click listener.
//
// So: every `addEventListener(type, name)` across the extension whose `name`
// is a function declared in the same surface takes nothing, or the event.
// Listeners written inline, or assigned to a variable later, are not resolved
// here; they are arrows that say what they pass.
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// Each directory is one surface: its scripts share a page's (or the content
// scripts') global scope, so a listener may be declared in a sibling file.
const SURFACES = ['background', 'content', 'i18n', 'offscreen', 'onboarding', 'options', 'popup', 'pdf', 'shared'];
const EVENT_PARAM = /^_?(e|ev|evt|event)$/;

function filesUnder(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });
}

function declaredParams(source, name) {
  const patterns = [
    new RegExp(`function\\s*\\*?\\s*${name}\\s*\\(([^)]*)\\)`),
    new RegExp(`(?:const|let|var)\\s+${name}\\s*=\\s*(?:async\\s*)?(?:function\\s*[\\w$]*\\s*)?\\(([^)]*)\\)`),
    new RegExp(`(?:const|let|var)\\s+${name}\\s*=\\s*(?:async\\s+)?([A-Za-z_$][\\w$]*)\\s*=>`),
  ];
  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (match) return match[1].replace(/\s+/g, ' ').trim();
  }
  return null;
}

/** Every named DOM listener, with the parameters its declaration takes (null: not resolved). */
function namedListeners() {
  const found = [];
  for (const surface of SURFACES) {
    const files = filesUnder(path.join(ROOT, surface));
    const sources = new Map(files.map((file) => [file, readFileSync(file, 'utf8')]));
    for (const [file, source] of sources) {
      for (const match of source.matchAll(/addEventListener\(\s*[^,()]+?\s*,\s*([A-Za-z_$][\w$]*)\s*[,)]/g)) {
        const name = match[1];
        // The attaching file first, then its siblings in the same surface.
        let params = declaredParams(source, name);
        for (const [other, otherSource] of sources) {
          if (params !== null) break;
          if (other !== file) params = declaredParams(otherSource, name);
        }
        const line = source.slice(0, match.index).split('\n').length;
        found.push({ at: `${path.relative(ROOT, file)}:${line}`, name, params });
      }
    }
  }
  return found;
}

test('a function wired straight to a DOM event takes nothing, or the event (D-501)', () => {
  const listeners = namedListeners();
  const resolved = listeners.filter((listener) => listener.params !== null);
  // The scan has to be seeing the page it was written for, not matching nothing.
  assert.ok(resolved.length >= 100, `only ${resolved.length} named listeners resolved`);
  for (const name of ['comicSignIn', 'blabSignIn', 'comicSignOut']) {
    assert.ok(resolved.some((listener) => listener.name === name), `${name} is wired by name and resolved`);
  }
  const offenders = resolved
    .filter(({ params }) => params !== '' && !EVENT_PARAM.test(params))
    .map(({ at, name, params }) => `${at} ${name}(${params})`);
  assert.deepEqual(offenders, [], 'these would be handed the event in place of their own argument');
});
