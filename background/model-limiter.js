// Blab Translation background — 每个配置档的限速（P1-D 设计 §3.10）。
//
// callModel 的每一次尝试（含重试）先 acquire(profile) 取一个令牌：这一档的并发数
// 和每分钟请求数都有余量才放行，否则按到达顺序排队。放行时拿到一个释放函数，
// 这一次尝试结束（成败都算）调它一次，归还并发名额；每分钟请求数的名额不归还，
// 它按放行时刻在 60 秒窗口里过期。
//
// - 按档 id 分桶。每次 acquire 读档上当时的 rpm / concurrency，所以改了值从下一次
//   acquire 起生效；0 表示不限。桶里的限值随最后一次 acquire 更新，排队中的请求
//   按桶里的限值放行 —— 档被删了，队列照常走完。
// - 调用方在排队中取消：从队列里拿掉、以 err.aborted 拒绝，不占名额。callModel 的
//   总预算在排队中用完也走这一条（它断开自己传进来的 signal，再把拒绝换成超时）。
// - 计数只在内存里，SW 被回收就清零（设计 §8 已接受）。
// - 排队时间不算这一次尝试的超时（callModel 在放行之后才起超时计时器），但排队
//   期间的 keepalive 由 callModel 持有。

const WINDOW_MS = 60000;

/** 调用方取消的错误形状，与 callModel 的一致：err.aborted，没有 apiFailure。 */
function abortedError() {
  const error = new Error('Model request aborted by the caller');
  error.aborted = true;
  return error;
}

/**
 * 一个限速器。`now` 与 `setTimer` 可替换，单测用它们拨时钟；
 * 产品里只有下面那一个默认实例。
 */
function createLimiter({ now = () => Date.now(), setTimer = setTimeout } = {}) {
  const buckets = new Map();

  function bucketFor(profile) {
    const key = profile.id || '(unsaved)';
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { key, rpm: 0, concurrency: 0, inFlight: 0, stamps: [], queue: [], timer: null };
      buckets.set(key, bucket);
    }
    bucket.rpm = Number(profile.rpm) > 0 ? Number(profile.rpm) : 0;
    bucket.concurrency = Number(profile.concurrency) > 0 ? Number(profile.concurrency) : 0;
    return bucket;
  }

  /** 这一刻还要等多久才有 rpm 名额；0 = 现在就有。 */
  function rpmWait(bucket, at) {
    while (bucket.stamps.length > 0 && at - bucket.stamps[0] >= WINDOW_MS) bucket.stamps.shift();
    if (!bucket.rpm || bucket.stamps.length < bucket.rpm) return 0;
    return bucket.stamps[0] + WINDOW_MS - at;
  }

  function forget(bucket) {
    if (bucket.inFlight === 0 && bucket.queue.length === 0 && bucket.stamps.length === 0 && !bucket.timer) {
      buckets.delete(bucket.key);
    }
  }

  function grant(bucket, at) {
    bucket.inFlight += 1;
    if (bucket.rpm) bucket.stamps.push(at);
    let released = false;
    return function releaseModelSlot() {
      if (released) throw new Error('model-limiter: releaseModelSlot called twice');
      released = true;
      bucket.inFlight -= 1;
      pump(bucket);
    };
  }

  /** 严格先来先走：队头放不出去，后面的也等着。 */
  function pump(bucket) {
    while (bucket.queue.length > 0) {
      if (bucket.concurrency && bucket.inFlight >= bucket.concurrency) return;
      const at = now();
      const wait = rpmWait(bucket, at);
      if (wait > 0) {
        if (!bucket.timer) {
          bucket.timer = setTimer(() => {
            bucket.timer = null;
            pump(bucket);
          }, wait);
        }
        return;
      }
      const waiter = bucket.queue.shift();
      waiter.settle(grant(bucket, at));
    }
    forget(bucket);
  }

  /**
   * 取一个令牌：resolve 成释放函数 releaseModelSlot()，这一次尝试结束时调一次。
   * signal 断了（排队前或排队中）以 err.aborted 拒绝，不占名额。
   */
  function acquire(profile, signal) {
    if (!profile || typeof profile !== 'object') throw new TypeError('model-limiter: acquire needs a profile');
    if (signal && signal.aborted) return Promise.reject(abortedError());
    const bucket = bucketFor(profile);
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const index = bucket.queue.indexOf(waiter);
        if (index < 0) return;
        bucket.queue.splice(index, 1);
        reject(abortedError());
        pump(bucket);
      };
      const waiter = {
        settle(release) {
          if (signal) signal.removeEventListener('abort', onAbort);
          resolve(release);
        },
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      bucket.queue.push(waiter);
      pump(bucket);
    });
  }

  /** 测试用：某档此刻的在途数、排队数、窗口内的放行数。 */
  function state(profileId) {
    const bucket = buckets.get(profileId || '(unsaved)');
    if (!bucket) return { inFlight: 0, queued: 0, recent: 0 };
    return { inFlight: bucket.inFlight, queued: bucket.queue.length, recent: bucket.stamps.length };
  }

  return { acquire, state };
}

/** 产品里唯一的限速器。 */
const limiter = createLimiter();

export { limiter, createLimiter, WINDOW_MS };
