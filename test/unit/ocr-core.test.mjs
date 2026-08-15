// Image OCR translation — the pure half in shared/ocr.js, the vision message
// builders in shared/api-compat.js, and the wiring contracts the feature
// depends on (worker import, manifest order, locale coverage).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoFile = (rel) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');

await import('../../shared/ocr.js');
await import('../../shared/api-compat.js');
const OCR = globalThis.OCRCore;
const A = globalThis.APICompat;

// --- parseOcrResponse --------------------------------------------------------

test('a clean JSON reply parses into all four fields', () => {
  const parsed = OCR.parseOcrResponse(
    '{"text": "HELLO", "language": "en", "languageName": "英语", "translation": "你好"}'
  );
  assert.deepEqual(parsed, { text: 'HELLO', language: 'en', languageName: '英语', translation: '你好' });
});

test('a ```json fence around the object is stripped', () => {
  const parsed = OCR.parseOcrResponse(
    'Here you go:\n```json\n{"text": "Hi", "language": "en", "languageName": "English", "translation": "Salut"}\n```'
  );
  assert.equal(parsed.text, 'Hi');
  assert.equal(parsed.translation, 'Salut');
});

test('prose before and after the object is trimmed away', () => {
  const parsed = OCR.parseOcrResponse(
    'Sure! The result is {"text": "A", "language": "fr", "languageName": "French", "translation": "B"} — hope that helps.'
  );
  assert.equal(parsed.text, 'A');
  assert.equal(parsed.language, 'fr');
  assert.equal(parsed.translation, 'B');
});

test('snake_case language_name is accepted alongside languageName', () => {
  const parsed = OCR.parseOcrResponse('{"text": "x", "language": "ja", "language_name": "Japanese", "translation": "y"}');
  assert.equal(parsed.languageName, 'Japanese');
});

test('a reply with no recoverable JSON becomes a bare translation', () => {
  const parsed = OCR.parseOcrResponse('The sign says "Exit" which means 出口.');
  assert.equal(parsed.text, '');
  assert.equal(parsed.language, '');
  assert.equal(parsed.translation, 'The sign says "Exit" which means 出口.');
});

test('empty and non-string replies come back all-empty, never throw', () => {
  const empty = { text: '', language: '', languageName: '', translation: '' };
  assert.deepEqual(OCR.parseOcrResponse(''), empty);
  assert.deepEqual(OCR.parseOcrResponse(null), empty);
  assert.deepEqual(OCR.parseOcrResponse(undefined), empty);
});

test('non-string JSON values are normalized to empty strings, not passed through', () => {
  const parsed = OCR.parseOcrResponse('{"text": 42, "language": null, "languageName": [], "translation": "ok"}');
  assert.equal(parsed.text, '');
  assert.equal(parsed.language, '');
  assert.equal(parsed.languageName, '');
  assert.equal(parsed.translation, 'ok');
});

// --- Encoding limits ---------------------------------------------------------

test('pass-through covers exactly the formats every vision API accepts', () => {
  for (const type of ['image/jpeg', 'image/png', 'image/webp', 'image/gif']) {
    assert.ok(OCR.canSendImageDirectly(type, 1024), `${type} should pass through`);
  }
  assert.ok(!OCR.canSendImageDirectly('image/svg+xml', 1024), 'SVG must be re-encoded');
  assert.ok(!OCR.canSendImageDirectly('image/bmp', 1024), 'BMP must be re-encoded');
});

test('the byte cap is inclusive at the limit and rejects one byte past it', () => {
  assert.ok(OCR.canSendImageDirectly('image/png', OCR.OCR_MAX_BYTES));
  assert.ok(!OCR.canSendImageDirectly('image/png', OCR.OCR_MAX_BYTES + 1));
});

// --- Prompt ------------------------------------------------------------------

test('the system prompt names the target language for detection labels and translation', () => {
  const prompt = OCR.buildOcrSystemPrompt('简体中文');
  // Translation target, languageName language, and the already-target rule all
  // hinge on the same name appearing.
  assert.ok((prompt.match(/简体中文/g) || []).length >= 3);
  for (const key of ['"text"', '"language"', '"languageName"', '"translation"']) {
    assert.ok(prompt.includes(key), `prompt must pin the ${key} key`);
  }
});

// --- Vision message builders (shared/api-compat.js) --------------------------

test('the OpenAI vision content is text first, then a data-URL image part', () => {
  const content = A.buildOpenAIVisionUserContent('read this', 'image/png', 'QUJD');
  assert.equal(content.length, 2);
  assert.deepEqual(content[0], { type: 'text', text: 'read this' });
  assert.equal(content[1].type, 'image_url');
  assert.equal(content[1].image_url.url, 'data:image/png;base64,QUJD');
});

test('the Claude vision content is image first with raw base64 fields, then text', () => {
  const content = A.buildClaudeVisionUserContent('read this', 'image/jpeg', 'QUJD');
  assert.equal(content.length, 2);
  assert.deepEqual(content[0], {
    type: 'image',
    source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' }
  });
  assert.deepEqual(content[1], { type: 'text', text: 'read this' });
});

// --- Wiring contracts --------------------------------------------------------

test('the service worker loads shared/ocr.js and answers OCR_IMAGE', () => {
  const background = repoFile('background/background.js');
  assert.ok(background.includes("import '../shared/ocr.js'"), 'background must import the OCR core');
  assert.ok(background.includes("'OCR_IMAGE'"), 'background must handle the OCR_IMAGE message');
  assert.ok(
    !/function\s+parseOcrResponse|function\s+canSendImageDirectly/.test(background),
    'OCR parsing/limits live in shared/ocr.js only'
  );
});

test('the content script chain loads the OCR UI before the message router', () => {
  const manifest = JSON.parse(repoFile('manifest.json'));
  const js = manifest.content_scripts.find((c) => c.matches.includes('<all_urls>')).js;
  const ocrAt = js.indexOf('content/content-image-ocr.js');
  const messagingAt = js.indexOf('content/content-messaging.js');
  assert.ok(ocrAt !== -1, 'content-image-ocr.js must be injected');
  assert.ok(ocrAt < messagingAt, 'the router dispatches to ctx.startImageOcrTranslation, so the UI must load first');
});

test('every locale carries the OCR strings the worker and popup look up', () => {
  const source = repoFile('i18n/messages.js');
  // messages.js is a classic script; run it for its globalThis side effect.
  new Function(source)();
  const messages = globalThis.I18N_MESSAGES;
  const keys = [
    'contextOcrImage',
    'ocrExtracting',
    'ocrNoTextDetected',
    'ocrDetectedLanguage',
    'ocrImageLoadFailed',
    'ocrImageUnsupported',
    'enableImageOcrTranslation',
    'hintEnableImageOcrTranslation'
  ];
  for (const [locale, table] of Object.entries(messages)) {
    for (const key of keys) {
      assert.equal(typeof table[key], 'string', `${locale} is missing ${key}`);
      assert.ok(table[key].length > 0, `${locale} has an empty ${key}`);
    }
  }
});
