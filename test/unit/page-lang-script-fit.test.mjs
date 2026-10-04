// 页面语言能不能给一段短文字兜底，先看字母体系对不对得上（content/engine/
// languages.js 的 pageLangFits，答案来自 shared/lang-tags.js 的 langFitsText）。
//
// 曾经的判法是一张从 SUPPORTED_LANGS 里筛出来的非拉丁语言表：
//   - 端上不支持的非拉丁语言（kk、sr、mn）不在表里，于是被当成拉丁语言 ——
//     kk 页面上的西里尔短句判成「不可能是 kk」，掉到检测器那里，真 Chrome 上
//     很容易被判成 ru，再被送进 ru 的模型；
//   - 把表放开到所有语言又会反过来：Intl 把 sr 补成西里尔，拉丁字母写的塞尔维亚
//     语被判成「不可能是 sr」，一路落到 lastResortLang 的 'en'。
// 两条都得对：sr 两套字都常见，标签写明了文字时才只认那一套。
//
// 页面语言由第四个参数（子 frame 量好的页面语言）代答，一个进程里就能换着问。
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { installEngineHarness } from './helpers/engine-harness.mjs';

const { ctx } = await installEngineHarness({ pageText: 'unused: every call below passes its page language' });
const eng = ctx.engine;

const block = (text, pageLang) => eng.resolveSourceLang(text, '', false, pageLang);
const typed = (text, pageLang) => eng.resolveSourceLang(text, '', true, pageLang);

test('Latin-script Serbian on a Serbian page takes the page language', async () => {
  assert.equal(await block('Ovo je tekst', 'sr'), 'sr');
  assert.equal(await typed('Ovo je tekst', 'sr'), 'sr');
});

test('Cyrillic-script Serbian on a Serbian page takes the page language too', async () => {
  assert.equal(await block('Ово је текст', 'sr'), 'sr');
  assert.equal(await typed('Ово је текст', 'sr'), 'sr');
});

test('an unsupported non-Latin page language still owns its own script', async () => {
  assert.equal(await block('Бұл мәтін', 'kk'), 'kk');
  assert.equal(await block('Энэ бол текст', 'mn'), 'mn');
});

test('Cyrillic-script Uzbek on an Uzbek page takes the page language', async () => {
  assert.equal(await block('Бу матн', 'uz'), 'uz');
  assert.equal(await block('Bu matn', 'uz'), 'uz');
});

test('a script the page language cannot be written in is still vetoed', async () => {
  // 中文页面上的拉丁短词：页面语言出局，最后按英文处理。
  assert.equal(await typed('Ovo je tekst', 'zh'), 'en');
  // 西里尔短句配英文页面：页面语言出局，检测器这里也答不出，交给 AI 自己认。
  assert.equal(await block('Ово је текст', 'en'), '');
});

test('a page language Intl cannot place is not used as a source', async () => {
  // <html lang="english">：曾经因为不在非拉丁表里而被当成拉丁语言照用。
  assert.equal(await block('Hello there', 'english'), 'en');
});
