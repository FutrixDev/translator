// The target-language list exists once: shared/target-lang.js's SUPPORTED.
// It used to be written out in six places — the in-page picker's
// TARGET_LANGUAGE_OPTIONS, the prompt's languageNames table, five hardcoded
// <select>s on the settings page, eleven `lang*` message keys, and two key
// tables for OCR and PDF jobs — and this file's job was to compare them. They
// drifted once already (`pt` reached the prompt builder with no name for it).
//
// Now names are computed by Intl.DisplayNames in the UI language, so this file
// checks the one list and what Intl makes of it instead.
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { engineSource, workerSource } from './helpers/sources.mjs';

const repoFile = (rel) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');

await import('../../shared/lang-tags.js');
await import('../../shared/target-lang.js');
const TargetLang = globalThis.TargetLang;

// The engine family's language table, loaded the way the options page loads
// it: a bare AI_TRANSLATOR_CONTENT shelf, plus the route signal it subscribes
// to at load (stubbed: no real route polling here).
globalThis.window = globalThis.window || { AI_TRANSLATOR_CONTENT: {} };
globalThis.SpaNavigation = { onRouteChange() {} };
await import('../../content/engine/languages.js');
const eng = globalThis.window.AI_TRANSLATOR_CONTENT.engine;

await import('../../i18n/messages.js');
const { UI_LANGUAGES } = globalThis;
const OLD_TEN = ['zh-CN', 'zh-TW', 'en', 'ja', 'ko', 'fr', 'de', 'es', 'pt', 'ru'];

/** The built-in engine's capability list, read off its source. */
function builtinLanguages() {
  const source = engineSource();
  const start = source.indexOf('const SUPPORTED_LANGS = new Set([');
  assert.notEqual(start, -1, 'could not find SUPPORTED_LANGS');
  const block = source.slice(start, source.indexOf(']);', start));
  return [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

test('78 target languages, no duplicates', () => {
  assert.equal(TargetLang.SUPPORTED.length, 78);
  assert.equal(new Set(TargetLang.SUPPORTED).size, 78);
});

test('every language the built-in engine knows is a target we offer', () => {
  const offered = new Set(TargetLang.SUPPORTED.map((code) => eng.toApiLang(code)));
  const builtin = builtinLanguages();
  assert.equal(builtin.length, 39);
  for (const api of builtin) {
    assert.ok(offered.has(api), `built-in language '${api}' has no target code`);
  }
  // …and exactly 39 of the 78 map onto one — the rest are AI only.
  const local = TargetLang.SUPPORTED.filter((code) => eng.supportsTarget(code));
  assert.equal(local.length, 39);
});

// "Can the built-in engine translate into this target?" is eng.supportsTarget.
// Before it existed, supportsLang(toApiLang(target)) was spelled out in five
// places: the menus' "AI only" tag, the language-pack status, the engine's
// error wording, the batch pre-check and the card's switch-engine button.
const REBUILT_TARGET_CHECK = /supportsLang\(\s*[\w.]*toApiLang\(/;

test('the scan sees supportsLang(toApiLang(...)) however it is spelled (self-check)', () => {
  for (const line of [
    'bt.supportsLang(bt.toApiLang(option.value))',
    'engine.supportsLang(engine.toApiLang(targetLang))',
    'eng.supportsLang( eng.toApiLang(x) )',
  ]) assert.match(line, REBUILT_TARGET_CHECK, line);
  // An API code in hand is a different question, asked with supportsLang.
  assert.doesNotMatch('eng.supportsLang(src) || !eng.supportsLang(tgt)', REBUILT_TARGET_CHECK);
});

test('no caller rebuilds supportsTarget out of supportsLang and toApiLang', () => {
  const dirs = ['background', 'content', 'i18n', 'offscreen', 'onboarding', 'options', 'popup', 'pdf', 'shared'];
  const jsFiles = (dir) => readdirSync(fileURLToPath(new URL(`../../${dir}/`, import.meta.url)), { withFileTypes: true })
    .flatMap((entry) => entry.isDirectory() ? jsFiles(`${dir}/${entry.name}`)
      : entry.name.endsWith('.js') ? [`${dir}/${entry.name}`] : []);
  const files = dirs.flatMap(jsFiles);
  assert.ok(files.length > 50, `only ${files.length} files scanned; the scan may be looking in the wrong place`);
  const offenders = files.flatMap((rel) => repoFile(rel).split('\n')
    .map((line, index) => REBUILT_TARGET_CHECK.test(line) ? `${rel}:${index + 1}` : null)
    .filter(Boolean));
  assert.deepEqual(offenders, [], 'ask eng.supportsTarget (ctx.builtinTranslator.supportsTarget) instead');
});

test('the cloud selectors keep the old ten, all of them valid targets', () => {
  assert.deepEqual(TargetLang.CLOUD_TARGETS.slice().sort(), OLD_TEN.slice().sort());
  for (const code of TargetLang.CLOUD_TARGETS) assert.ok(TargetLang.SUPPORTED.includes(code), code);
});

test('every language has a name in every UI language, and a name of its own', () => {
  for (const ui of UI_LANGUAGES) {
    for (const code of TargetLang.SUPPORTED) {
      assert.notEqual(TargetLang.nameOf(code, ui), code, `no ${ui} name for '${code}'`);
    }
  }
  for (const code of TargetLang.SUPPORTED) {
    assert.notEqual(TargetLang.autonym(code), code, `no autonym for '${code}'`);
  }
});

test('ar fa he ur are right-to-left, the other 73 left-to-right', () => {
  const rtl = TargetLang.SUPPORTED.filter((code) => TargetLang.direction(code) === 'rtl');
  assert.deepEqual(rtl.sort(), ['ar', 'fa', 'he', 'ur']);
  for (const code of TargetLang.SUPPORTED) {
    assert.ok(['rtl', 'ltr'].includes(TargetLang.direction(code)), code);
  }
  // Not a language at all is HTML's default, not an exception.
  assert.equal(TargetLang.direction(''), 'ltr');
  assert.equal(TargetLang.direction('x-klingon'), 'ltr');
});

test('fromTag folds any tag into one of the 78, and only an unknown one into en', () => {
  const cases = [
    ['sv-SE', 'sv'],
    ['tl', 'fil'],
    ['iw', 'he'],
    ['in', 'id'],
    ['nb', 'no'],
    ['nn', 'no'],
    ['zh-HK', 'zh-TW'],
    ['zh-Hant-TW', 'zh-TW'],
    ['zh', 'zh-CN'],
    ['sh', 'sr'],
    ['pt-PT', 'pt'],
    ['es-419', 'es'],
    ['EN-us', 'en'],
    ['xh', 'en'],
    ['x-klingon', 'en'],
    ['', 'en'],
    // A truncated extension must not make Intl throw: only the prefix is read.
    ['en-US-u-', 'en'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(TargetLang.fromTag(input), expected, `fromTag(${JSON.stringify(input)})`);
  }
  // Every code on the list is its own answer.
  for (const code of TargetLang.SUPPORTED) assert.equal(TargetLang.fromTag(code), code);
});

test('menu form capitalises only an all-lowercase name in a cased script', () => {
  assert.equal(TargetLang.nameOf('fa', 'fr'), 'Persan');
  assert.equal(TargetLang.nameOf('fa', 'fr', { inSentence: true }), 'persan');
  assert.equal(TargetLang.nameOf('zh-CN', 'fr'), 'Chinois simplifié');
  // Georgian's capitals are a different alphabet (Mtavruli): left alone.
  assert.equal(TargetLang.autonym('ka'), 'ქართული');
  // An internal capital means the name already has its own casing.
  assert.equal(TargetLang.autonym('zu'), 'isiZulu');
  assert.equal(TargetLang.autonym('ru'), 'Русский');
  // In-sentence form is Intl as it stands, in every UI language.
  for (const ui of UI_LANGUAGES) {
    assert.equal(TargetLang.nameOf('fa', ui, { inSentence: true }),
      new Intl.DisplayNames([ui], { type: 'language' }).of('fa'));
  }
});

test('zh-CN and zh-TW are named as the two scripts, not as two regions', () => {
  assert.equal(TargetLang.nameOf('zh-CN', 'en'), 'Simplified Chinese');
  assert.equal(TargetLang.nameOf('zh-TW', 'en'), 'Traditional Chinese');
  assert.equal(TargetLang.autonym('zh-CN'), '简体中文');
  assert.equal(TargetLang.autonym('zh-TW'), '繁體中文');
});

test('nameOf takes any well-formed tag and returns an unknown one as it is', () => {
  // OCR hands it what it detected, which is not always a target code.
  assert.equal(TargetLang.nameOf('zh', 'en'), 'Chinese');
  assert.equal(TargetLang.nameOf('zh-Hans', 'zh-CN'), '简体中文');
  assert.equal(TargetLang.nameOf('', 'en'), '');
  assert.equal(TargetLang.nameOf('x-klingon', 'en'), 'x-klingon');
  assert.equal(TargetLang.nameOf('qqq', 'en'), 'qqq');
});

test('promptName gives the model the English name and the autonym', () => {
  assert.equal(TargetLang.promptName('ja'), 'Japanese (日本語)');
  assert.equal(TargetLang.promptName('fa'), 'Persian (فارسی)');
  assert.equal(TargetLang.promptName('en'), 'English');
});

// Chrome's ICU has no name for lzh in any UI language (Node's knows a few, so a
// test that only asked Intl would pass here and show the bare code in Chrome).
// Its names come from target-lang.js's own table, whatever Intl says. It comes
// in two scripts: lzh is Traditional (the one 1.5.8 shipped, so a stored lzh
// keeps meaning what it meant), lzh-Hans is Simplified.
test('Classical Chinese is named from our own table, not from Intl, in both scripts', () => {
  assert.equal(TargetLang.nameOf('lzh', 'zh-CN'), '文言文（繁体）');
  assert.equal(TargetLang.nameOf('lzh-Hans', 'zh-CN'), '文言文（简体）');
  assert.equal(TargetLang.nameOf('lzh', 'zh-TW'), '文言文（繁體）');
  assert.equal(TargetLang.nameOf('lzh-Hans', 'zh-TW'), '文言文（簡體）');
  assert.equal(TargetLang.nameOf('lzh', 'ja'), '漢文（繁体字）');
  assert.equal(TargetLang.nameOf('lzh', 'en'), 'Classical Chinese (Traditional)');
  assert.equal(TargetLang.nameOf('lzh-Hans', 'en'), 'Classical Chinese (Simplified)');
  assert.equal(TargetLang.nameOf('lzh', 'fr'), 'Chinois classique (traditionnel)');
  assert.equal(TargetLang.nameOf('lzh', 'fr', { inSentence: true }), 'chinois classique (traditionnel)');
  assert.equal(TargetLang.nameOf('lzh-Hans', 'pt-BR'), 'Chinês clássico (simplificado)');
  assert.equal(TargetLang.nameOf('lzh-Hans', 'xx'), 'Classical Chinese (Simplified)');
  assert.equal(TargetLang.autonym('lzh'), '文言文（繁體）');
  assert.equal(TargetLang.autonym('lzh-Hans'), '文言文（简体）');
  // The prompt names the script, so the model knows which characters to write.
  assert.equal(TargetLang.promptName('lzh'), 'Classical Chinese (Traditional) (文言文（繁體）)');
  assert.equal(TargetLang.promptName('lzh-Hans'), 'Classical Chinese (Simplified) (文言文（简体）)');
  for (const code of ['lzh', 'lzh-Hans']) assert.equal(TargetLang.direction(code), 'ltr');
  // Only a tag that says Simplified is lzh-Hans; every other Classical Chinese tag is lzh.
  assert.equal(TargetLang.fromTag('lzh'), 'lzh');
  assert.equal(TargetLang.fromTag('lzh-Hant'), 'lzh');
  assert.equal(TargetLang.fromTag('lzh-TW'), 'lzh');
  assert.equal(TargetLang.fromTag('lzh-Hans'), 'lzh-Hans');
  assert.equal(TargetLang.fromTag('lzh-hans-CN'), 'lzh-Hans');
  // Every UI language has its own name for both: a UI language added without one
  // would list these entries in English among names Intl wrote in that language,
  // and the two must never read the same.
  for (const ui of UI_LANGUAGES) {
    const [traditional, simplified] = ['lzh', 'lzh-Hans'].map((code) => TargetLang.nameOf(code, ui));
    assert.notEqual(traditional, simplified, `UI ${ui} names both scripts alike`);
    if (ui === 'en') continue;
    assert.notEqual(traditional, 'Classical Chinese (Traditional)', `no Classical Chinese name for UI ${ui}`);
    assert.notEqual(simplified, 'Classical Chinese (Simplified)', `no Simplified Classical Chinese name for UI ${ui}`);
  }
  // The built-in engine has no Classical Chinese: AI only, like the other 37.
  assert.equal(eng.supportsTarget('lzh'), false);
  assert.equal(eng.supportsTarget('lzh-Hans'), false);
  // The rest still ask Intl.
  assert.equal(TargetLang.nameOf('zh-CN', 'en'), 'Simplified Chinese');
});

test('options are in the UI language, menu form, sorted by its collation', () => {
  for (const ui of UI_LANGUAGES) {
    const list = TargetLang.options(ui);
    assert.equal(list.length, 78);
    const collator = new Intl.Collator(ui);
    for (let i = 0; i < list.length; i += 1) {
      assert.equal(list[i].label, TargetLang.nameOf(list[i].value, ui));
      if (i > 0) assert.ok(collator.compare(list[i - 1].label, list[i].label) <= 0, `${ui} out of order at ${i}`);
    }
  }
  assert.deepEqual(TargetLang.options('en', TargetLang.CLOUD_TARGETS).map((o) => o.value).sort(),
    OLD_TEN.slice().sort());
});

test('the built-in engine asks lang-tags whether the page language fits, instead of keeping a list', () => {
  // pageLangFits decides whether the page's language could plausibly be the
  // language of a short block or of something typed into the input dialog. A
  // list in the engine is another thing to keep in step, and it used to be
  // filtered to SUPPORTED_LANGS: an unsupported non-Latin page language (kk,
  // sr) then counted as Latin, so its own Cyrillic text was ruled out.
  const source = engineSource();
  assert.doesNotMatch(source, /NON_LATIN_LANGS/, 'the engine grew its own script list again');
  assert.match(source, /const pageLangFits = LangTags\.langFitsText;/, 'pageLangFits should be lang-tags\' answer');
  // The script question itself has one owner, shared/lang-tags.js, and its
  // answer comes from Intl, not a literal.
  assert.match(repoFile('shared/lang-tags.js'), /function langFitsText\([^)]*\) \{[\s\S]*?new Intl\.Locale[\s\S]*?\.maximize\(\)\.script/,
    'a language\'s script should be Intl\'s answer, not a literal');

  // And the derivation has to actually have an answer for every target we
  // offer — a language Intl cannot place would fall to the catch branch.
  for (const lang of TargetLang.SUPPORTED) {
    assert.ok(new Intl.Locale(lang).maximize().script, `Intl cannot place the script of '${lang}'`);
  }
});

test('nobody grows a second copy of the list', () => {
  for (const [rel, source] of [['the service worker', workerSource()], ['options.js', repoFile('options/options.js')]]) {
    assert.equal(source.includes('const supportedLangs = ['), false,
      `${rel} grew its own copy of the supported-language list again`);
  }
  assert.equal(repoFile('shared/target-lang.js').includes('VARIANTS'), false,
    'the region-variant table came back; fromTag step 7 covers it');
});

test('the settings page writes no language option by hand', () => {
  // options-languages.js draws them all from TargetLang; a hand-written
  // <option> is a second list and a name Intl did not compute.
  const html = repoFile('options/options.html');
  const selectBody = (id) => {
    const start = html.indexOf(`<select id="${id}"`);
    assert.notEqual(start, -1, `could not find #${id}`);
    return html.slice(start, html.indexOf('</select>', start));
  };
  // The target is the in-page dropdown (shared/lang-picker.js), whose menu
  // LangPicker.renderMenu fills each time it opens.
  // The first </div> after the root closes its (empty) menu.
  const targetStart = html.indexOf('<div class="ai-translator-lang-dropdown" id="targetLang"');
  assert.notEqual(targetStart, -1, 'could not find the #targetLang dropdown');
  const target = html.slice(targetStart, html.indexOf('</div>', targetStart));
  assert.doesNotMatch(target, /<option\b|ai-translator-lang-item/, '#targetLang has hand-written items');
  for (const id of ['uiLanguage', 'comicTargetLang', 'pdfTargetLang']) {
    const options = selectBody(id).match(/<option\b[^>]*>/g) || [];
    assert.equal(options.length, 1, `#${id} should keep only its empty "follow" option`);
    assert.match(options[0], /value=""/, `#${id}'s one option should be the empty one`);
  }
  assert.doesNotMatch(html, /data-i18n="lang(?:Zh|ZhCN|ZhTW|En|Ja|Ko|Fr|De|Es|Pt|Ru)"/);
  // The auto-translate language chips went with the ask bar (R33, D-351).
  assert.doesNotMatch(html, /data-lang="/);
});

test('the prompt names every target: English name plus autonym', async () => {
  const { languageNames } = await import('../../background/settings.js');
  assert.deepEqual(Object.keys(languageNames).sort(), TargetLang.SUPPORTED.slice().sort());
  for (const code of TargetLang.SUPPORTED) {
    assert.equal(languageNames[code], TargetLang.promptName(code), code);
  }
});

test('every locale carries the four new strings, and none of the eleven old names', async () => {
  await import('../../i18n/messages.js');
  const { I18N_MESSAGES } = globalThis;
  // Each old key named exactly: a /^lang/ prefix would also catch langAiOnly.
  const DELETED = ['langZh', 'langZhCN', 'langZhTW', 'langEn', 'langJa', 'langKo',
    'langFr', 'langDe', 'langEs', 'langPt', 'langRu'];
  const WITH_LANG = ['builtinTargetUnsupportedLocalOnly', 'builtinTargetUnsupportedAllowAi'];
  const PLAIN = ['langAiOnly', 'speechNoVoice'];
  for (const ui of UI_LANGUAGES) {
    const table = I18N_MESSAGES[ui];
    for (const key of DELETED) assert.equal(key in table, false, `${ui}.${key} should be gone`);
    for (const key of WITH_LANG) {
      assert.equal(typeof table[key], 'string', `${ui}.${key} missing`);
      // Exactly one slot: the name is filled in once, in its in-sentence form.
      assert.equal(table[key].split('{lang}').length, 2, `${ui}.${key} needs one {lang}`);
    }
    for (const key of PLAIN) {
      assert.equal(typeof table[key], 'string', `${ui}.${key} missing`);
      assert.ok(table[key].length > 0 && !table[key].includes('{lang}'), `${ui}.${key}`);
    }
    assert.equal(table.inputChipTranslateTo.split('{lang}').length, 2, `${ui}.inputChipTranslateTo`);
  }
});
