// The settings page's two Sign in entries, clicked the way a person clicks them
// (D-501). The account card's #comicSignIn sends COMIC_SIGN_IN; the Blab
// Translation note's Sign in sends BLAB_ACCOUNT_ACTION 'signin'. Both go
// through one sign-in flow, and a click while it runs joins it.
//
// B-2 was the card's listener being a function with a parameter of its own:
// the click event took the parameter's place, the worker was sent
// {"isTrusted":true}, nothing answered it, and the card said "Sign-in failed".
// Every test here ends where a person would look: signed in, the card showing
// the account, and no error left in the status strip.
//
// Scope (D-501 ruling 3): the card's Sign in is not a Blab entry and records no
// click; the new token is what lets a Blab latch go.
const { test, expect } = require('./fixtures');
const { setUp, openOptions, storedToken, en } = require('./blab-journey');
const { getServiceWorker } = require('./helpers');

const CARD = '#comicSignIn';
const NOTE = '#translationEngineBlabNote [data-account-action="signin"]';

/** Every message the settings page sends to the worker, as sent, from now on. */
async function recordMessages(options) {
  await options.evaluate(() => {
    window.__sent = [];
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = (message, ...rest) => {
      window.__sent.push(JSON.parse(JSON.stringify(message)));
      return send(message, ...rest);
    };
  });
  return async () => (await options.evaluate(() => window.__sent))
    .filter((m) => !m.type || m.type === 'COMIC_SIGN_IN' || m.type === 'BLAB_ACCOUNT_ACTION');
}

/** The account-entry click as the worker keeps it (blab-client.js ACTION_KEY). */
async function clickRecord(context) {
  const worker = await getServiceWorker(context);
  return worker.evaluate(() => chrome.storage.session.get('blabAccountAction').then((r) => r.blabAccountAction));
}

/** The settings page, signed out, with both entries drawn. */
async function signedOutOptions(context, extensionId) {
  const options = await openOptions(context, extensionId);
  await expect(options.locator(CARD)).toBeVisible();
  await expect(options.locator(NOTE)).toHaveText(en('comicSignIn'));
  return options;
}

/** Where every test ends: signed in, the card says so, no error is showing. */
async function expectSignedIn(context, options) {
  await expect.poll(() => storedToken(context), { timeout: 15000 }).toBe('granted-token');
  await expect(options.locator('#comicSignedIn')).toBeVisible();
  await expect(options.locator(CARD)).toBeHidden();
  await expect(options.locator('#statusMessage')).not.toHaveClass(/\berror\b/);
}

test.describe('D-501 the settings page signs in from either entry', () => {
  test('the account card\'s Sign in sends COMIC_SIGN_IN, opens sign-in once and signs in', async ({ context, page, extensionId }) => {
    const { blab, close } = await setUp(context, page, { mode: 'available', signedIn: false });
    try {
      const options = await signedOutOptions(context, extensionId);
      const sent = await recordMessages(options);

      await options.locator(CARD).click();

      await expectSignedIn(context, options);
      expect(await sent()).toEqual([{ type: 'COMIC_SIGN_IN' }]);
      expect(blab.state.connects).toBe(1);
      // Not a Blab entry: no click is kept for the next translation.
      expect(await clickRecord(context)).toBeUndefined();
    } finally {
      await close();
    }
  });

  test('A2d: the card and then the note in the same tick sign in once, and the person is signed in', async ({ context, page, extensionId }) => {
    const { blab, close } = await setUp(context, page, { mode: 'available', signedIn: false });
    try {
      const options = await signedOutOptions(context, extensionId);
      const sent = await recordMessages(options);

      await options.evaluate(({ card, note }) => {
        const noteButton = document.querySelector(note);
        document.querySelector(card).click();
        noteButton.click();
      }, { card: CARD, note: NOTE });

      await expectSignedIn(context, options);
      // The note joined the card's sign-in and sent nothing of its own.
      expect(await sent()).toEqual([{ type: 'COMIC_SIGN_IN' }]);
      expect(blab.state.connects).toBe(1);
    } finally {
      await close();
    }
  });

  test('A2e: the card, then the note 400 ms later while sign-in is open: one sign-in, no stale failure', async ({ context, page, extensionId }) => {
    const { blab, close } = await setUp(context, page, { mode: 'available', signedIn: false });
    try {
      const options = await signedOutOptions(context, extensionId);
      const sent = await recordMessages(options);
      // The person takes a moment on the sign-in page.
      blab.state.connectDelayMs = 1500;

      await options.locator(CARD).click();
      await options.waitForTimeout(400);
      await options.locator(NOTE).click({ timeout: 2000 });

      await expectSignedIn(context, options);
      expect(await sent()).toEqual([{ type: 'COMIC_SIGN_IN' }]);
      expect(blab.state.connects).toBe(1);
    } finally {
      await close();
    }
  });
});
