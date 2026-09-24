// Blab Translation — what the translation engine can actually do right now.
//
// Two questions with one answer each, both pure, so the popup and the content
// script cannot drift apart on them:
//
//   builtinUnsupportedReason()  why the built-in Translator is not here
//   describeEngineStatus()      what the user should be told, in one line
//
// The built-in engine is the default and it is key-free, so the popup used to
// judge readiness by `!settings.apiKey` and told every default user "API Not
// Configured" — an error about a thing they were never meant to configure.
// Readiness is a property of the *engine in this tab*, and that is what these
// two functions compute. Even the AI engine is not judged by the key alone: a
// local model server needs none, and whether one is needed is
// APICompat.isApiKeyMissing's answer (shared/api-compat.js, which every load
// list carries ahead of this file).
//
// Loaded as a classic script by the popup and by the content scripts, so it
// publishes onto the global object rather than using `export`.
(function (root) {
  'use strict';

  // The Chrome release where the Translator API reached stable. manifest.json
  // stays at minimum_chrome_version 116 on purpose — everything else in the
  // extension works there, and a user on 116 with their own API key has a
  // perfectly good product. What they must not get is silence: on 116–137 the
  // built-in engine is simply absent, and the status line says so.
  const BUILTIN_MIN_CHROME = 138;

  /**
   * Why `self.Translator` is not available, given three facts the caller
   * gathers from its own realm.
   *
   * The order is the honest one. `Translator` is [SecureContext], so on an
   * http:// page it is absent whatever the browser version — presence alone
   * cannot tell the two apart. The version is the one fact that is knowable
   * independently, so it is asked first; the scheme explains the rest.
   *
   * @param {Object}  env
   * @param {boolean} env.secureContext  self.isSecureContext
   * @param {boolean} env.hasTranslator  self.Translator.create is callable
   * @param {number}  env.chromeMajor    major version, 0 when unknown
   * @returns {'oldBrowser'|'insecureContext'|'noApi'|''} '' when it *is* available
   */
  function builtinUnsupportedReason({ secureContext, hasTranslator, chromeMajor }) {
    if (hasTranslator && secureContext) return '';
    if (chromeMajor > 0 && chromeMajor < BUILTIN_MIN_CHROME) return 'oldBrowser';
    if (!secureContext) return 'insecureContext';
    return 'noApi';
  }

  // Every way the built-in engine can be unavailable, in one table: the three
  // environment reasons above, and the five ENGINE_REASONS the translate path
  // itself raises. To the user they are all "why this page could not use local
  // translation", and both the status line and the fallback trace read them
  // from here — a reason that reaches either surface has a sentence.
  const REASON_MESSAGE_KEYS = Object.freeze({
    oldBrowser: 'builtinReasonOldBrowser',
    insecureContext: 'builtinReasonInsecureContext',
    noApi: 'builtinReasonNoApi',
    unsupportedEnv: 'builtinUnsupportedEnv',
    unsupportedPair: 'builtinUnsupportedPair',
    needsDownload: 'builtinNeedsDownload',
    createFailed: 'builtinUnavailable',
    timedOut: 'builtinUnavailable'
  });

  /**
   * @typedef {Object} EngineProbe  what the content script saw in its own tab
   * @property {'builtin'|'ai'} engine
   * @property {boolean} supported        the built-in Translator is usable here
   * @property {string}  reason           a key of REASON_MESSAGE_KEYS, '' when supported
   * @property {'available'|'downloadable'|'downloading'|'unavailable'|'unknown'} availability
   * @property {{reason: string}|null} lastFallback  a fallback that already happened here
   */

  /**
   * @typedef {Object} EngineStatus
   * @property {string}  key       i18n key for the status line
   * @property {string}  detailKey i18n key appended in parentheses, or ''
   * @property {boolean} ok        false paints the popup's error state
   */

  /**
   * One line of truth for the popup footer.
   *
   * `probe` is null when the content script could not be reached — a
   * chrome:// page, the Web Store, a tab the extension is not injected into.
   * That is a real answer ("not here"), not a missing one, and it is separate
   * from a probe that timed out: a timeout is not evidence of a problem, so it
   * comes back as `{ availability: 'unknown' }` and is read as working.
   *
   * @param {Object} settings           the user's settings
   * @param {EngineProbe|null} probe
   * @returns {EngineStatus}
   */
  function describeEngineStatus(settings, probe) {
    const engine = (probe && probe.engine) || (settings && settings.translationEngine) || 'builtin';

    if (engine === 'ai') {
      // The only engine that can need a key. APICompat is read here, at call
      // time, so a load list that forgot shared/api-compat.js fails at this
      // line rather than silently at load.
      const ready = !root.APICompat.isApiKeyMissing(settings);
      return status(ready ? 'ready' : 'apiNotConfigured', '', ready);
    }

    if (probe === null) {
      return status('statusPageUnsupported', '', false);
    }

    if (probe.lastFallback) {
      // The built-in engine gave up on this page and the user's own API was
      // billed for the rest. That is the one thing the fallback must never do
      // silently, so it outranks whatever the engine's state is now.
      return status('statusEngineFellBack', reasonKey(probe.lastFallback.reason), true);
    }

    if (probe.supported === false) {
      return status('statusBuiltinUnavailable', reasonKey(probe.reason), false);
    }

    switch (probe.availability) {
      case 'downloadable':
      case 'downloading':
        return status('statusBuiltinPreparing', '', true);
      case 'unavailable':
        return status('statusBuiltinUnavailable', REASON_MESSAGE_KEYS.unsupportedPair, false);
      case 'available':
        return status('statusBuiltinReady', '', true);
      default:
        // 'unknown' — the probe answered but could not settle the language
        // pair, most often because the page's language is not detectable yet.
        // Nothing is known to be wrong, so nothing is claimed to be.
        return status('ready', '', true);
    }
  }

  function reasonKey(reason) {
    return REASON_MESSAGE_KEYS[reason] || '';
  }

  function status(key, detailKey, ok) {
    return { key, detailKey, ok };
  }

  // What a probe that did not come back in time counts as. Deliberately not
  // `null`: "the content script was too slow" and "there is no content script
  // on this page" are different facts, and only the second one is a problem.
  const UNKNOWN_PROBE = Object.freeze({
    engine: '',
    supported: true,
    reason: '',
    availability: 'unknown',
    lastFallback: null
  });

  root.EngineStatus = {
    BUILTIN_MIN_CHROME,
    REASON_MESSAGE_KEYS,
    UNKNOWN_PROBE,
    builtinUnsupportedReason,
    describeEngineStatus
  };
})(globalThis);
