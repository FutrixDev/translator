// Guards for applyFastBatchTranslations in content/content-page-translation.js.
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

// content-page-translation.js is a classic script hanging everything off
// window.AI_TRANSLATOR_CONTENT; at load it only defines functions, so this is
// all the DOM it needs. `document`/`chrome` stay empty: the code under test
// must not reach them (autoDetect=false keeps shouldSkipTranslation local).
globalThis.window = {
  AI_TRANSLATOR_CONTENT: {
    constants: { MATH_CONTAINER_SELECTOR: '.katex' },
    settings: { autoDetect: false },
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

// The guard narrates every fallback; assertions do the talking here.
console.warn = () => {};
console.error = () => {};

await import('../../content/content-page-translation.js');
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
