// The settings page's Send feedback button. Feedback is filed on the account
// site, which asks for an account, so a signed-out click signs in first and
// then the worker opens the form at the configured site, tagged as coming from
// the settings page.
const { test, expect } = require('./fixtures');
const { setUp, openOptions, storedToken, en } = require('./blab-journey');

const BUTTON = '#feedbackButton';

async function clickForTab(context, options) {
  const [tab] = await Promise.all([
    context.waitForEvent('page', { predicate: (p) => p.url().includes('/app/feedback') }),
    options.locator(BUTTON).click(),
  ]);
  return tab;
}

test.describe('Send feedback from the settings page', () => {
  test('signed in: the button opens the feedback form at the site, once', async ({ context, page, extensionId }) => {
    const { blab, close } = await setUp(context, page, { signedIn: true });
    try {
      const options = await openOptions(context, extensionId);
      await expect(options.locator(BUTTON)).toHaveText(en('feedbackLink'));

      const tab = await clickForTab(context, options);
      await expect.poll(() => tab.url()).toBe(`${blab.base}/app/feedback?utm_source=extension&utm_medium=options`);
      expect(blab.state.connects).toBe(0);
      expect(context.pages().filter((p) => p.url().includes('/app/feedback'))).toHaveLength(1);
      await expect(options.locator('#statusMessage')).not.toHaveClass(/\berror\b/);
    } finally {
      await close();
    }
  });

  test('signed out: the click signs in first, then opens the form', async ({ context, page, extensionId }) => {
    const { blab, close } = await setUp(context, page, { signedIn: false });
    try {
      const options = await openOptions(context, extensionId);
      await expect(options.locator('#comicSignIn')).toBeVisible();

      const tab = await clickForTab(context, options);
      expect(await storedToken(context)).toBe('granted-token');
      expect(blab.state.connects).toBe(1);
      await expect.poll(() => tab.url()).toBe(`${blab.base}/app/feedback?utm_source=extension&utm_medium=options`);
      await expect(options.locator('#comicSignedIn')).toBeVisible();
    } finally {
      await close();
    }
  });
});
