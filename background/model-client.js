// Blab Translation background — the one place a request leaves for a model.
//
// callModel(profile, request, { signal, retry, limit, clock }) 发一次请求，回
// { text }，失败抛 Error，带 err.apiFailure（设计 §3.6）：
//   - { network: true, status: 0, … }   连不上；
//   - { network: false, status, detail } 服务商回了错（readAPIResponse 的 failure），
//     响应带 Retry-After 时多一个 retryAfterMs；
//   - { timeout: true, seconds }        这一档的 timeoutSec 到了还没回来（§3.7）；被总预算
//                                        截短的那一次、或在限速器里排队排到预算用完，
//                                        seconds 是实际等了多久；
//   - { empty: true }                   回来了，但答案是空的（修-10：空答案不当译文）。
// Retry-After 超过 60 秒的失败不再试、立即抛。只有 429 在 failure 上多一个
// rateLimitedWait（秒数），措辞是 apiErrorRateLimitedWait；5xx 仍按状态码措辞
// （服务端那一类），不说成限流。
// 调用方自己的 signal 断了（没人在等了）抛的是 err.aborted = true、不带
// apiFailure：不报给用户，也不记日志。
//
// 这里不打日志：错误都往上抛，由接住它的那一层（background.js 的 handler、
// OCR、AI_PROFILE_TEST）打一次，带操作名、档 id 和功能（api-errors.js 的
// replyError）。重试中间的失败也不打：最后那一次原样抛，err.attempts 记着
// 一共试了几次，replyError 把它写进那一条日志。
//
// 重试（§3.9）：网络错、超时、429、500–599 可重试，至多 3 次尝试；第 2、3 次
// 之前等 1 秒、2 秒，各乘 0.8–1.2 的随机因子；有 Retry-After 就等它说的时间
// （不再乘抖动）。其余 4xx、空答案、调用方取消不重试。
// 限速（§3.10）：每次尝试先经 model-limiter.js 的 acquire 取令牌，尝试结束归还。
// 每次尝试都有自己的超时（放行之后才起算）和取消；keepalive 在整个调用期间
// （排队、等待、在途）持有一份（§3.8）。不流式（§5 在 D3）。
//
// 总预算：一次 callModel 从进门起最多 AIProfiles.LIMITS.timeoutMax 秒（240），排队、
// 每次尝试、退避等待全算在内。每次尝试的超时取 min(timeoutSec, 剩余预算)；剩余
// 不到 LIMITS.timeoutMin 秒（15，一次有意义的尝试）就不再发下一次，原样抛上一次
// 的失败；在限速器里排到只剩这么多，就从队列里摘掉、以超时失败。排队仍不算进
// 那一次尝试自己的超时 —— 预算和单次超时是两件事。retry:false / limit:false 也受它管。
//
// 选项：
//   retry: false  只试一次（AI_PROFILE_TEST：测试连接要立刻知道这一档通不通）；
//   limit: false  不进限速器（同上）；
//   clock         单测替换的时钟 { random(), sleep(ms, signal), now(), setTimer(fn, ms),
//                 clearTimer(handle) }；
//   limiter       单测替换的限速器（model-limiter.js 的 createLimiter()）。
//
// 两种送法（transportFor，按档认一次）：用户自己的 AI 档直连服务商（modelRequest
// + sendToProvider）；Engines.BLAB_PROFILE 发到账户的 /api/blab/complete
// （blab-client.js，D-477）。重试、限速、keepalive、超时与总预算两边是同一套。
// Blab 那几种账户状态（daily_limit / plan_required / unauthorized）的失败带
// retryable: false，不重试（设计 §5.2）。

import '../shared/api-compat.js';
import '../shared/engines.js';
import { modelRequest, apiError } from './api-client.js';
import { blabRequest, sendBlab } from './blab-client.js';
import { acquire as holdKeepalive, release as dropKeepalive } from './keepalive.js';
import { limiter as productLimiter } from './model-limiter.js';

const { readAPIResponse } = globalThis.APICompat;

const MAX_ATTEMPTS = 3;
const BACKOFF_MS = Object.freeze([1000, 2000]);
const JITTER = 0.2;
const RETRY_AFTER_MAX_SEC = 60;

function callerAborted() {
  const error = new Error('Model request aborted by the caller');
  error.aborted = true;
  return error;
}

/** 等 ms 毫秒；signal 断了立即以 err.aborted 拒绝。 */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(callerAborted());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(callerAborted());
    };
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

const SYSTEM_CLOCK = Object.freeze({
  random: Math.random,
  sleep,
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle) => clearTimeout(handle),
});

/**
 * 总预算与一次尝试的下限（毫秒），就是配置档超时的上下限。调用时才读：
 * shared/ai-profiles.js 由 background.js 装进 SW，没装就是装配错，直接抛。
 */
function budgetLimits() {
  const { timeoutMin, timeoutMax } = globalThis.AIProfiles.LIMITS;
  return { budgetMs: timeoutMax * 1000, minAttemptMs: timeoutMin * 1000 };
}

/** 实际等了多少毫秒，写进文案的整秒数（至少 1）。 */
const wholeSeconds = (ms) => Math.max(1, Math.round(ms / 1000));

/**
 * Retry-After 的值换成毫秒：秒数，或者 HTTP 日期（减去此刻，已过去的算 0）。
 * 没有这个头、或者读不懂，回 null —— 调用方按退避时间走。
 */
function parseRetryAfter(value, now) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  // HTTP 日期三种写法都带英文月份名；没有字母的（如 "1.5"）V8 的 Date.parse 也会
  // 硬读成某个日期，这里先挡掉，算读不懂。
  if (!/[a-z]/i.test(text)) return null;
  const at = Date.parse(text);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - now);
}

/** 这一次失败之后还要不要再试。apiFailure 之外的错误（调用方取消、程序错）一律不试。 */
function isRetryable(failure) {
  if (!failure || failure.empty || failure.retryable === false) return false;
  if (failure.network || failure.timeout) return true;
  const status = Number(failure.status);
  return status === 429 || (status >= 500 && status <= 599);
}

/**
 * 直连服务商的一次发送：`signal` 是这一次尝试自己的。被它断开的，原样把错误抛
 * 回去，由 attemptOnce 说成超时或取消；其余连不上的是网络错。
 */
async function sendToProvider(prepared, signal, clock) {
  const { endpoint, claudeShape, headers, body } = prepared;
  let response;
  try {
    response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body), signal });
  } catch (error) {
    if (signal.aborted) throw error;
    throw apiError(`Network error: ${endpoint}`, { network: true, status: 0, detail: '', endpoint });
  }

  let data;
  try {
    data = await response.json();
  } catch (error) {
    if (signal.aborted) throw error;
    data = {};
  }

  const result = readAPIResponse(data, response.status, response.ok, claudeShape);
  if (result.failure) {
    const { status, detail } = result.failure;
    const failure = { ...result.failure, network: false, endpoint };
    // Retry-After 在响应头里，readAPIResponse 只看正文：这里读，带到失败对象上。
    const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'), clock.now());
    if (retryAfterMs !== null) failure.retryAfterMs = retryAfterMs;
    throw apiError(detail ? `HTTP ${status}: ${detail}` : `HTTP ${status}`, failure);
  }
  if (!result.text) {
    throw apiError(`Empty answer: ${endpoint}`, { empty: true, status: response.status, detail: '', endpoint });
  }
  return { text: result.text };
}

const PROVIDER_TRANSPORT = Object.freeze({ prepare: modelRequest, send: sendToProvider });
const BLAB_TRANSPORT = Object.freeze({ prepare: (_profile, request) => blabRequest(request), send: sendBlab });

/** 这一档怎么发：Blab 那一档按 id 认（shared/engines.js），其余都是用户自己的 AI 档。 */
function transportFor(profile) {
  return profile.id === globalThis.Engines.BLAB_PROFILE.id ? BLAB_TRANSPORT : PROVIDER_TRANSPORT;
}

/**
 * 一次尝试：自己的超时、自己的 AbortController，调用方的 signal 转过来。
 * 超时取 min(timeoutSec, 剩余预算)；被预算截短时文案写实际等的整秒数。
 * 发送本身交给 transport.send；它因这个 signal 失败的，这里说成超时或取消。
 */
async function attemptOnce(profile, transport, prepared, signal, clock, deadline) {
  const fullMs = profile.timeoutSec * 1000;
  const remainingMs = deadline - clock.now();
  const cut = remainingMs < fullMs;
  const limitMs = cut ? remainingMs : fullMs;
  const seconds = cut ? wholeSeconds(limitMs) : profile.timeoutSec;
  const { endpoint } = prepared;
  const controller = new AbortController();
  let timedOut = false;
  const timer = clock.setTimer(() => {
    timedOut = true;
    controller.abort();
  }, limitMs);
  const onCallerAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onCallerAbort, { once: true });
  }

  try {
    return await transport.send(prepared, controller.signal, clock);
  } catch (error) {
    if (!controller.signal.aborted) throw error;
    if (timedOut) throw apiError(`Timeout after ${seconds}s: ${endpoint}`, { timeout: true, seconds, endpoint });
    throw callerAborted();
  } finally {
    clock.clearTimer(timer);
    if (signal) signal.removeEventListener('abort', onCallerAbort);
  }
}

/**
 * 在限速器里取令牌，最多排到 gateAt（预算里只剩一次尝试的下限那一刻）。
 * 到点了：断开传给限速器的 signal —— 它把这一位从队列里摘掉、不占名额 —— 再把
 * 那个 err.aborted 换成超时失败，seconds 是实际排了多久。调用方自己取消的，原样抛。
 */
async function acquireWithin(limiter, profile, signal, clock, gateAt, endpoint) {
  const started = clock.now();
  const gate = new AbortController();
  let expired = false;
  const onCallerAbort = () => gate.abort();
  if (signal) {
    if (signal.aborted) gate.abort();
    else signal.addEventListener('abort', onCallerAbort, { once: true });
  }
  const timer = clock.setTimer(() => {
    expired = true;
    gate.abort();
  }, Math.max(0, gateAt - started));
  try {
    return await limiter.acquire(profile, gate.signal);
  } catch (error) {
    if (!expired) throw error;
    const seconds = wholeSeconds(clock.now() - started);
    throw apiError(`Timeout after ${seconds}s queued for ${endpoint}`, { timeout: true, seconds, endpoint });
  } finally {
    clock.clearTimer(timer);
    if (signal) signal.removeEventListener('abort', onCallerAbort);
  }
}

/**
 * 第 attempt 次失败之后等多久再试；不该再试就回 null。
 * Retry-After 超过 60 秒的，在 failure 上记下秒数（rateLimitedWait）再判失败：
 * 这一条排在「最后一次」之前，所以第一次就回 Retry-After: 120 的请求只发一次。
 */
function nextWait(error, attempt, maxAttempts, clock) {
  const failure = error && error.apiFailure;
  if (!isRetryable(failure)) return null;
  if (failure.retryAfterMs > RETRY_AFTER_MAX_SEC * 1000) {
    // 「请等 N 秒」只说给 429：5xx 叫你等 2 分钟是服务端出了事，按状态码措辞。
    if (Number(failure.status) === 429) failure.rateLimitedWait = Math.ceil(failure.retryAfterMs / 1000);
    return null;
  }
  if (attempt >= maxAttempts) return null;
  if (failure.retryAfterMs !== undefined) return failure.retryAfterMs;
  return BACKOFF_MS[attempt - 1] * (1 - JITTER + 2 * JITTER * clock.random());
}

async function callModel(profile, request, {
  signal, retry = true, limit = true, clock = SYSTEM_CLOCK, limiter = productLimiter,
} = {}) {
  if (!(profile.timeoutSec > 0)) throw new TypeError('callModel: profile.timeoutSec must be a positive number');
  const { budgetMs, minAttemptMs } = budgetLimits();
  const transport = transportFor(profile);
  const prepared = transport.prepare(profile, request);
  const maxAttempts = retry ? MAX_ATTEMPTS : 1;
  const deadline = clock.now() + budgetMs;

  holdKeepalive();
  try {
    for (let attempt = 1; ; attempt += 1) {
      // 排队不算这一次尝试的超时：attemptOnce 在放行之后才起超时计时器。
      // 排队算总预算：排到只剩一次尝试的下限就以超时失败。
      const releaseModelSlot = limit
        ? await acquireWithin(limiter, profile, signal, clock, deadline - minAttemptMs, prepared.endpoint)
        : null;
      let error;
      try {
        return await attemptOnce(profile, transport, prepared, signal, clock, deadline);
      } catch (caught) {
        error = caught;
      } finally {
        if (releaseModelSlot) releaseModelSlot();
      }
      const wait = nextWait(error, attempt, maxAttempts, clock);
      // 等完之后剩的预算不够一次有意义的尝试，就不等了：上一次的失败原样抛。
      if (wait === null || clock.now() + wait + minAttemptMs > deadline) {
        error.attempts = attempt;
        throw error;
      }
      await clock.sleep(wait, signal);
    }
  } finally {
    dropKeepalive();
  }
}

export { callModel, parseRetryAfter, MAX_ATTEMPTS, BACKOFF_MS, JITTER, RETRY_AFTER_MAX_SEC };
