/**
 * The popup's PDF and comic entries on a device that is not signed in (D-467).
 *
 * "Not signed in" and "turned off" are two different answers
 * (shared/account-gate.js): signed out means the entry is offered and using it
 * signs in first; off means it is gone. These journeys pin both, from the
 * popup the user actually clicks:
 *
 *   A1  a PDF tab: both document rows show, no task list is asked for; a click
 *       signs in and then hands the PDF over with no second click; closing the
 *       sign-in tab does nothing at all.
 *   A2  a comic page, and an image opened on its own: the comic rows show; a
 *       click asks for a sign-in on the page and then runs the job by itself.
 *   A3  both switches off, signed in or not: none of the five rows show.
 *
 * The popup is opened as a tab beside the page and the page is brought back to
 * the front before the popup asks which tab is active — the frames.spec.js
 * pattern. Everything after the click is the production path: the worker's
 * sign-in tab, the mock's /ext/connect bounce, the real job requests.
 */
const { test, expect } = require('./fixtures');
const { getServiceWorker, waitForFloatBall } = require('./helpers');
const { startDocService } = require('./doc-service-mock');
const comicFixtures = require('./comic-fixtures');

const BAR = '#ai-translator-auto-bar';
const ROWS = ['#pdfTranslateCurrent', '#pdfTranslateLocal', '#comicTranslatePage', '#comicColorizePage'];

/**
 * Point the extension at `base` with both features switched as given, and with
 * or without a token on this device.
 */
async function connectExtension(context, base, { signedIn, enabled = true }) {
  const worker = await getServiceWorker(context);
  await worker.evaluate(async ({ base, signedIn, enabled }) => {
    await chrome.storage.sync.set({ enablePdfTranslation: enabled, enableComicTranslation: enabled });
    await chrome.storage.local.remove([
      'comicToken', 'comicTokenExpiresAt', 'comicAccountCache', 'comicJobs', 'pdfJobs', 'pdfUrlOps',
    ]);
    const values = { comicApiBase: base };
    if (signedIn) {
      values.comicToken = 'test-token';
      values.comicTokenExpiresAt = Date.now() + 3600_000;
    }
    await chrome.storage.local.set(values);
  }, { base, signedIn, enabled });
  return worker;
}

/**
 * The popup, asking about `page`. Every runtime message it sends is recorded
 * in `window.__sent`, so a request it must not make can be counted.
 */
async function openPopupOver(context, extensionId, page) {
  const popup = await context.newPage();
  await popup.addInitScript(() => {
    window.__sent = [];
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = (message, ...rest) => {
      window.__sent.push(message && message.type);
      return send(message, ...rest);
    };
  });
  await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  // goto() fronted the popup's tab; give the window back to the page and let
  // the popup ask again.
  await page.bringToFront();
  await popup.reload();
  return popup;
}

function storedToken(worker) {
  return worker.evaluate(() => chrome.storage.local.get('comicToken').then(r => r.comicToken || ''));
}

test.describe('A1 · signed out, the popup over a PDF', () => {
  test('offers both document rows, lists nothing, and one click signs in then sends the PDF', async ({ context, page, extensionId }) => {
    const service = await startDocService();
    try {
      const worker = await connectExtension(context, service.base, { signedIn: false });
      await page.goto(`${service.base}/paper.pdf`);
      // The page's own hint is up: its content script is there to take the click.
      await expect(page.locator(`${BAR}[data-mode="offer"]`)).toBeVisible({ timeout: 15000 });

      const popup = await openPopupOver(context, extensionId, page);
      for (const row of ROWS) await expect(popup.locator(row), row).toBeVisible();
      // The task list is the account's: nothing to draw, and nothing asked for.
      await expect(popup.locator('#pdfJobs')).toBeHidden();
      await popup.waitForTimeout(500);
      expect(await popup.evaluate(() => window.__sent)).not.toContain('PDF_JOBS_LIST');
      expect(service.state.connects).toBe(0);
      expect(service.state.apiHits).toEqual([]);

      await popup.locator('#pdfTranslateCurrent').click();

      // Signs in first (the sign-in tab bounces through /ext/connect)...
      await expect.poll(() => service.state.connects, { timeout: 15000 }).toBe(1);
      await expect.poll(() => storedToken(worker)).toBe('granted-token');
      // ...and then the PDF goes out with nobody clicking again.
      await expect.poll(() => service.state.apiHits.filter(h => h === 'POST /api/pdf/jobs').length,
        { timeout: 20000 }).toBe(1);
      expect(service.state.apiHits.filter(h => h === 'POST /api/pdf/uploads')).toHaveLength(1);
    } finally {
      await service.close();
    }
  });

  test('closing the sign-in tab does nothing, and the rows are still there', async ({ context, page, extensionId }) => {
    // The sign-in page that never finishes: the user is looking at it, and
    // closes it.
    const service = await startDocService({ connect: 'hold' });
    try {
      const worker = await connectExtension(context, service.base, { signedIn: false });
      await page.goto(`${service.base}/paper.pdf`);
      const bar = page.locator(`${BAR}[data-mode="offer"]`);
      await expect(bar).toBeVisible({ timeout: 15000 });

      const popup = await openPopupOver(context, extensionId, page);
      await expect(popup.locator('#pdfTranslateCurrent')).toBeVisible();
      const signInTab = context.waitForEvent('page', { predicate: p => p !== popup && p !== page });
      await popup.locator('#pdfTranslateCurrent').click();
      const auth = await signInTab;
      await auth.waitForURL(/\/ext\/connect/);
      await auth.close();

      // Nothing sent, nothing said: a cancel is not a failure.
      await page.waitForTimeout(1500);
      expect(service.state.apiHits).toEqual([]);
      expect(await storedToken(worker)).toBe('');
      await expect(page.locator(`${BAR}[data-mode="notice"]`)).toHaveCount(0);
      // The hint is back as it was, ready for another go.
      await expect(bar).toBeVisible();

      if (!popup.isClosed()) await popup.close();
      const again = await openPopupOver(context, extensionId, page);
      await expect(again.locator('#pdfTranslateCurrent')).toBeVisible();
      await expect(again.locator('#pdfTranslateLocal')).toBeVisible();
    } finally {
      await service.close();
    }
  });
});

test.describe('A2 · signed out, the popup over a comic', () => {
  for (const [name, path] of [['a comic page', '/page'], ['an image opened on its own', '/source.png']]) {
    test(`${name}: the row signs in on the page and the job runs by itself`, async ({ context, page, extensionId }) => {
      const service = await comicFixtures.startMockService('succeed');
      try {
        const worker = await comicFixtures.connectExtension(context, service.base, { withToken: false });
        await page.goto(`${service.base}${path}`);
        const img = page.locator('img').first();
        await expect(img).toBeVisible();
        await waitForFloatBall(page);

        const popup = await openPopupOver(context, extensionId, page);
        await expect(popup.locator('#comicTranslatePage')).toBeVisible();
        await expect(popup.locator('#comicColorizePage')).toBeVisible();

        await popup.locator('#comicTranslatePage').click();

        // The page asks for the sign-in; without a token no create was tried.
        const overlay = page.locator('.ai-translator-comic-overlay');
        const signIn = overlay.locator('.ai-translator-comic-btn.is-primary');
        await expect(signIn).toBeVisible({ timeout: 15000 });
        expect(service.state.createBodies).toHaveLength(0);

        await signIn.click();

        // Signed in, the same job carries on: one create, and the result lands
        // on the image without another click.
        await expect.poll(() => service.state.connects, { timeout: 15000 }).toBe(1);
        await expect.poll(() => storedToken(worker)).toBe('granted-token');
        await expect(img).toHaveAttribute('src', /\/result\.png\?sig=/, { timeout: 20000 });
        expect(service.state.createBodies).toHaveLength(1);
      } finally {
        await service.close();
      }
    });
  }
});

test.describe('A3 · both switches off', () => {
  for (const signedIn of [false, true]) {
    test(`${signedIn ? 'signed in' : 'signed out'}: none of the five rows show`, async ({ context, page, extensionId }) => {
      const service = await startDocService();
      try {
        await connectExtension(context, service.base, { signedIn, enabled: false });
        await page.goto(`${service.base}/paper.pdf`);
        await page.waitForLoadState('load');

        const popup = await openPopupOver(context, extensionId, page);
        // Drawn: the page rows the popup always answers for are up, so the
        // gate has had its say by now.
        await expect(popup.locator('#translatePage')).toBeVisible();
        await popup.waitForTimeout(500);
        for (const row of [...ROWS, '#pdfJobs']) await expect(popup.locator(row), row).toBeHidden();
        expect(await popup.evaluate(() => window.__sent)).not.toContain('PDF_JOBS_LIST');
      } finally {
        await service.close();
      }
    });
  }
});
