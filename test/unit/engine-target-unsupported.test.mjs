// 76 门目标语言里，内置引擎只认得 39 门。手动引擎是内置、又不许回退 AI 时，选一门
// 端上译不了的语言会得到什么？
//
// 以前是一句笼统的「内置翻译不支持这个语言对」—— 用户会以为是原文的问题。现在
// 目标语言本身译不了时点它的名（句中形：法语界面下是「persan」不是「Persan」），
// 只有目标语言没问题、这一对仍然不行时才是那句笼统的。不静默回退 AI，也不退成英文。
//
// 放在单测而不是 e2e：e2e 的 Chromium 可能根本没有 Translator，先走的是
// UNSUPPORTED_ENV 那条分支，永远到不了这里。
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { installEngineHarness } from './helpers/engine-harness.mjs';
import { messageCatalog } from './helpers/sources.mjs';

const ENGLISH_PAGE = 'The quick brown fox jumps over the lazy dog, again and again. '.repeat(20);

const { ctx, translateCalls, sentToAI } = await installEngineHarness({ pageText: ENGLISH_PAGE });

// 语言名由真的 content-language.js 按界面语言现算；界面语言定成法语，句中形才看得出来。
const UI = 'fr';
const FR = messageCatalog()[UI];
ctx.uiLanguage = () => UI;
ctx.t = (key) => FR[key];
await import('../../content/content-language.js');

function request(targetLang) {
  return ctx.requestTranslation({ type: 'TRANSLATE', text: 'Hello there', targetLang, mode: 'text' });
}

test('a target the built-in engine cannot translate into is named, in its in-sentence form', async () => {
  translateCalls.length = 0;
  sentToAI.length = 0;
  const result = await request('fa');
  const name = globalThis.TargetLang.nameOf('fa', UI, { inSentence: true });
  assert.equal(name, 'persan');
  assert.equal(result.error, FR.builtinTargetUnsupportedLocalOnly.replace('{lang}', name));
  assert.equal(translateCalls.length, 0, 'the built-in translator was asked anyway');
  assert.equal(sentToAI.length, 0, 'an unsupported target fell back to AI without being allowed to');
});

test('a supported target on a pair that still fails keeps the generic sentence', async () => {
  const availability = globalThis.self.Translator.availability;
  globalThis.self.Translator.availability = async () => 'unavailable';
  try {
    const result = await request('fr');
    assert.equal(result.error, FR.builtinUnsupportedPair);
  } finally {
    globalThis.self.Translator.availability = availability;
  }
});
