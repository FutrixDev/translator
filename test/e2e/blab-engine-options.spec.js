/**
 * Blab Translation in the options page: the third engine survives the page
 * that edits it (D-479), and the two engine selects say whether it can be used
 * right now (design §5.4, journeys J1 1–2/7 and J2).
 *
 * The service is stubbed (test/e2e/mock-blab-service.js implements the §2
 * contract); everything else is real: the token in chrome.storage.local, the
 * worker's account cache, the page's own save path.
 */
const { test, expect } = require('./fixtures');
const { connectExtension, writeSyncSettings, getSyncSettings } = require('./helpers');
const { startMockServer } = require('./mock-server');

test.describe('Blab Translation as a stored engine', () => {
  test('a stored blab survives loading, a whole-form save and a reload', async ({ context, page, extensionId }) => {
    // No service needed for this one: the value must survive whether or not the
    // engine can be used right now — signed out, the option is disabled but the
    // setting is the user's and stays as it is.
    const { origin, close } = await startMockServer((req, res) => {
      res.writeHead(404);
      res.end();
    });
    try {
      await connectExtension(context, origin, { signedIn: false });
      await writeSyncSettings(context, { translationEngine: 'blab', autoTranslateEngine: 'blab' });
      await page.goto(`chrome-extension://${extensionId}/options/options.html`);

      await expect(page.locator('#translationEngine')).toHaveValue('blab');
      await expect(page.locator('#autoTranslateEngine')).toHaveValue('blab');

      // A change to any other field saves the whole form (collectSettings): that
      // is the path that used to write 'builtin' back over the third value.
      const floatBall = page.locator('label:has(#showFloatBall)');
      await floatBall.click();
      await expect.poll(async () => (await getSyncSettings(context, ['showFloatBall'])).showFloatBall)
        .toBe(false);
      expect(await getSyncSettings(context, ['translationEngine', 'autoTranslateEngine']))
        .toEqual({ translationEngine: 'blab', autoTranslateEngine: 'blab' });

      await page.reload();
      await expect(page.locator('#translationEngine')).toHaveValue('blab');
      await expect(page.locator('#autoTranslateEngine')).toHaveValue('blab');
    } finally {
      await close();
    }
  });
});
