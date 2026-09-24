// The popup's footer used to read `!settings.apiKey` and tell every default
// user "API Not Configured" — an error about a thing the default engine does
// not use. Readiness is a property of the engine in the tab in front of you,
// and shared/engine-status.js is where that judgement lives.
//
// Two rules this suite exists to hold:
//   1. not knowing is not the same as knowing something is wrong
//   2. falling back to the user's own API spends their money, so it is opt-in
//      and it is never silent
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { engineSource, familyPaths } from './helpers/sources.mjs';

const repoFile = (rel) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');

// engine-status.js reads APICompat at call time (the AI engine's readiness is
// APICompat.isApiKeyMissing), and every page loads api-compat.js before it.
await import('../../shared/api-compat.js');
await import('../../shared/engine-status.js');
await import('../../shared/default-settings.js');
await import('../../i18n/messages.js');
const ES = globalThis.EngineStatus;
const { getMessage, UI_LANGUAGES } = globalThis;

// ----------------------------------------------------- why it is not here

test('the version is asked first, because it is the only fact that stands alone', () => {
  // Translator is [SecureContext], so on an http:// page it is absent whatever
  // the browser version — its absence alone cannot tell the two apart.
  const reason = (env) => ES.builtinUnsupportedReason(env);

  assert.equal(reason({ secureContext: true, hasTranslator: true, chromeMajor: 140 }), '');

  // Chrome 116–137: the extension runs, the Translator does not exist yet.
  assert.equal(reason({ secureContext: true, hasTranslator: false, chromeMajor: 137 }), 'oldBrowser');
  // Same browser over http — still the version that is wrong, and we can say so.
  assert.equal(reason({ secureContext: false, hasTranslator: false, chromeMajor: 137 }), 'oldBrowser');

  // New enough, but this page is not a secure context.
  assert.equal(reason({ secureContext: false, hasTranslator: false, chromeMajor: 140 }), 'insecureContext');
  // Version unknown (an http:// page has no navigator.userAgentData, and the
  // UA string may not name Chrome at all) — the scheme is what we can see.
  assert.equal(reason({ secureContext: false, hasTranslator: false, chromeMajor: 0 }), 'insecureContext');

  // Secure, recent, and still no API: another Chromium build, or a channel
  // where the feature is off. We do not invent a reason for it.
  assert.equal(reason({ secureContext: true, hasTranslator: false, chromeMajor: 0 }), 'noApi');
  assert.equal(reason({ secureContext: true, hasTranslator: false, chromeMajor: 140 }), 'noApi');
});

test('the cutoff is the Chrome release the Translator API shipped in', () => {
  assert.equal(ES.BUILTIN_MIN_CHROME, 138);
  // And manifest.json deliberately does not follow it: everything else works
  // on 116, so a user with their own API key still has a working extension.
  // The status line is what keeps that honest.
  const manifest = JSON.parse(repoFile('manifest.json'));
  assert.equal(manifest.minimum_chrome_version, '116');
});

// ------------------------------------------------------ the one status line

const probe = (over = {}) => Object.assign({
  engine: 'builtin', supported: true, reason: '', availability: 'available', lastFallback: null
}, over);

test('only the AI engine is judged by the API key', () => {
  assert.deepEqual(
    ES.describeEngineStatus({ translationEngine: 'ai', apiKey: '' }, null),
    { key: 'apiNotConfigured', detailKey: '', ok: false });
  assert.deepEqual(
    ES.describeEngineStatus({ translationEngine: 'ai', apiKey: 'sk-x' }, null),
    { key: 'ready', detailKey: '', ok: true });

  // A local model server needs no key: the Ollama / LM Studio presets, or any
  // loopback / LAN endpoint. The rule is APICompat's, not a second copy here.
  for (const local of [
    { provider: 'ollama', apiEndpoint: 'http://localhost:11434/v1/chat/completions' },
    { provider: 'lmstudio', apiEndpoint: 'http://localhost:1234/v1/chat/completions' },
    { provider: 'custom', apiEndpoint: 'http://127.0.0.1:8080/v1/chat/completions' },
    { provider: 'custom', apiEndpoint: 'http://192.168.1.20:11434/v1/chat/completions' },
  ]) {
    assert.deepEqual(
      ES.describeEngineStatus({ translationEngine: 'ai', apiKey: '', ...local }, null),
      { key: 'ready', detailKey: '', ok: true }, JSON.stringify(local));
  }
  // A remote endpoint still does, whatever the preset is called.
  assert.equal(ES.describeEngineStatus({
    translationEngine: 'ai', apiKey: '  ', provider: 'custom', apiEndpoint: 'https://api.example.com/v1/chat/completions',
  }, null).key, 'apiNotConfigured');

  // The regression this file is named after: the default engine is key-free,
  // so a missing key is not an error and must not be reported as one.
  const status = ES.describeEngineStatus({ translationEngine: 'builtin', apiKey: '' }, probe());
  assert.equal(status.key, 'statusBuiltinReady');
  assert.equal(status.ok, true);
});

test('a page with no content script is a different answer from a slow one', () => {
  // chrome://, the Web Store, a tab we are not injected into.
  const absent = ES.describeEngineStatus({ translationEngine: 'builtin' }, null);
  assert.equal(absent.key, 'statusPageUnsupported');
  assert.equal(absent.ok, false);

  // A probe that did not come back in time is not evidence of a problem, so
  // it must not paint the error state.
  const slow = ES.describeEngineStatus({ translationEngine: 'builtin' }, ES.UNKNOWN_PROBE);
  assert.equal(slow.ok, true);
  assert.equal(slow.key, 'ready');
});

test('an unusable engine says why, in the same words everywhere', () => {
  for (const reason of ['oldBrowser', 'insecureContext', 'noApi']) {
    const status = ES.describeEngineStatus({}, probe({ supported: false, reason }));
    assert.equal(status.key, 'statusBuiltinUnavailable');
    assert.equal(status.detailKey, ES.REASON_MESSAGE_KEYS[reason]);
    assert.equal(status.ok, false);
  }
  // An unsupported language pair is the same sentence with a different reason.
  const pair = ES.describeEngineStatus({}, probe({ availability: 'unavailable' }));
  assert.equal(pair.key, 'statusBuiltinUnavailable');
  assert.equal(pair.detailKey, 'builtinUnsupportedPair');
  assert.equal(pair.ok, false);
});

test('a language pack on its way is progress, not a fault', () => {
  for (const availability of ['downloadable', 'downloading']) {
    const status = ES.describeEngineStatus({}, probe({ availability }));
    assert.equal(status.key, 'statusBuiltinPreparing');
    assert.equal(status.ok, true);
  }
  // Answered, but the page's language is not settled yet. Nothing is known to
  // be wrong, so nothing is claimed to be.
  const unknown = ES.describeEngineStatus({}, probe({ availability: 'unknown' }));
  assert.equal(unknown.key, 'ready');
  assert.equal(unknown.ok, true);
});

test('a fallback that already happened outranks whatever the engine says now', () => {
  // Billing the user's own API is the one thing that must never pass in
  // silence, so it is reported even though the engine looks fine again.
  const status = ES.describeEngineStatus({}, probe({ lastFallback: { reason: 'needsDownload', at: 1 } }));
  assert.equal(status.key, 'statusEngineFellBack');
  assert.equal(status.detailKey, 'builtinNeedsDownload');
});

test('every reason the engine can raise has a sentence', () => {
  // The translate path's own reason codes, from the engine family.
  const source = engineSource();
  const block = source.slice(source.indexOf('const ENGINE_REASONS'));
  const codes = [...block.slice(0, block.indexOf('};')).matchAll(/:\s*'([a-zA-Z]+)'/g)].map(m => m[1]);
  assert.ok(codes.length >= 5, 'ENGINE_REASONS moved — this test is reading the wrong block');
  for (const code of [...codes, 'oldBrowser', 'insecureContext', 'noApi']) {
    assert.ok(ES.REASON_MESSAGE_KEYS[code],
      `noteFallback('${code}') would show the user an empty parenthesis`);
  }
});

test('every key the status line can name exists in every language', () => {
  const keys = [
    'ready', 'apiNotConfigured', 'statusBuiltinReady', 'statusBuiltinPreparing',
    'statusBuiltinUnavailable', 'statusPageUnsupported', 'statusEngineFellBack',
    ...Object.values(ES.REASON_MESSAGE_KEYS)
  ];
  for (const lang of UI_LANGUAGES) {
    for (const key of new Set(keys)) {
      const text = getMessage(key, lang);
      assert.notEqual(text, key, `${lang} falls through to the key for '${key}'`);
      assert.equal(text, globalThis.I18N_MESSAGES[lang][key],
        `${lang} has no '${key}' of its own — it is borrowing English`);
    }
  }
});

// ------------------------------------------------------- the money question

test('falling back to the user own API is off unless they asked for it', () => {
  const source = engineSource();
  const fn = source.slice(source.indexOf('async function canFallBackToAI'));
  const body = fn.slice(0, fn.indexOf('\n  }'));
  assert.match(body, /settings\.engineFallback !== 'allow-ai'/,
    'canFallBackToAI no longer consults engineFallback, so the built-in engine can quietly start billing again');
  // And the gate comes before the AI-config lookup, so no storage read happens
  // for a decision that is already made.
  assert.ok(body.indexOf('aiConfig') > 0, 'the AI-config lookup moved; re-judge this ordering');
  assert.ok(body.indexOf('engineFallback') < body.indexOf('aiConfig'));
});

test('local-only is the default, in the one dictionary the content scripts read', () => {
  assert.equal(globalThis.DefaultSettings.CONTENT_DEFAULTS.engineFallback, 'local-only');
  // The settings page keeps its own dictionary (it is the form's initial
  // values, not a copy) — it must agree on this one.
  assert.match(repoFile('options/options.js'), /engineFallback: 'local-only'/);
  assert.match(repoFile('options/options.html'), /<option value="local-only"/);
});

test('a fallback that does happen leaves a trace the popup can read', () => {
  const source = engineSource();
  // Every branch that gives up on the built-in engine and posts to the service
  // worker instead has to say so.
  const calls = source.match(/noteFallback\(/g) || [];
  assert.ok(calls.length >= 3, 'a fallback path stopped recording itself');
  assert.match(source, /probeStatus/, 'the popup has no way to ask');
  // In memory, not storage: the trace belongs to this page and should die with it.
  const note = source.slice(source.indexOf('function noteFallback'));
  assert.doesNotMatch(note.slice(0, note.indexOf('\n  }')), /chrome\.storage/);
});

// ------------------------------------------------------------- the wiring

test('the probe reaches the only realm that can answer it', () => {
  // The popup's own isSecureContext is always true; the tab's may not be.
  assert.match(repoFile('popup/popup.js'), /type: 'PROBE_ENGINE'/);
  const messaging = repoFile('content/content-messaging.js');
  assert.match(messaging, /case 'PROBE_ENGINE'/);
  // It is the only asynchronous reply in that listener, so it is the only
  // branch that may hold the channel open.
  assert.equal((messaging.match(/return true;/g) || []).length, 1);
});

test('the status line has exactly one writer', () => {
  const popup = repoFile('popup/popup.js');
  // renderStatus() is it. A second place writing the text alone leaves the dot
  // saying the opposite — translationFailed used to show a green one — and a
  // second place touching the class leaves it stuck, because add() without a
  // matching remove() is how the error state became permanent.
  assert.equal((popup.match(/elements\.statusText\.textContent\s*=/g) || []).length, 1);
  assert.equal((popup.match(/classList\.(?:add|remove|toggle)\('status-error'/g) || []).length, 1);
  assert.match(popup, /classList\.toggle\('status-error'/, 'the error state is set but never cleared');

  // And nothing re-applies i18n over it: applyI18n() writes every [data-i18n]
  // element's textContent, so the status span must not be one of them.
  assert.doesNotMatch(repoFile('popup/popup.html'), /id="statusText"[^>]*data-i18n/);
});

test('engine-status.js is loaded wherever it is read', () => {
  // The engine module calls into it, so every page that loads the engine needs
  // it too — the settings page loads content-translation-engine.js to drive the
  // language-pack button, and reads the reason for its own status line.
  for (const page of ['popup/popup.html', 'options/options.html']) {
    assert.match(repoFile(page), /shared\/engine-status\.js/, `${page} is missing it`);
  }
  const js = JSON.parse(repoFile('manifest.json')).content_scripts
    .find(entry => entry.matches.includes('<all_urls>')).js;
  // No module system in the content scripts — order is the dependency graph.
  assert.ok(js.indexOf('shared/engine-status.js') >= 0, 'not in the content scripts at all');
  assert.ok(js.indexOf('shared/engine-status.js') < js.indexOf('content/content-translation-engine.js'));

  // And engine-status.js asks APICompat whether the AI engine has what it needs,
  // so shared/api-compat.js comes before it in all three load lists. A page
  // without it throws on the first status line drawn with the AI engine.
  const lists = {
    'manifest.json': (file) => js.indexOf(file),
    'popup/popup.html': (file) => repoFile('popup/popup.html').indexOf(`<script src="../${file}"></script>`),
    'options/options.html': (file) => repoFile('options/options.html').indexOf(`<script src="../${file}"></script>`),
  };
  for (const [name, at] of Object.entries(lists)) {
    assert.ok(at('shared/api-compat.js') >= 0, `${name} does not load shared/api-compat.js`);
    assert.ok(at('shared/api-compat.js') < at('shared/engine-status.js'),
      `${name} must load shared/api-compat.js before shared/engine-status.js`);
  }
});

test('both load lists carry the whole engine family, after the lang-tags it needs', () => {
  // The options page does not go through the manifest; it lists its own
  // <script> tags one by one. A new file in the family that only makes it into
  // the manifest leaves the options page calling an eng.toApiLang nobody put on
  // the shelf the moment "download language pack" is clicked — and no e2e
  // clicks that page every day.
  const html = repoFile('options/options.html');
  const js = JSON.parse(repoFile('manifest.json')).content_scripts
    .find(entry => entry.matches.includes('<all_urls>')).js;
  const lists = {
    'manifest.json': (file) => js.indexOf(file),
    'options/options.html': (file) => html.indexOf(`<script src="../${file}"></script>`),
  };
  for (const [name, at] of Object.entries(lists)) {
    for (const file of familyPaths('content/engine', 'content/content-translation-engine.js')) {
      assert.ok(at(file) >= 0, `${name} is missing ${file}`);
      assert.ok(at('shared/lang-tags.js') < at(file), `${name} must load shared/lang-tags.js before ${file}`);
    }
  }
});
