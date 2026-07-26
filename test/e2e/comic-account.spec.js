/**
 * Comic account state in the options page and the popup.
 *
 * Both surfaces read the balance from the service through the worker, so the
 * service is stubbed and everything else is real: the token in
 * chrome.storage.local, the worker's HTTP client and its 30s account cache,
 * and the rendering of the numbers the user actually acts on.
 */
const http = require('node:http');
const { test, expect } = require('./fixtures');

const ACCOUNT = {
  user: { email: 'reader@example.com', name: 'Reader' },
  balancePoints: 240,
  pagesRemaining: 24,
  freeQuota: { remaining: 3, total: 5 },
};

function startMockService() {
  const state = { meRequests: 0 };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };

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
  test('options page shows the balance when signed in', async ({ context, page, extensionId }) => {
    const service = await startMockService();
    try {
      await connectExtension(context, service.base);
      await page.goto(`chrome-extension://${extensionId}/options/options.html`);

      await expect(page.locator('#comicSignedIn')).toBeVisible();
      await expect(page.locator('#comicEmail')).toHaveText(ACCOUNT.user.email);
      await expect(page.locator('#comicPagesRemaining')).toHaveText(String(ACCOUNT.pagesRemaining));
      await expect(page.locator('#comicBalance')).toHaveText(String(ACCOUNT.balancePoints));
      await expect(page.locator('#comicFreeQuota')).toHaveText(String(ACCOUNT.freeQuota.remaining));
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

  test('popup shows pages remaining, and a sign-in prompt without a token', async ({ context, page, extensionId }) => {
    const service = await startMockService();
    try {
      await connectExtension(context, service.base);
      await page.goto(`chrome-extension://${extensionId}/popup/popup.html`);
      // Pages, not points — the popup has room for one number only.
      await expect(page.locator('#comicAccountStatus')).toHaveText(String(ACCOUNT.pagesRemaining));

      await connectExtension(context, service.base, { withToken: false });
      await page.reload();
      await expect(page.locator('#comicAccountStatus')).not.toHaveText(String(ACCOUNT.pagesRemaining));
      await expect(page.locator('#comicAccountStatus')).not.toBeEmpty();
    } finally {
      await service.close();
    }
  });
});

test.describe('Comic translation switch', () => {
  test('is off out of the box and hides the popup row', async ({ context, page, extensionId }) => {
    const service = await startMockService();
    try {
      await connectExtension(context, service.base, { enabled: false });
      await page.goto(`chrome-extension://${extensionId}/popup/popup.html`);

      await expect(page.locator('#comicAccount')).toBeHidden();
      // A feature nobody switched on must not talk to a paid service.
      expect(service.state.meRequests).toBe(0);
    } finally {
      await service.close();
    }
  });

  test('writes immediately and gates the language select', async ({ context, page, extensionId }) => {
    const service = await startMockService();
    try {
      const worker = await connectExtension(context, service.base, { enabled: false });
      await page.goto(`chrome-extension://${extensionId}/options/options.html`);

      // Off: the account block is not merely empty, it is absent, and nothing
      // has been asked of the service.
      await expect(page.locator('#comicSignedIn')).toBeHidden();
      await expect(page.locator('#comicSignedOut')).toBeHidden();
      await expect(page.locator('#comicAccountLoading')).toBeHidden();
      expect(service.state.meRequests).toBe(0);

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
