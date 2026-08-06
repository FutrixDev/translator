// AI Translator — the account gate for the two server-backed features.
//
// Comic translation and PDF translation do not use the user's own API key: they
// run on our servers against a monthly free page allowance, so both require a
// signed-in account. That makes their switches a preference with a
// precondition, and the two live in different storage areas on purpose:
//
//   enableComicTranslation / enablePdfTranslation   chrome.storage.sync   (per account)
//   comicToken                                      chrome.storage.local  (per device)
//
// A device with no token cannot run either feature, so it must not show them as
// on, hide-nothing entry points, or accept a job for them. That answer is
// DERIVED here on every read rather than written back to sync: a new install
// syncs the switches down before it has ever signed in, so a signed-out device
// that "corrected" the preference would reach across and turn the feature off
// on the device that is still signed in.
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
   * Force the account-backed switches off when this device has no account.
   *
   * Mutates and returns `settings` — every caller already holds the object it
   * read out of sync storage, and the point is that no caller ever sees the
   * ungated value.
   */
  async function applyAccountGate(settings) {
    if (!settings) return settings;
    // Nothing to gate when both are already off, and that is the common case —
    // worth skipping the storage read on every settings load for.
    if (!ACCOUNT_FEATURE_KEYS.some(key => settings[key])) return settings;
    if (await hasAccount()) return settings;
    ACCOUNT_FEATURE_KEYS.forEach(key => { settings[key] = false; });
    return settings;
  }

  root.AccountGate = { TOKEN_KEY, ACCOUNT_FEATURE_KEYS, hasAccount, applyAccountGate };
})(globalThis);
