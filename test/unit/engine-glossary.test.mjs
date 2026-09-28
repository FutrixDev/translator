// 引擎这一族里的词表（P1-C §6.3）：content/engine/glossary.js 的匹配器与内置引擎的
// 占位保护，content/engine/addenda.js 的切份，以及 content-translation-engine.js 的
// sendToModel 按份发送。
//
// 快照由 eng.glossary.fromEntries 直接建（测试台没有 ctx.glossary），经
// ctx.sendTranslation 的第二个参数传进去 —— 缓存层就是这样把它那一份快照交给
// 引擎的：先按这一页盖语域（ctx.withPromptAddenda），再送出（request 下面）。
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { installEngineHarness } from './helpers/engine-harness.mjs';
import { engineSource } from './helpers/sources.mjs';

const PAGE = 'This page is written in ordinary English prose, long enough for the detector to be sure about it.'.repeat(6);

const { ctx, setApiKey } = await installEngineHarness({ pageText: PAGE });
await import('../../shared/storage-writer.js');
await import('../../shared/auto-stats.js');
setApiKey('test-key');

const eng = ctx.engine;
const request = (message, opts) => ctx.sendTranslation(ctx.withPromptAddenda(message), opts);
const snapOf = (entries) => eng.glossary.fromEntries(entries, `test-${Math.random()}`);
const matched = (snap, text) => snap.match(text).map((hit) => text.slice(hit.start, hit.end));

// 内置引擎：一个实例按语言对缓存，所以装一次、行为按用例换。
const builtin = { calls: [], behave: (text) => `[B] ${text}` };
self.Translator = {
  availability: async () => 'available',
  create: async () => ({
    translate: async (text) => {
      builtin.calls.push(text);
      return builtin.behave(text);
    },
    destroy() {},
  }),
};

// AI 那边：记下每一次发给服务工作者的消息，回话由用例定。
const ai = { sent: [], answer: async (message) => ({ translations: message.texts.map((t) => `[T] ${t}`) }) };
globalThis.chrome.runtime.sendMessage = async (message) => {
  ai.sent.push(message);
  return ai.answer(message);
};

function configure(patch) {
  Object.assign(ctx.settings, {
    translationEngine: 'builtin',
    autoTranslateEngine: 'builtin',
    engineFallback: 'off',
    autoAiDailyBudget: 0,
  }, patch);
  builtin.calls.length = 0;
  builtin.behave = (text) => `[B] ${text}`;
  ai.sent.length = 0;
  ai.answer = async (message) => ({ translations: message.texts.map((t) => `[T] ${t}`) });
}

function captureWarnings(run) {
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args);
  return Promise.resolve()
    .then(run)
    .then((value) => ({ value, warnings }))
    .finally(() => { console.warn = original; });
}

// ------------------------------------------------------------------ 匹配器

test('matcher: word boundaries only on the side whose character is a W-class letter or digit', () => {
  const snap = snapOf([{ s: 'GPT-4', t: 'GPT-4' }, { s: 'C++', t: 'C++' }]);
  assert.deepEqual(matched(snap, 'GPT-4 and GPT-45 and xGPT-4'), ['GPT-4']);
  // 「C++」只有前面要词边界：后面紧跟数字照样命中，前面粘着字母不命中。
  assert.deepEqual(matched(snap, 'C++17 but not aC++'), ['C++']);
  // 西里尔与希腊字母同属 W 类。
  const cyr = snapOf([{ s: 'сеть', t: 'net' }, { s: 'λόγος', t: 'logos' }]);
  assert.deepEqual(matched(cyr, 'сеть сетьи λόγος λόγοςα'), ['сеть', 'λόγος']);
});

test('matcher: CJK terms need no word boundary', () => {
  const snap = snapOf([{ s: '注意力', t: 'attention' }, { s: 'トークン', t: 'token' }]);
  assert.deepEqual(matched(snap, '自注意力机制与トークン化'), ['注意力', 'トークン']);
});

test('matcher: case-sensitive entries match exactly, the others in any case', () => {
  const snap = snapOf([{ s: 'Apple', t: '苹果公司', c: 1 }, { s: 'token', t: '词元' }]);
  assert.deepEqual(matched(snap, 'apple Apple APPLE'), ['Apple']);
  assert.deepEqual(matched(snap, 'Token TOKEN token'), ['Token', 'TOKEN', 'token']);
  // 同一起点、同样长：区分大小写的那条赢。
  const both = snapOf([{ s: 'Go', t: 'Go 语言', c: 1 }, { s: 'go', t: '去' }]);
  const [hit] = both.match('Go home');
  assert.equal(hit.entry.t, 'Go 语言');
});

test('matcher: leftmost, then longest, never overlapping; spaces match any whitespace', () => {
  const snap = snapOf([
    { s: 'neural', t: '神经' },
    { s: 'neural network', t: '神经网络' },
    { s: 'network model', t: '网络模型' },
  ]);
  assert.deepEqual(matched(snap, 'a neural network model'), ['neural network']);
  assert.deepEqual(matched(snap, 'a neural\n  network, a network model'), ['neural\n  network', 'network model']);
});

test('matcher: only text segments are searched, never placeholders or markers', () => {
  const snap = snapOf([{ s: '1', t: 'one' }, { s: 'b', t: 'bee' }]);
  const text = '{{1}} <b1>b</b1> 1';
  const hits = snap.match(text);
  assert.deepEqual(hits.map((hit) => [text.slice(hit.start, hit.end), hit.start]),
    [['b', text.indexOf('>b<') + 1], ['1', text.length - 1]]);
});

test('matcher: the engine family never writes an inline case modifier (Chrome 116 has none)', () => {
  assert.doesNotMatch(engineSource(), /\(\?i/);
});

// ------------------------------------------------------------ 内置引擎的保护

test('protect: at most 20 placeholders, numbered after the ids already in the text', () => {
  const snap = snapOf([{ s: 'attention', t: '注意力' }]);
  const source = `{{3}} ${Array.from({ length: 25 }, () => 'attention').join(' ')}`;
  const guarded = snap.protect(source, 4);
  assert.equal(guarded.ids.length, eng.glossary.MAX_PLACEHOLDERS);
  assert.equal(eng.glossary.MAX_PLACEHOLDERS, 20);
  assert.deepEqual(guarded.ids, Array.from({ length: 20 }, (_, k) => String(4 + k)));
  assert.equal(guarded.text.match(/attention/g).length, 5, 'the 21st hit onwards is sent as it is');
  assert.ok(guarded.text.startsWith('{{3}} {{4}} '), 'the math placeholder is left alone');
});

test('withGlossary: detects language on the source, restores terms, keep-original keeps the page spelling', async () => {
  const snap = snapOf([{ s: 'attention', t: '注意力' }, { s: 'transformer' }]);
  const source = 'Attention and the Transformer are what this ordinary English sentence is about.';
  const runs = [];
  const out = await eng.glossary.withGlossary(snap, source, async (text, extra) => {
    runs.push([text, { ...extra }]);
    return `[B] ${text}`;
  });
  assert.deepEqual(runs, [[
    '{{1}} and the {{2}} are what this ordinary English sentence is about.',
    { detectText: source },
  ]]);
  assert.equal(out, '[B] 注意力 and the Transformer are what this ordinary English sentence is about.');
});

test('withGlossary: an engine that echoes the protected text gets the source back', async () => {
  const snap = snapOf([{ s: 'attention', t: '注意力' }]);
  const source = 'attention please';
  const out = await eng.glossary.withGlossary(snap, source, async (text) => text);
  assert.equal(out, source);
});

test('withGlossary: a lost glossary placeholder is logged once, counted, and retried once without the glossary', async () => {
  const snap = snapOf([{ s: 'attention', t: '注意力' }]);
  const before = eng.glossary.stats().placeholderLosses;
  const runs = [];
  const { value, warnings } = await captureWarnings(() => eng.glossary.withGlossary(snap, 'x {{1}} attention', async (text, extra) => {
    runs.push([text, { ...extra }]);
    if (runs.length === 1) throw new eng.PlaceholderLossError(['2']);
    return `[B] ${text}`;
  }));
  assert.deepEqual(runs, [['x {{1}} {{2}}', { detectText: 'x {{1}} attention' }], ['x {{1}} attention', {}]]);
  assert.equal(value, '[B] x {{1}} attention');
  assert.equal(eng.glossary.stats().placeholderLosses, before + 1);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0][0], 'Blab Translation: builtin translator dropped glossary placeholders');
  assert.deepEqual(JSON.parse(JSON.stringify(warnings[0][1])), { lost: ['2'] });
});

test('withGlossary: losing only a math placeholder is thrown as it is, no retry, no count', async () => {
  const snap = snapOf([{ s: 'attention', t: '注意力' }]);
  const before = eng.glossary.stats().placeholderLosses;
  let runs = 0;
  await assert.rejects(
    eng.glossary.withGlossary(snap, 'x {{1}} attention', async () => {
      runs += 1;
      throw new eng.PlaceholderLossError(['1']);
    }),
    (error) => error instanceof eng.PlaceholderLossError && error.lost[0] === '1',
  );
  assert.equal(runs, 1);
  assert.equal(eng.glossary.stats().placeholderLosses, before);
});

test('builtin engine: PlaceholderLossError.lost names the ids the source had and the output lost', async () => {
  configure({});
  builtin.behave = (text) => `[B] ${text.replace('{{1}}', '')}`;
  const source = 'Energy {{1}} and mass {{2}} are both conserved in this ordinary English sentence.';
  const { value, warnings } = await captureWarnings(() => request(
    { type: 'TRANSLATE', text: source, targetLang: 'zh-CN', engine: 'builtin' }, { glossary: snapOf([]) }));
  assert.ok(value.error, JSON.stringify(value));
  const failed = warnings.find((args) => args[0] === 'Blab Translation: builtin translation failed');
  assert.ok(failed, JSON.stringify(warnings.map((args) => args[0])));
  assert.equal(failed[1].name, 'PlaceholderLossError');
  assert.deepEqual(failed[1].lost, ['1']);
});

test('builtin engine: a page batch through the glossary, then again with the placeholders dropped', async () => {
  configure({});
  const snap = snapOf([{ s: 'attention', t: '注意力' }]);
  const hit = 'Attention is all you need, says this ordinary English sentence.';
  const plain = 'This ordinary English sentence mentions no glossary term at all.';
  const message = { type: 'TRANSLATE_BATCH_FAST', texts: [hit, plain], targetLang: 'zh-CN' };

  const first = await request(message, { glossary: snap });
  assert.deepEqual(builtin.calls, ['{{1}} is all you need, says this ordinary English sentence.', plain]);
  assert.deepEqual(first.translations, [`[B] 注意力 is all you need, says this ordinary English sentence.`, `[B] ${plain}`]);
  assert.equal(first.engine, 'builtin');
  assert.equal(ai.sent.length, 0, 'the builtin branch sends nothing to the model, addenda included');

  builtin.calls.length = 0;
  builtin.behave = (text) => `[B] ${text.replace(/\{\{\d+\}\}/g, '')}`;
  const before = eng.glossary.stats().placeholderLosses;
  const { value } = await captureWarnings(() => request(message, { glossary: snap }));
  assert.deepEqual(builtin.calls, ['{{1}} is all you need, says this ordinary English sentence.', hit, plain]);
  assert.deepEqual(value.translations, [`[B] ${hit}`, `[B] ${plain}`]);
  assert.equal(eng.glossary.stats().placeholderLosses, before + 1);
});

// ------------------------------------------------------------ sendToModel 切份

const TERMS = Array.from({ length: 70 }, (_, k) => ({ s: `term${k}`, t: `术语${k}` }));
const TERM_TEXTS = TERMS.map((entry) => `We discuss ${entry.s} today.`);

test('sendToModel: over 60 entries splits the batch, sent one part after another, stitched back in order', async () => {
  configure({ translationEngine: 'ai' });
  const snap = snapOf(TERMS);
  let inFlight = 0;
  let overlapped = false;
  ai.answer = async (message) => {
    inFlight += 1;
    if (inFlight > 1) overlapped = true;
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
    return { translations: message.texts.map((t) => `[T] ${t}`) };
  };
  const result = await request(
    { type: 'TRANSLATE_BATCH_FAST', texts: TERM_TEXTS, targetLang: 'zh-CN' }, { glossary: snap });
  assert.equal(overlapped, false, 'parts are sent one after another');
  assert.deepEqual(ai.sent.map((m) => [m.texts.length, m.addenda.glossary.length]), [[60, 60], [10, 10]]);
  assert.deepEqual(ai.sent[1].addenda.glossary[0], { s: 'term60', t: '术语60' });
  assert.deepEqual(result, { translations: TERM_TEXTS.map((t) => `[T] ${t}`), engine: 'ai' });
});

test('sendToModel: every part passes the budget gate on its own', async () => {
  configure({ translationEngine: 'ai', autoTranslateEngine: 'ai' });
  const charged = [];
  const realCharge = globalThis.AutoStats.charge;
  globalThis.AutoStats.charge = async (chars) => {
    charged.push(chars);
    return { allowed: true };
  };
  try {
    await request(
      { type: 'TRANSLATE_BATCH_FAST', texts: TERM_TEXTS, targetLang: 'zh-CN', auto: true }, { glossary: snapOf(TERMS) });
  } finally {
    globalThis.AutoStats.charge = realCharge;
  }
  const chars = (texts) => texts.reduce((sum, t) => sum + t.length, 0);
  assert.deepEqual(charged, [chars(TERM_TEXTS.slice(0, 60)), chars(TERM_TEXTS.slice(60))]);
});

test('sendToModel: the first failed part is returned as it is and the rest are not sent', async () => {
  configure({ translationEngine: 'ai' });
  ai.answer = async () => ({ error: 'upstream said no' });
  const result = await request(
    { type: 'TRANSLATE_BATCH_FAST', texts: TERM_TEXTS, targetLang: 'zh-CN' }, { glossary: snapOf(TERMS) });
  assert.equal(ai.sent.length, 1);
  assert.deepEqual(result, { error: 'upstream said no', engine: 'ai' });
});

test('sendToModel: a batch with no hit carries only the page stamp; TRANSLATE carries its own hits', async () => {
  configure({ translationEngine: 'ai' });
  const snap = snapOf([{ s: 'attention', t: '注意力' }]);
  await request({ type: 'TRANSLATE_BATCH_FAST', texts: ['plain words'], targetLang: 'zh-CN' }, { glossary: snap });
  assert.equal(ai.sent.length, 1);
  assert.deepEqual(ai.sent[0].addenda, {}, 'only the stamp this page gave it');
  ai.answer = async () => ({ translation: 'x' });
  await request({ type: 'TRANSLATE', text: 'attention please', targetLang: 'zh-CN' }, { glossary: snap });
  assert.deepEqual(ai.sent[1].addenda, { glossary: [{ s: 'attention', t: '注意力' }] });
});
