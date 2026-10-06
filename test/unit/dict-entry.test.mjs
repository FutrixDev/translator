// The dictionary entry has one owner, shared/dict-entry.js (D-469/D-470):
//
//   - normalize() is the only check on what the model sends back: a missing
//     list is empty, a wrong type or an overlong string throws `invalidEntry`,
//     extra keys are dropped, lists past their cap are cut;
//   - the keys the prompt asks for are the keys normalize() reads, because both
//     are built from FIELDS (checked here from the prompt's own text);
//   - render() puts model strings on the page as text, never as HTML;
//   - the input dialog and the selection card both draw with DictEntry.render
//     and neither builds an entry block of its own;
//   - only an AI answer in word mode carries an entry (entryFor).
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

await import('../../shared/dict-entry.js');
const { FIELDS, MAX_TEXT, OUTPUT_RULES, PROMPT_MARK, normalize, fromModelText, entryFor, render } = globalThis.DictEntry;

const repoFile = (rel) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');

const FULL = {
  translation: '跑',
  phonetics: [{ label: 'UK', ipa: '/rʌn/' }, { label: 'US', ipa: '/rʌn/' }],
  senses: [{ pos: 'v.', defs: ['跑', '奔跑'] }, { pos: 'n.', defs: ['跑步'] }],
  examples: [{ source: 'I run every day.', target: '我每天跑步。' }],
  forms: [{ label: '过去式', value: 'ran' }],
};

const throwsInvalid = (fn, reason) => assert.throws(fn, (error) => {
  assert.equal(error.invalidEntry, true, `${reason}: not marked invalidEntry`);
  return true;
}, reason);

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

test('wrong types throw rather than being coerced', () => {
  throwsInvalid(() => normalize(null), 'null');
  throwsInvalid(() => normalize('跑'), 'a string');
  throwsInvalid(() => normalize([FULL]), 'an array');
  throwsInvalid(() => normalize({ translation: 42 }), 'number translation');
  throwsInvalid(() => normalize({ ...FULL, senses: { pos: 'v.' } }), 'senses not an array');
  throwsInvalid(() => normalize({ ...FULL, examples: ['I run.'] }), 'example item a string');
  throwsInvalid(() => normalize({ ...FULL, senses: [{ pos: 'v.', defs: '跑' }] }), 'defs a string');
  throwsInvalid(() => normalize({ ...FULL, senses: [{ pos: 'v.', defs: [1] }] }), 'def a number');
  throwsInvalid(() => normalize({ ...FULL, phonetics: [{ label: 1, ipa: '/rʌn/' }] }), 'label a number');
  throwsInvalid(() => normalize({ ...FULL, forms: [{ label: '过去式', value: ['ran'] }] }), 'form value an array');
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

test('overlong strings throw; overlong lists are cut to their cap', () => {
  const long = 'x'.repeat(MAX_TEXT + 1);
  throwsInvalid(() => normalize({ translation: long }), 'long translation');
  throwsInvalid(() => normalize({ ...FULL, examples: [{ source: long, target: 'y' }] }), 'long example');
  assert.equal(normalize({ translation: 'x'.repeat(MAX_TEXT) }).translation.length, MAX_TEXT);

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

test('an answer that is not an entry throws invalidEntry — no line guessing, no translation-only rescue', () => {
  throwsInvalid(() => fromModelText('跑\n/rʌn/'), 'plain lines');
  throwsInvalid(() => fromModelText('{"translation": "跑", "phonetics": ['), 'truncated JSON');
  throwsInvalid(() => fromModelText('{"translation": "跑", "phonetic": "/rʌn/", "senses": "v."}'), 'senses a string');
  throwsInvalid(() => fromModelText('{"phonetic": "/rʌn/"}'), 'old shape without translation');
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

test('both word prompts are built from the shared rules', () => {
  const prompts = repoFile('background/prompts.js');
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
const MESSAGES = { dictUK: 'UK', dictUS: 'US', dictExamples: 'Examples', dictForms: 'Forms', pronounceOriginal: 'Play' };

function draw(entry) {
  const container = new FakeElement(doc, 'div');
  const bound = [];
  const speech = {
    SPEAKER_ICON: ICON,
    bindSpeakButton: (button, resolve) => { bound.push({ button, resolve }); return () => {}; },
  };
  render(container, entry, { word: 'run', t: (key) => MESSAGES[key], speech });
  return { container, bound };
}

test('render draws every block, and the speaker buttons read the word in en-GB / en-US', () => {
  const { container, bound } = draw(normalize(FULL));
  assert.equal(container.hidden, false);
  assert.deepEqual(container.find('ai-translator-dict-accent').map((n) => n.textContent), ['UK', 'US']);
  assert.deepEqual(container.find('ai-translator-dict-ipa').map((n) => n.textContent), ['/rʌn/', '/rʌn/']);
  assert.deepEqual(container.find('ai-translator-dict-pos').map((n) => n.textContent), ['v.', 'n.']);
  assert.deepEqual(container.find('ai-translator-dict-defs').map((n) => n.textContent), ['跑; 奔跑', '跑步']);
  assert.deepEqual(container.find('ai-translator-dict-heading').map((n) => n.textContent), ['Examples', 'Forms']);
  assert.deepEqual(container.find('ai-translator-dict-example-source').map((n) => n.textContent), ['I run every day.']);
  assert.deepEqual(container.find('ai-translator-dict-form-value').map((n) => n.textContent), ['ran']);
  assert.deepEqual(bound.map((b) => b.resolve()), [{ text: 'run', lang: 'en-GB' }, { text: 'run', lang: 'en-US' }]);
});

test('a translation-only entry draws nothing and hides the container', () => {
  const { container, bound } = draw(normalize({ translation: '跑' }));
  assert.equal(container.childElementCount, 0);
  assert.equal(container.hidden, true);
  assert.equal(bound.length, 0);
});

test('a phonetic with no label shows no UK/US and lets speech detect the language', () => {
  const { container, bound } = draw(normalize({ translation: 'cat', phonetics: [{ label: '', ipa: 'māo' }] }));
  assert.deepEqual(container.find('ai-translator-dict-accent'), []);
  assert.deepEqual(bound.map((b) => b.resolve()), [{ text: 'run', lang: '' }]);
  assert.doesNotMatch(container.textContent, /UK|US/);
});

test('null clears what was drawn before', () => {
  const container = new FakeElement(doc, 'div');
  const speech = { SPEAKER_ICON: ICON, bindSpeakButton: () => () => {} };
  render(container, normalize(FULL), { word: 'run', t: (k) => k, speech });
  render(container, null, { word: 'run', t: (k) => k, speech });
  assert.equal(container.childElementCount, 0);
  assert.equal(container.hidden, true);
  assert.throws(() => render(container, 'run', { word: 'run', t: (k) => k, speech }), TypeError);
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

// ---- one renderer, two surfaces --------------------------------------------

test('the input dialog and the selection card both draw through DictEntry.render', () => {
  for (const rel of ['content/content-input-dialog.js', 'content/content-popup.js']) {
    const code = repoFile(rel);
    assert.match(code, /DictEntry\.render\(/, `${rel} does not draw with DictEntry.render`);
    assert.match(code, /DictEntry\.entryFor\(/, `${rel} does not ask DictEntry.entryFor which answers carry an entry`);
    assert.doesNotMatch(code, /ai-translator-dict-(?!entry\b)[a-z-]+/,
      `${rel} builds a piece of the entry itself — only shared/dict-entry.js draws its blocks`);
    assert.doesNotMatch(code, /\bphonetic\b/, `${rel} still reads the old phonetic field`);
  }
});

test('the old shape is gone from the service worker', () => {
  const worker = repoFile('background/ai-translate.js');
  assert.doesNotMatch(worker, /parseWordTranslation|phonetic/);
  assert.match(worker, /DictEntry\.fromModelText\(/);
});
