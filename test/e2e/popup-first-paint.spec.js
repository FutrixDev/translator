// R33 A1：点开图标以后，「翻译此页」要当场能按。
//
// popup 打开时会问页面要一份状态（AUTO_PAGE_STATE）。内容脚本正忙时这一问能晚
// 回好几秒，而从前按钮的监听器排在它的 await 后面 —— 那几秒里按钮画在那儿，点
// 下去什么都不发生。这里把那一问在 popup 这一端拖 5 秒（别的消息原样放行），
// 打开后 500 ms 内点「翻译此页」，看页面真的开译：请求到了 mock。
const { test, expect } = require('./fixtures');
const { startMockOpenAIServer } = require('./mock-openai-server');
const { serve, BODY } = require('./auto-touchpoint-fixtures');

const popupUrl = (extensionId) => `chrome-extension://${extensionId}/popup/popup.html`;
const SLOW_STATE_MS = 5000;

test('Translate this page answers within 500 ms while the tab is slow to report its state', async ({ page, context, extensionId }) => {
  const { close, endpoint, sentTexts } = await startMockOpenAIServer();
  try {
    await serve(page, context, endpoint);
    // 这一页不自动翻：请求只能来自 popup 那一下。
    expect(sentTexts).toEqual([]);

    const popup = await context.newPage();
    await popup.addInitScript((delay) => {
      const original = chrome.tabs.sendMessage.bind(chrome.tabs);
      chrome.tabs.sendMessage = (...args) => {
        const message = args[1];
        if (message && message.type === 'AUTO_PAGE_STATE') {
          return new Promise((resolve) => setTimeout(resolve, delay)).then(() => original(...args));
        }
        return original(...args);
      };
    }, SLOW_STATE_MS);
    await popup.goto(popupUrl(extensionId));
    // goto() 把 popup 的标签页推到了前面；把窗口还给页面，再让 popup 重新问一遍。
    await page.bringToFront();
    await popup.reload();

    const opened = Date.now();
    await popup.locator('#translatePage').click({ timeout: 500 });
    expect(Date.now() - opened).toBeLessThan(500);

    // 页面那边真的开译了：原文到了 mock，译文写回了页面。都在那 5 秒之内。
    await expect.poll(() => sentTexts.some((text) => text.includes(BODY)), { timeout: SLOW_STATE_MS - 1000 })
      .toBe(true);
    await expect(page.locator('#box .ai-translator-inline-block'))
      .toContainText('[T]', { timeout: SLOW_STATE_MS });
  } finally {
    await close();
  }
});
