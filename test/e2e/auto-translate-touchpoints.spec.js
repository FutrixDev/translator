// 自动翻译的第三条旅程：**用户怎么开、怎么关**。
//
// 前两条旅程（判定、滚动续译）证的都是「该翻的翻了」。这一条证的是那之前和之后
// 的两下：一个不在任何名单上的站点上，我们安静到什么程度；以及用户说「开」或
// 「不用」之后，这件事变得有多干净。
//
// 名单外的站点从 R33 起是安静的 off（D-351）：不翻、不问、也不算拒绝。开它的路
// 只有用户自己点的那几处 —— popup 的站点开关、设置页的站点表、Alt+A。
//
// 这一份问的是安静本身和开关：键位注册、状态点、popup。另外两段旅程分在
// auto-translate-hidden.spec.js（按下之后把译文藏起来那条路）和
// auto-translate-hotkey.spec.js（Alt+A 和划词/悬停键位撞在一起）。
// 夹具在 auto-touchpoint-fixtures.js。
const { test, expect } = require('./fixtures');
const { getSyncSetting, getServiceWorker, sendMessageToActiveTab } = require('./helpers');
const { startMockOpenAIServer } = require('./mock-openai-server');
const { BODY, serve } = require('./auto-touchpoint-fixtures');

test('名单外的站点安静地不翻：没有追问条，一个请求都不发；写一条「总是」当场开译', async ({ page, context }) => {
  const { close, endpoint, sentTexts } = await startMockOpenAIServer();
  const auto = async () => {
    const { status, reason, siteRefused } = (await sendMessageToActiveTab(page, { type: 'AUTO_PAGE_STATE' })).auto;
    return { status, reason, siteRefused };
  };

  try {
    await serve(page, context, endpoint);

    // 给它足够的时间去判、去画。什么都不该出现 —— 从前这里会冒出一条追问条。
    await page.waitForTimeout(2000);
    await expect(page.locator('#ai-translator-auto-bar')).toHaveCount(0);
    await expect(page.locator('#box .ai-translator-inline-block')).toHaveCount(0);
    expect(sentTexts.join('\n')).not.toContain(BODY);
    // 安静的 off 不是拒绝：popup 上不会写成「这个站点你关掉了」。
    expect(await auto()).toEqual({ status: 'off', reason: 'DEFAULT_OFF', siteRefused: false });

    // 用户在 popup / 设置页里把这个站点设成「总是」：写的是 decide() 查的那张表，
    // 页面不用刷新就开译。
    const worker = await getServiceWorker(context);
    await worker.evaluate(() => globalThis.SiteRules.writeUserRule('ask.test', 'always'));
    await page.waitForSelector('#box .ai-translator-inline-block', { timeout: 30000 });
    await expect(page.locator('#box .ai-translator-inline-block')).toContainText(BODY);
    await expect(page.locator('#ai-translator-auto-bar')).toHaveCount(0);
  } finally {
    await close();
  }
});

test('一次性的「翻译这一页」不会让站点开关说成「开」', async ({ page, context }) => {
  // popup 上「自动翻译这个站点」那一行画的要是 status，这一条就是它的账单：
  // 用户按 Alt+A（或 popup 上的「翻译此页」）只翻了这一页 —— 这一页翻了
  // （idle/running），规则表里一条都没落地，下次再来照样不翻。那一行却写着
  // 「开」；他顺手去点那个看起来已经开着的开关，写进去的是一条**永久的 never**。
  // 他想开，反倒关死了。
  //
  // 断言落在 auto.siteAuto 上 —— popup 那一行读的就是这一个字段。
  const { close, endpoint } = await startMockOpenAIServer();
  const siteAuto = async () =>
    (await sendMessageToActiveTab(page, { type: 'AUTO_PAGE_STATE' })).auto.siteAuto;

  try {
    await serve(page, context, endpoint);

    expect(await sendMessageToActiveTab(page, { type: 'TOGGLE_PAGE_TRANSLATION' }))
      .toEqual({ action: 'translating' });
    await page.waitForSelector('#box .ai-translator-inline-block', { timeout: 30000 });

    const after = (await sendMessageToActiveTab(page, { type: 'AUTO_PAGE_STATE' })).auto;
    expect(['idle', 'running']).toContain(after.status);   // 这一页确实在翻
    expect(after.siteAuto).toBe(false);                    // 这个站点却一条规则都没有
    expect(await getSyncSetting(context, 'siteRules')).toBeFalsy();

    // 反过来那一半同样会错，而且更难想到：把「表过态」当成「这个站点关着」来认
    // （只认 USER_ALWAYS / BUILTIN_ALWAYS 那两条理由）的话，x.com 这种内置就翻
    // 的站点上，用户按一下 Alt+A，这一行反倒从「开」翻成「关」—— decide() 的阶
    // 梯上 explicit 排在所有站点规则之前，把它们全挡在了后面。
    //
    // 这里用等价的用户规则摆出同一个局面：规则落地，而这一页早就表过态了。
    const worker = await getServiceWorker(context);
    await worker.evaluate(() => globalThis.SiteRules.writeUserRule('ask.test', 'always'));
    await expect.poll(siteAuto, { timeout: 5000 }).toBe(true);
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
  await expect(page.locator('#stopSiteAuto')).toBeHidden();
  await expect(page.locator('#togglePagePause')).toBeHidden();
  await expect(page.locator('#translatePage')).toBeVisible();

  // 键位从 chrome.commands.getAll() 读回来，所以用户改过之后这里印的是他改成
  // 的那个；这条同时也是「新代码在 popup 里没抛异常」的证据 —— 抛了的话这一行
  // 会停在 hidden。
  await expect(page.locator('#translatePageShortcut')).toHaveText(/^(Alt\+|⌥)A$/);
});

test('popup 总开关：关掉就是 autoTranslate=false，这一页当场停，新长出来的段落不再送', async ({ page, context, extensionId }) => {
  const { close, endpoint, sentTexts } = await startMockOpenAIServer();
  const append = (id, text) => page.evaluate(([id, text]) => {
    const p = document.createElement('p');
    p.id = id;
    p.textContent = text;
    document.getElementById('box').appendChild(p);
  }, [id, text]);
  const BEFORE = 'The lighthouse keeper wrote down every ship that passed the northern rocks.';
  const AFTER = 'The ferry timetable was pinned to the door of the harbour office each spring.';

  try {
    await serve(page, context, endpoint, { siteRules: { 'ask.test': 'always' } });
    await page.waitForSelector('#box .ai-translator-inline-block', { timeout: 30000 });
    // 对照：开着的时候，新长出来的段落是会被接着翻的。
    await append('before', BEFORE);
    await expect.poll(() => sentTexts.some((text) => text.includes(BEFORE)), { timeout: 15000 }).toBe(true);

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
    // goto() 把 popup 推到了前面；把窗口还给页面，让 popup 问到的是这一页。
    await page.bringToFront();
    await popup.reload();
    const master = popup.locator('#toggleGlobalAuto');
    await expect(master).toBeVisible();
    await expect(master).toHaveAttribute('aria-pressed', 'true');

    await master.click();
    // 写的是设置页 #autoTranslate 那一个键。
    await expect.poll(() => getSyncSetting(context, 'autoTranslate'), { timeout: 5000 }).toBe(false);
    await expect(master).toHaveAttribute('aria-pressed', 'false');
    await expect(popup.locator('#globalAutoStatus')).toHaveText('Off');

    // 这一页当场停：调度层重判，答的是总开关关着。
    await expect.poll(async () =>
      (await sendMessageToActiveTab(page, { type: 'AUTO_PAGE_STATE' })).auto.reason, { timeout: 5000 })
      .toBe('GLOBAL_OFF');
    await append('after', AFTER);
    await page.waitForTimeout(2500);
    expect(sentTexts.join('\n')).not.toContain(AFTER);
    await expect(page.locator('#after + .ai-translator-inline-block, #after .ai-translator-inline-block')).toHaveCount(0);
    await popup.close();
  } finally {
    await close();
  }
});
