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
// two functions compute. The AI engine is not judged by the global settings
// either: which AI profile a page uses depends on that page's site rule, so
// whether AI is ready is the page's answer (`probe.aiReady`), or the service
// worker's when there is no page to ask (aiReady() below).
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
   * @property {'builtin'|'ai'|'blab'} engine
   * @property {boolean} supported        the built-in Translator is usable here
   * @property {string}  reason           a key of REASON_MESSAGE_KEYS, '' when supported
   * @property {'available'|'downloadable'|'downloading'|'unavailable'|'unknown'} availability
   * @property {{reason: string}|null} lastFallback  a fallback that already happened here
   * @property {boolean} aiReady          page translation's AI profile is usable here
   */

  /**
   * @typedef {Object} EngineStatus
   * @property {string}  key       i18n key for the status line
   * @property {string}  detailKey i18n key appended in parentheses, or ''
   * @property {boolean} ok        false paints the popup's error state
   */

  /**
   * The engine a click on this tab will use: one of Engines.ENGINES.
   *
   * The page answers first (`probe.engine`): it knows this site's custom rule,
   * which can pin an engine and outranks the setting. Only when there is no
   * page answer — the probe timed out, or the tab has no content script — does
   * the setting speak. The popup footer and the popup's "no API key" gate both
   * ask this one function, so they cannot disagree about which engine it is.
   *
   * @param {Object} settings
   * @param {EngineProbe|null} probe
   * @returns {'builtin'|'ai'|'blab'}
   */
  function selectedEngine(settings, probe) {
    if (probe && probe.engine) return probe.engine;
    return root.Engines.normalizeEngine(settings && settings.translationEngine);
  }

  /**
   * Whether "Translate this page" can go to the AI engine: is a profile
   * selected for page translation, and does it have the key it needs.
   *
   * The page answers first (`probe.aiReady`): it resolves the profile with this
   * site's rule. A probe that timed out is UNKNOWN_PROBE, whose `aiReady` is
   * true: a slow page is not evidence of a problem, and the real request
   * reports the real reason. With no page answer at all (`probe` is null: no
   * content script) the caller asks the service worker (AI_PROFILES_READY
   * {feature: 'page'}, no site rule, since there is no site) and passes that
   * in as `workerReady`.
   *
   * @param {EngineProbe|null} probe
   * @param {boolean} [workerReady]  required when probe is null
   * @returns {boolean}
   */
  function aiReady(probe, workerReady) {
    const answer = probe ? probe.aiReady : workerReady;
    if (typeof answer !== 'boolean') {
      throw new TypeError(probe ? 'EngineStatus.aiReady: the probe has no aiReady'
        : 'EngineStatus.aiReady: no probe, and no answer from the service worker');
    }
    return answer;
  }

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
   * @param {boolean} aiIsReady          aiReady()'s answer for this tab
   * @param {string|null} [blabAccess]   Engines.blabAccess() of the account, or
   *                                     null when the account could not be read;
   *                                     required when the engine is 'blab'
   * @returns {EngineStatus}
   */
  function describeEngineStatus(settings, probe, aiIsReady, blabAccess) {
    const engine = selectedEngine(settings, probe);

    if (engine === 'ai') {
      if (typeof aiIsReady !== 'boolean') throw new TypeError('describeEngineStatus: the AI engine needs aiReady()');
      return status(aiIsReady ? 'ready' : 'apiNotConfigured', '', aiIsReady);
    }

    // Blab Translation: the account says whether it can be used (signed in and
    // a plan, Engines.blabAccess). The dot is a claim of "works", so it is green
    // only when the account says AVAILABLE; an account that could not be read
    // (null) has not said so either. Today's allowance is the request's answer,
    // not the footer's.
    if (engine === 'blab') {
      const access = root.Engines.BLAB_ACCESS;
      if (blabAccess === access.AVAILABLE) return status('engineBlab', '', true);
      if (blabAccess === access.SIGNED_OUT) return status('engineBlab', 'blabStatusSignedOut', false);
      if (blabAccess === access.PLAN_REQUIRED) return status('engineBlab', 'blabStatusPlanRequired', false);
      if (blabAccess === null) return status('engineBlab', 'blabStatusUnknown', false);
      throw new TypeError('describeEngineStatus: the Blab engine needs the account\'s blabAccess (or null)');
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
    lastFallback: null,
    aiReady: true
  });

  root.EngineStatus = {
    BUILTIN_MIN_CHROME,
    REASON_MESSAGE_KEYS,
    UNKNOWN_PROBE,
    builtinUnsupportedReason,
    selectedEngine,
    aiReady,
    describeEngineStatus
  };
})(globalThis);
