// The auto-status bar (content/content-auto-status.js) answers only the user's
// own clicks.
//
// The bar is an ordinary node in the page's DOM, so a page script can find its
// "Translate" button and call .click() on it. Behind that button sits a paid job
// (the PDF / comic offer). A synthetic click must do nothing at all, on every
// button.
//
// Run for real in a vm page with a stand-in for the few DOM calls the bar
// makes: the question is which callbacks fire on which click, and a regex over
// the source cannot tell a guarded handler from an unguarded one.
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'content/content-auto-status.js'), 'utf8');

/** Just enough of an element for the bar: its parts are found by selector. */
function element() {
  const parts = {};
  const el = {
    dataset: {},
    hidden: false,
    disabled: false,
    checked: false,
    textContent: '',
    parentNode: null,
    listeners: {},
    addEventListener(type, fn) { el.listeners[type] = fn; },
    setAttribute() {},
    querySelector: (selector) => parts[selector] || null,
    closest: () => null,
    set innerHTML(html) {
      for (const [, act] of html.matchAll(/data-act="(\w+)"/g)) {
        const button = element();
        button.dataset.act = act;
        button.closest = (selector) => (selector === '[data-act]' ? button : null);
        parts[`[data-act="${act}"]`] = button;
      }
      parts['.ai-translator-auto-text'] = element();
    },
  };
  return el;
}

function load() {
  const body = {
    children: [],
    appendChild(el) { body.children.push(el); el.parentNode = body; },
    removeChild(el) { body.children = body.children.filter((c) => c !== el); el.parentNode = null; },
    contains: (el) => body.children.includes(el),
  };
  const calls = [];
  const ctx = {
    t: (key) => key,
    settings: {},
    STATUS_AUTO: { OFF: 'OFF', IDLE: 'IDLE', RUNNING: 'RUNNING', PAUSED: 'PAUSED', ERROR: 'ERROR' },
    autoTranslate: {
      onStateChange() {},
    },
  };
  const sandbox = {
    console: { warn() {}, log() {}, error() {} },
    document: {
      body,
      visibilityState: 'visible',
      createElement: () => element(),
      querySelector: () => null,
      addEventListener() {},
    },
  };
  sandbox.globalThis = sandbox;
  sandbox.window = { AI_TRANSLATOR_CONTENT: ctx };
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox, { filename: 'content/content-auto-status.js' });
  ctx.setupAutoStatus();

  const bar = () => body.children[0] || null;
  const click = (act, isTrusted) => {
    const target = bar().querySelector(`[data-act="${act}"]`);
    bar().listeners.click({ isTrusted, target });
  };
  return { ctx, calls, bar, click };
}

function offerOn(page) {
  const offer = {
    text: 'mediaHintComic',
    link: { text: 'mediaHintSetShortcut', onClick: () => page.calls.push('link') },
    accept: () => page.calls.push('accept'),
    dismiss: () => page.calls.push('dismiss'),
  };
  page.ctx.showAutoStatusOffer(offer);
  assert.equal(page.bar().dataset.mode, 'offer');
}

test('a synthetic click on the offer does nothing, on any of its buttons', () => {
  const page = load();
  offerOn(page);
  for (const act of ['translate', 'link', 'dismiss', 'close']) page.click(act, false);
  assert.deepEqual(page.calls, [], 'a page script clicked the bar and something ran');
  assert.equal(page.bar().querySelector('[data-act="translate"]').disabled, false);
  assert.equal(page.bar().dataset.mode, 'offer', 'a synthetic close took the bar away');

  // The same buttons answer the user's own hand.
  page.click('translate', true);
  assert.deepEqual(page.calls, ['accept']);
});
