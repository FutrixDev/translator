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
import '../shared/engines.js';
import '../i18n/messages.js';
import { uiLanguageOf } from './settings.js';
import { isBlabAccountFailure } from './blab-client.js';

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
  // Blab Translation has no key of its own: it rides the account's token, and
  // a missing one comes back from the service as `unauthorized` (below).
  if (globalThis.Engines.isBlabProfile(profile)) return '';
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
  if (error && isBlabAccountFailure(error.apiFailure)) return blabAccountMessage(error.apiFailure, settings, t);
  if (error && error.apiFailure && globalThis.Engines.isBlabProfile(profile)) {
    return blabServiceMessage(error.apiFailure, t);
  }
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
 * Blab Translation's account state, worded for the reader (design §5.2): today's
 * allowance spent (with the local time it comes back), no subscription, or not
 * signed in. Each names Settings, where signing in and subscribing live. None
 * of them is a reason to try another engine: the reply is the answer.
 */
function blabAccountMessage(failure, settings, t) {
  if (failure.blab === 'daily_limit') {
    const resets = new Date(failure.resetsAt);
    const time = Number.isNaN(resets.getTime())
      ? ''
      : resets.toLocaleString(uiLanguageOf(settings), { dateStyle: 'short', timeStyle: 'short' });
    return t('blabDailyLimit').replace('{time}', time);
  }
  if (failure.blab === 'plan_required') return t('blabPlanRequired');
  return t('blabSignInRequired');
}

/**
 * Blab Translation's other failures, in its own words (D-490 N3): the service
 * is ours, so "check your API address and key" (describeAPIFailure's wording
 * for the user's own AI) would send the reader to a setting that does not
 * exist. Busy (429, any 5xx including upstream_failed), unreachable, too slow,
 * an empty answer, or a request the service would not take (another 4xx, with
 * its status for the bug report).
 */
function blabServiceMessage(failure, t) {
  if (failure.timeout) return t('blabErrorTimeout').replace('{seconds}', String(failure.seconds));
  if (failure.empty) return t('blabErrorEmpty');
  if (failure.network) return t('blabErrorNetwork');
  const status = Number(failure.status);
  if (failure.rateLimitedWait || status === 429 || status >= 500) return t('blabErrorBusy');
  return t('blabErrorRequest').replace('{status}', String(failure.status));
}

/**
 * The entry an account failure carries to the page (D-490 N2, design §5.2):
 * the error bar and the selection card draw it as a button. No subscription
 * gets "Subscribe", a missing or expired sign-in gets "Sign in"; today's
 * allowance has nothing to press — it comes back by itself.
 */
const BLAB_ACCOUNT_ACTIONS = Object.freeze({ plan_required: 'subscribe', unauthorized: 'signin' });

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
  const reply = { error: apiErrorMessage(error, settings, profile) };
  // The account's state ends a whole-page pass at once (content/page/batch.js
  // reads passFatal): every other batch would get the same answer.
  if (isBlabAccountFailure(error && error.apiFailure)) {
    reply.passFatal = true;
    const action = BLAB_ACCOUNT_ACTIONS[error.apiFailure.blab];
    if (action) reply.action = action;
  }
  return reply;
}

export { profileError, missingApiKeyMessage, apiErrorMessage, replyError };
