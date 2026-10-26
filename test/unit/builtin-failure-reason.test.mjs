// 内置引擎失败时，报给用户的原因得是真的那一个。
//
// 以前两处都会冒充成「内置翻译不支持这个语言对」：availability() 本身抛了错，
// 和整批每一段都没译出来（空结果、占位符丢失、translate() 抛错）。英译中整页翻译
// 时用户看到的就是这一句，目标语言明明支持。现在前者是 probeFailed、后者是
// allSegmentsFailed，cause 带着真实错误；只有第一段本来就是语言对不支持时，
// 整批才还报语言对。
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { installEngineHarness } from './helpers/engine-harness.mjs';

const ENGLISH_PAGE = 'The quick brown fox jumps over the lazy dog, again and again. '.repeat(20);

const { ctx } = await installEngineHarness({ pageText: ENGLISH_PAGE });

// 没有 API Key、没登录：不许回落 AI，错误原样回到调用方。ctx.t 原样回键名。
const PARAGRAPHS = [
  'Compound yourself. Compounding is magic, so look for it everywhere.',
  'Have almost too much self-belief, and learn to think independently.',
];

// 引擎按语言对缓存实例，建过的对不再问 availability：每个测试用自己的目标语言。
function batch(targetLang, texts = PARAGRAPHS) {
  return ctx.requestTranslation({ type: 'TRANSLATE_BATCH_FAST', feature: 'page', texts, targetLang });
}

// 换掉 Translator 的一部分，跑完放回去。
async function withTranslator(patch, run) {
  const original = { ...globalThis.self.Translator };
  Object.assign(globalThis.self.Translator, patch);
  try {
    return await run();
  } finally {
    Object.assign(globalThis.self.Translator, original);
  }
}

// 截住 console.warn：失败停下的那一层要把真实错误记一次。
async function capturingWarnings(run) {
  const warned = [];
  const original = console.warn;
  console.warn = (...args) => warned.push(args);
  try {
    return { result: await run(), warned };
  } finally {
    console.warn = original;
  }
}

function translatingWith(translate) {
  return { create: async () => ({ translate, destroy() {} }) };
}

test('an availability probe that throws is reported as a failed probe, not an unsupported pair', async () => {
  const broken = new Error('availability exploded');
  const { result, warned } = await capturingWarnings(() => withTranslator(
    { availability: async () => { throw broken; } },
    () => ctx.requestTranslation({ type: 'TRANSLATE', feature: 'selection', text: PARAGRAPHS[0], targetLang: 'fr', mode: 'text' }),
  ));
  assert.equal(result.error, 'builtinUnavailable');
  const stopped = warned.find((args) => String(args[0]).includes('builtin unavailable'));
  assert.ok(stopped, 'the probe error was never logged');
  assert.equal(stopped[1], 'probeFailed');
  assert.equal(stopped[2], broken);
});

test('a batch where every paragraph comes back empty reports that, with the first error as cause', async () => {
  const { result, warned } = await capturingWarnings(() => withTranslator(
    translatingWith(async () => ''),
    () => batch('zh-CN'),
  ));
  assert.equal(result.error, 'builtinUnavailable');
  const stopped = warned.find((args) => String(args[0]).includes('builtin unavailable'));
  assert.ok(stopped, 'the batch failure was never logged where it stopped');
  assert.equal(stopped[1], 'allSegmentsFailed');
  assert.match(stopped[2].message, /empty result/);
});

test('a batch where every paragraph throws carries the first paragraph\'s own error', async () => {
  let calls = 0;
  const { result, warned } = await capturingWarnings(() => withTranslator(
    translatingWith(async () => { calls += 1; throw new Error(`segment ${calls} broke`); }),
    () => batch('ja'),
  ));
  assert.equal(result.error, 'builtinUnavailable');
  const stopped = warned.find((args) => String(args[0]).includes('builtin unavailable'));
  assert.equal(stopped[1], 'allSegmentsFailed');
  assert.equal(stopped[2].message, 'segment 1 broke');
});

test('a batch whose paragraphs really are an unsupported pair still says so', async () => {
  const result = await withTranslator(
    { availability: async () => 'unavailable' },
    () => batch('de'),
  );
  assert.equal(result.error, 'builtinUnsupportedPair');
});

test('one failed paragraph among good ones is dropped, not the whole batch', async () => {
  const result = await withTranslator(
    translatingWith(async (text) => (text.startsWith('Compound') ? '' : `译:${text}`)),
    () => batch('ko'),
  );
  assert.equal(result.error, undefined);
  assert.deepEqual(result.translations, ['', `译:${PARAGRAPHS[1]}`]);
});
