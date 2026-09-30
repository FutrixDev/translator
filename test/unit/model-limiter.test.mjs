// 每个配置档的限速器（background/model-limiter.js，P1-D 设计 §3.10）。
//
// 守五件事：并发上限、每分钟请求数上限、改了值从下一次 acquire 起生效、排队中
// 取消不占名额、0 是不限。时钟和计时器都换成可拨的替身；「排队时间不算超时」
// 要真 callModel，在 model-client.test.mjs。
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';

const { createLimiter, WINDOW_MS } = await import('../../background/model-limiter.js');

/** 可拨的时钟与计时器：advance(ms) 把时间往前拨，到点的计时器依次触发。 */
function fakeTime() {
  let at = 1000000;
  const timers = [];
  return {
    now: () => at,
    setTimer: (fn, ms) => {
      const timer = { fn, due: at + ms, done: false };
      timers.push(timer);
      return timer;
    },
    advance(ms) {
      at += ms;
      for (const timer of timers) {
        if (!timer.done && timer.due <= at) {
          timer.done = true;
          timer.fn();
        }
      }
    },
    pending: () => timers.filter((timer) => !timer.done).length,
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

/** acquire 之后看它放没放行：{ release, error, settled }。 */
function track(promise) {
  const box = { release: null, error: null, settled: false };
  promise.then((release) => { box.release = release; box.settled = true; },
    (error) => { box.error = error; box.settled = true; });
  return box;
}

test('limiter: concurrency caps attempts in flight; a release lets the next one in, first come first served', async () => {
  const time = fakeTime();
  const limiter = createLimiter(time);
  const p = { id: 'a', concurrency: 2, rpm: 0 };
  const boxes = [1, 2, 3, 4].map(() => track(limiter.acquire(p)));
  await flush();
  assert.deepEqual(boxes.map((box) => box.settled), [true, true, false, false], 'LIMIT-CONCURRENCY holds the third');
  assert.deepEqual(limiter.state('a'), { inFlight: 2, queued: 2, recent: 0 });
  boxes[1].release();
  await flush();
  assert.deepEqual(boxes.map((box) => box.settled), [true, true, true, false], 'the third, not the fourth');
  boxes[0].release();
  boxes[2].release();
  await flush();
  assert.equal(boxes[3].settled, true);
  boxes[3].release();
  assert.deepEqual(limiter.state('a'), { inFlight: 0, queued: 0, recent: 0 });
});

test('limiter: rpm caps grants in any 60 s window; the queue moves when the oldest grant ages out', async () => {
  const time = fakeTime();
  const limiter = createLimiter(time);
  const p = { id: 'b', concurrency: 0, rpm: 2 };
  const first = track(limiter.acquire(p));
  time.advance(10000);
  const second = track(limiter.acquire(p));
  const third = track(limiter.acquire(p));
  await flush();
  assert.equal(first.settled && second.settled, true);
  assert.equal(third.settled, false, 'LIMIT-RPM holds the third inside the window');
  first.release();
  second.release();
  await flush();
  assert.equal(third.settled, false, 'releasing does not give an rpm slot back');
  assert.equal(time.pending(), 1, 'one timer for the queue, not one per waiter');
  time.advance(WINDOW_MS - 10000 - 1);
  await flush();
  assert.equal(third.settled, false);
  time.advance(1);
  await flush();
  assert.equal(third.settled, true, 'granted when the first grant is 60 s old');
  third.release();
  assert.equal(limiter.state('b').recent, 2);
});

test('limiter: a changed limit applies from the next acquire', async () => {
  const time = fakeTime();
  const limiter = createLimiter(time);
  const a = track(limiter.acquire({ id: 'c', concurrency: 1 }));
  const b = track(limiter.acquire({ id: 'c', concurrency: 1 }));
  await flush();
  assert.equal(b.settled, false);
  const c = track(limiter.acquire({ id: 'c', concurrency: 3 }));
  await flush();
  assert.equal(b.settled, true, 'raised to 3: the queue drains in order');
  assert.equal(c.settled, true);
  const d = track(limiter.acquire({ id: 'c', concurrency: 0 }));
  await flush();
  assert.equal(d.settled, true, '0 is unlimited');
  [a, b, c, d].forEach((box) => box.release());
  assert.deepEqual(limiter.state('c'), { inFlight: 0, queued: 0, recent: 0 });
});

test('limiter: cancelling while queued rejects err.aborted and takes no slot', async () => {
  const time = fakeTime();
  const limiter = createLimiter(time);
  const p = { id: 'd', concurrency: 1 };
  const a = track(limiter.acquire(p));
  const controller = new AbortController();
  const b = track(limiter.acquire(p, controller.signal));
  const c = track(limiter.acquire(p));
  await flush();
  controller.abort();
  await flush();
  assert.equal(b.error && b.error.aborted, true);
  assert.equal(b.error.apiFailure, undefined);
  assert.deepEqual(limiter.state('d'), { inFlight: 1, queued: 1, recent: 0 });
  a.release();
  await flush();
  assert.equal(c.settled && !c.error, true, 'the one behind it moves up');
  c.release();

  const gone = new AbortController();
  gone.abort();
  await assert.rejects(limiter.acquire(p, gone.signal), (error) => error.aborted === true);
  assert.deepEqual(limiter.state('d'), { inFlight: 0, queued: 0, recent: 0 });
});

test('limiter: profiles are counted separately, and unlimited profiles never queue', async () => {
  const limiter = createLimiter(fakeTime());
  const one = track(limiter.acquire({ id: 'e', concurrency: 1 }));
  const other = track(limiter.acquire({ id: 'f', concurrency: 1 }));
  const many = Array.from({ length: 50 }, () => track(limiter.acquire({ id: 'g', concurrency: 0, rpm: 0 })));
  await flush();
  assert.equal(one.settled && other.settled, true);
  assert.equal(many.every((box) => box.settled), true);
  [one, other, ...many].forEach((box) => box.release());
});

test('limiter: the paired release is releaseModelSlot and throws when called twice', async () => {
  const limiter = createLimiter(fakeTime());
  const release = await limiter.acquire({ id: 'h', concurrency: 1 });
  assert.equal(release.name, 'releaseModelSlot');
  release();
  assert.throws(() => release(), /called twice/);
  assert.throws(() => limiter.acquire(null), TypeError);
});
