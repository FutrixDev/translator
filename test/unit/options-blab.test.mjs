// The Blab Translation option on the settings page (options/options-blab.js,
// design §5.4): whether it can be chosen is the server's answer only
// (Engines.blabAccess), the two unavailable states each carry their own way
// out, the available state shows the numbers the API returned, and a Blab
// choice that stopped working is kept and warned about, never rewritten. Both
// ways out are the account entry: they send BLAB_ACCOUNT_ACTION, so the worker
// notes the click before it signs in or opens the pricing page (D-500).
//
// The card script runs in a vm with just enough DOM to draw a note.
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { optionsSource, repoSource } from './helpers/sources.mjs';

await import('../../shared/engines.js');
await import('../../i18n/lang/en.js');
await import('../../i18n/messages.js');
const { Engines } = globalThis;
const en = (key) => globalThis.getMessage(key, 'en');

test('Engines.blabAccess: only the server saying available makes it available', () => {
  const { SIGNED_OUT, PLAN_REQUIRED, AVAILABLE } = Engines.BLAB_ACCESS;
  assert.equal(Engines.blabAccess(null), SIGNED_OUT);
  assert.equal(Engines.blabAccess({ signedIn: false }), SIGNED_OUT);
  assert.equal(Engines.blabAccess({ signedIn: false, blabTranslation: { available: true } }), SIGNED_OUT);
  assert.equal(Engines.blabAccess({ signedIn: true }), PLAN_REQUIRED, 'a missing field is not a yes');
  assert.equal(Engines.blabAccess({ signedIn: true, planId: 'pro', blabTranslation: { available: false } }), PLAN_REQUIRED,
    'never inferred from the plan');
  assert.equal(Engines.blabAccess({ signedIn: true, blabTranslation: { available: 'yes' } }), PLAN_REQUIRED);
  assert.equal(Engines.blabAccess({ signedIn: true, blabTranslation: { available: true, limit: 1, used: 0 } }), AVAILABLE);
});

function fakeElement(tagName) {
  const classes = new Set();
  const listeners = {};
  return {
    tagName, children: [], textContent: '', className: '', hidden: false, disabled: false, value: '', dataset: {},
    classList: {
      toggle(name, on) { if (on) classes.add(name); else classes.delete(name); },
      contains: (name) => classes.has(name),
    },
    replaceChildren(...nodes) { this.children = nodes; },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    dispatch(type) { return Promise.all((listeners[type] || []).map((fn) => fn())); },
  };
}

function fakeSelect(value) {
  const select = fakeElement('select');
  select.value = value;
  select.blabOption = fakeElement('option');
  select.querySelector = (selector) => {
    assert.equal(selector, 'option[value="blab"]');
    return select.blabOption;
  };
  return select;
}

/**
 * Load options-blab.js with both selects at the given values. `reply` is what
 * the worker answers a message the card sends itself.
 */
function loadCard({ manual = 'builtin', auto = 'builtin', reply = { ok: true } } = {}) {
  const notes = { translationEngineBlabNote: fakeElement('div'), autoTranslateEngineBlabNote: fakeElement('div') };
  const signIns = [];
  const sent = [];
  const statuses = [];
  const sandbox = {
    Engines,
    currentUILang: 'en',
    comicSignedIn: null,
    accountSiteBase: 'https://blab.test',
    elements: { translationEngine: fakeSelect(manual), autoTranslateEngine: fakeSelect(auto) },
    document: { getElementById: (id) => notes[id], createElement: fakeElement },
    t: en,
    comicSignIn: (message) => { signIns.push(message); return Promise.resolve(true); },
    chrome: { runtime: { sendMessage: async (message) => { sent.push(message); return reply; } } },
    showStatus: (text, type) => { statuses.push([text, type]); },
    console: { error: () => {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(repoSource('options/options-blab.js'), sandbox);
  sandbox.setupBlabEngine();
  return {
    sandbox, notes, signIns, sent, statuses, manual: notes.translationEngineBlabNote, auto: notes.autoTranslateEngineBlabNote,
  };
}

const texts = (note) => note.children.filter((node) => node.tagName === 'span').map((node) => node.textContent);
const action = (note) => note.children.find((node) => node.tagName !== 'span');
/** A value built inside the vm, as a plain object of this realm. */
const plain = (value) => JSON.parse(JSON.stringify(value));

const AVAILABLE = { signedIn: true, blabTranslation: { available: true, limit: 1000000, used: 12345 } };

/** What renderAccountFeatures() does after showAccount(account). */
function draw(card, account) {
  card.sandbox.rememberBlabAccount(account);
  card.sandbox.comicSignedIn = account.signedIn === true;
  card.sandbox.renderBlabEngine();
}

test('options blab: before the account answers, the option is disabled and both notes are folded', () => {
  const card = loadCard({ manual: 'blab' });
  assert.equal(card.sandbox.elements.translationEngine.blabOption.disabled, true);
  assert.equal(card.sandbox.elements.autoTranslateEngine.blabOption.disabled, true);
  assert.equal(card.manual.hidden, true);
  assert.equal(card.auto.hidden, true);
  assert.equal(card.sandbox.elements.translationEngine.value, 'blab', 'the stored choice is kept');
});

test('options blab: signed out disables the option and offers the account card\'s sign-in, entered as the account entry', async () => {
  const card = loadCard();
  draw(card, { signedIn: false });
  for (const select of Object.values(card.sandbox.elements)) assert.equal(select.blabOption.disabled, true);
  for (const note of [card.manual, card.auto]) {
    assert.equal(note.hidden, false);
    assert.deepEqual(texts(note), [en('blabNoteSignedOut')]);
    assert.equal(action(note).tagName, 'button');
    assert.equal(action(note).textContent, en('comicSignIn'));
    assert.equal(action(note).dataset.accountAction, 'signin');
    assert.equal(note.classList.contains('blab-note-warning'), false, 'not selected: a hint, not a warning');
  }
  await action(card.manual).dispatch('click');
  assert.deepEqual(plain(card.signIns), [{ type: 'BLAB_ACCOUNT_ACTION', action: 'signin' }],
    'the account card\'s flow, through the worker\'s account entry');
  assert.deepEqual(card.sent, [], 'the card sends nothing else itself');
});

test('options blab: signed in without a plan disables the option, and Subscribe asks the worker to open the pricing page', async () => {
  const card = loadCard();
  draw(card, { signedIn: true, blabTranslation: { available: false } });
  assert.equal(card.sandbox.elements.translationEngine.blabOption.disabled, true);
  assert.deepEqual(texts(card.manual), [en('blabNotePlanRequired')]);
  const subscribe = action(card.manual);
  // A link would open the page itself, before the worker noted the click.
  assert.equal(subscribe.tagName, 'button');
  assert.equal(subscribe.href, undefined);
  assert.equal(subscribe.dataset.accountAction, 'subscribe');
  assert.equal(subscribe.textContent, en('blabSubscribe'));
  await subscribe.dispatch('click');
  assert.deepEqual(plain(card.sent), [{ type: 'BLAB_ACCOUNT_ACTION', action: 'subscribe' }]);
  assert.equal(subscribe.disabled, false);
  assert.deepEqual(card.statuses, []);
});

test('options blab: Subscribe the worker could not open says so on the page', async () => {
  const card = loadCard({ reply: { ok: false, error: { code: 'unknown', message: 'no pricing page' } } });
  draw(card, { signedIn: true, blabTranslation: { available: false } });
  const subscribe = action(card.manual);
  await subscribe.dispatch('click');
  assert.deepEqual(card.statuses, [[en('blabActionFailed'), 'error']]);
  assert.equal(subscribe.disabled, false, 'can be tried again');
});

test('options blab: with no account site address the plan note draws no dead link (D-490 N4)', () => {
  const card = loadCard();
  card.sandbox.accountSiteBase = '';
  draw(card, { signedIn: true, blabTranslation: { available: false } });
  assert.deepEqual(texts(card.manual), [en('blabNotePlanRequired')]);
  assert.equal(action(card.manual), undefined, 'no Subscribe that could only fail');
});

test('Engines.blabPricingUrl: only an http(s) site address makes a pricing link', () => {
  assert.equal(Engines.blabPricingUrl('https://blab.test'), 'https://blab.test/app/pricing');
  assert.equal(Engines.blabPricingUrl('http://localhost:3310/some/path?q=1'), 'http://localhost:3310/app/pricing');
  for (const base of ['', null, undefined, 'not a url', 'chrome-extension://abc', 'javascript:alert(1)']) {
    assert.equal(Engines.blabPricingUrl(base), '', String(base));
  }
});

test('options blab: available enables the option; the note shows only under a select set to Blab, with the API\'s numbers', () => {
  const card = loadCard({ manual: 'builtin', auto: 'blab' });
  draw(card, AVAILABLE);
  for (const select of Object.values(card.sandbox.elements)) assert.equal(select.blabOption.disabled, false);
  assert.equal(card.manual.hidden, true, 'builtin chosen: nothing to say about Blab');
  assert.equal(card.auto.hidden, false);
  const [line] = texts(card.auto);
  assert.ok(line.includes('1,000,000'), line);
  assert.ok(line.includes('12,345'), line);
  assert.ok(!/\{limit\}|\{used\}/.test(line));

  draw(card, { signedIn: true, blabTranslation: { available: true, limit: 500, used: 499 } });
  assert.ok(texts(card.auto)[0].includes('500') && texts(card.auto)[0].includes('499'), 'not written in: whatever the API says');

  card.sandbox.elements.translationEngine.value = 'blab';
  card.sandbox.elements.translationEngine.dispatch('change');
  assert.equal(card.manual.hidden, false, 'choosing Blab redraws its note');
});

test('options blab: a Blab choice that stopped working is kept and warned about, with the way back', () => {
  const card = loadCard({ manual: 'blab', auto: 'builtin' });
  draw(card, AVAILABLE);
  assert.equal(card.manual.classList.contains('blab-note-warning'), false);

  // Signed out on this device: the card sets comicSignedIn = false without a new account.
  card.sandbox.comicSignedIn = false;
  card.sandbox.renderBlabEngine();
  assert.equal(card.sandbox.elements.translationEngine.value, 'blab', 'not rewritten');
  assert.equal(card.manual.classList.contains('blab-note-warning'), true);
  assert.deepEqual(texts(card.manual), [en('blabNoteSelectedUnavailable'), en('blabNoteSignedOut')]);
  assert.equal(action(card.manual).tagName, 'button');
  assert.equal(card.auto.classList.contains('blab-note-warning'), false, 'only the select set to Blab warns');

  draw(card, { signedIn: true, blabTranslation: { available: false } });
  assert.deepEqual(texts(card.manual), [en('blabNoteSelectedUnavailable'), en('blabNotePlanRequired')]);
  assert.equal(action(card.manual).dataset.accountAction, 'subscribe');
});

test('options blab: the card is wired into the account card, the page load and the sync mirror', () => {
  const source = optionsSource();
  assert.match(source, /function showAccount\(account\) \{\n {2}rememberBlabAccount\(account\);/);
  assert.match(source, /function renderAccountFeatures\(\) \{\n {2}renderBlabEngine\(\);/);
  assert.match(source, /comicAccountReady = refreshComicAccount\(\{ force: true \}\)/,
    'the page-open read skips the 30s cache (design §5.4)');
  assert.match(source, /setupBlabEngine\(\);/);
  assert.match(source, /translationEngine: \(\) => \{[^}]*renderBlabEngine\(\);/);
  assert.match(repoSource('options/options.html'), /<script src="options-blab\.js"><\/script>/);
});

test('options blab: both selects load and save through Engines.normalizeEngine, so blab survives a round trip', () => {
  const source = optionsSource();
  for (const key of ['translationEngine', 'autoTranslateEngine']) {
    assert.match(source, new RegExp(`elements\\.${key}\\.value = Engines\\.normalizeEngine\\(result\\.${key}\\);`), `${key} load`);
    assert.match(source, new RegExp(`${key}: Engines\\.normalizeEngine\\(elements\\.${key}\\.value\\),`), `${key} save`);
  }
  for (const id of ['translationEngine', 'autoTranslateEngine']) {
    const select = repoSource('options/options.html').match(new RegExp(`<select id="${id}"[\\s\\S]*?</select>`))[0];
    assert.deepEqual([...select.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]), [...Engines.ENGINES], `${id} offers every engine`);
  }
  assert.equal(Engines.normalizeEngine('blab'), 'blab');
});

test('options blab: the site-rule editor can pin every engine, Blab included, and only AI asks to confirm spend', () => {
  const source = repoSource('options/options-custom-rules.js');
  assert.match(source, /for \(const engine of Engines\.ENGINES\) select\.appendChild\(new Option\(t\(RULE_ENGINE_LABELS\[engine\]\), engine\)\);/);
  const labels = vm.runInNewContext(`${source.match(/const RULE_ENGINE_LABELS = Object\.freeze\(\{[\s\S]*?\}\);/)[0]} RULE_ENGINE_LABELS`);
  assert.deepEqual(Object.keys(labels).sort(), [...Engines.ENGINES].sort());
  for (const key of Object.values(labels)) assert.notEqual(en(key), key, `${key} is a real message`);
  assert.match(source, /if \(select\.value === 'ai' && previous !== 'ai' && !confirmUnattendedAiSpend\('customRuleEngineAiConfirm'\)\)/);
});

test('options blab: the engine hint in every language says Blab sends text to Blab\'s servers', async () => {
  const { messageCatalog } = await import('./helpers/sources.mjs');
  const catalog = messageCatalog();
  const langs = Object.keys(catalog);
  assert.equal(langs.length, 10);
  for (const lang of langs) {
    assert.match(catalog[lang].hintTranslationEngine, /Blab Translation/, lang);
    assert.doesNotMatch(catalog[lang].customRuleProfileWithBuiltin, /built-in|integriert|integrado|intégré|内蔵|기본 제공|встроенн|内置|內建/i, lang);
  }
});

test('options blab: content and settings ask the same predicate', () => {
  assert.match(repoSource('content/engine/model.js'), /Engines\.blabAccess\(response\.data\)/);
});
