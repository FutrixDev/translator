// The dictionary entry has one owner, shared/dict-entry.js (D-469/D-470):
//
//   - isLookup() alone decides what is looked up (D-473–D-475), checked
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
//   - only an AI answer in word mode carries an entry (entryFor).
//
// That the dialog and the card draw the same entry is checked on the page:
// test/e2e/dictionary-entry.spec.js compares the two.
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { repoSource, workerSource } from './helpers/sources.mjs';

// render() reads LangTags; the manifest loads it first (checked below).
await import('../../shared/lang-tags.js');
await import('../../shared/dict-entry.js');
const {
  FIELDS, MAX_TEXT, OUTPUT_RULES, PROMPT_MARK, isLookup, normalize, fromModelText, entryFor, render,
} = globalThis.DictEntry;

// `run` looked up into zh-CN: the phonetics are the translation's, pinyin with
// no label (D-487).
const FULL = {
  translation: '跑',
  phonetics: [{ label: '', ipa: 'pǎo' }],
  senses: [{ pos: 'v.', defs: ['跑', '奔跑'] }, { pos: 'n.', defs: ['跑步'] }],
  examples: [{ source: 'I run every day.', target: '我每天跑步。' }],
  forms: [{ label: '过去式', value: 'ran' }],
};

const throwsInvalid = (fn, reason) => assert.throws(fn, (error) => {
  assert.equal(error.invalidEntry, true, `${reason}: not marked invalidEntry`);
  return true;
}, reason);

// ---- isLookup (D-473) -------------------------------------------------------

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
  ['run.', false],
  // trimmed first
  ['  give up \n', true],
  ['', false],
  ['   ', false],
  // 1–3 words, by spaces
  ['look forward to it', false],
  ['state-of-the-art', true],
  // 1–4 characters where words are not spaced, by code point
  ['一石二鳥', true],
  ['一石二鸟吧', false],
  ['ありがとう', false],
  ['猫 狗', true],
  ['안녕', true],
  ['𠮷野家', true],
  // any sentence punctuation, half- or full-width
  ['run!', false],
  ['run?', false],
  ['跑！', false],
  ['跑？', false],
  ['跑。', false],
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

test('isLookup answers the D-473–D-475 table', () => {
  for (const [text, expected] of LOOKUP_TABLE) {
    assert.equal(isLookup(text), expected, JSON.stringify(text));
  }
  assert.equal(isLookup(null), false);
  assert.equal(isLookup(undefined), false);
});

// ---- normalize ------------------------------------------------------------

test('a full entry comes back field for field', () => {
  assert.deepEqual(normalize(FULL), FULL);
});

test('missing lists are empty, and only translation is required', () => {
  assert.deepEqual(normalize({ translation: ' 跑 ' }),
    { translation: '跑', phonetics: [], senses: [], examples: [], forms: [] });
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

test('extra keys are ignored and not carried, at the top and in items', () => {
  const entry = normalize({ ...FULL, note: 'x', senses: [{ pos: 'v.', defs: ['跑'], rank: 1 }] });
  assert.deepEqual(Object.keys(entry), ['translation', 'phonetics', 'senses', 'examples', 'forms']);
  assert.deepEqual(entry.senses, [{ pos: 'v.', defs: ['跑'] }]);
});

test('empty arrays stay empty and empty items are dropped', () => {
  const entry = normalize({
    translation: '跑',
    phonetics: [{ label: 'UK', ipa: '' }],
    senses: [{ pos: 'v.', defs: ['', '  '] }, { pos: '', defs: ['跑'] }],
    examples: [{ source: 'I run.', target: '' }],
    forms: [],
  });
  assert.deepEqual(entry.phonetics, []);
  assert.deepEqual(entry.senses, [{ pos: '', defs: ['跑'] }]);
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

test('the model answer is read as one JSON object, fenced or bare', () => {
  const json = JSON.stringify(FULL);
  assert.deepEqual(fromModelText(json), FULL);
  assert.deepEqual(fromModelText('```json\n' + json + '\n```'), FULL);
  assert.deepEqual(fromModelText('Here it is:\n' + json), FULL);
});

test('a reasoning model\'s <think> block is stripped before the JSON is looked for', () => {
  const json = JSON.stringify(FULL);
  const think = '<think>The user wants {"translation": "奔"} — no, {a JSON object}.</think>';
  assert.deepEqual(fromModelText(think + '\n' + json), FULL);
  assert.deepEqual(fromModelText('<THINK>\n{x}\n</THINK>\n```json\n' + json + '\n```'), FULL);
  throwsInvalid(() => fromModelText('<think>{"translation": "跑"}</think>\n跑'), 'only the think block has JSON');
});

test('an answer that is not an entry throws invalidEntry — no line guessing, no translation-only rescue', () => {
  throwsInvalid(() => fromModelText('跑\n/rʌn/'), 'plain lines');
  throwsInvalid(() => fromModelText('{"translation": "跑", "phonetics": ['), 'truncated JSON');
  throwsInvalid(() => fromModelText('{"phonetic": "/rʌn/"}'), 'old shape without translation');
  throwsInvalid(() => fromModelText('["跑"]'), 'an array, not an object');
  throwsInvalid(() => fromModelText('{"translation": ""}'), 'empty translation');
  // A wrong-typed optional field is not one of the three: the rest stands.
  assert.deepEqual(fromModelText('{"translation": "跑", "phonetic": "/rʌn/", "senses": "v."}'),
    { translation: '跑', phonetics: [], senses: [], examples: [], forms: [] });
});

// ---- prompt and validator agree -------------------------------------------

test('the prompt names exactly the keys the validator reads', () => {
  assert.ok(OUTPUT_RULES.startsWith(PROMPT_MARK));
  assert.doesNotMatch(OUTPUT_RULES, /\{targetLang\}/, 'the rules are appended after substitution');
  // Top-level keys: the `- "key":` lines. Item keys: every other quoted name
  // followed by a colon.
  const topLevel = [...OUTPUT_RULES.matchAll(/^- "([a-z]+)":/gm)].map((m) => m[1]);
  assert.deepEqual(topLevel, Object.keys(FIELDS));
  const itemKeys = new Set([...OUTPUT_RULES.matchAll(/\{([^}]*)\}/g)]
    .flatMap((m) => [...m[1].matchAll(/"([a-z]+)":/g)].map((k) => k[1])));
  const expected = new Set(Object.values(FIELDS).flatMap((field) => Object.keys(field.item || {})));
  assert.deepEqual([...itemKeys].sort(), [...expected].sort());
  for (const [key, field] of Object.entries(FIELDS)) {
    if (field.max) assert.match(OUTPUT_RULES, new RegExp(`- "${key}": array \\(at most ${field.max}\\)`));
  }
});

test('the phonetics asked for are the translation\'s, in the target language (D-487)', () => {
  const line = OUTPUT_RULES.split('\n').find((row) => row.startsWith('- "phonetics":'));
  assert.match(line, /the pronunciation of the word in "translation", in the target language\./);
  assert.match(line, /When the target language is English give two items, "UK" and "US", each IPA wrapped in slashes/);
  assert.match(line, /For any other target language give one item with an empty "label", in that language's usual notation \(pinyin with tone marks for Chinese/);
  assert.doesNotMatch(line, /source/, 'the source word has its own speaker; its pronunciation is not asked for');
});

test('both word prompts are built from the shared rules', () => {
  const prompts = repoSource('background/prompts.js');
  assert.match(prompts, /DictEntry\.OUTPUT_RULES/);
  assert.doesNotMatch(prompts, /"phonetic"/, 'the old {translation, phonetic} shape is gone');
});

// ---- entryFor -------------------------------------------------------------

test('only an AI answer in word mode carries an entry', () => {
  assert.deepEqual(entryFor('word', { engine: 'ai', translation: '跑', entry: FULL }), FULL);
  assert.equal(entryFor('word', { engine: 'builtin', translation: '跑' }), null);
  assert.equal(entryFor('text', { engine: 'ai', translation: '跑' }), null);
  assert.throws(() => entryFor('word', { engine: 'ai', translation: '跑' }), /carries no entry/);
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
const doc = { createElement: (tag) => new FakeElement(doc, tag) };
const MESSAGES = { dictUK: 'UK', dictUS: 'US', dictExamples: 'Examples', dictForms: 'Forms', pronounceTranslation: 'Read the translation' };

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

function draw(entry, targetLang = 'zh-CN', container = new FakeElement(doc, 'div')) {
  const { bound, speech } = stubSpeech();
  render(container, entry, { targetLang, t: (key) => MESSAGES[key], speech });
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

test('null clears what was drawn before', () => {
  const container = new FakeElement(doc, 'div');
  const speech = { SPEAKER_ICON: ICON, bindSpeakButton: () => () => {} };
  render(container, normalize(FULL), { targetLang: 'zh-CN', t: (k) => k, speech });
  render(container, null, { t: (k) => k, speech });
  assert.equal(container.childElementCount, 0);
  assert.equal(container.hidden, true);
  assert.throws(() => render(container, 'run', { targetLang: 'zh-CN', t: (k) => k, speech }), TypeError);
});

test('drawing an entry without the target language throws: an unlabelled row would have no voice', () => {
  const container = new FakeElement(doc, 'div');
  const speech = { SPEAKER_ICON: ICON, bindSpeakButton: () => () => {} };
  for (const targetLang of [undefined, '', null]) {
    assert.throws(() => render(container, normalize(FULL), { targetLang, t: (k) => k, speech }), /targetLang is required/);
  }
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
  render(container, normalize(CAT), { targetLang: 'en', t, speech: stubSpeech(log).speech });
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
