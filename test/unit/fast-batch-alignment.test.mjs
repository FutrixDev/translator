// Guards for applyFastBatchTranslations in content/page/batch.js.
//
// Page translation joins a batch of blocks with a delimiter and maps the
// returned segments back onto the blocks BY POSITION. That mapping is only
// sound when the model returned exactly one segment per block. When it merges
// two segments (swallows a delimiter) or splits one (invents a delimiter),
// every translation from that point on lands one block off — block A shows
// block B's translation — and since inline-markup markers (<a1>…</a1>) ride
// along inside segment text, a shifted translation also drops literal marker
// junk into a block that cannot resolve it.
//
// The oversized-block path (processOversizedBlock) has always refused such a
// response outright. This suite pins the same rule onto the regular batch
// path, plus its recovery: a count mismatch must never be applied by position;
// instead each block is retried individually, where one request carries one
// segment and misalignment is structurally impossible.
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';

// ==================== the faked browser ====================

// The content/page/* modules are classic scripts hanging everything off
// window.AI_TRANSLATOR_CONTENT; at load they only define functions, so this is
// all the DOM it needs. `document`/`chrome` stay empty: the code under test
// must not reach them (skipTargetLanguageText=false keeps shouldSkipTranslation local).
globalThis.window = {
  AI_TRANSLATOR_CONTENT: {
    constants: { MATH_CONTAINER_SELECTOR: '.katex' },
    settings: { skipTargetLanguageText: false },
    state: {},
    t: (key) => key,
    escapeHtml: (s) => s,
    isExtensionContextAvailable: () => true,
    isExtensionContextInvalidated: () => false,
    getEffectiveTargetLang: () => 'zh-CN',
    getLangBase: (lang) => (lang || '').split('-')[0],
    getLanguageDetectionText: (text) => text || '',
  },
};
globalThis.document = {};
globalThis.chrome = {};
// 落笔会给每个块登记内容指纹（shared/block-identity.js），指纹是把原文子树读一遍
// 算出来的，所以这个假 DOM 也得有节点类型常量。
globalThis.Node = { ELEMENT_NODE: 1, TEXT_NODE: 3 };

// The guard narrates every fallback; assertions do the talking here.
console.warn = () => {};
console.error = () => {};

// 分批器要落笔就得有 insert.js，比对原文要有 collect.js 的 normalizeComparableText。
// 按 manifest 顺序加载，跨文件引用全是 ctx.x() 的运行时读取，顺序其实无所谓。
await import('../../shared/block-identity.js');
// 收集、落笔、比对原文都在调用时读 globalThis.TextMarkers（占位符与标记的语法）。
await import('../../shared/text-markers.js');
// 收集器在调用时读 shadow / notranslate / scope 挂的 ctx.x，这里装真模块，不手写替身；
// scope.js 读 globalThis.SiteRules，所以 lang-tags、site-rules-builtin、site-rules 排在它前面。
await import('../../shared/lang-tags.js');
await import('../../shared/site-rules-builtin.js');
await import('../../shared/storage-writer.js');
await import('../../shared/site-rules.js');
// scope.js 在调用时读 ctx.customRules（P1-B 用户站点规则）；不调 init() 就是「没有规则」。
await import('../../content/page/custom-rule.js');
await import('../../content/page/shadow.js');
await import('../../content/page/notranslate.js');
await import('../../content/page/scope.js');
for (const module of ['batch', 'collect', 'insert', 'visibility', 'progress']) {
  await import(`../../content/page/${module}.js`);
}
// visibility.js 调 ctx.frames 的钩子：装真的 shelf（默认全是空操作），不手写 ctx.frames。
await import('../../content/frames/shelf.js');
const ctx = globalThis.window.AI_TRANSLATOR_CONTENT;

// ==================== helpers ====================

// Insertions are observed through insertTranslationBlock's managed-root early
// return: stubbing these three hooks makes ctx.renderManagedTranslation the
// recording sink while still exercising the real shouldSkipTranslation and the
// real insertTranslationBlock dedupe (the ai-translator-translated class).
const inserted = [];
ctx.isInsideManagedDomRoot = () => true;
ctx.canRenderManagedTranslation = () => true;
ctx.renderManagedTranslation = (element, translation) => {
  inserted.push({ element, translation });
};

function makeBlock(text) {
  const classes = new Set();
  return {
    text,
    element: {
      nodeType: 1,
      localName: 'p',
      childNodes: [],
      parentNode: {},
      classList: {
        contains: (c) => classes.has(c),
        add: (c) => classes.add(c),
        remove: (c) => classes.delete(c),
      },
    },
  };
}

/**
 * Point ctx.requestTranslation at a scripted responder and collect every
 * request it receives. `respond(message)` returns the response object.
 */
function stubRequests(respond) {
  const requests = [];
  ctx.requestTranslation = async (message) => {
    requests.push(message);
    return respond(message);
  };
  return requests;
}

function insertedByElement(blocks) {
  return blocks.map((block) => {
    const hit = inserted.find((entry) => entry.element === block.element);
    return hit ? hit.translation : null;
  });
}

test.beforeEach(() => {
  inserted.length = 0;
});

// ==================== the aligned case stays untouched ====================

test('a response with one translation per block is applied by position, no extra requests', async () => {
  const blocks = ['First.', 'Second.', 'Third.'].map(makeBlock);
  const requests = stubRequests(() => {
    throw new Error('the aligned path must not issue any request');
  });

  await ctx.applyFastBatchTranslations(blocks, ['一', '二', '三'], {});

  assert.deepEqual(insertedByElement(blocks), ['一', '二', '三']);
  assert.equal(requests.length, 0);
});

// ==================== the core failure: merged / split segments ====================

test('fewer translations than blocks are never applied by position; every block is retried alone', async () => {
  // The model swallowed a delimiter: 3 blocks in, 2 segments out. Applying
  // ['一二', '三'] by position would hang block A's+B's merged translation on
  // block A and block C's on block B — with <a1> markers landing in the wrong
  // block as literal junk.
  const blocks = ['First.', 'Second.', 'Third.'].map(makeBlock);
  const requests = stubRequests((message) => ({
    translations: [`译:${message.texts[0]}`],
  }));

  await ctx.applyFastBatchTranslations(blocks, ['一二', '三'], {});

  assert.deepEqual(
    requests.map((m) => m.texts),
    [['First.'], ['Second.'], ['Third.']],
    'each block must be retried as its own single-segment request'
  );
  assert.equal(requests.every((m) => m.type === 'TRANSLATE_BATCH_FAST'), true);
  assert.deepEqual(insertedByElement(blocks), ['译:First.', '译:Second.', '译:Third.']);
  assert.equal(inserted.length, 3, 'the misaligned array was applied as well as the retries');
});

test('more translations than blocks trigger the same per-block retry', async () => {
  // The model invented a delimiter mid-segment: 2 blocks in, 3 segments out.
  const blocks = ['Alpha.', 'Beta.'].map(makeBlock);
  const requests = stubRequests((message) => ({
    translations: [`译:${message.texts[0]}`],
  }));

  await ctx.applyFastBatchTranslations(blocks, ['甲', '乙前', '乙后'], {});

  assert.deepEqual(requests.map((m) => m.texts), [['Alpha.'], ['Beta.']]);
  assert.deepEqual(insertedByElement(blocks), ['译:Alpha.', '译:Beta.']);
});

test('a response with no translations array at all is retried per block, not dropped', async () => {
  // processBatch feeds response.translations straight in; a malformed response
  // ({} — neither error nor translations) and an empty array both take the
  // same mismatch exit instead of silently losing the batch.
  for (const translations of [undefined, []]) {
    inserted.length = 0;
    const blocks = ['First.', 'Second.'].map(makeBlock);
    const requests = stubRequests((message) => ({
      translations: [`译:${message.texts[0]}`],
    }));

    await ctx.applyFastBatchTranslations(blocks, translations, {});

    assert.deepEqual(requests.map((m) => m.texts), [['First.'], ['Second.']]);
    assert.deepEqual(insertedByElement(blocks), ['译:First.', '译:Second.']);
  }
});

// ==================== the retry itself holds the same line ====================

test('a single-block retry whose response splits into two segments inserts nothing for that block', async () => {
  const blocks = ['One.', 'Two.'].map(makeBlock);
  stubRequests((message) => (
    message.texts[0] === 'One.'
      ? { translations: ['壹前', '壹后'] } // still misaligned — refuse
      : { translations: ['贰'] }
  ));

  await ctx.applyFastBatchTranslations(blocks, ['only-one-segment'], {});

  assert.deepEqual(insertedByElement(blocks), [null, '贰']);
});

test('per-block failures are reported, and an abort stops the remaining retries', async () => {
  const blocks = ['A.', 'B.', 'C.'].map(makeBlock);
  const failures = [];
  let aborted = false;
  const requests = stubRequests(() => ({ error: 'boom' }));

  await ctx.applyFastBatchTranslations(blocks, ['mismatched'], {
    onFailure: (message) => {
      failures.push(message);
      aborted = true; // what noteBatchFailure does once the threshold is hit
    },
    isAborted: () => aborted,
  });

  assert.deepEqual(failures, ['boom']);
  assert.equal(requests.length, 1, 'an aborted batch kept issuing per-block requests');
  assert.equal(inserted.length, 0);
});

// ==================== page context: the neighbours (P1-C C3) ====================
//
// 「附带页面上下文」开着时，三处发请求的地方（普通批、超大块的分块、逐块重试）都经
// batch.js 同一个 neighbourContext 给消息加 pageContext：这一批第一段在本轮收集顺序
// 里的前一段、最后一段的后一段。截断和去标记在引擎那头（engine-addenda.test.mjs）。

async function runPass(blocks, respond, { pageContext }) {
  ctx.settings.aiPageContext = pageContext;
  globalThis.window.innerHeight = 800;
  const requests = stubRequests(respond);
  try {
    await ctx.runTranslationPass(blocks);
  } finally {
    delete ctx.settings.aiPageContext;
  }
  return requests;
}

const echo = (message) => ({ translations: message.texts.map((text) => `译:${text}`) });
const contextOf = (requests) => requests.map((m) => [m.texts.join('|'), m.pageContext]);

test('page context off: no request carries a pageContext field at all', async () => {
  const blocks = Array.from({ length: 42 }, (_, k) => makeBlock(`Block ${k}.`));
  const requests = await runPass(blocks, echo, { pageContext: false });
  assert.equal(requests.length, 2);
  for (const message of requests) assert.equal('pageContext' in message, false);
});

test('page context on: a batch gets the block before its first and after its last, in collection order', async () => {
  // 40 段一批：[0..39] 与 [40, 41] 两批。
  const blocks = Array.from({ length: 42 }, (_, k) => makeBlock(`Block ${k}.`));
  const requests = await runPass(blocks, echo, { pageContext: true });
  assert.deepEqual(requests.map((m) => [m.texts.length, m.pageContext]), [
    [40, { before: '', after: 'Block 40.' }],
    [2, { before: 'Block 39.', after: '' }],
  ]);
  assert.equal(inserted.length, 42);
});

test('page context on: one block per batch (builtin pacing) gets its own neighbours', async () => {
  ctx.builtinTranslator = { isActive: () => true };
  try {
    const blocks = ['A.', 'B.', 'C.'].map(makeBlock);
    const requests = await runPass(blocks, echo, { pageContext: true });
    assert.deepEqual(contextOf(requests).sort(), [
      ['A.', { before: '', after: 'B.' }],
      ['B.', { before: 'A.', after: 'C.' }],
      ['C.', { before: 'B.', after: '' }],
    ]);
  } finally {
    delete ctx.builtinTranslator;
  }
});

test('page context on: the per-block retry of a misaligned batch carries each block\'s own neighbours', async () => {
  const blocks = ['A.', 'B.', 'C.'].map(makeBlock);
  const requests = await runPass(blocks, (message) => (
    message.texts.length > 1 ? { translations: ['merged'] } : echo(message)
  ), { pageContext: true });
  assert.deepEqual(contextOf(requests), [
    ['A.|B.|C.', { before: '', after: '' }],
    ['A.', { before: '', after: 'B.' }],
    ['B.', { before: 'A.', after: 'C.' }],
    ['C.', { before: 'B.', after: '' }],
  ]);
});

test('page context on: every chunk of an oversized block carries that block\'s neighbours', async () => {
  const sentence = 'This sentence is long enough to be one of many chunks. ';
  const big = makeBlock(sentence.repeat(Math.ceil((ctx.PAGE_LIMITS.MAX_BATCH_CHARS * 1.5) / sentence.length)));
  big.oversized = true;
  const blocks = [makeBlock('Before.'), big, makeBlock('After.')];
  const requests = await runPass(blocks, echo, { pageContext: true });
  const chunked = requests.filter((m) => m.texts.join('').includes('many chunks'));
  assert.ok(chunked.length >= 2, `expected the oversized block in several requests, got ${chunked.length}`);
  for (const message of chunked) assert.deepEqual(message.pageContext, { before: 'Before.', after: 'After.' });
});

test('an exported applyFastBatchTranslations call outside a pass carries no neighbours', async () => {
  ctx.settings.aiPageContext = true;
  try {
    const blocks = ['A.', 'B.'].map(makeBlock);
    const requests = stubRequests(echo);
    await ctx.applyFastBatchTranslations(blocks, ['one'], {});
    assert.equal(requests.length, 2);
    for (const message of requests) assert.equal('pageContext' in message, false);
  } finally {
    delete ctx.settings.aiPageContext;
  }
});
