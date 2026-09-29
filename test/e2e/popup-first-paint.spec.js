// R33 A1：点开图标以后，「翻译此页」要当场能按。
//
// popup 打开时会问页面要一份状态（AUTO_PAGE_STATE）。内容脚本正忙时这一问能晚
// 回好几秒，而从前按钮的监听器排在它的 await 后面 —— 那几秒里按钮画在那儿，点
// 下去什么都不发生。这里把那一问在 popup 这一端拖 5 秒（别的消息原样放行），
// 打开后 500 ms 内点「翻译此页」，看页面真的开译：请求到了 mock。
const { test, expect } = require('./fixtures');
const { startMockOpenAIServer } = require('./mock-openai-server');
const { serve, BODY } = require('./auto-touchpoint-fixtures');
const { writeSyncSettings } = require('./helpers');

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

// R33 N1：总开关那一行只从存储画。存储晚答时它灰着、不说开也不说关；能按的第一帧
// 说的就是存储里的值。这里把 popup 的 storage.sync.get 拖 1.5 秒，存储里是关着的，
// 用 MutationObserver 从 DOMContentLoaded 起记下按钮的每一个样子。
const SLOW_STORAGE_MS = 1500;

test('the auto-translate master switch never shows a guessed state while storage is slow', async ({ context, extensionId }) => {
  await writeSyncSettings(context, { autoTranslate: false });
  const popup = await context.newPage();
  await popup.addInitScript((delay) => {
    const get = chrome.storage.sync.get.bind(chrome.storage.sync);
    chrome.storage.sync.get = (...args) => new Promise((resolve) => setTimeout(resolve, delay)).then(() => get(...args));
    window.__masterFrames = [];
    document.addEventListener('DOMContentLoaded', () => {
      const button = document.getElementById('toggleGlobalAuto');
      const status = document.getElementById('globalAutoStatus');
      const snap = () => window.__masterFrames.push({
        disabled: button.disabled,
        pressed: button.getAttribute('aria-pressed'),
        status: status.textContent,
        // 开关自带轨道：空着也画得出一条空轨道，所以问的是它画没画（D-360 F9）。
        drawn: status.getClientRects().length > 0,
      });
      snap();
      new MutationObserver(snap).observe(button, { attributes: true, attributeFilter: ['disabled', 'aria-pressed'] });
    });
  }, SLOW_STORAGE_MS);
  await popup.goto(popupUrl(extensionId));

  const master = popup.locator('#toggleGlobalAuto');
  await expect(master).toBeDisabled();
  expect(await master.getAttribute('aria-pressed')).toBeNull();
  await expect(popup.locator('#globalAutoStatus')).toBeHidden();

  await expect(master).toBeEnabled({ timeout: SLOW_STORAGE_MS + 5000 });
  await expect(master).toHaveAttribute('aria-pressed', 'false');
  await expect(popup.locator('#globalAutoStatus')).toHaveText('Off');
  await expect(popup.locator('#globalAutoStatus')).toBeVisible();

  const frames = await popup.evaluate(() => window.__masterFrames);
  expect(frames[0]).toEqual({ disabled: true, pressed: null, status: '', drawn: false });
  expect(frames.filter((frame) => frame.pressed === 'true')).toEqual([]);
  expect(frames.filter((frame) => !frame.disabled).map((frame) => frame.pressed)).not.toContain(null);
});
