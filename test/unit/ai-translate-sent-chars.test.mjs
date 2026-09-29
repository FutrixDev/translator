// background/ai-translate.js 的三个出口怎么记「发给模型的字符数」。
//
// 页面上下文（设置「附带页面上下文」）是真的随请求发出去的文字，设置页的说明也
// 承诺「会多用一些额度」。所以三个出口都按 AutoStats.sentChars(源文本, addenda)
// 记账：源文本加上下文三段，词表和领域不计（shared/auto-stats.js）。
// 悬停 / 划词卡片走单条 TRANSLATE（translateTextWithMode），整页批走 numbered
// （translateBatchWithAI）或快速分批（translateBatchFastWithAI）。这里调真模块，
// 只把 fetch 换成回答固定内容的桩、把 AutoStats.add 换成记账本。
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';

await import('../../shared/api-compat.js');
await import('../../shared/storage-writer.js');
await import('../../shared/auto-stats.js');
await import('../../shared/prompt-addenda.js');
const { translateTextWithMode, translateBatchWithAI, translateBatchFastWithAI } =
  await import('../../background/ai-translate.js');

// 接口、Key、模型、超时是 AI 配置档的（shared/ai-profiles.js），自定义提示词还在设置里。
const profile = {
  id: 'default',
  provider: 'custom',
  apiEndpoint: 'http://127.0.0.1:9/v1/chat/completions',
  apiKey: 'test-key',
  modelName: 'test-model',
  timeoutSec: 60,
};
const settings = { customPrompt: '' };

// 上下文三段长度各不相同，漏了哪一段都看得出来；词表和领域故意很长，
// 算进去了也看得出来。
const addenda = {
  glossary: [{ s: 'attention mechanism', t: '注意力机制' }],
  domain: 'academic',
  context: { title: 'T'.repeat(7), before: 'B'.repeat(11), after: 'A'.repeat(13) },
};
const CONTEXT_CHARS = 7 + 11 + 13;

/** 跑一次 `fn`：模型回答 `reply`，返回这期间 AutoStats.add 收到的 aiChars。 */
async function charged(reply, fn) {
  const booked = [];
  const originalFetch = globalThis.fetch;
  const originalAdd = globalThis.AutoStats.add;
  globalThis.fetch = async () => new Response(
    JSON.stringify({ choices: [{ message: { content: reply } }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } });
  globalThis.AutoStats.add = async (delta) => { booked.push(delta.aiChars); };
  try {
    await fn();
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.AutoStats.add = originalAdd;
  }
  return booked;
}

test('single TRANSLATE (hover, selection card): the page context is counted with the text', async () => {
  const text = 'The model attends to every token.';
  const booked = await charged('模型关注每一个词元。', () =>
    translateTextWithMode(text, 'zh-CN', profile, settings, false, addenda));
  assert.deepEqual(booked, [text.length + CONTEXT_CHARS]);

  // 没有 addenda 就只记源文本 —— 上面那笔多出来的正是上下文。
  const bare = await charged('模型关注每一个词元。', () =>
    translateTextWithMode(text, 'zh-CN', profile, settings, false, undefined));
  assert.deepEqual(bare, [text.length]);
});

test('single word goes through the same count', async () => {
  const booked = await charged('{"translation":"注意","phonetic":"/əˈtenʃən/"}', () =>
    translateTextWithMode('attention', 'zh-CN', profile, settings, false, addenda));
  assert.deepEqual(booked, ['attention'.length + CONTEXT_CHARS]);
});

test('numbered batch: the page context is counted once per request, not once per text', async () => {
  const texts = ['First paragraph.', 'Second one.'];
  const booked = await charged('[1] 第一段。\n\n[2] 第二段。', () =>
    translateBatchWithAI(texts, 'zh-CN', profile, settings, addenda));
  assert.deepEqual(booked, [texts.join('').length + CONTEXT_CHARS]);
});

test('fast batch: the page context is counted, and again on the numbered fallback', async () => {
  const texts = ['First paragraph.', 'Second one.'];
  const delimiter = globalThis.BATCH_DELIMITER;
  const ok = await charged(`第一段。${delimiter}第二段。`, () =>
    translateBatchFastWithAI(texts, 'zh-CN', profile, settings, addenda));
  assert.deepEqual(ok, [texts.join('').length + CONTEXT_CHARS]);

  // 分隔符对不上 → 整批按编号法重发一次，那是第二次真发出去的请求，也带着上下文。
  const fallback = await charged('第一段。第二段。', () =>
    translateBatchFastWithAI(texts, 'zh-CN', profile, settings, addenda));
  assert.deepEqual(fallback, [texts.join('').length + CONTEXT_CHARS, texts.join('').length + CONTEXT_CHARS]);
});
