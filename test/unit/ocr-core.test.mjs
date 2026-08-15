// Image OCR — the pure half in shared/ocr.js, the vision message builders in
// shared/api-compat.js, and the wiring contracts the feature depends on
// (worker import, manifest order, locale coverage, engine packaging).
//
// The feature is two steps and the tests are organised the same way: everything
// here is step 1, recognition. Step 2 is ordinary text translation and is
// covered where that lives.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoPath = (rel) => fileURLToPath(new URL(`../../${rel}`, import.meta.url));
const repoFile = (rel) => readFileSync(repoPath(rel), 'utf8');

await import('../../shared/ocr.js');
await import('../../shared/api-compat.js');
const OCR = globalThis.OCRCore;
const A = globalThis.APICompat;

// --- parseOcrResponse --------------------------------------------------------

test('a clean JSON reply parses into text and language', () => {
  const parsed = OCR.parseOcrResponse('{"text": "HELLO", "language": "en"}');
  assert.deepEqual(parsed, { text: 'HELLO', language: 'en' });
});

test('a ```json fence around the object is stripped', () => {
  const parsed = OCR.parseOcrResponse('Here you go:\n```json\n{"text": "Hi", "language": "en"}\n```');
  assert.equal(parsed.text, 'Hi');
  assert.equal(parsed.language, 'en');
});

test('prose before and after the object is trimmed away', () => {
  const parsed = OCR.parseOcrResponse('Sure! The result is {"text": "A", "language": "fr"} — hope that helps.');
  assert.equal(parsed.text, 'A');
  assert.equal(parsed.language, 'fr');
});

test('a reply with no recoverable JSON is taken as the recognised text', () => {
  // A model that answered in prose still read the image. Discarding that would
  // lose the user a result; the language falls to detectScriptLanguage.
  const parsed = OCR.parseOcrResponse('The sign reads 出口.');
  assert.equal(parsed.text, 'The sign reads 出口.');
  assert.equal(parsed.language, '');
});

test('literal newlines inside JSON string values parse and survive', () => {
  // "Preserve line breaks" read literally: raw control characters where JSON
  // demands \n. Pretty-printed whitespace between tokens must stay untouched.
  const parsed = OCR.parseOcrResponse('{\n  "text": "LINE ONE\nLINE TWO",\n  "language": "en"\n}');
  assert.equal(parsed.text, 'LINE ONE\nLINE TWO');
  assert.equal(parsed.language, 'en');
});

test('a JSON reply broken past repair is null, never shown as recognised text', () => {
  // Truncated by the token cap mid-string: not prose, not recoverable JSON.
  assert.equal(OCR.parseOcrResponse('{"text": "HELLO WORLD", "language": "en", "langu'), null);
  assert.equal(OCR.parseOcrResponse('```json\n{"text": broken}\n```'), null);
});

test('empty and non-string replies come back all-empty, never throw', () => {
  const empty = { text: '', language: '' };
  assert.deepEqual(OCR.parseOcrResponse(''), empty);
  assert.deepEqual(OCR.parseOcrResponse(null), empty);
  assert.deepEqual(OCR.parseOcrResponse(undefined), empty);
});

test('non-string JSON values are normalized to empty strings, not passed through', () => {
  const parsed = OCR.parseOcrResponse('{"text": 42, "language": null}');
  assert.equal(parsed.text, '');
  assert.equal(parsed.language, '');
});

// --- resolveOcrLanguages -----------------------------------------------------

test('auto pairs English with the user own script, and only those two', () => {
  assert.equal(OCR.resolveOcrLanguages('auto', 'zh-CN'), 'eng+chi_sim');
  assert.equal(OCR.resolveOcrLanguages('auto', 'zh-TW'), 'eng+chi_tra');
  assert.equal(OCR.resolveOcrLanguages('auto', 'ja'), 'eng+jpn');
  assert.equal(OCR.resolveOcrLanguages('auto', 'ko'), 'eng+kor');
});

test('auto falls back to English alone for a UI language with no bundled pack', () => {
  // French text is Latin script, which eng already reads well enough; loading a
  // second pack would cost time for nothing.
  assert.equal(OCR.resolveOcrLanguages('auto', 'fr'), 'eng');
  assert.equal(OCR.resolveOcrLanguages('', ''), 'eng');
});

test('an explicit language wins outright — no English tagged on', () => {
  // Someone who picked Japanese knows better than the heuristic, and every
  // extra language costs recognition time and a little accuracy.
  assert.equal(OCR.resolveOcrLanguages('jpn', 'zh-CN'), 'jpn');
  assert.equal(OCR.resolveOcrLanguages('eng', 'ja'), 'eng');
});

test('an unknown stored language is treated as auto, not passed to Tesseract', () => {
  // A setting from a future build, or a hand-edited one. Tesseract throws on a
  // pack it cannot load, which would break the feature outright.
  assert.equal(OCR.resolveOcrLanguages('klingon', 'ja'), 'eng+jpn');
});

test('every catalog language has a bundled traineddata file', () => {
  for (const lang of OCR.OCR_LANGUAGES) {
    assert.ok(
      existsSync(repoPath(`vendor/tesseract/lang/${lang.code}.traineddata`)),
      `${lang.code} is offered but its traineddata is not vendored`
    );
  }
});

// --- detectScriptLanguage ----------------------------------------------------

test('kana settles Japanese even when Han characters outnumber it', () => {
  // The whole reason kana is tested first: Japanese is mostly Han by volume.
  assert.equal(OCR.detectScriptLanguage('東京都渋谷区の駅', 'jpn'), 'ja');
  assert.equal(OCR.detectScriptLanguage('日本語です', 'eng+jpn'), 'ja');
});

test('Hangul settles Korean', () => {
  assert.equal(OCR.detectScriptLanguage('출구 없음', 'kor'), 'ko');
});

test('Han with no kana is Chinese, and the language list picks the variant', () => {
  assert.equal(OCR.detectScriptLanguage('紧急出口', 'eng+chi_sim'), 'zh-Hans');
  assert.equal(OCR.detectScriptLanguage('緊急出口', 'chi_tra'), 'zh-Hant');
  // Both packs loaded: no evidence either way, so the common case wins.
  assert.equal(OCR.detectScriptLanguage('緊急出口', 'chi_sim+chi_tra'), 'zh-Hans');
});

test('a few stray Latin letters do not outvote the script they sit in', () => {
  assert.equal(OCR.detectScriptLanguage('WiFi 密码就在前台那边登记本上', 'eng+chi_sim'), 'zh-Hans');
});

test('Latin and Cyrillic are recognised', () => {
  assert.equal(OCR.detectScriptLanguage('Emergency exit', 'eng'), 'en');
  assert.equal(OCR.detectScriptLanguage('Аварийный выход', 'eng'), 'ru');
});

test('text with nothing to go on returns empty rather than guessing', () => {
  assert.equal(OCR.detectScriptLanguage('', 'eng'), '');
  assert.equal(OCR.detectScriptLanguage('   \n  ', 'eng'), '');
  assert.equal(OCR.detectScriptLanguage('12:45 — 99.9%', 'eng'), '');
  assert.equal(OCR.detectScriptLanguage(null, 'eng'), '');
});

// --- normalizeRecognizedText -------------------------------------------------

test('spaces Tesseract inserts between CJK glyphs are removed', () => {
  // Its layout analysis reads the gaps of a proportional CJK font as word
  // breaks. A run needs two passes, which is why normalize does two.
  assert.equal(OCR.normalizeRecognizedText('紧急 出 口 处'), '紧急出口处');
  assert.equal(OCR.normalizeRecognizedText('こ の 先 通 行 止 め'), 'この先通行止め');
});

test('a space between Latin words is a real word break and survives', () => {
  assert.equal(OCR.normalizeRecognizedText('Emergency exit'), 'Emergency exit');
  // The digit is not a CJK glyph, so this space is not between two of them.
  assert.equal(OCR.normalizeRecognizedText('第1 章'), '第1 章');
});

test('runs of whitespace, trailing space and extra blank lines collapse', () => {
  assert.equal(OCR.normalizeRecognizedText('  Exit   here  \n\n\n\nNow  '), 'Exit here\n\nNow');
  assert.equal(OCR.normalizeRecognizedText('a\r\nb\rc'), 'a\nb\nc');
});

test('normalizing nothing yields an empty string, never throws', () => {
  assert.equal(OCR.normalizeRecognizedText(''), '');
  assert.equal(OCR.normalizeRecognizedText(null), '');
  assert.equal(OCR.normalizeRecognizedText(undefined), '');
});

// --- filterRecognizedLines ---------------------------------------------------

test('low-confidence garbage lines are dropped, real lines survive in order', () => {
  // The real bug: large stylised Chinese glyphs Tesseract has no model for,
  // recognised as low-scoring Latin garbage next to correctly-read small text.
  const lines = [
    { text: '< rs', confidence: 21 },
    { text: 'SEE Fis 64, BEAR K. MASS 7 Ol eR', confidence: 34 },
    { text: '柳宗元', confidence: 91 },
    { text: '裁剪编辑', confidence: 88 }
  ];
  assert.deepEqual(
    OCR.filterRecognizedLines(lines).map((l) => l.text),
    ['柳宗元', '裁剪编辑']
  );
});

test('when every line is low confidence, the input comes back unfiltered', () => {
  // A photo that is all stylised type is exactly where confidence stops
  // meaning anything, and a shaky result still beats an empty popup.
  const lines = [
    { text: 'blurry one', confidence: 30 },
    { text: 'blurry two', confidence: 41 }
  ];
  assert.deepEqual(OCR.filterRecognizedLines(lines), lines);
});

test('surviving lines keep their order and identity, so structure can be rebuilt', () => {
  // The offscreen document rebuilds paragraph gaps by Set membership, which
  // only works if the filter returns the same objects it was given.
  const first = { text: 'Header', confidence: 90 };
  const junk = { text: 'ol eR', confidence: 12 };
  const last = { text: 'Body line', confidence: 84 };
  const kept = OCR.filterRecognizedLines([first, junk, last]);
  assert.equal(kept.length, 2);
  assert.equal(kept[0], first);
  assert.equal(kept[1], last);
});

test('a line with no numeric confidence is kept — unknown is not bad', () => {
  const lines = [
    { text: 'no score' },
    { text: 'garbage', confidence: 10 },
    { text: 'good', confidence: 95 }
  ];
  assert.deepEqual(OCR.filterRecognizedLines(lines).map((l) => l.text), ['no score', 'good']);
});

test('the threshold is inclusive at the bar and drops one point under it', () => {
  const at = { text: 'at', confidence: OCR.OCR_LINE_CONFIDENCE_THRESHOLD };
  const below = { text: 'below', confidence: OCR.OCR_LINE_CONFIDENCE_THRESHOLD - 1 };
  assert.deepEqual(OCR.filterRecognizedLines([at, below]), [at]);
});

test('filtering nothing yields an empty array, never throws', () => {
  assert.deepEqual(OCR.filterRecognizedLines([]), []);
  assert.deepEqual(OCR.filterRecognizedLines(null), []);
  assert.deepEqual(OCR.filterRecognizedLines(undefined), []);
});

// --- shouldTranslate ---------------------------------------------------------

test('the translate step runs when it is on and the languages differ', () => {
  assert.equal(OCR.shouldTranslate({ enabled: true, text: '出口', sourceLanguage: 'zh', targetLanguage: 'en' }), true);
});

test('the translate step is skipped when it is switched off', () => {
  assert.equal(OCR.shouldTranslate({ enabled: false, text: '出口', sourceLanguage: 'zh', targetLanguage: 'en' }), false);
});

test('text already in the target language is not sent to be translated', () => {
  // Callers normalise both codes first, so 'zh-CN' and 'zh-Hans' have already
  // become the same 'zh' by the time they arrive here.
  assert.equal(OCR.shouldTranslate({ enabled: true, text: '出口', sourceLanguage: 'zh', targetLanguage: 'zh' }), false);
});

test('an unknown source language is still worth a try', () => {
  // The engine gets the final say. Guessing "already translated" from no
  // evidence would lose the user a result.
  assert.equal(OCR.shouldTranslate({ enabled: true, text: 'Exit', sourceLanguage: '', targetLanguage: 'zh' }), true);
});

test('nothing recognised and no target are both nothing to translate', () => {
  assert.equal(OCR.shouldTranslate({ enabled: true, text: '   ', sourceLanguage: 'en', targetLanguage: 'zh' }), false);
  assert.equal(OCR.shouldTranslate({ enabled: true, text: 'Exit', sourceLanguage: 'en', targetLanguage: '' }), false);
});

// --- Detected-language labels ------------------------------------------------

test('detected language codes map to i18n keys, case and variant insensitively', () => {
  assert.equal(OCR.detectedLanguageLabelKey('zh-Hans'), 'langZhCN');
  assert.equal(OCR.detectedLanguageLabelKey('zh-CN'), 'langZhCN');
  assert.equal(OCR.detectedLanguageLabelKey('zh-Hant'), 'langZhTW');
  assert.equal(OCR.detectedLanguageLabelKey('JA'), 'langJa');
});

test('everything detectScriptLanguage can return has a label', () => {
  // Otherwise the popup shows a raw subtag for a language we ourselves named.
  for (const code of ['en', 'ja', 'ko', 'ru', 'zh-Hans', 'zh-Hant']) {
    assert.notEqual(OCR.detectedLanguageLabelKey(code), '', `${code} needs a label key`);
  }
});

test('an unmapped code yields no key, so the caller shows it raw', () => {
  assert.equal(OCR.detectedLanguageLabelKey('th'), '');
  assert.equal(OCR.detectedLanguageLabelKey(''), '');
  assert.equal(OCR.detectedLanguageLabelKey(null), '');
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

test('the vision prompt asks for recognition only and pins both keys', () => {
  const prompt = OCR.OCR_SYSTEM_PROMPT;
  for (const key of ['"text"', '"language"']) {
    assert.ok(prompt.includes(key), `prompt must pin the ${key} key`);
  }
  // Translation is step 2 and belongs to the ordinary translation path. A
  // prompt that also translated would give the vision engine a different
  // response shape from the local one.
  assert.ok(/Never translate/i.test(prompt), 'the prompt must forbid translating');
  assert.ok(!/"translation"/.test(prompt), 'the vision engine must not be asked for a translation');
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

test('recognition stops at the worker — translating is the content script job', () => {
  // The one thing that would quietly undo the two-step split: a worker that
  // helpfully translates, giving the two engines different response shapes and
  // cutting the free built-in translator out of the vision path.
  const background = repoFile('background/background.js');
  const start = background.indexOf('async function recognizeLocally');
  const end = background.indexOf('async function translateWithAI');
  assert.ok(start !== -1 && end > start, 'the OCR handlers should sit above the translation ones');
  const ocrSection = background.slice(start, end);
  assert.ok(
    !/translateWithAI\(|translateTextWithMode\(|translationEngine/.test(ocrSection),
    'the OCR handlers must not translate'
  );
  const ocrUi = repoFile('content/content-image-ocr.js');
  assert.ok(
    ocrUi.includes('ctx.translateText('),
    'the content script runs step 2 through the shared translation path'
  );
  // The worker owns the setting, so it has to put the answer on the message —
  // the content script cannot read chrome.storage.sync for it.
  assert.ok(
    background.includes('settings.ocrTranslate'),
    'the menu click must carry the translate preference to the content script'
  );
  assert.ok(
    repoFile('content/content-messaging.js').includes('translate: message.translate'),
    'the router must forward it to the OCR flow'
  );
});

test('the local engine runs in the offscreen document, not the worker', () => {
  // A service worker cannot spawn a nested Worker or instantiate this WASM, so
  // an import here would fail at runtime rather than at review.
  const background = repoFile('background/background.js');
  assert.ok(
    !/importScripts\(|tesseract\.min\.js|Tesseract\.createWorker|createWorker\(/.test(background),
    'the engine must not be loaded or driven from the service worker'
  );
  assert.ok(background.includes('chrome.offscreen.createDocument'), 'the worker opens the offscreen document');

  const manifest = JSON.parse(repoFile('manifest.json'));
  assert.ok(manifest.permissions.includes('offscreen'), 'the offscreen permission is required');
  assert.ok(
    /wasm-unsafe-eval/.test(manifest.content_security_policy.extension_pages),
    'MV3 needs wasm-unsafe-eval to instantiate the OCR engine'
  );

  const offscreen = repoFile('offscreen/offscreen.js');
  // Every one of these defaults to a CDN fetch, which MV3 forbids and which
  // would also break the feature offline.
  for (const opt of ['corePath', 'workerPath', 'langPath', 'workerBlobURL', 'gzip']) {
    assert.ok(offscreen.includes(opt), `the engine must be pinned to the vendored ${opt}`);
  }
});

test('the offscreen document filters what it recognised before answering', () => {
  // Without the structured output there are no per-line confidences, and
  // without the filter the stylised-glyph garbage rides along with the real
  // text and poisons language detection downstream.
  const offscreen = repoFile('offscreen/offscreen.js');
  assert.ok(/blocks:\s*true/.test(offscreen), 'recognize must request the structured blocks output');
  assert.ok(offscreen.includes('filterRecognizedLines'), 'the confidence filter must run on the result');
});

test('the content script chain loads the OCR core and UI before the message router', () => {
  const manifest = JSON.parse(repoFile('manifest.json'));
  const js = manifest.content_scripts.find((c) => c.matches.includes('<all_urls>')).js;
  const coreAt = js.indexOf('shared/ocr.js');
  const ocrAt = js.indexOf('content/content-image-ocr.js');
  const messagingAt = js.indexOf('content/content-messaging.js');
  assert.ok(coreAt !== -1, 'the OCR UI reads OCRCore, so shared/ocr.js must be injected');
  assert.ok(coreAt < ocrAt, 'the core must load before the UI that reads it');
  assert.ok(ocrAt < messagingAt, 'the router dispatches to ctx.startImageOcrTranslation, so the UI must load first');
});

test('there is still one language-code table, and OCR is not a second one', () => {
  // shouldTranslate compares two language codes, which is exactly the shape
  // that grows its own alias table ('zh-CN' vs 'zh-Hans' vs 'zh'). It takes
  // codes the caller has already put through toApiLang instead.
  const ocr = repoFile('shared/ocr.js');
  assert.ok(
    !/LANG_ALIASES|toApiLang\s*[=(]|toTranslatorLanguage/.test(ocr),
    'normalising language codes belongs to content-translation-engine.js'
  );
  const ocrUi = repoFile('content/content-image-ocr.js');
  assert.ok(
    ocrUi.includes('toApiLang'),
    'the caller must normalise both codes before shouldTranslate compares them'
  );
});

test('the OCR language list and the default engine are stated once', () => {
  // Both are things two surfaces need and neither owns: the languages must
  // match what is vendored, and the default engine must match the worker's.
  const optionsHtml = repoFile('options/options.html');
  assert.ok(optionsHtml.includes('shared/ocr.js'), 'the options page must load the OCR core');
  assert.ok(
    !/value="(eng|chi_sim|chi_tra|jpn|kor)"/.test(optionsHtml),
    'the language options are rendered from OCR_LANGUAGES, not written into the markup'
  );
  for (const file of ['options/options.js', 'background/background.js']) {
    assert.ok(
      repoFile(file).includes('DEFAULT_OCR_ENGINE'),
      `${file} must take the default engine from shared/ocr.js`
    );
  }
});

test('the packaged zip carries the engine and the offscreen document', () => {
  // Vendored binaries in a directory nothing else references: the easiest thing
  // in the repo to leave out of the release and the hardest to notice.
  const zip = JSON.parse(repoFile('package.json')).scripts.zip;
  for (const dir of ['vendor/', 'offscreen/']) {
    assert.ok(zip.includes(dir), `${dir} must be in the zip script`);
  }
});

test('every locale carries the OCR strings the worker, popup and options look up', () => {
  const source = repoFile('i18n/messages.js');
  // messages.js is a classic script; run it for its globalThis side effect.
  new Function(source)();
  const messages = globalThis.I18N_MESSAGES;
  const keys = [
    'contextOcrImage',
    'ocrExtracting',
    'ocrRecognizing',
    'ocrLoadingEngine',
    'ocrNoTextDetected',
    'ocrEngineFailed',
    'ocrImageLoadFailed',
    'ocrImageUnsupported',
    'enableImageOcrTranslation',
    'hintEnableImageOcrTranslation',
    'ocrEngine',
    'hintOcrEngine',
    'ocrEngineLocal',
    'ocrEngineVision',
    'ocrSourceLanguage',
    'hintOcrSourceLanguage',
    'ocrSourceLanguageAuto',
    'ocrTranslate',
    'hintOcrTranslate'
  ];
  // The labels the recognised-language line resolves through.
  for (const lang of OCR.OCR_LANGUAGES) keys.push(lang.labelKey);
  for (const [locale, table] of Object.entries(messages)) {
    for (const key of keys) {
      assert.equal(typeof table[key], 'string', `${locale} is missing ${key}`);
      assert.ok(table[key].length > 0, `${locale} has an empty ${key}`);
    }
  }
});
