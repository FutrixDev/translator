// Blab Translation background — the one place a request leaves for a model.
//
// callModel(profile, request, { signal, retry, limit, clock }) 发一次请求，回
// { text }，失败抛 Error，带 err.apiFailure（设计 §3.6）：
//   - { network: true, status: 0, … }   连不上；
//   - { network: false, status, detail } 服务商回了错（readAPIResponse 的 failure），
//     响应带 Retry-After 时多一个 retryAfterMs；
//   - { timeout: true, seconds }        这一档的 timeoutSec 到了还没回来（§3.7）；
//   - { empty: true }                   回来了，但答案是空的（修-10：空答案不当译文）。
// Retry-After 超过 60 秒的 429 在 failure 上多一个 rateLimitedWait（秒数），
// 措辞是 apiErrorRateLimitedWait。
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
// 选项：
//   retry: false  只试一次（AI_PROFILE_TEST：测试连接要立刻知道这一档通不通）；
//   limit: false  不进限速器（同上）；
//   clock         单测替换的时钟 { random(), sleep(ms, signal), now() }。

import '../shared/api-compat.js';
import { modelRequest, apiError } from './api-client.js';
import { acquire as holdKeepalive, release as dropKeepalive } from './keepalive.js';
import { acquire as acquireModelSlot } from './model-limiter.js';

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

const SYSTEM_CLOCK = Object.freeze({ random: Math.random, sleep, now: () => Date.now() });

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
  if (!failure || failure.empty) return false;
  if (failure.network || failure.timeout) return true;
  const status = Number(failure.status);
  return status === 429 || (status >= 500 && status <= 599);
}

/** 一次尝试：自己的超时、自己的 AbortController，调用方的 signal 转过来。 */
async function attemptOnce(profile, prepared, signal, now) {
  const seconds = profile.timeoutSec;
  const { endpoint, claudeShape, headers, body } = prepared;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, seconds * 1000);
  const onCallerAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onCallerAbort, { once: true });
  }
  const abortError = () => {
    if (timedOut) return apiError(`Timeout after ${seconds}s: ${endpoint}`, { timeout: true, seconds, endpoint });
    return callerAborted();
  };

  try {
    let response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (_) {
      if (controller.signal.aborted) throw abortError();
      throw apiError(`Network error: ${endpoint}`, { network: true, status: 0, detail: '', endpoint });
    }

    let data;
    try {
      data = await response.json();
    } catch (_) {
      if (controller.signal.aborted) throw abortError();
      data = {};
    }

    const result = readAPIResponse(data, response.status, response.ok, claudeShape);
    if (result.failure) {
      const { status, detail } = result.failure;
      const failure = { ...result.failure, network: false, endpoint };
      // Retry-After 在响应头里，readAPIResponse 只看正文：这里读，带到失败对象上。
      const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'), now());
      if (retryAfterMs !== null) failure.retryAfterMs = retryAfterMs;
      throw apiError(detail ? `HTTP ${status}: ${detail}` : `HTTP ${status}`, failure);
    }
    if (!result.text) {
      throw apiError(`Empty answer: ${endpoint}`, { empty: true, status: response.status, detail: '', endpoint });
    }
    return { text: result.text };
  } finally {
    clearTimeout(timer);
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
    failure.rateLimitedWait = Math.ceil(failure.retryAfterMs / 1000);
    return null;
  }
  if (attempt >= maxAttempts) return null;
  if (failure.retryAfterMs !== undefined) return failure.retryAfterMs;
  return BACKOFF_MS[attempt - 1] * (1 - JITTER + 2 * JITTER * clock.random());
}

async function callModel(profile, request, { signal, retry = true, limit = true, clock = SYSTEM_CLOCK } = {}) {
  if (!(profile.timeoutSec > 0)) throw new TypeError('callModel: profile.timeoutSec must be a positive number');
  const prepared = modelRequest(profile, request);
  const maxAttempts = retry ? MAX_ATTEMPTS : 1;

  holdKeepalive();
  try {
    for (let attempt = 1; ; attempt += 1) {
      // 排队不算超时：attemptOnce 在放行之后才起超时计时器。
      const releaseModelSlot = limit ? await acquireModelSlot(profile, signal) : null;
      let error;
      try {
        return await attemptOnce(profile, prepared, signal, clock.now);
      } catch (caught) {
        error = caught;
      } finally {
        if (releaseModelSlot) releaseModelSlot();
      }
      const wait = nextWait(error, attempt, maxAttempts, clock);
      if (wait === null) {
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
