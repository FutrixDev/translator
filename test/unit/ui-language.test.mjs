// The extension's UI language used to be derived from the *target* language:
// choosing to translate pages into Japanese also turned the settings page, the
// popup, the float-ball menu and the context menu Japanese, and there was no
// way to read the extension in English while translating into Japanese. Two
// unrelated choices were wired to one control.
//
// getUILanguage() now answers from the user's own `uiLanguage` setting, falling
// back to the browser. This suite pins both halves: the function's behaviour,
// and the fact that no caller went back to handing it a target language.
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { optionsSource, popupSource, uploadPageSource, workerSource } from './helpers/sources.mjs';

const repoFile = (rel) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');

// No `export` — messages.js is a classic script that publishes onto globalThis.
await import('../../i18n/messages.js');
const { getUILanguage, UI_LANGUAGES, I18N_MESSAGES } = globalThis;

// ------------------------------------------------------------------ behaviour

test('an explicit setting wins', () => {
  for (const lang of UI_LANGUAGES) {
    assert.equal(getUILanguage(lang), lang);
  }
});

test('empty means follow the browser, and there is always an answer', () => {
  // Node has no chrome.i18n and navigator.language is the host's, so the only
  // guarantee worth asserting is that the result is a language we can draw.
  for (const empty of ['', null, undefined, '   ']) {
    assert.ok(UI_LANGUAGES.includes(getUILanguage(empty)), `${JSON.stringify(empty)} fell off the list`);
  }
});

test('a language we have no strings for lands on English', () => {
  assert.equal(getUILanguage('xx'), 'en');
  assert.equal(getUILanguage('sw-KE'), 'en');
});

test('region tags resolve to the block that actually holds their strings', () => {
  assert.equal(getUILanguage('en-GB'), 'en');
  assert.equal(getUILanguage('pt-BR'), 'pt');
  assert.equal(getUILanguage('fr-CA'), 'fr');
  // The one that cannot be resolved by stripping the region: Hong Kong and
  // Macau read traditional, Singapore reads simplified.
  assert.equal(getUILanguage('zh-CN'), 'zh-CN');
  assert.equal(getUILanguage('zh-SG'), 'zh-CN');
  assert.equal(getUILanguage('zh-Hans'), 'zh-CN');
  assert.equal(getUILanguage('zh-TW'), 'zh-TW');
  assert.equal(getUILanguage('zh-HK'), 'zh-TW');
  assert.equal(getUILanguage('zh-MO'), 'zh-TW');
  assert.equal(getUILanguage('zh-Hant'), 'zh-TW');
  // Bare 'zh' has to pick one; simplified is the larger population.
  assert.equal(getUILanguage('zh'), 'zh-CN');
});

test('every language it can return has a string block', () => {
  for (const lang of UI_LANGUAGES) {
    assert.ok(I18N_MESSAGES[lang], `i18n/messages.js has no '${lang}' block`);
  }
});

// -------------------------------------------------------------------- callers

// Five surfaces call getUILanguage. Each must pass the UI-language setting —
// the regression this suite exists to stop is any of them going back to
// targetLang, which no test at runtime would notice because the UI would simply
// render in a language the user did not ask for.
//
// 服务工作者整个算一个调用方：它自己拆成了一组模块（background/*.js），
// getUILanguage 具体落在哪个文件里是实现细节，这里问的是「worker 有没有拿
// targetLang 去喂它」。
const CALLERS = [
  ['the service worker', workerSource],
  ['the popup', popupSource],
  ['the settings page', optionsSource],
  ['the upload page', uploadPageSource],
  ['content/content-bootstrap.js', () => repoFile('content/content-bootstrap.js')],
];

test('no caller feeds getUILanguage a target language', () => {
  for (const [rel, load] of CALLERS) {
    const source = load();
    const calls = [...source.matchAll(/getUILanguage\(([^)]*)\)/g)].map((m) => m[1].trim());
    assert.ok(calls.length > 0, `${rel} no longer calls getUILanguage`);
    for (const argument of calls) {
      assert.ok(
        !/targetLang/i.test(argument),
        `${rel}: getUILanguage(${argument}) — the UI language is not the target language`,
      );
    }
  }
});

test('changing the UI language repaints the context menu right away', () => {
  // The context-menu titles are drawn with uiLanguageOf(settings), and the only
  // thing that redraws them is this storage listener. Watching targetLang alone
  // leaves the menu speaking the *old* UI language until the service worker
  // next cold-starts — while the popup and every content script switched the
  // moment the setting was written. Nothing throws; the menu is simply wrong.
  const worker = workerSource();
  const calls = [...worker.matchAll(/refreshContextMenuTitles\(\);/g)].map((m) => m.index);
  assert.ok(calls.length > 0, 'the worker no longer repaints the context-menu titles');
  const guards = calls.map((at) => worker.slice(Math.max(0, at - 400), at));
  assert.ok(guards.some((guard) => /changes\.uiLanguage/.test(guard)),
    'no storage listener repaints the context menu when uiLanguage changes');
  assert.ok(guards.some((guard) => /changes\.targetLang/.test(guard)),
    'the target language stopped repainting the context menu');
});

test('the settings page offers the choice, and "follow browser" is the empty value', () => {
  const html = repoFile('options/options.html');
  const start = html.indexOf('<select id="uiLanguage">');
  assert.notEqual(start, -1, 'options.html has no uiLanguage select');
  const block = html.slice(start, html.indexOf('</select>', start));
  const values = [...block.matchAll(/value="([^"]*)"/g)].map((m) => m[1]);
  assert.equal(values[0], '', 'the first option must be the empty "follow browser" value');
  assert.deepEqual(values.slice(1).sort(), [...UI_LANGUAGES].sort());
});
