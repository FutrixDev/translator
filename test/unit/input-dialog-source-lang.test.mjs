// The input dialog is a scratchpad. What you type into it has nothing to do
// with the page it happens to be open on — you can be reading an English page
// and want a Chinese word turned into English.
//
// The built-in engine did not know that. `resolveSourceLang()` self-detects
// only from 40 characters up; below that it takes the *page's* language as the
// source. So typing 动画 on an English page gave src='en', tgt='en', and
// `translateWithBuiltin` short-circuits equal languages by returning the input
// untouched. The reported symptom was exactly that: pick English, press
// 翻译, get 动画 back.
//
// Built-in is the default engine, so this is what most users hit.
//
// This file is the English-page half; the Chinese-page half is in
// input-dialog-source-lang-cjk-page.test.mjs, because the engine caches the
// page language for the life of the document.
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { installEngineHarness } from './helpers/engine-harness.mjs';

const ENGLISH_PAGE = 'The quick brown fox jumps over the lazy dog, again and again. '.repeat(20);

const { ctx, translateCalls } = await installEngineHarness({ pageText: ENGLISH_PAGE });

function typedIntoDialog(text, targetLang) {
  return ctx.requestTranslation({
    type: 'TRANSLATE',
    text,
    targetLang,
    mode: 'text',
    standaloneText: true,
  });
}

// ==================== the reported bug ====================

test('a Chinese word typed on an English page is translated, not echoed back', async () => {
  translateCalls.length = 0;
  const result = await typedIntoDialog('动画', 'en');

  assert.notEqual(result.translation, '动画', 'the input came straight back untranslated');
  assert.equal(translateCalls.length, 1, 'nothing was handed to the built-in translator');
  assert.equal(translateCalls[0].sourceLanguage, 'zh', 'the page language was used as the source');
  assert.equal(translateCalls[0].targetLanguage, 'en');
});

test('the page language is never consulted for text that was typed', async () => {
  // The page is English throughout this file, and this phrase is far under the
  // 40 characters that block-level self-detection needs.
  translateCalls.length = 0;
  await typedIntoDialog('这是一段很短的中文', 'en');

  assert.equal(translateCalls[0].sourceLanguage, 'zh');
});

test('text that really is in the target language still comes back untouched', async () => {
  // The equal-language short-circuit is right; it was being fed the wrong
  // source. Typing English and asking for English is a genuine no-op.
  translateCalls.length = 0;
  const result = await typedIntoDialog('the quick brown fox', 'en');

  assert.equal(result.translation, 'the quick brown fox');
  assert.equal(translateCalls.length, 0, 'asked the translator to convert en to en');
});

test('a short Latin word is not translated as whatever CLD guessed', async () => {
  // CLD really does answer 'ja' for "animation" and 'sr' for "hello". Trusting
  // that would hand the built-in translator the wrong source language and turn
  // one bug into another, so an unreliable answer is only believed when the
  // script itself pins the language.
  translateCalls.length = 0;
  await typedIntoDialog('animation', 'zh-CN');

  assert.equal(translateCalls[0].sourceLanguage, 'en', 'believed the guess that animation is Japanese');
});

test('kana is read as Japanese even on an English page', async () => {
  translateCalls.length = 0;
  await typedIntoDialog('アニメ', 'en');

  assert.equal(translateCalls[0].sourceLanguage, 'ja');
});

// ==================== the page's own text is unaffected ====================

test('page text still falls back to the page language when it is too short to detect', async () => {
  // Selection, hover and whole-page translation all send text that came off
  // the page, where the page's language is the best available answer for a
  // fragment too short to detect on its own. That behaviour has to stay.
  translateCalls.length = 0;
  await ctx.requestTranslation({ type: 'TRANSLATE', text: 'Read more', targetLang: 'ja', mode: 'text' });

  assert.equal(translateCalls[0].sourceLanguage, 'en', 'lost the page-language fallback');
});
