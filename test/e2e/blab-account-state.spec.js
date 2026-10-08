// What the user sees of the Blab account's state, and the way back once it is
// fixed (D-497 F1, F3, M7, M11, M12).
//
//   - The popup's status dot is green only when Blab can translate right now:
//     not when today's allowance is spent (billing/me's used >= limit, or the
//     service's daily_limit refusal still held), not when billing/me answers
//     401 to the token on this device.
//   - The selection card's title names the engine that answered.
//   - After the user went to fix the account (the subscribe button), the next
//     pass they start asks billing/me first, goes through, and wakes the page's
//     automatic session that stopped with it.
//
// The page, the mocks and the shared steps are in test/e2e/blab-journey.js.
const { test, expect } = require('./fixtures');
const {
  getServiceWorker,
  sendMessageToActiveTab,
  stubBuiltinTranslator,
  triggerPageTranslation,
} = require('./helpers');
const {
  en,
  setUp,
  openPage,
  translatePage,
  expectPassStopped,
  barEntry,
  storedToken,
  openPopupOver,
  openCardOn,
} = require('./blab-journey');

const autoStatus = async (page) => (await sendMessageToActiveTab(page, { type: 'AUTO_PAGE_STATE' })).auto.status;

async function expectPopupStatus(popup, detailKey) {
  await expect(popup.locator('#statusText')).toHaveText(`${en('engineBlab')} · ${en(detailKey)}`);
  await expect(popup.locator('body')).toHaveClass(/status-error/);
}

test.describe('F1 the popup over a spent allowance', () => {
  test('billing/me says used == limit: today\'s allowance is spent, not green', async ({ context, page, extensionId }) => {
    const { blab, close } = await setUp(context, page, { mode: 'daily_limit' });
    try {
      await openPage(page);
      // Nothing translated yet: only billing/me knows.
      const popup = await openPopupOver(context, extensionId, page);
      await expectPopupStatus(popup, 'blabStatusDailyLimit');
      expect(blab.state.meRequests).toBeGreaterThan(0);
      expect(blab.state.completeRequests).toHaveLength(0);
      await popup.close();
    } finally {
      await close();
    }
  });

  test('the service refused with daily_limit: still spent while that refusal holds, whatever billing/me says', async ({ context, page, extensionId }) => {
    test.setTimeout(90000);
    const { blab, close } = await setUp(context, page, { mode: 'daily_limit' });
    try {
      await openPage(page);
      await stubBuiltinTranslator(page);
      await triggerPageTranslation(page);
      await expectPassStopped(page, en('blabDailyLimit').split('{time}')[0]);
      // billing/me now reads available (a lagging meter, a plan change); the
      // refusal the service gave holds until its resetsAt all the same.
      blab.state.mode = 'available';
      const worker = await getServiceWorker(context);
      await worker.evaluate(() => chrome.storage.local.remove('comicAccountCache'));
      const asked = blab.state.meRequests;
      const popup = await openPopupOver(context, extensionId, page);
      await expectPopupStatus(popup, 'blabStatusDailyLimit');
      expect(blab.state.meRequests, 'the popup read a fresh account').toBeGreaterThan(asked);
      await popup.close();
    } finally {
      await close();
    }
  });
});

test.describe('M11 the popup when the server no longer honours the token', () => {
  test('a token on this device, billing/me answers 401: sign in, not green', async ({ context, extensionId }) => {
    const { blab, close } = await setUp(context, await context.newPage(), { mode: 'unauthorized' });
    try {
      expect(await storedToken(context)).not.toBe('');
      expect(blab.state.meRequests).toBe(0);
      // The popup is the first to ask, so the 401 is its answer (the 401 drops
      // the token, and a second read would only find no token: signed out by
      // another road). Opened on its own tab, it has no page to probe and goes
      // by the settings' engine.
      const popup = await context.newPage();
      await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
      await expectPopupStatus(popup, 'blabStatusSignedOut');
      expect(blab.state.meRequests).toBe(1);
      expect(await storedToken(context)).toBe('');
      expect(blab.state.completeRequests).toHaveLength(0);
      await popup.close();
    } finally {
      await close();
    }
  });
});

test.describe('M12 the selection card names Blab', () => {
  test('a card Blab answered is titled Blab Translation', async ({ context, page }) => {
    const { blab, ai, close } = await setUp(context, page);
    try {
      await openPage(page);
      const card = await openCardOn(page, '#lead');
      await expect(card.locator('.ai-translator-engine-tag')).toHaveText(en('cardEngineBlab'), { timeout: 20000 });
      await expect(card.locator('.ai-translator-content')).toContainText('[T]');
      await expect(card.locator('.ai-translator-title')).toHaveText(en('engineBlab'));
      expect(blab.state.completeRequests.length).toBeGreaterThan(0);
      expect(ai.sentTexts).toHaveLength(0);
    } finally {
      await close();
    }
  });
});

test.describe('F3 + M7 back from a lapsed plan', () => {
  test('after subscribing, the next pass asks billing/me first, translates, and wakes the stopped automatic session', async ({ context, page }) => {
    test.setTimeout(120000);
    const { blab, ai, close } = await setUp(context, page, {
      mode: 'plan_required',
      settings: { autoTranslate: true, autoTranslateEngine: 'blab' },
    });
    try {
      await openPage(page);
      await stubBuiltinTranslator(page);
      await triggerPageTranslation(page);
      await expectPassStopped(page, en('blabPlanRequired'));
      await expect.poll(() => autoStatus(page), { timeout: 30000 }).toBe('error');
      expect(blab.state.completeRequests).toHaveLength(1);

      // The user subscribes on the account site.
      const [pricing] = await Promise.all([context.waitForEvent('page'), barEntry(page).click()]);
      blab.state.mode = 'available';
      await pricing.close();
      await page.bringToFront();

      // Well inside the plan_required refusal's 60 s: the pass goes through
      // only because it asked billing/me again first.
      const asked = blab.state.meRequests;
      await translatePage(page);
      expect(blab.state.meRequests).toBeGreaterThan(asked);
      expect(blab.state.completeRequests.length).toBeGreaterThan(1);
      expect(ai.sentTexts).toHaveLength(0);
      // The automatic session that stopped with the failed pass is back.
      await expect.poll(() => autoStatus(page), { timeout: 30000 }).not.toBe('error');
    } finally {
      await close();
    }
  });
});
