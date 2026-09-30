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
    // 与 content-bootstrap.js 同一判据（上下文本身在测试里一直可用）。
    isExtensionContextInvalidated: (error) => Boolean(error) && String(error?.message || error).includes('Extension context invalidated'),
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
await import('../../content/page/reader-hidden.js');
await import('../../content/page/not-prose.js');
// failed-blocks.js：落笔前摘失败标记（ctx.failedBlocks.clear），失败时放标记。
for (const module of ['batch', 'collect', 'insert', 'failed-blocks', 'visibility', 'progress']) {
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

// ==================== failed-block markers (P1-D D2) ====================
//
// 每个失败点都要把那一段交给 ctx.failedBlocks.mark（content/page/failed-blocks.js），
// 这里换成记账替身，只看「哪一段、带没带 auto」。真标记长什么样、点了怎么重试在
// e2e（test/e2e/ai-retry-limits.spec.js 的 D-J10～D-J12）。

async function withMarks(run) {
  const real = ctx.failedBlocks;
  const marks = [];
  ctx.failedBlocks = {
    ...real,
    mark: (block, reason, options) => marks.push({ block, reason, auto: options && options.auto }),
    clear: () => {},
  };
  try {
    await run();
  } finally {
    ctx.failedBlocks = real;
  }
  return marks;
}

test('an oversized block with one empty chunk inserts nothing and is marked failed once, not dropped silently', async () => {
  const sentence = 'This sentence is long enough to be one of many chunks. ';
  const big = makeBlock(sentence.repeat(Math.ceil((ctx.PAGE_LIMITS.MAX_BATCH_CHARS * 1.5) / sentence.length)));
  big.oversized = true;
  let chunkRequests = 0;
  const marks = await withMarks(() => runPass([big], (message) => {
    chunkRequests += 1;
    // 第一个分块请求里留一个空译文：条数对得上，但这一块缺了一截。
    const translations = message.texts.map((text) => `译:${text}`);
    if (chunkRequests === 1) translations[0] = '';
    return { translations };
  }, { pageContext: false }));
  assert.ok(chunkRequests >= 2, `expected several chunk requests, got ${chunkRequests}`);
  assert.equal(inserted.length, 0, 'a block with a missing chunk must not be inserted');
  assert.deepEqual(marks.map((m) => [m.block, m.auto]), [[big, false]]);
});

test('a failed batch marks every block in it on a manual pass, and none on an automatic pass', async () => {
  const fail = () => ({ error: 'boom' });
  const manual = ['A.', 'B.'].map(makeBlock);
  const manualMarks = await withMarks(() => runPass(manual, fail, { pageContext: false }));
  assert.deepEqual(manualMarks.map((m) => [m.block, m.reason, m.auto]), [[manual[0], 'boom', false], [manual[1], 'boom', false]]);

  // 自动那一轮第一次失败只进台账（content/content-auto-translate.js 在 giveUp 时才放）。
  const auto = ['C.', 'D.'].map(makeBlock);
  const autoRequests = stubRequests(fail);
  const autoMarks = await withMarks(() => ctx.runTranslationPass(auto, { auto: true }));
  assert.ok(autoRequests.length >= 1, 'the automatic pass never sent its batch');
  assert.deepEqual(autoMarks, []);

  // 点标记重试的那一轮沿用自动的引擎，但失败要看得见。
  const retry = [makeBlock('E.')];
  stubRequests(fail);
  const retryMarks = await withMarks(() => ctx.runTranslationPass(retry, { auto: true, markFailures: true }));
  assert.deepEqual(retryMarks.map((m) => [m.block, m.auto]), [[retry[0], true]]);
});

test('a pass-fatal failure marks no paragraph: the whole-page error says it once', async () => {
  // 不认得的领域这类配置错（passFatal）点哪一段重试都一样失败；它只在进度条上报。
  // 六条路各走一遍：批次抛出的错误、批次回的 {error, passFatal}；数量对不上之后逐块
  // 回退里回的和抛出的；超长段分块请求里回的和抛出的。扩展上下文没了是同一类，
  // 在批次和逐块回退里各抛一次。
  const thrown = () => { throw Object.assign(new Error('bad domain'), { passFatal: true }); };
  const contextLost = () => { throw new Error('Extension context invalidated.'); };
  const replied = () => ({ error: 'bad domain', passFatal: true });
  const misaligned = (then) => (message) => (message.texts.length > 1 ? { translations: ['only one'] } : then());
  const pair = () => ['A.', 'B.'].map(makeBlock);
  const oversized = () => {
    const sentence = 'This sentence is long enough to be one of many chunks. ';
    const big = makeBlock(sentence.repeat(Math.ceil((ctx.PAGE_LIMITS.MAX_BATCH_CHARS * 1.5) / sentence.length)));
    big.oversized = true;
    return [big];
  };
  const paths = {
    thrown: [pair, thrown],
    replied: [pair, replied],
    perBlock: [pair, misaligned(replied)],
    perBlockThrown: [pair, misaligned(thrown)],
    oversizedReplied: [oversized, replied],
    oversizedThrown: [oversized, thrown],
    contextLost: [pair, contextLost],
    perBlockContextLost: [pair, misaligned(contextLost)]
  };
  for (const [path, [blocks, respond]] of Object.entries(paths)) {
    const marks = await withMarks(() => runPass(blocks(), respond, { pageContext: false }));
    assert.deepEqual(marks, [], `${path} put a marker on a paragraph`);
  }
});

test('a misaligned batch whose per-block retries succeed marks nothing', async () => {
  const blocks = ['A.', 'B.', 'C.'].map(makeBlock);
  const marks = await withMarks(() => runPass(blocks, (message) => (
    message.texts.length > 1 ? { translations: ['merged'] } : echo(message)
  ), { pageContext: false }));
  assert.deepEqual(marks, []);
  assert.equal(inserted.length, 3);
});

// ---- 修复回合 1（D-424）：C、I.3，以及逐段原因报给调用方（B 的 batch.js 一半）

test('a block the model hands back unchanged is settled and loses its failed marker (C)', async () => {
  // 「无需翻译」和「翻好了」一样是终局：上次失败留下的「重试」不该还挂着。
  const block = makeBlock('Already the same.');
  const real = ctx.failedBlocks;
  const cleared = [];
  const settled = [];
  ctx.failedBlocks = { ...real, clear: (b) => cleared.push(b) };
  try {
    globalThis.window.innerHeight = 800;
    stubRequests((message) => ({ translations: message.texts }));
    await ctx.runTranslationPass([block], { onSettled: (b) => settled.push(b) });
  } finally {
    ctx.failedBlocks = real;
  }
  assert.equal(inserted.length, 0, 'an unchanged reply is not inserted');
  assert.deepEqual(settled, [block]);
  assert.deepEqual(cleared, [block], 'the skip branch must clear the marker too');
});

test('failures after the pass was stopped are neither reported nor marked (I.3)', async () => {
  // 外面喊停（换了路由、关掉自动翻译）之后回来的失败：那一页已经不归这一轮管了。
  const blocks = ['A.', 'B.'].map(makeBlock);
  let stopped = false;
  const reported = [];
  const marks = await withMarks(async () => {
    globalThis.window.innerHeight = 800;
    stubRequests(() => {
      stopped = true;
      return { error: 'boom' };
    });
    await ctx.runTranslationPass(blocks, {
      isAborted: () => stopped,
      onBlockFailed: (block, reason) => reported.push([block, reason]),
    });
  });
  assert.deepEqual(marks, []);
  assert.deepEqual(reported, []);
});

test('the three-batch threshold is not an outside stop: every block that was sent and failed is marked (D-J11)', async () => {
  // 阈值停下的是「后面的批次别再发」，不是「这一页不归这一轮管了」：在飞的批次
  // 随后失败，照样放标记 —— 整页报错之下，发出去过的每一段都是一个可点的重试。
  const perBatch = ctx.PAGE_LIMITS.MAX_BATCH_ITEMS;
  const blocks = Array.from({ length: perBatch * (ctx.PAGE_LIMITS.CONCURRENCY.ai + 2) }, (_, i) => makeBlock(`Paragraph ${i}.`));
  let requests;
  const marks = await withMarks(async () => {
    globalThis.window.innerHeight = 800;
    requests = stubRequests(() => ({ error: 'boom' }));
    await ctx.runTranslationPass(blocks, {});
  });
  const sent = requests.reduce((sum, message) => sum + message.texts.length, 0);
  assert.ok(requests.length > 3, `more than three batches were in flight (got ${requests.length})`);
  assert.ok(sent < blocks.length, 'the batches after the threshold were not sent');
  assert.equal(marks.length, sent, 'a batch that failed after the threshold still marks its blocks');
});

test('every per-block failure is reported to the caller, with or without markers (B)', async () => {
  // 自动那一轮不放标记，但要拿到这一段自己的原因（giveUp 时做 title）。
  const blocks = ['C.', 'D.'].map(makeBlock);
  const reported = [];
  const marks = await withMarks(async () => {
    stubRequests(() => ({ error: 'apiErrorUnavailable' }));
    await ctx.runTranslationPass(blocks, {
      auto: true,
      onBlockFailed: (block, reason) => reported.push([block, reason]),
    });
  });
  assert.deepEqual(marks, []);
  assert.deepEqual(reported, [[blocks[0], 'apiErrorUnavailable'], [blocks[1], 'apiErrorUnavailable']]);
});
