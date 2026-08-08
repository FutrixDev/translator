/**
 * Test helper functions for AI Translator E2E tests
 */

/**
 * Wait for the float ball to appear on the page
 * @param {import('@playwright/test').Page} page
 * @param {number} timeout
 */
async function waitForFloatBall(page, timeout = 10000) {
  await page.waitForSelector('#ai-translator-float-ball', {
    state: 'visible',
    timeout,
  });
}

/**
 * Click the float ball to open menu
 * @param {import('@playwright/test').Page} page
 */
async function openFloatBallMenu(page) {
  await page.click('#ai-translator-float-ball');
  await page.waitForSelector('#ai-translator-float-menu', {
    state: 'visible',
    timeout: 5000,
  });
}

/**
 * Trigger page translation via float ball menu
 * @param {import('@playwright/test').Page} page
 */
async function triggerPageTranslation(page) {
  await openFloatBallMenu(page);
  await page.click('.ai-translator-menu-item[data-action="translate-page"]');
}

/**
 * Wait for translation to complete
 * @param {import('@playwright/test').Page} page
 * @param {number} timeout
 */
async function waitForTranslationComplete(page, timeout = 60000) {
  // Wait for progress bar to appear and then disappear
  try {
    await page.waitForSelector('#ai-translator-progress', {
      state: 'visible',
      timeout: 5000,
    });
  } catch {
    // Progress bar might not appear for quick translations
  }

  // Wait for at least one translated element
  await page.waitForSelector('.ai-translator-translated', {
    state: 'attached',
    timeout,
  });

  // Wait for progress bar to disappear (translation complete)
  await page.waitForSelector('#ai-translator-progress', {
    state: 'hidden',
    timeout,
  }).catch(() => {});
}

/**
 * Get element position info for alignment verification
 * @param {import('@playwright/test').Page} page
 * @param {string} selector
 */
async function getElementPosition(page, selector) {
  return await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
      paddingLeft: parseFloat(style.paddingLeft) || 0,
    };
  }, selector);
}

/**
 * Verify translation alignment with original text
 * @param {import('@playwright/test').Page} page
 * @param {string} originalSelector - Selector for original text element
 * @param {string} translationSelector - Selector for translation element
 * @param {number} tolerance - Allowed pixel difference
 */
async function verifyAlignment(page, originalSelector, translationSelector, tolerance = 2) {
  const result = await page.evaluate(
    ({ origSel, transSel }) => {
      const original = document.querySelector(origSel);
      const translation = document.querySelector(transSel);

      if (!original || !translation) {
        return { success: false, error: 'Elements not found' };
      }

      const originalRect = original.getBoundingClientRect();
      const translationRect = translation.getBoundingClientRect();
      const translationStyle = window.getComputedStyle(translation);
      const translationPaddingLeft = parseFloat(translationStyle.paddingLeft) || 0;

      // Calculate effective left position (considering padding)
      const translationEffectiveLeft = translationRect.left + translationPaddingLeft;

      return {
        success: true,
        originalLeft: originalRect.left,
        translationLeft: translationRect.left,
        translationPaddingLeft,
        translationEffectiveLeft,
        diff: Math.abs(originalRect.left - translationEffectiveLeft),
      };
    },
    { origSel: originalSelector, transSel: translationSelector }
  );

  return result;
}

/**
 * Count elements on page
 * @param {import('@playwright/test').Page} page
 * @param {string} selector
 */
async function countElements(page, selector) {
  return await page.locator(selector).count();
}

/**
 * Check if float ball exists in DOM
 * @param {import('@playwright/test').Page} page
 */
async function floatBallExists(page) {
  return await page.evaluate(() => {
    const ball = document.getElementById('ai-translator-float-ball');
    return ball && document.body.contains(ball);
  });
}

/**
 * Trigger selection translation hotkey.
 * @param {import('@playwright/test').Page} page
 * @param {string} hotkey
 */
async function triggerSelectionHotkey(page, hotkey = process.platform === 'darwin' ? 'Meta' : 'Control') {
  await page.keyboard.press(hotkey);
}

/**
 * Get current theme
 * @param {import('@playwright/test').Page} page
 */
async function getCurrentTheme(page) {
  return await page.evaluate(() => {
    return document.documentElement.getAttribute('data-ai-translator-theme');
  });
}

/**
 * The settings every E2E run needs in place before the extension will do what
 * the specs are about to assert.
 *
 * `translationEngine` is the whole list, and it is not a preference — it is what
 * makes the suite testable at all. The extension ships with Chrome's built-in
 * on-device Translator selected (`translationEngine: 'builtin'`, see
 * background/background.js), and in the test browser that engine is *present*
 * and reports en→zh as `downloadable`: it wants a language pack that never
 * finishes downloading there. Every path that awaits `Translator.create()` then
 * hangs for good — including the prefetch in
 * content/content-translation-engine.js, which fires on the page's first
 * keydown or pointerdown and caches the hung promise for every later request on
 * that page.
 *
 * Left at the shipped default the failure is silent and misleading: a spec that
 * stands up mock-openai-server.js sees zero requests, and a spec that waits on a
 * translation waits out its full timeout, because the content script answered
 * the request itself and never reached the service worker at all.
 *
 * So the harness pins the AI backend — the one the mock servers speak. A spec
 * that means to exercise the built-in engine passes `translationEngine`
 * explicitly to setExtensionSettings and wins over this.
 */
const E2E_BASE_SETTINGS = Object.freeze({
  translationEngine: 'ai',
});

/**
 * The extension's service worker — the only context here holding `chrome.*`.
 * It registers a moment after the browser context launches, so a caller that
 * gets there first has to wait for it.
 * @param {import('@playwright/test').BrowserContext} context
 */
async function getServiceWorker(context) {
  return context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
}

/**
 * @param {import('@playwright/test').BrowserContext} context
 * @param {object} settings
 */
async function writeSyncSettings(context, settings) {
  const worker = await getServiceWorker(context);
  await worker.evaluate((newSettings) => {
    return new Promise((resolve) => {
      chrome.storage.sync.set(newSettings, resolve);
    });
  }, settings);
}

/**
 * Read settings back out of chrome.storage.sync — the counterpart to the write
 * above, and the shape the assertions want: whatever a spec just clicked in the
 * options page, is it actually stored?
 * @param {import('@playwright/test').BrowserContext} context
 * @param {string[]} keys
 * @returns {Promise<object>}
 */
async function getSyncSettings(context, keys) {
  const worker = await getServiceWorker(context);
  return worker.evaluate((settingKeys) => new Promise((resolve) => {
    chrome.storage.sync.get(settingKeys, resolve);
  }), keys);
}

/**
 * One setting, unwrapped. Safe inside expect.poll — it reads storage fresh each
 * call rather than closing over a value.
 * @param {import('@playwright/test').BrowserContext} context
 * @param {string} key
 */
async function getSyncSetting(context, key) {
  const values = await getSyncSettings(context, [key]);
  return values[key];
}

/**
 * Put E2E_BASE_SETTINGS in place. The fixture in fixtures.js calls this once per
 * browser context, so the specs that never touch settings at all — most of
 * hover-translation.spec.js — are covered too.
 * @param {import('@playwright/test').BrowserContext} context
 */
async function applyBaseSettings(context) {
  await writeSyncSettings(context, { ...E2E_BASE_SETTINGS });
}

/**
 * Set extension settings via chrome.storage, on top of E2E_BASE_SETTINGS.
 * Anything the caller names wins over the baseline.
 * @param {import('@playwright/test').Page} page
 * @param {object} settings
 */
async function setExtensionSettings(page, settings) {
  await writeSyncSettings(page.context(), { ...E2E_BASE_SETTINGS, ...settings });
}

/**
 * Give the extension the account that comic and PDF translation require.
 *
 * Comic and PDF translation are gated on a token in chrome.storage.local as
 * well as on their switches (see shared/account-gate.js), so any test about
 * either feature being ON has to establish one. The account cache is seeded
 * alongside the token so nothing reaches the network: getAccount() serves it
 * for 30 seconds before asking the service.
 *
 * @param {import('@playwright/test').Page} page
 * @param {boolean} signedIn pass false to put the device back to signed out
 */
async function setExtensionAccount(page, signedIn = true) {
  const worker = await getServiceWorker(page.context());
  await worker.evaluate(async (isSignedIn) => {
    if (!isSignedIn) {
      await chrome.storage.local.remove(['comicToken', 'comicTokenExpiresAt', 'comicAccountCache']);
      return;
    }
    const quota = { limit: 40, used: 0, remaining: 40, applied: false, resetsAt: '2099-02-01T00:00:00.000Z' };
    await chrome.storage.local.set({
      comicToken: 'test-token',
      comicTokenExpiresAt: Date.now() + 3600_000,
      comicAccountCache: {
        fetchedAt: Date.now(),
        account: {
          user: { email: 'reader@example.com', name: 'Reader' },
          freeQuotas: { comic_page: quota, pdf_page: quota },
        },
      },
    });
  }, signedIn);
}

/**
 * Send a message to the active tab from the extension service worker
 * @param {import('@playwright/test').Page} page
 * @param {object} message
 */
async function sendMessageToActiveTab(page, message) {
  const worker = await getServiceWorker(page.context());
  await worker.evaluate(async (msg) => {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tabs[0]?.id) {
      chrome.tabs.sendMessage(tabs[0].id, msg);
    }
  }, message);
}

module.exports = {
  E2E_BASE_SETTINGS,
  getServiceWorker,
  getSyncSettings,
  getSyncSetting,
  applyBaseSettings,
  waitForFloatBall,
  openFloatBallMenu,
  triggerPageTranslation,
  waitForTranslationComplete,
  getElementPosition,
  verifyAlignment,
  countElements,
  floatBallExists,
  triggerSelectionHotkey,
  getCurrentTheme,
  setExtensionSettings,
  setExtensionAccount,
  sendMessageToActiveTab,
};
