// Blab Translation background — "adjust the tone" of what the user is writing.
//
// One request to the Blab server: the text, the language to write it in, the
// tone id and (when the page could tell) the text's language. Those four fields
// are the whole contract; the wording of each tone lives on the server, so no
// prompt is assembled here (docs/design/input-tone-rewrite.md §4.5, §6).
//
// Sign-in and the bearer token are apiFetch's (comic-client.js): with no token
// it refuses before any request leaves, and a 401 drops the token so the next
// attempt offers a sign-in. The request is `quiet`: a failure is logged once,
// in the page that shows it (content/content-input-menu.js), which also words
// each refusal from `error.code`; the entry that fixes it comes from
// account-actions.js through replyComic.

import '../shared/tones.js';
import { apiFetch, ComicApiError } from './comic-client.js';

/**
 * Rewrite `text` in `tone`, written in `targetLang`.
 * Resolves to `{ text, tone, usage }`; rejects with a ComicApiError.
 */
export async function composeTone({ text, targetLang, tone, sourceLang } = {}) {
  if (!globalThis.Tones.isTone(tone)) {
    throw new ComicApiError('bad_request', `unknown tone ${JSON.stringify(tone)}`, 400);
  }
  if (typeof text !== 'string' || !text.trim() || typeof targetLang !== 'string' || !targetLang) {
    throw new ComicApiError('bad_request', 'compose needs text and a target language', 400);
  }
  const body = { text, targetLang, tone };
  if (sourceLang) body.sourceLang = sourceLang;
  const reply = await apiFetch('/api/compose/tone', { method: 'POST', body, quiet: true });
  if (typeof reply.text !== 'string' || !reply.text.trim()) {
    throw new ComicApiError('upstream_failed', 'the rewrite came back empty', 502);
  }
  return { text: reply.text, tone: reply.tone, usage: reply.usage };
}
