// Guards for shared/account-gate.js — the module that decides whether comic and
// PDF translation are on, from the switch in sync storage AND the account token
// in local storage.
//
// The rule it enforces is easy to defeat by accident: a new surface reads
// `enableComicTranslation` straight out of chrome.storage.sync, forgets the
// account half, and offers a signed-out user a feature whose every entry point
// can only answer "sign in". That is asserted here rather than eyeballed.
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoFile = (rel) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');

// The module has no `export` (it is also loaded as a classic script by the
// popup, the options page and the content scripts), so importing it for its
// side effect publishes globalThis.AccountGate.
await import('../../shared/account-gate.js');
const gate = globalThis.AccountGate;

/** Stand in for the storage area the token lives in. */
function withToken(token) {
  globalThis.chrome = { storage: { local: { get: async (defaults) => ({ ...defaults, comicToken: token }) } } };
}

test('both account-backed switches are governed, and nothing else is', () => {
  assert.deepEqual(gate.ACCOUNT_FEATURE_KEYS, ['enableComicTranslation', 'enablePdfTranslation']);
});

test('a device with no token cannot have either feature on', async () => {
  withToken('');
  const settings = await gate.applyAccountGate({
    enableComicTranslation: true,
    enablePdfTranslation: true,
    showFloatBall: true,
  });
  assert.equal(settings.enableComicTranslation, false);
  assert.equal(settings.enablePdfTranslation, false);
  // Every other setting is none of this module's business.
  assert.equal(settings.showFloatBall, true);
});

test('a device with a token keeps the stored preference exactly', async () => {
  withToken('a-token');
  assert.deepEqual(
    await gate.applyAccountGate({ enableComicTranslation: true, enablePdfTranslation: false }),
    { enableComicTranslation: true, enablePdfTranslation: false },
  );
});

test('a storage failure fails closed', async () => {
  globalThis.chrome = { storage: { local: { get: async () => { throw new Error('context invalidated'); } } } };
  assert.equal((await gate.applyAccountGate({ enableComicTranslation: true })).enableComicTranslation, false);
});

test('both off skips the token read entirely', async () => {
  let reads = 0;
  globalThis.chrome = { storage: { local: { get: async () => { reads += 1; return { comicToken: '' }; } } } };
  await gate.applyAccountGate({ enableComicTranslation: false, enablePdfTranslation: false });
  assert.equal(reads, 0, 'the common case must not cost a storage read on every settings load');
});

test('the token key matches the one comic-client.js writes', () => {
  const client = repoFile('background/comic-client.js');
  assert.match(client, /token:\s*'comicToken'/,
    'comic-client.js renamed the token key — shared/account-gate.js reads it by name');
  assert.equal(gate.TOKEN_KEY, 'comicToken');
});

// Each of these renders or acts on the two switches, so each has to be able to
// weigh the account half. A page that reads the keys without loading the module
// cannot.
test('every surface that reads the two switches loads the gate', () => {
  // Matched as script tags, not bare filenames: prose in the markup mentions
  // popup.js well above the tags themselves.
  const surfaces = [
    ['options/options.html', 'options.js'],
    ['popup/popup.html', 'popup.js'],
  ];
  for (const [file, own] of surfaces) {
    const html = repoFile(file);
    const tag = (src) => html.indexOf(`<script src="${src}"`);
    const at = tag('../shared/account-gate.js');
    assert.ok(at !== -1, `${file} must load shared/account-gate.js`);
    assert.ok(at < tag(own), `shared/account-gate.js must load before ${own}`);
  }

  const manifest = JSON.parse(repoFile('manifest.json'));
  const scripts = manifest.content_scripts.find(entry => entry.js.includes('content/content-bootstrap.js')).js;
  assert.ok(
    scripts.indexOf('shared/account-gate.js') !== -1 &&
    scripts.indexOf('shared/account-gate.js') < scripts.indexOf('content/content-bootstrap.js'),
    'content scripts must load shared/account-gate.js before content-bootstrap.js reads settings',
  );

  assert.match(repoFile('background/background.js'), /import '\.\.\/shared\/account-gate\.js'/,
    'the service worker gates the context menu entries on the account too');
});
