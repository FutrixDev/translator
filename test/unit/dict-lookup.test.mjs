// ctx.dictLookup (content/content-dict-lookup.js), the offline dictionary's
// lookup, over the real engine language family (content/engine/languages.js)
// and a fake chrome.storage.local seeded from the hand-made v1 fixture packs:
//
//   - the source language: kana ja, hangul ko, Han zh-CN, Cyrillic ru; Latin
//     follows the page (en/es/fr/de/pt, anything else is tried as en), the
//     input box (standalone) the standalone rules (design §3.4);
//   - one storage read, plus one more for a form-table hit (`~ran` -> run);
//   - the Korean particle strip;
//   - a Traditional spelling found through the zh pack's form table (D-578);
//   - a pair missing from `dict:packs` answers null and sends DICT_PACK_WANT
//     once per pair per page, even when its keys are already half-seeded;
//   - the switch off, a non-lookup, a same-language pair: null, no read and
//     no DICT_PACK_WANT.
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
  const answer = await ctx.dictLookup(text, targetLang, options);
  return { answer, reads: reads.length, sent: [...sent] };
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
  const { answer, reads: n } = await lookup('食べた', 'zh-CN');
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

test('Latin text follows the page; a page outside en/es/fr/de/pt is tried as English', async () => {
  setPageLang('fr');
  assert.deepEqual((await lookup('chat', 'zh-CN')).sent, [{ type: 'DICT_PACK_WANT', src: 'fr', tgt: 'zh-CN' }]);
  setPageLang('it');
  assert.equal((await lookup('ran', 'zh-CN')).answer.translation, '跑');
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
    ['run', 'it'],
    ['run', 'en'],
    ['猫', 'zh-TW'],
    ['猫', 'zh-CN'],
  ]) {
    const { answer, reads: n, sent: messages } = await lookup(text, tgt);
    assert.equal(answer, null, text);
    assert.equal(n, 0, text);
    assert.deepEqual(messages, [], text);
  }
});
