// 整页翻译进 iframe（manifest 的 all_frames）的四条旅程，对应设计文档
// docs/plans/2026-09-24-p1-a-page-coverage.md §4 的 J-1～J-4。
//
// 页面全部由 context.route 供给，三个来源：
//
//   https://frames.test          顶层文章页（和它同源的 iframe）
//   https://embed.test           跨源的内容 iframe（评论区一类）
//   https://ad.doubleclick.net   假广告位：同样是英文段落，同样够大 —— 它不被翻
//                                的理由只能是进门资格（shared/frame-eligibility.js）
//
// 断言同时看 DOM 和 sentTexts：DOM 证明「画出来了 / 没画」，sentTexts 证明「送
// 出去了 / 没送」—— 广告 frame 的文字一旦发给模型，钱和隐私都已经花出去了，DOM
// 上干不干净不能说明这一点。
const { test, expect } = require('./fixtures');
const {
  setExtensionSettings,
  getServiceWorker,
  sendMessageToActiveTab,
  waitForFloatBall,
} = require('./helpers');
const { startMockOpenAIServer } = require('./mock-openai-server');

const TOP = 'https://frames.test';
const EMBED = 'https://embed.test';
const AD = 'https://ad.doubleclick.net';

const TOP_LEAD = 'The ferry leaves the northern pier every morning at a quarter past six.';
const INNER_LEAD = 'Readers who arrived late can find the full timetable pinned inside the waiting room.';
const EMBED_LEAD = 'I took the afternoon crossing last week and the sea was perfectly calm the whole way.';
const LATE_LEAD = 'A second comment appeared later, asking whether bicycles are allowed on the morning boat.';
const AD_LEAD = 'Book your seaside holiday today and save forty percent on every cabin upgrade this summer.';

const TRANSLATED = '.ai-translator-inline-block';
// 我们往页面里放的任何东西：译文节点、包装、标记类、悬浮球、进度条。
const ANY_OF_OURS = '[class*="ai-translator"], [id^="ai-translator"]';

const html = (body) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Harbour notes</title></head>
<body>${body}</body></html>`;

// 内容 frame 都给足尺寸：尺寸闸（content/frames/shelf.js，120×40）不该是这里任何
// 一个 frame 翻或不翻的原因。
const FRAME_ATTRS = 'width="640" height="220" style="border:0;display:block"';

const PAGES = {
  [`${TOP}/same-origin`]: html(`
    <p id="top-lead">${TOP_LEAD}</p>
    <iframe id="inner" src="${TOP}/inner" ${FRAME_ATTRS}></iframe>`),
  [`${TOP}/inner`]: html(`<p id="inner-lead">${INNER_LEAD}</p>`),
  [`${TOP}/cross-origin`]: html(`
    <p id="top-lead">${TOP_LEAD}</p>
    <iframe id="embed" src="${EMBED}/comments" ${FRAME_ATTRS}></iframe>
    <iframe id="ad" src="${AD}/slot" width="300" height="250" style="border:0;display:block"></iframe>`),
  [`${TOP}/auto`]: html(`
    <p id="top-lead">${TOP_LEAD}</p>
    <iframe id="embed" src="${EMBED}/comments" ${FRAME_ATTRS}></iframe>
    <div id="late-slot"></div>`),
  [`${EMBED}/comments`]: html(`<p id="embed-lead">${EMBED_LEAD}</p>`),
  [`${EMBED}/late`]: html(`<p id="late-lead">${LATE_LEAD}</p>`),
  [`${AD}/slot`]: html(`<p id="ad-lead">${AD_LEAD}</p>`),
};

async function serve(context) {
  for (const origin of [TOP, EMBED, AD]) {
    await context.route(`${origin}/**`, (route) => {
      const body = PAGES[route.request().url().split(/[?#]/)[0]];
      if (!body) return route.fulfill({ status: 404, body: 'not found' });
      return route.fulfill({ status: 200, contentType: 'text/html', body });
    });
  }
}

function settings(endpoint, extra) {
  return {
    apiEndpoint: endpoint,
    apiKey: 'test-key',
    modelName: 'gpt-4.1-mini',
    targetLang: 'zh-CN',
    skipTargetLanguageText: false,
    ...extra,
  };
}

/** 点球本身：单击球是「翻译 / 还原」（菜单在球上那颗 ···）。 */
async function clickFloatBall(page) {
  await waitForFloatBall(page);
  await page.click('#ai-translator-float-ball', { position: { x: 18, y: 18 } });
}

/**
 * Alt+A 的那一下，从服务工作者发出 —— 与 background/background.js 的快捷键处理
 * 同一条消息、同一个 frameId。
 *
 * 夹具隔离子步骤：chrome.commands 的快捷键在无头 Chromium 里按不出来（键盘事件
 * 到不了浏览器的快捷键层），所以这一步只替换「按键 → 服务工作者」这一跳；
 * 服务工作者之后的每一步（发给顶层、顶层广播指令、子 frame 跟着藏）都是生产路径。
 */
async function pressToggleShortcut(page) {
  const worker = await getServiceWorker(page.context());
  return worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_PAGE_TRANSLATION' }, { frameId: 0 });
  });
}

// 帧协议和 shadow 样式里「接住、打一条日志、继续」的五处（background/frame-relay.js、
// content/frames/shelf.js、content/page/shadow.js）。它们只该在真出故障时开口：
// J-1～J-4 正常跑完，一条都不许有。context 的 console 事件同时收服务工作者、顶层
// 和跨源子 frame 的内容脚本（隔离世界）——收得到这件事本身由下面的「console
// capture」用例正面对照，否则「零条」可能只是没在听。
const SWALLOWED = [
  'Blab Translation: frame relay message failed',
  'Blab Translation: frame relay to top failed',
  'Blab Translation: frame directive broadcast failed',
  'Blab Translation: loading shadow styles failed',
  'Blab Translation: installing shadow styles failed',
];

function watchSwallowedErrors(context) {
  const watch = { ours: 0, hits: [] };
  context.on('console', (msg) => {
    const text = msg.text();
    if (!text.startsWith('Blab Translation:')) return;
    watch.ours += 1;
    if (SWALLOWED.some((prefix) => text.startsWith(prefix))) {
      watch.hits.push(text);
    }
  });
  return watch;
}

function expectNoSwallowedErrors(watch, title) {
  // 证据行：交付报告引用的就是这一行（int-frames-nolog.log）。
  console.log(`[no-log] ${title}: ${watch.ours} extension console lines captured, ${watch.hits.length} swallowed-error lines`);
  expect(watch.hits).toEqual([]);
  // 这一程确实听到了扩展自己的日志：零条不是因为没接上。
  expect(watch.ours).toBeGreaterThan(0);
}

// ------------------------------------------------------------------ J-1

test('J-1: the float ball translates a same-origin iframe too, and Alt+A hides and shows both', async ({ page, context }) => {
  const watch = watchSwallowedErrors(context);
  const { close, endpoint, sentTexts } = await startMockOpenAIServer();
  try {
    await setExtensionSettings(page, settings(endpoint));
    await serve(context);

    await page.goto(`${TOP}/same-origin`);
    const inner = page.frameLocator('#inner');
    await expect(inner.locator('#inner-lead')).toBeVisible();

    await clickFloatBall(page);

    // 两边都出现译文。
    const topTranslation = page.locator(TRANSLATED).first();
    const innerTranslation = inner.locator(TRANSLATED).first();
    await expect(topTranslation).toContainText(TOP_LEAD, { timeout: 30000 });
    await expect(innerTranslation).toContainText(INNER_LEAD, { timeout: 30000 });
    expect(sentTexts.join('\n')).toContain(INNER_LEAD);

    // Alt+A：两边的译文都收起来，原文都还在。
    await pressToggleShortcut(page);
    await expect(topTranslation).toBeHidden();
    await expect(innerTranslation).toBeHidden({ timeout: 10000 });
    await expect(page.locator('#top-lead')).toBeVisible();
    await expect(inner.locator('#inner-lead')).toBeVisible();

    // 再按一次：两边都回来。
    await pressToggleShortcut(page);
    await expect(topTranslation).toBeVisible();
    await expect(innerTranslation).toBeVisible({ timeout: 10000 });
    await expect(innerTranslation).toContainText(INNER_LEAD);
    expectNoSwallowedErrors(watch, 'J-1');
  } finally {
    await close();
  }
});

// ------------------------------------------------------------------ J-2

test('J-2: a cross-origin content iframe is translated, an ad frame beside it is not touched', async ({ page, context }) => {
  const watch = watchSwallowedErrors(context);
  const { close, endpoint, sentTexts } = await startMockOpenAIServer();
  try {
    await setExtensionSettings(page, settings(endpoint));
    await serve(context);

    await page.goto(`${TOP}/cross-origin`);
    const embed = page.frameLocator('#embed');
    const ad = page.frameLocator('#ad');
    // 广告 frame 确实载入了、确实有同样是外文的段落 —— 下面的「零」才有意义。
    await expect(ad.locator('#ad-lead')).toHaveText(AD_LEAD);
    await expect(embed.locator('#embed-lead')).toBeVisible();

    await clickFloatBall(page);

    await expect(embed.locator(TRANSLATED).first()).toContainText(EMBED_LEAD, { timeout: 30000 });
    await expect(page.locator(TRANSLATED).first()).toContainText(TOP_LEAD, { timeout: 30000 });

    // 内容 frame 已经翻完，广告 frame 若会被翻，此刻也早该有动静了。
    await expect(ad.locator(ANY_OF_OURS)).toHaveCount(0);
    expect(sentTexts.join('\n')).not.toContain(AD_LEAD);
    expect(sentTexts.join('\n')).toContain(EMBED_LEAD);
    expectNoSwallowedErrors(watch, 'J-2');
  } finally {
    await close();
  }
});

// ------------------------------------------------------------------ J-3

test('J-3: on an "always" site the iframes translate themselves, including one inserted later', async ({ page, context }) => {
  const watch = watchSwallowedErrors(context);
  const { close, endpoint, sentTexts } = await startMockOpenAIServer();
  try {
    // 规则写在顶层的主机上。embed.test 自己没有任何规则 —— 它翻，是因为它跟着顶层。
    await setExtensionSettings(page, settings(endpoint, { siteRules: { 'frames.test': 'always' } }));
    await serve(context);

    await page.goto(`${TOP}/auto`);
    await waitForFloatBall(page);

    // 没有任何点击。
    await expect(page.locator(TRANSLATED).first()).toContainText(TOP_LEAD, { timeout: 30000 });
    await expect(page.frameLocator('#embed').locator(TRANSLATED).first()).toContainText(EMBED_LEAD, { timeout: 30000 });

    // 页面之后才插进来的 iframe（评论区懒加载一类）。
    await page.evaluate((src) => {
      const frame = document.createElement('iframe');
      frame.id = 'late';
      frame.src = src;
      frame.width = '640';
      frame.height = '220';
      frame.style.border = '0';
      document.getElementById('late-slot').appendChild(frame);
    }, `${EMBED}/late`);

    const late = page.frameLocator('#late');
    await expect(late.locator('#late-lead')).toBeVisible();
    await expect(late.locator(TRANSLATED).first()).toContainText(LATE_LEAD, { timeout: 30000 });
    expect(sentTexts.join('\n')).toContain(LATE_LEAD);
    expectNoSwallowedErrors(watch, 'J-3');
  } finally {
    await close();
  }
});

// ------------------------------------------------------------------ J-4

test('J-4: the popup and the page state it reads always describe the top page, never an iframe', async ({ page, context, extensionId }) => {
  const watch = watchSwallowedErrors(context);
  const { close, endpoint } = await startMockOpenAIServer();
  try {
    await setExtensionSettings(page, settings(endpoint));
    await serve(context);

    await page.goto(`${TOP}/cross-origin`);
    await clickFloatBall(page);
    // iframe 里出现译文 = 那个 frame 的内容脚本活着、登记过、收得到消息。没有这
    // 一步，下面「回话里是顶层」可能只是因为 iframe 还没人答。
    await expect(page.frameLocator('#embed').locator(TRANSLATED).first())
      .toContainText(EMBED_LEAD, { timeout: 30000 });

    // 不钉 frame 的问法（发给这一页的每个 frame，第一个回话的赢）问几次，答的
    // 都是顶层：子 frame 对这条消息不回话（content/frames/shelf.js 的 ignores）。
    for (let i = 0; i < 5; i++) {
      const reply = await sendMessageToActiveTab(page, { type: 'AUTO_PAGE_STATE' });
      expect(reply && reply.host).toBe('frames.test');
      expect(reply.hasTranslations).toBe(true);
    }

    // 上面那一步证明不了「子 frame 不答」：Chrome 按 frame 顺序投递，顶层总在
    // 前面，子 frame 就算答了也晚一步、被丢掉。所以再绕过顶层，直接对每个子
    // frame 单独问一次。测试没有 webNavigation 权限，拿不到子 frame 的 id，只能
    // 扫：每个用例是一个新浏览器，frameId 很小。三种结果：
    //   Receiving end does not exist → 那里没有我们的监听（不存在，或广告位沉睡）
    //   回话为 undefined             → 有我们的监听，但不答 —— 就是要证的这一条
    //   有回话                        → 必须仍是顶层（Chrome 把主 frame 自己的
    //                                    节点 id 也认作主 frame）
    const probes = await (await getServiceWorker(context)).evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      const ids = Array.from({ length: 999 }, (_, i) => i + 1);
      const out = await Promise.all(ids.map((frameId) => chrome.tabs
        .sendMessage(tab.id, { type: 'AUTO_PAGE_STATE' }, { frameId })
        .then((reply) => ({ frameId, host: reply ? reply.host : null }))
        .catch((error) => (/Receiving end does not exist/.test(error.message)
          ? null
          : { frameId, error: error.message }))));
      return out.filter(Boolean);
    });
    expect(probes.filter((p) => p.error)).toEqual([]);
    expect(probes.filter((p) => p.host !== null && p.host !== 'frames.test')).toEqual([]);
    // 至少有一个 frame 收到了、没答：那就是 embed.test 的内容脚本。
    expect(probes.filter((p) => p.host === null).length).toBeGreaterThanOrEqual(1);

    // 真的 popup：它画的站点行就是这份回话里的 host。
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
    // goto() 把 popup 的标签页推到了前面；把窗口还给文章页，popup 再问一次。
    await page.bringToFront();
    await popup.reload();
    const siteRow = popup.locator('#toggleSiteAuto');
    await expect(siteRow).toBeVisible();
    await expect(siteRow).toHaveAttribute('title', 'frames.test');
    expectNoSwallowedErrors(watch, 'J-4');
  } finally {
    await close();
  }
});

// ------------------------------------------------------------------ 取证

/**
 * 在一个 frame 的内容脚本隔离世界里求值。测试没有 scripting 权限，Playwright 的
 * evaluate 只到页面主世界，所以走 CDP：找这个 frame 里 origin 是扩展的那个隔离上下文。
 */
async function evaluateInContentScript(context, pageOrFrame, expression) {
  const session = await context.newCDPSession(pageOrFrame);
  const contexts = [];
  session.on('Runtime.executionContextCreated', (event) => contexts.push(event.context));
  await session.send('Runtime.enable');
  await expect.poll(() => contexts.some((c) => c.auxData && c.auxData.type === 'isolated'
    && String(c.origin).startsWith('chrome-extension://'))).toBe(true);
  const isolated = contexts.find((c) => c.auxData && c.auxData.type === 'isolated'
    && String(c.origin).startsWith('chrome-extension://'));
  const { result, exceptionDetails } = await session.send('Runtime.evaluate', {
    expression, contextId: isolated.id, awaitPromise: true, returnByValue: true,
  });
  await session.detach();
  if (exceptionDetails) throw new Error(`content-script evaluate failed: ${exceptionDetails.text}`);
  return result.value;
}

test('console capture: the no-log check hears the service worker and both frames\' content scripts', async ({ page, context }) => {
  // J-1～J-4 的「零条」的正面对照：同一个 watchSwallowedErrors，让那几句日志在
  // 三处（服务工作者、顶层内容脚本、跨源子 frame 的内容脚本）各出现一次，必须全
  // 部收到。这里证的是「听得到」，不是那几处代码路径本身——路径由
  // test/unit/frame-relay-errors.test.mjs 和 shadow-dom-errors.test.mjs 逐条覆盖。
  // （想过用 BigInt 字段让真的 sendToRelay 走日志分支：实测 sendMessage 的序列化
  // 错误是同步抛出的，越过 .catch 直接往上走，不进日志分支——这正是想要的「往上抛」。）
  const watch = watchSwallowedErrors(context);
  await serve(context);
  await page.goto(`${TOP}/cross-origin`);
  await waitForFloatBall(page);
  await expect(page.frameLocator('#embed').locator('#embed-lead')).toBeVisible();
  const embed = page.frames().find((frame) => frame.url().startsWith(EMBED));
  expect(embed, 'the cross-origin comment frame').toBeTruthy();

  const inContentScript = (line) => `typeof window.AI_TRANSLATOR_CONTENT === 'object'
    && (console.warn(${JSON.stringify(line)}, 'POSITIVE_CONTROL', location.origin), true)`;
  expect(await evaluateInContentScript(context, page, inContentScript(SWALLOWED[0]))).toBe(true);
  expect(await evaluateInContentScript(context, embed, inContentScript(SWALLOWED[3]))).toBe(true);

  const worker = await getServiceWorker(context);
  await worker.evaluate(() => console.warn('Blab Translation: frame relay to top failed', 'POSITIVE_CONTROL', self.location.protocol));

  await expect.poll(() => watch.hits.length).toBe(3);
  console.log(`[capture] ${JSON.stringify(watch.hits)}`);
  // 每一句最后一个参数是发出它的那个世界自己报的来处。
  expect([...watch.hits].sort()).toEqual([
    `${SWALLOWED[0]} POSITIVE_CONTROL ${TOP}`,
    `${SWALLOWED[1]} POSITIVE_CONTROL chrome-extension:`,
    `${SWALLOWED[3]} POSITIVE_CONTROL ${EMBED}`,
  ].sort());
});

test('relay semantics: what Chrome answers when nobody listens, and when a listener does not answer', async ({ page, context, extensionId }) => {
  // background/frame-relay.js 的 isNoReceiver 和 content/frames/shelf.js 的
  // sendToRelay 按这里量到的结果写：没人听 = reject（文字固定），有人听不答 =
  // resolve undefined。换了 Chromium 版本这条先红，两处跟着改。
  await serve(context);
  await page.goto(`${TOP}/same-origin`);
  await waitForFloatBall(page);
  const worker = await getServiceWorker(context);
  const measured = {};

  // 1. runtime.sendMessage，没有接收方：服务工作者发，此刻没有任何扩展页开着
  //    （服务工作者发的不回到自己的监听）。
  measured.runtimeNoReceiver = await worker.evaluate(() => chrome.runtime.sendMessage({ type: 'P1A_PROBE' })
    .then((value) => ({ resolved: value === undefined ? 'undefined' : value }), (error) => ({ rejected: error.message })));

  // 2. runtime.sendMessage，有监听但不答：扩展页发给服务工作者，这个 type 谁也不认。
  const extPage = await context.newPage();
  await extPage.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  measured.runtimeListenerSilent = await extPage.evaluate(() => chrome.runtime.sendMessage({ type: 'P1A_PROBE' })
    .then((value) => ({ resolved: value === undefined ? 'undefined' : value }), (error) => ({ rejected: error.message })));
  await extPage.close();

  // 3. tabs.sendMessage，有监听但不答：文章页的顶层内容脚本，同样不认这个 type。
  await page.bringToFront();
  measured.tabsListenerSilent = await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return chrome.tabs.sendMessage(tab.id, { type: 'P1A_PROBE' }, { frameId: 0 })
      .then((value) => ({ resolved: value === undefined ? 'undefined' : value }), (error) => ({ rejected: error.message }));
  });

  // 4. tabs.sendMessage，没有接收方：data: 页不注入内容脚本。
  const bare = await context.newPage();
  await bare.goto('data:text/html,<p>no content script here</p>');
  await bare.bringToFront();
  measured.tabsNoReceiver = await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return chrome.tabs.sendMessage(tab.id, { type: 'P1A_PROBE' })
      .then((value) => ({ resolved: value === undefined ? 'undefined' : value }), (error) => ({ rejected: error.message }));
  });
  await bare.close();

  console.log(`[measured] ${context.browser() ? context.browser().version() : 'persistent context'} ${JSON.stringify(measured, null, 2)}`);
  const NO_RECEIVER = 'Could not establish connection. Receiving end does not exist.';
  expect(measured).toEqual({
    runtimeNoReceiver: { rejected: NO_RECEIVER },
    runtimeListenerSilent: { resolved: 'undefined' },
    tabsListenerSilent: { resolved: 'undefined' },
    tabsNoReceiver: { rejected: NO_RECEIVER },
  });
});
