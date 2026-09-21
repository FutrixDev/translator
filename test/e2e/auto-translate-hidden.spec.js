// 自动翻译触点 —— **按下之后**那条路：把译文藏起来，再开回来。
//
// Alt+A 是个来回键：第一下翻，第二下藏。麻烦全在「藏着的时候」——这一页上还有划
// 词译出来的句子、有受管容器、有正在落下来的后半轮、有 popup 上的暂停和站点开关、
// 有上一轮留下的错误。这一组把这些情形一条条钉住：藏的是整页译文，不是别人的；
// 开回来的是同一页，不是重跑一遍。
//
// 问与开关在 auto-translate-touchpoints.spec.js，键位相撞在
// auto-translate-hotkey.spec.js，夹具在 auto-touchpoint-fixtures.js。
const { test, expect } = require('./fixtures');
const {
  setExtensionSettings,
  getServiceWorker,
  sendMessageToActiveTab,
  triggerSelectionHotkey,
  openFloatBallMenu,
} = require('./helpers');
const { startMockOpenAIServer } = require('./mock-openai-server');
const { ORIGIN, BODY, serve } = require('./auto-touchpoint-fixtures');

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

test('受管容器重建之后，悬浮球的第一下是翻译，不是藏一条不存在的译文', async ({ page, context }) => {
  // 受管译文没有自己的节点：句柄挂在一个 display:none 的离屏 holder 上，真正的
  // 译文是原文块的 ::after。子树被换掉的时候，::after 跟着走了，句柄留在原地
  // —— holder 挂在 body 上，谁都没动它。
  //
  // 于是「这一页翻过了没有」答成了 true：popup 上写着「显示原文」，而他点悬浮球
  // 的第一下是把一条早就不存在的译文「藏」一次。页面纹丝不动，他得再点一次才开
  // 始翻。普通容器里没有这一出 —— 那些译文节点就长在被换掉的子树里，一起没了。
  //
  // 两段分别钉两半。前半段编辑器自己重建子树（Lexical 这类容器的日常），换路由
  // 那一下没发生，孤儿句柄还原样挂着：这一下走得通，靠的只能是读的时候不数它。
  // 后半段换路由，收的是另一笔账 —— 规则和 map 里的条目再没人来收，一个长会话
  // 里只增不减。
  const { close, endpoint } = await startMockOpenAIServer();
  const handles = () => page.evaluate(
    () => document.querySelectorAll('#ai-translator-managed-handles .ai-translator-inline-block').length);

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
  <p id="one">${BODY}</p>
  <p id="two">Nobody in the office could say who had opened the second book.</p>
</div></body></html>`
      });
    });
    await page.goto(`${ORIGIN}/editor`);
    await page.waitForSelector('#ai-translator-float-ball');

    expect((await sendMessageToActiveTab(page, { type: 'TOGGLE_PAGE_TRANSLATION' })).action).toBe('translating');
    await page.waitForSelector('#two[data-ai-translator-managed]', { timeout: 30000 });
    await expect.poll(handles, { timeout: 30000 }).toBe(2);

    // 编辑器照自己那份状态把子树重建了一遍：块是新的，旧的那两个离开了文档 ——
    // 但单页应用把它们存着，回头还要挂回来（Turbo、React Router 的缓存都这么干）。
    await page.evaluate(() => {
      const box = document.getElementById('box');
      window.__cached = [...box.children];
      box.innerHTML =
        '<p id="three">The ledger from the previous winter was never returned to its shelf.</p>';
    });
    expect(await handles()).toBe(2);   // 换路由没发生，孤儿还挂着

    // 他点悬浮球。这一下该是翻译 —— 这一页现在一条译文都没有。
    expect((await sendMessageToActiveTab(page, { type: 'TOGGLE_PAGE_TRANSLATION' })).action).toBe('translating');
    await page.waitForSelector('#three[data-ai-translator-managed]', { timeout: 30000 });
    await expect.poll(handles, { timeout: 30000 }).toBe(3);

    // 换路由：上一页没了，这一刻不含糊，两个孤儿连同它们的规则一起收掉。
    await page.evaluate(() => { history.pushState({}, '', '/editor/next'); });
    await expect.poll(handles, { timeout: 10000 }).toBe(1);

    // 他又退回去了，缓存的那一段挂回原处。句柄和 ::after 刚才收掉了，内容身份的
    // 台账要是留着，发现层一看指纹没变就跳过（content/page/collect.js:295）——
    // 这两个块从此既没有译文，也再没有任何东西会来翻它们。
    await page.evaluate(() => {
      const box = document.getElementById('box');
      for (const el of window.__cached) box.appendChild(el);
    });
    expect(await page.evaluate(
      () => document.querySelectorAll('#one.ai-translator-translated, #two.ai-translator-translated').length
    )).toBe(0);

    // 收起来（#three 那条还在），再翻一遍：这一轮该把挂回来的两块重新翻出来。
    expect((await sendMessageToActiveTab(page, { type: 'TOGGLE_PAGE_TRANSLATION' })).action).toBe('restored');
    expect((await sendMessageToActiveTab(page, { type: 'TOGGLE_PAGE_TRANSLATION' })).action).toBe('translating');
    await page.waitForSelector('#one[data-ai-translator-managed]', { timeout: 30000 });
    await page.waitForSelector('#two[data-ai-translator-managed]', { timeout: 30000 });
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

test('出错的那一页，看一眼原文再看回来，不会替他重试一遍', async ({ page, context }) => {
  // 「隐藏译文」走的是 pauseCurrentPage('hidden')，而那道门只放过 OFF 和 PAUSED
  // —— 停在 ERROR 的一页会被改写成 PAUSED。两笔账：状态点从「出错」变成「已暂
  // 停」，为什么停了就此没人说得出；而「显示译文」那一下把它当成自己停下的那一页
  // 叫醒、重开一轮，刚刚失败的那些请求又发了一遍。用户只是想看一眼原文，页面上
  // 一点异样都没有，账单是他的。
  //
  // 造这个局面要的是「先翻成了一条，接口才开始出毛病」—— 一个字都没翻成的页面
  // 连「隐藏译文」都点不到（那一项按 hasPageTranslations() 挂）。
  const { close, endpoint, sentTexts } = await startMockOpenAIServer({ failAfter: 1 });
  const autoStatus = async () =>
    (await sendMessageToActiveTab(page, { type: 'AUTO_PAGE_STATE' })).auto.status;
  const toggleVisibility = async () => {
    await openFloatBallMenu(page);
    await page.click('.ai-translator-menu-item[data-action="toggle-translations"]');
  };

  try {
    await serve(page, context, endpoint, { siteRules: { 'ask.test': 'always' } });
    const blocks = page.locator('#box .ai-translator-inline-block');
    await expect(blocks).not.toHaveCount(0, { timeout: 30000 });

    // 接口从这一刻起不答了。新长出来的每一段都超过 MAX_BLOCK_CHARS —— 超大块各自
    // 单独成批（content/page/batch.js 的 createSmartBatches），一批一次失败，攒够
    // MAX_BATCH_FAILURES 就是「整体故障」：这一页停在 error 上，而刚才那条译文还
    // 在页面上。
    //
    // 排得紧一点是有原因的：发现层只收视野上下各一屏之内的块（见
    // content/content-auto-discover.js 的 BAND_MARGIN）。按默认字号铺开，这几段里
    // 只有头两段落在带子里，剩下的要等用户滚过去 —— 那就凑不齐三次。
    await page.evaluate(() => {
      const wrap = document.createElement('div');
      wrap.style.cssText = 'font-size:12px;line-height:1.2';
      for (let i = 0; i < 4; i += 1) {
        const p = document.createElement('p');
        p.style.margin = '0';
        p.textContent = `Ledger ${i}: `
          + 'The tide book records this departure and the return that followed it. '.repeat(60);
        wrap.appendChild(p);
      }
      document.getElementById('box').appendChild(wrap);
    });
    await expect.poll(autoStatus, { timeout: 30000 }).toBe('error');
    const spent = sentTexts.length;

    // 看一眼原文。
    await toggleVisibility();
    await expect(blocks.first()).toHaveClass(/ai-translator-hidden/);
    expect(await autoStatus()).toBe('error');

    // 看回译文。**这一下不是「重试」**：一个请求都不该发，状态也还是出错。
    await toggleVisibility();
    await expect(blocks.first()).not.toHaveClass(/ai-translator-hidden/);
    await page.waitForTimeout(2000);
    expect(await autoStatus()).toBe('error');
    expect(sentTexts.length).toBe(spent);

    // 而他真说出那一句的时候，它得动 —— popup 第三行的「继续」，藏着译文也一样：
    // 先把译文放回来，再重试。这一条正是上面那道门最容易反过来关死的地方。
    await toggleVisibility();
    await expect(blocks.first()).toHaveClass(/ai-translator-hidden/);
    await sendMessageToActiveTab(page, { type: 'SET_AUTO_PAUSED', paused: false });
    await expect(blocks.first()).not.toHaveClass(/ai-translator-hidden/);
    await expect.poll(() => sentTexts.length, { timeout: 30000 }).toBeGreaterThan(spent);
  } finally {
    await close();
  }
});

test('一轮里前面几块翻成了、后面崩了，这一页照样记进「本月自动翻译」', async ({ page, context }) => {
  // 设置页统计面板的第一格问的是「这个月自动翻了几页」。而一轮翻译的结局不止成
  // 和败两种：几批成了、另几批崩到了整体故障的门槛，页面上是真有译文摆着的。
  // 把这一页记成零，用户看到的就是「明明翻出来了，计数没动」—— 而他没有别的办
  // 法知道这一格到底在数什么，于是整块面板一起失去可信度。
  //
  // 这里刻意走询问条而不是 siteRules:always：always 的话第一轮只有 #para，干干
  // 净净地成功、当场记上一笔，后面崩不崩都不影响那个 1，这条测试就什么都没证。
  // 要崩的那几块必须和 #para **同在第一轮里**。
  //
  // 也刻意用 failWhen 而不是 failAfter：八个并发批次谁先到是赛跑，按次数挑的话
  // 有时崩的是 #para 那一批 —— 那一轮一个字都没翻成，本来就该记零。
  const MARK = 'Tide ledger';
  const { close, endpoint } = await startMockOpenAIServer({
    failWhen: (text) => text.includes(MARK)
  });
  const autoStatus = async () =>
    (await sendMessageToActiveTab(page, { type: 'AUTO_PAGE_STATE' })).auto.status;

  try {
    await serve(page, context, endpoint);
    const bar = page.locator('#ai-translator-auto-bar');
    await expect(bar).toBeVisible();

    // 四段各自超过 MAX_BLOCK_CHARS，于是各自成批，一批一次失败，攒够
    // MAX_BATCH_FAILURES（3）就是整体故障。排得紧一点是为了让它们全落进发现层
    // 那条带子里（content/content-auto-discover.js 的 BAND_MARGIN），不然要等
    // 用户滚过去才凑得齐三次。
    await page.evaluate((mark) => {
      const wrap = document.createElement('div');
      wrap.style.cssText = 'font-size:12px;line-height:1.2';
      for (let i = 0; i < 4; i += 1) {
        const p = document.createElement('p');
        p.style.margin = '0';
        p.textContent = `${mark} ${i}: `
          + 'The tide book records this departure and the return that followed it. '.repeat(60);
        wrap.appendChild(p);
      }
      document.getElementById('box').appendChild(wrap);
    }, MARK);

    await bar.locator('[data-act="translate"]').click();

    await expect.poll(autoStatus, { timeout: 30000 }).toBe('error');
    // 出错了，而 #para 的译文就在页面上 —— 这一页确实被自动翻过。少了这一条，
    // 下面那个 1 有可能来自一轮根本没翻成的空转。
    await expect(page.locator('#para + .ai-translator-inline-block')).toHaveCount(1);

    const worker = await getServiceWorker(context);
    await expect.poll(
      () => worker.evaluate(async () => (await chrome.storage.local.get('autoStats')).autoStats?.pages ?? 0),
      { timeout: 5000 }
    ).toBe(1);
  } finally {
    await close();
  }
});
