/**
 * A signed-out user can turn the PDF and comic hints off (D-365, option A).
 *
 * Both features ship switched on, and the hints appear on PDFs and comic
 * readers for a user who has never signed in — that is who they are for. The
 * settings page is where such a user says "no thanks", so it has to show the
 * switch as it is stored (on, "takes effect once you sign in") and let it go
 * off without a sign-in. Only turning a switch back on asks for an account.
 *
 * The journey, not the page: the hints are shown first (so their absence later
 * is not an accident of timing), switched off in settings, and then looked for
 * again on a PDF and on a comic reader the extension has not hinted on yet.
 */
const { test, expect } = require('./fixtures');
const { getServiceWorker, getSyncSetting, setExtensionSettings } = require('./helpers');
const { startDocService } = require('./doc-service-mock');
const { SOURCE_PNG } = require('./comic-fixtures');

const BAR = '#ai-translator-auto-bar';
const OFFER = `${BAR}[data-mode="offer"]`;
const READER_BEFORE = 'https://comics-before.test';
const READER_AFTER = 'https://comics-after.test';

const readerPage = () => `<!doctype html><html><body style="margin:0">
<main style="width:600px;margin:0 auto">${[1, 2, 3]
  .map((n) => `<img src="/p${n}.png" width="600" height="900" style="display:block">`).join('')}</main>
</body></html>`;

async function routeReaders(context) {
  for (const origin of [READER_BEFORE, READER_AFTER]) {
    await context.route(`${origin}/read/1`, (r) => r.fulfill({ contentType: 'text/html', body: readerPage() }));
    await context.route(`${origin}/p*.png`, (r) => r.fulfill({ contentType: 'image/png', body: SOURCE_PNG }));
  }
}

async function signedOutWithBothOn(page, base) {
  await setExtensionSettings(page, { enableComicTranslation: true, enablePdfTranslation: true });
  const worker = await getServiceWorker(page.context());
  await worker.evaluate(async (apiBase) => {
    await chrome.storage.sync.remove('comicHintHosts');
    await chrome.storage.local.remove(['comicToken', 'comicTokenExpiresAt', 'comicAccountCache']);
    await chrome.storage.local.set({ comicApiBase: apiBase });
  }, base);
  return worker;
}

const hintHosts = (worker) => worker.evaluate(
  () => chrome.storage.sync.get('comicHintHosts').then((r) => r.comicHintHosts || []));

test('signed out, switching both features off in settings takes the PDF and comic hints away', async ({ context, page, extensionId }) => {
  const service = await startDocService();
  try {
    const worker = await signedOutWithBothOn(page, service.base);
    await routeReaders(context);

    // Before: both hints appear for this signed-out user.
    await page.goto(`${service.base}/paper.pdf`);
    await expect(page.locator(OFFER)).toBeVisible({ timeout: 15000 });
    await page.goto(`${READER_BEFORE}/read/1`);
    await expect(page.locator(OFFER)).toBeVisible({ timeout: 15000 });

    // Settings show the switches as stored — on — and say what is missing.
    await page.goto(`chrome-extension://${extensionId}/options/options.html`);
    await expect(page.locator('#comicSignedOut')).toBeVisible();
    for (const [feature, key] of [['comic', 'enableComicTranslation'], ['pdf', 'enablePdfTranslation']]) {
      const toggle = page.locator(`#${key}`);
      const pending = page.locator(`#${feature}SignInPending`);
      await expect(toggle).toBeChecked();
      await expect(pending).toBeVisible();
      await expect(pending).toHaveText('On. Takes effect once you sign in.');

      // Off, with no sign-in on the way.
      await page.locator(`label:has(#${key})`).click();
      await expect(toggle).not.toBeChecked();
      await expect(pending).toBeHidden();
      await expect.poll(() => getSyncSetting(context, key)).toBe(false);
    }
    expect(service.state.connects).toBe(0);

    // After: neither hint appears. The reader is a host that has never had its
    // hint, so only the switch can be what keeps it quiet.
    await page.goto(`${service.base}/paper.pdf`);
    await page.waitForLoadState('load');
    await page.waitForTimeout(3000);
    await expect(page.locator(OFFER)).toBeHidden();

    await page.goto(`${READER_AFTER}/read/1`);
    await page.waitForLoadState('load');
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(3000);
    await expect(page.locator(OFFER)).toBeHidden();
    expect(await hintHosts(worker)).toEqual(['comics-before.test']);
    expect(service.state.connects).toBe(0);
  } finally {
    await service.close();
  }
});
