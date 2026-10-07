// Blab Translation background — what a failed AI request says to the reader.
//
// shared/api-compat.js decides whether a key is needed and what went wrong
// (a structured failure); it does not know the reader's language. This is the
// service worker's one boundary where both are turned into a sentence, in the
// UI language, for the TRANSLATE handlers, OCR's vision engine and the
// settings page's connection test alike. The content scripts show
// `response.error` as it arrives and do no wording of their own.
//
// It is also where those errors stop travelling up: replyError() is the one
// place an AI request failure is logged (operation, profile id, feature and
// the original error — never the key, the request body or the user's text).

import '../shared/api-compat.js';
import '../i18n/messages.js';
import { uiLanguageOf } from './settings.js';

/** The UI-language lookup for these settings, t(key) -> string. */
function uiMessages(settings) {
  const lang = uiLanguageOf(settings);
  return (key) => globalThis.getMessage(key, lang);
}

/**
 * An error that says which profile could not be used: `key` is
 * 'aiProfileMissing' (a request or rule names a profile that is gone; `id`
 * says which) or 'aiNotConfigured' (there is no profile at all). These are
 * AIProfiles.resolve() codes, not i18n keys: AIProfiles.resolveMessageKey()
 * words them, so "no profile" reads exactly like the popup's configureApiKeyFirst.
 */
function profileError(key, id) {
  const error = new Error(id ? `${key}: ${id}` : key);
  error.profileError = { key, id: id || '' };
  return error;
}

/**
 * The reader-facing refusal when this profile needs a key it does not have,
 * '' when it can go ahead. The rule itself is APICompat.isApiKeyMissing: a
 * local model server (loopback or LAN literal, or the Ollama / LM Studio
 * preset) needs none.
 */
function missingApiKeyMessage(profile, settings) {
  return globalThis.APICompat.isApiKeyMissing(profile)
    ? uiMessages(settings)('configureApiKeyFirst')
    : '';
}

/**
 * The reader-facing text for an error thrown on the way to the model.
 *
 * An error from model-client.js carries `apiFailure` and is described through
 * APICompat.describeAPIFailure (the local-server hints need the profile's
 * `provider`). A profile that could not be used carries `profileError`; a
 * profile the settings form described badly throws an AIProfiles error key
 * (AIProfiles.userErrorKey). A dictionary lookup whose answer is not a valid
 * entry carries `invalidEntry` (shared/dict-entry.js) and reads as
 * dictEntryUnreadable. Anything else was already written for the reader where it was thrown, so its
 * message stands; a bare Error falls back to the generic "translation failed".
 */
function apiErrorMessage(error, settings, profile) {
  const t = uiMessages(settings);
  if (error && error.apiFailure) {
    return globalThis.APICompat.describeAPIFailure(error.apiFailure, t,
      { provider: profile ? profile.provider : undefined });
  }
  if (error && error.profileError) {
    const { key, id } = error.profileError;
    return t(globalThis.AIProfiles.resolveMessageKey(key)).replace('{name}', id);
  }
  if (error && error.invalidEntry) return t('dictEntryUnreadable');
  const profileKey = globalThis.AIProfiles.userErrorKey(error);
  if (profileKey) return t(profileKey);
  return (error && error.message) || t('translationFailed');
}

/**
 * The one catch for an AI request: log once, answer `{ error }` in the UI
 * language. A request its caller abandoned (`error.aborted`) has nobody
 * waiting, so it is neither logged nor worded.
 */
function replyError(operation, error, { settings, profile, profileId, feature }) {
  if (error && error.aborted) return { aborted: true };
  const id = profile ? (profile.id || '(unsaved)') : (profileId || '(none)');
  // callModel 重试过的，把一共试了几次写进这一条（中间那几次不另打日志）。
  const tries = error && error.attempts > 1 ? ` after ${error.attempts} attempts` : '';
  console.error(`${operation} failed${tries} (profile ${id}, feature ${feature || '(none)'}):`, error);
  return { error: apiErrorMessage(error, settings, profile) };
}

export { profileError, missingApiKeyMessage, apiErrorMessage, replyError };
