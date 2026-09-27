// Blab Translation — the account gate for the two server-backed features.
//
// Comic translation and PDF translation do not use the user's own API key: they
// run on our servers against a monthly free page allowance, so both require a
// signed-in account. That makes their switches a preference with a
// precondition, and the two live in different storage areas on purpose:
//
//   enableComicTranslation / enablePdfTranslation   chrome.storage.sync   (per account)
//   comicToken                                      chrome.storage.local  (per device)
//
// The two halves are two different answers, and every surface needs to tell
// them apart: "the user turned it off" means stay out of the way, while "not
// signed in" means offer the feature and sign in when it is used. So the gate
// never rewrites a setting. It answers with one of three states, from the raw
// switch and the sign-in state together — featureState() below is the one place
// that combination is made.
//
// Nothing is written back to sync either: a new install syncs the switches down
// before it has ever signed in, so a signed-out device that "corrected" the
// preference would reach across and turn the feature off on the device that is
// still signed in.
//
// Loaded as a classic script by the popup, the options page and the content
// scripts, and as a side-effect import by the module service worker, so it
// publishes onto the global object rather than using `export`.
(function (root) {
  'use strict';

  // Written by comic-client.js saveToken/clearToken. Expiry is deliberately not
  // considered here — see getToken() there: the server's 401 is what retires a
  // token, because a wrong local clock must not lock a user out.
  const TOKEN_KEY = 'comicToken';

  // The two switches this gate governs. Both features share one account, so
  // they share one precondition.
  const ACCOUNT_FEATURE_KEYS = ['enableComicTranslation', 'enablePdfTranslation'];

  // What a surface can do with a feature:
  //   READY       switch on, signed in: every entry point works.
  //   SIGNED_OUT  switch on, no account on this device: offer it, and sign in
  //               first when it is used.
  //   OFF         the user turned the switch off: nothing appears on its own.
  const FEATURE_STATES = Object.freeze({ READY: 'ready', SIGNED_OUT: 'signed_out', OFF: 'off' });

  /** Whether this device holds a credential for the translation service. */
  async function hasAccount() {
    try {
      const stored = await chrome.storage.local.get({ [TOKEN_KEY]: '' });
      return !!stored[TOKEN_KEY];
    } catch (error) {
      // Only a torn-down extension context lands here, and "no account" is the
      // answer that fails closed.
      return false;
    }
  }

  /**
   * The state of one account-backed feature.
   *
   * `settings` is the raw sync read (never mutated), `signedIn` the caller's own
   * answer from hasAccount() — kept apart so a caller that already knows it
   * (the content script tracks it, the options page asks the server) does not
   * pay a storage read per question.
   */
  function featureState(settings, key, signedIn) {
    if (!ACCOUNT_FEATURE_KEYS.includes(key)) {
      throw new Error(`AccountGate: ${key} is not an account-backed feature`);
    }
    if (!settings || !settings[key]) return FEATURE_STATES.OFF;
    return signedIn ? FEATURE_STATES.READY : FEATURE_STATES.SIGNED_OUT;
  }

  root.AccountGate = { TOKEN_KEY, ACCOUNT_FEATURE_KEYS, FEATURE_STATES, hasAccount, featureState };
})(globalThis);
