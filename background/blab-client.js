// Blab Translation background — the 'blab' engine's one way out: POST
// /api/blab/complete on the signed-in account (design §2.1, D-477).
//
// callModel (model-client.js) owns the request's life — retry, rate limiter,
// keepalive, per-attempt timeout, total budget — exactly as for the user's own
// AI profiles. This file only answers two questions for it when the profile is
// Engines.BLAB_PROFILE: what the request looks like (blabRequest) and how one
// attempt is sent (sendBlab). The prompts and the parsing of the answer stay in
// ai-translate.js, shared with the 'ai' engine.
//
// It rides comic-client.js's apiFetch: the same account, bearer token, service
// address and ComicApiError as comics and documents. A failure is turned into
// the `apiFailure` shape callModel retries on and api-errors.js words:
//   - network_error               { network: true, status: 0 }  — retryable
//   - 502 upstream_failed, 503    { status, blab: code }        — retryable (5xx)
//   - daily_limit, plan_required,
//     unauthorized                { status, blab: code, retryable: false } — the
//                                 account's state, which another try in a second
//                                 does not change (design §5.2); daily_limit
//                                 carries the server's resetsAt
//   - anything else (400, 413)    { status, blab: code }        — a 4xx, not retried
// Nothing here logs: apiFetch warns once per non-ok reply (its existing line)
// and replyError logs the failure where the handler catches it.

import { apiFetch, getApiBase, ComicApiError } from './comic-client.js';
import { apiError } from './api-client.js';

const PATH = '/api/blab/complete';

// The account's state, not a passing failure: never retried, and they end the
// page's translation pass (api-errors.js marks the reply passFatal).
const ACCOUNT_CODES = Object.freeze(['daily_limit', 'plan_required', 'unauthorized']);

/**
 * The request body for one call (design §2.1). `temperature` is sent only when
 * the caller gave one (D-482): without it the gateway picks its default, which
 * is not api-compat's DEFAULT_TEMPERATURE.
 */
function blabRequest({ system, user, maxTokens, temperature }) {
  const body = { system: system || '', user, maxTokens };
  if (temperature !== undefined) body.temperature = temperature;
  return { endpoint: PATH, body };
}

/** The apiFailure for a ComicApiError from apiFetch; `endpoint` is the full URL for the wording. */
function blabFailure(error, endpoint) {
  if (!(error instanceof ComicApiError)) throw error;
  if (error.code === 'network_error') {
    return apiError(`Network error: ${endpoint}`, { network: true, status: 0, detail: '', endpoint, blab: error.code });
  }
  const failure = { network: false, status: error.status, detail: '', endpoint, blab: error.code };
  if (ACCOUNT_CODES.includes(error.code)) failure.retryable = false;
  if (error.code === 'daily_limit' && error.details.resetsAt) failure.resetsAt = String(error.details.resetsAt);
  return apiError(`HTTP ${error.status}: ${error.code}`, failure);
}

/**
 * One attempt. `signal` is the attempt's own (timeout and the caller's abort
 * both land on it); when it is the reason apiFetch failed, the error is
 * rethrown as is and callModel's attemptOnce words it as a timeout or a
 * cancellation, never as a network error.
 */
async function sendBlab(prepared, signal) {
  let data;
  try {
    data = await apiFetch(prepared.endpoint, { method: 'POST', body: prepared.body, signal });
  } catch (error) {
    if (signal.aborted) throw error;
    throw blabFailure(error, `${await getApiBase()}${PATH}`);
  }
  const text = typeof data.text === 'string' ? data.text.trim() : '';
  if (!text) {
    throw apiError(`Empty answer: ${PATH}`, { empty: true, status: 200, detail: '', endpoint: PATH });
  }
  return { text };
}

/** Whether this failure is the account's state (signed out, no plan, today's allowance spent). */
function isBlabAccountFailure(failure) {
  return Boolean(failure) && ACCOUNT_CODES.includes(failure.blab);
}

export { blabRequest, sendBlab, isBlabAccountFailure, ACCOUNT_CODES };
