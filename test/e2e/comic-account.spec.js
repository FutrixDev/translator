/**
 * The account panel in the options page, shared by comic and PDF translation.
 *
 * It reads the monthly free allowance from the service through the worker, so
 * the service is stubbed and everything else is real: the token in
 * chrome.storage.local, the worker's HTTP client and its 30s account cache,
 * and the rendering of the numbers the user actually acts on. The popup is
 * here too, to prove it stays out of this entirely.
 */
const { test, expect } = require('./fixtures');
const { getServiceWorker } = require('./helpers');
const { startMockServer } = require('./mock-server');

const RESETS_AT = '2099-02-01T00:00:00.000Z';
const quota = (limit, remaining) => ({
  limit, used: limit - remaining, remaining, applied: false, resetsAt: RESETS_AT,
});

const ACCOUNT = {
  user: { email: 'reader@example.com', name: 'Reader' },
  balancePoints: 0,
  pagesRemaining: 24,
  // `freeQuota` is the pre-PDF shape, still sent for extensions that predate
  // `freeQuotas`; the options page prefers the map when both are present.
  freeQuota: quota(40, 24),
  freeQuotas: { comic_page: quota(40, 24), pdf_page: quota(20, 17) },
};

/**
 * @param {'token'|'no-token'} connect what /ext/connect hands back. The real
 *   page bounces the browser to the extension's redirect URI with the token in
 *   the fragment; 'no-token' is the shape a failed authorization takes.
 * @param {number} meDelayMs hold the account response back this long, to hold
 *   the options page open in the window where it has a token but not yet an
 *   answer.
 * @param {number} connectDelayMs the same, for the sign-in bounce, so a second
 *   gate can arrive while the first authentication is still running.
 */
async function startMockService({ connect = 'token', meDelayMs = 0, connectDelayMs = 0 } = {}) {
  // `account` is mutable so a test can spend pages mid-run, the way a
  // translation job does, and see whether the page ever notices.
  const state = { meRequests: 0, connectRequests: 0, account: ACCOUNT };

  const { origin, close } = await startMockServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };

    // The sign-in tab. comic-client.js watches the tab's URL and settles as
    // soon as it starts navigating to the redirect URI, so the fact that
    // chromiumapp.org itself never loads is exactly the production behaviour.
    if (url.pathname === '/ext/connect') {
      state.connectRequests += 1;
      const redirect = url.searchParams.get('redirect_uri');
      const fragment = connect === 'token'
        ? `#token=granted-token&expires_at=${Date.now() + 3600_000}`
        : '#error=access_denied';
      const bounce = () => {
        res.writeHead(302, { location: `${redirect}${fragment}`, 'cache-control': 'no-store' });
        res.end();
      };
      if (connectDelayMs) return setTimeout(bounce, connectDelayMs);
      bounce();
      return;
    }

    if (url.pathname === '/api/billing/me') {
      state.meRequests += 1;
      if (!(req.headers.authorization || '').startsWith('Bearer ')) {
        return send(401, { error: 'unauthorized', loginRequired: true });
      }
      if (meDelayMs) return setTimeout(() => send(200, state.account), meDelayMs);
      return send(200, state.account);
    }

    send(404, { error: 'not_found' });
  });

  return { base: origin, state, close };
}

/**
 * Point the extension at the mock and give it a token, as a real sign-in would.
 *
 * The feature ships off, so it is switched on here: these tests are about what
 * a user who wants comic translation sees, and the off state has its own tests.
 */
async function connectExtension(context, base, { withToken = true, enabled = true } = {}) {
  const worker = await getServiceWorker(context);
  await worker.evaluate(async ({ base, withToken, enabled }) => {
    await chrome.storage.sync.set({ enableComicTranslation: enabled });
    await chrome.storage.local.remove(['comicToken', 'comicTokenExpiresAt', 'comicAccountCache']);
    const values = { comicApiBase: base };
    if (withToken) {
      values.comicToken = 'test-token';
      values.comicTokenExpiresAt = Date.now() + 3600_000;
    }
    await chrome.storage.local.set(values);
  }, { base, withToken, enabled });
  return worker;
}

test.describe('Comic account state', () => {
  test('options page shows both monthly allowances when signed in', async ({ context, page, extensionId }) => {
    const service = await startMockService();
    try {
      await connectExtension(context, service.base);
      await page.goto(`chrome-extension://${extensionId}/options/options.html`);

      await expect(page.locator('#comicSignedIn')).toBeVisible();
      await expect(page.locator('#comicEmail')).toHaveText(ACCOUNT.user.email);
      // Pages left this month, per feature — the product is free, so there is
      // no balance to show.
      await expect(page.locator('#comicPagesRemaining'))
        .toHaveText(String(ACCOUNT.freeQuotas.comic_page.remaining));
      await expect(page.locator('#pdfPagesRemaining'))
        .toHaveText(String(ACCOUNT.freeQuotas.pdf_page.remaining));
      await expect(page.locator('#freeQuotaReset')).not.toHaveText('—');
      await expect(page.locator('#comicSignedOut')).toBeHidden();
    } finally {
      await service.close();
    }
  });

  test('re-focusing an open options tab picks up pages spent since it loaded', async ({ context, page, extensionId }) => {
    const service = await startMockService();
    try {
      await connectExtension(context, service.base);
      await page.goto(`chrome-extension://${extensionId}/options/options.html`);
      await expect(page.locator('#comicPagesRemaining')).toHaveText('24');

      // Jobs run while the tab sits in the background. openOptionsPage() focuses
      // this tab rather than reloading it, so nothing here re-runs on its own —
      // without a refresh on the way back the counters stay at 24/17 forever.
      service.state.account = {
        ...ACCOUNT,
        freeQuota: quota(40, 11),
        freeQuotas: { comic_page: quota(40, 11), pdf_page: quota(20, 5) },
      };

      // The event is dispatched rather than provoked by focusing another tab:
      // headless Chrome reports every page as visible regardless of which is
      // in front, so bringToFront() cannot produce a hidden state to come back
      // from. Chrome firing this on tab focus is browser behaviour; what is
      // under test is what the page does when it arrives.
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));

      await expect(page.locator('#comicPagesRemaining')).toHaveText('11');
      await expect(page.locator('#pdfPagesRemaining')).toHaveText('5');
      // Quietly: the account panel is never swapped out for the loading state,
      // so a refresh the user did not ask for cannot make the page flicker.
      await expect(page.locator('#comicSignedIn')).toBeVisible();
      await expect(page.locator('#comicAccountLoading')).toBeHidden();
    } finally {
      await service.close();
    }
  });

  test('options page falls back to signed out when the token is gone', async ({ context, page, extensionId }) => {
    const service = await startMockService();
    try {
      await connectExtension(context, service.base, { withToken: false });
      await page.goto(`chrome-extension://${extensionId}/options/options.html`);

      await expect(page.locator('#comicSignedOut')).toBeVisible();
      await expect(page.locator('#comicSignedIn')).toBeHidden();
      // No token means no request: the worker answers signed-out on its own.
      expect(service.state.meRequests).toBe(0);
    } finally {
      await service.close();
    }
  });

  test('the popup carries no account row and queries nothing', async ({ context, page, extensionId }) => {
    const service = await startMockService();
    try {
      // Signed in, feature on: the state that used to make the popup fetch.
      await connectExtension(context, service.base);
      await page.goto(`chrome-extension://${extensionId}/popup/popup.html`);
      await expect(page.locator('#comicTranslatePage')).toBeVisible();
      await expect(page.locator('#comicAccount')).toHaveCount(0);

      // Allowance and sign-in live in Settings now, so opening the popup must
      // not cost a round trip.
      await page.waitForTimeout(300);
      expect(service.state.meRequests).toBe(0);
    } finally {
      await service.close();
    }
  });
});

test.describe('Comic translation switch', () => {
  test('is off out of the box and hides the popup rows', async ({ context, page, extensionId }) => {
    const service = await startMockService();
    try {
      await connectExtension(context, service.base, { enabled: false });
      await page.goto(`chrome-extension://${extensionId}/popup/popup.html`);

      await expect(page.locator('#comicTranslatePage')).toBeHidden();
      await expect(page.locator('#comicColorizePage')).toBeHidden();
    } finally {
      await service.close();
    }
  });

  test('writes immediately and gates the language select', async ({ context, page, extensionId }) => {
    const service = await startMockService();
    try {
      const worker = await connectExtension(context, service.base, { enabled: false });
      await page.goto(`chrome-extension://${extensionId}/options/options.html`);

      // The account panel loads even with both switches off: it is now the only
      // place to sign in, and turning either switch on requires being signed in.
      await expect(page.locator('#comicSignedIn')).toBeVisible();
      await expect(page.locator('#comicSignedOut')).toBeHidden();

      const toggle = page.locator('#enableComicTranslation');
      // The checkbox itself is display:none behind the slider, so the label is
      // what a user actually clicks.
      const toggleLabel = page.locator('label:has(#enableComicTranslation)');
      const lang = page.locator('#comicTargetLang');
      await expect(toggle).not.toBeChecked();
      await expect(lang).toBeDisabled();

      // No Save click: this card writes on change, because Save is gated on a
      // BYO API key that comic translation does not use.
      await toggleLabel.click();
      await expect(toggle).toBeChecked();
      await expect(lang).toBeEnabled();
      await lang.selectOption('ja');

      await expect.poll(async () => worker.evaluate(
        () => chrome.storage.sync.get({ enableComicTranslation: false, comicTargetLang: '' }),
      )).toEqual({ enableComicTranslation: true, comicTargetLang: 'ja' });

      // Empty means "follow the page-translation target", not "no language".
      await lang.selectOption('');
      await expect.poll(async () => worker.evaluate(
        () => chrome.storage.sync.get({ comicTargetLang: 'unset' }),
      )).toEqual({ comicTargetLang: '' });
    } finally {
      await service.close();
    }
  });

  // The entry follows BOTH halves of the answer: the switch and the account.
  // Signing out has to retract it even though no sync key moved.
  test('shows and hides the image context menu entry', async ({ context }) => {
    const service = await startMockService();
    try {
      const worker = await connectExtension(context, service.base, { enabled: false });
      // chrome.contextMenus has no read API, so the call the worker makes is the
      // only observable. Record it, then flip the setting the way options does.
      await worker.evaluate(() => {
        globalThis.__menuUpdates = [];
        const original = chrome.contextMenus.update.bind(chrome.contextMenus);
        chrome.contextMenus.update = (id, props, cb) => {
          globalThis.__menuUpdates.push({ id, visible: props && props.visible });
          return original(id, props, cb);
        };
      });

      const visibilityCalls = () => worker.evaluate(() => globalThis.__menuUpdates
        .filter(u => u.id === 'translate-comic-image' && u.visible !== undefined)
        .map(u => u.visible));

      await worker.evaluate(() => chrome.storage.sync.set({ enableComicTranslation: true }));
      await expect.poll(visibilityCalls).toContain(true);

      // Signed out with the switch untouched: the entry goes anyway.
      await worker.evaluate(() => chrome.storage.local.remove('comicToken'));
      await expect.poll(async () => (await visibilityCalls()).at(-1)).toBe(false);

      await worker.evaluate(() => chrome.storage.local.set({ comicToken: 'test-token' }));
      await expect.poll(async () => (await visibilityCalls()).at(-1)).toBe(true);

      await worker.evaluate(() => chrome.storage.sync.set({ enableComicTranslation: false }));
      await expect.poll(async () => (await visibilityCalls()).at(-1)).toBe(false);

      await worker.evaluate(() => { delete globalThis.__menuUpdates; });
    } finally {
      await service.close();
    }
  });
});

/**
 * Requirement of the free model: both server-backed features need an account,
 * so the switch itself is the sign-in prompt. Turning one ON without one must
 * not leave a switch claiming a feature that can only ever answer "sign in".
 */
test.describe('Advanced Settings login gate', () => {
  test('a failed sign-in snaps the switch back and stores nothing', async ({ context, page, extensionId }) => {
    const service = await startMockService({ connect: 'no-token' });
    try {
      const worker = await connectExtension(context, service.base, { withToken: false, enabled: false });
      await page.goto(`chrome-extension://${extensionId}/options/options.html`);
      await expect(page.locator('#comicSignedOut')).toBeVisible();

      await page.locator('label:has(#enableComicTranslation)').click();

      // The sign-in tab really opened; it just came back without a token.
      await expect.poll(() => service.state.connectRequests, { timeout: 15000 }).toBe(1);
      await expect(page.locator('#enableComicTranslation')).not.toBeChecked();
      await expect(page.locator('#comicTargetLang')).toBeDisabled();
      expect(await worker.evaluate(
        () => chrome.storage.sync.get({ enableComicTranslation: false }),
      )).toEqual({ enableComicTranslation: false });
    } finally {
      await service.close();
    }
  });

  // The gate belongs to the switch, not to the card. Both controls persist the
  // same pair of keys, so a language select that ran the gate would ask for a
  // sign-in over picking a language — and turn the feature off if it were
  // declined. It must also not carry the switch along: the select writes the
  // stored preference, never whatever the checkbox happens to be showing.
  test('picking a language never prompts for sign-in or moves the switch', async ({ context, page, extensionId }) => {
    const service = await startMockService();
    try {
      const worker = await connectExtension(context, service.base, { enabled: false });
      await worker.evaluate(() => chrome.storage.sync.set({ enablePdfTranslation: true, pdfTargetLang: '' }));
      await page.goto(`chrome-extension://${extensionId}/options/options.html`);
      await expect(page.locator('#comicSignedIn')).toBeVisible();
      await expect(page.locator('#enablePdfTranslation')).toBeChecked();

      await page.locator('#pdfTargetLang').selectOption('ja');

      await expect.poll(async () => worker.evaluate(
        () => chrome.storage.sync.get({ enablePdfTranslation: false, pdfTargetLang: '' }),
      )).toEqual({ enablePdfTranslation: true, pdfTargetLang: 'ja' });
      await expect(page.locator('#enablePdfTranslation')).toBeChecked();
      // No sign-in tab was opened on the way.
      expect(service.state.connectRequests).toBe(0);
    } finally {
      await service.close();
    }
  });

  // The state a signed-out device is in the moment sync delivers a preference
  // from a device that is signed in. Both features run on our servers, so this
  // one cannot have them on — and must not answer by writing the preference off
  // and syncing that back to the device that can.
  test('a synced-on switch stays off while this device has no account', async ({ context, page, extensionId }) => {
    const service = await startMockService({ connect: 'no-token' });
    try {
      const worker = await connectExtension(context, service.base, { withToken: false, enabled: true });
      await worker.evaluate(() => chrome.storage.sync.set({ enablePdfTranslation: true }));
      await page.goto(`chrome-extension://${extensionId}/options/options.html`);
      await expect(page.locator('#comicSignedOut')).toBeVisible();

      await expect(page.locator('#enableComicTranslation')).not.toBeChecked();
      await expect(page.locator('#enablePdfTranslation')).not.toBeChecked();
      await expect(page.locator('#comicTargetLang')).toBeDisabled();
      await expect(page.locator('#pdfTargetLang')).toBeDisabled();

      // Rendering it off is not the same as answering it off.
      expect(await worker.evaluate(
        () => chrome.storage.sync.get({ enableComicTranslation: false, enablePdfTranslation: false }),
      )).toEqual({ enableComicTranslation: true, enablePdfTranslation: true });
      // And nothing about drawing the page went looking for an account.
      expect(service.state.connectRequests).toBe(0);
    } finally {
      await service.close();
    }
  });

  // The switches are live from the first paint, but the account they depend on
  // arrives over the network. Nothing about "not answered yet" looks different
  // from "signed out" unless the gate waits for the answer.
  test('turning a switch on before the account lands does not open a sign-in tab', async ({ context, page, extensionId }) => {
    const service = await startMockService({ meDelayMs: 2000 });
    try {
      const worker = await connectExtension(context, service.base, { enabled: false });
      await page.goto(`chrome-extension://${extensionId}/options/options.html`);
      // A good token is in local storage; only the answer is outstanding.
      await expect(page.locator('#comicAccountLoading')).toBeVisible();

      await page.locator('label:has(#enableComicTranslation)').click();

      await expect(page.locator('#comicSignedIn')).toBeVisible();
      await expect(page.locator('#enableComicTranslation')).toBeChecked();
      await expect.poll(() => worker.evaluate(
        () => chrome.storage.sync.get({ enableComicTranslation: false }),
      )).toEqual({ enableComicTranslation: true });
      expect(service.state.connectRequests).toBe(0);
    } finally {
      await service.close();
    }
  });

  // Hiding entry points only governs what gets rendered next: a popup, an
  // upload page or a comic overlay that was already open when the switch went
  // off keeps its buttons. The worker is what actually decides.
  test('a create is refused for a feature whose switch is off', async ({ context, page, extensionId }) => {
    const service = await startMockService();
    try {
      const worker = await connectExtension(context, service.base, { enabled: false });
      await worker.evaluate(() => chrome.storage.sync.set({ enablePdfTranslation: false }));
      await page.goto(`chrome-extension://${extensionId}/options/options.html`);

      const comic = await page.evaluate(() => chrome.runtime.sendMessage({
        type: 'COMIC_JOB_CREATE', job: { imageUrl: 'https://example.com/page.png' },
      }));
      const pdf = await page.evaluate(() => chrome.runtime.sendMessage({
        type: 'PDF_CREATE_JOB', source: { kind: 'url', url: 'https://example.com/doc.pdf' },
      }));

      expect(comic.ok).toBe(false);
      expect(comic.error.code).toBe('feature_disabled');
      expect(pdf.ok).toBe(false);
      expect(pdf.error.code).toBe('feature_disabled');
    } finally {
      await service.close();
    }
  });

  // Sign-in already returns the account: the worker saves the token and fetches
  // it in the same call. A second round-trip would only add a way to fail after
  // succeeding — a transient error on it reads as "not signed in", clears the
  // checkbox, and demands the account that was just created.
  test('a successful sign-in renders the account it was handed, without asking again', async ({ context, page, extensionId }) => {
    const service = await startMockService();
    try {
      const worker = await connectExtension(context, service.base, { withToken: false, enabled: false });
      await page.goto(`chrome-extension://${extensionId}/options/options.html`);
      await expect(page.locator('#comicSignedOut')).toBeVisible();
      // The sign-out state cost nothing to determine: no token, no request.
      expect(service.state.meRequests).toBe(0);

      await page.locator('label:has(#enableComicTranslation)').click();

      await expect(page.locator('#comicSignedIn')).toBeVisible();
      await expect(page.locator('#comicEmail')).toHaveText(ACCOUNT.user.email);
      await expect(page.locator('#comicPagesRemaining')).toHaveText('24');
      await expect(page.locator('#enableComicTranslation')).toBeChecked();
      // One account fetch for the whole sign-in: the one inside it.
      expect(service.state.meRequests).toBe(1);
    } finally {
      await service.close();
    }
  });

  // Both switches are live while signed out, so both gates can be reached
  // before either has an account to check. Two independent flows would open two
  // authentication tabs, and the second to finish would overwrite the first.
  test('turning both switches on at once runs one sign-in, not two', async ({ context, page, extensionId }) => {
    const service = await startMockService({ connectDelayMs: 1500 });
    try {
      const worker = await connectExtension(context, service.base, { withToken: false, enabled: false });
      await worker.evaluate(() => chrome.storage.sync.set({ enablePdfTranslation: false }));
      await page.goto(`chrome-extension://${extensionId}/options/options.html`);
      await expect(page.locator('#comicSignedOut')).toBeVisible();

      // Toggled directly rather than by two clicks: the first one flips the
      // account panel to its loading state, which is a different height, and
      // the second click would land on coordinates the reflow has already
      // moved. What matters here is that both handlers reach the gate before
      // either has an answer, which is exactly this.
      await page.evaluate(() => {
        for (const id of ['enableComicTranslation', 'enablePdfTranslation']) {
          const el = document.getElementById(id);
          el.checked = true;
          el.dispatchEvent(new Event('change'));
        }
      });

      await expect(page.locator('#comicSignedIn')).toBeVisible();
      await expect(page.locator('#enableComicTranslation')).toBeChecked();
      await expect(page.locator('#enablePdfTranslation')).toBeChecked();
      await expect.poll(async () => worker.evaluate(
        () => chrome.storage.sync.get({ enableComicTranslation: false, enablePdfTranslation: false }),
      )).toEqual({ enableComicTranslation: true, enablePdfTranslation: true });
      // One authentication tab for both switches.
      expect(service.state.connectRequests).toBe(1);
    } finally {
      await service.close();
    }
  });

  // A read that was already on the wire when the user signed out is answering a
  // question about the account that was.
  test('an account read in flight during sign-out cannot undo it', async ({ context, page, extensionId }) => {
    const service = await startMockService({ meDelayMs: 2000 });
    try {
      const worker = await connectExtension(context, service.base);
      await page.goto(`chrome-extension://${extensionId}/options/options.html`);
      await expect(page.locator('#comicSignedIn')).toBeVisible();

      // The quiet refresh the page runs whenever it comes back to the front,
      // held open by the delayed service.
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await page.locator('#comicSignOut').click();
      await expect(page.locator('#comicSignedOut')).toBeVisible();

      // Long enough for the held-back response to land and be discarded.
      await page.waitForTimeout(3000);
      await expect(page.locator('#comicSignedOut')).toBeVisible();
      await expect(page.locator('#comicSignedIn')).toBeHidden();
      expect(await worker.evaluate(
        () => chrome.storage.local.get({ comicToken: '' }),
      )).toEqual({ comicToken: '' });
    } finally {
      await service.close();
    }
  });

  // Signing out takes both switches off screen with the token — neither feature
  // can run without one — but writes neither off. They are synced, so answering
  // the preference would disable the feature on every other device the account
  // is still signed in on; signing back in is what restores them here.
  test('signing out turns both switches off without answering the synced preference', async ({ context, page, extensionId }) => {
    const service = await startMockService();
    try {
      const worker = await connectExtension(context, service.base);
      await worker.evaluate(() => chrome.storage.sync.set({ enablePdfTranslation: true }));
      await page.goto(`chrome-extension://${extensionId}/options/options.html`);
      await expect(page.locator('#comicSignedIn')).toBeVisible();
      await expect(page.locator('#enableComicTranslation')).toBeChecked();
      await expect(page.locator('#enablePdfTranslation')).toBeChecked();

      await page.locator('#comicSignOut').click();

      await expect(page.locator('#comicSignedOut')).toBeVisible();
      await expect.poll(async () => worker.evaluate(
        () => chrome.storage.local.get({ comicToken: '' }),
      )).toEqual({ comicToken: '' });
      await expect(page.locator('#enableComicTranslation')).not.toBeChecked();
      await expect(page.locator('#enablePdfTranslation')).not.toBeChecked();
      await expect(page.locator('#comicTargetLang')).toBeDisabled();
      await expect(page.locator('#pdfTargetLang')).toBeDisabled();
      await expect.poll(async () => worker.evaluate(
        () => chrome.storage.sync.get({ enableComicTranslation: false, enablePdfTranslation: false }),
      )).toEqual({ enableComicTranslation: true, enablePdfTranslation: true });
    } finally {
      await service.close();
    }
  });
});
