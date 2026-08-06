/**
 * The account panel in the options page, shared by comic and PDF translation.
 *
 * It reads the monthly free allowance from the service through the worker, so
 * the service is stubbed and everything else is real: the token in
 * chrome.storage.local, the worker's HTTP client and its 30s account cache,
 * and the rendering of the numbers the user actually acts on. The popup is
 * here too, to prove it stays out of this entirely.
 */
const http = require('node:http');
const { test, expect } = require('./fixtures');

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
 */
function startMockService({ connect = 'token' } = {}) {
  const state = { meRequests: 0, connectRequests: 0 };

  const server = http.createServer((req, res) => {
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
      res.writeHead(302, { location: `${redirect}${fragment}`, 'cache-control': 'no-store' });
      res.end();
      return;
    }

    if (url.pathname === '/api/billing/me') {
      state.meRequests += 1;
      if (!(req.headers.authorization || '').startsWith('Bearer ')) {
        return send(401, { error: 'unauthorized', loginRequired: true });
      }
      return send(200, ACCOUNT);
    }

    send(404, { error: 'not_found' });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        base: `http://localhost:${server.address().port}`,
        state,
        close: () => new Promise(done => server.close(done)),
      });
    });
  });
}

async function serviceWorker(context) {
  const [existing] = context.serviceWorkers();
  return existing || context.waitForEvent('serviceworker');
}

/**
 * Point the extension at the mock and give it a token, as a real sign-in would.
 *
 * The feature ships off, so it is switched on here: these tests are about what
 * a user who wants comic translation sees, and the off state has its own tests.
 */
async function connectExtension(context, base, { withToken = true, enabled = true } = {}) {
  const worker = await serviceWorker(context);
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

  test('shows and hides the image context menu entry', async ({ context }) => {
    const worker = await serviceWorker(context);
    // chrome.contextMenus has no read API, so the call the worker makes is the
    // only observable. Record it, then flip the setting the way options does.
    await worker.evaluate(async () => {
      globalThis.__menuUpdates = [];
      const original = chrome.contextMenus.update.bind(chrome.contextMenus);
      chrome.contextMenus.update = (id, props, cb) => {
        globalThis.__menuUpdates.push({ id, visible: props && props.visible });
        return original(id, props, cb);
      };
      await chrome.storage.sync.set({ enableComicTranslation: false });
    });

    const visibilityCalls = () => worker.evaluate(() => globalThis.__menuUpdates
      .filter(u => u.id === 'translate-comic-image' && u.visible !== undefined)
      .map(u => u.visible));

    await worker.evaluate(() => chrome.storage.sync.set({ enableComicTranslation: true }));
    await expect.poll(visibilityCalls).toContain(true);

    await worker.evaluate(() => chrome.storage.sync.set({ enableComicTranslation: false }));
    await expect.poll(async () => (await visibilityCalls()).at(-1)).toBe(false);

    await worker.evaluate(() => { delete globalThis.__menuUpdates; });
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

  test('signing out turns both features off', async ({ context, page, extensionId }) => {
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
      await expect(page.locator('#enableComicTranslation')).not.toBeChecked();
      await expect(page.locator('#enablePdfTranslation')).not.toBeChecked();
      // Storage is what actually retracts the context menus and popup rows.
      await expect.poll(async () => worker.evaluate(
        () => chrome.storage.sync.get({ enableComicTranslation: true, enablePdfTranslation: true }),
      )).toEqual({ enableComicTranslation: false, enablePdfTranslation: false });
    } finally {
      await service.close();
    }
  });
});
