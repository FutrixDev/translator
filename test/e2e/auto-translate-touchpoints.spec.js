// 自动翻译的第三条旅程：**用户怎么开、怎么关**。
//
// 前两条旅程（判定、滚动续译）证的都是「该翻的翻了」。这一条证的是那之前和之后
// 的两下：一个我们拿不准的站点上，问得有多轻；以及用户说「不用」之后，这件事停
// 得有多干净。
//
// 三条硬指标，来自实现文档 PR-7 那一行：
//   · 启用 ≤3 次点击 —— 条子上勾一下、点一下「翻译」，这一页翻了，这个站点以后
//     也都翻。两下。
//   · 关闭不离开页面 —— 「不用」就地把条子收走，不跳设置页、不刷新。
//   · Alt+A 可用 —— 键位真的注册在 manifest 的 commands 里，而它触发的那个动作
//     和悬浮球、popup 点的是同一个。
const { test, expect } = require('./fixtures');
const {
  setExtensionSettings, getSyncSetting, getServiceWorker, sendMessageToActiveTab, triggerSelectionHotkey
} = require('./helpers');
const { startMockOpenAIServer } = require('./mock-openai-server');

const ORIGIN = 'https://ask.test';
const BODY = 'The harbour master keeps a separate ledger for the boats that never came back.';

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Harbour ledger</title></head>
<body><div id="box"><p id="para">${BODY}</p></div></body></html>`;

async function serve(page, context, endpoint, extra = {}) {
  await setExtensionSettings(page, {
    apiEndpoint: endpoint,
    apiKey: 'test-key',
    modelName: 'gpt-4.1-mini',
    targetLang: 'zh-CN',
    skipTargetLanguageText: false,
    ...extra
  });
  await context.route(`${ORIGIN}/**`, (route) => {
    route.fulfill({ status: 200, contentType: 'text/html', body: PAGE });
  });
  await page.goto(`${ORIGIN}/ledger`);
  await page.waitForSelector('#ai-translator-float-ball');
}

test('ask bar: 勾一下、点一下，这一页翻了，这个站点以后也都翻', async ({ page, context }) => {
  const { close, endpoint } = await startMockOpenAIServer();

  try {
    await serve(page, context, endpoint);

    // 没有规则命中的站点上，自动翻译什么都不做 —— 先问。
    const bar = page.locator('#ai-translator-auto-bar');
    await expect(bar).toBeVisible();
    await expect(bar).toHaveAttribute('data-mode', 'ask');
    // 问的时候一个字都还没翻。条子后面已经偷偷翻好了的话，问本身就是假的。
    await expect(page.locator('#box .ai-translator-inline-block')).toHaveCount(0);

    // —— 两下 ——
    await bar.locator('input[type="checkbox"]').check();
    await bar.locator('[data-act="translate"]').click();

    await page.waitForSelector('#box .ai-translator-inline-block', { timeout: 30000 });
    await expect(page.locator('#box .ai-translator-inline-block')).toContainText(BODY);
    // 表过态了就不该还挂在那儿。
    await expect(bar).toHaveCount(0);

    // 「总是」落到了盘上，而且落在 decide() 查的那个键上（归一化后的主机名）。
    await expect.poll(() => getSyncSetting(context, 'siteRules'), { timeout: 5000 })
      .toEqual({ 'ask.test': 'always' });
  } finally {
    await close();
  }
});

test('ask bar: 「不用」就地收走，不跳页、不翻译', async ({ page, context }) => {
  const { close, endpoint, sentTexts } = await startMockOpenAIServer();

  try {
    await serve(page, context, endpoint);

    const bar = page.locator('#ai-translator-auto-bar');
    await expect(bar).toBeVisible();
    const before = page.url();

    await bar.locator('[data-act="dismiss"]').click();
    await expect(bar).toHaveCount(0);

    // 「不离开页面」不是修辞：地址没变，页面上那一段原文还是它自己。
    expect(page.url()).toBe(before);
    await expect(page.locator('#para')).toHaveText(BODY);
    await expect(page.locator('#box .ai-translator-inline-block')).toHaveCount(0);

    // 计数记了一笔 —— 「不用」正是三次额度里的一次。
    await expect.poll(() => getSyncSetting(context, 'siteAskCount'), { timeout: 5000 })
      .toEqual({ 'ask.test': 1 });

    // 关掉之后这一页不该再冒出来，也不该背着用户把请求发出去。
    await page.waitForTimeout(1500);
    await expect(bar).toHaveCount(0);
    expect(sentTexts.join('\n')).not.toContain(BODY);
  } finally {
    await close();
  }
});

test('ask bar: 问满三次就再也不问了', async ({ page, context }) => {
  const { close, endpoint } = await startMockOpenAIServer();

  try {
    // 前三次已经问过（换过设备也算 —— 这条计数跟着 sync 走）。
    await serve(page, context, endpoint, { siteAskCount: { 'ask.test': 3 } });

    // 给它足够的时间去判、去画。什么都不该出现。
    await page.waitForTimeout(2000);
    await expect(page.locator('#ai-translator-auto-bar')).toHaveCount(0);
    await expect(page.locator('#box .ai-translator-inline-block')).toHaveCount(0);
  } finally {
    await close();
  }
});

test('Alt+A 注册在 commands 里，它触发的动作就是悬浮球点的那一个', async ({ page, context }) => {
  const { close, endpoint } = await startMockOpenAIServer();

  try {
    await serve(page, context, endpoint, { siteRules: { 'ask.test': 'never' } });

    // Chrome 自己派发的那一下按键在 Playwright 里到不了扩展，所以这里钉两头：
    // 键位真的注册了，以及它发出去的那条消息真的会翻译 / 还原这一页。
    const worker = await getServiceWorker(context);
    const commands = await worker.evaluate(() => chrome.commands.getAll());
    const toggle = commands.find((c) => c.name === 'toggle-translate-page');
    expect(toggle).toBeTruthy();
    // Chrome 按平台印键位：Windows/Linux 上是 `Alt+A`，macOS 上是 `⌥A`。钉死
    // 其中一种就是在另一个平台上红一次，而那不是缺陷。要的是「这个键真的绑上
    // 了，而且绑的是 Alt 那一档的 A」。
    expect(toggle.shortcut).toMatch(/^(Alt\+|⌥)A$/);

    expect(await sendMessageToActiveTab(page, { type: 'TOGGLE_PAGE_TRANSLATION' }))
      .toEqual({ action: 'translating' });
    await page.waitForSelector('#box .ai-translator-inline-block', { timeout: 30000 });

    // 再来一下是还原 —— 同一个键，同一件事的另一半。译文是藏起来不是删掉：
    // 再按一次要能原样回来，重译一遍是在花用户的钱买他刚才已经有过的东西。
    expect(await sendMessageToActiveTab(page, { type: 'TOGGLE_PAGE_TRANSLATION' }))
      .toEqual({ action: 'restored' });
    await expect(page.locator('#box .ai-translator-inline-block')).toBeHidden();
    await expect(page.locator('#para')).toHaveText(BODY);
  } finally {
    await close();
  }
});

test('状态点：暂停时亮灰，点它展开一行说明；恢复后熄灭', async ({ page, context }) => {
  const { close, endpoint } = await startMockOpenAIServer();

  try {
    await serve(page, context, endpoint, { siteRules: { 'ask.test': 'always' } });
    await page.waitForSelector('#box .ai-translator-inline-block', { timeout: 30000 });

    const dot = page.locator('#ai-translator-float-ball .ai-translator-status-dot');
    // 翻完了、没有翻不成的段落 —— 一个安静的页面上不该有灯。
    await expect(dot).toHaveAttribute('data-state', 'none');

    // popup 第三行按的就是这条消息。
    await sendMessageToActiveTab(page, { type: 'SET_AUTO_PAUSED', paused: true });
    await expect(dot).toHaveAttribute('data-state', 'paused');
    await expect(dot).toBeVisible();

    // 点一下展开说明：一行字，不是浮层，而且说得出「为什么是这样」。
    await page.hover('#ai-translator-float-ball');
    await dot.click();
    const bar = page.locator('#ai-translator-auto-bar');
    await expect(bar).toHaveAttribute('data-mode', 'explain');
    await expect(bar.locator('.ai-translator-auto-text')).not.toBeEmpty();
    // 展开态里没有「翻译 / 不用」那两个按钮 —— 它不是在问，是在答。
    await expect(bar.locator('[data-act="translate"]')).toBeHidden();

    await bar.locator('[data-act="close"]').click();
    await expect(bar).toHaveCount(0);

    await sendMessageToActiveTab(page, { type: 'SET_AUTO_PAUSED', paused: false });
    await expect(dot).toHaveAttribute('data-state', 'none');
  } finally {
    await close();
  }
});

test('popup: 没有可操作的页面时只剩一行，键位印的是真注册上的那个', async ({ page, extensionId }) => {
  // popup 当成标签页打开时，「当前标签页」就是它自己 —— 没有内容脚本，问不到
  // 任何页面状态。那时候站点行和暂停行都该收起来：一个点了什么都不会发生的
  // 开关，比没有这个开关更糟。
  await page.goto(`chrome-extension://${extensionId}/popup/popup.html`);

  await expect(page.locator('#toggleSiteAuto')).toBeHidden();
  await expect(page.locator('#togglePagePause')).toBeHidden();
  await expect(page.locator('#translatePage')).toBeVisible();

  // 键位从 chrome.commands.getAll() 读回来，所以用户改过之后这里印的是他改成
  // 的那个；这条同时也是「新代码在 popup 里没抛异常」的证据 —— 抛了的话这一行
  // 会停在 hidden。
  await expect(page.locator('#translatePageShortcut')).toHaveText(/^(Alt\+|⌥)A$/);
});

test('划词译了一句，Alt+A 第一下仍然是翻整页，不是把那一句藏起来', async ({ page, context }) => {
  // 划词译文和整页译文共用 .ai-translator-inline-block，只是各自多带一个类名。
  // 判据少写一个 :not()，用户划词查了一个词之后，这一页在插件眼里就算「翻过
  // 了」—— 再按 Alt+A 不翻页，反而把刚查的那句藏了。
  const { close, endpoint } = await startMockOpenAIServer();

  try {
    await setExtensionSettings(page, {
      apiEndpoint: endpoint,
      apiKey: 'test-key',
      modelName: 'gpt-4.1-mini',
      targetLang: 'zh-CN',
      skipTargetLanguageText: false,
      // 这一页不自动翻：要证的是手动那一下按下去做了哪件事。
      siteRules: { 'ask.test': 'never' }
    });
    await context.route(`${ORIGIN}/**`, (route) => {
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Ledger</title></head>
<body><div id="box">
  <p id="picked">${BODY}</p>
  <p id="rest">Nobody in the harbour office could say who had opened the second ledger.</p>
</div></body></html>`
      });
    });
    await page.goto(`${ORIGIN}/selection`);
    await page.waitForSelector('#ai-translator-float-ball');
    await expect(page.locator('#ai-translator-auto-bar')).toHaveCount(0);

    await page.locator('#picked').selectText();
    await triggerSelectionHotkey(page);
    await page.waitForSelector('.ai-translator-selection-translation', { state: 'attached' });
    // 这一页现在有一条译文了 —— 但它是划词译的，整页还一个字没翻。
    // 整页译文按块插在段落后面，所以数的是 #box 底下、去掉划词那一条之后还剩几条。
    const pageBlocks = page.locator('#box .ai-translator-inline-block:not(.ai-translator-selection-translation)');
    await expect(pageBlocks).toHaveCount(0);

    const first = await sendMessageToActiveTab(page, { type: 'TOGGLE_PAGE_TRANSLATION' });
    expect(first.action).toBe('translating');

    // 剩下那一段被翻了，划词那一条还在、还看得见。
    await expect(pageBlocks).not.toHaveCount(0, { timeout: 30000 });
    await expect(page.locator('.ai-translator-selection-translation')).toBeVisible();
  } finally {
    await close();
  }
});

test('一轮翻译跑到一半按下 Alt+A，后面落下来的译文也是藏着的', async ({ page, context }) => {
  // 整页翻译一批批往回落，一轮要几十秒。中途「显示原文」只管得到当时已经插好的
  // 块的话，用户一边藏、译文一边冒出来，那个开关就是个摆设。
  const { close, endpoint } = await startMockOpenAIServer({ delayMs: 700 });

  try {
    await setExtensionSettings(page, {
      apiEndpoint: endpoint,
      apiKey: 'test-key',
      modelName: 'gpt-4.1-mini',
      targetLang: 'zh-CN',
      skipTargetLanguageText: false,
      autoTranslate: false
    });
    // 一批最多装 40 段，而并发是 12 路：段数要多到凑出十几批，第十三批才会排在
    // 队里等 —— 「一半」那个窗口是这么来的，不是靠赛跑抢出来的。
    const paras = Array.from({ length: 600 }, (_, i) =>
      `<p id="p${i}">Entry ${i}: the harbour master wrote down every boat that left before dawn.</p>`
    ).join('');
    await context.route(`${ORIGIN}/**`, (route) => {
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Ledger</title></head>
<body><div id="box">${paras}</div></body></html>`
      });
    });
    await page.goto(`${ORIGIN}/long`);
    await page.waitForSelector('#ai-translator-float-ball');

    const started = await sendMessageToActiveTab(page, { type: 'TOGGLE_PAGE_TRANSLATION' });
    expect(started.action).toBe('translating');

    // 第一波落地，但整轮还没跑完 —— 这一下就按在半路上。
    await page.waitForSelector('#box .ai-translator-inline-block', { timeout: 30000 });
    const midway = await page.locator('#box .ai-translator-inline-block').count();
    expect(midway).toBeLessThan(600);

    const hidden = await sendMessageToActiveTab(page, { type: 'TOGGLE_PAGE_TRANSLATION' });
    expect(hidden.action).toBe('restored');

    // 剩下的批次继续落地 —— 但一条都不该露出来。
    await page.waitForFunction(
      (before) => document.querySelectorAll('#box .ai-translator-inline-block').length > before,
      midway,
      { timeout: 30000 }
    );
    await page.waitForTimeout(1500);
    const visible = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#box .ai-translator-inline-block'))
        .filter((el) => !el.classList.contains('ai-translator-hidden')).length
    );
    expect(visible).toBe(0);
  } finally {
    await close();
  }
});

test('把译文藏了之后，popup 上那颗「继续」真的能把这一页开回来', async ({ page, context }) => {
  // 藏译文会顺手把这一页停下（「我现在想看原文」），而 start() 里那道闩认的也是
  // 同一个标记。「继续」要是只重开一轮，就会原地弹回 PAUSED —— 按钮按下去毫无
  // 反应，还不报错。
  const { close, endpoint } = await startMockOpenAIServer();

  try {
    await serve(page, context, endpoint, { siteRules: { 'ask.test': 'always' } });
    const blocks = page.locator('#box .ai-translator-inline-block');
    await expect(blocks).not.toHaveCount(0, { timeout: 30000 });

    // 悬浮球菜单里的「显示原文」按的就是这一下。
    const hidden = await sendMessageToActiveTab(page, { type: 'TOGGLE_PAGE_TRANSLATION' });
    expect(hidden.action).toBe('restored');
    await expect(blocks.first()).toHaveClass(/ai-translator-hidden/);

    const dot = page.locator('#ai-translator-float-ball .ai-translator-status-dot');
    await expect(dot).toHaveAttribute('data-state', 'paused');

    // popup 第三行：继续翻这一页。
    const resumed = await sendMessageToActiveTab(page, { type: 'SET_AUTO_PAUSED', paused: false });
    expect(resumed.status).not.toBe('paused');
    await expect(blocks.first()).not.toHaveClass(/ai-translator-hidden/);
    await expect(dot).toHaveAttribute('data-state', 'none');
  } finally {
    await close();
  }
});
