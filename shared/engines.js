// Blab Translation — the translation engines, in one place (D-479).
//
//   'builtin'  Chrome's on-device Translator API; nothing leaves the browser
//   'ai'       the user's own AI API (an AI profile, their key, their bill)
//   'blab'     Blab Translation: the user's subscription, served by our API
//
// Every place that stores, validates, pins or renders an engine reads this
// list. Each of them used to spell the choice out as a two-way `=== 'ai' ?
// 'ai' : 'builtin'`, and a third value written by one of them was quietly
// turned back into 'builtin' by the next one that read it.
//
// `isModelEngine` is the other half: 'ai' and 'blab' are both a language model
// behind the service worker's callModel, so batching, the translation cache,
// dictionary entries and captions treat them alike. Only who pays differs —
// the user's own API for 'ai', the account's daily allowance for 'blab'.
//
// Loaded as a classic script by the pages and the content scripts and imported
// for its side effect by the service worker, so it publishes onto the global
// object rather than using `export`.
(function (root) {
  'use strict';

  const ENGINES = Object.freeze(['builtin', 'ai', 'blab']);
  const MODEL_ENGINES = Object.freeze(['ai', 'blab']);

  // The one profile the 'blab' engine sends with. It has the shape of an AI
  // profile (shared/ai-profiles.js) so the service worker's callModel — retry,
  // rate limiter, keepalive, total budget — treats it like any other, but it is
  // not one: no key, nothing the user can edit, never stored. Its id has a ':'
  // that SyncCollection.validId refuses, so no stored profile can collide with
  // it, and the worker recognises it by that id (background/blab-client.js).
  // apiEndpoint and modelName are what the translation cache keys on (design
  // §5.3); timeoutSec is the AI profiles' default, concurrency matches the
  // content side's CONCURRENCY.blab.
  const BLAB_PROFILE = Object.freeze({
    id: 'blab:service',
    kind: 'blab',
    provider: 'blab',
    apiEndpoint: 'blab',
    modelName: 'blab',
    timeoutSec: 120,
    rpm: 0,
    concurrency: 6,
  });

  /** Whether `value` is one of ENGINES. */
  function isEngine(value) {
    return ENGINES.includes(value);
  }

  /** Whether `engine` is answered by a language model ('ai' or 'blab'). */
  function isModelEngine(engine) {
    return MODEL_ENGINES.includes(engine);
  }

  /**
   * A stored engine setting as the engine it names. A value that is not an
   * engine — absent, or written by something else — reads as 'builtin', the
   * default, which is what every reader did before there were three.
   */
  function normalizeEngine(value) {
    return isEngine(value) ? value : 'builtin';
  }

  /**
   * Whether `profile` is BLAB_PROFILE: the service worker's one test for "send
   * this to /api/blab/complete" (callModel's transport, the TRANSLATE handlers'
   * profile lookup, the missing-key check). By id, because the profile crosses
   * a message as its id only.
   */
  function isBlabProfile(profile) {
    return Boolean(profile) && profile.id === BLAB_PROFILE.id;
  }

  /** What blabAccess() answers: the three states every surface draws (§5.4). */
  const BLAB_ACCESS = Object.freeze({
    SIGNED_OUT: 'signed_out',
    PLAN_REQUIRED: 'plan_required',
    AVAILABLE: 'available',
  });

  /**
   * Whether an account, as getAccount() answers it (`{signedIn, ...billing/me}`),
   * can use Blab Translation. Only the server decides (D-476): this reads
   * `blabTranslation.available` and never infers it from the plan. A signed-in
   * answer without the field is PLAN_REQUIRED, not available: a server that does
   * not say yes has not said yes. The settings page and the content side's
   * engine choice both ask this, so they cannot disagree.
   */
  function blabAccess(account) {
    if (!account || account.signedIn !== true) return BLAB_ACCESS.SIGNED_OUT;
    const blab = account.blabTranslation;
    return blab && blab.available === true ? BLAB_ACCESS.AVAILABLE : BLAB_ACCESS.PLAN_REQUIRED;
  }

  /**
   * Whether billing/me says today's Blab allowance is spent (D-497 F1): an
   * available account whose `used` has reached its `limit`. The account is still
   * AVAILABLE (blabAccess) — the plan is there, today's share is not — so this is
   * a second question, asked where "works right now" is claimed (the popup's dot).
   */
  function blabAllowanceSpent(account) {
    const blab = account && account.signedIn === true ? account.blabTranslation : null;
    if (!blab || blab.available !== true) return false;
    return Number.isFinite(blab.limit) && Number.isFinite(blab.used) && blab.used >= blab.limit;
  }

  /**
   * Where subscribing to Blab Translation happens: the account site's pricing
   * page, from the base the service worker answers (ACCOUNT_SITE_BASE). The
   * settings page's note and the worker's "Subscribe" entry (the page's error
   * bar, the selection card) both build it here.
   *
   * '' rather than a broken link when there is nowhere to point: no base, or one
   * that is not http(s). The base comes out of chrome.storage, so a value that
   * would turn an <a href> into `javascript:` is never built into one, and an
   * empty base never becomes the relative `/app/pricing` of the extension page.
   */
  function blabPricingUrl(base) {
    let origin;
    try {
      origin = new URL(String(base || ''));
    } catch {
      return '';
    }
    if (!/^https?:$/.test(origin.protocol)) return '';
    return `${origin.origin}/app/pricing`;
  }

  root.Engines = Object.freeze({
    ENGINES, MODEL_ENGINES, BLAB_PROFILE, BLAB_ACCESS,
    isEngine, isModelEngine, normalizeEngine, isBlabProfile, blabAccess, blabAllowanceSpent, blabPricingUrl,
  });
})(globalThis);
