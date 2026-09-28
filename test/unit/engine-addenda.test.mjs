// 引擎这一族里的领域与页面上下文（P1-C C3，设计 §3.5、§4.3）：
// content/engine/addenda.js 的 compose / stamp，以及 content-translation-engine.js
// 的 sendToModel 怎么把它们接上 —— 有效领域（规则压过全局、规则写 general 也算
// 写了）、上下文只在开关开着且不是输入框时附带、先去标记再截 300/300/200、
// `pageContext` 在发给模型前剥掉、上下文算进预算闸的字数、内置引擎一律不带。
//
// 本站规则是桩：引擎只在调用时读 ctx.customRules（engineOverride / domain /
// whenReady），真的 custom-rule.js 在 custom-rule-page.test.mjs 里测。
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { installEngineHarness } from './helpers/engine-harness.mjs';

const PAGE = 'This page is written in ordinary English prose, long enough for the detector to be sure about it.'.repeat(6);

const { ctx, setApiKey } = await installEngineHarness({ pageText: PAGE });
await import('../../shared/storage-writer.js');
await import('../../shared/auto-stats.js');
setApiKey('test-key');

const eng = ctx.engine;
const { LIMITS, DOMAINS } = globalThis.PromptAddenda;
const TEXT = 'This ordinary English sentence is the one being translated.';

const rule = { domain: null };
ctx.customRules = {
  engineOverride: () => null,
  domain: () => rule.domain,
  whenReady: async () => {},
};

const builtin = { calls: [] };
self.Translator = {
  availability: async () => 'available',
  create: async () => ({
    translate: async (text) => {
      builtin.calls.push(text);
      return `[B] ${text}`;
    },
    destroy() {},
  }),
};

const ai = { sent: [] };
globalThis.chrome.runtime.sendMessage = async (message) => {
  ai.sent.push(message);
  if (message.type === 'TRANSLATE') return { translation: 'x' };
  return { translations: message.texts.map((t) => `[T] ${t}`) };
};

function configure(patch = {}) {
  Object.assign(ctx.settings, {
    translationEngine: 'ai',
    autoTranslateEngine: 'ai',
    engineFallback: 'off',
    autoAiDailyBudget: 0,
    promptDomain: 'general',
    aiPageContext: false,
  }, patch);
  rule.domain = null;
  globalThis.document.title = 'A page title';
  builtin.calls.length = 0;
  ai.sent.length = 0;
}

const emptySnap = () => ({ glossary: eng.glossary.fromEntries([], `test-${Math.random()}`) });
const batch = (extra = {}) => ({ type: 'TRANSLATE_BATCH_FAST', texts: [TEXT], targetLang: 'zh-CN', ...extra });
const send = (message) => ctx.requestTranslation(message, emptySnap());

// ------------------------------------------------------------------ 领域

test('domain: global general sends no domain; a global domain is sent as its id', async () => {
  configure();
  await send(batch());
  assert.equal('addenda' in ai.sent[0], false, 'general is the default and sends nothing');

  configure({ promptDomain: 'legal' });
  await send(batch());
  assert.deepEqual(ai.sent[0].addenda, { domain: 'legal' });
});

test('domain: the site rule wins over the global setting, and a rule set to general sends none', async () => {
  configure({ promptDomain: 'legal' });
  rule.domain = 'medical';
  await send(batch());
  assert.equal(ai.sent[0].addenda.domain, 'medical');

  rule.domain = 'general';
  await send(batch());
  assert.equal('addenda' in ai.sent[1], false, 'a rule saying general is a choice, not "unset"');

  rule.domain = null;
  await send(batch());
  assert.equal(ai.sent[2].addenda.domain, 'legal', 'no rule domain follows the global one');
});

test('domain: an unknown or missing global domain is a defect and throws, it is not read as general', () => {
  // 抛出的是整轮致命的错误：文案给用户看（这里的 ctx.t 原样回键名），坏值留给日志。
  const fatal = (domain) => ({
    name: 'PromptDomainError', message: 'promptDomainUnknown', passFatal: true, domain,
  });
  configure({ promptDomain: 'poetry' });
  assert.throws(() => eng.addenda.compose(batch(), { glossary: [] }), fatal('poetry'));
  assert.throws(() => eng.addenda.stamp(eng.glossary.fromEntries([], 'empty'), TEXT), fatal('poetry'));
  configure({ promptDomain: undefined });
  assert.throws(() => eng.addenda.compose(batch(), { glossary: [] }), fatal(undefined));
  configure({ promptDomain: 'legal' });
  rule.domain = 'astrology';
  assert.throws(() => eng.addenda.compose(batch(), { glossary: [] }), fatal('astrology'));
  configure();
});

test('domain: every id the engine accepts comes from PromptAddenda.DOMAINS', () => {
  for (const id of DOMAINS) {
    configure({ promptDomain: id });
    const addenda = eng.addenda.compose(batch(), { glossary: [] });
    if (id === 'general') assert.equal(addenda, null);
    else assert.deepEqual(addenda, { domain: id });
  }
  configure();
});

// ------------------------------------------------------------------ 上下文

test('context: only with the switch on; the page title and the neighbours ride along', async () => {
  configure();
  await send(batch({ pageContext: { before: 'Earlier paragraph.', after: 'Later paragraph.' } }));
  assert.equal('addenda' in ai.sent[0], false, 'switch off, no context');

  configure({ aiPageContext: true });
  await send(batch({ pageContext: { before: 'Earlier paragraph.', after: 'Later paragraph.' } }));
  assert.deepEqual(ai.sent[0].addenda, {
    context: { title: 'A page title', before: 'Earlier paragraph.', after: 'Later paragraph.' },
  });
});

test('context: the input box (standaloneText) never carries it, even with the switch on', async () => {
  configure({ aiPageContext: true, promptDomain: 'legal' });
  await send({ type: 'TRANSLATE', text: TEXT, targetLang: 'zh-CN', standaloneText: true });
  assert.deepEqual(ai.sent[0].addenda, { domain: 'legal' }, 'the domain still applies, the context does not');
});

test('context: entries without neighbours (hover, selection, captions) carry the title only', async () => {
  configure({ aiPageContext: true });
  await send({ type: 'TRANSLATE', text: TEXT, targetLang: 'zh-CN' });
  assert.deepEqual(ai.sent[0].addenda, { context: { title: 'A page title', before: '', after: '' } });
});

test('context: markers are stripped first, then before keeps its last 300, after its first 300, title its first 200', async () => {
  configure({ aiPageContext: true });
  const before = `${'b'.repeat(10)}{{1}}<b1>${'B'.repeat(LIMITS.before)}</b1>`;
  const after = `<i2>${'A'.repeat(LIMITS.after)}</i2>{{3}}${'a'.repeat(10)}`;
  globalThis.document.title = `{{4}}${'T'.repeat(LIMITS.title)}${'t'.repeat(10)}`;
  await send(batch({ pageContext: { before, after } }));
  const { context } = ai.sent[0].addenda;
  assert.equal(context.before, 'B'.repeat(LIMITS.before));
  assert.equal(context.after, 'A'.repeat(LIMITS.after));
  assert.equal(context.title, 'T'.repeat(LIMITS.title));
  assert.doesNotThrow(() => globalThis.PromptAddenda.validate(ai.sent[0].addenda), 'the SW gate accepts it');
});

test('context: pageContext is stripped before the message goes to the model, whatever the message type', async () => {
  configure({ aiPageContext: true });
  const pageContext = { before: 'x', after: 'y' };
  await send(batch({ pageContext }));
  await send({ type: 'TRANSLATE', text: TEXT, targetLang: 'zh-CN', pageContext });
  for (const message of ai.sent) assert.equal('pageContext' in message, false, message.type);
});

test('context: a split batch sends the same context with every part', async () => {
  configure({ aiPageContext: true });
  const terms = Array.from({ length: 70 }, (_, k) => ({ s: `term${k}`, t: `术语${k}` }));
  const texts = terms.map((entry) => `We discuss ${entry.s} today.`);
  const snap = eng.glossary.fromEntries(terms, `test-${Math.random()}`);
  await ctx.requestTranslation(
    { type: 'TRANSLATE_BATCH_FAST', texts, targetLang: 'zh-CN', pageContext: { before: 'P', after: 'N' } },
    { glossary: snap });
  assert.equal(ai.sent.length, 2);
  for (const message of ai.sent) {
    assert.deepEqual(message.addenda.context, { title: 'A page title', before: 'P', after: 'N' });
  }
});

// ------------------------------------------------------------------ 计数与内置

test('budget gate: the context counts toward the charged characters, the domain does not', async () => {
  const charged = [];
  const realCharge = globalThis.AutoStats.charge;
  globalThis.AutoStats.charge = async (chars) => {
    charged.push(chars);
    return { allowed: true };
  };
  try {
    configure({ promptDomain: 'legal' });
    await send(batch({ auto: true, pageContext: { before: 'Earlier.', after: 'Later!' } }));
    configure({ promptDomain: 'legal', aiPageContext: true });
    await send(batch({ auto: true, pageContext: { before: 'Earlier.', after: 'Later!' } }));
  } finally {
    globalThis.AutoStats.charge = realCharge;
  }
  const extra = 'A page title'.length + 'Earlier.'.length + 'Later!'.length;
  assert.deepEqual(charged, [TEXT.length, TEXT.length + extra]);
});

test('builtin engine: never sends the context or the domain anywhere', async () => {
  configure({ translationEngine: 'builtin', aiPageContext: true, promptDomain: 'legal' });
  const result = await send(batch({ pageContext: { before: 'Earlier.', after: 'Later.' } }));
  assert.deepEqual(result.translations, [`[B] ${TEXT}`]);
  assert.deepEqual(builtin.calls, [TEXT], 'the builtin translator saw the text and nothing else');
  assert.equal(ai.sent.length, 0);
});

// ------------------------------------------------------------------ 缓存戳

test('stamp: the effective domain and the context switch are in the cache key, the neighbours are not', () => {
  const snap = eng.glossary.fromEntries([], `test-${Math.random()}`);
  configure();
  const plain = eng.addenda.stamp(snap, TEXT);
  assert.match(plain, /\|d:general\|c:0$/);
  configure({ promptDomain: 'legal' });
  assert.match(eng.addenda.stamp(snap, TEXT), /\|d:legal\|c:0$/);
  rule.domain = 'medical';
  assert.match(eng.addenda.stamp(snap, TEXT), /\|d:medical\|c:0$/);
  configure({ aiPageContext: true });
  assert.match(eng.addenda.stamp(snap, TEXT), /\|d:general\|c:1$/);
  configure();
});
