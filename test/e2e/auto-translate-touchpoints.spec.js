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
  setExtensionSettings, getSyncSetting, getServiceWorker, sendMessageToActiveTab, triggerSelectionHotkey,
  openFloatBallMenu
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

    // 再按一下：这一下是「我想看原文」。整页那一批收起来，划词那一句留着 ——
    // 他刚刚指着那句话问过「这什么意思」，答案不归一个管整页的开关收走。
    const hidden = await sendMessageToActiveTab(page, { type: 'TOGGLE_PAGE_TRANSLATION' });
    expect(hidden.action).toBe('restored');
    await expect(pageBlocks.first()).toBeHidden();
    await expect(page.locator('.ai-translator-selection-translation')).toBeVisible();
  } finally {
    await close();
  }
});

test('受管容器：整页译文藏着的时候划词，那一句照样看得见', async ({ page, context }) => {
  // Lexical / ProseMirror 这类容器里，译文不是节点而是原文块的 ::after，由一条
  // 文档级规则统管。上一条旅程里那两个 :not() 在这里落不到实处 —— 一个挂在
  // <html> 上的属性会把所有受管译文一起关掉，连同他刚划词问出来的那一句；而且
  // 它管的是生成内容，**接下来新划的一句照样不出来**，直到整页译文重新显示。
  const { close, endpoint } = await startMockOpenAIServer();

  try {
    await setExtensionSettings(page, {
      apiEndpoint: endpoint,
      apiKey: 'test-key',
      modelName: 'gpt-4.1-mini',
      targetLang: 'zh-CN',
      skipTargetLanguageText: false,
      siteRules: { 'ask.test': 'never' }
    });
    await context.route(`${ORIGIN}/**`, (route) => {
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Editor</title></head>
<body><div id="box" data-lexical-editor="true">
  <p id="picked">${BODY}</p>
  <p id="rest">Nobody in the office could say who had opened the second book.</p>
</div></body></html>`
      });
    });
    await page.goto(`${ORIGIN}/editor`);
    await page.waitForSelector('#ai-translator-float-ball');

    // 受管译文没有自己的节点可以数 —— 认原文块上的标记，看它的 ::after。
    const after = (sel) => page.evaluate(
      (s) => window.getComputedStyle(document.querySelector(s), '::after').content, sel);

    // 他先指着一句话问「这什么意思」。这一条是一次性的，块上有记号。
    await page.locator('#picked').selectText();
    await triggerSelectionHotkey(page);
    await page.waitForSelector('#picked[data-ai-translator-managed-one-off]', { timeout: 30000 });
    await expect.poll(() => after('#picked'), { timeout: 30000 }).toContain('harbour master');

    // 然后翻整页。划过的那一块已经有译文，发现层会跳过它。
    expect((await sendMessageToActiveTab(page, { type: 'TOGGLE_PAGE_TRANSLATION' })).action).toBe('translating');
    await page.waitForSelector('#rest[data-ai-translator-managed]', { timeout: 30000 });
    await expect.poll(() => after('#rest'), { timeout: 30000 }).toContain('second book');

    // 「显示原文」：整页那一批收起来 —— 他刚刚问出来的那一句留着。
    expect((await sendMessageToActiveTab(page, { type: 'TOGGLE_PAGE_TRANSLATION' })).action).toBe('restored');
    await expect.poll(() => after('#rest'), { timeout: 5000 }).toBe('none');
    expect(await after('#picked')).toContain('harbour master');
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

test('popup 上按下的暂停，不会被「显示原文 → 显示译文」顺手洗掉', async ({ page, context }) => {
  // 「这一页先别翻了」和「我现在想看原文」是两句话。显隐那两下说的是后者 ——
  // 它顺手停下、顺手继续都对，但能撤销的只有它自己停的那一下。越过那道闩的
  // 话，用户看一眼原文再切回来，页面自己又翻起来了，而他从头到尾没碰过那颗
  // 按钮 —— 而且他没有任何理由想到要再去按一次暂停。
  const { close, endpoint, sentTexts } = await startMockOpenAIServer();

  try {
    await serve(page, context, endpoint, { siteRules: { 'ask.test': 'always' } });
    const blocks = page.locator('#box .ai-translator-inline-block');
    await expect(blocks).not.toHaveCount(0, { timeout: 30000 });

    await sendMessageToActiveTab(page, { type: 'SET_AUTO_PAUSED', paused: true });
    expect((await sendMessageToActiveTab(page, { type: 'AUTO_PAGE_STATE' })).auto.status).toBe('paused');
    const spent = sentTexts.length;

    // 悬浮球菜单里那一项只管显隐（不像 Alt+A，它不会顺手开一轮）。来回各一次。
    const menu = page.locator('#ai-translator-float-menu');
    await openFloatBallMenu(page);
    await page.click('.ai-translator-menu-item[data-action="toggle-translations"]');
    await expect(blocks.first()).toHaveClass(/ai-translator-hidden/);
    await expect(menu).toBeHidden();
    await openFloatBallMenu(page);
    await page.click('.ai-translator-menu-item[data-action="toggle-translations"]');
    await expect(blocks.first()).not.toHaveClass(/ai-translator-hidden/);

    // 译文回来了，暂停还在。
    expect((await sendMessageToActiveTab(page, { type: 'AUTO_PAGE_STATE' })).auto.status).toBe('paused');
    await expect(page.locator('#ai-translator-float-ball .ai-translator-status-dot'))
      .toHaveAttribute('data-state', 'paused');

    // 停着就是真的停着：这一页新长出来的一段不会被翻。
    await page.evaluate(() => {
      const p = document.createElement('p');
      p.textContent = 'A ninth entry appeared overnight, written in a different hand.';
      document.getElementById('box').appendChild(p);
    });
    await page.waitForTimeout(1500);
    expect(sentTexts.length).toBe(spent);
  } finally {
    await close();
  }
});

test('译文藏着的时候把这个站点关掉 —— popup 上那个开关得真的关得掉', async ({ page, context }) => {
  // 「我想看原文」把这一页停在 paused。popup 上那一行画的是**状态**：状态一天
  // 停在 paused，它就一天写着「开」，再点一次又写一遍 never —— 怎么点都关不掉。
  // 所以规则改了，判定就得跟着改，哪怕这一页此刻一个字也不会翻。
  const { close, endpoint, sentTexts } = await startMockOpenAIServer();

  try {
    await serve(page, context, endpoint, { siteRules: { 'ask.test': 'always' } });
    const blocks = page.locator('#box .ai-translator-inline-block');
    await expect(blocks).not.toHaveCount(0, { timeout: 30000 });
    const spent = sentTexts.length;

    const hidden = await sendMessageToActiveTab(page, { type: 'TOGGLE_PAGE_TRANSLATION' });
    expect(hidden.action).toBe('restored');
    const paused = await sendMessageToActiveTab(page, { type: 'AUTO_PAGE_STATE' });
    expect(paused.auto.status).toBe('paused');

    // popup 上的那一下：把站点规则改成「永不」。走的是 popup 点下去的同一条路。
    const worker = await getServiceWorker(context);
    await worker.evaluate(() => globalThis.SiteRules.writeUserRule('ask.test', 'never'));

    await expect.poll(
      async () => (await sendMessageToActiveTab(page, { type: 'AUTO_PAGE_STATE' })).auto.status,
      { timeout: 5000 }
    ).toBe('off');

    // 关掉不等于把译文翻出来重来一遍：藏着的还藏着，一个新请求都不发。
    await expect(blocks.first()).toHaveClass(/ai-translator-hidden/);
    expect(sentTexts.length).toBe(spent);
  } finally {
    await close();
  }
});

test('划词键位是 Alt 时，Alt+A 只翻整页，不会顺手把选中的那句也译一遍', async ({ page, context }) => {
  // 划词和悬停的快捷键是「单独一个修饰键」，而 Alt+A 的第一下 keydown 长得和
  // 「只按了 Alt」一模一样。立刻动手的话，用户按一次 Alt+A 会既译一句又译一页
  // —— 两次请求，用自己的 API 就是两份钱。
  const { close, endpoint, sentTexts } = await startMockOpenAIServer();

  try {
    await serve(page, context, endpoint, {
      siteRules: { 'ask.test': 'never' },
      enableSelection: true,
      selectionTranslationHotkey: 'Alt'
    });
    await page.locator('#para').selectText();

    // Alt 按下去，接着来的是 A —— 这是一个和弦，不是「只按了 Alt」。
    await page.keyboard.down('Alt');
    await page.keyboard.press('a');
    await page.keyboard.up('Alt');

    // 等过「按住」的那一档，确认它是真的没动手，而不是还没轮到。
    await page.waitForTimeout(800);
    await expect(page.locator('.ai-translator-selection-translation')).toHaveCount(0);
    expect(sentTexts).toHaveLength(0);

    // 而单按一下 Alt 照样译：这是让键位闭嘴，不是让它失灵。
    await page.keyboard.press('Alt');
    await page.waitForSelector('.ai-translator-selection-translation', { state: 'attached' });
    // 浮层是先挂上「翻译中」再发请求的，所以这里得等请求真出去。当场数会数到
    // 零 —— 而零在这里不是「没发」，是「还没发」，两者差一个往返。
    await expect.poll(() => sentTexts.length, { timeout: 10000 }).toBe(1);
  } finally {
    await close();
  }
});

test('划词键位按住不放不算数 —— 松开那一下才译', async ({ page, context }) => {
  // 「按住够久也算数」是悬停的手势，不是划词的。划词也开上的话，和弦的第二下
  // 来得慢一点（用户按着 Ctrl 伸手去够 C）就会先被当成「只按了 Ctrl」译一句。
  const { close, endpoint, sentTexts } = await startMockOpenAIServer();

  try {
    await serve(page, context, endpoint, {
      siteRules: { 'ask.test': 'never' },
      enableSelection: true,
      selectionTranslationHotkey: 'Alt'
    });
    await page.locator('#para').selectText();

    // 按住，远远超过「按住」那一档的时长。
    await page.keyboard.down('Alt');
    await page.waitForTimeout(800);
    await expect(page.locator('.ai-translator-selection-translation')).toHaveCount(0);
    expect(sentTexts).toHaveLength(0);

    // 松开才算数。
    await page.keyboard.up('Alt');
    await page.waitForSelector('.ai-translator-selection-translation', { state: 'attached' });
    await expect.poll(() => sentTexts.length, { timeout: 10000 }).toBe(1);
  } finally {
    await close();
  }
});

test('按住 Alt 译了一段，再去够 A —— 后面划过的段落不该跟着译', async ({ page, context }) => {
  // 和弦不一定按得快。用户按住 Alt 的时候光标已经停在一段上，「按住档」那一瞬
  // 自己先译了一段；他这才去够 A。译出来的那一段留着 —— 请求已经付过了，当场
  // 撤掉只会更怪 —— 但从那一下起 Alt 就是和弦的一半，后面划过的段落一段都不该
  // 再译。少了这道补刀，松手之前划过多少段就是多少次请求。
  const { close, endpoint, sentTexts } = await startMockOpenAIServer();

  try {
    await serve(page, context, endpoint, {
      siteRules: { 'ask.test': 'never' },
      enableHoverTranslation: true,
      hoverTranslationHotkey: 'Alt'
    });
    await page.evaluate(() => {
      const extra = document.createElement('p');
      extra.id = 'para2';
      extra.textContent = 'Every ledger entry names a harbour that no longer keeps a lighthouse.';
      document.getElementById('box').appendChild(extra);
    });

    // 光标先停在第一段上再按住 Alt：这一按没有鼠标移动可依，靠的是「按住够久」。
    await page.locator('#para').hover();
    await page.keyboard.down('Alt');
    await page.waitForSelector('.ai-translator-hover-translation', { state: 'attached' });
    await expect.poll(() => sentTexts.length, { timeout: 10000 }).toBe(1);

    // Alt 还按着，这才按下 A。
    await page.keyboard.press('a');
    await page.locator('#para2').hover();
    await page.waitForTimeout(800);
    expect(sentTexts).toHaveLength(1);
    await expect(page.locator('.ai-translator-hover-translation')).toHaveCount(1);
    await page.keyboard.up('Alt');

    // 松开之后重新按住，悬停翻译照常能用：拦的是那一按，不是这个功能。
    await page.locator('#para2').hover();
    await page.keyboard.down('Alt');
    await expect.poll(() => sentTexts.length, { timeout: 10000 }).toBe(2);
    await page.keyboard.up('Alt');
  } finally {
    await close();
  }
});

test('悬停键位是 Alt 时，Alt+A 之后一路划过去也不会译', async ({ page, context }) => {
  // 悬停翻译是「按住键、鼠标划过哪段就译哪段」。Alt+A 按住的那一小会儿里鼠标
  // 只要动一下，划过的每一段都会被当成用户要译 —— 一个和弦，一串请求。
  const { close, endpoint, sentTexts } = await startMockOpenAIServer();

  try {
    await serve(page, context, endpoint, {
      siteRules: { 'ask.test': 'never' },
      enableHoverTranslation: true,
      hoverTranslationHotkey: 'Alt'
    });
    await page.mouse.move(5, 5);

    await page.keyboard.down('Alt');
    await page.keyboard.press('a');
    // Alt 还按着（用户手还没抬），鼠标划到段落上。
    await page.locator('#para').hover();
    await page.waitForTimeout(800);
    await expect(page.locator('.ai-translator-hover-translation')).toHaveCount(0);
    expect(sentTexts).toHaveLength(0);
    await page.keyboard.up('Alt');

    // 松开之后重新按住，这一下是干干净净的悬停翻译。
    await page.keyboard.down('Alt');
    await page.waitForSelector('.ai-translator-hover-translation', { state: 'attached' });
    await page.keyboard.up('Alt');
  } finally {
    await close();
  }
});

// 触屏上长按是菜单的唯一入口（没有 hover 就没有那颗 `···`）。菜单 500ms 就开出
// 来了，手指却常常还按着 —— 松手时浏览器补发的那一串合成事件，必须被认成这次
// 长按的尾巴，而不是一次新的单击。认错了，代价是一次没人点过的整页翻译。
test('长按开了菜单还按着不放 —— 松手那一下不该再把整页翻一遍', async ({ page, context }) => {
  const { close, endpoint, sentTexts } = await startMockOpenAIServer();

  try {
    await serve(page, context, endpoint, { siteRules: { 'ask.test': 'never' } });

    const ball = page.locator('#ai-translator-float-ball');
    const box = await ball.boundingBox();
    // 球心，不是那颗 `···`：落在球身上才会走到「翻译整页」那一档。
    const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart', touchPoints: [{ x: point.x, y: point.y }]
    });

    // 菜单在 500ms 开出来，手指再按满一秒多 —— 旧的一秒窗口就是在这儿过的期。
    await expect(page.locator('#ai-translator-float-menu')).toBeVisible();
    await page.waitForTimeout(1600);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });

    // 合成事件是异步补上来的，给它跑完的时间，再看有没有人开始花钱。
    await page.waitForTimeout(1200);
    expect(sentTexts).toHaveLength(0);
    await expect(page.locator('#box .ai-translator-inline-block')).toHaveCount(0);
    // 菜单还开着 —— 那一下要是漏过去，它会被当成第二次点击又合上。
    await expect(page.locator('#ai-translator-float-menu')).toBeVisible();
  } finally {
    await close();
  }
});

test('球上那两颗按钮，不碰鼠标也用得了', async ({ page, context }) => {
  // 实现文档那一行写的是「追问条、状态点、popup 四行均可 Tab / Enter」。鼠标那
  // 条路摊在 mousedown/mouseup 一对事件上 —— 键盘上一个字都跑不到，所以这条旅程
  // 走的全程只有 Tab / Enter / Esc。
  const { close, endpoint, sentTexts } = await startMockOpenAIServer();
  try {
    await serve(page, context, endpoint, { siteRules: { 'ask.test': 'always' } });
    const blocks = page.locator('#box .ai-translator-inline-block');
    await expect(blocks).not.toHaveCount(0, { timeout: 30000 });

    // 先把这一页停下来，状态点才有东西可说 —— 不亮的时候它是 display:none，
    // 键盘本来就够不着，也不该够得着。
    await sendMessageToActiveTab(page, { type: 'TOGGLE_PAGE_TRANSLATION' });
    const dot = page.locator('#ai-translator-float-ball .ai-translator-status-dot');
    await expect(dot).toHaveAttribute('data-state', 'paused');
    const spent = sentTexts.length;

    // 状态点：读屏靠 aria-label 认它，Enter 把说明条打开。
    const label = await dot.getAttribute('aria-label');
    expect(label && label.length).toBeTruthy();
    await dot.press('Enter');
    await expect(page.locator('#ai-translator-auto-bar')).toHaveAttribute('data-mode', 'explain');

    // ···：平时 opacity:0，焦点一落上去就得显形，否则焦点在人眼里凭空消失一格。
    const more = page.locator('#ai-translator-float-ball .ai-translator-ball-more');
    await expect(more).toHaveCSS('opacity', '0');
    await more.focus();
    await expect(more).toHaveCSS('opacity', '1');
    await more.press('Enter');
    await expect(page.locator('#ai-translator-float-menu')).toBeVisible();
    await expect(more).toHaveAttribute('aria-expanded', 'true');

    // 菜单里的几项本身也得进得了焦点。（不走 Tab：此刻说明条还开着，中间隔着
    // 它那颗按钮 —— 两个浮层同时开着时的 Tab 次序不是什么值得钉死的契约。）
    await page.locator('#ai-translator-float-menu .ai-translator-menu-item').first().focus();
    const inMenu = await page.evaluate(() => (document.activeElement && document.activeElement.className) || '');
    expect(inMenu).toContain('ai-translator-menu-item');

    // 键盘上没有「别处」可点，Esc 是菜单唯一的退路（那一处在 content-selection.js，
    // 它连着划词浮层一起关）。菜单一撤，焦点正在里头 —— 得把它送回 ··· 上，
    // 否则要从头 Tab 一整页才回得到球上。
    await page.keyboard.press('Escape');
    await expect(page.locator('#ai-translator-float-menu')).toHaveCount(0);
    await expect(more).toHaveAttribute('aria-expanded', 'false');
    const focused = await page.evaluate(() => (document.activeElement && document.activeElement.className) || '');
    expect(focused).toContain('ai-translator-ball-more');

    // 全程没有一下是花钱的。
    expect(sentTexts.length).toBe(spent);
  } finally {
    await close();
  }
});

test('他按下的暂停，别的标签页改一条规则也顶不开', async ({ page, context }) => {
  // 暂停只改调度层的 status，而 status 会被下一次 start() 盖掉 —— 而 start()
  // 常常是别人替他叫的：另一个标签页在追问条上勾了「总是」，siteRules 一落地，
  // 这一页的 onSettingsChanged 就重开一轮。他按下的暂停当场失效，页面自己又翻
  // 起来了，而他没有碰过任何东西。
  const { close, endpoint, sentTexts } = await startMockOpenAIServer();
  try {
    await serve(page, context, endpoint, { siteRules: { 'ask.test': 'always' } });
    const blocks = page.locator('#box .ai-translator-inline-block');
    await expect(blocks).toHaveCount(1, { timeout: 30000 });

    const paused = await sendMessageToActiveTab(page, { type: 'SET_AUTO_PAUSED', paused: true });
    expect(paused.status).toBe('paused');
    const spent = sentTexts.length;

    // 停下之后这一页又长出一段。重开一轮的话，它一定会被翻掉 —— 这是「有没有
    // 真的停住」唯一看得见的证据。
    await page.evaluate(() => {
      const p = document.createElement('p');
      p.id = 'later';
      p.textContent = 'A second ledger arrived on the evening tide, unsigned and already damp.';
      document.getElementById('box').appendChild(p);
    });

    // 别的标签页写了一条跟这一页无关的规则 —— siteRules 整张表变了，这一页照样
    // 收到通知。
    const worker = await getServiceWorker(context);
    await worker.evaluate(() => globalThis.SiteRules.writeUserRule('elsewhere.test', 'always'));

    await page.waitForTimeout(3000);
    const after = await sendMessageToActiveTab(page, { type: 'AUTO_PAGE_STATE' });
    expect(after.auto.status).toBe('paused');
    await expect(blocks).toHaveCount(1);
    expect(sentTexts.length).toBe(spent);
  } finally {
    await close();
  }
});
