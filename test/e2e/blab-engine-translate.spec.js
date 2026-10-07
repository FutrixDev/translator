// Blab Translation end to end (design §6 journeys J1–J3, §7): the extension
// against a stub of the account service's §2 contract
// (test/e2e/mock-blab-service.js), with a working AI profile configured beside
// it on a second mock. That second mock is the witness for "never falls back":
// any request that reaches it while Blab is the engine is a bug.
//
// Everything on the extension's side is real: the token in
// chrome.storage.local, the worker's account cache and /api/blab/complete
// client, the prompts and the parsing of the answer, the page cache, the card
// and the settings page. The page, the mocks and the shared steps are in
// test/e2e/blab-journey.js.
const { test, expect } = require('./fixtures');
const {
  evaluateInContentScript,
  getSyncSettings,
  seedTodaysAutoAiChars,
  sendMessageToActiveTab,
  stubBuiltinTranslator,
  triggerPageTranslation,
  waitForFloatBall,
  writeSyncSettings,
} = require('./helpers');
const {
  en,
  ORIGIN,
  walkShot,
  setUp,
  openPage,
  translatePage,
  expectPassStopped,
  expectBarOnScreen,
  barEntry,
  storedToken,
  openPopupOver,
  openCardOn,
  openOptions,
} = require('./blab-journey');

const count = (n) => n.toLocaleString('en');

test.describe('J1 Blab Translation with a plan', () => {
  test('chosen in settings, it translates the page, a selection and a word, caches, and the count moves', async ({ context, page, extensionId }) => {
    test.setTimeout(120000);
    const { blab, ai, close } = await setUp(context, page);
    try {
      // J1 1–2: the option can be chosen and the note says where the text goes
      // and how much of today's allowance is left, both numbers from billing/me.
      let options = await openOptions(context, extensionId);
      await expect(options.locator('#translationEngine option[value="blab"]')).toBeEnabled();
      await expect(options.locator('#translationEngine')).toHaveValue('blab');
      const note = options.locator('#translationEngineBlabNote');
      await expect(note).toHaveText(en('blabNoteAvailable')
        .replace('{limit}', count(1000000)).replace('{used}', count(0)));
      await expect(note).not.toHaveClass(/blab-note-warning/);
      await walkShot(options, 'J1-1-2-settings-available');
      await options.close();

      // J1 3–4: the page goes to /api/blab/complete with the account's bearer,
      // inline markup survives, and nothing reaches the user's own AI.
      await openPage(page);
      await translatePage(page);
      expect(blab.state.completeRequests.length).toBeGreaterThan(0);
      for (const request of blab.state.completeRequests) {
        expect(request.authorization).toBe('Bearer test-token');
        // §2.1's body and nothing else; temperature only as the caller gave it (D-482).
        const { system, user, maxTokens, temperature, ...rest } = request.body;
        expect(rest).toEqual({});
        expect([typeof system, typeof user, typeof maxTokens]).toEqual(['string', 'string', 'number']);
        if (temperature !== undefined) expect(typeof temperature).toBe('number');
      }
      expect(ai.sentTexts).toHaveLength(0);
      const rich = page.locator('#rich + .ai-translator-inline-block');
      await expect(rich.locator('a[href="/docs"]')).toHaveText('the documentation');
      await expect(rich.locator('strong')).toHaveText('start working');
      const richText = await rich.textContent();
      expect(richText).not.toMatch(/\{\d+\}|<\/?[a-z]+\d+>/i);
      await walkShot(page, 'J1-3-4-page-translated');

      // J1 5: a word in the card is a dictionary entry, answered by Blab.
      const card = await openCardOn(page, '#word');
      await expect(card.locator('.ai-translator-dict-entry')).toBeVisible({ timeout: 20000 });
      await expect(card.locator('.ai-translator-dict-ipa')).toHaveText('/rʌn/');
      await expect(card.locator('.ai-translator-dict-defs')).toHaveText('跑; 奔跑');
      await expect(card.locator('.ai-translator-engine-tag')).toHaveText(en('cardEngineBlab'));
      expect(ai.sentTexts).toHaveLength(0);
      await walkShot(page, 'J1-5-card-dictionary-entry');
      await page.keyboard.press('Escape');

      // J1 6: a reload translates the same page from the cache, with not one
      // new request. The flush is batched, so give it time to land first.
      await page.waitForTimeout(1500);
      const sentBefore = blab.state.completeRequests.length;
      await page.reload();
      await waitForFloatBall(page);
      await translatePage(page);
      expect(blab.state.completeRequests.length).toBe(sentBefore);
      expect(ai.sentTexts).toHaveLength(0);
      await walkShot(page, 'J1-6-page-from-cache');

      // J1 7: the settings page reads the account fresh and shows what was spent.
      expect(blab.state.used).toBeGreaterThan(0);
      options = await openOptions(context, extensionId);
      await expect(options.locator('#translationEngineBlabNote')).toHaveText(en('blabNoteAvailable')
        .replace('{limit}', count(1000000)).replace('{used}', count(blab.state.used)));
      await walkShot(options, 'J1-7-settings-used-moved');
      await options.close();
    } finally {
      await close();
    }
  });
});

test.describe('J2 Blab Translation without a plan', () => {
  test('signed out: the option is disabled and the note offers sign-in', async ({ context, page, extensionId }) => {
    const { close } = await setUp(context, page, { signedIn: false, engine: 'ai' });
    try {
      const options = await openOptions(context, extensionId);
      for (const id of ['translationEngine', 'autoTranslateEngine']) {
        await expect(options.locator(`#${id} option[value="blab"]`)).toBeDisabled();
        const note = options.locator(`#${id}BlabNote`);
        await expect(note.locator('.blab-note-text')).toHaveText(en('blabNoteSignedOut'));
        await expect(note.locator('button')).toHaveText(en('comicSignIn'));
      }
      await walkShot(options, 'J2-1-settings-signed-out');
      await options.close();
    } finally {
      await close();
    }
  });

  test('no plan: the option is disabled, the note offers Subscribe, and the service refuses', async ({ context, page, extensionId }) => {
    const { blab, close } = await setUp(context, page, { mode: 'plan_required', engine: 'ai' });
    try {
      const options = await openOptions(context, extensionId);
      await expect(options.locator('#translationEngine option[value="blab"]')).toBeDisabled();
      const note = options.locator('#translationEngineBlabNote');
      await expect(note.locator('.blab-note-text')).toHaveText(en('blabNotePlanRequired'));
      // The account entry (D-500): the worker opens the pricing page.
      const subscribe = note.locator('[data-account-action="subscribe"]');
      await expect(subscribe).toHaveText(en('blabSubscribe'));
      await walkShot(options, 'J2-2-settings-no-plan');
      const [pricing] = await Promise.all([context.waitForEvent('page'), subscribe.click()]);
      await pricing.waitForURL(/\/app\/pricing$/, { waitUntil: 'commit' });
      await pricing.close();
      await options.close();

      // The service's side of the same answer, as the contract has it.
      const response = await fetch(`${blab.base}/api/blab/complete`, {
        method: 'POST',
        headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
        body: JSON.stringify({ system: '', user: 'x', maxTokens: 16 }),
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'plan_required' });
    } finally {
      await close();
    }
  });

  test('plan lapsed after choosing Blab: the choice is kept and flagged, and the page stops with the reason', async ({ context, page, extensionId }) => {
    const { blab, ai, close } = await setUp(context, page);
    try {
      blab.state.mode = 'plan_required';

      const options = await openOptions(context, extensionId);
      await expect(options.locator('#translationEngine')).toHaveValue('blab');
      const note = options.locator('#translationEngineBlabNote');
      await expect(note).toHaveClass(/blab-note-warning/);
      await expect(note.locator('.blab-note-text').first()).toHaveText(en('blabNoteSelectedUnavailable'));
      await walkShot(options, 'J2-3-settings-lapsed-kept');
      await options.close();
      expect(await getSyncSettings(context, ['translationEngine'])).toEqual({ translationEngine: 'blab' });

      await openPage(page);
      // A working built-in engine on the page: an error that fell back to it
      // would put [B] text on the page, which expectPassStopped rules out.
      await stubBuiltinTranslator(page);
      await triggerPageTranslation(page);
      await expectPassStopped(page, en('blabPlanRequired'));
      expect(blab.state.completeRequests).toHaveLength(1);
      expect(ai.sentTexts).toHaveLength(0);
      expect(await evaluateInContentScript(context, page, 'self.__builtinCalls')).toBe(0);
      // D-490 N2: the message comes with its way out, and all of it is on screen.
      const entry = barEntry(page);
      await expect(entry).toHaveAttribute('data-account-action', 'subscribe');
      await expect(entry).toHaveText(en('blabSubscribe'));
      await expectBarOnScreen(page);
      await walkShot(page, 'J2-3-page-plan-required');
      // The account site's pricing page, opened from the service worker.
      const [pricing] = await Promise.all([context.waitForEvent('page'), entry.click()]);
      expect(pricing.url()).toBe(`${blab.base}/app/pricing`);
      await pricing.close();
    } finally {
      await close();
    }
  });
});

test.describe('J3 Blab Translation over the daily allowance', () => {
  test('one request, the reset time in the message, and nothing translated', async ({ context, page }) => {
    const { blab, ai, close } = await setUp(context, page, { mode: 'daily_limit' });
    try {
      await openPage(page);
      await stubBuiltinTranslator(page);
      await triggerPageTranslation(page);
      const [before, after] = en('blabDailyLimit').split('{time}');
      await expectPassStopped(page, before);
      const message = await page.locator('#ai-translator-progress .ai-translator-progress-error-text').textContent();
      const time = message.slice(message.indexOf(before) + before.length, message.lastIndexOf(after));
      expect(time.trim()).toMatch(/\d/);
      expect(blab.state.completeRequests).toHaveLength(1);
      expect(ai.sentTexts).toHaveLength(0);
      expect(await evaluateInContentScript(context, page, 'self.__builtinCalls')).toBe(0);
      // Nothing to click for a spent allowance: tomorrow is the way out.
      await expect(barEntry(page)).toHaveCount(0);
      await expectBarOnScreen(page);
      await walkShot(page, 'J3-page-daily-limit');
    } finally {
      await close();
    }
  });
});

// D-490 B1: clicking "translate page" also tells the automatic session that the
// user wants this page translated. When that manual pass stops on an account
// error, the automatic session must stop with it — not wait for the manual pass
// to end and send the same paragraphs again through its own engine.
test.describe('an account error stops the automatic session too', () => {
  const autoStatus = async (page) => (await sendMessageToActiveTab(page, { type: 'AUTO_PAGE_STATE' })).auto.status;

  for (const autoEngine of ['builtin', 'ai', 'blab']) {
    test(`manual Blab, automatic ${autoEngine}: one request in all, and the page stays untranslated`, async ({ context, page }) => {
      const { blab, ai, close } = await setUp(context, page, {
        mode: 'plan_required',
        settings: { autoTranslate: true, autoTranslateEngine: autoEngine },
      });
      try {
        await openPage(page);
        await stubBuiltinTranslator(page);
        await triggerPageTranslation(page);
        await expectPassStopped(page, en('blabPlanRequired'));
        await expect.poll(() => autoStatus(page), { timeout: 30000 }).toBe('error');
        // Quiet: well past the scheduler's retry after a manual pass (500 ms)
        // and its debounce (250 ms), so a re-send would have happened by now.
        await page.waitForTimeout(2000);
        expect(blab.state.completeRequests).toHaveLength(1);
        expect(await evaluateInContentScript(context, page, 'self.__builtinCalls')).toBe(0);
        expect(ai.sentTexts).toHaveLength(0);
        await expect(page.locator('.ai-translator-inline-block')).toHaveCount(0);
        await expect(page.locator('body')).not.toContainText('[B]');
        await expect(page.locator('body')).not.toContainText('[T]');
      } finally {
        await close();
      }
    });
  }
});

// D-490 "补测试": the server answers 401 to a token it no longer honours.
test.describe('J2 signed out by the server', () => {
  test('an expired token: the page and the card offer sign-in, the popup is not green, and signing in translates', async ({ context, page, extensionId }) => {
    test.setTimeout(120000);
    const { blab, ai, close } = await setUp(context, page, { mode: 'unauthorized' });
    try {
      await openPage(page);
      await stubBuiltinTranslator(page);
      await triggerPageTranslation(page);
      await expectPassStopped(page, en('blabSignInRequired'));
      expect(blab.state.completeRequests).toHaveLength(1);
      expect(ai.sentTexts).toHaveLength(0);
      expect(await evaluateInContentScript(context, page, 'self.__builtinCalls')).toBe(0);
      // The 401 dropped the token on this device.
      expect(await storedToken(context)).toBe('');
      const entry = barEntry(page);
      await expect(entry).toHaveAttribute('data-account-action', 'signin');
      await expect(entry).toHaveText(en('comicSignIn'));
      await expectBarOnScreen(page);
      await walkShot(page, 'J2-4-page-signed-out');

      // The card says the same, with the same way out, and asks nobody else.
      const card = await openCardOn(page, '#lead');
      await expect(card.locator('.ai-translator-error')).toContainText(en('blabSignInRequired'), { timeout: 20000 });
      await expect(card.locator('.ai-translator-account-action')).toHaveAttribute('data-account-action', 'signin');
      expect(ai.sentTexts).toHaveLength(0);
      await walkShot(page, 'J2-4-card-signed-out');
      await page.keyboard.press('Escape');

      // The popup's status line names the engine and why it cannot run.
      const popup = await openPopupOver(context, extensionId, page);
      await expect(popup.locator('#statusText')).toHaveText(`${en('engineBlab')} · ${en('blabStatusSignedOut')}`);
      await expect(popup.locator('body')).toHaveClass(/status-error/);
      await popup.close();

      // Signing in from the bar puts it away; the next pass goes through.
      blab.state.mode = 'available';
      await barEntry(page).click();
      await expect.poll(() => storedToken(context), { timeout: 15000 }).toBe('granted-token');
      await expect(page.locator('#ai-translator-progress')).toBeHidden({ timeout: 15000 });
      await translatePage(page);
      expect(blab.state.completeRequests.at(-1).authorization).toBe('Bearer granted-token');
      expect(ai.sentTexts).toHaveLength(0);
    } finally {
      await close();
    }
  });
});

test.describe('Blab Translation pinned by a site rule', () => {
  test('the manual engine is built-in, the site\'s rule says Blab: the page goes to Blab only', async ({ context, page }) => {
    const { blab, ai, close } = await setUp(context, page, { engine: 'builtin' });
    try {
      await writeSyncSettings(context, {
        'customRule:blabpin': { v: 1, match: ['blab-engine.test'], engine: 'blab', updatedAt: Date.now() },
      });
      await openPage(page);
      await stubBuiltinTranslator(page);
      await translatePage(page);
      expect(blab.state.completeRequests.length).toBeGreaterThan(0);
      expect(ai.sentTexts).toHaveLength(0);
      expect(await evaluateInContentScript(context, page, 'self.__builtinCalls')).toBe(0);
      await expect(page.locator('body')).not.toContainText('[B]');
    } finally {
      await close();
    }
  });
});

// D-490 N8: autoAiDailyBudget is the user's own AI money. Blab's allowance is
// the account's, metered by the service (D-480), so a spent AI budget does not
// stop automatic Blab translation.
test.describe('the AI budget does not gate automatic Blab translation', () => {
  test('budget spent, automatic engine Blab: the page translates itself through Blab', async ({ context, page }) => {
    const { blab, ai, close } = await setUp(context, page, {
      engine: 'builtin',
      settings: {
        autoTranslate: true,
        autoTranslateEngine: 'blab',
        autoAiDailyBudget: 100,
        siteRules: { 'blab-engine.test': 'always' },
      },
    });
    try {
      await seedTodaysAutoAiChars(context, 5000);
      await page.goto(`${ORIGIN}/notes`);
      // Nobody clicks: the automatic session does it.
      await expect(page.locator('#rich + .ai-translator-inline-block')).toContainText('[T]', { timeout: 30000 });
      expect(blab.state.completeRequests.length).toBeGreaterThan(0);
      expect(ai.sentTexts).toHaveLength(0);
      const auto = (await sendMessageToActiveTab(page, { type: 'AUTO_PAGE_STATE' })).auto;
      expect(auto.status).not.toBe('off');
    } finally {
      await close();
    }
  });
});

test.describe('§7 the other engines never reach Blab', () => {
  test('built-in engine: the page is translated with no request to the service', async ({ context, page }) => {
    const { blab, ai, close } = await setUp(context, page, { engine: 'builtin' });
    try {
      await openPage(page);
      await stubBuiltinTranslator(page);
      await triggerPageTranslation(page);
      await expect(page.locator('#rich + .ai-translator-inline-block')).toContainText('[B]', { timeout: 30000 });
      await page.waitForSelector('#ai-translator-progress', { state: 'hidden', timeout: 30000 });
      expect(blab.state.completeRequests).toHaveLength(0);
      expect(ai.sentTexts).toHaveLength(0);
    } finally {
      await close();
    }
  });

  test('own AI: the page goes to the user\'s endpoint with no request to the service', async ({ context, page }) => {
    const { blab, ai, close } = await setUp(context, page, { engine: 'ai' });
    try {
      await openPage(page);
      await translatePage(page);
      expect(ai.sentTexts.length).toBeGreaterThan(0);
      expect(blab.state.completeRequests).toHaveLength(0);
    } finally {
      await close();
    }
  });
});
