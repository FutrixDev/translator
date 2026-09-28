/**
 * Test helper functions for Blab Translation E2E tests
 */
const fs = require('fs');
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
// 界面文案是十一个文件了：一门语言一个表，加上取文案的那几个函数。语言清单不在
// 这里重抄一遍——UI_LANGUAGES 就在 messages.js 里，将来加一门语言这份夹具自己跟上。
const I18N_LANG_SCRIPTS = require(path.join(REPO_ROOT, 'i18n/messages.js'))
  .UI_LANGUAGES.map(lang => `i18n/lang/${lang}.js`);

const CONTENT_HARNESS_PRELUDE = Object.freeze([
  ...I18N_LANG_SCRIPTS,
  'i18n/messages.js',
  // default-settings.js 在加载时读 AccountGate.FEATURE_DEFAULTS；manifest 里它
  // 排在前面。
  'shared/account-gate.js',
  'shared/default-settings.js',
  // manifest 里它紧挨在 content-bootstrap.js 之前：bootstrap 建 ctx 之前先问它
  // 「这个 frame 进不进」。夹具页是顶层，答案恒为进；带上它是为了夹具与 manifest
  // 走同一条路，而不是靠 bootstrap 对它的软读退路。
  'shared/frame-eligibility.js',
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
  // 站点适配（content/page/site-adapter.js）读内置规则表，表在 shared/ 的这两个
  // 文件里；manifest 里它们排在整页翻译的所有模块之前。夹具漏掉它们不会红在这
  // 里——site-adapter 对 `globalThis.SiteRules` 是运行时软读，拿不到就安静地退回
  // 通用启发式，于是站点规则的 spec 全都「翻是翻了，只是没按规则翻」。
  'shared/site-rules-builtin.js',
  // site-rules.js 在加载时就取走 LangTags，缺了它整个文件抛错——而一个抛了错
  // 的 <script> 照样触发 load，addScriptTag 照样 resolve，于是 `globalThis.
  // SiteRules` 悄悄成了 undefined，正好落进上面那段说的软读退路里：spec 全绿，
  // 站点规则全没生效。
  'shared/lang-tags.js',
  // insert.js 按译文的语言写 dir 和对齐（TargetLang.direction），打标、缩进和行内
  // 间隙经 ctx.markLanguage / applyTextInset / startSide，后三者在
  // content-language.js。manifest 里两者都排在整页翻译的模块之前。
  'shared/target-lang.js',
  // site-rules.js 在加载时同样取走 StorageWriter（同步存储的单写者队列），缺了它
  // 就是上面那段说的同一种静默：抛错、SiteRules 成了 undefined、spec 照绿。
  'shared/storage-writer.js',
  'shared/site-rules.js',
  // 附加说明（R33 A4）：content-translation-cache.js 建键时取 PromptAddenda.stamp。
  // 这串模块里今天没有谁读它，照 manifest 的次序带上，免得哪天夹具加了缓存层、
  // 红在三步之后。
  'shared/prompt-addenda.js',
  // 用户站点规则（P1-B）：custom-rules.js 加载时取走 SiteRules / StorageWriter /
  // SyncCollection，manifest 里它们紧跟在 auto-stats 之后。夹具不调
  // ctx.customRules.init()（没有扩展运行时），所以本页恒为「没有规则」。
  // custom-rule.js 在 init() 里订阅 SpaNavigation 的路由信号；不调 init() 它
  // 就不接线，加载本身没有副作用。
  'shared/spa-navigation.js',
  'shared/sync-collection.js',
  // custom-rules.js 加载时取走 PromptAddenda（规则 v2 的 domain 按 DOMAINS 校验，
  // P1-C C3），缺了它整个文件抛错；manifest 里它排在 custom-rules.js 之前。
  // 上面 block-identity 的守卫只扫 `globalThis.X`，custom-rules.js 写的是
  // `root.PromptAddenda`，漏掉它不会红在那里。夹具也不调 ctx.customRules.init()，
  // 用不到 CustomRules，所以漏掉它时现有 DOM 夹具 spec 照样全绿（实测过）——
  // 这一行是为了和 manifest 顺序一致，不是哪条 spec 离了它就红。
  'shared/prompt-addenda.js',
  'shared/custom-rules.js',
  // display.js 在加载时取走 TranslationDisplay（样式集合）；manifest 里它排在
  // shared/default-settings.js 之后、整页翻译的所有模块之前。
  'shared/translation-display.js',
  // 占位符与标记的语法（shared/text-markers.js）：收集、落笔、语言检测在调用时
  // 读 globalThis.TextMarkers；manifest 里它排在 content-language.js 之前。
  'shared/text-markers.js',
  'content/content-language.js',
  'content/page/batch.js',
  // ctx.customRules：门面每轮先等它，site-adapter / scope / collect 读它。
  'content/page/custom-rule.js',
  'content/page/site-adapter.js',
  // 组合树（shadow.js）、notranslate、正文范围（scope.js）：收集器和门面在调用时
  // 读它们挂的 ctx.x，门面收块走的就是 scope.js 的 ctx.collectPageBlocks。
  'content/page/shadow.js',
  'content/page/notranslate.js',
  'content/page/scope.js',
  'content/page/collect.js',
  'content/page/insert.js',
  'content/page/visibility.js',
  'content/page/display.js',
  'content/page/progress.js',
  'content/content-page-translation.js',
  // 门面和显隐调 ctx.frames 的钩子（手动一轮开始 / 结束、显隐变了）。shelf 给的默认
  // 全是空操作，夹具里没有子 frame，照常可调、什么也不做——不手写 ctx.frames 替身。
  'content/frames/shelf.js',
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
 * Open the float ball's menu.
 *
 * 单击球本身现在是翻译 / 还原（PR-7：最常做的那件事该是最省事的那一下），菜单
 * 挪到了球上那颗 `···`。它平时 opacity:0 且 pointer-events:none，只在球 :hover
 * 时才在，所以这里必须先 hover 再点 —— Playwright 的 click 会自己先移过去，但
 * 那是在拿到元素框之后，而 pointer-events:none 的元素它根本不会当成可点。
 *
 * @param {import('@playwright/test').Page} page
 */
async function openFloatBallMenu(page) {
  await page.hover('#ai-translator-float-ball');
  await page.click('#ai-translator-float-ball .ai-translator-ball-more');
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
 * content/engine/watchdog.js (8d182bb) fixed the hang: the built-in
 * engine now gives up after ~30s and falls back to the AI path. But falling
 * back is not the same as being pointed at the right backend to begin with —
 * every such spec would pay 30s and depend on a timeout firing to pass.
 *
 * So the harness pins the AI backend — the one the mock servers speak — for
 * every context, rather than asking each spec to remember. A spec that means to
 * exercise the built-in engine passes `translationEngine` explicitly to
 * setExtensionSettings and wins over this.
 *
 * `autoTranslateEngine` is the same fact stated for the other half of the
 * extension. Automatic translation has an engine switch of its own (PRD FR-9),
 * defaulting to the free built-in one, and FR-9.1 says a page with no built-in
 * engine and no fallback is simply not translated automatically — quietly, by
 * design. That rule is right and it is exactly what this headless Chrome
 * triggers: pinning only `translationEngine` leaves every auto-translate spec
 * waiting on a page that has correctly decided to do nothing.
 *
 * Which makes the override rule above a rule about **both** keys, not one: a
 * spec that means to exercise the built-in engine has to say so twice. Clicking
 * 「翻译整页」 calls markPageExplicit(), so an automatic round runs on that same
 * page moments later — and it is judged by `autoTranslateEngine`. Override only
 * the manual half and the spec is really asking "what does the harness think
 * automatic translation may spend?", which is not a question any spec means to
 * ask. popup-status.spec.js's three built-in-engine specs pin both.
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
  autoTranslateEngine: 'ai',
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
    // 菜单挂在展开按钮上（R33 A3：图标本身是开关，菜单从它旁边那个小按钮出来）。
    const button = document.getElementById('ai-translator-caption-more');
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

/**
 * 扩展真正注入的那一整张内容脚本样式表。
 *
 * 样式表是 content/css/ 下的十二份文件了，**按 manifest 的 css 数组顺序**接起来
 * 才是浏览器里的那张表：顺序就是层叠顺序，light-theme.css 整份都靠排在被它覆盖
 * 的那些后面工作。往裸页面里塞样式的 spec 用这个，别自己拼文件名。
 */
function contentStylesheet() {
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'manifest.json'), 'utf8'));
  return manifest.content_scripts
    .flatMap((cs) => cs.css || [])
    .map((rel) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'))
    .join('\n');
}

/**
 * Evaluate an expression in a frame's content-script isolated world. The tests
 * have no scripting permission and Playwright's evaluate only reaches the page's
 * main world, so this goes through CDP: find the isolated context in that frame
 * whose origin is the extension.
 */
async function evaluateInContentScript(context, pageOrFrame, expression) {
  const session = await context.newCDPSession(pageOrFrame);
  const contexts = [];
  session.on('Runtime.executionContextCreated', (event) => contexts.push(event.context));
  await session.send('Runtime.enable');
  const isIsolated = (c) => c.auxData && c.auxData.type === 'isolated'
    && String(c.origin).startsWith('chrome-extension://');
  await expect.poll(() => contexts.some(isIsolated)).toBe(true);
  const isolated = contexts.find(isIsolated);
  const { result, exceptionDetails } = await session.send('Runtime.evaluate', {
    expression, contextId: isolated.id, awaitPromise: true, returnByValue: true,
  });
  await session.detach();
  if (exceptionDetails) throw new Error(`content-script evaluate failed: ${exceptionDetails.text}`);
  return result.value;
}

/**
 * STUB, not the real engine: replaces `self.Translator` in the content-script
 * world of a page, or of one of its frames, with one that answers
 * `'[B] ' + text`. Chromium in the e2e run has no on-device model, so the
 * built-in path can only be proven against a stand-in. Every call is counted
 * on `self.__builtinCalls` in that world, and the text each call received is
 * kept on `self.__builtinTexts` (P1-C: a glossary term reaches the built-in
 * engine as a `{{n}}` placeholder).
 *
 * `options.dropPlaceholders`: answer with every `{{n}}` removed, the way an
 * on-device model sometimes eats them. Leaving it out keeps the answer exactly
 * as before.
 *
 * @param {import('@playwright/test').Page|import('@playwright/test').Frame} pageOrFrame
 * @param {{dropPlaceholders?: boolean}} [options]
 */
async function stubBuiltinTranslator(pageOrFrame, options = {}) {
  const page = typeof pageOrFrame.page === 'function' ? pageOrFrame.page() : pageOrFrame;
  const dropPlaceholders = options.dropPlaceholders === true;
  return evaluateInContentScript(page.context(), pageOrFrame, `(() => {
    const dropPlaceholders = ${JSON.stringify(dropPlaceholders)};
    self.__builtinCalls = 0;
    self.__builtinTexts = [];
    self.Translator = {
      availability: async () => 'available',
      create: async () => ({
        translate: async (text) => {
          self.__builtinCalls += 1;
          self.__builtinTexts.push(text);
          return '[B] ' + (dropPlaceholders ? text.replace(/\\{\\{\\d+\\}\\}/g, '') : text);
        },
        destroy() {},
      }),
    };
    return true;
  })()`);
}

/**
 * How many of our nodes (any class that starts with `ai-translator-`) sit in the box with this
 * id, the box itself included, in a page or a frame.
 *
 * "This region was not translated" has two halves (RJ-3): this is 0 for the region's own box,
 * and the source text is not in the mock's sentTexts. A descendant lookup inside a block misses
 * the block's translation, which is inserted as its next sibling; one class name over the whole
 * page misses the other kinds of node; every node on the page also counts the float ball. So
 * wrap the region in a box of its own and count inside that.
 */
function oursIn(target, containerId) {
  return target.evaluate(([id, any]) => {
    const box = document.getElementById(id);
    return box.matches(any) ? 1 + box.querySelectorAll(any).length : box.querySelectorAll(any).length;
  }, [containerId, '[class*="ai-translator-"]']);
}

/**
 * oursIn for an element that cannot get a box of its own without changing what is collected: an
 * inline element among blocks, or a slotted element whose slot name has to stay on it. Counts
 * our nodes on and inside the element, plus its next element sibling when that sibling is a
 * translation node (a block translation lands there, insert.js `element.after`). The sibling test
 * is the translation class only: a translated neighbour carries `ai-translator-translated` and is
 * not this element's translation.
 */
function ourNodesAt(target, elementId) {
  return target.evaluate(([id, any, translation]) => {
    const el = document.getElementById(id);
    const inside = (el.matches(any) ? 1 : 0) + el.querySelectorAll(any).length;
    const next = el.nextElementSibling;
    return inside + (next && next.matches(translation) ? 1 : 0);
  }, [elementId, '[class*="ai-translator-"]', '.ai-translator-inline-block']);
}

/**
 * mock-openai-server 收到的原文按段拆开：每次请求按快速批的分隔符拆；不走快速
 * 批的请求整条就是一段。
 * @param {string[]} sentTexts
 * @param {{delimiter: string}[]} fastBatchRequests
 */
function sentSegments(sentTexts, fastBatchRequests) {
  const delimiters = [...new Set(fastBatchRequests.map((request) => request.delimiter))];
  return sentTexts.flatMap((text) => delimiters.reduce(
    (pieces, delimiter) => pieces.flatMap((piece) => piece.split(delimiter)),
    [text],
  ));
}

/** Everything in sync storage, and how many bytes it takes. */
async function syncSnapshot(context) {
  const worker = await getServiceWorker(context);
  return worker.evaluate(async () => ({
    items: await chrome.storage.sync.get(null),
    bytes: await chrome.storage.sync.getBytesInUse(null),
  }));
}

/**
 * 等内容脚本读完设置（P1-C 设计 §6 的就绪办法）：设置里先放
 * translationStyle: 'underline'，content-bootstrap.js 的 ctx.init 读完设置就经
 * applyTranslationDisplay 把它写到 <html data-ai-translator-style>。看到了，说明
 * 这一页的内容脚本已经起来、设置已经读进来。
 * @param {import('@playwright/test').Page} page
 */
async function waitForContentReady(page, style = 'underline') {
  await expect.poll(() => page.evaluate(
    () => document.documentElement.getAttribute('data-ai-translator-style'),
  )).toBe(style);
}

/** 持久译文缓存落了几条：chrome.storage.local 里 tc: 开头的键。 */
async function countPersistentCacheKeys(context) {
  const worker = await getServiceWorker(context);
  return worker.evaluate(async () => Object.keys(await chrome.storage.local.get(null))
    .filter((key) => key.startsWith('tc:')).length);
}

/**
 * 加一条术语表词条：从设置页发 GLOSSARY_WRITE（生产写入路径，经服务工作者的
 * 单写者队列落到 storage.sync），核对回话和存下的那一整条，再在设置页里按设计
 * 的算法量一次用量（Glossary.usage(Glossary.collect(整个 sync))）。
 *
 * 只用来铺设前置数据：C-J3、C-J8 把加词条标成 [fixture]（设计 §6.1 夹具隔离子
 * 步骤），走这条消息路径；C-J1 / C-J2 / C-J5 的加词条已改走设置页卡片
 * （addGlossaryEntryInCard）。
 * @returns {Promise<{id: string, usage: {count: number, bytes: number, max: number}, stored: object}>}
 */
async function addGlossaryEntry(context, extensionId, entry) {
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options/options.html`);
  const reply = await options.evaluate(
    (e) => chrome.runtime.sendMessage({ type: 'GLOSSARY_WRITE', kind: 'put', entry: e }),
    entry,
  );
  const usage = await options.evaluate(async () => ({
    ...Glossary.usage(Glossary.collect(await chrome.storage.sync.get(null))),
    max: Glossary.LIMITS.maxItems,
  }));
  await options.close();
  expect(reply.value).toEqual({ id: expect.any(String), replaced: false });
  const key = `glossary:${reply.value.id}`;
  const stored = (await getSyncSettings(context, [key]))[key];
  // 存下的是整条：没给范围就是所有语言（l: '*'），写入时戳上 u。
  expect(stored).toEqual({ l: '*', ...entry, u: expect.any(Number) });
  return { id: reply.value.id, usage, stored };
}

/** sync 里全部术语表词条，按键：{ 'glossary:<id>': 存下的那一条 }。 */
async function storedGlossary(context) {
  const { items } = await syncSnapshot(context);
  return Object.fromEntries(Object.entries(items).filter(([key]) => key.startsWith('glossary:')));
}

/**
 * 打开设置页，等术语表卡片第一次读回存储（用量那一行有了字）。
 * @returns {Promise<import('@playwright/test').Page>}
 */
async function openGlossaryCard(page, extensionId) {
  await page.goto(`chrome-extension://${extensionId}/options/options.html`);
  await expect(page.locator('#glossaryUsage')).not.toHaveText('');
  return page;
}

/**
 * 在设置页的术语表卡片上加一条：点「添加词条」，逐项填表（原文、译文、区分
 * 大小写、站点、目标语言），点「保存」，等表单收起、存储里多出恰好一条新键。
 * 这是 C-J1 / C-J2 / C-J5 加词条的真实入口；只有铺设用的 addGlossaryEntry 走消息。
 * @param {import('@playwright/test').Page} options 已由 openGlossaryCard 打开的设置页
 * @param {{s: string, t?: string, c?: number, h?: string, l?: string}} entry
 * @returns {Promise<{id: string, stored: object}>}
 */
async function addGlossaryEntryInCard(options, context, entry) {
  const before = await storedGlossary(context);
  await options.click('#glossaryAdd');
  const editor = options.locator('.glossary-editor');
  await editor.locator('#glossary-source').fill(entry.s);
  await editor.locator('#glossary-target').fill(entry.t || '');
  // 原文含大写字母时表单会自动勾上「区分大小写」：按词条显式设一次。
  await editor.locator('#glossary-case').setChecked(Boolean(entry.c));
  await editor.locator('#glossary-site').fill(entry.h || '');
  await editor.locator('#glossary-lang').selectOption(entry.l || '*');
  await editor.locator('.glossary-save').click();
  await expect(editor).toHaveCount(0);
  let added = [];
  await expect.poll(async () => {
    added = Object.entries(await storedGlossary(context)).filter(([key]) => !(key in before));
    return added.length;
  }).toBe(1);
  const [key, stored] = added[0];
  return { id: key.slice('glossary:'.length), stored };
}

module.exports = {
  oursIn,
  ourNodesAt,
  sentSegments,
  syncSnapshot,
  waitForContentReady,
  countPersistentCacheKeys,
  addGlossaryEntry,
  storedGlossary,
  openGlossaryCard,
  addGlossaryEntryInCard,
  evaluateInContentScript,
  stubBuiltinTranslator,
  E2E_BASE_SETTINGS,
  REPO_ROOT,
  CONTENT_HARNESS_PRELUDE,
  contentHarnessScripts,
  contentStylesheet,
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
