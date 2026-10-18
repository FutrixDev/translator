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
//   Japanese page is not the Chinese word). Latin text follows the page
//   language, or for the input box (standalone) the standalone rules of
//   content/engine/languages.js: a language with a pack is that pack; a
//   Latin-script language without one is no pack at all (burro on an Italian
//   page goes to the model, not to the English pack); no reading, or a
//   language written in another script, is tried as English.
// - One storage read fetches the pack list and every candidate key; a word
//   found only in the form table (`~form` -> {h}) costs one more read.
// - A pair absent from `dict:packs` (the only sign a pack is fully seeded)
//   answers null and asks the worker, once per pair per page, to fetch the
//   pack if the manifest has it (DICT_PACK_WANT). The caller takes its usual
//   path meanwhile. A pair the reader deleted (`dict:declined`) is not asked
//   for: only the settings card downloads it again (D-609).
//
// ctx.dictRoute(text, targetLang, { pinned, provenWord, standalone }) is the
// one routing rule the selection card and the input box share (design §5.2,
// D-641): the local answer, and the mode of the request that goes out when
// there is none. A lookup no engine was pinned for goes to ctx.dictLookup
// first, and only a miss goes on to ctx.requestTranslation.
(function() {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT;
  if (!ctx) return;

  const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;
  const HANGUL = /\p{Script=Hangul}/u;
  const HAN = /\p{Script=Han}/u;
  const CYRILLIC = /\p{Script=Cyrillic}/u;
  const LATIN = /\p{Script=Latin}/u;
  // Latin text with no reading is tried as English only: trying more packs
  // turns "pie" into Spanish.
  async function latinSource(text, standalone) {
    const { DictPack, LangTags } = globalThis;
    const eng = ctx.engine;
    const lang = standalone
      ? await eng.resolveSourceLang(text, '', true)
      : eng.toApiLang(await eng.pageSourceLang());
    // A reading in another script (a Chinese or Japanese page) says nothing
    // about a Latin word.
    if (!lang || !LangTags.langFitsText(lang, text)) return 'en';
    return DictPack.isPackLang(lang) ? lang : '';
  }

  // The page's own language decides Han in a selection: kanji alone on a
  // Japanese page are Japanese words.
  async function hanSource(standalone) {
    if (standalone) return 'zh-CN';
    const eng = ctx.engine;
    return eng.toApiLang(await eng.pageSourceLang()) === 'ja' ? 'ja' : 'zh-CN';
  }

  // The source pack's language, '' when no pack holds this text.
  async function sourceOf(text, standalone) {
    if (KANA.test(text)) return 'ja';
    if (HANGUL.test(text)) return 'ko';
    if (HAN.test(text)) return hanSource(standalone);
    if (CYRILLIC.test(text)) return 'ru';
    if (LATIN.test(text)) return latinSource(text, standalone);
    return '';
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

  /**
   * @param {string} text the selected or typed text
   * @param {string} targetLang an extension language code (zh-CN, en, ...)
   * @param {{standalone?: boolean}} [options] true for the input box, whose
   *   text is not the page's
   * @returns {Promise<object|null>} DictPack.toResponse()'s answer, or null
   */
  ctx.dictLookup = async function(text, targetLang, { standalone = false } = {}) {
    const { DictPack, DictEntry, LangTags } = globalThis;
    if (!ctx.settings.offlineDictionary || !DictEntry.isDictCandidate(text)) return null;
    if (!DictPack.isPackLang(targetLang)) return null;
    const word = String(text).trim();
    const src = await sourceOf(word, standalone);
    // zh-CN and zh-TW share a base: that is script conversion, not a lookup,
    // and no pack exists for it.
    if (!src || LangTags.getLangBase(src) === LangTags.getLangBase(targetLang)) return null;

    const candidates = DictPack.foldCandidates(word, src);
    const entryKeys = candidates.map((c) => DictPack.entryKey(src, targetLang, c));
    const formKeys = candidates.map((c) => DictPack.formKey(src, targetLang, c));
    const found = await chrome.storage.local.get([
      DictPack.PACKS_KEY, DictPack.DECLINED_KEY, ...entryKeys, ...formKeys,
    ]);
    const pair = DictPack.pairOf(src, targetLang);
    const meta = (found[DictPack.PACKS_KEY] || {})[pair];
    if (!meta) {
      if (!(found[DictPack.DECLINED_KEY] || []).includes(pair)) wantPack(src, targetLang);
      return null;
    }

    const entry = entryKeys.map((key) => found[key]).find(Boolean);
    if (entry) return DictPack.toResponse(meta, entry, targetLang);
    const pointer = formKeys.map((key) => found[key]).find(Boolean);
    if (!pointer) return null;
    const headKey = DictPack.entryKey(src, targetLang, pointer.h);
    const head = (await chrome.storage.local.get(headKey))[headKey];
    // A pack's form table points only at its own heads (parsePack), so a
    // missing head means a new version began replacing this one between the
    // two reads: there is no answer to give yet.
    return head ? DictPack.toResponse(meta, head, targetLang) : null;
  };

  /**
   * The local answer to a lookup, and the mode of the request that goes to an
   * engine when there is none. A request pinned to an engine (the card's
   * "explain in context with AI", the dialog's "use AI") never takes the local
   * answer; everything else is decided by ctx.dictLookup (a word at all, by
   * DictEntry.isDictCandidate; the switch; the pack; the hit).
   *
   * The mode is 'word' when the pack answered (a hit proves a word, D-609),
   * when the caller says the pack already proved this text a word
   * (`provenWord`: the card that settled with the pack's answer, asked again
   * pinned to a model), and otherwise as DictEntry.isLookup says. A miss says
   * nothing, so the caller's path is today's.
   *
   * @param {string} text
   * @param {string} targetLang
   * @param {{pinned?: string, provenWord?: boolean, standalone?: boolean}} [options]
   * @returns {Promise<{local: (object|null), mode: ('word'|'text')}>}
   */
  ctx.dictRoute = async function(text, targetLang, { pinned = '', provenWord = false, standalone = false } = {}) {
    const local = pinned ? null : await ctx.dictLookup(text, targetLang, { standalone });
    const word = !!local || provenWord || globalThis.DictEntry.isLookup(text);
    return { local, mode: word ? 'word' : 'text' };
  };
})();
