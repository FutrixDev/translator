/**
 * Playwright fixtures for Chrome Extension testing
 * Extends base test with extension-loaded browser context
 */
const { test: base, chromium } = require('@playwright/test');
const path = require('path');
const { applyBaseSettings } = require('./helpers');

// Path to the extension
const extensionPath = path.resolve(__dirname, '../../');

const ONBOARDING_PATH = '/onboarding/onboarding.html';
const ONBOARDING_WAIT_MS = 10_000;

/**
 * Every context is a fresh profile, so the extension is freshly *installed* in
 * each one, and background/install.js opens the welcome page on that. Left
 * alone it becomes the active tab a moment after the test's own page opens, and
 * everything that asks for "the active tab" (sendMessageToActiveTab, the popup)
 * would be talking to the welcome page instead. So it is closed before the test
 * body runs — unless the spec is about it (`test.use({ keepOnboarding: true })`).
 *
 * Not finding it is a failure, not a skip: a fresh install that opens no welcome
 * page is exactly the regression onboarding.spec.js J-F1 exists to catch, and a
 * fixture that shrugged would hide it from every other spec too.
 * @param {import('@playwright/test').BrowserContext} context
 */
async function waitForOnboardingPage(context) {
  const deadline = Date.now() + ONBOARDING_WAIT_MS;
  for (;;) {
    const found = context.pages().find((p) => p.url().startsWith('chrome-extension://') && p.url().includes(ONBOARDING_PATH));
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`the onboarding page did not open within ${ONBOARDING_WAIT_MS} ms of install`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * Extended test fixture that loads the Chrome extension
 */
const test = base.extend({
  /** Keep the welcome page a fresh install opens (onboarding.spec.js). */
  keepOnboarding: [false, { option: true }],

  /**
   * Browser context with extension loaded
   * Uses persistent context to support Chrome extensions
   */
  context: async ({ keepOnboarding }, use) => {
    const context = await chromium.launchPersistentContext('', {
      // Chrome's newer headless shell loads unpacked extensions, so the suite no
      // longer has to steal window focus and the pointer while it runs. The
      // `chromium` channel is what selects that shell — the bundled default
      // build still cannot load extensions headless.
      // Set HEADED=1 (or `npm run test:headed`) to watch a run.
      channel: 'chromium',
      headless: !process.env.HEADED,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        '--no-sandbox',
        '--disable-setuid-sandbox',
      ],
      viewport: { width: 1280, height: 720 },
    });

    // Ensure at least one page exists to avoid hanging on page event
    if (context.pages().length === 0) {
      await context.newPage();
    }

    const onboarding = await waitForOnboardingPage(context);
    if (!keepOnboarding) {
      // Closing the last tab would close the window; the blank page above is
      // normally still there, but make sure.
      if (context.pages().length === 1) await context.newPage();
      await onboarding.close();
    }

    // Every context, not only the ones a spec configures: a spec that calls no
    // helper at all still needs the extension pointed at a backend the suite can
    // serve. See E2E_BASE_SETTINGS in helpers.js for what that means and why.
    // This runs before the test body, so it lands before the first page.goto()
    // and the content script reads it on load.
    await applyBaseSettings(context);

    await use(context);
    await context.close();
  },

  /**
   * Extension page - for accessing extension popup/options
   */
  extensionId: async ({ context }, use) => {
    // Get extension ID from service worker
    let extensionId;

    // Wait for service worker to be registered
    const serviceWorkers = await context.serviceWorkers();
    if (serviceWorkers.length > 0) {
      const url = serviceWorkers[0].url();
      const match = url.match(/chrome-extension:\/\/([^/]+)/);
      if (match) {
        extensionId = match[1];
      }
    }

    // Fallback: wait for service worker
    if (!extensionId) {
      const worker = await context.waitForEvent('serviceworker');
      const url = worker.url();
      const match = url.match(/chrome-extension:\/\/([^/]+)/);
      if (match) {
        extensionId = match[1];
      }
    }

    await use(extensionId);
  },

  /**
   * Create a new page with extension loaded
   */
  page: async ({ context }, use) => {
    const page = await context.newPage();
    await use(page);
    await page.close();
  },
});

const { expect } = require('@playwright/test');

module.exports = { test, expect, extensionPath, waitForOnboardingPage };
