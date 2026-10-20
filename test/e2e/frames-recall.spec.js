// 子 frame 里的装回（页面重建节点时从记忆同步放回译文）跟顶层页面的自动判定走：
// 顶层「这个站点自动翻、且没被用户暂停」时挂，否则不挂。子 frame 没有自己的用户态
// —— 手动点「翻译整页」、按暂停都发生在顶层 —— 所以它挂不挂只能听顶层指令里的装回
// 量，外加它自己的两道闸（自己的主机被拒、frame 不够大）。
//
// 四条旅程（F1～F4）都在一个跨源 iframe 里的菜单上量：菜单由页面自己的 renderNav()
// 整片重建，文字一个字不变，节点全是新的。
//
//   F1 手动页：站点没开自动（DEFAULT_OFF），用户点悬浮球翻完，iframe 菜单重建 ——
//      不从记忆装回。判据：重建后的第一帧里没有我们的译文节点（rAF 逐帧计数）。
//      装回是同步的（MutationObserver 的回调在第一帧 rAF 之前跑完），挂着的话第一
//      帧就是满的；不挂的话第一帧一条都没有。之后那段时间页面会不会再由逐块发现
//      补上译文，不是这条判据的事，不断言。
//   F2 自动站点：站点规则 always，自动翻完，重建 —— 全部装回，没有一帧缺译文，
//      请求 +0。
//   F3 手动转自动：F1 的手动页翻完后，用户在 popup 打开「总是翻译这个站点」，
//      重建 —— 全部装回，请求 +0。
//   F4 顶层暂停：自动站点翻完，用户在 popup 按暂停，重建 —— 没有一帧有译文，
//      请求 +0。
//
// 夹具只隔离一个子步骤并在用到处标注：iframe 菜单的重建由测试调用页面自己的
// renderNav()（模拟页面脚本重绘），其余每一步都是用户的真实点击。请求数看 mock AI
// 服务收到的原文条数（子 frame 的引擎请求也经顶层发出，都落在同一个 mock 上）。
const { test, expect } = require('./fixtures');
const {
  evaluateInContentScript,
  openPopupOver,
  setExtensionSettings,
  waitForFloatBall,
} = require('./helpers');
const { clickBall, waitForPageRoundEnd } = require('./float-ball-helpers');
const { startMockOpenAIServer } = require('./mock-openai-server');

const TOP = 'https://frames.test';
const EMBED = 'https://embed.test';
const TOP_URL = `${TOP}/menu-page`;
const MENU_URL = `${EMBED}/menu`;

const TOP_LEAD = 'The ferry leaves the northern pier every morning at a quarter past six.';
const NAV = [
  'Timetables for the island crossings and the night boat.',
  'Fares, season tickets and the discount for cyclists.',
  'Where to wait when the harbour office is closed.',
  'Luggage limits on the small passenger launches.',
  'Lost property and how to reach the duty officer.',
];

const TRANSLATION = '.ai-translator-inline-block';
const NAV_TRANSLATIONS = `#nav ${TRANSLATION}`;

const html = (body) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Harbour ferries</title>
<style>body{margin:0}#nav a{display:block;padding:6px 0}</style></head>
<body>${body}</body></html>`;

// iframe 给足尺寸，菜单五项全在视口里：尺寸闸和视口都不该是这里装不装回的原因。
const PAGES = {
  [TOP_URL]: html(`
    <p id="top-lead">${TOP_LEAD}</p>
    <iframe id="menu" src="${MENU_URL}" width="640" height="420" style="border:0;display:block"></iframe>`),
  [MENU_URL]: html(`<div id="nav"></div>
<script>
const NAV = ${JSON.stringify(NAV)};
window.renderNav = () => {
  document.getElementById('nav').innerHTML = NAV.map((text) => '<a href="#">' + text + '</a>').join('');
};
window.renderNav();
</script>`),
};

async function serve(context) {
  for (const origin of [TOP, EMBED]) {
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

const autoState = (context, pageOrFrame) => evaluateInContentScript(context, pageOrFrame,
  'window.AI_TRANSLATOR_CONTENT.autoTranslate.state()');

const menuFrame = (page) => page.frame({ url: MENU_URL });

/**
 * 夹具：页面脚本整片重建 iframe 菜单（同文本、新节点），重建的同一刻起在 iframe
 * 主世界的 rAF 上逐帧数译文节点，数满 ms 毫秒。返回每一帧的译文节点数（frames，
 * 第 0 个就是重建后画出来的第一帧），以及第一帧里页面自己的菜单项文字
 * （firstOriginals：不在我们译文节点里的 <a>）。块级 <a> 的译文是紧跟着它的兄弟
 * <a>，所以「原文画出来了」只能在同一帧里量：晚一点去读 #nav a，逐块发现补上的
 * 译文也会被数进去。
 */
function rebuildAndCountFrames(frame, ms) {
  return frame.evaluate(({ selector, ours, ms: span }) => new Promise((resolve) => {
    const frames = [];
    let firstOriginals = null;
    window.renderNav();
    const end = performance.now() + span;
    const tick = () => {
      frames.push(document.querySelectorAll(selector).length);
      if (firstOriginals === null) {
        firstOriginals = [...document.querySelectorAll('#nav a')]
          .filter((a) => !a.closest(ours))
          .map((a) => a.textContent);
      }
      if (performance.now() < end) requestAnimationFrame(tick);
      else resolve({ frames, firstOriginals });
    };
    requestAnimationFrame(tick);
  }), { selector: NAV_TRANSLATIONS, ours: TRANSLATION, ms });
}

/** 打开顶层页，等 iframe 菜单载入。 */
async function openMenuPage(page, context, endpoint, extra) {
  await setExtensionSettings(page, settings(endpoint, extra));
  await serve(context);
  await page.goto(TOP_URL);
  await waitForFloatBall(page);
  await expect(page.frameLocator('#menu').locator('#nav a')).toHaveCount(NAV.length);
  return menuFrame(page);
}

/** 手动页：站点自动关着，用户点悬浮球翻这一页，等这一轮（连同 iframe 菜单）翻完。 */
async function translateByHand(page, context, endpoint) {
  const frame = await openMenuPage(page, context, endpoint);
  // 站点没设规则：顶层的自动判定是 DEFAULT_OFF。
  await expect.poll(async () => (await autoState(context, page)).reason, { timeout: 10000 }).toBe('DEFAULT_OFF');
  await clickBall(page);
  await waitForPageRoundEnd(page);
  await expect(page.frameLocator('#menu').locator(NAV_TRANSLATIONS)).toHaveCount(NAV.length, { timeout: 30000 });
  // 顶层的自动判定仍不是站点自动：手动那一下不算进装回的依据。
  expect((await autoState(context, page)).siteAuto).toBe(false);
  return frame;
}

/** 自动站点：规则写在顶层主机上，不点任何东西，等 iframe 菜单自己翻好。 */
async function translateAutomatically(page, context, endpoint) {
  const frame = await openMenuPage(page, context, endpoint, { siteRules: { 'frames.test': 'always' } });
  await expect(page.frameLocator('#menu').locator(NAV_TRANSLATIONS)).toHaveCount(NAV.length, { timeout: 30000 });
  expect((await autoState(context, page)).siteAuto).toBe(true);
  return frame;
}

// ------------------------------------------------------------------ F1

test('F1: on a page translated by hand, a rebuilt iframe menu is not recalled from memory', async ({ page, context }) => {
  const mock = await startMockOpenAIServer();
  try {
    const frame = await translateByHand(page, context, mock.endpoint);
    await page.waitForTimeout(1500);

    const { frames, firstOriginals } = await rebuildAndCountFrames(frame, 300);
    // 探针真的在逐帧跑，重建的菜单也真画出来了（第一帧里是五条原文，不是空白）。
    expect(frames.length).toBeGreaterThan(3);
    expect(firstOriginals).toEqual(NAV);
    // 判据：重建后的第一帧没有我们的译文 —— 不是从记忆同步装回的。
    expect(frames[0]).toBe(0);
    // 子 frame 也不认为这是自动站点。
    expect((await autoState(context, frame)).siteAuto).toBe(false);
  } finally {
    await mock.close();
  }
});

// ------------------------------------------------------------------ F2

test('F2: on an "always" site, a rebuilt iframe menu is recalled whole in every frame, unsent', async ({ page, context }) => {
  const mock = await startMockOpenAIServer();
  try {
    const frame = await translateAutomatically(page, context, mock.endpoint);
    await page.waitForTimeout(1500);
    const before = mock.sentTexts.length;

    const { frames } = await rebuildAndCountFrames(frame, 1500);
    expect(frames.length).toBeGreaterThan(10);
    expect(frames.filter((count) => count < NAV.length)).toEqual([]);
    await page.waitForTimeout(1500);
    await expect(page.frameLocator('#menu').locator(NAV_TRANSLATIONS)).toHaveCount(NAV.length);
    expect(mock.sentTexts.length).toBe(before);
  } finally {
    await mock.close();
  }
});

// ------------------------------------------------------------------ F3

test('F3: after "always translate this site" on a hand-translated page, a rebuilt iframe menu is recalled, unsent', async ({ page, context, extensionId }) => {
  const mock = await startMockOpenAIServer();
  try {
    const frame = await translateByHand(page, context, mock.endpoint);
    await page.waitForTimeout(1500);

    // 用户在 popup 上打开「总是翻译这个站点」。
    const popup = await openPopupOver(context, extensionId, page);
    await expect(popup.locator('#toggleSiteAuto')).toBeVisible();
    await expect(popup.locator('#toggleSiteAuto')).toHaveAttribute('aria-pressed', 'false');
    await popup.locator('#toggleSiteAuto').click();
    await expect(popup.locator('#toggleSiteAuto')).toHaveAttribute('aria-pressed', 'true');
    await page.bringToFront();
    await expect.poll(async () => (await autoState(context, page)).siteAuto, { timeout: 10000 }).toBe(true);
    await expect.poll(async () => (await autoState(context, frame)).siteAuto, { timeout: 10000 }).toBe(true);
    await page.waitForTimeout(1500);
    await expect(page.frameLocator('#menu').locator(NAV_TRANSLATIONS)).toHaveCount(NAV.length);
    const before = mock.sentTexts.length;

    const { frames } = await rebuildAndCountFrames(frame, 1500);
    expect(frames.length).toBeGreaterThan(10);
    expect(frames.filter((count) => count < NAV.length)).toEqual([]);
    await page.waitForTimeout(1500);
    expect(mock.sentTexts.length).toBe(before);
  } finally {
    await mock.close();
  }
});

// ------------------------------------------------------------------ F4

test('F4: with the top page paused, a rebuilt iframe menu gets no translations and nothing is sent', async ({ page, context, extensionId }) => {
  const mock = await startMockOpenAIServer();
  try {
    const frame = await translateAutomatically(page, context, mock.endpoint);
    await page.waitForTimeout(1500);

    // 用户在 popup 上按「暂停」。
    const popup = await openPopupOver(context, extensionId, page);
    await expect(popup.locator('#togglePagePause')).toBeVisible();
    await popup.locator('#togglePagePause').click();
    await expect.poll(async () => (await autoState(context, page)).status, { timeout: 10000 }).toBe('paused');
    await page.bringToFront();
    // 指令到了子 frame：它不再跟着翻。
    await expect.poll(async () => (await autoState(context, frame)).status, { timeout: 10000 }).toBe('off');
    await page.waitForTimeout(1500);
    const before = mock.sentTexts.length;

    const { frames } = await rebuildAndCountFrames(frame, 1500);
    expect(frames.length).toBeGreaterThan(10);
    expect(frames.filter((count) => count > 0)).toEqual([]);
    await page.waitForTimeout(1500);
    await expect(page.frameLocator('#menu').locator(NAV_TRANSLATIONS)).toHaveCount(0);
    await expect(page.frameLocator('#menu').locator('#nav a')).toHaveText(NAV);
    expect(mock.sentTexts.length).toBe(before);
    expect((await autoState(context, page)).status).toBe('paused');
  } finally {
    await mock.close();
  }
});
