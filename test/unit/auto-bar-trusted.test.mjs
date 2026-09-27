// The auto-status bar (content/content-auto-status.js) answers only the user's
// own clicks, and steps aside while a video fills the screen.
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
  // ctx.videoStage, reduced to what the bar asks: stepAside's contract (watch
  // only while wanted, repaint on each change, shown unless a video fills the
  // screen; the real one is pinned in video-stage.test.mjs). `set(filled)`
  // plays the stage's poll.
  const stage = {
    filled: false,
    listeners: new Set(),
    stepAside(repaint) {
      let watching = false;
      return (wanted) => {
        if (wanted && !watching) { stage.listeners.add(repaint); watching = true; }
        if (!wanted && watching) { stage.listeners.delete(repaint); watching = false; }
        return wanted && !stage.filled;
      };
    },
    set(filled) {
      stage.filled = filled;
      for (const listener of [...stage.listeners]) listener(filled);
    },
  };
  const ctx = {
    videoStage: stage,
    t: (key) => key,
    settings: {},
    STATUS_AUTO: { OFF: 'OFF', IDLE: 'IDLE', RUNNING: 'RUNNING', PAUSED: 'PAUSED', ERROR: 'ERROR' },
    autoTranslate: {
      // Subscribing replays the current state at once, as the scheduler does.
      onStateChange(listener) { listener({ status: 'IDLE', gaveUp: 0 }); },
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
  // The manifest loads the reason table before the bar; the explain line reads it.
  const reasons = 'shared/auto-reason-keys.js';
  vm.runInContext(fs.readFileSync(path.join(ROOT, reasons), 'utf8'), sandbox, { filename: reasons });
  vm.runInContext(SOURCE, sandbox, { filename: 'content/content-auto-status.js' });
  ctx.setupAutoStatus();

  const bar = () => body.children[0] || null;
  const click = (act, isTrusted) => {
    const target = bar().querySelector(`[data-act="${act}"]`);
    bar().listeners.click({ isTrusted, target });
  };
  return { ctx, calls, bar, click, stage };
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

test('the bar steps aside while a video fills the screen, and comes back as it was', () => {
  const page = load();
  assert.equal(page.stage.listeners.size, 0, 'nothing to show, yet the stage is being measured');
  offerOn(page);
  assert.equal(page.stage.listeners.size, 1);

  page.stage.set(true);
  assert.equal(page.bar(), null, 'the bar stayed over a full-screen video');
  page.stage.set(false);
  assert.equal(page.bar().dataset.mode, 'offer');
  assert.equal(page.bar().querySelector('.ai-translator-auto-text').textContent, 'mediaHintComic');

  // Already full screen when the offer arrives: never drawn over the video.
  page.ctx.showAutoStatusOffer(null);
  assert.equal(page.stage.listeners.size, 0, 'the bar went away but kept the stage polling');
  page.stage.filled = true;
  page.ctx.showAutoStatusOffer({ text: 'mediaHintPdf', accept() {}, dismiss() {} });
  assert.equal(page.bar(), null);
  page.stage.set(false);
  assert.equal(page.bar().dataset.mode, 'offer');
});

test('one priority: notice over the explain line over the offer, and nothing while the picker is open', () => {
  const page = load();
  const mode = () => (page.bar() ? page.bar().dataset.mode : null);
  offerOn(page);
  page.ctx.toggleAutoStatusExplain();
  assert.equal(mode(), 'explain', 'the line the user asked for sits over the offer');
  page.ctx.showAutoStatusNotice('popupSiteRuleFailed');
  assert.equal(mode(), 'notice');
  assert.equal(page.bar().querySelector('.ai-translator-auto-text').textContent, 'popupSiteRuleFailed');

  page.ctx.yieldAutoStatus(true);
  assert.equal(page.bar(), null, 'the bar stayed under the picker');
  page.ctx.yieldAutoStatus(false);
  assert.equal(mode(), 'notice', 'the notice came back after the picker');

  // "Translate" belongs to the offer: under a notice it is not the offer's button.
  page.click('translate', true);
  assert.deepEqual(page.calls, [], 'the offer was accepted while the bar was saying something else');

  // Each close takes away the layer the bar is showing, one at a time.
  page.click('close', true);
  assert.equal(mode(), 'explain');
  page.click('dismiss', true);
  assert.equal(mode(), 'offer');
  assert.deepEqual(page.calls, [], 'closing the notice or the explain line dismissed the offer');
  page.click('close', true);
  assert.deepEqual(page.calls, ['dismiss']);
});
