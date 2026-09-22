// The popup footer, and the one rule underneath it: the built-in engine is
// free and key-free, so a missing API key is not an error — it is only an
// error for the engine that needs a key.
//
// The old code read `!settings.apiKey` and told every default user "API Not
// Configured", pointing at a setting the default engine never touches. These
// specs pin the contrast, the round-trip that replaced it, and the promise
// that `local-only` costs nothing.
const { test, expect } = require('./fixtures');
const { getMessage } = require('../../i18n/messages');
const {
  setExtensionSettings,
  triggerPageTranslation,
  sendMessageToActiveTab,
} = require('./helpers');
const { startMockOpenAIServer } = require('./mock-openai-server');

const en = (key) => getMessage(key, 'en');
const popupUrl = (extensionId) => `chrome-extension://${extensionId}/popup/popup.html`;

// Every sentence the built-in engine can put in the footer. Which one a given
// machine gets depends on its Chrome build and which language packs it has
// downloaded, and this suite deliberately does not pin that — what it pins is
// that the footer speaks about the engine rather than about an API key.
const BUILTIN_SENTENCES = [
  'statusBuiltinReady', 'statusBuiltinPreparing', 'statusBuiltinUnavailable',
  'statusEngineFellBack', 'ready',
].map(en);

test('the engine that needs a key is the only one judged by it', async ({ page, extensionId }) => {
  await setExtensionSettings(page, { translationEngine: 'ai', apiKey: '' });

  await page.goto(popupUrl(extensionId));
  await expect(page.locator('#statusText')).toHaveText(en('apiNotConfigured'));
  await expect(page.locator('body')).toHaveClass(/status-error/);
});

test('a configured key clears the footer', async ({ page, extensionId }) => {
  await setExtensionSettings(page, { translationEngine: 'ai', apiKey: 'sk-test' });

  await page.goto(popupUrl(extensionId));
  await expect(page.locator('#statusText')).toHaveText(en('ready'));
  // The error class used to be set and never removed, so one bad load left the
  // dot red for the rest of the popup's life.
  await expect(page.locator('body')).not.toHaveClass(/status-error/);
});

test('the default engine never asks for an API key', async ({ page, extensionId }) => {
  await setExtensionSettings(page, { translationEngine: 'builtin', apiKey: '' });

  await page.goto(popupUrl(extensionId));
  const status = page.locator('#statusText');
  await expect(status).not.toHaveText(en('apiNotConfigured'));

  // Opened as a tab, the popup's own tab is the active one, and there is no
  // content script on a chrome-extension:// page — so the honest answer here
  // is "not this page", which is a different sentence from "not configured".
  await expect(status).toHaveText(en('statusPageUnsupported'));
});

test('the footer reports the engine in the tab, not the popup', async ({ context, extensionId }) => {
  // The popup's own realm is always a secure context, so it cannot answer the
  // question it is asking — only the content script in the page can. This is
  // that round-trip, end to end.
  await setExtensionSettings(await context.newPage(), {
    translationEngine: 'builtin',
    apiKey: '',
    targetLang: 'zh-CN',
  });

  const content = await context.newPage();
  await content.goto('https://example.com');
  await content.waitForSelector('#ai-translator-float-ball');

  const popup = await context.newPage();
  await popup.goto(popupUrl(extensionId));
  // goto() activated the popup's tab; hand the window back to the page, then
  // let the popup ask again with a real tab in front of it.
  await content.bringToFront();
  await popup.reload();

  const text = await popup.locator('#statusText').textContent();
  expect(text).not.toBe(en('apiNotConfigured'));
  // It reached a content script, so it is no longer "not this page".
  expect(text).not.toBe(en('statusPageUnsupported'));
  expect(BUILTIN_SENTENCES.some(sentence => text.startsWith(sentence))).toBeTruthy();
});

test('the probe answers with what this page can actually do', async ({ page }) => {
  await setExtensionSettings(page, { translationEngine: 'builtin', targetLang: 'zh-CN' });
  await page.goto('https://example.com');
  await page.waitForSelector('#ai-translator-float-ball');

  const probe = await sendMessageToActiveTab(page, { type: 'PROBE_ENGINE' });
  expect(probe).toBeTruthy();
  expect(probe.engine).toBe('builtin');
  expect(['available', 'downloadable', 'downloading', 'unavailable', 'unknown'])
    .toContain(probe.availability);
  expect(probe.lastFallback).toBeNull();

  // https:// in a headless Chromium: the only reason the built-in engine can
  // be missing here is the browser version, and if it is missing the probe has
  // to say which of the three it is rather than shrug.
  const major = Number((await page.evaluate(() => navigator.userAgent).then(
    ua => /Chrom(?:e|ium)\/(\d+)/.exec(ua)?.[1])) || 0);
  expect(major).toBeGreaterThan(0);
  if (probe.supported) {
    expect(major).toBeGreaterThanOrEqual(138);
    expect(probe.reason).toBe('');
  } else {
    expect(['oldBrowser', 'insecureContext', 'noApi']).toContain(probe.reason);
  }
});

test('local-only spends nothing when the built-in engine cannot do the job', async ({ page }) => {
  const { close, endpoint, sentTexts } = await startMockOpenAIServer();

  try {
    await setExtensionSettings(page, {
      apiEndpoint: endpoint,
      apiKey: 'test-key',
      modelName: 'gpt-4.1-mini',
      translationEngine: 'builtin',
      // 自动那一边有自己的引擎设置，要一起说 —— 见 helpers.js 的 E2E_BASE_SETTINGS。
      autoTranslateEngine: 'builtin',
      engineFallback: 'local-only',
      // Afrikaans is not in the Translator API's language list, so the
      // built-in engine gives up on every block for a reason that does not
      // depend on which Chrome is running the suite.
      targetLang: 'af',
      skipTargetLanguageText: false,
    });

    await page.goto('https://example.com');
    await page.waitForSelector('#ai-translator-float-ball');
    await triggerPageTranslation(page);

    // The key is right there in storage and the endpoint is up. Not asking is
    // the whole feature: the user chose the free engine, and a page it cannot
    // handle must not quietly start billing them.
    await page.waitForTimeout(3000);
    expect(sentTexts).toEqual([]);
    await expect(page.locator('.ai-translator-translated')).toHaveCount(0);
  } finally {
    await close();
  }
});

test('allow-ai is the same page, with permission', async ({ page }) => {
  const { close, endpoint, sentTexts } = await startMockOpenAIServer();

  try {
    await setExtensionSettings(page, {
      apiEndpoint: endpoint,
      apiKey: 'test-key',
      modelName: 'gpt-4.1-mini',
      translationEngine: 'builtin',
      // 自动那一边有自己的引擎设置，要一起说 —— 见 helpers.js 的 E2E_BASE_SETTINGS。
      autoTranslateEngine: 'builtin',
      engineFallback: 'allow-ai',
      targetLang: 'af',
      skipTargetLanguageText: false,
    });

    await page.goto('https://example.com');
    await page.waitForSelector('#ai-translator-float-ball');
    await triggerPageTranslation(page);

    await expect.poll(() => sentTexts.length, {
      timeout: 15000,
      message: 'allow-ai never reached the API',
    }).toBeGreaterThan(0);
    await expect(page.locator('.ai-translator-translated').first()).toBeVisible();
  } finally {
    await close();
  }
});

test('a fallback that happened is on the footer, not just in the log', async ({ context, extensionId }) => {
  const { close, endpoint, sentTexts } = await startMockOpenAIServer();

  try {
    const content = await context.newPage();
    await setExtensionSettings(content, {
      apiEndpoint: endpoint,
      apiKey: 'test-key',
      modelName: 'gpt-4.1-mini',
      translationEngine: 'builtin',
      // 自动那一边有自己的引擎设置，要一起说 —— 见 helpers.js 的 E2E_BASE_SETTINGS。
      autoTranslateEngine: 'builtin',
      engineFallback: 'allow-ai',
      targetLang: 'af',
      skipTargetLanguageText: false,
    });

    await content.goto('https://example.com');
    await content.waitForSelector('#ai-translator-float-ball');
    await triggerPageTranslation(content);
    await expect.poll(() => sentTexts.length, { timeout: 15000 }).toBeGreaterThan(0);

    const popup = await context.newPage();
    await popup.goto(popupUrl(extensionId));
    await content.bringToFront();
    await popup.reload();

    // Spending the user's money is the one outcome that must never pass in
    // silence, so it outranks whatever the engine's state is now.
    await expect(popup.locator('#statusText'))
      .toHaveText(new RegExp(`^${en('statusEngineFellBack')}`));
  } finally {
    await close();
  }
});

test('页面在他看着按钮的时候出错了：那一下不该把 ERROR 抹成 PAUSED', async ({ page, extensionId }) => {
  // popup 上那三行是打开那一刻画的，之后它就不再听了（refreshPageRows 是一问一
  // 答，没有任何东西会把新状态推过来）。他盯着「暂停」这颗按钮的这几秒里，那一
  // 轮可能已经失败了。
  //
  // 拿快照去写的样子：送出去的是 paused:true，而这一页此刻停在 ERROR —— 从
  // popup 来的这一下不带 cause:'hidden'，pauseCurrentPage 里那道 ERROR 守卫拦不
  // 住它（content-auto-translate.js:568）。「出错」被改写成「已暂停」，那句「为
  // 什么停了」就此没人说得出，而那一行本来正是他重试的入口。
  //
  // 这里把页面那一端换成一个听我们摆布的假页面：popup 作为标签页打开时，
  // chrome.tabs.query 问到的活动标签页就是 popup 自己，真页面接不上。换掉的只
  // 是出口，按钮、渲染和点击处理都是真的。
  await page.goto(popupUrl(extensionId));
  await page.waitForFunction(() => typeof refreshPageRows === 'function');

  await page.evaluate(() => {
    window.__sent = [];
    window.__status = 'running';
    chrome.tabs.query = async () => [{ id: 1 }];
    chrome.tabs.sendMessage = async (tabId, message) => {
      window.__sent.push(message);
      if (message.type === 'AUTO_PAGE_STATE') {
        return { host: 'example.com', blocked: false, ruleWritable: true, auto: { status: window.__status, siteAuto: true } };
      }
      if (message.type === 'SET_AUTO_PAUSED') {
        window.__status = message.paused ? 'paused' : 'running';
        return { status: window.__status, siteAuto: true };
      }
      return null;
    };
  });

  await page.evaluate(() => refreshPageRows());
  const label = page.locator('#pagePauseLabel');
  await expect(page.locator('#togglePagePause')).toBeVisible();
  await expect(label).toHaveText(en('popupPausePage'));

  // 这一轮失败了。popup 什么都不知道，按钮还印着「暂停」。
  await page.evaluate(() => { window.__status = 'error'; });
  await page.evaluate(() => { window.__sent.length = 0; });
  await page.locator('#togglePagePause').click();

  // 这一下瞄的是另一颗按钮。重新问一次页面就够了，不替他按。
  await expect(label).toHaveText(en('popupResumePage'));
  expect(await page.evaluate(() => window.__sent.map((m) => m.type)))
    .toEqual(['AUTO_PAGE_STATE']);
  expect(await page.evaluate(() => window.__status)).toBe('error');

  // 他看着「继续」再点一次 —— 这一下才是重试，而失败的原因一直留到这一刻。
  await page.locator('#togglePagePause').click();
  expect(await page.evaluate(() => window.__sent.filter((m) => m.type === 'SET_AUTO_PAUSED')))
    .toEqual([{ type: 'SET_AUTO_PAUSED', paused: false }]);
});
