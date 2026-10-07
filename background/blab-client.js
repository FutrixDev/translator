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
//   - network_error               { network: true, status: 0 }  — retried, the
//                                 only Blab failure that is (D-497 F7)
//   - 502 upstream_failed, 503    { status, blab: code }        — not retried:
//                                 the service already retried its upstream
//   - daily_limit, plan_required,
//     unauthorized                { status, blab: code, retryable: false } — the
//                                 account's state, which another try in a second
//                                 does not change (design §5.2); daily_limit
//                                 carries the server's resetsAt
//   - anything else (400, 413)    { status, blab: code }        — not retried
// Nothing here logs: apiFetch warns once per non-ok reply (its existing line)
// and replyError logs the failure where the handler catches it.
//
// An account failure is also remembered (the latch below, D-490 N1): until the
// account could have changed, the next calls are refused here with the same
// failure and send nothing. A page pass, a caption line every few seconds and a
// selection card would otherwise each ask the service a question it has already
// answered.

import { apiFetch, getAccount, getApiBase, getToken, getCachedAccount, ComicApiError } from './comic-client.js';
import { apiError } from './api-client.js';

const PATH = '/api/blab/complete';

// The account's state, not a passing failure: never retried, and they end the
// page's translation pass (api-errors.js marks the reply passFatal).
const ACCOUNT_CODES = Object.freeze(['daily_limit', 'plan_required', 'unauthorized']);

// How long plan_required / unauthorized stay remembered when nothing tells us
// the account changed. Short: buying a plan on the site does not reach this
// device by itself, and a minute is the longest the user should wait for the
// engine to notice without opening the popup or the settings page (each of
// which asks billing/me again).
const LATCH_TTL_MS = 60_000;

// { failure, message, at, until, token } — the account failure the service gave
// last, with the token it was given for. null: nothing remembered.
// Only in the service worker's memory: when Chrome recycles the worker the
// latch is gone, and at most one more wave of requests goes out before the
// service answers the same failure again and it is remembered anew.
let latch = null;

// After the user clicked an account entry ("Subscribe", "Sign in") the latch may
// be holding a state the user has just fixed on the site, which nothing tells
// this device about (D-497 F3). `actionPending` says so until a request a
// person made has been through refreshAfterAccountAction after the click; only
// such a request uses it up (D-498 F3-H). Requests nobody clicked (the
// automatic pass, subtitles) never do — the click may be a minute old and the
// latch they find a new one — and ask billing/me at most every
// ACTION_REFRESH_MS meanwhile, not once per batch or line.
const ACTION_REFRESH_MS = 10_000;
let actionPending = false;
let lastActionRefreshAt = -Infinity;

// The billing/me refresh on its way, { explicit, done }, or null. Every request
// that arrives meanwhile waits for it instead of asking again (D-498 N-2): a
// page pass sends its batches together, and a batch that skipped the wait would
// read the latch before the answer lands and be refused by it.
let refreshing = null;

async function currentToken() {
  const stored = await getToken();
  return stored ? stored.token : null;
}

/**
 * Remember an account failure. daily_limit lasts until the server's resetsAt
 * (a missing or unreadable one gets the short TTL); the other two until the
 * TTL. Either ends earlier when the account changes (latchedFailure).
 */
async function rememberAccountFailure(error) {
  const failure = error.apiFailure;
  const at = Date.now();
  const resetsAt = failure.blab === 'daily_limit' ? Date.parse(failure.resetsAt) : NaN;
  const until = Number.isFinite(resetsAt) ? resetsAt : at + LATCH_TTL_MS;
  latch = { failure, message: error.message, at, until, token: await currentToken() };
}

/**
 * The remembered latch ({ failure, message, ... }) while it still holds, else
 * null. It stops holding when
 * its time is up, when the token is not the one it was given for (signed in
 * again, signed out, another account), or — for plan_required and
 * unauthorized — when billing/me has judged the account since and found Blab
 * available.
 */
async function latchedFailure() {
  // The latch as this call found it: batches sent together read it at once, and
  // one of them may let it go (or a new refusal replace it) while another waits
  // on storage here.
  const held = latch;
  if (!held) return null;
  const release = () => {
    if (latch === held) latch = null;
    return null;
  };
  if (Date.now() >= held.until || (await currentToken()) !== held.token) return release();
  if (held.failure.blab !== 'daily_limit') {
    const cached = await getCachedAccount();
    const judgedSince = cached && cached.fetchedAt > held.at;
    if (judgedSince && globalThis.Engines.blabAccess({ signedIn: true, ...cached.account })
      === globalThis.Engines.BLAB_ACCESS.AVAILABLE) {
      return release();
    }
  }
  return held;
}

/**
 * Whether today's allowance is remembered as spent (a daily_limit the service
 * answered, until its resetsAt). The popup asks it beside billing/me, whose
 * `used` can lag behind the call that spent the last of it.
 */
async function dailyLimitHeld() {
  const held = await latchedFailure();
  return Boolean(held) && held.failure.blab === 'daily_limit';
}

/** The user clicked an account entry; see actionPending. */
function noteAccountAction() {
  actionPending = true;
}

/**
 * Before a Blab request, after an account entry was clicked: while a
 * plan_required or unauthorized latch holds, ask billing/me (forced past its
 * 30 s cache). latchedFailure then releases the latch if the account is
 * available now. `explicit`: a person asked for this request. Only such a
 * request uses up the pending refresh — by asking billing/me while the latch
 * holds, or by finding nothing held; any other asks at most every
 * ACTION_REFRESH_MS and leaves the click pending. A billing/me failure is this
 * request's failure (and that of every request that waited for it), worded and
 * remembered like the service's own answer.
 */
async function refreshAfterAccountAction({ explicit }) {
  if (refreshing) {
    const shared = refreshing;
    await shared.done;
    // A person's request does not settle for an answer asked before it on
    // nobody's behalf: it looks again, and asks again if the latch still holds.
    if (shared.explicit || !explicit) return;
  }
  if (!actionPending) return;
  const held = await latchedFailure();
  // Another request started the refresh while this one read the latch.
  if (refreshing) return refreshAfterAccountAction({ explicit });
  if (!held) {
    // Nothing is held: a person's request goes out as it is, and its own
    // answer is the account's. One nobody made leaves the click pending.
    if (explicit) actionPending = false;
    return;
  }
  // The allowance comes back with the day, not with a click.
  if (held.failure.blab === 'daily_limit') return;
  const now = Date.now();
  if (!explicit && now - lastActionRefreshAt < ACTION_REFRESH_MS) return;
  if (explicit) actionPending = false;
  lastActionRefreshAt = now;
  const flight = { explicit, done: askAccount() };
  refreshing = flight;
  try {
    await flight.done;
  } finally {
    if (refreshing === flight) refreshing = null;
  }
}

/** billing/me, forced; its failure turned into the Blab failure and remembered. */
async function askAccount() {
  try {
    await getAccount({ force: true });
  } catch (error) {
    const failure = blabFailure(error, `${await getApiBase()}/api/billing/me`);
    if (isBlabAccountFailure(failure.apiFailure)) await rememberAccountFailure(failure);
    throw failure;
  }
}

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
  const latched = await latchedFailure();
  if (latched) throw apiError(latched.message, { ...latched.failure, latched: true });
  let data;
  try {
    data = await apiFetch(prepared.endpoint, { method: 'POST', body: prepared.body, signal });
  } catch (error) {
    if (signal.aborted) throw error;
    const failure = blabFailure(error, `${await getApiBase()}${PATH}`);
    if (isBlabAccountFailure(failure.apiFailure)) await rememberAccountFailure(failure);
    throw failure;
  }
  const text = typeof data.text === 'string' ? data.text.trim() : '';
  if (!text) {
    const endpoint = `${await getApiBase()}${PATH}`;
    throw apiError(`Empty answer: ${endpoint}`, { empty: true, status: 200, detail: '', endpoint });
  }
  return { text };
}

/** Whether this failure is the account's state (signed out, no plan, today's allowance spent). */
function isBlabAccountFailure(failure) {
  return Boolean(failure) && ACCOUNT_CODES.includes(failure.blab);
}

export {
  blabRequest, sendBlab, dailyLimitHeld, noteAccountAction, refreshAfterAccountAction,
  isBlabAccountFailure, ACCOUNT_CODES,
};
