// 自动翻译触点 —— **键位相撞**：Alt+A 和划词、悬停共用同一下 Alt。
//
// 划词翻译和悬停翻译的键位都可以设成 Alt，于是「按住 Alt 再去够 A」这一下，在用
// 户眼里是一个动作，在页面里却是三条路同时醒过来。这一组问的就是这个：整页翻译
// 该触发，划过的那句和停在的那段不该跟着译，长按开了菜单松手那一下也不该再翻一
// 遍。末了还有一条不是键位的：他按下的暂停，别的标签页改规则也顶不开。
//
// 问与开关在 auto-translate-touchpoints.spec.js，藏起译文那条路在
// auto-translate-hidden.spec.js，夹具在 auto-touchpoint-fixtures.js。
const { test, expect } = require('./fixtures');
const { getServiceWorker, sendMessageToActiveTab } = require('./helpers');
const { startMockOpenAIServer } = require('./mock-openai-server');
const { serve } = require('./auto-touchpoint-fixtures');

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

test('悬停键位是 Alt 时，光标停在段落上按住 Alt，不会抢在 A 之前先译一段', async ({ page, context }) => {
  // Alt+A 是「先按住 Alt，再去够 A」。手慢一点，中间那段空当就超过了按住档的
  // 220ms —— 旧的样子是当场替他译了光标底下那一段，A 随后照样把整页翻了。补跑
  // 的和弦收得回「按住了」这个状态，收不回已经发出去的那次请求：这套机制本来
  // 要挡的那笔重复账单，从按住档漏了回来。
  //
  // 所以命令键位占着的修饰键不开按住档（见 content-utils.js 的 commandModifiers）。
  // 断言落在 sentTexts 上，是因为漏掉的那一次在页面上只是多出一段译文，看着
  // 像是功能正常——只有账单知道。
  const { close, endpoint, sentTexts } = await startMockOpenAIServer();

  try {
    await serve(page, context, endpoint, {
      siteRules: { 'ask.test': 'never' },
      enableHoverTranslation: true,
      hoverTranslationHotkey: 'Alt'
    });

    // 光标先停在段落上再按住 Alt：这一按没有鼠标移动可依，走的正是按住档那条路。
    await page.locator('#para').hover();
    await page.keyboard.down('Alt');
    await page.waitForTimeout(800);
    expect(sentTexts).toHaveLength(0);
    await expect(page.locator('.ai-translator-hover-translation')).toHaveCount(0);

    // Alt 还按着，这才按下 A。松手也不该补译一次 —— 那一下已经是和弦的一半了。
    await page.keyboard.press('a');
    await page.keyboard.up('Alt');
    await page.waitForTimeout(800);
    expect(sentTexts).toHaveLength(0);

    // 而这是让它闭嘴，不是让它失灵：同一个手势，松开手就译。命令键位走不到松
    // 开那一步（A 一下去就作废了），真的只按了 Alt 的人一下都不少。
    await page.locator('#para').hover();
    await page.keyboard.down('Alt');
    await page.keyboard.up('Alt');
    await page.waitForSelector('.ai-translator-hover-translation', { state: 'attached' });
    await expect.poll(() => sentTexts.length, { timeout: 10000 }).toBe(1);
  } finally {
    await close();
  }
});

test('按着 Alt 划了一段，再去够 A —— 后面划过的段落不该跟着译', async ({ page, context }) => {
  // 和弦不一定按得快。用户按着 Alt 先划过了一段，悬停当场就译了（走的是
  // mouseover，跟按住档无关）；他这才去够 A。译出来的那一段留着 —— 请求已经付
  // 过了，当场撤掉只会更怪 —— 但从那一下起 Alt 就是和弦的一半，后面划过的段落
  // 一段都不该再译。少了这道补刀，松手之前划过多少段就是多少次请求。
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

    await page.mouse.move(5, 5);
    await page.keyboard.down('Alt');
    await page.locator('#para').hover();
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
    await page.mouse.move(5, 5);
    await page.keyboard.down('Alt');
    await page.locator('#para2').hover();
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

    // 松开之后重新来一次，这一下是干干净净的悬停翻译。先把光标挪开再按住：
    // 命令键位占着的修饰键没有按住档（Alt+A 的那半秒不该先译一段），悬停走的
    // 是按住之后划过去的那条路。
    await page.mouse.move(5, 5);
    await page.keyboard.down('Alt');
    await page.locator('#para').hover();
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
