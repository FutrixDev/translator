// 繁体的一页，简体的目标语言，走内置引擎那条路。
//
// 检测器分不出简繁：繁体和简体它都答一个光秃秃的 `zh`（真实 Chrome 里实测过，
// 两边都是 100%、isReliable，夹具照抄了这个行为）。而内置引擎认的是两门语言 ——
// 'zh' 是简体，'zh-Hant' 是繁体。源语言压成 zh 之后，translateWithBuiltin 里
// `src === tgt` 那一档就成立了：原文原样返回，整页一个字都不译，也不报错。
//
// 上游的闸门（batch.js 的「这一段已经是目标语言了」）补过简繁之后照样会放行这
// 一段 —— 闸门开了，引擎在下游又自己判了一次，判的还是压成 zh 的那一次。所以
// 简繁必须在 detectLanguageOf 里就数出来，那是「这段文字是什么语言」的唯一出处。
//
// 整页翻译的 e2e 盖不到这里：headless Chrome 没有 Translator API，那条 spec 全
// 程走的是 AI 回落。
//
// 引擎按文档缓存页面语言，所以一个进程只有一门页面语言，这一份要单独一个文件。
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { installEngineHarness } from './helpers/engine-harness.mjs';

const HANT_PAGE = '這個網站說明了兩個系統之間的關係，並且詳細記錄了每一個實驗的結果與數據。'.repeat(20);
const HANT_BLOCK = '這一段是繁體中文的正文，長度足夠讓引擎自己去問一次檢測器，而不是直接拿頁面語言。';
const HANS_BLOCK = '这一段是简体中文的正文，长度足够让引擎自己去问一次检测器，而不是直接拿页面语言。';

const { ctx, translateCalls } = await installEngineHarness({ pageText: HANT_PAGE });

const translate = (text, targetLang) =>
  ctx.requestTranslation({ type: 'TRANSLATE', text, targetLang, mode: 'text' });

test('繁体正文配简体目标：真的送进引擎，而不是原样退回', async () => {
  translateCalls.length = 0;
  const result = await translate(HANT_BLOCK, 'zh-CN');

  assert.equal(translateCalls.length, 1, '一个字都没送进内置引擎——又被同语言短路了');
  assert.equal(translateCalls[0].sourceLanguage, 'zh-Hant', '源语言被压成了 zh');
  assert.equal(translateCalls[0].targetLanguage, 'zh');
  assert.notEqual(result.translation, HANT_BLOCK, '原文原样回来了');
});

test('短到不自己探的块，拿的也是补过简繁的页面语言', async () => {
  // 低于自探门槛（40 字）时走的是页面级缓存那条路。两条路都得补，否则短句永远
  // 不译、长句译——页面上看是「有的翻了有的没翻」。
  translateCalls.length = 0;
  await translate('這個', 'zh-CN');

  assert.equal(translateCalls.length, 1);
  assert.equal(translateCalls[0].sourceLanguage, 'zh-Hant', '页面语言那条路没补简繁');
});

test('同为繁体时仍旧原样退回：这不是「总是翻一遍」', async () => {
  translateCalls.length = 0;
  const result = await translate(HANT_BLOCK, 'zh-TW');

  assert.equal(translateCalls.length, 0, '繁体译繁体，白花一次推理');
  assert.equal(result.translation, HANT_BLOCK);
});

test('繁体页面上引用的一段简体，按这一段自己的书写系统算', async () => {
  // 逐块自探存在的意义就是这个：判的是这一段，不是这一页。
  translateCalls.length = 0;
  const result = await translate(HANS_BLOCK, 'zh-CN');

  assert.equal(translateCalls.length, 0, '简体译简体，白花一次推理');
  assert.equal(result.translation, HANS_BLOCK);
});

test('繁体页面翻成英文照旧', async () => {
  translateCalls.length = 0;
  await translate(HANT_BLOCK, 'en');

  assert.equal(translateCalls[0].sourceLanguage, 'zh-Hant');
  assert.equal(translateCalls[0].targetLanguage, 'en');
});
