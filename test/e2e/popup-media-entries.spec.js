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
 *       sign-in tab does nothing at all. Where the page cannot take the click
 *       (no content script answers) or is not a PDF document after all (a .pdf
 *       URL serving a comic page), the popup opens exactly one sign-in itself
 *       and nothing else starts — above all no comic job.
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
const { connectExtension, waitForFloatBall } = require('./helpers');
const { startDocService } = require('./doc-service-mock');
const comicFixtures = require('./comic-fixtures');

const BAR = '#ai-translator-auto-bar';
const ROWS = ['#pdfTranslateCurrent', '#pdfTranslateLocal', '#comicTranslatePage', '#comicColorizePage'];

/**
 * The popup, asking about `page`. Every runtime message it sends is recorded
 * in `window.__sent`, so a request it must not make can be counted.
 *
 * `noReceiver` is a tab with no content script to answer (a restricted page,
 * an extension reloaded under the page): every chrome.tabs.sendMessage fails
 * the way Chrome fails it.
 */
async function openPopupOver(context, extensionId, page, { noReceiver = false } = {}) {
  const popup = await context.newPage();
  await popup.addInitScript((noReceiver) => {
    window.__sent = [];
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = (message, ...rest) => {
      window.__sent.push(message && message.type);
      return send(message, ...rest);
    };
    if (noReceiver) {
      chrome.tabs.sendMessage = () => Promise.reject(
        new Error('Could not establish connection. Receiving end does not exist.'));
    }
  }, noReceiver);
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
      // One sign-in tab, all the way to the job: the popup did not open its own.
      expect(service.state.connects).toBe(1);
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
      // ...and nothing opened a second sign-in behind the one that was closed.
      expect(service.state.connects).toBe(1);
      expect(context.pages().filter(p => /\/ext\/connect/.test(p.url()))).toHaveLength(0);
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

test.describe('A1 · signed out, the page does not take the hand-off', () => {
  /** The popup's own console, which names which of the two answers it got. */
  function popupWarnings(popup) {
    const lines = [];
    popup.on('console', (m) => { if (m.type() === 'warning') lines.push(m.text()); });
    return lines;
  }

  test('no content script answers: one sign-in from the popup, and no PDF job', async ({ context, page, extensionId }) => {
    const service = await startDocService();
    try {
      const worker = await connectExtension(context, service.base, { signedIn: false });
      await page.goto(`${service.base}/paper.pdf`);
      await expect(page.locator(`${BAR}[data-mode="offer"]`)).toBeVisible({ timeout: 15000 });

      const popup = await openPopupOver(context, extensionId, page, { noReceiver: true });
      const warnings = popupWarnings(popup);
      await expect(popup.locator('#pdfTranslateCurrent')).toBeVisible();
      await popup.locator('#pdfTranslateCurrent').click();

      await expect.poll(() => service.state.connects, { timeout: 15000 }).toBe(1);
      await expect.poll(() => storedToken(worker)).toBe('granted-token');
      expect(warnings.join('\n')).toContain('no content script took the signed-out PDF translate');
      // Signed in, and the PDF is one more click away: nothing went out by itself.
      await page.waitForTimeout(2000);
      expect(service.state.connects).toBe(1);
      expect(service.state.apiHits).toEqual([]);
    } finally {
      await service.close();
    }
  });

  test('a .pdf URL that is a comic page: one sign-in, no comic job, no PDF job', async ({ context, page, extensionId }) => {
    const service = await comicFixtures.startMockService('succeed');
    try {
      const worker = await connectExtension(context, service.base, { signedIn: false });
      await page.goto(`${service.base}/comic.pdf`);
      await expect(page.locator('img').first()).toBeVisible();
      await waitForFloatBall(page);

      const popup = await openPopupOver(context, extensionId, page);
      const warnings = popupWarnings(popup);
      // The URL looks like a PDF, so the row is offered.
      await expect(popup.locator('#pdfTranslateCurrent')).toBeVisible();
      await popup.locator('#pdfTranslateCurrent').click();

      await expect.poll(() => service.state.connects, { timeout: 15000 }).toBe(1);
      await expect.poll(() => storedToken(worker)).toBe('granted-token');
      expect(warnings.join('\n')).toContain('the page says it is not a PDF document');
      // Long enough for a comic job the page started on its own to reach the
      // service after the sign-in landed.
      await page.waitForTimeout(3000);
      expect(service.state.connects).toBe(1);
      expect(service.state.createBodies).toHaveLength(0);
      expect(service.state.pdfHits).toEqual([]);
      await expect(page.locator('.ai-translator-comic-overlay')).toHaveCount(0);
      await expect(page.locator(`${BAR}[data-mode="notice"]`)).toHaveCount(0);
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
        const worker = await connectExtension(context, service.base, { signedIn: false });
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
        await connectExtension(context, service.base, { signedIn, comic: false, pdf: false });
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
