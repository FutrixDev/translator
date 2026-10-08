// What a failed Blab Translation request says to the reader, and what it tells
// the page (background/api-errors.js, design §5.2): the account's three states
// are worded as themselves and end the page's pass (passFatal), the two a reader
// can fix carry their entry (subscribe / sign in); every other failure is worded
// as Blab's own service (D-490 N3), never as the user's API, and the page keeps
// going.
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.chrome = {
  runtime: { getPlatformInfo: async () => ({ os: 'mac' }) },
  i18n: { getUILanguage: () => 'en' },
  storage: { local: { get: async (d) => ({ ...d }), set: async () => {}, remove: async () => {} } },
};

await import('../../shared/lang-tags.js');
await import('../../shared/site-rules-builtin.js');
await import('../../shared/storage-writer.js');
await import('../../shared/site-rules.js');
await import('../../shared/sync-collection.js');
await import('../../shared/api-compat.js');
await import('../../shared/ai-profiles.js');
await import('../../shared/engines.js');
await import('../../i18n/messages.js');
await import('../../i18n/lang/en.js');
await import('../../i18n/lang/zh-CN.js');
const { apiErrorMessage, missingApiKeyMessage, replyError } = await import('../../background/api-errors.js');

const BLAB = globalThis.Engines.BLAB_PROFILE;
const en = { uiLanguage: 'en' };
const zh = { uiLanguage: 'zh-CN' };
const msg = (key, lang) => globalThis.getMessage(key, lang);

function failure(fields) {
  const error = new Error(`HTTP ${fields.status}`);
  error.apiFailure = { network: false, detail: '', endpoint: 'http://blab.test/api/blab/complete', ...fields };
  return error;
}

function quietly(fn) {
  const saved = console.error;
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.error = saved;
  }
}

test('blab errors: the Blab profile needs no API key; a keyless user profile still does', () => {
  assert.equal(missingApiKeyMessage(BLAB, en), '');
  const keyless = { id: 'p1', provider: 'openai', apiEndpoint: 'https://api.openai.com/v1/chat/completions', apiKey: '', modelName: 'gpt-4.1-mini' };
  assert.equal(missingApiKeyMessage(keyless, en), msg('configureApiKeyFirst', 'en'));
});

test('blab errors: daily_limit names the local time the allowance comes back, in the UI language', () => {
  const resetsAt = '2026-10-08T00:00:00Z';
  for (const [settings, lang] of [[en, 'en'], [zh, 'zh-CN']]) {
    const text = apiErrorMessage(failure({ status: 429, blab: 'daily_limit', retryable: false, resetsAt }), settings, BLAB);
    const time = new Date(resetsAt).toLocaleString(lang, { dateStyle: 'short', timeStyle: 'short' });
    assert.equal(text, msg('blabDailyLimit', lang).replace('{time}', time));
    assert.ok(text.includes(time));
    assert.ok(!text.includes('{time}'));
  }
});

test('blab errors: plan_required and unauthorized read as the account state, not as an API key problem', () => {
  assert.equal(apiErrorMessage(failure({ status: 403, blab: 'plan_required', retryable: false }), en, BLAB), msg('blabPlanRequired', 'en'));
  assert.equal(apiErrorMessage(failure({ status: 401, blab: 'unauthorized', retryable: false }), en, BLAB), msg('blabSignInRequired', 'en'));
  // No token on this device: apiFetch answers unauthorized with status 0 and nothing is sent.
  assert.equal(apiErrorMessage(failure({ status: 0, blab: 'unauthorized', retryable: false }), zh, BLAB), msg('blabSignInRequired', 'zh-CN'));
});

test('blab errors: the account wording sends nobody to Settings, and a timeout names no seconds (D-497 R1-N6, F6)', () => {
  // The way out is the entry on the bar or card (Subscribe opens pricing, Sign in
  // signs in): a message that says "in Settings" points somewhere else.
  const settingsWord = { en: /settings/i, 'zh-CN': /设置/, 'zh-TW': /設定/, ja: /設定/, ko: /설정/, de: /Einstellungen/,
    fr: /paramètres/i, es: /configuración/i, pt: /configurações/i, ru: /настройк/i };
  for (const [lang, word] of Object.entries(settingsWord)) {
    for (const key of ['blabPlanRequired', 'blabSignInRequired']) {
      const text = msg(key, lang);
      assert.ok(text && !word.test(text), `${lang} ${key}: ${text}`);
    }
    const timeout = msg('blabErrorTimeout', lang);
    assert.ok(timeout && !/\d|\{seconds\}/.test(timeout), `${lang} blabErrorTimeout: ${timeout}`);
  }
  const said = apiErrorMessage(failure({ status: 0, timeout: true, seconds: 90 }), en, BLAB);
  assert.equal(said, msg('blabErrorTimeout', 'en'));
  assert.ok(!/\d/.test(said), said);
});

test('blab errors: the three account states end the page pass; a 502 does not', () => {
  const cases = [
    [failure({ status: 429, blab: 'daily_limit', retryable: false, resetsAt: '2026-10-08T00:00:00Z' }), true],
    [failure({ status: 403, blab: 'plan_required', retryable: false }), true],
    [failure({ status: 401, blab: 'unauthorized', retryable: false }), true],
    [failure({ status: 502, blab: 'upstream_failed' }), false],
    [failure({ status: 413, blab: 'too_large' }), false],
  ];
  for (const [error, fatal] of cases) {
    const reply = quietly(() => replyError('Translation', error, { settings: en, profile: BLAB, feature: 'page' }));
    assert.equal(typeof reply.error, 'string');
    assert.equal(reply.passFatal === true, fatal, `${error.apiFailure.blab} passFatal=${fatal}`);
  }
});

test('blab errors: a failure is logged once with the profile id and never the text', () => {
  const logged = [];
  const saved = console.error;
  console.error = (...args) => logged.push(args);
  try {
    replyError('Translation', failure({ status: 403, blab: 'plan_required', retryable: false }), { settings: en, profile: BLAB, feature: 'page' });
  } finally {
    console.error = saved;
  }
  assert.equal(logged.length, 1);
  assert.match(String(logged[0][0]), /profile blab:service, feature page/);
});

test('blab errors: the service failures are worded as Blab, never as the user\'s API address or key (D-490 N3)', () => {
  const cases = [
    [failure({ status: 0, network: true }), msg('blabErrorNetwork', 'en')],
    [failure({ status: 0, timeout: true, seconds: 90 }), msg('blabErrorTimeout', 'en')],
    [failure({ status: 200, empty: true }), msg('blabErrorEmpty', 'en')],
    [failure({ status: 429, blab: 'rate_limited' }), msg('blabErrorBusy', 'en')],
    [failure({ status: 503, rateLimitedWait: 120 }), msg('blabErrorBusy', 'en')],
    [failure({ status: 502, blab: 'upstream_failed' }), msg('blabErrorBusy', 'en')],
    [failure({ status: 413, blab: 'too_large' }), msg('blabErrorRequest', 'en').replace('{status}', '413')],
  ];
  for (const [error, expected] of cases) {
    const text = apiErrorMessage(error, en, BLAB);
    assert.equal(text, expected, JSON.stringify(error.apiFailure));
    assert.ok(!/\{\w+\}/.test(text), `placeholder left in: ${text}`);
  }
  // The same failure from the user's own AI keeps the shared API wording.
  const own = { id: 'p1', provider: 'openai', apiEndpoint: 'https://api.openai.com/v1/chat/completions', apiKey: 'k', modelName: 'gpt-4.1-mini' };
  assert.notEqual(apiErrorMessage(failure({ status: 502 }), en, own), msg('blabErrorBusy', 'en'));
});

test('blab errors: the account failure a reader can fix carries its entry; today\'s allowance has none (D-490 N2)', () => {
  const cases = [
    [failure({ status: 403, blab: 'plan_required', retryable: false }), 'subscribe'],
    [failure({ status: 401, blab: 'unauthorized', retryable: false }), 'signin'],
    [failure({ status: 429, blab: 'daily_limit', retryable: false, resetsAt: '2026-10-08T00:00:00Z' }), undefined],
    [failure({ status: 502, blab: 'upstream_failed' }), undefined],
  ];
  for (const [error, action] of cases) {
    const reply = quietly(() => replyError('Translation', error, { settings: en, profile: BLAB, feature: 'page' }));
    assert.equal(reply.action, action, `${error.apiFailure.blab} action`);
  }
});
