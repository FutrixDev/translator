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
 * Set extension settings via chrome.storage
 * @param {import('@playwright/test').Page} page
 * @param {object} settings
 */
async function setExtensionSettings(page, settings) {
  const context = page.context();
  let worker = context.serviceWorkers()[0];
  if (!worker) {
    worker = await context.waitForEvent('serviceworker');
  }
  await worker.evaluate((newSettings) => {
    return new Promise((resolve) => {
      chrome.storage.sync.set(newSettings, resolve);
    });
  }, settings);
}

/**
 * Send a message to the active tab from the extension service worker
 * @param {import('@playwright/test').Page} page
 * @param {object} message
 */
async function sendMessageToActiveTab(page, message) {
  const context = page.context();
  let worker = context.serviceWorkers()[0];
  if (!worker) {
    worker = await context.waitForEvent('serviceworker');
  }
  await worker.evaluate(async (msg) => {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tabs[0]?.id) {
      chrome.tabs.sendMessage(tabs[0].id, msg);
    }
  }, message);
}

module.exports = {
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
  sendMessageToActiveTab,
};
