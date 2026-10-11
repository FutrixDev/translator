// Blab Translation — 整页翻译：统一进度源 ctx.progressFeed（设计 §2）
//
// 手动整页翻译和自动翻译的调度层各报各的进度，球上的进度环只读这一份。两个
// 来源，一个快照：
//
//   { source, phase, known, settled, failed, pending, inflight, session }
//
// - known：这一轮（手动）/ 这一代（自动）里**被接纳进 inflight 过**的块数。累计，
//   单调不减；新到的块让它增长，所以比例允许回退 —— 回退是诚实的。
// - settled：有结果的块（译好 + 模型说不用翻 + 放弃），单调不减，永远 ≤ known。
// - failed：settled 里放弃的那些。
// - pending：还在队里等下一轮的（手动恒为 0）。
// - inflight：已发未回。
// - session：自动调度层的代次（SessionGuard.version()），翻篇时快照整个归零。
//
// 这里只是纯状态加发布/订阅，不碰 DOM，也不画任何东西（环归 content-float-ball.js）。
//
// **不变量由这里守，坏了就抛。** 分母在同一代里倒退、分子超过分母，画出来的就是
// 一个先大后小、或者卡在 100% 之外的环；那是上游记账记错了，悄悄夹住只会把错账
// 画成一个看起来正常的环。所以 known / settled / failed 在同一来源、同一代（手动是
// 同一轮）里只许增不许减，settled ≤ known、failed ≤ settled，违反即抛。
//
// 手动在跑时手动优先（自动那一轮本来就在等它，content-auto-translate.js 的
// isTranslatingPage 分支）：期间调度层报上来的快照照样校验、记下，但不顶掉手动的。
// 手动一收尾，快照停在它的终态上，直到调度层下一次报数。
(function() {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT;
  if (!ctx) return;

  const PHASES = Object.freeze(['idle', 'arming', 'running', 'done', 'partial', 'paused', 'error', 'budget']);
  // 手动一轮的四种收尾。
  const MANUAL_OUTCOMES = Object.freeze(['done', 'partial', 'error', 'paused']);
  const COUNTS = Object.freeze(['known', 'settled', 'failed', 'pending', 'inflight']);
  // 只要还有块没回来，比例就不画满：满格只属于 done（设计 §2）。
  const RUNNING_CAP = 0.99;

  const blank = (session) => Object.freeze({
    source: 'none', phase: 'idle', known: 0, settled: 0, failed: 0, pending: 0, inflight: 0, session
  });

  let current = blank(0);
  // 调度层最近一次报上来的快照：手动在跑时它不上台，但单调性照样拿它比。
  let lastAuto = null;
  let manualActive = false;

  const subscribers = new Set();
  let frame = 0;

  function validate(next, previous) {
    if (!PHASES.includes(next.phase)) throw new Error(`progressFeed: unknown phase ${next.phase}`);
    if (!Number.isInteger(next.session) || next.session < 0) {
      throw new Error(`progressFeed: session must be a non-negative integer, got ${next.session}`);
    }
    for (const key of COUNTS) {
      if (!Number.isInteger(next[key]) || next[key] < 0) {
        throw new Error(`progressFeed: ${key} must be a non-negative integer, got ${next[key]}`);
      }
    }
    if (next.settled > next.known) {
      throw new Error(`progressFeed: settled ${next.settled} exceeds known ${next.known}`);
    }
    if (next.failed > next.settled) {
      throw new Error(`progressFeed: failed ${next.failed} exceeds settled ${next.settled}`);
    }
    if (!previous) return;
    for (const key of ['known', 'settled', 'failed']) {
      if (next[key] < previous[key]) {
        throw new Error(`progressFeed: ${next.source} ${key} went down from ${previous[key]} to ${next[key]} in session ${next.session}`);
      }
    }
  }

  // 订阅者按帧合并：一轮里几十块各报一次，环一帧只重画一次。没人订阅时不排帧
  // —— state() 永远是最新的，按需去读就行。
  function notify() {
    if (subscribers.size === 0 || frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const snapshot = current;
      for (const fn of subscribers) {
        // 画环是附带动作：一个订阅者抛了，不该让别的订阅者、更不该让翻译本身停下。
        try {
          fn(snapshot);
        } catch (error) {
          console.warn('Blab Translation: progress subscriber failed', error);
        }
      }
    });
  }

  function show(snapshot) {
    current = snapshot;
    notify();
  }

  // ------------------------------------------------------------------ 手动

  function requireManual(what) {
    if (!manualActive) throw new Error(`progressFeed.manual.${what}: no manual run in progress`);
  }

  function requireCount(what, n) {
    if (!Number.isInteger(n) || n < 1) throw new Error(`progressFeed.manual.${what}: n must be a positive integer, got ${n}`);
  }

  function manualStep(changes) {
    const next = { ...current, ...changes };
    validate(next, current);
    show(Object.freeze(next));
  }

  const manual = Object.freeze({
    /** 一轮手动整页翻译开始：known = 这一轮要翻的块数，全部在途。 */
    begin(known) {
      if (!Number.isInteger(known) || known < 0) {
        throw new Error(`progressFeed.manual.begin: known must be a non-negative integer, got ${known}`);
      }
      manualActive = true;
      const next = {
        source: 'manual', phase: 'arming', known, settled: 0, failed: 0, pending: 0, inflight: known,
        session: lastAuto ? lastAuto.session : current.session
      };
      // 新的一轮，从零起算：不和上一轮比单调。
      validate(next, null);
      show(Object.freeze(next));
    },
    /** n 块有了结果（译好或模型说不用翻）。第一块回来时 arming → running。 */
    settle(n = 1) {
      requireManual('settle');
      requireCount('settle', n);
      manualStep({ phase: 'running', settled: current.settled + n, inflight: current.inflight - n });
    },
    /** n 块放弃了（重试后仍失败）：既算有结果，也记进 failed。 */
    fail(n = 1) {
      requireManual('fail');
      requireCount('fail', n);
      manualStep({
        phase: 'running', settled: current.settled + n, failed: current.failed + n, inflight: current.inflight - n
      });
    },
    /** 这一轮收尾：outcome ∈ done | partial | error | paused。没回来的不再算在途。 */
    end(outcome) {
      requireManual('end');
      if (!MANUAL_OUTCOMES.includes(outcome)) throw new Error(`progressFeed.manual.end: unknown outcome ${outcome}`);
      manualStep({ phase: outcome, inflight: 0, pending: 0 });
      manualActive = false;
    }
  });

  // ------------------------------------------------------------------ 自动

  const auto = Object.freeze({
    /**
     * 调度层每次状态或账目变化时报一份完整的数（content-auto-translate.js 的
     * feedProgress）：{ phase, known, settled, failed, pending, inflight, session }。
     * 代次变了（翻篇）就是新的起点，不和上一代比单调。
     */
    publish(partial) {
      const next = { source: 'auto' };
      for (const key of ['phase', 'session', ...COUNTS]) {
        if (!(key in partial)) throw new Error(`progressFeed.auto.publish: missing ${key}`);
        next[key] = partial[key];
      }
      validate(next, lastAuto && lastAuto.session === next.session ? lastAuto : null);
      lastAuto = Object.freeze(next);
      if (manualActive) return;
      show(lastAuto);
    }
  });

  /**
   * 这份快照该画多少：settled / known；还有块没回来（pending + inflight > 0）时
   * 封顶 0.99，phase 为 done 才是 1。呈现层只认这一处，不自己再算一遍。
   */
  function fraction(snapshot) {
    if (snapshot.phase === 'done') return 1;
    if (snapshot.known === 0) return 0;
    const ratio = snapshot.settled / snapshot.known;
    return snapshot.pending + snapshot.inflight > 0 ? Math.min(ratio, RUNNING_CAP) : ratio;
  }

  ctx.progressFeed = Object.freeze({
    state: () => current,
    /** 订阅变化（同一帧里的多次变化合并成一次回调），返回退订函数。 */
    subscribe(fn) {
      if (typeof fn !== 'function') throw new TypeError('progressFeed.subscribe: fn must be a function');
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    fraction,
    manual,
    auto,
    PHASES,
    RUNNING_CAP
  });
})();
