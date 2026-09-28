// Blab Translation background — the one place a request leaves for a model.
//
// callModel(profile, request, { signal, onDelta, feature }) 发一次请求，回
// { text }，失败抛 Error，带 err.apiFailure（设计 §3.6）：
//   - { network: true, status: 0, … }   连不上；
//   - { network: false, status, detail } 服务商回了错（readAPIResponse 的 failure）；
//   - { timeout: true, seconds }        这一档的 timeoutSec 到了还没回来（§3.7）；
//   - { empty: true }                   回来了，但答案是空的（修-10：空答案不当译文）。
// 调用方自己的 signal 断了（没人在等了）抛的是 err.aborted = true、不带
// apiFailure：不报给用户，也不记日志。
//
// 这里不打日志：错误都往上抛，由接住它的那一层（background.js 的 handler、
// OCR、AI_PROFILE_TEST）打一次，带操作名、档 id 和功能（api-errors.js 的
// replyError）。
//
// D1 不重试（§3.9 在 D2），不流式（§5 在 D3）：onDelta 现在不读。每次尝试都有
// 自己的超时和取消，在途期间持有 keepalive（§3.8）。

import '../shared/api-compat.js';
import { modelRequest, apiError } from './api-client.js';
import { acquire, release } from './keepalive.js';

const { readAPIResponse } = globalThis.APICompat;

async function callModel(profile, request, { signal } = {}) {
  const seconds = profile.timeoutSec;
  if (!(seconds > 0)) throw new TypeError('callModel: profile.timeoutSec must be a positive number');
  const { endpoint, claudeShape, headers, body } = modelRequest(profile, request);

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

  // 超时与调用方取消都表现为同一个 abort；按 timedOut 分开。
  const abortError = () => {
    if (timedOut) {
      return apiError(`Timeout after ${seconds}s: ${endpoint}`, { timeout: true, seconds, endpoint });
    }
    const error = new Error('Model request aborted by the caller');
    error.aborted = true;
    return error;
  };

  acquire();
  try {
    let response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal
      });
    } catch (_) {
      if (controller.signal.aborted) throw abortError();
      throw apiError(`Network error: ${endpoint}`, { network: true, status: 0, detail: '', endpoint });
    }

    // Some APIs report failures with HTTP 200 and an error payload, so the body
    // is always parsed; a body that is not JSON reads as {} and is judged by
    // the status alone. An abort while reading the body is still an abort.
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
      throw apiError(detail ? `HTTP ${status}: ${detail}` : `HTTP ${status}`,
        { ...result.failure, network: false, endpoint });
    }
    if (!result.text) {
      throw apiError(`Empty answer: ${endpoint}`, { empty: true, status: response.status, detail: '', endpoint });
    }
    return { text: result.text };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onCallerAbort);
    release();
  }
}

export { callModel };
