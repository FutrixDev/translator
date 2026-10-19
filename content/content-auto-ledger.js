// Blab Translation — 自动翻译调度层的进度账本
//
// 调度层（content/content-auto-translate.js）一代之内的四本账都在这里，别处只能
// 经下面这几个方法动它们：
//
//   - settled：已经**有结果**的 key（译好、模型说不用翻、滤掉、放弃）。takeBatch
//     问 has() 挡「再送一次」。
//   - accepted：被接纳进 inflight 过的 key。进度的分母，累计、只增不减；放回队列
//     再送一次的块 key 不变，不计两次。
//   - retired：接纳过、却再也走不到结果的 key（节点断开、文字换了、被别处翻好、
//     挂了失败标记归用户）。不进 settled —— 那本挡的是再送，这些块换个样子回来
//     时还得能送；只在报进度时算作已了结。
//   - revived：从 retired 摘回来、又接纳了一次的次数。进度源要求一代之内 known、
//     settled 只增不减，摘掉的那一笔已经报成了结、不能收回，所以它回来算又欠一
//     块：known、settled 各加这个数。
//   - gaveUp：给过第二次机会还是没翻成的块数，即 failed。
//
// 一个 key 只会在 settled、retired 两本里的一本：retire 不收已了结的，settle 把
// retired 里那一笔挪过来。两本都记的话 settled 会把同一块数两次、超过 known。
//
// key 是 `代次内编号:文本指纹`，只由 keyOf 拼。
//
// 一个文件而不是调度层里的闭包：闭包只能经 vm 里整个调度层去测，这本账的不变式
// 要能单独测（test/unit/auto-ledger.test.mjs）。
(function() {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT;
  if (!ctx) return;

  const keyOf = (blockId, fingerprint) => `${blockId}:${fingerprint}`;

  function create() {
    const settled = new Set();
    const accepted = new Set();
    const retired = new Set();
    let revived = 0;
    let gaveUp = 0;

    return Object.freeze({
      /** 这个 key 这一代有结果了：别再送。 */
      has: (key) => settled.has(key),

      /** 接纳进 inflight：分母长一块。从 retired 摘回来的算又欠一块。 */
      accept(key) {
        accepted.add(key);
        if (retired.delete(key)) revived += 1;
      },

      /** 有结果了。 */
      settle(key) {
        retired.delete(key);
        settled.add(key);
      },

      /** 接纳过的 key 就此走不到结果。没接纳过的、已经了结的不算。 */
      retire(key) {
        if (accepted.has(key) && !settled.has(key)) retired.add(key);
      },

      /** 又放弃了 n 块（它们各自已经 settle 过）。 */
      giveUp(n) {
        gaveUp += n;
      },

      counts: () => ({
        known: accepted.size + revived,
        settled: settled.size + retired.size + revived,
        failed: gaveUp
      }),

      /** 代次翻篇：整本作废。 */
      reset() {
        settled.clear();
        accepted.clear();
        retired.clear();
        revived = 0;
        gaveUp = 0;
      }
    });
  }

  ctx.autoLedger = Object.freeze({ create, keyOf });
})();
