// ctx.dictLookup (content/content-dict-lookup.js), the offline dictionary's
// lookup, over the real engine language family (content/engine/languages.js)
// and a fake chrome.storage.local seeded from the hand-made v1 fixture packs:
//
//   - the source language (design §3.4, revised by D-686): kana ja, hangul
//     ko, Cyrillic ru; Han zh-CN, or ja in a selection on a Japanese page;
//     Latin follows the page (a pack language is that pack, another
//     Latin-script language is no lookup, no reading or a non-Latin page is
//     tried as en), the input box (standalone) the standalone rules;
//   - one storage read, plus one more for a form-table hit (`~ran` -> run);
//   - the Korean particle strip;
//   - a Traditional spelling found through the zh pack's form table (D-578);
//   - a pair missing from `dict:packs` answers null and sends DICT_PACK_WANT
//     once per pair per page, even when its keys are already half-seeded;
//   - a pair in `dict:declined` answers null with no DICT_PACK_WANT (D-609);
//   - the switch off, a non-candidate, a same-language pair: null, no read and
//     no DICT_PACK_WANT;
//   - the word's language for the model's prompt (wordLang): the target's
//     own only on proof (a script that pins it, or the word in a seeded pack
//     of the target language), another only on proof (a script, or a reliable
//     reading of typed text), and unknown otherwise, never from the page or
//     the English last resort.
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// ---- the browser ------------------------------------------------------------

// What the detector answers. The page's language is whatever `page.lang` says
// for the page-sized body sample; a short word is unreliable, as in real
// Chrome, except one long German word the standalone rule can trust.
const page = { lang: 'en', body: 'This page body is long enough for the page language detector.' };
function detectLanguage(sample) {
  if (sample === page.body) return { isReliable: true, languages: [{ language: page.lang, percentage: 99 }] };
  if (sample === 'Schmetterling') return { isReliable: true, languages: [{ language: 'de', percentage: 99 }] };
  return { isReliable: false, languages: [{ language: 'ja', percentage: 100 }] };
}

let resetPageLang = null;
const storage = new Map();
const reads = [];
const sent = [];

globalThis.window = { AI_TRANSLATOR_CONTENT: { settings: { offlineDictionary: true } } };
globalThis.document = { body: { get innerText() { return page.body; } } };
globalThis.SpaNavigation = { onRouteChange: (fn) => { resetPageLang = fn; } };
globalThis.chrome = {
  i18n: { detectLanguage: async (sample) => detectLanguage(sample) },
  storage: {
    local: {
      async get(keys) {
        const list = [].concat(keys);
        reads.push(list);
        return Object.fromEntries(list.filter((k) => storage.has(k)).map((k) => [k, storage.get(k)]));
      },
    },
  },
  runtime: {
    async sendMessage(message) {
      sent.push(message);
    },
  },
};

await import('../../shared/lang-tags.js');
await import('../../shared/engines.js');
await import('../../shared/dict-entry.js');
await import('../../shared/dict-pack.js');
await import('../../content/engine/languages.js');
await import('../../content/content-dict-lookup.js');
const { DictPack, DictEntry } = globalThis;
const ctx = globalThis.window.AI_TRANSLATOR_CONTENT;

// ---- the packs --------------------------------------------------------------

const fixture = (name) =>
  DictPack.parsePack(readFileSync(new URL(`../fixtures/dict-runtime/${name}.json`, import.meta.url), 'utf8'));

function seed(pack, { listed = true } = {}) {
  for (const chunk of DictPack.seedChunks(pack)) {
    for (const [key, value] of Object.entries(chunk)) storage.set(key, value);
  }
  if (!listed) return;
  const packs = storage.get(DictPack.PACKS_KEY) || {};
  packs[DictPack.pairOf(pack.src, pack.tgt)] = DictPack.listItem(pack, { sha256: 'x', bytes: 1, rawBytes: 1 });
  storage.set(DictPack.PACKS_KEY, packs);
}
seed(fixture('en-zh-CN'));
seed(fixture('ja-zh-CN'));
seed(fixture('ko-en'));
seed(fixture('zh-CN-ja'));

function setPageLang(lang) {
  page.lang = lang;
  resetPageLang();
}

// One lookup, with the storage reads and messages it made.
async function lookup(text, targetLang, options) {
  reads.length = 0;
  sent.length = 0;
  const { answer, wordLang } = await ctx.dictLookup(text, targetLang, options);
  return { answer, wordLang, reads: reads.length, sent: [...sent] };
}

// The same, with every key it read.
async function lookupKeys(text, targetLang, options) {
  reads.length = 0;
  const { wordLang } = await ctx.dictLookup(text, targetLang, options);
  return { wordLang, keys: reads.flat() };
}

// ---- hits -------------------------------------------------------------------

test('a form-table hit takes a second read and answers with the head (J-B1.2)', async () => {
  const { answer, reads: n, sent: messages } = await lookup('ran', 'zh-CN');
  assert.equal(n, 2);
  assert.deepEqual(messages, []);
  assert.equal(answer.engine, DictEntry.DICT_ENGINE);
  assert.equal(answer.translation, '跑');
  assert.deepEqual(answer.entry.phonetics, [{ label: '', ipa: 'pǎo' }], 'one unlabelled reading for a zh target');
  const entry = DictEntry.entryFor('word', answer);
  assert.equal(entry.translation, '跑');
  assert.equal(entry.senses.length, 2);
});

test('a direct hit takes one read; case and a trailing stop fold', async () => {
  for (const text of ['Run', 'APPLE', 'apple.', 'ＲＵＮ']) {
    const { answer, reads: n } = await lookup(text, 'zh-CN');
    assert.ok(answer, text);
    assert.equal(n, 1, text);
  }
});

test('a Korean particle is stripped and an English target has UK and US (J-B1.3)', async () => {
  const { answer } = await lookup('학교에서', 'en');
  assert.equal(answer.translation, 'school');
  assert.deepEqual(answer.entry.phonetics, [{ label: 'UK', ipa: '/skuːl/' }, { label: 'US', ipa: '/skul/' }]);
  DictEntry.entryFor('word', answer);
});

test('kana is Japanese; a JMdict record brings its credit (J-B1.4)', async () => {
  // 食べました is past isLookup's four-Han limit: isDictCandidate lets it in (D-609).
  assert.equal(DictEntry.isLookup('食べました'), false);
  const { answer, reads: n } = await lookup('食べました', 'zh-CN');
  assert.equal(n, 2);
  assert.equal(answer.translation, '吃');
  assert.deepEqual(answer.credits.map((c) => c.label), ['JMdict © EDRDG']);
  assert.equal(DictEntry.entryFor('word', answer).translation, '吃');
});

test('a Traditional spelling reaches its Simplified head through the form table (D-578)', async () => {
  for (const [text, reads] of [['蘋果', 2], ['苹果', 1], ['學校', 2]]) {
    const { answer, reads: n, sent: messages } = await lookup(text, 'ja');
    assert.equal(n, reads, text);
    assert.deepEqual(messages, [], text);
    assert.equal(answer.translation, text === '學校' ? '学校' : 'りんご', text);
  }
});

test('an unknown word in an installed pack is null, with no request for the pack', async () => {
  const { answer, reads: n, sent: messages } = await lookup('xyzzy', 'zh-CN');
  assert.equal(answer, null);
  assert.equal(n, 1);
  assert.deepEqual(messages, []);
});

// ---- the source language (design §3.4) --------------------------------------

test('Han without kana is zh-CN and Cyrillic is ru', async () => {
  assert.deepEqual((await lookup('猫', 'en')).sent, [{ type: 'DICT_PACK_WANT', src: 'zh-CN', tgt: 'en' }]);
  assert.deepEqual((await lookup('кот', 'en')).sent, [{ type: 'DICT_PACK_WANT', src: 'ru', tgt: 'en' }]);
});

test('Han selected on a Japanese page is Japanese; typed Han is still zh-CN (D-686)', async () => {
  setPageLang('ja');
  assert.deepEqual((await lookup('猫', 'ko')).sent, [{ type: 'DICT_PACK_WANT', src: 'ja', tgt: 'ko' }]);
  assert.deepEqual((await lookup('猫', 'ru', { standalone: true })).sent,
    [{ type: 'DICT_PACK_WANT', src: 'zh-CN', tgt: 'ru' }], 'the input box is not the page');
  setPageLang('en');
});

test('Latin text follows the page: a pack language, no lookup, or English (D-686)', async () => {
  setPageLang('fr');
  assert.deepEqual((await lookup('chat', 'zh-CN')).sent, [{ type: 'DICT_PACK_WANT', src: 'fr', tgt: 'zh-CN' }]);
  setPageLang('it');
  const burro = await lookup('burro', 'zh-CN');
  assert.equal(burro.answer, null, 'an Italian page: no pack holds Italian');
  assert.equal(burro.reads, 0);
  assert.deepEqual(burro.sent, [], 'and none is asked for');
  assert.equal((await lookup('ran', 'zh-CN')).answer, null, 'not even an English head');
  setPageLang('');
  assert.equal((await lookup('ran', 'zh-CN')).answer.translation, '跑', 'no reading: English');
  setPageLang('zh');
  assert.equal((await lookup('ran', 'zh-CN')).answer.translation, '跑', 'a Chinese page: Latin is English');
  setPageLang('en');
});

test('the input box (standalone) takes the standalone rules, not the page', async () => {
  setPageLang('es');
  assert.deepEqual((await lookup('Schmetterling', 'zh-CN')).sent,
    [{ type: 'DICT_PACK_WANT', src: 'es', tgt: 'zh-CN' }], 'the page decides a selection');
  assert.deepEqual((await lookup('Schmetterling', 'ja', { standalone: true })).sent,
    [{ type: 'DICT_PACK_WANT', src: 'de', tgt: 'ja' }], 'a reliable reading decides typed text');
  setPageLang('en');
});

test('a script no pack holds answers null without asking', async () => {
  const { answer, reads: n, sent: messages } = await lookup('สวัสดี', 'en');
  assert.equal(answer, null);
  assert.equal(n, 0);
  assert.deepEqual(messages, []);
});

// ---- DICT_PACK_WANT ---------------------------------------------------------

test('a missing pair asks once per page, and stays null meanwhile (J-B1.5)', async () => {
  const first = await lookup('apple', 'ko');
  assert.equal(first.answer, null);
  assert.deepEqual(first.sent, [{ type: 'DICT_PACK_WANT', src: 'en', tgt: 'ko' }]);
  const second = await lookup('apple', 'ko');
  assert.equal(second.answer, null);
  assert.deepEqual(second.sent, [], 'once per pair per page');
});

test('a pair the reader deleted is not asked for (D-609)', async () => {
  storage.set(DictPack.DECLINED_KEY, ['en-es']);
  try {
    const { answer, reads: n, sent: messages } = await lookup('apple', 'es');
    assert.equal(answer, null);
    assert.equal(n, 1);
    assert.deepEqual(messages, []);
  } finally {
    storage.delete(DictPack.DECLINED_KEY);
  }
  assert.deepEqual((await lookup('apple', 'es')).sent, [{ type: 'DICT_PACK_WANT', src: 'en', tgt: 'es' }],
    'once the pair is no longer declined, the page asks');
});

test('seeded keys without the list item are not a pack', async () => {
  seed(fixture('en-zh-CN'), { listed: false });
  const pack = fixture('ko-en');
  pack.tgt = 'ja';
  seed(pack, { listed: false });
  const { answer, sent: messages } = await lookup('학교', 'ja');
  assert.ok(storage.has(DictPack.entryKey('ko', 'ja', '학교')), 'the head is there');
  assert.equal(answer, null);
  assert.deepEqual(messages, [{ type: 'DICT_PACK_WANT', src: 'ko', tgt: 'ja' }]);
});

// ---- no lookup at all -------------------------------------------------------

test('the switch off: null, no read, no request (J-B1.9)', async () => {
  ctx.settings.offlineDictionary = false;
  try {
    for (const [text, tgt] of [['ran', 'zh-CN'], ['apple', 'es']]) {
      const { answer, reads: n, sent: messages } = await lookup(text, tgt);
      assert.equal(answer, null);
      assert.equal(n, 0);
      assert.deepEqual(messages, []);
    }
  } finally {
    ctx.settings.offlineDictionary = true;
  }
});

test('not a lookup, an unsupported target, or the same language: null, no read, no request', async () => {
  for (const [text, tgt] of [
    ['I ran. Then I stopped', 'zh-CN'],
    ['私は学生です。', 'zh-CN'],
    ['今日は良い天気ですね', 'zh-CN'],
    ['run', 'it'],
    ['猫', 'zh-TW'],
    ['猫', 'zh-CN'],
  ]) {
    const { answer, reads: n, sent: messages } = await lookup(text, tgt);
    assert.equal(answer, null, text);
    assert.equal(n, 0, text);
    assert.deepEqual(messages, [], text);
  }
  // A Latin word under its own page's language is no pack lookup either, but
  // the one read still asks the target language's packs whether it is theirs.
  const { answer, reads: n, sent: messages } = await lookup('run', 'en');
  assert.equal(answer, null);
  assert.equal(n, 1);
  assert.deepEqual(messages, []);
});

// ---- the word's language, for the model's prompt (wordLang) ----------------

const { TARGET, OTHER, UNKNOWN } = DictEntry.WORD_LANGS;

test('a script proves the language: kana, hangul and Han pin theirs, another script is not the target\'s', async () => {
  for (const [text, tgt, wordLang] of [
    ['たべる', 'ja', TARGET],
    ['학교', 'ko', TARGET],
    ['猫', 'zh-CN', TARGET],
    ['猫', 'zh-TW', TARGET],
    ['猫', 'en', OTHER],
    ['run', 'zh-CN', OTHER],
    ['кот', 'en', OTHER],
    ['학교', 'ja', OTHER],
  ]) {
    assert.equal((await lookup(text, tgt)).wordLang, wordLang, `${text} -> ${tgt}`);
  }
});

test('a script many languages share proves nothing on its own: Cyrillic, Han on a Japanese page', async () => {
  assert.equal((await lookup('кот', 'ru')).wordLang, UNKNOWN, 'Ukrainian is Cyrillic too');
  setPageLang('ja');
  assert.equal((await lookup('先生', 'zh-CN')).wordLang, UNKNOWN, 'kanji on a Japanese page may be Japanese');
  assert.equal((await lookup('先生', 'zh-CN', { standalone: true })).wordLang, TARGET, 'typed Han is Chinese');
  setPageLang('en');
});

test('a word in a seeded pack of the target language is that language\'s, through its form table too', async () => {
  for (const [text, tgt] of [['run', 'en'], ['Ran', 'en'], ['apple', 'en-GB'], ['猫', 'ja']]) {
    const { wordLang, reads: n } = await lookup(text, tgt);
    assert.equal(wordLang, TARGET, `${text} -> ${tgt}`);
    assert.equal(n, 1, `${text}: the proof rides on the one read`);
  }
  // 猫 is in the ja pack, so a Japanese reader gets the Japanese word; Han
  // that no ja pack holds stays the Chinese reading.
  assert.equal((await lookup('学校', 'ja')).wordLang, OTHER);
});

test('a short Latin word with no proof is unknown, wherever the page and the last resort point', async () => {
  for (const lang of ['en', 'fr', '']) {
    setPageLang(lang);
    for (const text of ['popular', 'Schadenfreude', 'Bonjour', 'gato']) {
      assert.equal((await lookup(text, 'en')).wordLang, UNKNOWN, `${text} on a '${lang}' page`);
      assert.equal((await lookup(text, 'en', { standalone: true })).wordLang, UNKNOWN, `typed ${text}`);
    }
  }
  setPageLang('en');
});

test('a reliable reading of typed text proves another language, never the target\'s own', async () => {
  assert.equal((await lookup('Schmetterling', 'en', { standalone: true })).wordLang, OTHER);
  assert.equal((await lookup('Schmetterling', 'de', { standalone: true })).wordLang, UNKNOWN);
  // A selection is read by the page, not the detector.
  assert.equal((await lookup('Schmetterling', 'en')).wordLang, UNKNOWN);
});

test('pack proof needs the switch on and the pack listed; the verdict needs neither for a script', async () => {
  ctx.settings.offlineDictionary = false;
  try {
    const run = await lookup('run', 'en');
    assert.equal(run.wordLang, UNKNOWN);
    assert.equal(run.reads, 0);
    assert.equal((await lookup('猫', 'zh-CN')).wordLang, TARGET);
    assert.equal((await lookup('猫', 'en')).wordLang, OTHER);
  } finally {
    ctx.settings.offlineDictionary = true;
  }
  const packs = storage.get(DictPack.PACKS_KEY);
  storage.set(DictPack.PACKS_KEY, Object.fromEntries(Object.entries(packs).filter(([pair]) => pair !== 'en-zh-CN')));
  try {
    assert.equal((await lookup('colour', 'en')).wordLang, UNKNOWN, 'seeded keys without the list item prove nothing');
  } finally {
    storage.set(DictPack.PACKS_KEY, packs);
  }
});

test('a word selected on a page in another language is not proven the target\'s by the target\'s packs', async () => {
  // run is in the seeded en-zh-CN pack, which proves it English on an English
  // page. On a German page a word that German can write is the page's as much
  // as English's (Gift, Rat, Kind): the model decides, and the en packs are
  // not even asked.
  setPageLang('de');
  try {
    const enKeys = (key) => key.startsWith('d:en-');
    const { wordLang, keys } = await lookupKeys('run', 'en');
    assert.equal(wordLang, UNKNOWN);
    assert.deepEqual(keys.filter(enKeys), [], 'no proof key of an en pack is read');
    // Typed into the box, the same word has no page around it: the pack proves it.
    assert.equal((await lookup('run', 'en', { standalone: true })).wordLang, TARGET);
    // A page in the target's own language still lets the pack prove it.
    setPageLang('en-GB');
    assert.equal((await lookup('run', 'en')).wordLang, TARGET);
  } finally {
    setPageLang('en');
  }
});

// ---- the route (ctx.dictRoute) ----------------------------------------------

async function route(text, targetLang, options) {
  reads.length = 0;
  sent.length = 0;
  const result = await ctx.dictRoute(text, targetLang, options);
  return { ...result, keys: reads.flat(), sent: [...sent] };
}

test('a lookup pinned to an engine reads only its verdict: no pack entry, no pack request', async () => {
  const pairKeysOf = (src, tgt) => (key) => key.startsWith(`d:${DictPack.pairOf(src, tgt)}:`);
  // apple -> pt: the en-pt pack is not seeded and no lookup has asked for it
  // yet. ran -> zh-CN and 학교 -> en are in seeded packs. Pinned, the pack never
  // answers, so none of its keys is read and nothing is asked for.
  for (const [text, tgt, src] of [['apple', 'pt', 'en'], ['ran', 'zh-CN', 'en'], ['학교', 'en', 'ko']]) {
    const pinned = await route(text, tgt, { pinned: 'ai' });
    assert.equal(pinned.local, null, text);
    assert.equal(pinned.request.mode, 'word', text);
    assert.deepEqual(pinned.sent, [], `${text}: no DICT_PACK_WANT`);
    assert.deepEqual(pinned.keys.filter(pairKeysOf(src, tgt)), [], `${text}: no ${src}-${tgt} key read`);
    assert.equal(pinned.keys.includes(DictPack.DECLINED_KEY), false, text);
  }
  // The same lookups unpinned read those keys, and the missing pack is asked for.
  const unpinned = await route('apple', 'pt');
  assert.deepEqual(unpinned.sent, [{ type: 'DICT_PACK_WANT', src: 'en', tgt: 'pt' }]);
  assert.ok(unpinned.keys.some(pairKeysOf('en', 'pt')), 'the unpinned lookup reads the en-pt keys');
  assert.equal((await route('ran', 'zh-CN')).local.translation, '跑');
  // The verdict still reads the proof: run pinned for an English reader is English.
  const proven = await route('run', 'en', { pinned: 'ai' });
  assert.deepEqual(proven.request, { mode: 'word', wordLang: TARGET });
  assert.ok(proven.keys.some((key) => key.startsWith('d:en-zh-CN:')), 'the proof keys are read');
  // Text that is no lookup goes out as text, with nothing read at all.
  const sentence = await route('I ran. Then I stopped', 'en', { pinned: 'ai' });
  assert.deepEqual([sentence.request, sentence.keys, sentence.sent], [{ mode: 'text' }, [], []]);
});

test('an unpinned route answers from the pack and keeps the verdict', async () => {
  const hit = await route('ran', 'zh-CN');
  assert.equal(hit.local.translation, '跑');
  assert.deepEqual(hit.request, { mode: 'word', wordLang: OTHER });
  // A pack hit proves a word that isLookup would not look up (D-609).
  assert.equal(DictEntry.isLookup('食べました'), false);
  assert.equal((await route('食べました', 'zh-CN')).request.mode, 'word');
  // A provenWord card asked again pinned is still a word.
  assert.equal((await route('食べました', 'zh-CN', { pinned: 'ai', provenWord: true })).request.mode, 'word');
  assert.deepEqual((await route('I ran. Then I stopped', 'en')).request, { mode: 'text' });
});

test('text that is no dictionary candidate has no word language', async () => {
  const { answer, wordLang, reads: n } = await lookup('I ran. Then I stopped', 'en');
  assert.deepEqual([answer, wordLang, n], [null, null, 0]);
});
