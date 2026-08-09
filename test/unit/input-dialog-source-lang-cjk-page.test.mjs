// The mirror of the reported bug, and the more common one for this
// extension's users: on a Chinese page, typing "animation" into the input
// dialog and asking for Chinese gave src='zh', tgt='zh' — the equal-language
// short-circuit handed the word straight back.
//
// Separate file from input-dialog-source-lang.test.mjs because the engine
// caches the page's language for the life of the document, so one page
// language per process.
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { installEngineHarness } from './helpers/engine-harness.mjs';

const CHINESE_PAGE = '这是一个中文网页，正文里全部都是中文句子，用来给页面语言探测取样。'.repeat(20);

const { ctx, translateCalls } = await installEngineHarness({ pageText: CHINESE_PAGE });

function typedIntoDialog(text, targetLang) {
  return ctx.requestTranslation({
    type: 'TRANSLATE',
    text,
    targetLang,
    mode: 'text',
    standaloneText: true,
  });
}

test('an English word typed on a Chinese page is translated, not echoed back', async () => {
  translateCalls.length = 0;
  const result = await typedIntoDialog('animation', 'zh-CN');

  assert.notEqual(result.translation, 'animation', 'the input came straight back untranslated');
  assert.equal(translateCalls.length, 1, 'nothing was handed to the built-in translator');
  assert.equal(translateCalls[0].sourceLanguage, 'en', 'the page language was used as the source');
  assert.equal(translateCalls[0].targetLanguage, 'zh');
});

test('the page language is only rejected when its script disagrees', async () => {
  // A Chinese word typed on a Chinese page is Chinese; nothing here should
  // push the source away from the page just because the text was typed.
  translateCalls.length = 0;
  await typedIntoDialog('动画', 'en');

  assert.equal(translateCalls[0].sourceLanguage, 'zh');
});

test('page text on a Chinese page still falls back to the page language', async () => {
  translateCalls.length = 0;
  await ctx.requestTranslation({ type: 'TRANSLATE', text: '更多', targetLang: 'en', mode: 'text' });

  assert.equal(translateCalls[0].sourceLanguage, 'zh', 'lost the page-language fallback');
});
