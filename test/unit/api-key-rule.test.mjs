// One rule for "does this configuration need an API key", and one describer
// for "what went wrong with the request", both in shared/api-compat.js.
//
// Before this file there were nine places that each asked `!settings.apiKey`
// on their own, and none of them knew that a local model server (Ollama,
// LM Studio, a box on the LAN) takes no key: every one of them refused a
// perfectly good local setup. The error text had the opposite problem: it was
// written in Chinese, in a layer that does not know the reader's language.
//
// So this suite holds four things:
//   1. the predicate's truth table (what counts as local, and what does not)
//   2. no caller judges the key on its own again (a scan, with a self-check)
//   3. an empty key sends no auth header at all
//   4. every failure is described through the caller's own t(), in the
//      reader's language, and no Chinese literal is left in the code paths
//      that used to produce one
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

await import('../../shared/api-compat.js');
await import('../../i18n/messages.js');
const A = globalThis.APICompat;
const { getMessage, UI_LANGUAGES } = globalThis;

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

// ------------------------------------------------------ 1. the predicate

const LOCAL = [
  // loopback
  'http://localhost:11434/v1/chat/completions',
  'http://foo.localhost:8080/v1/chat/completions',
  'http://127.0.0.1:1234/v1/chat/completions',
  'http://127.9.9.9/v1/chat/completions',
  'http://[::1]:11434/v1/chat/completions',
  // the local network, as Chrome's Local Network Access defines it
  'http://10.0.0.2:11434/v1/chat/completions',
  'http://172.16.0.1/v1/chat/completions',
  'http://172.31.255.255/v1/chat/completions',
  'http://192.168.1.20:11434/v1/chat/completions',
  'http://169.254.1.1/v1/chat/completions',
  'http://[fd00::1]/v1/chat/completions',
  'http://[fe80::1]/v1/chat/completions',
  // new URL() rewrites this to [::ffff:c0a8:102]; it must still read as LAN
  'http://[::ffff:192.168.1.2]/v1/chat/completions',
  'http://mybox.local:11434/v1/chat/completions',
];

const NOT_LOCAL = [
  'http://172.32.0.1/v1/chat/completions',
  'http://8.8.8.8/v1/chat/completions',
  // the unspecified address; Chrome refuses it outright
  'http://0.0.0.0:11434/v1/chat/completions',
  'https://api.openai.com/v1/chat/completions',
  'https://localhost.evil.com/v1/chat/completions',
  // a public name that resolves to loopback: the predicate does not ask DNS
  'http://127.0.0.1.nip.io/v1/chat/completions',
  '[::ffff:8.8.8.8]',
  'http://[::ffff:8.8.8.8]/v1',
  '',
  'not a url',
  undefined,
  null,
];

test('what counts as a local endpoint', () => {
  for (const url of LOCAL) assert.equal(A.isLocalEndpoint(url), true, url);
  for (const url of NOT_LOCAL) assert.equal(A.isLocalEndpoint(url), false, String(url));
});

test('a key is required unless the preset or the endpoint says local', () => {
  const remote = 'https://api.openai.com/v1/chat/completions';
  // The two local presets need none, whatever endpoint they were saved with.
  assert.equal(A.requiresApiKey({ provider: 'ollama', apiEndpoint: remote }), false);
  assert.equal(A.requiresApiKey({ provider: 'lmstudio', apiEndpoint: remote }), false);
  // Any preset pointed at a local endpoint needs none either.
  assert.equal(A.requiresApiKey({ provider: 'custom', apiEndpoint: 'http://192.168.1.20:11434/v1/chat/completions' }), false);
  assert.equal(A.requiresApiKey({ provider: 'openai', apiEndpoint: 'http://localhost:8080/v1/chat/completions' }), false);
  // Everything else does.
  assert.equal(A.requiresApiKey({ provider: 'openai', apiEndpoint: remote }), true);
  assert.equal(A.requiresApiKey({ provider: 'custom', apiEndpoint: 'https://gateway.example.com/v1' }), true);
  // Missing keys read as "remote, needs a key", never as local.
  assert.equal(A.requiresApiKey({}), true);
  assert.equal(A.requiresApiKey({ apiEndpoint: remote }), true);
  assert.equal(A.requiresApiKey({ provider: 'ollama' }), false);
  assert.equal(A.requiresApiKey(undefined), true);
  // A provider name that happens to be an Object.prototype key is not a preset.
  assert.equal(A.requiresApiKey({ provider: 'constructor', apiEndpoint: remote }), true);
  // Only the two local presets are key-optional.
  const optional = Object.entries(A.PROVIDERS).filter(([, p]) => p.keyOptional).map(([k]) => k).sort();
  assert.deepEqual(optional, ['lmstudio', 'ollama']);
});

test('a key is missing only where one is required, and blank counts as none', () => {
  const remote = { provider: 'openai', apiEndpoint: 'https://api.openai.com/v1/chat/completions' };
  assert.equal(A.isApiKeyMissing({ ...remote, apiKey: '' }), true);
  assert.equal(A.isApiKeyMissing({ ...remote, apiKey: '   ' }), true);
  assert.equal(A.isApiKeyMissing({ ...remote }), true);
  assert.equal(A.isApiKeyMissing({ ...remote, apiKey: 'test-key' }), false);

  const local = { provider: 'custom', apiEndpoint: 'http://127.0.0.1:11434/v1/chat/completions' };
  assert.equal(A.isApiKeyMissing({ ...local, apiKey: '' }), false);
  assert.equal(A.isApiKeyMissing({ provider: 'ollama', apiKey: '' }), false);
});

// ------------------------------------------ 2. nobody judges the key alone

// Blank every comment, keep every literal. A small state machine rather than a
// regex, because both halves of this suite read what is left: a regex cannot
// tell `'https://'` from a line comment, and a comment that mentions the old
// `!settings.apiKey` must not count as code that still does it.
function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  const lastSignificant = () => {
    let j = out.length - 1;
    while (j >= 0 && /\s/.test(out[j])) j -= 1;
    return out.slice(Math.max(0, j - 7), j + 1);
  };
  const regexMayStart = () => {
    const tail = lastSignificant();
    return tail === '' || /[(,=:[!&|?{};+\-*%<>~^}]$/.test(tail)
      || /(?:^|[^\w$])(?:return|typeof|case|do|else|in|of|void|yield|await|delete|new|throw)$/.test(tail);
  };
  const blank = (text) => text.replace(/[^\n]/g, ' ');

  function scanCode(stopAtBrace) {
    let depth = 0;
    while (i < n) {
      const c = src[i];
      const d = src[i + 1];
      if (c === '/' && d === '/') {
        const end = src.indexOf('\n', i);
        const stop = end < 0 ? n : end;
        out += blank(src.slice(i, stop));
        i = stop;
      } else if (c === '/' && d === '*') {
        const end = src.indexOf('*/', i + 2);
        const stop = end < 0 ? n : end + 2;
        out += blank(src.slice(i, stop));
        i = stop;
      } else if (c === '"' || c === "'") {
        let j = i + 1;
        while (j < n && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
        out += src.slice(i, j + 1);
        i = j + 1;
      } else if (c === '`') {
        out += c;
        i += 1;
        while (i < n && src[i] !== '`') {
          if (src[i] === '\\') {
            out += src.slice(i, i + 2);
            i += 2;
          } else if (src[i] === '$' && src[i + 1] === '{') {
            out += '${';
            i += 2;
            scanCode(true);
          } else {
            out += src[i];
            i += 1;
          }
        }
        out += src[i] || '';
        i += 1;
      } else if (c === '/' && regexMayStart()) {
        let j = i + 1;
        let inClass = false;
        while (j < n && src[j] !== '\n') {
          if (src[j] === '\\') { j += 2; continue; }
          if (src[j] === '[') inClass = true;
          else if (src[j] === ']') inClass = false;
          else if (src[j] === '/' && !inClass) break;
          j += 1;
        }
        const close = j;
        j += 1;
        while (j < n && /[a-z]/i.test(src[j])) j += 1;
        // A regex reads text (a model's reply, a page) and never shows any,
        // so its body is blanked too: ai-translate.js accepts a full-width
        // colon after "phonetic" in what the model writes back.
        out += `/${blank(src.slice(i + 1, close))}${src.slice(close, j)}`;
        i = j;
      } else {
        if (stopAtBrace) {
          if (c === '{') depth += 1;
          if (c === '}') {
            if (depth === 0) { out += c; i += 1; return; }
            depth -= 1;
          }
        }
        out += c;
        i += 1;
      }
    }
  }
  scanCode(false);
  return out;
}

// A value's truthiness taken as "is there a key". Reading, assigning, passing
// it on and storing it are all fine; deciding with it is APICompat's job.
const CHAIN = String.raw`(?:[\w$]+\??\.)*`;
const BARE_KEY_CHECKS = [
  new RegExp(String.raw`!\s*\(?\s*${CHAIN}apiKey\b`),                       // !settings.apiKey, !apiKey, !!(x.apiKey)
  new RegExp(String.raw`${CHAIN}apiKey\b(?:\.trim\(\))?\s*&&`),            // apiKey && ...
  new RegExp(String.raw`&&\s*${CHAIN}apiKey\b(?:\.trim\(\))?\s*[)&|;?]`),  // ... && apiKey)
  new RegExp(String.raw`${CHAIN}apiKey\b(?:\.trim\(\))?\s*\?(?![.?])`),    // apiKey ? a : b
  new RegExp(String.raw`if\s*\(\s*${CHAIN}apiKey\b(?:\.trim\(\))?\s*\)`),  // if (apiKey)
  new RegExp(String.raw`Boolean\(\s*${CHAIN}apiKey\b`),                     // Boolean(apiKey)
];
const bareKeyCheck = (code) => BARE_KEY_CHECKS.find((re) => re.test(code)) || null;

test('the scan catches every way of asking the key directly (self-check)', () => {
  const forbidden = [
    'if (!settings.apiKey) {',
    'if (!apiKey) return;',
    'hasApiKey = !!(result.apiKey && String(result.apiKey).trim());',
    'const ok = !!(settings.apiKey);',
    'return apiKey && endpoint;',
    'return settings.apiKey.trim() && x;',
    'if (endpoint && settings.apiKey) go();',
    'const h = apiKey ? auth : {};',
    'if (apiKey) headers.Authorization = x;',
    'if (settings?.apiKey) run();',
    'if (!elements.apiKey.value) warn();',
    'const has = Boolean(settings.apiKey);',
  ];
  for (const snippet of forbidden) assert.ok(bareKeyCheck(snippet), `not caught: ${snippet}`);

  const allowed = [
    'settings.apiKey,',
    'apiKey: \'\',',
    "const AI_CONFIG_KEYS = ['provider', 'apiEndpoint', 'apiKey'];",
    'elements.apiKey.value = result.apiKey;',
    'claudeHeaders(apiKey)',
    'const headers = claudeShape ? claudeHeaders(apiKey) : openAIHeaders(apiKey);',
    "const isPassword = elements.apiKey.type === 'password';",
    'return { provider, apiEndpoint, apiKey: elements.apiKey.value.trim() };',
    'if (APICompat.isApiKeyMissing(settings)) {',
    'x !== apiKey',
    'const k = settings?.apiKey ?? \'\';',
  ];
  for (const snippet of allowed) assert.equal(bareKeyCheck(snippet), null, `false alarm: ${snippet}`);

  // And the stripper really hides comments while keeping strings whole.
  const stripped = stripComments([
    "// if (!settings.apiKey) {",
    "/* if (!apiKey) */ const url = 'https://api.openai.com'; // !apiKey",
    'const re = /\\/\\/[^/]*/g; const s = `a ${b ? `c` : \'d\'} // not a comment`;',
  ].join('\n'));
  assert.equal(bareKeyCheck(stripped), null);
  assert.match(stripped, /'https:\/\/api\.openai\.com'/);
  assert.match(stripped, /\/\/ not a comment`/);
});

function jsFiles(dir) {
  const out = [];
  for (const name of readdirSync(path.join(ROOT, dir))) {
    const rel = `${dir}/${name}`;
    if (statSync(path.join(ROOT, rel)).isDirectory()) out.push(...jsFiles(rel));
    else if (name.endsWith('.js')) out.push(rel);
  }
  return out;
}

test('outside shared/api-compat.js, nothing judges the API key on its own', () => {
  const dirs = ['background', 'content', 'shared', 'popup', 'options', 'pdf', 'offscreen'];
  const files = dirs.flatMap(jsFiles).filter((rel) => rel !== 'shared/api-compat.js');
  assert.ok(files.length > 50, `only ${files.length} files scanned; the scan may be looking in the wrong place`);
  const offenders = [];
  for (const rel of files) {
    const lines = stripComments(read(rel)).split('\n');
    lines.forEach((line, index) => {
      if (bareKeyCheck(line)) offenders.push(`${rel}:${index + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [],
    `judge the key with APICompat.isApiKeyMissing / requiresApiKey instead:\n  ${offenders.join('\n  ')}`);
});

// ------------------------------------------------------- 3. request headers

test('an empty key sends no auth header; a key is sent, even to a local server', () => {
  for (const blank of ['', '   ', undefined, null]) {
    const openai = A.openAIHeaders(blank);
    assert.equal('Authorization' in openai, false, `openAIHeaders(${JSON.stringify(blank)})`);
    assert.equal(openai['Content-Type'], 'application/json');
    const claude = A.claudeHeaders(blank);
    assert.equal('x-api-key' in claude, false, `claudeHeaders(${JSON.stringify(blank)})`);
    assert.ok(claude['anthropic-version'], 'anthropic-version goes out with or without a key');
  }
  // LM Studio's "Require Authentication" wants the key even on localhost.
  assert.equal(A.openAIHeaders(' test-key ').Authorization, 'Bearer test-key');
  assert.equal(A.claudeHeaders('test-key')['x-api-key'], 'test-key');
});

// ------------------------------------------------- 4. saying what went wrong

const en = (key) => getMessage(key, 'en');
const LOCAL_URL = 'http://127.0.0.1:8080/v1/chat/completions';
const REMOTE_URL = 'https://api.openai.com/v1/chat/completions';

test('every known status has its own sentence, and the vendor text follows it', () => {
  const table = {
    401: 'apiErrorAuth',
    402: 'apiErrorQuota',
    403: 'apiErrorForbidden',
    404: 'apiErrorModelNotFound',
    429: 'apiErrorRateLimited',
    500: 'apiErrorServer',
    502: 'apiErrorGateway',
    503: 'apiErrorUnavailable',
  };
  for (const [status, key] of Object.entries(table)) {
    const failure = { status: Number(status), detail: '', endpoint: REMOTE_URL };
    assert.equal(A.describeAPIFailure(failure, en), en(key), status);
    assert.equal(A.describeAPIFailure({ ...failure, detail: 'vendor says no' }, en), `${en(key)}\nvendor says no`);
  }
  // Anything else names the status rather than guessing at a reason.
  assert.equal(A.describeAPIFailure({ status: 418, detail: '', endpoint: REMOTE_URL }, en),
    en('apiErrorStatus').replace('{status}', '418'));
  assert.match(A.describeAPIFailure({ status: 418, detail: '', endpoint: REMOTE_URL }, en), /418/);
});

test('a local server that answers 403 gets a hint for that server', () => {
  const at = (endpoint, provider) => A.describeAPIFailure({ status: 403, detail: '', endpoint }, en, { provider });
  // By preset...
  assert.equal(at(LOCAL_URL, 'ollama'), en('apiErrorOllamaOrigins'));
  assert.equal(at(LOCAL_URL, 'lmstudio'), en('apiErrorLmStudioCors'));
  // ...or by the port each server listens on by default.
  assert.equal(at('http://127.0.0.1:11434/v1/chat/completions', 'custom'), en('apiErrorOllamaOrigins'));
  assert.equal(at('http://192.168.1.20:1234/v1/chat/completions', 'custom'), en('apiErrorLmStudioCors'));
  // Neither: both remedies.
  assert.equal(at(LOCAL_URL, 'custom'), en('apiErrorLocalRefused'));
  assert.equal(at(LOCAL_URL, undefined), en('apiErrorLocalRefused'));
  // A remote 403 is a permissions problem, not a server setting.
  assert.equal(at(REMOTE_URL, 'openai'), en('apiErrorForbidden'));
  assert.equal(at('https://gateway.example.com:11434/v1', 'custom'), en('apiErrorForbidden'));
});

test('no answer at all names the server, local or not', () => {
  const local = A.describeAPIFailure({ network: true, endpoint: 'http://127.0.0.1:9/v1/chat/completions' }, en);
  assert.equal(local, en('apiErrorLocalUnreachable').replace('{endpoint}', 'http://127.0.0.1:9'));
  assert.doesNotMatch(local, /\{endpoint\}/);

  const remote = A.describeAPIFailure({ network: true, endpoint: REMOTE_URL }, en);
  assert.equal(remote, en('apiErrorNetwork').replace('{endpoint}', 'https://api.openai.com'));
});

test('a lookup that lacks the key, or throws, still yields a string', () => {
  const failure = { status: 403, detail: 'd', endpoint: LOCAL_URL };
  assert.equal(A.describeAPIFailure(failure, (key) => key), 'apiErrorLocalRefused\nd');
  assert.equal(A.describeAPIFailure(failure, () => ''), 'apiErrorLocalRefused\nd');
  assert.equal(A.describeAPIFailure(failure, () => { throw new Error('boom'); }), 'apiErrorLocalRefused\nd');
  assert.equal(A.describeAPIFailure(failure, undefined), 'apiErrorLocalRefused\nd');
  assert.equal(typeof A.describeAPIFailure(undefined, en), 'string');
});

test('the text is the reader\'s language, in every UI language', () => {
  const failure = { status: 401, detail: '', endpoint: REMOTE_URL };
  const seen = new Set();
  for (const lang of UI_LANGUAGES) {
    const text = A.describeAPIFailure(failure, (key) => getMessage(key, lang));
    assert.notEqual(text, 'apiErrorAuth', `${lang} has no apiErrorAuth`);
    seen.add(text);
  }
  assert.equal(seen.size, UI_LANGUAGES.length, 'some languages share one sentence; one of them is not translated');
});

test('the remedies are commands, and commands are not translated', () => {
  for (const lang of UI_LANGUAGES) {
    const say = (key) => getMessage(key, lang);
    for (const key of ['apiErrorOllamaOrigins', 'apiErrorLocalRefused']) {
      assert.ok(say(key).includes('OLLAMA_ORIGINS=chrome-extension://*'), `${lang}.${key}`);
    }
    for (const key of ['apiErrorLmStudioCors', 'apiErrorLocalRefused']) {
      assert.ok(say(key).includes('lms server start --cors'), `${lang}.${key}`);
    }
    assert.ok(say('apiErrorLocalUnreachable').includes('ollama serve'), `${lang}.apiErrorLocalUnreachable`);
    for (const key of ['apiErrorNetwork', 'apiErrorLocalUnreachable']) {
      assert.ok(say(key).includes('{endpoint}'), `${lang}.${key} lost its {endpoint}`);
    }
    assert.ok(say('apiErrorStatus').includes('{status}'), `${lang}.apiErrorStatus lost its {status}`);
  }
  // What the local 403 is not: CORS does not stop an extension's service
  // worker from connecting, so no language may say it does.
  assert.doesNotMatch(getMessage('apiErrorLocalUnreachable', 'en'), /CORS/);
  assert.doesNotMatch(getMessage('apiErrorNetwork', 'en'), /CORS/);
});

// No CJK character in the code of the files that used to write the error
// text themselves. Comments do not reach the reader and are not scanned.
const CJK = new RegExp(
  String.raw`[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[`
    + String.fromCharCode(0x3000) + '-' + String.fromCharCode(0x303f)
    + String.fromCharCode(0xff00) + '-' + String.fromCharCode(0xffef) + ']',
  'u');

test('the self-check: the CJK scan sees literals and ignores comments', () => {
  const sample = String.fromCharCode(0x8ba4, 0x8bc1); // two Han characters
  assert.ok(CJK.test(stripComments(`throw new Error('${sample}');`)));
  assert.ok(CJK.test(stripComments(`const s = \`${sample}\`;`)));
  assert.equal(CJK.test(stripComments(`// ${sample}\nconst a = 1; /* ${sample} */`)), false);
  const colon = String.fromCharCode(0xff1a);
  assert.equal(CJK.test(stripComments(`x = line.replace(/^ipa\\s*[:${colon}]/i, '');`)), false);
  assert.ok(CJK.test(stripComments(`x = a / b; y = '${colon}';`)), 'division is not a regex');
});

test('no Chinese literal is left where the reader could see it', () => {
  const files = [
    'background/background.js',
    'background/api-client.js',
    'background/api-errors.js',
    'background/ai-translate.js',
    'background/ocr-recognize.js',
    'background/settings.js',
    'shared/api-compat.js',
    'options/options-connection.js',
    'popup/popup.js',
  ];
  const offenders = [];
  for (const rel of files) {
    stripComments(read(rel)).split('\n').forEach((line, index) => {
      if (CJK.test(line)) offenders.push(`${rel}:${index + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [], `put these through getMessage / t():\n  ${offenders.join('\n  ')}`);
});
