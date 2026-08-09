// AI Translator — choosing the language and the voice a read-aloud button
// speaks with.
//
// Three questions, all easy to get wrong, all pure, so they live here where
// `npm run test:unit` can exercise them against a synthetic voice list rather
// than against whichever voices the machine running the tests happens to have.
//
//   1. What language is this text actually in?   resolveSpokenLang()
//   2. What tag will an installed voice answer to? resolveSpeechLang()
//   3. Which of the voices answering should speak? pickVoice()
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
// Question 3 is why a correct tag still came out hoarse. When `utterance.voice`
// is unset, Chrome takes the FIRST voice in its list that matches the tag, not
// the language's flagship — and macOS enumerates voices alphabetically, so
// `en-US` lands on Albert, a croaking novelty voice, with Samantha at 131.
// Japanese lands on Eddy, an Eloquence robot, with Kyoko behind it. The tag
// fix moved the failure from "wrong language" to "right language, joke voice".
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
   * The widened tag is only half the answer: left to match it alone, Chrome
   * takes the first listed voice for the tag, which on macOS is a novelty.
   * pickVoice() below chooses the voice that actually speaks; this keeps
   * choosing the tag, which is also the fallback when pickVoice has no list
   * to rank yet.
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

  // macOS ships two families of deliberately unnatural voices in the same list
  // as the real ones, and on a machine with nothing else installed they are
  // what alphabetical order serves first.
  //
  // The novelty voices are sound-effect jokes — Albert is a hoarse croak,
  // Bells sings, Whisper whispers. Kathy, Fred, Junior and Ralph are their
  // 1980s-era siblings. None of them should ever read a translation while any
  // natural voice for the language is installed.
  const NOVELTY_VOICES = new Set([
    'Albert', 'Bad News', 'Bahh', 'Bells', 'Boing', 'Bubbles', 'Cellos',
    'Fred', 'Good News', 'Jester', 'Junior', 'Kathy', 'Organ', 'Ralph',
    'Superstar', 'Trinoids', 'Whisper', 'Wobble', 'Zarvox',
  ]);
  // The Eloquence voices are intelligible but robotic — kept by Apple for
  // screen-reader users who prefer them. Each name repeats across every
  // language with a localized parenthetical ("Eddy (英语（美国）)"), which is
  // why matching is on the family name before the parenthesis.
  const ELOQUENCE_VOICES = new Set([
    'Eddy', 'Flo', 'Grandma', 'Grandpa', 'Reed', 'Rocko', 'Sandy', 'Shelley',
  ]);

  /** 2 a natural voice, 1 an Eloquence robot, 0 a novelty joke. */
  function voiceTier(voice) {
    // The parenthetical's inner pair is localized (fullwidth on a Chinese
    // system), and nothing promises the outer pair never will be — an Eddy
    // missed here would rank as natural and out-order the real voices.
    const family = String(voice?.name || '').split(/\s*[（(]/)[0].trim();
    if (NOVELTY_VOICES.has(family)) return 0;
    if (ELOQUENCE_VOICES.has(family)) return 1;
    return 2;
  }

  /**
   * The voice that should read text in `lang`, or null to leave the choice to
   * the engine (no list yet, or nothing installed for the language).
   *
   * Ranking: natural beats Eloquence beats novelty; within a tier the system
   * default voice wins, then list order — which is how ties were broken before
   * this function existed, minus the joke voices that made ties dangerous.
   *
   * @param {string} lang
   * @param {Array<{name: string, lang: string, default?: boolean}>} voices
   */
  function pickVoice(lang, voices) {
    const list = Array.isArray(voices) ? voices : [];
    const tag = resolveSpeechLang(lang, list);
    if (!tag || !list.length) return null;

    const canon = (value) => String(value || '').replace('_', '-').toLowerCase();
    let candidates = list.filter((voice) => canon(voice?.lang) === canon(tag));
    if (!candidates.length) {
      // Belt and braces: resolveSpeechLang only hands back a tag no voice
      // answers to when no voice shares its base either, so this filter
      // should never fire — but a same-base voice still beats returning null.
      candidates = list.filter((voice) => baseOf(voice?.lang) === baseOf(tag));
    }

    let best = null;
    let bestScore = -1;
    for (const voice of candidates) {
      const score = voiceTier(voice) * 2 + (voice?.default ? 1 : 0);
      if (score > bestScore) {
        best = voice;
        bestScore = score;
      }
    }
    return best;
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

  root.SpeechLang = { SPEECH_REGION, CJK_SCRIPT, scriptOf, resolveSpeechLang, resolveSpokenLang, pickVoice };
})(globalThis);
