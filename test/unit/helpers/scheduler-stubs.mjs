// 调度层（content/content-auto-translate.js）在 vm 里跑时要的拉取器桩。
//
// 真的 ctx.focusOrder.createBatchFeeder 住在 content/page/focus-order.js 里，要量
// 布局、读视口；这些 harness 测的是调度层自己的账（台账、放回、代次），收块和送翻
// 本来就是桩。默认一批装下全部、按文档顺序，于是 roundCap() 不起作用 —— 和限量
// 之前一轮抽干整队的行为一样。评分本身由 test/unit/batch-feeder.test.mjs 测，限量由
// test/unit/progress-feed.test.mjs 的调度层用例测。
//
// 进度源不用桩：harness 把真的 content/page/progress-feed.js 装进同一个 vm
// （SCHEDULER_PRELUDE），调度层每报一次账都经过它的不变量校验 —— 账记错了当场抛。

/** 排在 content/content-auto-translate.js 之前装进 vm 的真实文件。 */
export const SCHEDULER_PRELUDE = Object.freeze(['content/page/progress-feed.js']);

/**
 * { focusOrder: { createBatchFeeder }, passConcurrency, passBatchShape }：按文档顺序
 * 每批 perBatch 块，并发位 concurrency（roundCap() = concurrency × 2 批）。
 */
export function docOrderFeeder({ perBatch = Infinity, concurrency = 4 } = {}) {
  return {
    focusOrder: {
      createBatchFeeder(blocks, shape) {
        if (!shape || shape.perBatch !== perBatch) throw new Error('docOrderFeeder: shape must come from passBatchShape');
        const rest = [...blocks];
        return { next: () => (rest.length > 0 ? rest.splice(0, shape.perBatch) : null) };
      },
    },
    passConcurrency: () => concurrency,
    passBatchShape: () => ({ perBatch, maxChars: Infinity, maxTokens: Infinity }),
  };
}
