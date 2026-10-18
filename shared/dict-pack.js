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
//   dict:packs              {<src>-<tgt>: {src, tgt, ver, url, sha256, heads,
//                            bytes, rawBytes, lic, sources, credits}}
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
// foldCandidates() and toResponse() read globalThis.DictEntry, and toResponse()
// globalThis.LangTags, when they run, so the load order between the files does
// not matter. parsePack() reads neither: it is the only check on a pack.
(function (root) {
  'use strict';

  const PACKS_KEY = 'dict:packs';
  const STATUS_KEY = 'dict:status';
  // The pairs the reader deleted: they are not fetched again until the reader
  // asks for them on the settings card (D-609).
  const DECLINED_KEY = 'dict:declined';
  const DOWNLOAD_ORIGIN = 'https://dl.blab-translation.com/';
  const MANIFEST_URL = `${DOWNLOAD_ORIGIN}dict/v1/manifest.json`;
  const CHUNK_KEYS = 5000;
  const LANGS = Object.freeze(['zh-CN', 'zh-TW', 'en', 'ja', 'ko', 'es', 'fr', 'de', 'pt', 'ru']);
  const FORM_MARK = '~';

  // The credits a pack may carry, by id, and the one host each may link to.
  // The card draws them as <a href> beside the entry (JMdict and Tatoeba ask
  // for a credit beside the data; every other source is credited on the
  // settings page). parsePack() is the only check on them (D-686).
  const CREDITS = Object.freeze({ jmdict: 'www.edrdg.org', tatoeba: 'tatoeba.org' });

  // Every size a pack is held to. parsePack() refuses a pack past any of
  // them, and the build's runtime check reads this table (D-686), so a cap is
  // written here and nowhere else.
  const LIMITS = Object.freeze({
    MAX_RECORDS: 6, // records under one head
    MAX_GLOSSES: 4, // glosses in one record
    MAX_EXAMPLES: 2, // examples under one head
    MAX_FORMS: 8, // forms under one head
    // A gloss, an example sentence, a form's value. Equal to DictEntry.MAX_TEXT
    // (a test holds them together): the first gloss is the answer's
    // translation, and the entry refuses a longer one rather than cut it.
    MAX_TEXT: 500,
    MAX_LABEL: 80, // a part of speech, a form's label, a credit's label
    MAX_KEY: 200, // a head or a form, the tail of its storage key
    MAX_SOURCES: 8, // the pack's sources list
    MAX_CREDITS: Object.keys(CREDITS).length, // one per id in CREDITS
  });

  // ---- keys -------------------------------------------------------------------

  const pairOf = (src, tgt) => `${src}-${tgt}`;
  const isPackLang = (lang) => LANGS.includes(lang);
  const notAPair = (pair) => new Error(`dictionary packs: ${pair} is not a language pair`);

  /** The pair's name, when both languages have packs and differ; throws otherwise. */
  function needPair(src, tgt) {
    if (!isPackLang(src) || !isPackLang(tgt) || src === tgt) throw notAPair(pairOf(src, tgt));
    return pairOf(src, tgt);
  }

  // A pair back into its languages. Either side may carry a hyphen (zh-CN -> en,
  // en -> zh-CN), so it is split at a known language code, not at the first
  // hyphen. Anything needPair() would refuse throws.
  function splitPair(pair) {
    const text = String(pair);
    const src = LANGS.find((lang) => text.startsWith(`${lang}-`) && isPackLang(text.slice(lang.length + 1)));
    if (!src) throw notAPair(text);
    const tgt = text.slice(src.length + 1);
    needPair(src, tgt);
    return { src, tgt };
  }
  const prefixOf = (src, tgt) => `d:${pairOf(src, tgt)}:`;
  const entryKey = (src, tgt, head) => `${prefixOf(src, tgt)}${head}`;
  const formKey = (src, tgt, form) => `${prefixOf(src, tgt)}${FORM_MARK}${form}`;

  // ---- the check on a pack ----------------------------------------------------

  function fail(path, why) {
    return new Error(`dictionary pack: ${path} ${why}`);
  }

  const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const isText = (value) => typeof value === 'string' && value.length > 0;
  // A gloss is shown, so one made only of whitespace counts as empty (D-609 N8).
  const hasWords = (value) => typeof value === 'string' && value.trim().length > 0;

  function needObject(value, path) {
    if (!isObject(value)) throw fail(path, 'is not an object');
    return value;
  }

  function needLength(value, path, max) {
    if (value.length > max) throw fail(path, `is over ${max} characters`);
    return value;
  }

  function needText(value, path, max = Infinity) {
    if (!isText(value)) throw fail(path, 'is not a non-empty string');
    return needLength(value, path, max);
  }

  // A link the settings page and the card draw as <a href>: https only, so a
  // pack can never put a javascript: URL on an extension page.
  function needLink(value, path) {
    if (!/^https:\/\/[^\s]+$/.test(needText(value, path))) throw fail(path, 'is not an https URL');
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

  // Characters that take no room on screen: a label made only of these (and
  // spaces) would draw a link nobody can see, so it counts as no label.
  const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF]/g;

  // `href` as the URL parser writes it back, when it is https on `host`
  // exactly (no subdomain, no look-alike) with no user, password or port;
  // '' otherwise.
  function creditHref(href, host) {
    let url;
    try {
      url = new URL(href);
    } catch {
      return '';
    }
    const plain = url.protocol === 'https:' && !url.username && !url.password && !url.port;
    return plain && url.hostname === host ? url.href : '';
  }

  // A credit the card draws as it is: a label that shows something, and an
  // href already in the parser's own spelling (nothing is trimmed or
  // repaired), on the one host its id may link to (D-609 N7).
  function needCredit(id, value, path) {
    if (!Object.hasOwn(CREDITS, id)) throw fail(path, `is not ${Object.keys(CREDITS).join(' or ')}`);
    needObject(value, path);
    const label = needText(value.label, `${path}.label`, LIMITS.MAX_LABEL);
    if (!label.replace(ZERO_WIDTH, '').trim()) throw fail(`${path}.label`, 'has no visible characters');
    const href = needText(value.href, `${path}.href`);
    if (creditHref(href, CREDITS[id]) !== href) throw fail(`${path}.href`, `is not an https URL on ${CREDITS[id]}`);
  }

  function checkRecords(e, sourceIds) {
    let jmdict = false;
    for (const [head, records] of Object.entries(e)) {
      const path = `e[${JSON.stringify(head)}]`;
      needText(head, path, LIMITS.MAX_KEY);
      // A head written as a form key would be read back as a form pointer.
      if (head.startsWith(FORM_MARK)) throw fail(path, `starts with "${FORM_MARK}", the form-key mark`);
      needList(records, path, 1, LIMITS.MAX_RECORDS);
      records.forEach((record, i) => {
        const at = `${path}[${i}]`;
        needList(record, at, 4, 4);
        const [pos, glosses, reading, origin] = record;
        if (typeof pos !== 'string') throw fail(`${at}[0]`, 'is not a string');
        needLength(pos, `${at}[0]`, LIMITS.MAX_LABEL);
        needList(glosses, `${at}[1]`, 1, LIMITS.MAX_GLOSSES);
        glosses.forEach((gloss, g) => {
          if (typeof gloss !== 'string') throw fail(`${at}[1][${g}]`, 'is not a string');
          needLength(gloss, `${at}[1][${g}]`, LIMITS.MAX_TEXT);
        });
        // D-576 N4: a record with no gloss would make an answer with nothing
        // but a credits line. The whole pack is refused, not the record.
        if (!glosses.some(hasWords)) throw fail(`${at}[1]`, 'has no non-empty gloss');
        if (reading !== null && !isText(reading)) throw fail(`${at}[2]`, 'is not a non-empty string or null');
        if (!sourceIds.has(origin)) throw fail(`${at}[3]`, 'is not an id in sources');
        if (origin === 'jmdict') jmdict = true;
      });
    }
    return jmdict;
  }

  // An example is a Tatoeba pair when it carries a sentence id; a kaikki
  // example has null on both sides.
  const isTatoeba = (example) => example[2] !== null || example[3] !== null;

  function checkExamples(x, e) {
    let tatoeba = false;
    for (const [head, examples] of Object.entries(x)) {
      const path = `x[${JSON.stringify(head)}]`;
      if (!Object.hasOwn(e, head)) throw fail(path, 'has no head in e');
      needList(examples, path, 1, LIMITS.MAX_EXAMPLES);
      examples.forEach((example, i) => {
        const at = `${path}[${i}]`;
        needList(example, at, 4, 4);
        needText(example[0], `${at}[0]`, LIMITS.MAX_TEXT);
        needText(example[1], `${at}[1]`, LIMITS.MAX_TEXT);
        needSentenceId(example[2], `${at}[2]`);
        needSentenceId(example[3], `${at}[3]`);
        if (isTatoeba(example)) tatoeba = true;
      });
    }
    return tatoeba;
  }

  function checkForms(m, e) {
    for (const [head, forms] of Object.entries(m)) {
      const path = `m[${JSON.stringify(head)}]`;
      if (!Object.hasOwn(e, head)) throw fail(path, 'has no head in e');
      needList(forms, path, 1, LIMITS.MAX_FORMS);
      forms.forEach((form, i) => {
        needList(form, `${path}[${i}]`, 2, 2);
        needText(form[0], `${path}[${i}][0]`, LIMITS.MAX_LABEL);
        needText(form[1], `${path}[${i}][1]`, LIMITS.MAX_TEXT);
      });
    }
  }

  function checkPointers(f, e) {
    for (const [form, head] of Object.entries(f)) {
      const path = `f[${JSON.stringify(form)}]`;
      needText(form, path, LIMITS.MAX_KEY);
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
    needPair(pack.src, pack.tgt);
    needText(pack.ver, 'ver');
    needText(pack.lic, 'lic');
    const sourceIds = new Set();
    needList(pack.sources, 'sources', 1, LIMITS.MAX_SOURCES).forEach((source, i) => {
      needObject(source, `sources[${i}]`);
      for (const key of ['id', 'name', 'license']) needText(source[key], `sources[${i}].${key}`);
      needLink(source.url, `sources[${i}].url`);
      sourceIds.add(source.id);
    });
    needObject(pack.credits, 'credits');
    for (const [id, credit] of Object.entries(pack.credits)) needCredit(id, credit, `credits.${id}`);
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
      url: download.url,
      sha256: download.sha256,
      heads: Object.keys(pack.e).length,
      bytes: download.bytes,
      rawBytes: download.rawBytes,
      lic: pack.lic,
      sources: pack.sources,
      credits: pack.credits,
    };
  }

  /**
   * The licence and attribution files published beside a pack (D-570: one
   * directory per pack holds the JSON, LICENSE.txt and ATTRIBUTION.txt), from
   * the `url` its list item kept.
   */
  function docUrls(item) {
    const dir = DOWNLOAD_ORIGIN + item.url.slice(0, item.url.lastIndexOf('/') + 1);
    return { license: `${dir}LICENSE.txt`, attribution: `${dir}ATTRIBUTION.txt` };
  }

  // ---- lookup -----------------------------------------------------------------

  // The Korean particles a looked-up word may carry (D-578: the one fold made
  // at lookup time). Longest first, so 에서 is tried before 에 and 으로 before 로.
  // Tested through foldCandidates(), not exported.
  const KO_PARTICLES = Object.freeze([
    '은', '는', '이', '가', '을', '를', '에', '에서', '에게', '한테', '께서', '의', '와', '과', '도',
    '로', '으로', '만', '부터', '까지', '보다', '처럼', '이나', '나', '랑', '이랑',
  ].sort((a, b) => b.length - a.length));

  // The longest particle that leaves a stem: 이나 is the whole word, so 나
  // is tried next (D-609 N9).
  function stripParticle(word) {
    for (const particle of KO_PARTICLES) {
      if (word.endsWith(particle) && word.length > particle.length) return word.slice(0, -particle.length);
    }
    return '';
  }

  /**
   * The spellings to look `text` up under, in order: as written, lower case,
   * NFKC (full-width to half-width), then the same three with one trailing
   * sentence stop dropped, and for Korean the word with one particle
   * stripped. No duplicates, no empty strings.
   */
  function foldCandidates(text, src) {
    const exact = String(text == null ? '' : text).trim();
    // DictEntry.isLookup drops one sentence stop at the very end ("apple." and
    // "run?" are lookups, D-542), so the word is tried both with it ("etc." is
    // a head of its own) and without it.
    const word = exact.replace(root.DictEntry.TRAILING_STOP, '').trimEnd();
    const out = [];
    for (const spelling of [exact, word]) {
      const nfkc = spelling.normalize('NFKC');
      out.push(spelling, spelling.toLowerCase(), nfkc, nfkc.toLowerCase());
    }
    if (src === 'ko') out.push(stripParticle(word.normalize('NFKC')));
    return [...new Set(out.filter(Boolean))];
  }

  const isEnglish = (lang) => root.LangTags.getLangBase(lang) === 'en';

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
    const translation = records[0][1].find(hasWords);
    const credits = [];
    if (records.some((r) => r[3] === 'jmdict')) credits.push(meta.credits.jmdict);
    if (examples.some(isTatoeba)) credits.push(meta.credits.tatoeba);
    return {
      translation,
      entry: {
        translation,
        phonetics: phoneticsOf(records[0][2], targetLang),
        senses: records.map(([pos, glosses]) => ({ pos, defs: glosses.filter(hasWords) })),
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
    DECLINED_KEY,
    DOWNLOAD_ORIGIN,
    MANIFEST_URL,
    CHUNK_KEYS,
    LANGS,
    LIMITS,
    pairOf,
    isPackLang,
    needPair,
    splitPair,
    prefixOf,
    entryKey,
    formKey,
    parsePack,
    seedChunks,
    listItem,
    docUrls,
    foldCandidates,
    toResponse,
  });
})(globalThis);
