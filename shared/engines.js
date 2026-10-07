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

  root.Engines = Object.freeze({ ENGINES, MODEL_ENGINES, isEngine, isModelEngine, normalizeEngine });
})(globalThis);
