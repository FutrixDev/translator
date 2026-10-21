// Blab Translation offline dictionary lookup
//
// ctx.dictLookup(text, targetLang, { standalone }) answers a looked-up word
// from a seeded dictionary pack, or null. It reads chrome.storage.local
// directly and never wakes the service worker: a stopped worker costs ~100 ms
// to start, a storage read under a millisecond (design §4.3).
//
// - It looks up only what DictEntry.isDictCandidate() lets through (every
//   isLookup() lookup, plus short kanji-and-kana words such as 食べました,
//   D-609), and only while the offlineDictionary switch is on.
// - The source language follows design §3.4 as revised by D-686: the script
//   decides first (kana ja, hangul ko, Cyrillic ru). Han without kana is
//   zh-CN, except in a selection on a Japanese page, where it is ja (先生 on a
//   Japanese page is not the Chinese word); the input box (standalone) has no
//   page, so Han there is zh-CN. Latin text in a selection follows the page;
//   typed Latin text is the detector's reliable reading
//   (engine.detectStandaloneLang), else the page language. A language with a
//   pack is that pack; a Latin-script language without one is no pack at all
//   (burro on an Italian page goes to the model, not to the English pack); no
//   reading, or a language written in another script, is tried as English.
// - It also says which prompt a model lookup of the word takes
//   (DictEntry.WORD_LANGS): `target` when the word is proven to be in the
//   target language (a script that pins it, or a hit in a seeded pack whose
//   source is the target language), `other` when it is proven not to be (a
//   script the target is not written in or that pins another language, or a
//   reliable reading of another language), and `unknown` otherwise. The page
//   language and the English last resort are guesses for the pack, never
//   proof. A word selected on a page in another language that fits it is not
//   proven the target's by the target's packs either (Gift on a German page,
//   target en): it is `unknown`, and the model decides.
// - One storage read fetches the pack list and every candidate key, the proof
//   keys included; a word found only in the form table (`~form` -> {h}) costs
//   one more read.
// - A pair absent from `dict:packs` (the only sign a pack is fully seeded)
//   answers null and asks the worker, once per pair per page, to fetch the
//   pack if the manifest has it (DICT_PACK_WANT). The caller takes its usual
//   path meanwhile. A pair the reader deleted (`dict:declined`) is not asked
//   for: only the settings card downloads it again (D-609).
//
// ctx.dictRoute(text, targetLang, { pinned, provenWord, standalone }) is the
// one routing rule the selection card and the input box share (design §5.2,
// D-641): the local answer, and the fields of the request that goes out when
// there is none. A lookup no engine was pinned for goes to
// ctx.dictLookup first, and only a miss goes on to ctx.requestTranslation; a
// pinned one reads only what its verdict needs (wordLangOf).
(function() {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT;
  if (!ctx) return;

  const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;
  const HANGUL = /\p{Script=Hangul}/u;
  const HAN = /\p{Script=Han}/u;
  const CYRILLIC = /\p{Script=Cyrillic}/u;
  const LATIN = /\p{Script=Latin}/u;

  /**
   * What language a looked-up word is in: `{ lang, by, page }`. `lang` is the
   * language a pack lookup tries. `by` says what it rests on: 'script' when the
   * script pins it (kana, hangul, and Han outside a Japanese page),
   * 'detected' when the detector read typed text reliably, null when it is
   * only the pack rules' guess (the page language, or English as the last
   * resort), which says nothing about the word itself. `page` is true when
   * `lang` is the language of the page the word was selected on, a language
   * the word can be written in. The one detection a lookup makes is here.
   */
  async function readingOf(word, standalone) {
    const { LangTags } = globalThis;
    const eng = ctx.engine;
    if (KANA.test(word)) return { lang: 'ja', by: 'script' };
    if (HANGUL.test(word)) return { lang: 'ko', by: 'script' };
    if (HAN.test(word)) {
      // Kanji alone on a Japanese page are tried as Japanese words, but they
      // are Chinese characters too, so that is a guess.
      if (standalone) return { lang: 'zh-CN', by: 'script' };
      const japanesePage = eng.toApiLang(await eng.pageSourceLang()) === 'ja';
      return japanesePage ? { lang: 'ja', by: null, page: true } : { lang: 'zh-CN', by: 'script' };
    }
    // Ukrainian, Bulgarian and Serbian are Cyrillic too.
    if (CYRILLIC.test(word)) return { lang: 'ru', by: null };
    if (!LATIN.test(word)) return { lang: '', by: null };
    // A reading in another script (a Chinese or Japanese page, or the detector
    // reading pinyin as zh) says nothing about a Latin word.
    const fits = (lang) => !!lang && LangTags.langFitsText(lang, word);
    if (standalone) {
      const detected = eng.toApiLang(await eng.detectStandaloneLang(word));
      if (fits(detected)) return { lang: detected, by: 'detected' };
    }
    const page = eng.toApiLang(await eng.pageSourceLang());
    if (!fits(page)) return { lang: 'en', by: null };
    // Typed text that falls back to the page language is not the page's text.
    return { lang: page, by: null, page: !standalone };
  }

  // Pairs this page has already asked the worker for.
  const wanted = new Set();

  function wantPack(src, tgt) {
    const pair = globalThis.DictPack.pairOf(src, tgt);
    if (wanted.has(pair)) return;
    wanted.add(pair);
    // A side request: the lookup has already answered null, so a refusal here
    // is logged, not thrown.
    chrome.runtime.sendMessage({ type: 'DICT_PACK_WANT', src, tgt }).catch((error) => {
      console.warn('[Blab Translation] DICT_PACK_WANT failed', pair, error);
    });
  }

  // The entry and form keys of one pair for every fold of the word.
  function pairKeys(word, src, tgt) {
    const { DictPack } = globalThis;
    const candidates = DictPack.foldCandidates(word, src);
    return {
      src, tgt, pair: DictPack.pairOf(src, tgt),
      entries: candidates.map((c) => DictPack.entryKey(src, tgt, c)),
      forms: candidates.map((c) => DictPack.formKey(src, tgt, c)),
    };
  }

  // Every seeded pair whose source is the target language: a word found in one
  // of them is a word of that language, whatever the page around it says.
  function proofPairs(word, targetLang) {
    const { DictPack, LangTags } = globalThis;
    const base = LangTags.getLangBase;
    const sources = DictPack.LANGS.filter((src) => base(src) === base(targetLang));
    return sources.flatMap((src) => DictPack.LANGS
      .filter((tgt) => base(tgt) !== base(src))
      .map((tgt) => pairKeys(word, src, tgt)));
  }

  /**
   * What a lookup of `word` would read: the pack pair it is looked up in
   * (`lookup`, or null) and the pairs that could prove it a word of the target
   * language (`proof`). Builds keys only, reads nothing.
   *
   * The target language's packs prove a word only when nothing says it is
   * another language's: a word selected on a page whose language fits it and
   * is not the target's (Gift on a German page, target en) is that page's
   * word as much as the target's, and the en pack holding "gift" cannot tell
   * the two apart. The model decides that one (UNKNOWN), so its proof keys are
   * not even built.
   */
  function lookupPlan(word, targetLang, reading) {
    const { DictPack, LangTags } = globalThis;
    const base = LangTags.getLangBase;
    const on = !!ctx.settings.offlineDictionary;
    // A word the target language cannot even be written in is not that
    // language's, and a script that pins the target's own language is.
    const fits = LangTags.langFitsText(targetLang, word);
    const scriptSame = reading.by === 'script' && base(reading.lang) === base(targetLang);
    const pageOther = !!reading.page && base(reading.lang) !== base(targetLang);
    const proof = on && fits && !scriptSame && !pageOther ? proofPairs(word, targetLang) : [];
    // zh-CN and zh-TW share a base: that is script conversion, not a lookup,
    // and no pack exists for it.
    const src = DictPack.isPackLang(reading.lang) ? reading.lang : '';
    const lookup = on && src && DictPack.isPackLang(targetLang) && base(src) !== base(targetLang)
      ? pairKeys(word, src, targetLang) : null;
    return { fits, scriptSame, proof, lookup };
  }

  /**
   * The verdict (DictEntry.WORD_LANGS) from what is known: whether the target
   * language can write the word, whether a script pins it to the target's
   * language, whether the word is in a seeded pack of the target language
   * (`proven`), and the reading. Same language needs proof: the script, or
   * the pack. Another language needs proof too: the script, or a reliable
   * reading of typed text. Anything else is the model's call.
   */
  function classify({ fits, scriptSame, proven, reading, targetLang }) {
    const { WORD_LANGS } = globalThis.DictEntry;
    const base = globalThis.LangTags.getLangBase;
    if (!fits) return WORD_LANGS.OTHER;
    if (scriptSame || proven) return WORD_LANGS.TARGET;
    if (reading.by && base(reading.lang) !== base(targetLang)) return WORD_LANGS.OTHER;
    return WORD_LANGS.UNKNOWN;
  }

  // One storage read for these pairs' keys and the pack list (and the declined
  // list when a lookup pair needs it); none when there are no pairs.
  async function readPairs(groups, { declined }) {
    const { DictPack } = globalThis;
    if (!groups.length) return {};
    return chrome.storage.local.get([
      DictPack.PACKS_KEY, ...(declined ? [DictPack.DECLINED_KEY] : []),
      ...groups.flatMap((g) => [...g.entries, ...g.forms]),
    ]);
  }

  // Whether any proof pair is listed (fully seeded) and holds the word.
  function provenBy(proof, found) {
    const packs = found[globalThis.DictPack.PACKS_KEY] || {};
    return proof.some((g) => !!packs[g.pair] && [...g.entries, ...g.forms].some((key) => found[key]));
  }

  /**
   * The verdict alone, for a request pinned to an engine: it reads the proof
   * keys only, never the lookup pair's entries or forms, and never asks the
   * worker for a pack (DICT_PACK_WANT).
   *
   * @returns {Promise<string|null>} a DictEntry.WORD_LANGS value, null for text
   *   that is no dictionary candidate
   */
  async function wordLangOf(text, targetLang, { standalone = false } = {}) {
    if (!globalThis.DictEntry.isDictCandidate(text)) return null;
    const word = String(text).trim();
    const reading = await readingOf(word, standalone);
    const { fits, scriptSame, proof } = lookupPlan(word, targetLang, reading);
    const found = await readPairs(proof, { declined: false });
    return classify({ fits, scriptSame, proven: provenBy(proof, found), reading, targetLang });
  }

  /**
   * @param {string} text the selected or typed text
   * @param {string} targetLang an extension language code (zh-CN, en, ...)
   * @param {{standalone?: boolean}} [options] true for the input box, whose
   *   text is not the page's
   * @returns {Promise<{answer: (object|null), wordLang: (string|null)}>}
   *   `answer` is DictPack.toResponse()'s answer or null; `wordLang`, a value
   *   of DictEntry.WORD_LANGS, says which prompt a model lookup of this word
   *   takes (null for text that is no dictionary candidate)
   */
  ctx.dictLookup = async function(text, targetLang, { standalone = false } = {}) {
    if (!globalThis.DictEntry.isDictCandidate(text)) return { answer: null, wordLang: null };
    const word = String(text).trim();
    const reading = await readingOf(word, standalone);
    const { fits, scriptSame, proof, lookup } = lookupPlan(word, targetLang, reading);
    const found = await readPairs(lookup ? [lookup, ...proof] : proof, { declined: !!lookup });
    const wordLang = classify({ fits, scriptSame, proven: provenBy(proof, found), reading, targetLang });
    return { answer: lookup ? await packAnswer(lookup, found) : null, wordLang };
  };

  // The lookup pair's answer out of the first read, or null.
  async function packAnswer(lookup, found) {
    const { DictPack } = globalThis;
    const meta = (found[DictPack.PACKS_KEY] || {})[lookup.pair];
    if (!meta) {
      if (!(found[DictPack.DECLINED_KEY] || []).includes(lookup.pair)) wantPack(lookup.src, lookup.tgt);
      return null;
    }
    const entry = lookup.entries.map((key) => found[key]).find(Boolean);
    if (entry) return DictPack.toResponse(meta, entry, lookup.tgt);
    const pointer = lookup.forms.map((key) => found[key]).find(Boolean);
    if (!pointer) return null;
    const headKey = DictPack.entryKey(lookup.src, lookup.tgt, pointer.h);
    const head = (await chrome.storage.local.get(headKey))[headKey];
    // A pack's form table points only at its own heads (parsePack), so a
    // missing head means a new version began replacing this one between the
    // two reads: there is no answer to give yet.
    return head ? DictPack.toResponse(meta, head, lookup.tgt) : null;
  }

  /**
   * The local answer to a lookup, and the fields of the request that goes to
   * an engine when there is none. A request pinned to an engine (the card's
   * "explain in context with AI", the dialog's "use AI") never takes the local
   * answer, so it never reads the pack's entries nor asks for a missing pack:
   * only the verdict (wordLangOf). Everything else is decided by
   * ctx.dictLookup (a word at all, by DictEntry.isDictCandidate; the switch;
   * the pack; the hit).
   *
   * The mode is 'word' when the pack answered (a hit proves a word, D-609),
   * when the caller says the pack already proved this text a word
   * (`provenWord`: the card that settled with the pack's answer, asked again
   * pinned to a model), and otherwise as DictEntry.isLookup says. A miss says
   * nothing, so the caller's path is today's.
   *
   * A word also carries `wordLang` (the verdict), which picks the service
   * worker's prompt: monolingual for a word proven to be in the target
   * language, bilingual for one proven to be in another, and for the rest one
   * prompt that lets the model decide and say which entry it wrote
   * (background/ai-translate.js, DictEntry.fromModelText).
   *
   * @param {string} text
   * @param {string} targetLang
   * @param {{pinned?: string, provenWord?: boolean, standalone?: boolean}} [options]
   * @returns {Promise<{local: (object|null), request: {mode: ('word'|'text'), wordLang?: string}}>}
   */
  ctx.dictRoute = async function(text, targetLang, { pinned = '', provenWord = false, standalone = false } = {}) {
    let local = null;
    let wordLang;
    if (pinned) {
      if (!provenWord && !globalThis.DictEntry.isLookup(text)) return { local: null, request: { mode: 'text' } };
      wordLang = await wordLangOf(text, targetLang, { standalone });
    } else {
      ({ answer: local, wordLang } = await ctx.dictLookup(text, targetLang, { standalone }));
      if (!local && !provenWord && !globalThis.DictEntry.isLookup(text)) {
        return { local: null, request: { mode: 'text' } };
      }
    }
    if (!wordLang) throw new Error('dictRoute: a word with no dictionary reading');
    return { local, request: { mode: 'word', wordLang } };
  };
})();
