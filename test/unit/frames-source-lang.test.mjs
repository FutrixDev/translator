// 子 frame 的翻译请求经中继在顶层执行（content/frames/child.js），而短文本的
// 源语言要拿「页面语言」兜底 —— 在顶层执行时，顶层自己的 document 答的是顶层
// 的语言，不是那个 frame 的。英文新闻页里嵌一个法文评论区，评论区的一行短评就
// 会被当成英文送进内置翻译器，equal-language 短路或者一句乱译。
//
// 所以子 frame 把自己量好的页面语言写进消息（pageSourceLang），引擎在
// resolveSourceLang 里用它代替 getPageSourceLang。这里验这条兜底：只在要兜底
// 的时候起作用，hint 与逐块自测照旧优先。
//
// 整个文件跑在一张英文页上（引擎把页面语言缓存到文档结束，一个进程只有一种）。
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { installEngineHarness } from './helpers/engine-harness.mjs';

const ENGLISH_PAGE = 'The quick brown fox jumps over the lazy dog, again and again. '.repeat(20);

const { ctx, translateCalls } = await installEngineHarness({ pageText: ENGLISH_PAGE });
const eng = ctx.engine;

test('without a fallback, a short block takes this document language', async () => {
  assert.equal(await eng.resolveSourceLang('Bonjour', '', false, undefined), 'en');
});

test('a fallback from the frame replaces this document language', async () => {
  assert.equal(await eng.resolveSourceLang('Bonjour', '', false, 'fr'), 'fr');
});

test('an empty fallback is an answer: the frame could not tell, and neither can we', async () => {
  // 子 frame 量不出自己的语言时写的是空串。拿顶层的语言顶上去就是猜错。
  assert.equal(await eng.resolveSourceLang('Bonjour', '', false, ''), '');
});

test('a hint still wins over the fallback', async () => {
  assert.equal(await eng.resolveSourceLang('Bonjour', 'de', false, 'fr'), 'de');
});

test('a long block still detects itself; the fallback is only a fallback', async () => {
  const long = 'This paragraph is long enough for the detector to be sure about it.';
  assert.equal(await eng.resolveSourceLang(long, '', false, 'fr'), 'en');
});

test('typed text that cannot be read falls back to the frame language, not the top one', async () => {
  // 'ok' 在 CLD 那里判不准；纯拉丁文本、拉丁页面语言，兜底就是那个 frame 的。
  assert.equal(await eng.resolveSourceLang('ok', '', true, 'de'), 'de');
});

test('a relayed request carries the frame language into the built-in translator', async () => {
  translateCalls.length = 0;
  await ctx.requestTranslation({
    type: 'TRANSLATE',
    text: 'Bonjour',
    targetLang: 'zh-CN',
    pageSourceLang: 'fr',
  });
  assert.equal(translateCalls.length, 1, 'nothing reached the built-in translator');
  assert.equal(translateCalls[0].sourceLanguage, 'fr');
});

test('the same request from this document still uses this document language', async () => {
  translateCalls.length = 0;
  await ctx.requestTranslation({ type: 'TRANSLATE', text: 'Bonjour', targetLang: 'zh-CN' });
  assert.equal(translateCalls[0].sourceLanguage, 'en');
});
