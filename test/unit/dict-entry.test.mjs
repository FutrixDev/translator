// The dictionary entry has one owner, shared/dict-entry.js (D-469/D-470):
//
//   - isLookup() alone decides what is looked up (D-473–D-475, D-542), checked
//     against the rulings' own samples;
//   - normalize() is the only check on what the model sends back (D-472): only
//     a non-object or a missing/empty translation throws `invalidEntry`; a
//     wrong-typed optional field or an overlong item is dropped and the rest
//     kept, a missing list is empty, extra keys are dropped, lists past their
//     cap are cut;
//   - the keys the prompt asks for are the keys normalize() reads, because both
//     are built from FIELDS (checked here from the prompt's own text);
//   - the phonetics asked for are the translation's, in the target language,
//     and each phonetic speaker reads the translation: UK in en-GB, US in
//     en-US, an unlabelled row in the request's target language (D-487); UK
//     and US hold only for an English target, otherwise the label is dropped
//     and the row is read in the target language;
//   - render() puts model strings on the page as text, never as HTML, and
//     stops the old entry's speaker before replacing it;
//   - only a word-mode answer from a model engine ('ai' or 'blab') or the
//     offline dictionary ('dict') carries an entry (entryFor); only the
//     dictionary's answer may carry credits, kept when each is an https link
//     to an allowed host, and render draws them as one line of links;
//   - RULES holds one set of rules per WORD_LANGS value, and nothing else;
//   - credits never reach the prompt: RULES.other is pinned word for word;
//   - a word already in the target language has its own rules,
//     RULES.target: the same keys, a gloss for "translation", the
//     word's own phonetics, examples with no translation; a word whose
//     language is not known gets RULES.unknown, which adds one key,
//     "monolingual", for the model to say which entry it wrote;
//   - fromModelText() stamps entry.monolingual: from the caller's wordLang
//     when it is known, from the model's own answer when it is not; only a
//     cross-language entry's example needs its target;
//   - render() reads a monolingual entry's phonetics as the looked-up word
//     (the `text` option, required) and draws an example with no translation
//     as its sentence alone.
//
// That the dialog and the card draw the same entry is checked on the page:
// test/e2e/dictionary-entry.spec.js compares the two.
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { repoSource, workerSource } from './helpers/sources.mjs';

// render() reads LangTags; the manifest loads it first (checked below).
await import('../../shared/lang-tags.js');
await import('../../shared/engines.js');
await import('../../shared/dict-entry.js');
const {
  DICT_ENGINE, FIELDS, MAX_TEXT, RULES, WORD_LANGS,
  PROMPT_MARK, isLookup, isDictCandidate, normalize, fromModelText, entryFor,
  hasContent, render,
} = globalThis.DictEntry;

// `run` looked up into zh-CN: the phonetics are the translation's, pinyin with
// no label (D-487). A cross-language entry: monolingual is false.
const FULL = {
  translation: '跑',
  monolingual: false,
  phonetics: [{ label: '', ipa: 'pǎo' }],
  senses: [{ pos: 'v.', defs: ['跑', '奔跑'] }, { pos: 'n.', defs: ['跑步'] }],
  examples: [{ source: 'I run every day.', target: '我每天跑步。' }],
  forms: [{ label: '过去式', value: 'ran' }],
};

const throwsInvalid = (fn, reason) => assert.throws(fn, (error) => {
  assert.equal(error.invalidEntry, true, `${reason}: not marked invalidEntry`);
  return true;
}, reason);

// ---- isLookup (D-473, D-542) ------------------------------------------------

// The ruling's samples, every one of them, then the edges of each rule.
const LOOKUP_TABLE = [
  ['run', true],
  ['give up', true],
  ['look forward to', true],
  ['I run daily', true],
  ['我每天早上跑步。', false],
  ['跑步', true],
  ['猫', true],
  ['東京', true],
  ['Hello, world', false],
  // one sentence stop at the end is how a word is often typed: dropped first
  // (D-542)
  ['run.', true],
  ['apple.', true],
  ['good morning!', true],
  // a stop inside, or more than one, is still a sentence
  ['e.g.', false],
  ['U.S.', false],
  ['3.14', false],
  ['Mr. Smith', false],
  ['run..', false],
  ['?', false],
  // trimmed first
  ['  give up \n', true],
  ['', false],
  ['   ', false],
  // 1–3 words, by spaces
  ['look forward to it', false],
  ['state-of-the-art', true],
  // where words are not spaced, by code point: 1–4 with any Han, 1–8 in kana,
  // hangul, Thai and the like (D-542)
  ['一石二鳥', true],
  ['一石二鸟吧', false],
  ['ありがとう', true],
  ['こんにちは', true],
  ['안녕하세요', true],
  ['감사합니다', true],
  ['สวัสดี', true],
  ['ありがとうございます', false],
  ['食べる', true],
  ['食べられない', false],
  ['猫 狗', true],
  ['안녕', true],
  ['𠮷野家', true],
  // any other sentence punctuation, half- or full-width, or a stop that is
  // not the last character
  ['run!', true],
  ['run?', true],
  ['跑！', true],
  ['跑？', true],
  ['跑。', true],
  ['run?!', false],
  ['How are you doing', false],
  ['跑；', false],
  ['run;', false],
  ['跑，', false],
  ['note: run', false],
  ['跑：', false],
  // formula notation is translated, never looked up (D-474): LaTeX delimiters
  // and commands, math symbols, ^ _ { }
  ['$x + y$', false],
  ['\\(x + y\\)', false],
  ['\\[a\\]', false],
  ['$$E$$', false],
  ['\\alpha', false],
  ['x^2', false],
  ['a_i', false],
  ['{x}', false],
  ['a = b', false],
  ['1 + 1', false],
  ['x ± y', false],
  // ASCII arithmetic is formula notation too (D-475): any *, a - or / between
  // spaces or between bare operands; hyphenated and slashed words stay lookups
  ['x - y', false],
  ['a / b', false],
  ['cost - tax', false],
  ['miles / hour', false],
  ['x/y', false],
  ['2*2', false],
  ['(x-y)', false],
  ['a/b', false],
  ['3/4', false],
  ['1990-2000', false],
  ['x-ray', true],
  ['Wi-Fi', true],
  ['T-shirt', true],
  ['e-mail', true],
  ['COVID-19', true],
  ['km/h', true],
  ['and/or', true],
];

test('isLookup answers the D-473–D-475 table, as revised by D-542', () => {
  for (const [text, expected] of LOOKUP_TABLE) {
    assert.equal(isLookup(text), expected, JSON.stringify(text));
  }
  assert.equal(isLookup(null), false);
  assert.equal(isLookup(undefined), false);
});

// ---- isDictCandidate (D-609) -------------------------------------------------

// Japanese inflections run past isLookup's four-Han limit but are one word the
// pack's form table can answer; sentences are still not asked about.
const DICT_CANDIDATE_TABLE = [
  ['食べました', true],
  ['勉強しました', true],
  ['美しかった', true],
  ['食べられない', true],
  ['  食べました ', true],
  // sentence punctuation, even one stop at the end, keeps it a sentence
  ['私は学生です。', false],
  ['食べました。', false],
  // past eight characters it is a phrase
  ['今日は良い天気ですね', false],
  ['勉強させられました', false],
  // Han without kana, or kana without Han, is isLookup's call alone
  ['一石二鸟吧', false],
  ['ありがとうございます', false],
  // formula notation is never a word
  ['食べ$x$た', false],
  ['', false],
];

test('isDictCandidate is every lookup, plus short kanji-and-kana words', () => {
  for (const [text, expected] of DICT_CANDIDATE_TABLE) {
    assert.equal(isDictCandidate(text), expected, JSON.stringify(text));
  }
  assert.equal(Array.from('今日は良い天気ですね').length, 10, 'rejected by the eight-character limit, not by punctuation');
  for (const [text, expected] of LOOKUP_TABLE) {
    if (expected) assert.equal(isDictCandidate(text), true, `every lookup is a candidate: ${JSON.stringify(text)}`);
  }
  assert.equal(isDictCandidate(null), false);
  for (const text of ['食べました', '勉強しました', '美しかった']) {
    assert.equal(isLookup(text), false, `isLookup itself is unchanged: ${text}`);
  }
});

// ---- normalize ------------------------------------------------------------

test('a full entry comes back field for field', () => {
  assert.deepEqual(normalize(FULL), FULL);
});

test('missing lists are empty, and only translation is required', () => {
  assert.deepEqual(normalize({ translation: ' 跑 ' }),
    { translation: '跑', monolingual: false, phonetics: [], senses: [], examples: [], forms: [] });
  throwsInvalid(() => normalize({ phonetics: [] }), 'no translation');
  throwsInvalid(() => normalize({ translation: '   ' }), 'blank translation');
});

test('only a non-object or a translation that is missing, empty or not a string throws', () => {
  throwsInvalid(() => normalize(null), 'null');
  throwsInvalid(() => normalize('跑'), 'a string');
  throwsInvalid(() => normalize([FULL]), 'an array');
  throwsInvalid(() => normalize({ translation: 42 }), 'number translation');
  throwsInvalid(() => normalize({ translation: ['跑'] }), 'array translation');
});

// D-472②: each row is one wrong-typed optional field; that field (or item)
// goes, everything else in FULL stays.
const LENIENT_ROWS = [
  ['senses a string (L2-5)', { senses: 'v. 跑；奔跑' }, { senses: [] }],
  ['senses an object', { senses: { pos: 'v.' } }, { senses: [] }],
  ['phonetics a number', { phonetics: 3 }, { phonetics: [] }],
  ['examples a string', { examples: 'I run.' }, { examples: [] }],
  ['forms null', { forms: null }, { forms: [] }],
  ['one example item a string',
    { examples: ['I run.', ...FULL.examples] }, {}],
  ['one sense item null',
    { senses: [null, ...FULL.senses] }, {}],
  ['defs a string drops the sense',
    { senses: [{ pos: 'v.', defs: '跑' }, ...FULL.senses] }, {}],
  ['one def a number',
    { senses: [{ pos: 'v.', defs: [1, '跑', '奔跑'] }, FULL.senses[1]] }, {}],
  ['pos a number drops the pos',
    { senses: [{ pos: 7, defs: ['跑', '奔跑'] }, FULL.senses[1]] },
    { senses: [{ pos: '', defs: ['跑', '奔跑'] }, FULL.senses[1]] }],
  ['label a number drops the label',
    { phonetics: [{ label: 1, ipa: '/kæt/' }, { label: 'US', ipa: '/kæt/' }] },
    { phonetics: [{ label: '', ipa: '/kæt/' }, { label: 'US', ipa: '/kæt/' }] }],
  ['form value an array drops the form',
    { forms: [{ label: '过去式', value: ['ran'] }, ...FULL.forms] }, {}],
];

test('a wrong-typed optional field is dropped and the rest of the entry kept', () => {
  for (const [name, patch, expected] of LENIENT_ROWS) {
    assert.deepEqual(normalize({ ...FULL, ...patch }), { ...FULL, ...expected }, name);
  }
});

// D-542: lenient is not silent. One warn per normalize() that dropped
// anything, naming each field and why; never the model's text. A clean entry
// warns nothing.
test('normalize warns once, by field name, when it drops what the model sent', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  normalize(FULL);
  normalize({ translation: '跑' });
  assert.equal(warn.mock.callCount(), 0, 'a clean entry warns nothing');
  // A translation that cannot be read is a throw, not a drop: no warn either.
  assert.throws(() => normalize({ translation: 42 }), /translation is missing or empty/);
  assert.throws(() => normalize({ translation: 'x'.repeat(MAX_TEXT + 1) }), /translation is missing or empty/);
  assert.equal(warn.mock.callCount(), 0, 'a rejected translation warns nothing');

  const secret = 'SECRET-SOURCE-TEXT';
  normalize({ ...FULL, phonetics: 'pǎo', senses: [{ pos: 7, defs: [secret.repeat(40)] }], examples: [secret] });
  assert.equal(warn.mock.callCount(), 1, 'one warn for the whole entry');
  const [message, dropped] = warn.mock.calls[0].arguments;
  assert.equal(message, '[Blab Translation] dict-entry: dropped fields');
  assert.deepEqual(dropped, [
    'phonetics: not an array',
    'senses[0].pos: not a string',
    `senses[0].defs[0]: over ${MAX_TEXT} characters`,
    'senses[0]: missing defs',
    'examples[0]: not an object',
  ]);
  assert.ok(!JSON.stringify(warn.mock.calls[0].arguments).includes(secret), 'the text never reaches the log');
});

test('extra keys are ignored and not carried, at the top and in items', () => {
  const entry = normalize({ ...FULL, note: 'x', senses: [{ pos: 'v.', defs: ['跑'], rank: 1 }] });
  assert.deepEqual(Object.keys(entry), ['translation', 'monolingual', 'phonetics', 'senses', 'examples', 'forms']);
  assert.deepEqual(entry.senses, [{ pos: 'v.', defs: ['跑'] }]);
});

test('empty arrays stay empty and empty items are dropped', () => {
  const entry = normalize({
    translation: '跑',
    phonetics: [{ label: 'UK', ipa: '' }],
    senses: [{ pos: 'v.', defs: ['', '  '] }, { pos: '', defs: ['跑'] }],
    examples: [{ source: '', target: '我跑。' }, { source: 'I run.', target: '' }],
    forms: [],
  });
  assert.deepEqual(entry.phonetics, []);
  assert.deepEqual(entry.senses, [{ pos: '', defs: ['跑'] }]);
  // A cross-language example needs both halves.
  assert.deepEqual(entry.examples, []);
  assert.deepEqual(entry.forms, []);
});

test('an unknown phonetic label keeps the pronunciation without a label', () => {
  assert.deepEqual(normalize({ translation: 'cat', phonetics: [{ label: 'GB', ipa: 'māo' }, { label: 'us', ipa: '/x/' }] }).phonetics,
    [{ label: '', ipa: 'māo' }, { label: 'US', ipa: '/x/' }]);
});

test('an overlong item is dropped and the rest kept; an overlong translation counts as missing', () => {
  const long = 'x'.repeat(MAX_TEXT + 1);
  throwsInvalid(() => normalize({ translation: long }), 'long translation');
  assert.equal(normalize({ translation: 'x'.repeat(MAX_TEXT) }).translation.length, MAX_TEXT);
  const rows = [
    ['long example source', { examples: [{ source: long, target: 'y' }, ...FULL.examples] }, {}],
    ['long def', { senses: [{ pos: 'v.', defs: ['跑', long, '奔跑'] }, FULL.senses[1]] }, {}],
    ['long pos', { senses: [{ pos: long, defs: ['跑', '奔跑'] }, FULL.senses[1]] },
      { senses: [{ pos: '', defs: ['跑', '奔跑'] }, FULL.senses[1]] }],
    ['long ipa', { phonetics: [FULL.phonetics[0], { label: '', ipa: long }] },
      { phonetics: [FULL.phonetics[0]] }],
    ['long form value', { forms: [...FULL.forms, { label: '复数', value: long }] }, {}],
  ];
  for (const [name, patch, expected] of rows) {
    assert.deepEqual(normalize({ ...FULL, ...patch }), { ...FULL, ...expected }, name);
  }
});

test('lists past their cap are cut', () => {

  const many = (n, make) => Array.from({ length: n }, (_, i) => make(i));
  const entry = normalize({
    translation: '跑',
    phonetics: many(5, (i) => ({ label: '', ipa: `/${i}/` })),
    senses: many(20, (i) => ({ pos: `p${i}`, defs: many(20, (j) => `d${j}`) })),
    examples: many(9, (i) => ({ source: `s${i}`, target: `t${i}` })),
    forms: many(20, (i) => ({ label: `l${i}`, value: `v${i}` })),
  });
  assert.equal(entry.phonetics.length, FIELDS.phonetics.max);
  assert.equal(entry.senses.length, FIELDS.senses.max);
  assert.equal(entry.senses[0].defs.length, FIELDS.senses.maxDefs);
  assert.equal(entry.examples.length, FIELDS.examples.max);
  assert.equal(entry.forms.length, FIELDS.forms.max);
});

// ---- fromModelText --------------------------------------------------------

const { TARGET, OTHER, UNKNOWN } = WORD_LANGS;

test('the model answer is read as one JSON object, fenced or bare', () => {
  const json = JSON.stringify(FULL);
  assert.deepEqual(fromModelText(json, OTHER), FULL);
  assert.deepEqual(fromModelText('```json\n' + json + '\n```', OTHER), FULL);
  assert.deepEqual(fromModelText('Here it is:\n' + json, OTHER), FULL);
});

test('a reasoning model\'s <think> block is stripped before the JSON is looked for', () => {
  const json = JSON.stringify(FULL);
  const think = '<think>The user wants {"translation": "奔"} — no, {a JSON object}.</think>';
  assert.deepEqual(fromModelText(think + '\n' + json, OTHER), FULL);
  assert.deepEqual(fromModelText('<THINK>\n{x}\n</THINK>\n```json\n' + json + '\n```', OTHER), FULL);
  throwsInvalid(() => fromModelText('<think>{"translation": "跑"}</think>\n跑', OTHER), 'only the think block has JSON');
});

test('an answer that is not an entry throws invalidEntry — no line guessing, no translation-only rescue', () => {
  throwsInvalid(() => fromModelText('跑\n/rʌn/', OTHER), 'plain lines');
  throwsInvalid(() => fromModelText('{"translation": "跑", "phonetics": [', OTHER), 'truncated JSON');
  throwsInvalid(() => fromModelText('{"phonetic": "/rʌn/"}', OTHER), 'old shape without translation');
  throwsInvalid(() => fromModelText('["跑"]', OTHER), 'an array, not an object');
  throwsInvalid(() => fromModelText('{"translation": ""}', OTHER), 'empty translation');
  // A wrong-typed optional field is not one of the three: the rest stands.
  assert.deepEqual(fromModelText('{"translation": "跑", "phonetic": "/rʌn/", "senses": "v."}', OTHER),
    { translation: '跑', monolingual: false, phonetics: [], senses: [], examples: [], forms: [] });
});

test('fromModelText stamps monolingual from the word\'s language, or from the model when that is unknown', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const answer = (monolingual) => JSON.stringify({ translation: 'liked by many people', monolingual });
  // A known language decides, whatever the model says.
  assert.equal(fromModelText(answer(false), TARGET).monolingual, true);
  assert.equal(fromModelText(answer(true), OTHER).monolingual, false);
  assert.equal(fromModelText(JSON.stringify({ translation: '跑' }), TARGET).monolingual, true);
  assert.equal(warn.mock.callCount(), 0);
  // An unknown one takes the model's answer.
  assert.equal(fromModelText(answer(true), UNKNOWN).monolingual, true);
  assert.equal(fromModelText(answer(false), UNKNOWN).monolingual, false);
  assert.equal(warn.mock.callCount(), 0);
  // A missing answer reads as the bilingual entry, and is named in the log.
  assert.equal(fromModelText(JSON.stringify({ translation: '跑' }), UNKNOWN).monolingual, false);
  assert.deepEqual(warn.mock.calls.at(-1).arguments[1], ['monolingual: missing']);
  // A wrong-typed one is dropped like any other optional field.
  assert.equal(fromModelText(answer('yes'), UNKNOWN).monolingual, false);
  assert.deepEqual(warn.mock.calls.at(-1).arguments[1], ['monolingual: not a boolean']);
  // The caller always says which of the three it asked for.
  for (const wordLang of [undefined, '', 'same', true]) {
    assert.throws(() => fromModelText(answer(true), wordLang), TypeError, String(wordLang));
  }
});

test('a cross-language example needs its translation; a monolingual one does not', () => {
  const examples = [{ source: 'I run every day.', target: '' }, { source: 'She runs.', target: '她跑。' }];
  assert.deepEqual(normalize({ translation: '跑', examples }).examples, [examples[1]]);
  assert.deepEqual(normalize({ translation: 'to move fast on foot', monolingual: true, examples }).examples, examples);
  assert.deepEqual(fromModelText(JSON.stringify({ translation: '跑', examples }), OTHER).examples, [examples[1]]);
  assert.deepEqual(fromModelText(JSON.stringify({ translation: 'to move fast', examples }), TARGET).examples, examples);
});

test('normalize takes monolingual from the caller when the caller knows, and then never reads the model\'s', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const examples = [{ source: 'I run every day.', target: '' }];
  // The caller's answer wins either way, and the model's is not even checked.
  assert.equal(normalize({ translation: 'to move fast', monolingual: false, examples }, { monolingual: true }).monolingual, true);
  assert.deepEqual(normalize({ translation: 'to move fast', examples }, { monolingual: true }).examples, examples);
  assert.equal(normalize({ translation: '跑', monolingual: true, examples }, { monolingual: false }).monolingual, false);
  assert.deepEqual(normalize({ translation: '跑', monolingual: true, examples }, { monolingual: false }).examples, []);
  assert.equal(normalize({ translation: '跑', monolingual: 'yes' }, { monolingual: false }).monolingual, false);
  assert.equal(warn.mock.calls.filter((call) => call.arguments[1].some((d) => d.startsWith('monolingual'))).length, 0);
  // Without the option the model's own answer decides.
  assert.equal(normalize({ translation: 'to move fast', monolingual: true }).monolingual, true);
  assert.equal(normalize({ translation: 'to move fast', monolingual: true }, {}).monolingual, true);
  // An option that is not a boolean is the caller's bug, not the model's: it throws.
  for (const monolingual of [undefined, null, 'true', 1]) {
    assert.throws(() => normalize({ translation: '跑' }, { monolingual }), TypeError, String(monolingual));
  }
  assert.throws(() => normalize({ translation: '跑' }, null), TypeError);
});

// ---- prompt and validator agree -------------------------------------------

test('the prompt names exactly the keys the validator reads', () => {
  assert.ok(RULES.other.startsWith(PROMPT_MARK));
  assert.doesNotMatch(RULES.other, /\{targetLang\}/, 'the rules are appended after substitution');
  // Top-level keys: the `- "key":` lines. Item keys: every other quoted name
  // followed by a colon.
  const topLevel = [...RULES.other.matchAll(/^- "([a-z]+)":/gm)].map((m) => m[1]);
  assert.deepEqual(topLevel, Object.keys(FIELDS));
  const itemKeys = new Set([...RULES.other.matchAll(/\{([^}]*)\}/g)]
    .flatMap((m) => [...m[1].matchAll(/"([a-z]+)":/g)].map((k) => k[1])));
  const expected = new Set(Object.values(FIELDS).flatMap((field) => Object.keys(field.item || {})));
  assert.deepEqual([...itemKeys].sort(), [...expected].sort());
  for (const [key, field] of Object.entries(FIELDS)) {
    if (field.max) assert.match(RULES.other, new RegExp(`- "${key}": array \\(at most ${field.max}\\)`));
  }
});

test('the phonetics asked for are the translation\'s, in the target language (D-487)', () => {
  const line = RULES.other.split('\n').find((row) => row.startsWith('- "phonetics":'));
  assert.match(line, /the pronunciation of the word in "translation", in the target language\./);
  assert.match(line, /When the target language is English give two items, "UK" and "US", each IPA wrapped in slashes/);
  assert.match(line, /For any other target language give one item with an empty "label", in that language's usual notation \(pinyin with tone marks for Chinese/);
  assert.doesNotMatch(line, /source/, 'the source word has its own speaker; its pronunciation is not asked for');
});

test('the rules the model is asked to follow are unchanged by the offline dictionary, word for word', () => {
  // sha256 of the bilingual rules (RULES.other) at 90812ca, before the dictionary's credits existed.
  // Credits are the dictionary's, beside the entry: never a key the model is
  // asked for, so a change here is a prompt change and needs its own review.
  assert.equal(createHash('sha256').update(RULES.other).digest('hex'),
    '6798039c7cad1d2f078886b97fd2d861e2a711c965eee4e67b5b1b6fdd5dc901');
  assert.equal(PROMPT_MARK, 'OUTPUT FORMAT (dictionary entry):');
  assert.equal('credits' in FIELDS, false);
  assert.doesNotMatch(RULES.other, /credit/i);
});

const keysOf = (text) => [...text.matchAll(/^- "([a-z]+)":/gm)].map((m) => m[1]);
const lineOf = (rules, key) => rules.split('\n').find((row) => row.startsWith(`- "${key}":`));

test('the monolingual rules name the same keys and ask for a monolingual entry', () => {
  const rules = RULES.target;
  const lines = rules.split('\n');
  assert.equal(lines[0], PROMPT_MARK, 'the mock server and the model key on the first line');
  assert.match(lines[1], /already in the target language.*do not translate it/);
  assert.ok(rules.endsWith('\n' + globalThis.DictEntry.FORMAT_OVERRIDE));
  assert.deepEqual(keysOf(rules), keysOf(RULES.other));
  assert.match(lineOf(rules, 'translation'), /a short gloss of the word in the same language/);
  assert.match(lineOf(rules, 'phonetics'), /the pronunciation of the looked-up word itself/);
  assert.match(lineOf(rules, 'examples'), /Leave "target" empty: the reader needs no translation/);
  assert.doesNotMatch(rules, /translation in the target language|the word in "translation"/,
    'nothing asks for a translation of a word that needs none');
  // Senses and forms read the same in both.
  for (const key of ['senses', 'forms']) assert.equal(lineOf(rules, key), lineOf(RULES.other, key), key);
});

test('the conditional rules ask the model to choose, and to say which entry it wrote', () => {
  const rules = RULES.unknown;
  const lines = rules.split('\n');
  assert.equal(lines[0], PROMPT_MARK);
  assert.match(lines[1], /^First decide whether the word is already a word of the target language/);
  assert.ok(rules.endsWith('\n' + globalThis.DictEntry.FORMAT_OVERRIDE));
  // One key more than the bilingual rules, first, so it is decided first.
  assert.deepEqual(keysOf(rules), ['monolingual', ...keysOf(RULES.other)]);
  assert.match(lineOf(rules, 'monolingual'), /true when you wrote the monolingual entry.*false when you translated it\. Required\./);
  // Each key that differs carries both readings: the bilingual one, then the
  // monolingual one.
  for (const key of ['translation', 'phonetics', 'examples']) {
    const line = lineOf(rules, key);
    assert.ok(line.startsWith(lineOf(RULES.other, key)), `${key}: the bilingual reading first`);
    assert.match(line, / In a monolingual entry: /, key);
  }
  for (const key of ['senses', 'forms']) assert.equal(lineOf(rules, key), lineOf(RULES.other, key), key);
  // The bilingual and monolingual sets never ask for it.
  assert.equal(keysOf(RULES.other).includes('monolingual'), false);
  assert.equal(keysOf(RULES.target).includes('monolingual'), false);
});

test('RULES holds one frozen set of rules per WORD_LANGS value', () => {
  assert.deepEqual(Object.keys(RULES).sort(), Object.values(WORD_LANGS).sort());
  assert.ok(Object.isFrozen(RULES));
  assert.equal(new Set(Object.values(RULES)).size, Object.keys(RULES).length, 'each mode has rules of its own');
  for (const rules of Object.values(RULES)) assert.ok(rules.startsWith(PROMPT_MARK + '\n'));
});

test('the word prompts are built from the shared rules', () => {
  const prompts = repoSource('background/prompts.js');
  assert.match(prompts, /const \{ WORD_LANGS, RULES \} = globalThis\.DictEntry;/);
  assert.match(prompts, /Object\.entries\(RULES\)/, 'WORD_MODES is keyed by the modes RULES has');
  assert.doesNotMatch(prompts, /"phonetic"/, 'the old {translation, phonetic} shape is gone');
});

// ---- entryFor -------------------------------------------------------------

test('only a model engine answer (ai or blab) or the dictionary\'s, in word mode, carries an entry', () => {
  for (const engine of ['ai', 'blab']) {
    assert.deepEqual(entryFor('word', { engine, translation: '跑', entry: FULL }), FULL, engine);
    assert.equal(entryFor('text', { engine, translation: '跑' }), null, engine);
    assert.throws(() => entryFor('word', { engine, translation: '跑' }), /a model word-mode answer carries no entry/, engine);
  }
  assert.equal(entryFor('word', { engine: 'builtin', translation: '跑' }), null);
  assert.equal(entryFor('word', null), null);
});

// ---- the offline dictionary (D-561) ----------------------------------------

const JMDICT = { label: 'JMdict © EDRDG', href: 'https://www.edrdg.org/edrdg/licence.html' };
const TATOEBA = { label: 'Tatoeba', href: 'https://tatoeba.org/' };
// DictPack.toResponse() always sends a credits list, empty when the pack has
// none.
const dictAnswer = (extra = {}) => ({ engine: DICT_ENGINE, translation: '跑', entry: FULL, credits: [], ...extra });

test('the dictionary engine is \'dict\', and it is not an engine a user picks', () => {
  assert.equal(DICT_ENGINE, 'dict');
  assert.equal(globalThis.Engines.ENGINES.includes(DICT_ENGINE), false);
  assert.equal(globalThis.Engines.isModelEngine(DICT_ENGINE), false);
});

test('a dictionary answer in word mode carries its entry, normalized like a model\'s', () => {
  assert.deepEqual(entryFor('word', dictAnswer()), FULL);
  // normalize, not a pass-through: unknown keys go, a wrong-typed list is empty.
  assert.deepEqual(entryFor('word', dictAnswer({ entry: { translation: ' 跑 ', senses: 'v.', extra: 1 } })),
    { translation: '跑', monolingual: false, phonetics: [], senses: [], examples: [], forms: [] });
  assert.equal(entryFor('text', dictAnswer()), null);
});

test('a dictionary word answer without an entry throws, as a model\'s does', () => {
  assert.throws(() => entryFor('word', { engine: DICT_ENGINE, translation: '跑' }),
    /a dictionary word-mode answer carries no entry/);
  assert.throws(() => entryFor('word', { engine: DICT_ENGINE, entry: null }), /carries no entry/);
  // An entry with no translation is the same hard failure as a model's.
  throwsInvalid(() => entryFor('word', { engine: DICT_ENGINE, entry: { senses: [] } }), 'no translation');
});

test('a dictionary answer\'s credits ride on the entry as they are', () => {
  const entry = entryFor('word', dictAnswer({ credits: [JMDICT, TATOEBA] }));
  assert.deepEqual(entry.credits, [JMDICT, TATOEBA]);
  assert.deepEqual({ ...entry, credits: undefined }, { ...FULL, credits: undefined });
  // As they are: DictPack.parsePack() is the one check (D-686), so a label is
  // not trimmed here and nothing is dropped or warned about.
  const padded = [{ label: ' Tatoeba ', href: TATOEBA.href }];
  assert.deepEqual(entryFor('word', dictAnswer({ credits: padded })).credits, padded);
  // An empty list: no key at all, not an empty list.
  assert.equal('credits' in entryFor('word', dictAnswer()), false);
});

test('a model answer never carries credits, whatever it sends', () => {
  for (const engine of ['ai', 'blab']) {
    const entry = entryFor('word', { engine, translation: '跑', entry: { ...FULL, credits: [TATOEBA] }, credits: [JMDICT] });
    assert.deepEqual(entry, FULL, engine);
    assert.equal('credits' in entry, false, engine);
  }
  assert.equal(entryFor('word', { engine: 'builtin', translation: '跑', credits: [TATOEBA] }), null);
});

// ---- render ---------------------------------------------------------------

// The least DOM render() touches. innerHTML is allowed exactly one value, the
// speaker glyph; any other write fails the test on the spot.
const ICON = '<svg data-icon="speaker"></svg>';
class FakeElement {
  constructor(doc, tag) {
    this.ownerDocument = doc;
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.attributes = {};
    this.dataset = {};
    this.className = '';
    this.hidden = false;
    this._text = '';
  }
  set textContent(value) { this.children = []; this._text = String(value); }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  set innerHTML(value) {
    assert.equal(value, ICON, 'render() wrote HTML that is not the speaker glyph');
    this._text = '';
  }
  get childElementCount() { return this.children.length; }
  appendChild(child) { this.children.push(child); return child; }
  replaceChildren() { this.children = []; this._text = ''; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  find(cls) {
    const out = [];
    const walk = (node) => {
      if (node.className.split(' ').includes(cls)) out.push(node);
      node.children.forEach(walk);
    };
    walk(this);
    return out;
  }
}
// A text node: no class, no children, just its text.
const textNode = (value) => ({ nodeType: 3, className: '', children: [], textContent: String(value) });
const doc = { createElement: (tag) => new FakeElement(doc, tag), createTextNode: textNode };
const MESSAGES = {
  dictUK: 'UK', dictUS: 'US', dictExamples: 'Examples', dictForms: 'Forms', pronounceTranslation: 'Read the translation',
  pronounceOriginal: 'Read the original', dictCredits: 'Sources:',
};

// `猫` looked up into English: two labelled IPA rows for the translation.
const CAT = { translation: 'cat', phonetics: [{ label: 'UK', ipa: '/kæt/' }, { label: 'US', ipa: '/kæt/' }] };

// `log` records, in order, every visibility change a speaker gets and every
// time the container is emptied.
function stubSpeech(log = []) {
  const bound = [];
  const speech = {
    SPEAKER_ICON: ICON,
    bindSpeakButton: (button, resolve) => {
      bound.push({ button, resolve });
      return (visible) => log.push(`${button.dataset.accent || '-'}:${visible}`);
    },
  };
  return { bound, speech };
}

// The looked-up text: a monolingual entry's speakers read it.
const LOOKED = 'word';

function draw(entry, targetLang = 'zh-CN', container = new FakeElement(doc, 'div'), text = LOOKED) {
  const { bound, speech } = stubSpeech();
  render(container, entry, { targetLang, text, t: (key) => MESSAGES[key], speech });
  return { container, bound };
}

test('render draws every block, and the unlabelled speaker reads the translation in the target language', () => {
  const { container, bound } = draw(normalize(FULL), 'zh-CN');
  assert.equal(container.hidden, false);
  assert.deepEqual(container.find('ai-translator-dict-accent'), []);
  assert.deepEqual(container.find('ai-translator-dict-ipa').map((n) => n.textContent), ['pǎo']);
  assert.deepEqual(container.find('ai-translator-dict-pos').map((n) => n.textContent), ['v.', 'n.']);
  assert.deepEqual(container.find('ai-translator-dict-defs').map((n) => n.textContent), ['跑; 奔跑', '跑步']);
  assert.deepEqual(container.find('ai-translator-dict-heading').map((n) => n.textContent), ['Examples', 'Forms']);
  assert.deepEqual(container.find('ai-translator-dict-example-source').map((n) => n.textContent), ['I run every day.']);
  assert.deepEqual(container.find('ai-translator-dict-form-value').map((n) => n.textContent), ['ran']);
  assert.doesNotMatch(container.textContent, /UK|US/);
  assert.deepEqual(bound.map((b) => b.resolve()), [{ text: '跑', lang: 'zh-CN' }]);
  assert.deepEqual(bound.map((b) => b.button.attributes['aria-label']), ['Read the translation']);
});

test('an English translation has UK and US rows whose speakers read it in en-GB / en-US', () => {
  const { container, bound } = draw(normalize(CAT), 'en');
  assert.deepEqual(container.find('ai-translator-dict-accent').map((n) => n.textContent), ['UK', 'US']);
  assert.deepEqual(container.find('ai-translator-dict-ipa').map((n) => n.textContent), ['/kæt/', '/kæt/']);
  assert.deepEqual(bound.map((b) => b.resolve()), [{ text: 'cat', lang: 'en-GB' }, { text: 'cat', lang: 'en-US' }]);
  assert.deepEqual(bound.map((b) => b.button.attributes['aria-label']), ['Read the translation', 'Read the translation']);
});

test('an unlabelled row speaks in whichever language the request translated into', () => {
  const { bound } = draw(normalize({ translation: 'はしる', phonetics: [{ label: '', ipa: 'hashiru' }] }), 'ja');
  assert.deepEqual(bound.map((b) => b.resolve()), [{ text: 'はしる', lang: 'ja' }]);
});

test('a UK/US label under a non-English target is dropped and the row is read in the target language', () => {
  // A stale or malformed label from the model must not pick an English voice
  // for a Spanish word: the speech layer trusts the declared language.
  const { container, bound } = draw(normalize({ translation: 'correr', phonetics: [{ label: 'US', ipa: 'koˈreɾ' }] }), 'es');
  assert.deepEqual(container.find('ai-translator-dict-accent'), []);
  assert.deepEqual(container.find('ai-translator-dict-ipa').map((n) => n.textContent), ['koˈreɾ']);
  assert.doesNotMatch(container.textContent, /UK|US/);
  assert.deepEqual(bound.map((b) => b.button.dataset.accent), ['']);
  assert.deepEqual(bound.map((b) => b.resolve()), [{ text: 'correr', lang: 'es' }]);
});

test('an English target with a region subtag keeps the UK and US voices', () => {
  for (const targetLang of ['en-US', 'en-GB', 'EN']) {
    const { container, bound } = draw(normalize(CAT), targetLang);
    assert.deepEqual(container.find('ai-translator-dict-accent').map((n) => n.textContent), ['UK', 'US'], targetLang);
    assert.deepEqual(bound.map((b) => b.resolve()), [{ text: 'cat', lang: 'en-GB' }, { text: 'cat', lang: 'en-US' }], targetLang);
  }
});

test('a dictionary entry with credits ends in one line of links that open in a new tab', () => {
  const { container } = draw(entryFor('word', dictAnswer({ credits: [JMDICT, TATOEBA] })));
  const [line] = container.find('ai-translator-dict-credits');
  assert.ok(line, 'the credits line is drawn');
  assert.equal(container.children.at(-1), line, 'the credits line is the last block');
  // Its own line, not a section: sections stack their rows.
  assert.equal(line.className, 'ai-translator-dict-credits');
  // Prefix, first link, ' · ', second link; a separator only between links.
  assert.deepEqual(line.children.map((n) => n.className || n.textContent),
    ['ai-translator-dict-credits-prefix', 'ai-translator-dict-credit-link', ' · ', 'ai-translator-dict-credit-link']);
  assert.equal(line.textContent, `Sources:${JMDICT.label} · ${TATOEBA.label}`);
  assert.deepEqual(line.find('ai-translator-dict-credits-prefix').map((n) => n.textContent), ['Sources:']);
  const links = line.find('ai-translator-dict-credit-link');
  assert.deepEqual(links.map((a) => a.tagName), ['A', 'A']);
  assert.deepEqual(links.map((a) => a.textContent), [JMDICT.label, TATOEBA.label]);
  assert.deepEqual(links.map((a) => a.attributes.href), [JMDICT.href, TATOEBA.href]);
  for (const a of links) {
    assert.equal(a.attributes.target, '_blank');
    assert.deepEqual(a.attributes.rel.split(' ').sort(), ['noopener', 'noreferrer']);
  }
});

test('an entry without credits draws no credits line, and credits alone are not content', () => {
  for (const entry of [entryFor('word', dictAnswer()), entryFor('word', { engine: 'ai', entry: FULL, credits: [TATOEBA] })]) {
    const { container } = draw(entry);
    assert.deepEqual(container.find('ai-translator-dict-credits'), []);
    assert.equal(container.childElementCount, 4);
  }
  // A translation-only dictionary entry with credits: nothing to credit, so
  // the container stays hidden.
  const bare = entryFor('word', { engine: DICT_ENGINE, entry: { translation: '跑' }, credits: [TATOEBA] });
  assert.equal(hasContent(bare), false);
  assert.equal(draw(bare).container.hidden, true);
});

test('a credit label comes out as text, never as markup', () => {
  const evil = '<img src=x onerror="alert(1)">';
  const { container } = draw(entryFor('word', dictAnswer({ credits: [{ label: evil, href: TATOEBA.href }] })));
  assert.deepEqual(container.find('ai-translator-dict-credit-link').map((a) => a.textContent), [evil]);
});

test('the content scripts load shared/lang-tags.js before shared/dict-entry.js', () => {
  const js = JSON.parse(repoSource('manifest.json')).content_scripts
    .filter((entry) => entry.js.includes('shared/dict-entry.js'));
  assert.ok(js.length > 0, 'the manifest loads shared/dict-entry.js');
  for (const { js: list } of js) {
    const at = list.indexOf('shared/lang-tags.js');
    assert.ok(at >= 0 && at < list.indexOf('shared/dict-entry.js'), 'lang-tags.js must come before dict-entry.js');
  }
});

test('a translation-only entry draws nothing and hides the container', () => {
  const { container, bound } = draw(normalize({ translation: '跑' }));
  assert.equal(container.childElementCount, 0);
  assert.equal(container.hidden, true);
  assert.equal(bound.length, 0);
});

test('hasContent is true exactly when render draws a block', () => {
  assert.equal(hasContent(normalize({ translation: '跑' })), false);
  assert.equal(hasContent(normalize(FULL)), true);
  for (const key of Object.keys(FIELDS).filter((name) => FIELDS[name].kind === 'list')) {
    const one = { translation: '跑', [key]: FULL[key].slice(0, 1) };
    const entry = normalize(one);
    assert.equal(hasContent(entry), true, key);
    const { container } = draw(entry);
    assert.equal(container.hidden, false, key);
    assert.equal(container.childElementCount, 1, key);
  }
});

test('null clears what was drawn before', () => {
  const container = new FakeElement(doc, 'div');
  const speech = { SPEAKER_ICON: ICON, bindSpeakButton: () => () => {} };
  render(container, normalize(FULL), { targetLang: 'zh-CN', text: LOOKED, t: (k) => k, speech });
  render(container, null, { t: (k) => k, speech });
  assert.equal(container.childElementCount, 0);
  assert.equal(container.hidden, true);
  assert.throws(() => render(container, 'run', { targetLang: 'zh-CN', text: LOOKED, t: (k) => k, speech }), TypeError);
});

test('drawing an entry without the target language throws: an unlabelled row would have no voice', () => {
  const container = new FakeElement(doc, 'div');
  const speech = { SPEAKER_ICON: ICON, bindSpeakButton: () => () => {} };
  for (const targetLang of [undefined, '', null]) {
    assert.throws(() => render(container, normalize(FULL), { targetLang, text: LOOKED, t: (k) => k, speech }), /targetLang is required/);
  }
});

test('drawing an entry without the looked-up text throws: a monolingual row would have nothing to say', () => {
  const container = new FakeElement(doc, 'div');
  const speech = { SPEAKER_ICON: ICON, bindSpeakButton: () => () => {} };
  for (const text of [undefined, null, '', '  ', 7]) {
    assert.throws(() => render(container, normalize(FULL), { targetLang: 'zh-CN', text, t: (k) => k, speech }),
      /options\.text is required/, JSON.stringify(text));
  }
});

// `popular` looked up with English as the target: a monolingual entry.
const POPULAR = {
  translation: 'liked by many people',
  phonetics: [{ label: 'UK', ipa: '/ˈpɒpjələ/' }, { label: 'US', ipa: '/ˈpɑːpjələr/' }],
  senses: [{ pos: 'adj.', defs: ['liked or enjoyed by a large number of people'] }],
  examples: [{ source: 'It is a popular song.', target: '' }],
  forms: [],
};

test('a monolingual entry reads the looked-up word and draws its examples without empty rows', () => {
  for (const targetLang of ['en', 'en-GB', 'en-US']) {
    const { container, bound } = draw(normalize({ ...POPULAR, monolingual: true }), targetLang, undefined, ' popular ');
    assert.deepEqual(container.find('ai-translator-dict-accent').map((n) => n.textContent), ['UK', 'US']);
    assert.deepEqual(container.find('ai-translator-dict-ipa').map((n) => n.textContent), ['/ˈpɒpjələ/', '/ˈpɑːpjələr/']);
    assert.deepEqual(bound.map((b) => b.resolve()), [{ text: 'popular', lang: 'en-GB' }, { text: 'popular', lang: 'en-US' }]);
    assert.deepEqual(bound.map((b) => b.button.attributes['aria-label']), ['Read the original', 'Read the original']);
    assert.deepEqual(container.find('ai-translator-dict-example-source').map((n) => n.textContent), ['It is a popular song.']);
    assert.deepEqual(container.find('ai-translator-dict-example-target'), [], 'no empty translation row');
  }
  // The same rows in a cross-language entry are the translation's: they read
  // "translation", and the example with no translation is not kept.
  const { container, bound } = draw(normalize(POPULAR), 'en', undefined, 'popular');
  assert.deepEqual(bound.map((b) => b.resolve().text), ['liked by many people', 'liked by many people']);
  assert.deepEqual(bound.map((b) => b.button.attributes['aria-label']), ['Read the translation', 'Read the translation']);
  assert.deepEqual(container.find('ai-translator-dict-example-source'), []);
});

test('malicious model strings come out as text, never as markup', () => {
  const evil = '<img src=x onerror="alert(1)">';
  const entry = normalize({
    translation: evil,
    phonetics: [{ label: 'US', ipa: evil }],
    senses: [{ pos: evil, defs: [evil] }],
    examples: [{ source: evil, target: evil }],
    forms: [{ label: evil, value: evil }],
  });
  // FakeElement.innerHTML asserts on any value but the glyph, so reaching the
  // end is the proof that no model string went through HTML.
  const { container } = draw(entry);
  assert.equal(container.textContent.split(evil).length - 1, 7);
});

test('drawing again stops the old entry\'s speakers before their buttons leave', () => {
  const container = new FakeElement(doc, 'div');
  const log = [];
  const realReplace = container.replaceChildren.bind(container);
  container.replaceChildren = () => { log.push('replaced'); realReplace(); };
  const t = (key) => MESSAGES[key];
  render(container, normalize(CAT), { targetLang: 'en', text: LOOKED, t, speech: stubSpeech(log).speech });
  assert.deepEqual(log, ['replaced']);
  render(container, null, { t, speech: stubSpeech(log).speech });
  assert.deepEqual(log, ['replaced', 'UK:false', 'US:false', 'replaced']);
  // Nothing left to stop the next time.
  render(container, null, { t, speech: stubSpeech(log).speech });
  assert.deepEqual(log.slice(4), ['replaced']);
});

test('the old shape is gone from the service worker', () => {
  assert.doesNotMatch(workerSource(), /parseWordTranslation|"phonetic"|\.phonetic\b/);
  assert.match(repoSource('background/ai-translate.js'), /DictEntry\.fromModelText\(/);
});
