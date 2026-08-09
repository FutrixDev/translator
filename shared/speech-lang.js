// AI Translator — choosing the language a read-aloud button speaks in.
//
// Two questions, both easy to get wrong, both pure, so they live here where
// `npm run test:unit` can exercise them against a synthetic voice list rather
// than against whichever voices the machine running the tests happens to have.
//
//   1. What language is this text actually in?   resolveSpokenLang()
//   2. What tag will an installed voice answer to? resolveSpeechLang()
//
// Question 2 is the one that made every non-Chinese target unintelligible.
// Chrome matches `utterance.lang` against the installed voices, and when
// nothing matches it does NOT fall back to a near neighbour — it uses the
// system default voice. No installed voice carries a bare language tag; every
// one of the 180 voices macOS ships is region-qualified (`en-US`, `ja-JP`,
// `fr-FR`). Eight of our ten targets are bare, and so are the ISO-639 codes
// chrome.i18n.detectLanguage returns. So the common case was the broken one:
// choosing English on a Chinese-locale Mac set `lang = 'en'`, matched nothing,
// and read the English out with 婷婷, the system default.
//
// Loaded as a classic script by the content scripts, so it publishes onto the
// global object rather than using `export`.
(function(root) {
  'use strict';

  // Widening a bare code needs a region, and the region is a real choice: to a
  // listener pt-BR and pt-PT are not interchangeable. Every language the
  // pickers offer needs an entry here, which test/unit/content-speech.test.mjs
  // checks against content/content-bootstrap.js so the two cannot drift.
  const SPEECH_REGION = {
    zh: 'zh-CN',
    en: 'en-US',
    ja: 'ja-JP',
    ko: 'ko-KR',
    fr: 'fr-FR',
    de: 'de-DE',
    es: 'es-ES',
    pt: 'pt-BR',
    ru: 'ru-RU',
  };

  // The scripts our languages use that Latin never borrows wholesale. Japanese
  // is tested before Chinese: Japanese mixes kanji into kana, so Han alone is
  // Chinese but Han beside kana is not.
  const CJK_SCRIPT = {
    ja: /[぀-ヿ]/,                  // hiragana + katakana
    ko: /[가-힯ᄀ-ᇿ]/,     // hangul syllables + jamo
    zh: /[一-鿿]/,                  // han
  };

  const baseOf = (tag) => String(tag || '').split(/[-_]/)[0].toLowerCase();

  /** The language a piece of text is in when its script alone settles it. */
  function scriptOf(text) {
    const value = String(text || '');
    for (const lang of Object.keys(CJK_SCRIPT)) {
      if (CJK_SCRIPT[lang].test(value)) return lang;
    }
    return '';
  }

  /**
   * Widen a language tag until some installed voice answers to it.
   *
   * Only the tag is ever set, never `utterance.voice`: once the tag matches,
   * the engine picks that language's preferred voice. Choosing one ourselves
   * would mean ranking the 41 English voices macOS installs with no signal for
   * which are ordinary and which are novelties — the first alphabetically is
   * Albert, and "Bad News" and "Bells" are in there too.
   *
   * @param {string} lang
   * @param {Array<{lang: string}>} voices speechSynthesis.getVoices()
   * @returns {string} a tag to put on the utterance, or '' to leave it unset
   */
  function resolveSpeechLang(lang, voices) {
    if (!lang) return '';
    const tag = String(lang).replace('_', '-');
    const list = Array.isArray(voices) ? voices : [];
    // Nothing to check against: hand back the tag rather than guess a region
    // the machine may not have.
    if (!list.length) return tag;

    const tagOf = (voice) => String(voice?.lang || '').replace('_', '-');
    const has = (candidate) => list.some((voice) => tagOf(voice).toLowerCase() === candidate.toLowerCase());
    if (has(tag)) return tag;

    const preferred = SPEECH_REGION[baseOf(tag)];
    if (preferred && has(preferred)) return preferred;

    // A language we do not translate into can still turn up as a detected
    // source language. Whatever region of it is installed beats falling back
    // to the system default voice.
    const installed = list.find((voice) => baseOf(tagOf(voice)) === baseOf(tag));
    return installed ? tagOf(installed) : tag;
  }

  /**
   * Which language `text` should actually be spoken in.
   *
   * `declared` is what the caller asked the translator for, not what came
   * back. Those differ often enough to matter: the prompt tells the model to
   * return text already in the target language untouched, and a translation
   * can fail into an echo of the source. Reading 动画 with an English voice is
   * not an accent, it is noise.
   *
   * Script settles it wherever script can. It is the dependable half of
   * language identification — telling Spanish from Portuguese takes a whole
   * sentence, but no quantity of Han is English — and it decides the two
   * characters that chrome.i18n.detectLanguage cannot judge at all.
   *
   * @param {string} text
   * @param {string} declared the target language the caller asked for, if any
   * @param {() => Promise<string>} detect statistical detection, the last resort
   */
  async function resolveSpokenLang(text, declared, detect) {
    const script = scriptOf(text);
    if (script) {
      // zh-CN and zh-TW both reduce to `zh`; keep the caller's finer answer.
      return baseOf(declared) === script ? declared : script;
    }
    // The text carries no CJK, so a CJK target is the wrong voice to read it
    // with — whatever it is, it is not that.
    if (declared && !CJK_SCRIPT[baseOf(declared)]) return declared;
    const detected = typeof detect === 'function' ? await detect() : '';
    return detected || declared || '';
  }

  root.SpeechLang = { SPEECH_REGION, CJK_SCRIPT, scriptOf, resolveSpeechLang, resolveSpokenLang };
})(globalThis);
