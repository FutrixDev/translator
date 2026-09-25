// 用户站点规则（P1-B）B1 的整扩展旅程：J-2、J-3、J-4（第 1、3 步）、J-8、J-9、J-10。
//
// 夹具隔离子步骤：写规则这一步 B2 改走真实入口。B1 还没有写规则的界面（设置页卡片、
// 悬浮球「不翻译此区域」都在 B2），所以规则由服务工作者直接写进 chrome.storage.sync
// —— 与 B2 的界面最终写下的是同一个键、同一个形状（`customRule:<id>`）。写下之后的
// 每一步（SW 镜像、CUSTOM_RULES_FOR_HOST、bootstrap 转发增量、custom-rule.js 的流水
// 线、收块、引擎）都是生产路径。所以每条标题都带 `[fixture]`。
//
// 页面全部由 context.route 供给，翻译走 mock-openai-server（回 `[T] 原文`）：
//   - 「翻了」= 原位出现以 `[T] ` 开头的译文节点；
//   - 「没翻」= 那一片零 ai-translator 节点，**并且**原文不在 sentTexts 里；
//   - 「1 s 内」= 从写入 / 删除规则那一刻（调用服务工作者之前取 t0）起 1000 ms 内
//     断言成立，中间不刷新页面。每一处都打一行 `[1s] <步骤>: <毫秒>` 作证据。
const { test, expect } = require('./fixtures');
const {
  setExtensionSettings,
  writeSyncSettings,
  getServiceWorker,
  openFloatBallMenu,
  triggerPageTranslation,
  waitForFloatBall,
} = require('./helpers');
const { startMockOpenAIServer } = require('./mock-openai-server');

const SECOND = 1000;
const TRANSLATED = '.ai-translator-inline-block';
const ANY_OURS = '[class*="ai-translator-"]';

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

const html = (body) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Rules fixture</title></head>
<body>${body}</body></html>`;

async function serve(context, pages) {
  const origins = new Set(Object.keys(pages).map((url) => new URL(url).origin));
  for (const origin of origins) {
    await context.route(`${origin}/**`, (route) => {
      const body = pages[route.request().url().split(/[?#]/)[0]];
      if (!body) return route.fulfill({ status: 404, body: 'not found' });
      return route.fulfill({ status: 200, contentType: 'text/html', body });
    });
  }
}

function rule(match, fields) {
  return { v: 1, match, ...fields, updatedAt: Date.now() };
}

/** 服务工作者写一条规则（夹具隔离子步骤）。 */
async function writeRule(context, id, value) {
  await writeSyncSettings(context, { [`customRule:${id}`]: value });
}

/** 服务工作者删规则。helpers.js 没有「删 sync 键」的助手，就地写在这里。 */
async function removeRules(context, ids) {
  const worker = await getServiceWorker(context);
  await worker.evaluate((keys) => new Promise((resolve) => {
    chrome.storage.sync.remove(keys, resolve);
  }), ids.map((id) => `customRule:${id}`));
}

/** 两半缓存一起清：SW 删 L2 的 tc: 键并写 epoch，每个标签页跟着丢自己的 L1。 */
async function clearTranslationCache(context) {
  const worker = await getServiceWorker(context);
  await worker.evaluate(() => globalThis.TranslationCache.clear());
}

const sent = (sentTexts, text) => sentTexts.some((chunk) => chunk.includes(text));
const sendCount = (sentTexts, text) =>
  sentTexts.reduce((sum, chunk) => sum + chunk.split(text).length - 1, 0);

/**
 * 从 t0 起 1000 ms 内 check() 为真；不刷新页面。打印实际用时作证据。
 * @param {number} t0 写入 / 删除之前取的 Date.now()
 * @param {() => Promise<boolean>} check
 * @param {string} label
 */
async function withinOneSecond(t0, check, label) {
  for (;;) {
    if (await check()) break;
    if (Date.now() - t0 >= SECOND) throw new Error(`${label}: not true within ${SECOND} ms`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const elapsed = Date.now() - t0;
  console.log(`[1s] ${label}: ${elapsed} ms`);
  expect(elapsed).toBeLessThan(SECOND);
}

// 段落的译文是紧随其后的兄弟；列表项的译文在条目里面。
const translationOf = (id) => `#${id} + ${TRANSLATED}, #${id} > ${TRANSLATED}`;

/** frame（或页面）里 id 这一块现在有没有 `[T] ` 开头的译文。 */
function isTranslated(target, id) {
  return target.evaluate((selector) => {
    const node = document.querySelector(selector);
    return Boolean(node && node.textContent.startsWith('[T] '));
  }, translationOf(id));
}

/** 容器里（含它自己）有没有任何我们的节点。 */
function oursIn(target, containerId) {
  return target.evaluate(([id, any]) => {
    const box = document.getElementById(id);
    return box.matches(any) ? 1 + box.querySelectorAll(any).length : box.querySelectorAll(any).length;
  }, [containerId, ANY_OURS]);
}

// ------------------------------------------------------------------ J-2

const RULES = 'https://rules.test';
const J2 = {
  plain: 'The kettle boils water in under three minutes and switches itself off afterwards.',
  brandLead: 'Our',
  brandTail: 'kettle comes with a two year warranty and a spare filter in the box.',
  codeName: 'Project Lighthouse release candidate seven for the northern region',
  reopened: 'This reopened paragraph explains what the release candidate changes for readers.',
};

const J2_PAGE = html(`
  <div id="plain-box"><p id="plain">${J2.plain}</p></div>
  <div id="brand-box"><p id="brand">${J2.brandLead} <span class="brand">BrandX</span> ${J2.brandTail}</p></div>
  <div translate="no">
    <div id="code-box"><p id="code" class="code-name" translate="yes">${J2.codeName}</p></div>
    <div id="reopen-box"><p id="reopen" translate="yes">${J2.reopened}</p></div>
  </div>`);

test('[fixture] J-2: keepOriginal keeps an inline brand verbatim inside the translation and a whole block untouched', async ({ page, context }) => {
  const { close, endpoint, sentTexts } = await startMockOpenAIServer();
  try {
    await setExtensionSettings(page, settings(endpoint));
    await writeRule(context, 'j2keep', rule(['rules.test'], { keepOriginal: ['.brand', '.code-name'] }));
    await serve(context, { [`${RULES}/kettle`]: J2_PAGE });
    await page.goto(`${RULES}/kettle`);
    await waitForFloatBall(page);

    await triggerPageTranslation(page);
    await expect(page.locator(translationOf('plain'))).toHaveText(`[T] ${J2.plain}`, { timeout: 30000 });
    // 对照：同一个 translate="no" 容器里被 translate="yes" 重新打开、但不带规则类的
    // 那一段照样翻 —— `.code-name` 没翻只能是规则的缘故。
    await expect(page.locator(translationOf('reopen'))).toHaveText(`[T] ${J2.reopened}`, { timeout: 30000 });

    // 行内 keepOriginal：段落翻了，BrandX 原样出现在译文里，名字本身没发出去。
    const brand = page.locator(translationOf('brand'));
    await expect(brand).toContainText('[T]', { timeout: 30000 });
    await expect(brand).toContainText(J2.brandTail);
    await expect(brand.locator('span.brand')).toHaveText('BrandX');
    expect(sent(sentTexts, J2.brandTail)).toBe(true);
    expect(sent(sentTexts, 'BrandX')).toBe(false);

    // 块级 keepOriginal：零我们的节点，原文不在 sentTexts 里。
    expect(await oursIn(page, 'code-box')).toBe(0);
    expect(sent(sentTexts, J2.codeName)).toBe(false);
  } finally {
    await close();
  }
});

// ------------------------------------------------------------------ J-3

const J3 = {
  nav: 'World news and politics section of the gazette',
  main1: 'The first crossing of the season left the northern pier at a quarter past six this morning.',
  main2: 'Crews spent most of the winter repairing the landing stage after the January storms.',
  faqQ: 'How early should passengers arrive before the ferry departs from the pier?',
  faqA: 'Please arrive at least twenty minutes early so the crew can load bicycles first.',
  aside: 'The most read stories of the week are collected in this sidebar panel.',
};

const J3_PAGE = html(`
  <nav id="site-nav"><ul><li id="nav1">${J3.nav}</li></ul></nav>
  <main id="main"><article><p id="main1">${J3.main1}</p><p id="main2">${J3.main2}</p></article></main>
  <aside id="sidebar">
    <div class="faq" id="faq"><p id="faq-q">${J3.faqQ}</p><p id="faq-a">${J3.faqA}</p></div>
    <p id="aside-p">${J3.aside}</p>
  </aside>`);

test('[fixture] J-3: include narrows even a whole-page setting to the FAQ, and "Translate Whole Page" widens it again', async ({ page, context }) => {
  const { close, endpoint, sentTexts } = await startMockOpenAIServer();
  try {
    await setExtensionSettings(page, settings(endpoint, { pageTranslateScope: 'page' }));
    await writeRule(context, 'j3faq', rule(['rules.test/help'], { include: ['.faq'] }));
    await serve(context, { [`${RULES}/help`]: J3_PAGE });
    await page.goto(`${RULES}/help`);
    await waitForFloatBall(page);

    // 1. 只有 .faq 翻了：导航、正文、侧栏其余部分零节点、零发送。
    await triggerPageTranslation(page);
    await expect(page.locator(translationOf('faq-q'))).toHaveText(`[T] ${J3.faqQ}`, { timeout: 30000 });
    await expect(page.locator(translationOf('faq-a'))).toHaveText(`[T] ${J3.faqA}`, { timeout: 30000 });
    await page.waitForTimeout(1500);
    expect(await oursIn(page, 'site-nav')).toBe(0);
    expect(await oursIn(page, 'main')).toBe(0);
    await expect(page.locator(translationOf('aside-p'))).toHaveCount(0);
    for (const text of [J3.nav, J3.main1, J3.main2, J3.aside]) {
      expect(sent(sentTexts, text), `sent: ${text}`).toBe(false);
    }

    // 2. 设置是 'page'，但规则把范围收到了 include：菜单里有「翻译整个页面」，
    //    它在菜单盒子里，菜单在视口里。
    await openFloatBallMenu(page);
    const item = page.locator('.ai-translator-menu-item[data-action="translate-whole-page"]');
    await expect(item).toBeVisible();
    await expect(item).toContainText('Translate Whole Page');
    const itemBox = await item.boundingBox();
    const menuBox = await page.locator('#ai-translator-float-menu').boundingBox();
    const viewport = page.viewportSize();
    expect(itemBox.width).toBeGreaterThan(0);
    expect(itemBox.x).toBeGreaterThanOrEqual(menuBox.x - 0.5);
    expect(itemBox.y).toBeGreaterThanOrEqual(menuBox.y - 0.5);
    expect(itemBox.x + itemBox.width).toBeLessThanOrEqual(menuBox.x + menuBox.width + 0.5);
    expect(itemBox.y + itemBox.height).toBeLessThanOrEqual(menuBox.y + menuBox.height + 0.5);
    expect(menuBox.x).toBeGreaterThanOrEqual(0);
    expect(menuBox.y).toBeGreaterThanOrEqual(0);
    expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(viewport.width);
    expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(viewport.height);

    // 3. 真点这一项：其余全部翻出来，FAQ 不重复发。
    const faqSends = sendCount(sentTexts, J3.faqQ);
    await item.click();
    for (const id of ['nav1', 'main1', 'main2', 'aside-p']) {
      await expect(page.locator(translationOf(id))).toContainText('[T]', { timeout: 30000 });
    }
    for (const text of [J3.nav, J3.main1, J3.main2, J3.aside]) {
      expect(sent(sentTexts, text), `sent: ${text}`).toBe(true);
    }
    expect(sendCount(sentTexts, J3.faqQ)).toBe(faqSends);
    await expect(page.locator(translationOf('faq-q'))).toHaveCount(1);
  } finally {
    await close();
  }
});

// ------------------------------------------------------------------ J-4

const J4 = {
  lead: 'The harbour office publishes the tide table for the coming week every Friday afternoon.',
  promo: 'Subscribe to the newsletter and receive the timetable changes before anybody else.',
};

const J4_PAGE = html(`
  <div id="lead-box"><p id="lead">${J4.lead}</p></div>
  <div id="promo-box" class="promo"><p id="promo">${J4.promo}</p></div>`);

test('[fixture] J-4: rule CSS restyles a translated tab within 1 s; unsafe CSS is refused while the rest of the rule works', async ({ page, context }) => {
  const { close, endpoint, sentTexts } = await startMockOpenAIServer();
  // /leak 计数：context.route 截下所有指向 /leak 的请求（哪个 frame、哪个来源都算）。
  // 末尾有一步正向对照：页面自己去取一次，计数必须变成 1 —— 证明计数器是接上的。
  let leaks = 0;
  await context.route('**/leak*', (route) => {
    leaks += 1;
    return route.fulfill({ status: 200, contentType: 'image/png', body: '' });
  });
  const cssRefusals = [];
  page.on('console', (msg) => {
    if (msg.text().startsWith('Blab Translation: custom rule CSS not applied')) cssRefusals.push(msg.text());
  });
  try {
    await setExtensionSettings(page, settings(endpoint));
    await serve(context, { [`${RULES}/tides`]: J4_PAGE });
    await page.goto(`${RULES}/tides`);
    await waitForFloatBall(page);
    await triggerPageTranslation(page);
    await expect(page.locator(translationOf('lead'))).toHaveText(`[T] ${J4.lead}`, { timeout: 30000 });
    await expect(page.locator(translationOf('promo'))).toHaveText(`[T] ${J4.promo}`, { timeout: 30000 });

    const leadColor = () => page.evaluate((selector) =>
      getComputedStyle(document.querySelector(selector)).color, translationOf('lead'));
    expect(await leadColor()).not.toBe('rgb(1, 2, 3)');

    // 1. 已翻好的标签页上写一条只有 CSS 的规则：1 s 内译文的计算颜色变过去，不刷新。
    //    选择器就是原样的 `.ai-translator-inline-block`，没有加重；但插入译文时会把
    //    原文的计算样式（含 color）抄进译文节点的行内 style，任何选择器都压不过行内
    //    样式，所以这条用户 CSS 带 `!important`（规则数据，不是我们的样式表）。
    let t0 = Date.now();
    await writeRule(context, 'j4css', rule(['rules.test'], {
      css: '.ai-translator-inline-block { color: rgb(1, 2, 3) !important }',
    }));
    await withinOneSecond(t0, async () => (await leadColor()) === 'rgb(1, 2, 3)', 'J-4 step 1 CSS applied');

    // 3. SW 直接写一条带外链 CSS 的规则（绕过写入口的校验，等于别的设备或手改的
    //    sync 数据），同一条里还有 exclude。exclude 照常生效；CSS 一个字都不挂；
    //    /leak 零请求。
    const leakUrl = `${new URL(endpoint).origin}/leak`;
    t0 = Date.now();
    await writeRule(context, 'j4css', rule(['rules.test'], {
      exclude: ['.promo'],
      css: `body { background: url(${leakUrl}) }`,
    }));
    await withinOneSecond(t0, async () => (await oursIn(page, 'promo-box')) === 0, 'J-4 step 3 exclude applied');
    expect(await isTranslated(page, 'lead')).toBe(true);
    // 上一条规则的 CSS 也随之卸下：本页生效的规则只有这一条，它的 CSS 被拒了。
    expect(await leadColor()).not.toBe('rgb(1, 2, 3)');
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundImage)).toBe('none');
    await page.waitForTimeout(1500);
    expect(leaks).toBe(0);
    expect(cssRefusals.length).toBeGreaterThan(0);
    // 拒绝日志只带错误键，不带规则内容。
    for (const line of cssRefusals) expect(line).not.toContain('leak');

    // 正向对照：页面自己取一次 /leak，计数器看得见。
    await page.evaluate((url) => { new Image().src = `${url}?control`; }, leakUrl);
    await expect.poll(() => leaks, { timeout: 5000 }).toBe(1);
    expect(sent(sentTexts, J4.lead)).toBe(true);
  } finally {
    await close();
  }
});

// ------------------------------------------------------------------ J-8

const J8 = {
  keep: 'The ferry timetable changes twice a year, in April and again in October.',
  region: 'Readers can leave comments about the crossing in the discussion area below.',
};

const J8_PAGE = html(`
  <div id="keep-box"><p id="keep">${J8.keep}</p></div>
  <div id="region-box" class="comments"><p id="region">${J8.region}</p></div>`);

/**
 * 一轮：手动翻 → 加 exclude（1 s 内收回）→ 清两半缓存 → 删规则（1 s 内回来，
 * 原文恰好多发一次）。
 */
async function excludeRoundTrip(page, context, sentTexts, label) {
  await triggerPageTranslation(page);
  await expect(page.locator(translationOf('keep'))).toHaveText(`[T] ${J8.keep}`, { timeout: 30000 });
  await expect(page.locator(translationOf('region'))).toHaveText(`[T] ${J8.region}`, { timeout: 30000 });

  let t0 = Date.now();
  await writeRule(context, 'j8excl', rule(['rules.test'], { exclude: ['.comments'] }));
  await withinOneSecond(t0, async () => (await oursIn(page, 'region-box')) === 0, `${label} exclude added`);
  expect(await isTranslated(page, 'keep')).toBe(true);

  // 基线：清掉两半缓存之后再数一次原文发出去几次。不清的话，删规则后那一块直接
  // 从缓存里回来，「恰好一次」就没法断言。
  await clearTranslationCache(context);
  const before = sendCount(sentTexts, J8.region);
  const keepBefore = sendCount(sentTexts, J8.keep);

  t0 = Date.now();
  await removeRules(context, ['j8excl']);
  await withinOneSecond(t0, () => isTranslated(page, 'region'), `${label} exclude removed`);
  // 再等一会儿：确认没有第二条路径把同一块再送一次。
  await page.waitForTimeout(1500);
  expect(sendCount(sentTexts, J8.region)).toBe(before + 1);
  expect(sendCount(sentTexts, J8.keep)).toBe(keepBefore);
  await expect(page.locator(translationOf('region'))).toHaveCount(1);
}

test('[fixture] J-8: adding an exclude takes a translation back within 1 s, removing it brings the region back within 1 s', async ({ page, context }) => {
  const { close, endpoint, sentTexts } = await startMockOpenAIServer();
  try {
    await serve(context, { [`${RULES}/ferry`]: J8_PAGE });

    // 自动翻译总开关关着：删规则后由 custom-rule.js 自己补的那一轮接回来。
    await setExtensionSettings(page, settings(endpoint, { autoTranslate: false }));
    await page.goto(`${RULES}/ferry`);
    await waitForFloatBall(page);
    await excludeRoundTrip(page, context, sentTexts, 'J-8 autoTranslate off');

    // 总开关开着：手动翻译把本页交给调度器（markPageExplicit），删规则后由调度器
    // 重启接回来 —— 两条路不收同一批块，所以原文依旧恰好多发一次。
    await setExtensionSettings(page, settings(endpoint, { autoTranslate: true }));
    await page.goto(`${RULES}/ferry`);
    await waitForFloatBall(page);
    await excludeRoundTrip(page, context, sentTexts, 'J-8 autoTranslate on');
  } finally {
    await close();
  }
});

// ------------------------------------------------------------------ J-9

const TOP = 'https://rules-top.test';
const NOTE = 'https://rules-note.test';
const J9 = {
  top: 'The museum reopens its maritime gallery to visitors on the first Saturday of May.',
  body: 'The embedded guide lists every ship model on display along with its year of launch.',
  more: 'Audio commentary for the gallery is available in six languages at the front desk.',
  side: 'Internal note for editors about image licensing which should never be shown translated.',
};

const J9_PAGES = {
  [`${TOP}/museum`]: html(`
    <p id="top-lead">${J9.top}</p>
    <iframe id="note-frame" src="${NOTE}/guide" width="640" height="260" style="border:0;display:block"></iframe>`),
  [`${NOTE}/guide`]: html(`
    <p id="guide-body">${J9.body}</p>
    <div id="side-box" class="side-note"><p id="side">${J9.side}</p></div>
    <p id="guide-more">${J9.more}</p>`),
};

test('[fixture] J-9: an iframe follows its own host rule for regions and the top host rule for the engine', async ({ page, context }) => {
  const { close, endpoint, sentTexts } = await startMockOpenAIServer();
  try {
    // 全局两张引擎开关都是内置；e2e 的 Chromium 没有 Translator API，内置引擎翻不
    // 出任何东西 —— iframe 的段落出现在 sentTexts 里，只能是继承了顶层规则的 AI。
    await setExtensionSettings(page, settings(endpoint, {
      translationEngine: 'builtin',
      autoTranslateEngine: 'builtin',
    }));
    await writeRule(context, 'j9note', rule(['rules-note.test'], { exclude: ['.side-note'] }));
    await writeRule(context, 'j9top', rule(['rules-top.test'], { engine: 'ai' }));
    await serve(context, J9_PAGES);
    await page.goto(`${TOP}/museum`);
    await waitForFloatBall(page);
    const frame = page.frameLocator('#note-frame');
    await expect(frame.locator('#guide-body')).toBeVisible();

    await page.click('#ai-translator-float-ball', { position: { x: 18, y: 18 } });
    await expect(page.locator(translationOf('top-lead'))).toHaveText(`[T] ${J9.top}`, { timeout: 30000 });
    await expect(frame.locator(translationOf('guide-body'))).toHaveText(`[T] ${J9.body}`, { timeout: 30000 });
    await expect(frame.locator(translationOf('guide-more'))).toHaveText(`[T] ${J9.more}`, { timeout: 30000 });
    expect(sent(sentTexts, J9.body)).toBe(true);
    expect(sent(sentTexts, J9.more)).toBe(true);

    // iframe 自己主机的规则：.side-note 零节点、零发送。
    await page.waitForTimeout(1500);
    const noteFrame = page.frames().find((f) => f.url().startsWith(NOTE));
    expect(noteFrame, 'the rules-note.test frame').toBeTruthy();
    expect(await oursIn(noteFrame, 'side-box')).toBe(0);
    expect(sent(sentTexts, J9.side)).toBe(false);
  } finally {
    await close();
  }
});

// ------------------------------------------------------------------ J-10

const PLAIN = 'http://rules-plain.test';
const J10 = {
  lead: 'The lighthouse keeper recorded the weather at dawn and at dusk for forty years.',
  body: 'His notebooks are now kept in the county archive and can be read by appointment.',
};

const J10_PAGE = html(`
  <div id="lead-box"><p id="lead">${J10.lead}</p></div>
  <div id="body-box"><p id="body">${J10.body}</p></div>`);

test('[fixture] J-10: on an http page with no usable engine, a rule pinning AI starts translation within 1 s', async ({ page, context }) => {
  const { close, endpoint, sentTexts } = await startMockOpenAIServer();
  try {
    // 两张开关都是内置、回退只许本地、站点「总是」；http 页面不是安全上下文，内置
    // 引擎不可用 —— 于是没有引擎，页面保持原文，mock 零请求。
    await setExtensionSettings(page, settings(endpoint, {
      translationEngine: 'builtin',
      autoTranslateEngine: 'builtin',
      engineFallback: 'local-only',
      siteRules: { 'rules-plain.test': 'always' },
    }));
    await serve(context, { [`${PLAIN}/keeper`]: J10_PAGE });
    await page.goto(`${PLAIN}/keeper`);
    await waitForFloatBall(page);
    expect(await page.evaluate(() => window.isSecureContext)).toBe(false);

    // 探语言最多等 1.2 s，再过一轮攒批防抖；给到 4 s。
    await page.waitForTimeout(4000);
    await expect(page.locator(TRANSLATED)).toHaveCount(0);
    expect(sentTexts).toEqual([]);

    // 写一条钉 AI 的规则：1 s 内、不刷新，译文出现，mock 收到请求。
    const t0 = Date.now();
    await writeRule(context, 'j10ai', rule(['rules-plain.test'], { engine: 'ai' }));
    await withinOneSecond(t0, () => isTranslated(page, 'lead'), 'J-10 AI pinned');
    expect(sent(sentTexts, J10.lead)).toBe(true);
    await expect(page.locator(translationOf('body'))).toHaveText(`[T] ${J10.body}`, { timeout: 30000 });
  } finally {
    await close();
  }
});
