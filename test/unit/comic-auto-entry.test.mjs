// The on-entry start of a long strip (content/comic/auto.js, watchAutoEntry)
// spends the account's pages, so it starts only in a tab the reader can see.
//
// This is a unit test rather than an e2e journey because headless Chrome
// reports every page as visible whichever tab is in front: a background or
// prerendered tab cannot be produced there (see comic-account.spec.js).
//
// Runs the REAL auto.js over stand-ins for the comic shelf it reads from.
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const SOURCE = await readFile(new URL('../../content/comic/auto.js', import.meta.url), 'utf8');

/** A signed-in reader on a site set to auto-translate, with one strip page on screen. */
function load({ visible }) {
  const documentListeners = {};
  const timers = [];
  const ordered = [];
  const page = { tagName: 'IMG' };
  const comic = {
    hasComicStack: () => true,
    comicEnabled: () => true,
    comicTargetLang: () => 'zh-CN',
    normalizeMode: mode => mode,
    pageIdOf: () => 'page-1',
    isComicPage: () => true,
    distinctPages: imgs => imgs.map(img => ({ img, rect: { top: 0, bottom: 400, left: 0, right: 400 } })),
    entryFor: () => null,
    claimKnownPage: () => false,
    translateImage: async (img, order) => { ordered.push(order); },
  };
  const ctx = {
    comic,
    state: { translationsVisible: true },
    autoTranslate: { recallOn: () => true, onStateChange: fn => fn() },
  };
  const sandbox = {
    console,
    location: { href: 'https://comics.example/chapter/1' },
    innerHeight: 800,
    innerWidth: 1200,
    getComputedStyle: () => ({ visibility: 'visible', display: 'block', opacity: '1' }),
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout() {},
    document: {
      images: [page],
      visibilityState: visible ? 'visible' : 'hidden',
      addEventListener(type, fn) { (documentListeners[type] ||= []).push(fn); },
    },
  };
  sandbox.window = { AI_TRANSLATOR_CONTENT: ctx, addEventListener() {}, innerHeight: 800, innerWidth: 1200 };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox, { filename: 'content/comic/auto.js' });
  /** Runs every scan pending now, and lets the purchases promise settle first. */
  const settle = async () => {
    await new Promise(resolve => setImmediate(resolve));
    while (timers.length) timers.shift()();
    await new Promise(resolve => setImmediate(resolve));
  };
  const show = () => {
    sandbox.document.visibilityState = 'visible';
    for (const fn of documentListeners.visibilitychange || []) fn();
  };
  return { comic, ordered, settle, show };
}

test('a strip in a tab nobody has looked at orders nothing; shown, it starts', async () => {
  const page = load({ visible: false });
  page.comic.watchAutoEntry(Promise.resolve(true));
  await page.settle();
  assert.equal(page.ordered.length, 0);

  page.show();
  await page.settle();
  assert.equal(page.ordered.length, 1);
  assert.equal(page.ordered[0].onEntry, true);
});

test('a strip in the tab the reader is on starts on entry', async () => {
  const page = load({ visible: true });
  page.comic.watchAutoEntry(Promise.resolve(true));
  await page.settle();
  assert.equal(page.ordered.length, 1);
});
