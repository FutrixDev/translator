// Guards for shared/account-gate.js — the module that answers what comic and PDF
// translation can do here, from the switch in sync storage AND the account token
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
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const repoFile = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

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

// The three answers, and the one thing the old gate could not say: "turned
// off" and "not signed in" are different states (D-353). A switch the user
// turned off keeps every hint away; a switch that is on for a signed-out device
// is an invitation to sign in, not a missing feature.
test('featureState tells "turned off" apart from "not signed in"', () => {
  const S = gate.FEATURE_STATES;
  for (const key of gate.ACCOUNT_FEATURE_KEYS) {
    assert.equal(gate.featureState({ [key]: false }, key, true), S.OFF, `${key} off, signed in`);
    assert.equal(gate.featureState({ [key]: false }, key, false), S.OFF, `${key} off, signed out`);
    assert.equal(gate.featureState({ [key]: true }, key, false), S.SIGNED_OUT, `${key} on, signed out`);
    assert.equal(gate.featureState({ [key]: true }, key, true), S.READY, `${key} on, signed in`);
  }
  assert.deepEqual(Object.values(S).sort(), ['off', 'ready', 'signed_out']);
});

test('featureState never rewrites the settings it is asked about', () => {
  const settings = Object.freeze({ enableComicTranslation: true, enablePdfTranslation: true, showFloatBall: true });
  assert.equal(gate.featureState(settings, 'enablePdfTranslation', false), 'signed_out');
  assert.equal(settings.enablePdfTranslation, true);
});

test('featureState refuses a key it does not govern', () => {
  assert.throws(() => gate.featureState({ showFloatBall: true }, 'showFloatBall', true), /not an account-backed feature/);
});

/** Stand in for both storage areas readFeatureState() reads. */
function withStorage({ sync = {}, token = '' } = {}) {
  const reads = [];
  globalThis.chrome = {
    storage: {
      sync: { get: async (defaults) => { reads.push(defaults); return { ...defaults, ...sync }; } },
      local: { get: async (defaults) => ({ ...defaults, comicToken: token }) },
    },
  };
  return reads;
}

test('readFeatureState reads the switch and the sign-in now, and a missing switch is its default', async () => {
  const S = gate.FEATURE_STATES;
  for (const key of gate.ACCOUNT_FEATURE_KEYS) {
    const reads = withStorage();
    assert.equal(await gate.readFeatureState(key), S.SIGNED_OUT, `${key} never set, signed out`);
    assert.deepEqual(reads, [{ [key]: gate.FEATURE_DEFAULTS[key] }], 'asked storage without the one default');
    withStorage({ token: 'a-token' });
    assert.equal(await gate.readFeatureState(key), S.READY, `${key} never set, signed in`);
    withStorage({ sync: { [key]: false }, token: 'a-token' });
    assert.equal(await gate.readFeatureState(key), S.OFF, `${key} turned off, signed in`);
  }
  await assert.rejects(gate.readFeatureState('showFloatBall'), /not an account-backed feature/);
});

// One copy of the two defaults. The three settings tables spread
// FEATURE_DEFAULTS and every storage read of the switch goes through
// readFeatureState(); a literal default anywhere else is a second answer to
// "is this feature on for someone who never touched it", and those drift.
// Production sources only — tests set the switches to both values on purpose.
test('no production source outside the gate spells out a default for the two switches', () => {
  const SKIP = new Set(['.git', 'node_modules', 'test', 'docs', 'vendor', 'brand', 'icons', '_locales']);
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIP.has(entry.name) && !entry.name.startsWith('.')) walk(rel);
      } else if (/\.(m?js|html)$/.test(entry.name)) {
        files.push(rel);
      }
    }
  };
  walk('');
  assert.ok(files.includes('shared/default-settings.js') && files.includes('options/options.js'),
    'the walk no longer reaches the settings tables');
  const literal = /['"]?enable(?:Comic|Pdf)Translation['"]?\s*:\s*(?:true|false)\b/;
  const offenders = files
    .filter((rel) => rel !== 'shared/account-gate.js' && literal.test(repoFile(rel)))
    .map((rel) => `${rel}: ${repoFile(rel).match(literal)[0]}`);
  assert.deepEqual(offenders, [], 'spread AccountGate.FEATURE_DEFAULTS or call AccountGate.readFeatureState()');
});

test('every list that loads default-settings.js loads the gate before it', () => {
  // The content defaults spread AccountGate.FEATURE_DEFAULTS as they load.
  const manifest = JSON.parse(repoFile('manifest.json'));
  const scripts = manifest.content_scripts.find(entry => entry.js.includes('shared/default-settings.js')).js;
  assert.ok(scripts.indexOf('shared/account-gate.js') !== -1 &&
    scripts.indexOf('shared/account-gate.js') < scripts.indexOf('shared/default-settings.js'), 'manifest.json');
  for (const file of ['options/options.html', 'onboarding/onboarding.html']) {
    const html = repoFile(file);
    const tag = (src) => html.indexOf(`<script src="${src}"`);
    assert.ok(tag('../shared/account-gate.js') !== -1 &&
      tag('../shared/account-gate.js') < tag('../shared/default-settings.js'), file);
  }
});

test('hasAccount reads the token, and a storage failure fails closed', async () => {
  withToken('a-token');
  assert.equal(await gate.hasAccount(), true);
  withToken('');
  assert.equal(await gate.hasAccount(), false);
  globalThis.chrome = { storage: { local: { get: async () => { throw new Error('context invalidated'); } } } };
  assert.equal(await gate.hasAccount(), false);
});

// The superseded mechanism, applyAccountGate, rewrote both switches to false on
// a signed-out device. Nothing may bring that shape back: one mechanism only.
test('no surface rewrites the switches to express sign-in any more', () => {
  assert.equal(gate.applyAccountGate, undefined);
  for (const file of ['content/content-bootstrap.js', 'popup/popup.js', 'popup/popup-pdf.js',
    'background/feature-gate.js', 'background/context-menus.js', 'options/options-account.js']) {
    assert.doesNotMatch(repoFile(file), /applyAccountGate|getGatedSettings/, `${file} still uses the old gate`);
  }
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
