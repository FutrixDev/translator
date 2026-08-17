// Guards for the sign-in tab in background/comic-client.js.
//
// The bug these exist for: runAuthTab() has to register onUpdated/onRemoved
// before it calls chrome.tabs.create, or a fast redirect is gone before anyone
// is listening. But the tab's id only arrives when the create promise resolves,
// so for a few hundred milliseconds (~200ms measured against a redirect that
// landed at ~1300ms) every event fails the `tabId !== authTabId` check against a
// null id. Dropping those was survivable for onUpdated, where more events
// follow, and fatal for onRemoved, where none do: closing the auth tab inside
// that window meant nothing ever settled the promise, signIn() hung forever and
// both listeners leaked for the life of the service worker.
//
// So the shape under test is "an event that arrives before the id does still
// counts", which is why every test here drives chrome.tabs.create by hand
// instead of letting it resolve.
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';

const REDIRECT_URI = 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/';
const TAB_ID = 42;

/**
 * A chrome.tabs fake whose create() resolves only when the test says so, plus
 * the storage/identity surface signIn() touches on the way past.
 */
function installChrome({ redirectUri = REDIRECT_URI } = {}) {
  const store = {};
  const updatedListeners = [];
  const removedListeners = [];

  let resolveCreate;
  let rejectCreate;
  const createPromise = new Promise((resolve, reject) => {
    resolveCreate = resolve;
    rejectCreate = reject;
  });
  let createArgs = null;
  const removeCalls = [];

  const drop = (list, fn) => {
    const index = list.indexOf(fn);
    if (index >= 0) list.splice(index, 1);
  };

  const emitRemoved = (tabId) => {
    for (const fn of [...removedListeners]) fn(tabId, { windowId: 1, isWindowClosing: false });
  };

  globalThis.chrome = {
    identity: { getRedirectURL: () => redirectUri },
    tabs: {
      onUpdated: {
        addListener: (fn) => updatedListeners.push(fn),
        removeListener: (fn) => drop(updatedListeners, fn)
      },
      onRemoved: {
        addListener: (fn) => removedListeners.push(fn),
        removeListener: (fn) => drop(removedListeners, fn)
      },
      create: (args) => { createArgs = args; return createPromise; },
      remove: async (tabId) => { removeCalls.push(tabId); emitRemoved(tabId); }
    },
    storage: {
      local: {
        get: async (defaults) => {
          const out = { ...defaults };
          for (const key of Object.keys(defaults)) {
            if (key in store) out[key] = store[key];
          }
          return out;
        },
        set: async (values) => { Object.assign(store, values); },
        remove: async (keys) => { for (const key of [].concat(keys)) delete store[key]; }
      }
    }
  };

  return {
    store,
    removeCalls,
    get createArgs() { return createArgs; },
    finishCreate: (tab) => resolveCreate(tab),
    failCreate: (error) => rejectCreate(error),
    emitUpdated: (tabId, changeInfo, tab) => {
      for (const fn of [...updatedListeners]) fn(tabId, changeInfo, tab);
    },
    emitRemoved,
    listenerCount: () => updatedListeners.length + removedListeners.length
  };
}

/** Let signIn() get as far as registering its listeners and calling create. */
const settleMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * The whole point of the bug is a promise that never settles, and an unbounded
 * await on one hangs the runner rather than failing it.
 */
function mustSettle(promise, what) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} never settled — a pre-id event was dropped`)), 2000);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

/** A signed-in account response, so a resolving sign-in has somewhere to land. */
function stubBillingFetch() {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ plan: 'free', pagesRemaining: 20 })
  });
}

installChrome();
const comic = await import('../../background/comic-client.js');

test('a tab closed before create() resolves cancels sign-in instead of hanging', async () => {
  const chromeFake = installChrome();
  const signInPromise = comic.signIn();
  await settleMicrotasks();

  // The user closes the auth tab while chrome.tabs.create is still in flight,
  // so this removal is the only event this tab will ever produce.
  chromeFake.emitRemoved(TAB_ID);
  chromeFake.finishCreate({ id: TAB_ID });

  await assert.rejects(
    mustSettle(signInPromise, 'signIn()'),
    (error) => error.code === 'sign_in_cancelled'
  );
  assert.equal(chromeFake.listenerCount(), 0, 'both listeners are detached on cancel');
  assert.equal('comicToken' in chromeFake.store, false);
});

test('a redirect that lands before create() resolves still completes sign-in', async () => {
  const chromeFake = installChrome();
  stubBillingFetch();
  const signInPromise = comic.signIn();
  await settleMicrotasks();

  chromeFake.emitUpdated(TAB_ID, { url: `${REDIRECT_URI}#token=tok-early&expires_at=1780000000` }, { id: TAB_ID });
  chromeFake.finishCreate({ id: TAB_ID });

  const account = await mustSettle(signInPromise, 'signIn()');
  assert.equal(account.signedIn, true);
  assert.equal(chromeFake.store.comicToken, 'tok-early');
  assert.deepEqual(chromeFake.removeCalls, [TAB_ID], 'the dead chromiumapp.org tab is still closed for the user');
  assert.equal(chromeFake.listenerCount(), 0);
});

test('a redirect queued ahead of a removal wins, so the tab we close ourselves is not a cancel', async () => {
  const chromeFake = installChrome();
  stubBillingFetch();
  const signInPromise = comic.signIn();
  await settleMicrotasks();

  // Both arrive before the id: the page redirected and the user closed the tab
  // a moment later. Replaying in arrival order is what keeps this a success.
  chromeFake.emitUpdated(TAB_ID, { url: `${REDIRECT_URI}#token=tok-race` }, { id: TAB_ID });
  chromeFake.emitRemoved(TAB_ID);
  chromeFake.finishCreate({ id: TAB_ID });

  const account = await mustSettle(signInPromise, 'signIn()');
  assert.equal(account.signedIn, true);
  assert.equal(chromeFake.store.comicToken, 'tok-race');
});

test('another tab closing during the window is not read as a cancel', async () => {
  const chromeFake = installChrome();
  stubBillingFetch();
  const signInPromise = comic.signIn();
  await settleMicrotasks();

  chromeFake.emitRemoved(TAB_ID + 1);
  chromeFake.finishCreate({ id: TAB_ID });
  await settleMicrotasks();

  // Queued, replayed, and discarded on the id check — the flow is still live.
  chromeFake.emitUpdated(TAB_ID, { url: `${REDIRECT_URI}#token=tok-late` }, { id: TAB_ID });
  const account = await mustSettle(signInPromise, 'signIn()');
  assert.equal(account.signedIn, true);
  assert.equal(chromeFake.store.comicToken, 'tok-late');
});

test('the ordinary ordering — create first, then the redirect — is unaffected', async () => {
  const chromeFake = installChrome();
  stubBillingFetch();
  const signInPromise = comic.signIn();
  await settleMicrotasks();

  chromeFake.finishCreate({ id: TAB_ID });
  await settleMicrotasks();
  assert.match(chromeFake.createArgs.url, /\/ext\/connect\?state=/);

  chromeFake.emitUpdated(TAB_ID, {}, { id: TAB_ID, url: `${REDIRECT_URI}#token=tok-normal` });
  const account = await mustSettle(signInPromise, 'signIn()');
  assert.equal(chromeFake.store.comicToken, 'tok-normal');
  assert.equal(account.signedIn, true);
  assert.equal(chromeFake.listenerCount(), 0);
});

test('a created tab with no usable id fails rather than waiting on an id that never comes', async () => {
  const chromeFake = installChrome();
  const signInPromise = comic.signIn();
  await settleMicrotasks();

  // Chrome hands back a tab with no id when it could not really open one; with
  // nothing to match against, every queued event would sit there forever.
  chromeFake.emitRemoved(TAB_ID);
  chromeFake.finishCreate({});

  await assert.rejects(
    mustSettle(signInPromise, 'signIn()'),
    (error) => error.code === 'sign_in_failed'
  );
  assert.equal(chromeFake.listenerCount(), 0);
});

test('a create that rejects detaches the listeners too', async () => {
  const chromeFake = installChrome();
  const signInPromise = comic.signIn();
  await settleMicrotasks();

  chromeFake.failCreate(new Error('No active window'));

  await assert.rejects(
    mustSettle(signInPromise, 'signIn()'),
    (error) => error.code === 'sign_in_failed' && /No active window/.test(error.message)
  );
  assert.equal(chromeFake.listenerCount(), 0);
});
