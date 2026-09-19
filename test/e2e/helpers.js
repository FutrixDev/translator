/**
 * Test helper functions for Blab Translation E2E tests
 */
const path = require('path');
const { expect } = require('@playwright/test');

const REPO_ROOT = path.join(__dirname, '..', '..');

/**
 * The source files a DOM-harness spec injects to get a working
 * `window.AI_TRANSLATOR_CONTENT` — no extension, no network, no display.
 *
 * Four specs each kept their own copy of this list. They are not a preference:
 * content-bootstrap.js reaches for `DefaultSettings` and `getUILanguage` as it
 * runs, so a module missing from the list is a TypeError inside an injected
 * script, which Playwright reports as `ctx.settings` being undefined three
 * calls later. Adding shared/default-settings.js broke all four at once, in
 * exactly that unreadable shape, which is why the list lives here now.
 *
 * Pass the modules the spec is actually about; they load after the prelude, in
 * the order given.
 *
 * @param {...string} modules repo-relative paths, e.g. ...PAGE_TRANSLATION_MODULES
 * @returns {string[]} absolute paths, ready for page.addScriptTag({ path })
 */
const CONTENT_HARNESS_PRELUDE = Object.freeze([
  'i18n/messages.js',
  'shared/default-settings.js',
  'content/content-bootstrap.js',
]);

// 整页翻译不是一个文件了：collect/batch/insert/visibility 加门面，少一个就是
// 某个 ctx.x 不存在，报出来的还是三步之后的 TypeError。要整页翻译就要这一串。
// progress.js 不在里面：进度条是页面级 UI，DOM 夹具里没有它要挂的地方，门面在
// 调用前就会因为拿不到 showPageTranslationProgress 报错——所以它也在。
const PAGE_TRANSLATION_MODULES = Object.freeze([
  // shared/ 的模块也在这串里：collect.js / insert.js 通过 `globalThis.BlockIdentity`
  // 拿内容身份，manifest 里它排在两者之前。夹具漏掉它的症状和上面那段说的一样难
  // 读——`Cannot read properties of undefined (reading 'lookup')`，堆栈指着 collect.js
  // 而不是这份清单。block-identity.test.mjs 里有一条守卫：这串模块里出现的每个
  // `globalThis.X`，都必须由前面某个文件提供。
  'shared/block-identity.js',
  'content/page/batch.js',
  'content/page/collect.js',
  'content/page/insert.js',
  'content/page/visibility.js',
  'content/page/progress.js',
  'content/content-page-translation.js',
]);

function contentHarnessScripts(...modules) {
  return [...CONTENT_HARNESS_PRELUDE, ...modules].map(rel => path.join(REPO_ROOT, rel));
}

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
 * `translationEngine` is the whole list, and it is not a preference — it is how
 * the suite picks the backend it is testing. The extension ships with Chrome's
 * on-device Translator selected (`translationEngine: 'builtin'`, see
 * background/background.js), and the headless Chrome this suite drives answers
 * `availability('en'→'zh')` as 'downloadable' in about a millisecond and then
 * never settles `create()`: it wants a language pack that never arrives.
 *
 * That used to hang the page outright, which is what made the failure so hard
 * to read — a spec that stood up mock-openai-server.js saw zero requests and
 * timed out saying nothing about the engine. The stall watchdog in
 * content/content-translation-engine.js (8d182bb) fixed the hang: the built-in
 * engine now gives up after ~30s and falls back to the AI path. But falling
 * back is not the same as being pointed at the right backend to begin with —
 * every such spec would pay 30s and depend on a timeout firing to pass.
 *
 * So the harness pins the AI backend — the one the mock servers speak — for
 * every context, rather than asking each spec to remember. A spec that means to
 * exercise the built-in engine passes `translationEngine` explicitly to
 * setExtensionSettings and wins over this.
 *
 * `uiLanguage` is here for the same reason. Left unset it means "follow the
 * browser", so every label a spec reads — the OCR popup's "Source · English",
 * the caption menu's rows, every error string — would be drawn in whatever
 * language the machine running the suite happens to have Chrome in. Pinning
 * English makes those assertions mean something; a spec asserting another
 * language passes `uiLanguage` and wins over this.
 */
const E2E_BASE_SETTINGS = Object.freeze({
  translationEngine: 'ai',
  uiLanguage: 'en',
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
  return worker.evaluate(async (msg) => {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tabs[0]?.id) return undefined;
    // The reply, for the messages that have one (PROBE_ENGINE). A tab with no
    // listener rejects, and that is an answer too — `undefined` rather than a
    // rejection the caller did not ask for, since most callers here only
    // trigger something and never look.
    return chrome.tabs.sendMessage(tabs[0].id, msg).catch(() => undefined);
  }, message);
}

/**
 * The caption menu is a popover: it sits just above the icon, right-aligned
 * with it, at its own content height, inside the anchor it is placed in. Both
 * caption specs assert it — docked in the player, and floating over a bare
 * <video> — so the four checks live here rather than twice.
 * @param {import('@playwright/test').Page} page
 * @param {string} anchorSelector the element the menu is positioned within
 */
async function expectCaptionMenuAnchoredAboveButton(page, anchorSelector) {
  const boxes = await page.evaluate((sel) => {
    const box = (el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, height: r.height };
    };
    const menu = document.getElementById('ai-translator-caption-menu');
    const button = document.getElementById('ai-translator-caption-btn');
    const anchor = document.querySelector(sel);
    if (!menu || !button || !anchor) return null;
    return { menu: box(menu), button: box(button), anchor: box(anchor) };
  }, anchorSelector);

  expect(boxes, `menu, button and ${anchorSelector} must all be on the page`).not.toBeNull();
  // Above the button, not overlapping it.
  expect(boxes.menu.bottom).toBeLessThanOrEqual(boxes.button.top);
  // Right-aligned with the button.
  expect(Math.abs(boxes.menu.right - boxes.button.right)).toBeLessThanOrEqual(8);
  // Its own height — not stretched between two opposite pinned edges.
  expect(boxes.menu.height).toBeLessThan(320);
  // And inside the player / floating box it is anchored to.
  expect(boxes.menu.left).toBeGreaterThanOrEqual(boxes.anchor.left);
  return boxes;
}

module.exports = {
  E2E_BASE_SETTINGS,
  REPO_ROOT,
  CONTENT_HARNESS_PRELUDE,
  contentHarnessScripts,
  PAGE_TRANSLATION_MODULES,
  expectCaptionMenuAnchoredAboveButton,
  getServiceWorker,
  writeSyncSettings,
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
