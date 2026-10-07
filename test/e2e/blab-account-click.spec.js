// Blab Translation: after the user clicked an account entry, which request uses
// the click up (D-497 F3, D-498 N-1). Driven through the service worker's own
// TRANSLATE / TRANSLATE_BATCH_FAST handlers, the way the content script sends
// them (stamped with an empty `addenda`): the `auto` / `unattended` flag on the
// message is the only thing that tells the worker nobody clicked for it.
//
//   - A request nobody made (the automatic pass, a caption line) asks billing/me
//     at most every 10 s and never uses the click up.
//   - The next request a person makes asks billing/me again, however recently
//     the automatic one asked, and goes through once the plan is bought.
//
// The page sending the messages is the extension's PDF upload page: an
// extension page that asks the account nothing by itself, so every billing/me
// counted here is one the worker sent for a translation.
const { test, expect } = require('./fixtures');
const { setUp } = require('./blab-journey');

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

/** The service refuses for want of a plan, and the user clicks Subscribe. */
async function refusedThenSubscribe(context, send, blab) {
  const refused = await send(translate());
  expect(refused.error).toBeTruthy();
  expect(blab.state.completeRequests).toHaveLength(1);
  const [pricing, action] = await Promise.all([
    context.waitForEvent('page'),
    send({ type: 'BLAB_ACCOUNT_ACTION', action: 'subscribe' }),
  ]);
  expect(action.ok).toBe(true);
  await pricing.close();
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

      const caption = await send(translate({ unattended: true }));
      expect(caption.error).toBeTruthy();
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
});
