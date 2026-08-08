// Guard for the E2E suite's own setup, not for shipped code.
//
// Translation has two backends (content/content-translation-engine.js): Chrome's
// on-device Translator API, which is the shipped default, and the user's own
// OpenAI-compatible endpoint. A spec that mocks that endpoint and then asserts on
// the traffic it receives is testing the second one — but unless it writes
// `translationEngine: 'ai'` into settings, the content script tries the first, and
// the headless Chrome this suite drives reports every language pack as
// 'downloadable' and never finishes create(). The mock is then never called and
// the spec fails on a timeout that says nothing about the missing setting.
//
// That is a whole afternoon to diagnose and one line to prevent, so the pairing
// "mocks the translation API from a content script" => "pins the AI engine" is
// asserted here instead of left to whoever writes the next spec.
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const E2E_DIR = new URL('../e2e/', import.meta.url);

// Every way a spec currently stands in for the translation API: the shared
// fast-batch mock, a private http server on 127.0.0.1 answering chat/completions,
// and Playwright route interception of the real OpenAI host.
const MOCKS_TRANSLATION_API = [
  /startMockOpenAIServer/,
  /127\.0\.0\.1:\$\{port\}\/v1\/chat\/completions/,
  /route\(\s*['"]https:\/\/api\.openai\.com/,
];

// The engine only picks a backend for translations the content script performs.
// The options page's own "test connection" probe calls the endpoint directly and
// is unaffected, which is why mocking the API is not on its own enough to require
// the pin — feature-settings.spec.js mocks it for exactly that probe. Reaching for
// any `ai-translator-*` node is what marks a spec as driving the content script.
const DRIVES_CONTENT_SCRIPT = /ai-translator-/;

const PIN = /translationEngine:\s*'ai'/;

const specs = readdirSync(E2E_DIR)
  .filter((name) => name.endsWith('.spec.js'))
  .map((name) => ({ name, source: readFileSync(new URL(name, E2E_DIR), 'utf8') }));

const needPin = specs.filter(({ source }) =>
  MOCKS_TRANSLATION_API.some((re) => re.test(source)) && DRIVES_CONTENT_SCRIPT.test(source));

test('the guard still recognizes the specs it is meant to cover', () => {
  // Without this, a drifted pattern turns the assertion below into a no-op that
  // passes forever. These four are the ones that mock the API and translate in a
  // page; add to the list when a fifth arrives.
  assert.deepEqual(needPin.map((s) => s.name).sort(), [
    'clipped-container-translation.spec.js',
    'input-translation.spec.js',
    'page-translation-highlight-class.spec.js',
    'page-translation-inline-skip.spec.js',
    'video-caption-translation.spec.js',
    'youtube-caption-translation.spec.js',
  ]);
});

test('every e2e spec that mocks the translation API from a page pins translationEngine: ai', () => {
  const missing = needPin.filter(({ source }) => !PIN.test(source)).map(({ name }) => name);

  assert.deepEqual(missing, [], 'these e2e specs mock the translation API but leave the engine on its '
    + `'builtin' default, so the mock is never called and they time out: ${missing.join(', ')}`);
});

test('the options page connection probe is not asked to pin an engine', () => {
  // The counter-example the rule above is shaped around. If this spec ever does
  // start driving the content script, the guard will begin requiring the pin and
  // this assertion is the place that says why that is a change, not a bug.
  const probe = specs.find((s) => s.name === 'feature-settings.spec.js');
  assert.ok(probe, 'feature-settings.spec.js is missing');
  assert.ok(MOCKS_TRANSLATION_API.some((re) => re.test(probe.source)));
  assert.equal(DRIVES_CONTENT_SCRIPT.test(probe.source), false);
});
