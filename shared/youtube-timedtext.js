// Blab Translation — which track a YouTube caption request is for.
//
// The page's player fetches captions for whatever is playing in it, and that is
// not always the video the page is for: an ad plays in the same player, with no
// navigation, and its caption track comes down the same endpoint, in the same
// language, timed from zero. Taken as the video's track, the ad's lines are
// merged into the video's timeline and shown over its opening minutes — lines
// the video never had.
//
// The request says which video its payload belongs to (`v`), and the player
// says which video the page is for. This is the one place the two are compared.
// It is its own file because it is the only thing here that knows what a
// YouTube caption URL looks like: shared/caption-core.js knows nothing about
// any site, and the provider that calls this (content/content-caption-providers.js)
// is not something a unit test can load.
//
// A classic script for the content side, loaded before the providers; a test
// imports it for its side effect and reads globalThis.YouTubeTimedText.
(function (root) {
  'use strict';

  /**
   * The track a caption request is for — or null when it is not for the video
   * this page is showing.
   *
   * With no content id there is nothing to compare against, and that reads as
   * "not ours": guessing would bring the ad lines back.
   *
   * The id covers everything that makes two requests two different texts. A
   * video's manual and auto-generated tracks share `lang` and differ in `kind`;
   * two manual tracks in one language differ in `name`; a machine-translated
   * one carries `tlang`. Keyed on `lang` alone they would be merged into one
   * timeline instead of replacing each other. `lang` in the answer is the
   * language the text is in, which under `tlang` is the translation's.
   *
   * @param {string} url the request, as the player made it; may be relative
   * @param {string} contentVideoId the video the player says the page is for
   * @param {string} [base] what a relative `url` is relative to
   * @returns {{trackId: string, lang: string} | null}
   */
  function trackOf(url, contentVideoId, base) {
    if (!contentVideoId) return null;
    let params;
    try {
      params = new URL(url, base).searchParams;
    } catch (e) {
      return null;
    }
    if (params.get('v') !== contentVideoId) return null;
    const part = (name) => params.get(name) || '';
    const lang = part('lang');
    const tlang = part('tlang');
    return {
      trackId: [contentVideoId, lang, part('kind'), part('name'), tlang].join('|'),
      lang: tlang || lang,
    };
  }

  root.YouTubeTimedText = { trackOf };
})(globalThis);
