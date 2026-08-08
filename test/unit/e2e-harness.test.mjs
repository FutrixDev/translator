// Guards for the E2E harness's baseline settings — E2E_BASE_SETTINGS in
// test/e2e/helpers.js.
//
// The bug these exist for: the harness wrote apiEndpoint / apiKey / modelName
// and left `translationEngine` alone, so every spec ran against the shipped
// default — Chrome's built-in on-device Translator. In the test browser that
// engine is present and answers `downloadable` for en→zh, i.e. it wants a
// language pack that never finishes downloading there, and every await on
// `Translator.create()` hangs for good. Five specs failed as bare timeouts,
// with the mock OpenAI server they had just stood up showing zero requests and
// nothing in the output pointing at the engine.
//
// That failure is invisible from inside a spec, and the fix is a single value in
// one place, so it is asserted here rather than trusted to stay put.
//
// This supersedes test/unit/e2e-translation-engine-pinned.test.mjs, which fixed
// the same bug the other way round: each spec wrote the pin itself, and that
// test asserted they had, via a heuristic — "mocks the translation API" AND
// "reaches for an ai-translator-* node" — backed by a hand-maintained list of
// the six specs then matching. Two problems it named itself. The list has to be
// edited whenever a seventh arrives, and the patterns can drift into matching
// nothing, which is why it carried a second test guarding its own regexes.
// Worse, the heuristic could not see hover-translation.spec.js, which failed for
// exactly this reason without mocking the API in any shape the patterns knew.
// Pinning the engine for every context needs no heuristic, no list, and no
// second guard, so the two cannot coexist: that one required the line in each
// spec, this one requires its absence.
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const repoFile = (rel) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');
const require = createRequire(import.meta.url);

// helpers.js pulls in nothing — no Playwright, no browser — so it imports here
// as plainly as any other module.
const helpers = require('../e2e/helpers.js');

/**
 * Stand in for the Playwright page/context/service-worker chain, and capture
 * what would have been handed to chrome.storage.sync.set.
 */
function fakePage() {
  const writes = [];
  const worker = { evaluate: async (_fn, settings) => { writes.push(settings); } };
  const context = {
    serviceWorkers: () => [worker],
    waitForEvent: async () => worker,
  };
  return { writes, context, page: { context: () => context } };
}

test('a spec that configures an API endpoint is not answered by the built-in engine', async () => {
  const { writes, page } = fakePage();
  await helpers.setExtensionSettings(page, {
    apiEndpoint: 'http://127.0.0.1:9/v1/chat/completions',
    apiKey: 'test-key',
  });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].translationEngine, 'ai',
    'the mock server a spec stands up never sees a request unless the AI backend is selected');
  // The caller's own settings still arrive intact.
  assert.equal(writes[0].apiEndpoint, 'http://127.0.0.1:9/v1/chat/completions');
  assert.equal(writes[0].apiKey, 'test-key');
});

test('a spec that asks for the built-in engine still gets it', async () => {
  const { writes, page } = fakePage();
  await helpers.setExtensionSettings(page, { translationEngine: 'builtin' });
  assert.equal(writes[0].translationEngine, 'builtin',
    'the baseline is a default, not an override — a spec about the built-in path must be able to say so');
});

test('a spec that sets no settings at all is covered by the fixture', async () => {
  const { writes, context } = fakePage();
  await helpers.applyBaseSettings(context);
  assert.deepEqual(writes, [{ translationEngine: 'ai' }]);

  // Most of hover-translation.spec.js never calls setExtensionSettings, so the
  // baseline has to be applied per context rather than per settings call.
  assert.match(repoFile('test/e2e/fixtures.js'), /await applyBaseSettings\(context\)/,
    'fixtures.js must apply the baseline to every browser context');
});

test('the pin is load-bearing: the shipped default is a different engine', () => {
  const shipped = repoFile('background/background.js').match(/translationEngine: '([a-z]+)'/)?.[1];
  assert.equal(shipped, 'builtin', 'background/background.js no longer declares a default engine by that name');
  assert.notEqual(shipped, helpers.E2E_BASE_SETTINGS.translationEngine,
    'if the extension ever ships the AI backend as its default, drop the pin and this test with it');
});

test("'ai' is the only value that turns the built-in engine off", () => {
  // isBuiltinSelected() treats every other value — including a missing one — as
  // built-in, so the baseline has to spell this one exactly.
  assert.match(repoFile('content/content-translation-engine.js'), /settings\.translationEngine !== 'ai'/,
    'the content script decides the engine by this comparison; E2E_BASE_SETTINGS has to match it');
});

const specFiles = () => readdirSync(fileURLToPath(new URL('../e2e/', import.meta.url)))
  .filter(name => name.endsWith('.spec.js'));

test('no spec restates the engine the harness already pins', () => {
  const offenders = specFiles()
    .filter(name => /translationEngine:\s*'ai'/.test(repoFile(`test/e2e/${name}`)));
  assert.deepEqual(offenders, [],
    'E2E_BASE_SETTINGS in test/e2e/helpers.js already selects the AI backend for every spec');
});

// The engine bug was one spelling of a broader habit: reaching for chrome.* by
// hand-rolling the service-worker lookup in whichever spec needed it first.
// Five specs held a copy — two of them a byte-identical getSetting(), one
// spelled `const [existing] = context.serviceWorkers()` so a grep for the
// others missed it. That is how the write path came to have a single place to
// configure and the read path none, which is what let the engine default go
// unnoticed. Reaching the worker is helpers.js's job now.
//
// Only the lookup is banned, not worker.evaluate: comic-account.spec.js holds a
// worker to stub chrome.contextMenus and to read storage with a defaults
// object, and both are real work in the worker rather than a settings read.
test('no spec re-derives the extension service worker', () => {
  const offenders = specFiles()
    .filter(name => /context\.serviceWorkers\(\)/.test(repoFile(`test/e2e/${name}`)));
  assert.deepEqual(offenders, [],
    'use getServiceWorker / getSyncSetting / getSyncSettings from test/e2e/helpers.js');
});
