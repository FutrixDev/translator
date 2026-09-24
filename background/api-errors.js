// Blab Translation background — what a failed AI request says to the reader.
//
// shared/api-compat.js decides whether a key is needed and what went wrong
// (a structured failure); it does not know the reader's language. This is the
// service worker's one boundary where both are turned into a sentence, in the
// UI language, for the three TRANSLATE handlers and OCR's vision engine alike.
// The content scripts show `response.error` as it arrives and do no wording of
// their own.

import '../shared/api-compat.js';
import '../i18n/messages.js';
import { uiLanguageOf } from './settings.js';

/** The UI-language lookup for these settings, t(key) -> string. */
function uiMessages(settings) {
  const lang = uiLanguageOf(settings);
  return (key) => globalThis.getMessage(key, lang);
}

/**
 * The reader-facing refusal when this configuration needs a key it does not
 * have, '' when it can go ahead. The rule itself is APICompat.isApiKeyMissing:
 * a local model server (loopback or LAN literal, or the Ollama / LM Studio
 * preset) needs none.
 */
function missingApiKeyMessage(settings) {
  return globalThis.APICompat.isApiKeyMissing(settings)
    ? uiMessages(settings)('configureApiKeyFirst')
    : '';
}

/**
 * The reader-facing text for an error thrown on the way to the model.
 *
 * An error from api-client.js carries `apiFailure` and is described through
 * APICompat.describeAPIFailure (the local-server hints need `provider`, which
 * `settings` carries). Anything else was already written for the reader where
 * it was thrown, so its message stands; a bare Error falls back to the generic
 * "translation failed".
 */
function apiErrorMessage(error, settings) {
  const t = uiMessages(settings);
  if (error && error.apiFailure) {
    return globalThis.APICompat.describeAPIFailure(error.apiFailure, t, settings);
  }
  return (error && error.message) || t('translationFailed');
}

export { missingApiKeyMessage, apiErrorMessage };
