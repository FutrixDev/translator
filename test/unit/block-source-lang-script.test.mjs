// 整页翻译的块，源语言在判不准时拿页面语言兜底 —— 但页面语言的字母体系得和这
// 一块对得上。x.com 的时间线整页是英文，夹在里面的一条中文推文不到 40 字，旧
// 逻辑直接给它 en，于是 en→zh 的内置模型硬译中文：真 Chrome 实测
// `<span1>谁懂这个座位的含金量啊</span1>` 回来是 `<span1> span1>`，页面上只剩
// 一截「span1>」。
//
// 整个文件跑在一张英文页上（引擎把页面语言缓存到文档结束，一个进程只有一种）；
// 反方向（中文页上的拉丁短块）在 block-source-lang-script-zh-page.test.mjs。
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { installEngineHarness } from './helpers/engine-harness.mjs';

const ENGLISH_PAGE = 'The quick brown fox jumps over the lazy dog, again and again. '.repeat(20);
const TWEET = '<span1>谁懂这个座位的含金量啊</span1>';

const { ctx, translateCalls } = await installEngineHarness({ pageText: ENGLISH_PAGE });
const eng = ctx.engine;

test('a short Chinese block on an English page is read as Chinese, not as the page', async () => {
  assert.equal(await eng.resolveSourceLang(TWEET, '', false, undefined), 'zh');
});

test('a short Latin block on an English page still takes the page language', async () => {
  assert.equal(await eng.resolveSourceLang('Bonjour', '', false, undefined), 'en');
});

test('a Chinese tweet with a Chinese target never reaches the built-in model', async () => {
  translateCalls.length = 0;
  const response = await ctx.requestTranslation({
    type: 'TRANSLATE_BATCH_FAST',
    texts: [TWEET],
    targetLang: 'zh-CN',
    delimiter: '⟪⟫⟪⟫⟪⟫',
  });
  assert.deepEqual(translateCalls, [], 'the Chinese tweet was pushed through a translation model');
  // 原样退回：page/batch.js 的 shouldSkipTranslation 据此不插译文
  assert.deepEqual(response.translations, [TWEET]);
});

test('the same tweet with an English target is translated from Chinese', async () => {
  translateCalls.length = 0;
  await ctx.requestTranslation({
    type: 'TRANSLATE_BATCH_FAST',
    texts: [TWEET],
    targetLang: 'en',
    delimiter: '⟪⟫⟪⟫⟪⟫',
  });
  assert.equal(translateCalls.length, 1);
  assert.equal(translateCalls[0].sourceLanguage, 'zh');
});

test('a frame language whose script contradicts the block is not used either', async () => {
  assert.equal(await eng.resolveSourceLang(TWEET, '', false, 'fr'), 'zh');
});
