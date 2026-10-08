// Blab Translation: after the user clicked an account entry, which request asks
// billing/me and when the click is used up (D-497 F3, D-498 N-1, D-499). Driven
// through the service worker's own TRANSLATE / TRANSLATE_BATCH_FAST handlers,
// the way the content script sends them (stamped with an empty `addenda`): the
// `auto` / `unattended` flag on the message is the only thing that tells the
// worker nobody clicked for it.
//
//   - A request nobody made (the automatic pass, a caption line) asks billing/me
//     at most every 10 s while a plan_required latch holds.
//   - The next request a person makes asks billing/me again, however recently
//     the automatic one asked, and goes through once the plan is bought.
//   - The click is kept in session storage until billing/me says Blab is
//     available: the worker being recycled, or a request that found nothing
//     held, does not lose it.
//   - The settings page's Subscribe and Sign in are the same entry as the
//     page's (D-500): clicking them there records the click too.
//
// The page sending the messages is the extension's PDF upload page: an
// extension page that asks the account nothing by itself, so every billing/me
// counted here is one the worker sent for a translation.
const { test, expect } = require('./fixtures');
const { setUp, openOptions, storedToken, en } = require('./blab-journey');
const { getServiceWorker } = require('./helpers');

const BLAB = 'blab:service';
const TEXTS = ['The ferry leaves at noon.', 'Bring a warm coat.'];

async function messenger(context, extensionId) {
  const sender = await context.newPage();
  await sender.goto(`chrome-extension://${extensionId}/pdf/upload.html`);
  return (message) => sender.evaluate((m) => chrome.runtime.sendMessage(m), message);
}

const translate = (flags = {}) => ({
  type: 'TRANSLATE', text: TEXTS[0], targetLang: 'zh-CN', profileId: BLAB, feature: 'page', addenda: {}, ...flags,
});
const batch = (flags = {}) => ({
  type: 'TRANSLATE_BATCH_FAST', texts: TEXTS, targetLang: 'zh-CN', profileId: BLAB, feature: 'page', addenda: {}, ...flags,
});

/** The user clicks Subscribe; the pricing page opens and is left. */
async function subscribe(context, send) {
  const [pricing, action] = await Promise.all([
    context.waitForEvent('page'),
    send({ type: 'BLAB_ACCOUNT_ACTION', action: 'subscribe' }),
  ]);
  expect(action.ok).toBe(true);
  await pricing.close();
}

/** The service refuses for want of a plan, and the user clicks Subscribe. */
async function refusedThenSubscribe(context, send, blab) {
  const refused = await send(translate());
  expect(refused.error).toBeTruthy();
  expect(blab.state.completeRequests).toHaveLength(1);
  await subscribe(context, send);
}

/** The account-entry click as the worker keeps it (blab-client.js ACTION_KEY). */
async function clickRecord(context) {
  const worker = await getServiceWorker(context);
  return worker.evaluate(() => chrome.storage.session.get('blabAccountAction').then((r) => r.blabAccountAction));
}

/**
 * Chrome recycles the extension's service worker, as it does after half a
 * minute idle; the DevTools connection Playwright keeps open stops that from
 * happening by itself. The next message wakes a new worker.
 */
async function recycleWorker(context, page) {
  const cdp = await context.newCDPSession(page);
  try {
    await cdp.send('ServiceWorker.enable');
    await cdp.send('ServiceWorker.stopAllWorkers');
  } finally {
    await cdp.detach();
  }
}

test.describe('N-1 who uses up the account click', () => {
  test('(a) an automatic batch first does not use the click up: the person\'s batch after it asks billing/me and goes through', async ({ context, page, extensionId }) => {
    const { blab, ai, close } = await setUp(context, page, { mode: 'plan_required' });
    try {
      const send = await messenger(context, extensionId);
      await refusedThenSubscribe(context, send, blab);
      const asked = blab.state.meRequests;

      // The automatic pass while the user is still on the pricing page: it may
      // ask billing/me (the first ask in 10 s), finds no plan, and is refused.
      const automatic = await send(batch({ auto: true }));
      expect(automatic.error).toBeTruthy();
      expect(blab.state.meRequests).toBe(asked + 1);
      expect(blab.state.completeRequests).toHaveLength(1);

      // The user pays and translates, well inside the latch's minute.
      blab.state.mode = 'available';
      const person = await send(batch());
      expect(person.error).toBeUndefined();
      expect(person.translations).toHaveLength(TEXTS.length);
      expect(person.translations[0]).toContain('[T]');
      expect(blab.state.meRequests).toBe(asked + 2);
      expect(ai.sentTexts).toHaveLength(0);
    } finally {
      await close();
    }
  });

  test('(b) a caption line\'s refresh a moment ago does not hold back the person\'s request: it asks billing/me again and goes through', async ({ context, page, extensionId }) => {
    const { blab, ai, close } = await setUp(context, page, { mode: 'plan_required' });
    try {
      const send = await messenger(context, extensionId);
      await refusedThenSubscribe(context, send, blab);
      const asked = blab.state.meRequests;

      // A caption line is a TRANSLATE_BATCH_FAST marked unattended
      // (shared/caption-core.js): the first may ask, the next inside 10 s may not.
      const caption = await send(batch({ unattended: true }));
      expect(caption.error).toBeTruthy();
      expect(blab.state.meRequests).toBe(asked + 1);
      const nextLine = await send(batch({ unattended: true }));
      expect(nextLine.error).toBeTruthy();
      expect(blab.state.meRequests).toBe(asked + 1);

      // Within the 10 s that would hold back another unattended request.
      blab.state.mode = 'available';
      const person = await send(translate());
      expect(person.error).toBeUndefined();
      expect(JSON.stringify(person)).toContain('[T]');
      expect(blab.state.meRequests).toBe(asked + 2);
      expect(ai.sentTexts).toHaveLength(0);
    } finally {
      await close();
    }
  });

  test('(c) journey 1: the worker recycled after the click, the automatic pass latches anew; after paying, the person\'s batch asks billing/me and goes through', async ({ context, page, extensionId }) => {
    const { blab, ai, close } = await setUp(context, page, { mode: 'plan_required' });
    try {
      const send = await messenger(context, extensionId);
      await refusedThenSubscribe(context, send, blab);
      await recycleWorker(context, page);

      // The automatic pass wakes a new worker, which remembers no refusal: it
      // is sent, refused by the service and latched again.
      const automatic = await send(batch({ auto: true }));
      expect(automatic.error).toBeTruthy();
      expect(blab.state.completeRequests).toHaveLength(2);
      const asked = blab.state.meRequests;

      // The user pays and translates, well inside the new latch's minute.
      blab.state.mode = 'available';
      const person = await send(batch());
      expect(person.error).toBeUndefined();
      expect(person.translations).toHaveLength(TEXTS.length);
      expect(person.translations[0]).toContain('[T]');
      expect(blab.state.meRequests).toBe(asked + 1);
      expect(ai.sentTexts).toHaveLength(0);
    } finally {
      await close();
    }
  });

  test('(d) journey 2: clicked with nothing held, the person\'s request is refused by the service; after paying, the next one inside the minute asks billing/me and goes through', async ({ context, page, extensionId }) => {
    const { blab, ai, close } = await setUp(context, page, { mode: 'plan_required' });
    try {
      const send = await messenger(context, extensionId);
      await subscribe(context, send);
      const asked = blab.state.meRequests;

      // Nothing remembered yet: the request goes out and the service refuses it.
      const refused = await send(translate());
      expect(refused.error).toBeTruthy();
      expect(blab.state.completeRequests).toHaveLength(1);
      expect(blab.state.meRequests).toBe(asked);

      blab.state.mode = 'available';
      const person = await send(translate());
      expect(person.error).toBeUndefined();
      expect(JSON.stringify(person)).toContain('[T]');
      expect(blab.state.meRequests).toBe(asked + 1);
      expect(ai.sentTexts).toHaveLength(0);
    } finally {
      await close();
    }
  });

  test('(e) the settings page\'s Subscribe records the click: after paying, the person\'s batch inside the minute asks billing/me and goes through', async ({ context, page, extensionId }) => {
    const { blab, ai, close } = await setUp(context, page, { mode: 'plan_required' });
    try {
      const send = await messenger(context, extensionId);
      // The service refuses: a plan_required latch for 60 s.
      const refused = await send(batch());
      expect(refused.error).toBeTruthy();
      expect(blab.state.completeRequests).toHaveLength(1);

      // The user opens the settings page and clicks Subscribe there.
      const options = await openOptions(context, extensionId);
      const entry = options.locator('#translationEngineBlabNote .blab-note-action');
      await expect(entry).toHaveText(en('blabSubscribe'));
      const [pricing] = await Promise.all([context.waitForEvent('page'), entry.click()]);
      await pricing.waitForURL(/\/app\/pricing$/, { waitUntil: 'commit' });
      // Settings first: back in view it asks billing/me again; count after both.
      await options.close();
      await pricing.close();
      const asked = blab.state.meRequests;

      // The user pays and translates at once, inside the latch's minute.
      blab.state.mode = 'available';
      const person = await send(batch());
      expect(person.error).toBeUndefined();
      expect(person.translations).toHaveLength(TEXTS.length);
      expect(person.translations[0]).toContain('[T]');
      expect(blab.state.meRequests).toBe(asked + 1);
      expect(await clickRecord(context)).toBeUndefined();
      expect(ai.sentTexts).toHaveLength(0);
    } finally {
      await close();
    }
  });

  test('(f) the settings page\'s Sign in records the click and signs in; the person\'s batch then goes through', async ({ context, page, extensionId }) => {
    const { blab, ai, close } = await setUp(context, page, { mode: 'unauthorized' });
    try {
      const send = await messenger(context, extensionId);
      // The service no longer honours the token: it is dropped, and latched.
      const refused = await send(batch());
      expect(refused.error).toBeTruthy();
      expect(await storedToken(context)).toBe('');

      const options = await openOptions(context, extensionId);
      const entry = options.locator('#translationEngineBlabNote .blab-note-action');
      await expect(entry).toHaveText(en('comicSignIn'));
      blab.state.mode = 'available';
      await entry.click();
      await expect.poll(() => storedToken(context), { timeout: 15000 }).toBe('granted-token');
      // Sign-in fetched the account itself, not the forced billing/me a latch
      // asks: the click stays for the next one.
      expect(await clickRecord(context)).toBe(true);
      await options.close();

      // A new token lets the old one's latch go.
      const person = await send(batch());
      expect(person.error).toBeUndefined();
      expect(person.translations[0]).toContain('[T]');
      expect(blab.state.completeRequests.at(-1).authorization).toBe('Bearer granted-token');
      expect(ai.sentTexts).toHaveLength(0);
    } finally {
      await close();
    }
  });
});
