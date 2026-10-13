// Blab Translation — offline dictionary packs: the storage layout, the check
// on a downloaded pack, how it is cut into writes, and how a stored record
// becomes a dictionary answer (D-561, D-566).
//
// A pack is one JSON object (contract: docs/delivery/taskbooks/
// offline-dict-common.md, "词典包 v1"). It is downloaded once by the service
// worker (background/dict-packs.js), checked by parsePack(), and written to
// chrome.storage.local one key per head, so a lookup reads only the keys it
// needs and never wakes the service worker (content/content-dict-lookup.js):
//
//   d:<src>-<tgt>:<head>    {e, x?, m?}   the head's records, examples, forms
//   d:<src>-<tgt>:~<form>   {h}           an inflected form's head
//   dict:packs              {<src>-<tgt>: {src, tgt, ver, sha256, heads,
//                            bytes, rawBytes, sources, credits}}
//   dict:status             {<src>-<tgt>: {state, ver, reason}}
//
// The `dict:packs` item is written last and is the only mark that a pack is
// seeded: a lookup trusts no `d:` key of a pair that is not listed there.
// `dict:status` is what the settings page shows while a pack downloads or
// after it failed; it never decides whether a pack is usable.
//
// Folding at lookup time is only what foldCandidates() does: exact, lower
// case, NFKC, and the one runtime rule, the Korean particle strip. Every other
// reduction — inflections, Traditional to Simplified — is in the pack's `f`
// table, made at build time (D-578).
//
// Dual-mode classic script: the service worker imports it, the content scripts
// and the settings page load it as a script, all read globalThis.DictPack.
// parsePack() and toResponse() read globalThis.DictEntry when they run, so the
// load order between the two files does not matter.
(function (root) {
  'use strict';

  const PACKS_KEY = 'dict:packs';
  const STATUS_KEY = 'dict:status';
  const DOWNLOAD_ORIGIN = 'https://dl.blab-translation.com/';
  const MANIFEST_URL = `${DOWNLOAD_ORIGIN}dict/v1/manifest.json`;
  const CHUNK_KEYS = 5000;
  const LANGS = Object.freeze(['zh-CN', 'zh-TW', 'en', 'ja', 'ko', 'es', 'fr', 'de', 'pt', 'ru']);
  const MAX_RECORDS = 6;
  const MAX_GLOSSES = 4;
  const MAX_EXAMPLES = 2;
  const MAX_FORMS = 8;
  const FORM_MARK = '~';

  // ---- keys -------------------------------------------------------------------

  const pairOf = (src, tgt) => `${src}-${tgt}`;
  const prefixOf = (src, tgt) => `d:${pairOf(src, tgt)}:`;
  const entryKey = (src, tgt, head) => `${prefixOf(src, tgt)}${head}`;
  const formKey = (src, tgt, form) => `${prefixOf(src, tgt)}${FORM_MARK}${form}`;

  // ---- the check on a pack ----------------------------------------------------

  function fail(path, why) {
    return new Error(`dictionary pack: ${path} ${why}`);
  }

  const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const isText = (value) => typeof value === 'string' && value.length > 0;

  function needObject(value, path) {
    if (!isObject(value)) throw fail(path, 'is not an object');
    return value;
  }

  function needText(value, path) {
    if (!isText(value)) throw fail(path, 'is not a non-empty string');
    return value;
  }

  function needList(value, path, min, max) {
    if (!Array.isArray(value)) throw fail(path, 'is not an array');
    if (value.length < min || value.length > max) throw fail(path, `has ${value.length} items, not ${min}–${max}`);
    return value;
  }

  // A Tatoeba sentence id: a positive integer, or null for a kaikki example.
  function needSentenceId(value, path) {
    if (value === null) return;
    if (!Number.isInteger(value) || value <= 0) throw fail(path, 'is not a sentence id or null');
  }

  function needCredit(value, path) {
    needObject(value, path);
    needText(value.label, `${path}.label`);
    needText(value.href, `${path}.href`);
  }

  function checkRecords(e, sourceIds) {
    let jmdict = false;
    for (const [head, records] of Object.entries(e)) {
      const path = `e[${JSON.stringify(head)}]`;
      if (!head) throw fail(path, 'is an empty head');
      // A head written as a form key would be read back as a form pointer.
      if (head.startsWith(FORM_MARK)) throw fail(path, `starts with "${FORM_MARK}", the form-key mark`);
      needList(records, path, 1, MAX_RECORDS);
      records.forEach((record, i) => {
        const at = `${path}[${i}]`;
        needList(record, at, 4, 4);
        const [pos, glosses, reading, origin] = record;
        if (typeof pos !== 'string') throw fail(`${at}[0]`, 'is not a string');
        needList(glosses, `${at}[1]`, 1, MAX_GLOSSES);
        glosses.forEach((gloss, g) => {
          if (typeof gloss !== 'string') throw fail(`${at}[1][${g}]`, 'is not a string');
          // The first gloss becomes the answer's translation, and the entry
          // refuses a translation longer than this rather than cut it.
          if (gloss.length > root.DictEntry.MAX_TEXT) throw fail(`${at}[1][${g}]`, `is over ${root.DictEntry.MAX_TEXT} characters`);
        });
        // D-576 N4: a record with no gloss would make an answer with nothing
        // but a credits line. The whole pack is refused, not the record.
        if (!glosses.some(isText)) throw fail(`${at}[1]`, 'has no non-empty gloss');
        if (reading !== null && !isText(reading)) throw fail(`${at}[2]`, 'is not a non-empty string or null');
        if (!sourceIds.has(origin)) throw fail(`${at}[3]`, 'is not an id in sources');
        if (origin === 'jmdict') jmdict = true;
      });
    }
    return jmdict;
  }

  function checkExamples(x, e) {
    let tatoeba = false;
    for (const [head, examples] of Object.entries(x)) {
      const path = `x[${JSON.stringify(head)}]`;
      if (!Object.hasOwn(e, head)) throw fail(path, 'has no head in e');
      needList(examples, path, 1, MAX_EXAMPLES);
      examples.forEach((example, i) => {
        const at = `${path}[${i}]`;
        needList(example, at, 4, 4);
        needText(example[0], `${at}[0]`);
        needText(example[1], `${at}[1]`);
        needSentenceId(example[2], `${at}[2]`);
        needSentenceId(example[3], `${at}[3]`);
        if (example[2] !== null || example[3] !== null) tatoeba = true;
      });
    }
    return tatoeba;
  }

  function checkForms(m, e) {
    for (const [head, forms] of Object.entries(m)) {
      const path = `m[${JSON.stringify(head)}]`;
      if (!Object.hasOwn(e, head)) throw fail(path, 'has no head in e');
      needList(forms, path, 1, MAX_FORMS);
      forms.forEach((form, i) => {
        needList(form, `${path}[${i}]`, 2, 2);
        needText(form[0], `${path}[${i}][0]`);
        needText(form[1], `${path}[${i}][1]`);
      });
    }
  }

  function checkPointers(f, e) {
    for (const [form, head] of Object.entries(f)) {
      const path = `f[${JSON.stringify(form)}]`;
      if (!form) throw fail(path, 'is an empty form');
      if (typeof head !== 'string' || !Object.hasOwn(e, head)) throw fail(path, 'does not name a head in e');
    }
  }

  /**
   * The pack in `text` (the downloaded JSON, already decoded) when it keeps
   * the v1 contract, or a throw naming the first field path that does not.
   * Nothing is repaired or skipped: one bad record refuses the whole pack.
   */
  function parsePack(text) {
    let pack;
    try {
      pack = JSON.parse(text);
    } catch (error) {
      throw fail('(root)', `is not JSON: ${error.message}`);
    }
    needObject(pack, '(root)');
    if (pack.v !== 1) throw fail('v', 'is not 1');
    if (!LANGS.includes(pack.src)) throw fail('src', 'is not a supported language');
    if (!LANGS.includes(pack.tgt)) throw fail('tgt', 'is not a supported language');
    if (pack.src === pack.tgt) throw fail('tgt', 'equals src');
    needText(pack.ver, 'ver');
    needText(pack.lic, 'lic');
    const sourceIds = new Set();
    needList(pack.sources, 'sources', 1, Infinity).forEach((source, i) => {
      needObject(source, `sources[${i}]`);
      for (const key of ['id', 'name', 'license', 'url']) needText(source[key], `sources[${i}].${key}`);
      sourceIds.add(source.id);
    });
    needObject(pack.credits, 'credits');
    for (const [key, credit] of Object.entries(pack.credits)) {
      if (key !== 'jmdict' && key !== 'tatoeba') throw fail(`credits.${key}`, 'is not jmdict or tatoeba');
      needCredit(credit, `credits.${key}`);
    }
    const e = needObject(pack.e, 'e');
    if (!Object.keys(e).length) throw fail('e', 'has no heads');
    const usesJmdict = checkRecords(e, sourceIds);
    const usesTatoeba = checkExamples(needObject(pack.x, 'x'), e);
    checkForms(needObject(pack.m, 'm'), e);
    checkPointers(needObject(pack.f, 'f'), e);
    if (usesJmdict && !pack.credits.jmdict) throw fail('credits.jmdict', 'is missing for jmdict records');
    if (usesTatoeba && !pack.credits.tatoeba) throw fail('credits.tatoeba', 'is missing for Tatoeba examples');
    return pack;
  }

  // ---- seeding ----------------------------------------------------------------

  /**
   * The pack's storage writes, CHUNK_KEYS keys at a time: every head first,
   * then every form pointer. The `dict:packs` item is not among them — the
   * caller writes it after the last chunk (see the top of this file).
   */
  function* seedChunks(pack) {
    const { src, tgt } = pack;
    let chunk = {};
    let size = 0;
    function* put(key, value) {
      chunk[key] = value;
      size += 1;
      if (size === CHUNK_KEYS) {
        yield chunk;
        chunk = {};
        size = 0;
      }
    }
    for (const [head, records] of Object.entries(pack.e)) {
      const value = { e: records };
      if (Object.hasOwn(pack.x, head)) value.x = pack.x[head];
      if (Object.hasOwn(pack.m, head)) value.m = pack.m[head];
      yield* put(entryKey(src, tgt, head), value);
    }
    for (const [form, head] of Object.entries(pack.f)) {
      yield* put(formKey(src, tgt, form), { h: head });
    }
    if (size) yield chunk;
  }

  /** What `dict:packs` keeps about a seeded pack (`download` is its manifest row). */
  function listItem(pack, download) {
    return {
      src: pack.src,
      tgt: pack.tgt,
      ver: pack.ver,
      sha256: download.sha256,
      heads: Object.keys(pack.e).length,
      bytes: download.bytes,
      rawBytes: download.rawBytes,
      sources: pack.sources,
      credits: pack.credits,
    };
  }

  // ---- lookup -----------------------------------------------------------------

  // The Korean particles a looked-up word may carry (D-578: the one fold made
  // at lookup time). Longest first, so 에서 is tried before 에 and 으로 before 로.
  const KO_PARTICLES = Object.freeze([
    '은', '는', '이', '가', '을', '를', '에', '에서', '에게', '한테', '께서', '의', '와', '과', '도',
    '로', '으로', '만', '부터', '까지', '보다', '처럼', '이나', '나', '랑', '이랑',
  ].sort((a, b) => b.length - a.length));

  function stripParticle(word) {
    const particle = KO_PARTICLES.find((p) => word.endsWith(p));
    if (!particle) return '';
    const stem = word.slice(0, -particle.length);
    return Array.from(stem).length >= 1 ? stem : '';
  }

  // DictEntry.isLookup drops one sentence stop at the very end ("apple." and
  // "run?" are lookups, D-542), so the word is tried both with it ("etc." is a
  // head of its own) and without it.
  const TRAILING_STOP = /[.!?。！？]$/u;

  /**
   * The spellings to look `text` up under, in order: as written, lower case,
   * NFKC (full-width to half-width), then the same three with one trailing
   * sentence stop dropped, and for Korean the word with one particle
   * stripped. No duplicates, no empty strings.
   */
  function foldCandidates(text, src) {
    const exact = String(text == null ? '' : text).trim();
    const word = exact.replace(TRAILING_STOP, '').trimEnd();
    const out = [];
    for (const spelling of [exact, word]) {
      const nfkc = spelling.normalize('NFKC');
      out.push(spelling, spelling.toLowerCase(), nfkc, nfkc.toLowerCase());
    }
    if (src === 'ko') out.push(stripParticle(word.normalize('NFKC')));
    return [...new Set(out.filter(Boolean))];
  }

  const nonEmpty = (value) => typeof value === 'string' && value.length > 0;
  const isEnglish = (lang) => String(lang || '').toLowerCase().split('-')[0] === 'en';

  // The translation's pronunciation (D-487): an English target has a UK and a
  // US reading, "/UK/|/US/", either side possibly empty; any other target has
  // one, unlabelled. A pack writes null when it has none, never a guess.
  function phoneticsOf(reading, targetLang) {
    if (reading === null) return [];
    if (!isEnglish(targetLang)) return [{ label: '', ipa: reading }];
    const [uk = '', us = ''] = reading.split('|');
    return [{ label: 'UK', ipa: uk }, { label: 'US', ipa: us }].filter((item) => item.ipa);
  }

  /**
   * A stored head (`record`, the value under its entry key) as a dictionary
   * answer: `{translation, entry, credits, engine}`, the shape
   * DictEntry.entryFor('word', …) accepts. `meta` is the pack's `dict:packs`
   * item. The card credits only what this entry shows: JMdict when a record
   * came from it, Tatoeba when a shown example is a Tatoeba pair.
   */
  function toResponse(meta, record, targetLang) {
    const records = record.e;
    const examples = record.x || [];
    const translation = records[0][1].find(nonEmpty);
    const credits = [];
    if (records.some((r) => r[3] === 'jmdict')) credits.push(meta.credits.jmdict);
    if (examples.some((x) => x[2] !== null || x[3] !== null)) credits.push(meta.credits.tatoeba);
    return {
      translation,
      entry: {
        translation,
        phonetics: phoneticsOf(records[0][2], targetLang),
        senses: records.map(([pos, glosses]) => ({ pos, defs: glosses.filter(nonEmpty) })),
        examples: examples.map(([source, target]) => ({ source, target })),
        forms: (record.m || []).map(([label, value]) => ({ label, value })),
      },
      credits,
      engine: root.DictEntry.DICT_ENGINE,
    };
  }

  root.DictPack = Object.freeze({
    PACKS_KEY,
    STATUS_KEY,
    DOWNLOAD_ORIGIN,
    MANIFEST_URL,
    CHUNK_KEYS,
    LANGS,
    KO_PARTICLES,
    pairOf,
    prefixOf,
    entryKey,
    formKey,
    parsePack,
    seedChunks,
    listItem,
    foldCandidates,
    toResponse,
  });
})(globalThis);
