// 自动翻译的路由重建旅程（J4.1–J4.8）：单页应用切菜单时把左栏整片重建，文字一个
// 字没变，节点全是新的。
//
// 在这之前，按节点认身份的那张表查不到新节点：五个菜单名再翻一遍，翻回来之前左栏
// 闪一下原文；更糟的是 <main> 的占比算进了我们自己的译文，左栏连译文一起被重建掉
// 的那一刻 <main> 被推过门槛，范围翻到 <main>，左栏从此不翻。
//
// 夹具照真实左栏写：`<div>` 不是 `<nav>`（`'main'` 范围本来就跳过 <nav>，那样测不
// 到问题），每次 go() 从数据重建 innerHTML。闪白用页面主世界的 rAF 逐帧计数（下面
// 的 startFrames）—— 判据是「有没有一帧画出来的左栏少于 5 条译文」，不是最后数一遍。
//
// 内置引擎桩（默认的自动引擎）：每段一次调用，计数和送出的原文都在内容脚本世界里
// （self.__builtinCalls / __builtinTexts）。mock AI 服务只是兜底，断言它一条也没收到。
const fs = require('fs');
const { test, expect } = require('./fixtures');
const {
  setExtensionSettings,
  evaluateInContentScript,
  serveHtml,
  scopeProbe,
  settingsSettled,
  stubBuiltinTranslator,
  waitForContentReady,
} = require('./helpers');
const { startMockOpenAIServer } = require('./mock-openai-server');

const HOST = 'leftmenu.test';
const NAV = [
  'Getting started with the archive and its reading rooms.',
  'Catalogue of maps, charts and surveying notebooks.',
  'Opening hours for the summer and winter seasons.',
  'Membership tiers and the annual reading pass.',
  'Contact the curators and request a private viewing.',
];
const KEYS = ['home', 'maps', 'hours', 'members', 'contact'];
// 正文与 translate="no" 的署名段落的长度是算过的（J4.4）：只数原文时 <main> 占比
// 0.27–0.29，低于门槛 0.3；把我们的译文也数进去就到 0.33–0.35。差这一截，
// 「占比不扣我们自己的节点」才会在翻译后把范围推到 <main>。改文字前先重算。
const MAIN = {
  home: 'The archive keeps two centuries of harbour records in a converted customs house. Ledgers, pilot logs and cargo manifests fill the upper floors, and the reading room looks out over the old quay where ships once unloaded.',
  maps: 'Nautical charts from the eighteen hundreds show the sandbanks shifting with every storm. Surveyors redrew the channel each spring, and their notebooks record soundings, buoy positions and the names of the boats that ran aground.',
  hours: 'The reading rooms stay open late on Thursdays during the summer season. In winter the doors close at four, and the map room needs a booking two days ahead because the large tables are shared with the conservation team.',
  members: 'Members borrow facsimiles, join the monthly lectures and bring a guest to the annual open evening. The reading pass covers every branch, and students pay half the yearly fee when they show a current card at the front desk.',
};
const CREDITS = 'Harbour Archive Trust, registered charity 1048217, Quay Street. Collections staff: Ines Albrecht, Tomasz Wierzbicki, Mariko Hoshino, Rafael Quintero, Siobhan Gallagher, Dmitri Volkonsky. The east wing is funded by the Maritime Heritage Fund and the Friends of the Archive. Image rights stay with the photographers.';

function leftMenuHtml({ mainTag }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Harbour Archive</title>
<style>body{margin:0;display:grid;grid-template-columns:280px 1fr}#nav a{display:block;padding:8px 0}</style></head><body>
<div id="side"><div id="nav"></div><p id="credits" translate="no">${CREDITS}</p></div>
<${mainTag} id="main"><p id="view">${MAIN.home}</p></${mainTag}>
<script>
const NAV = ${JSON.stringify(NAV)};
const MAIN = ${JSON.stringify(MAIN)};
const KEYS = ${JSON.stringify(KEYS)};
function renderNav(active) {
  document.getElementById('nav').innerHTML = NAV.map((text, i) => '<a href="/' + KEYS[i] + '" data-key="' + KEYS[i] + '"'
    + (KEYS[i] === active ? ' aria-current="page"' : '') + '>' + text + '</a>').join('');
}
window.go = (key) => {
  history.pushState({}, '', '/' + key);
  document.getElementById('view').textContent = MAIN[key];
  renderNav(key);
};
window.renameNav = (i, text) => { NAV[i] = text; };
renderNav('home');
</script></body></html>`;
}

const NAV_TRANSLATIONS = '#nav .ai-translator-inline-block';

function settings(endpoint, extra) {
  // 自动引擎写明内置：那是产品默认值（J4.1「内置默认」），e2e 的基线设置把它
  // 改成了 ai（helpers.js 的 E2E_BASE_SETTINGS），这里改回来。
  return {
    apiEndpoint: endpoint,
    apiKey: 'test-key',
    modelName: 'gpt-4.1-mini',
    targetLang: 'zh-CN',
    skipTargetLanguageText: false,
    autoTranslateEngine: 'builtin',
    translationStyle: 'underline',
    ...extra,
  };
}

const navSent = (texts) => NAV.filter((text) => texts.some((sent) => sent.includes(text))).length;

async function builtinTexts(context, page) {
  return evaluateInContentScript(context, page, 'self.__builtinTexts.slice()');
}

// 打开一页，装上内置引擎桩，再把这个站点设成「总是翻译」。beforeAuto 在自动
// 翻译开始之前跑（量翻译前的状态用）。
async function openAuto(page, context, endpoint, { url, html, beforeAuto, extra } = {}) {
  await setExtensionSettings(page, settings(endpoint, extra));
  await serveHtml(context, { [url]: html });
  await page.goto(url);
  await waitForContentReady(page);
  await stubBuiltinTranslator(page);
  if (beforeAuto) await beforeAuto();
  await setExtensionSettings(page, settings(endpoint, { ...extra, siteRules: { [new URL(url).host]: 'always' } }));
}

async function openLeftMenu(page, context, endpoint, { mainTag = 'div', beforeAuto, extra } = {}) {
  await openAuto(page, context, endpoint, { url: `https://${HOST}/home`, html: leftMenuHtml({ mainTag }), beforeAuto, extra });
  await expect(page.locator(NAV_TRANSLATIONS)).toHaveCount(5, { timeout: 30000 });
  await expect(page.locator('#main .ai-translator-inline-block')).toHaveCount(1, { timeout: 30000 });
}

// 切一次路由，等正文的新译文落下，再多等一段：防抖 400 ms + 起跑 250 ms 之后
// 还没有新请求，才算这一下真的只翻了正文。
async function switchTo(page, key) {
  await page.evaluate((k) => window.go(k), key);
  await expect(page.locator('#main .ai-translator-inline-block')).toContainText(MAIN[key].slice(0, 40), { timeout: 30000 });
  await page.waitForTimeout(1500);
}

// 逐帧计数探针，跑在页面主世界的 rAF 上：每一帧数一遍 selector 里 keep 为真的
// 节点，记一个数。keep 是按源码（toString）送进页面的，只能用它自己的参数和页面
// 的全局，不能引用这个文件里的任何东西。
async function startFrames(page, selector, keep = () => true) {
  await page.evaluate(`(() => {
    const keep = ${keep.toString()};
    window.__frames = [];
    window.__framing = true;
    const tick = () => {
      let count = 0;
      for (const el of document.querySelectorAll(${JSON.stringify(selector)})) if (keep(el)) count += 1;
      window.__frames.push(count);
      if (window.__framing) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  })()`);
}

function stopFrames(page) {
  return page.evaluate(() => { window.__framing = false; return window.__frames; });
}

// 和视口相交（高度为 0 的不算）。
const inView = (el) => {
  const rect = el.getBoundingClientRect();
  return rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight;
};

// 视口里的菜单项，紧跟着它的还不是一条译文（块级 <a> 的译文落在它后面做兄弟）。
const missingInView = (el) => {
  const rect = el.getBoundingClientRect();
  if (!(rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight)) return false;
  const next = el.nextElementSibling;
  return !(next && next.classList.contains('ai-translator-inline-block'));
};

test('J4.1/J4.2/J4.3 a rebuilt left menu keeps its translations: no request, no frame without them', async ({ page, context }) => {
  const mock = await startMockOpenAIServer();
  try {
    await openLeftMenu(page, context, mock.endpoint);
    const first = await builtinTexts(context, page);
    // 首轮：左栏 5 段 + 正文 1 段；translate="no" 的署名一段不送。
    expect(first.length).toBe(6);
    expect(navSent(first)).toBe(5);

    for (const key of ['maps', 'hours']) {
      const before = (await builtinTexts(context, page)).length;
      await startFrames(page, NAV_TRANSLATIONS);
      await switchTo(page, key);
      const frames = await stopFrames(page);
      const sent = (await builtinTexts(context, page)).slice(before);
      // J4.1：只有正文进请求，左栏一串也没重发。
      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain(MAIN[key].slice(0, 40));
      expect(navSent(sent)).toBe(0);
      // 探针真的在逐帧跑（防止一个没跑起来的探针给出空集合的「0 帧」）。
      expect(frames.length).toBeGreaterThan(10);
      expect(frames.filter((count) => count < 5)).toEqual([]);
      await expect(page.locator(NAV_TRANSLATIONS)).toHaveCount(5);
    }

    // J4.2：只改高亮属性，不发请求。
    const beforeHighlight = (await builtinTexts(context, page)).length;
    await page.evaluate(() => {
      for (const a of document.querySelectorAll('#nav a')) a.toggleAttribute('aria-current', a.dataset.key === 'home');
    });
    await page.waitForTimeout(1500);
    expect((await builtinTexts(context, page)).length).toBe(beforeHighlight);

    // J4.3：一行文字真变 —— 恰好正文 + 那一行。
    const renamed = 'Volunteer with the archive and help catalogue the logbooks.';
    const beforeRename = (await builtinTexts(context, page)).length;
    await page.evaluate((text) => window.renameNav(3, text), renamed);
    await switchTo(page, 'members');
    const sent = (await builtinTexts(context, page)).slice(beforeRename);
    expect(sent).toHaveLength(2);
    expect(sent.some((text) => text.includes(renamed))).toBe(true);
    expect(sent.some((text) => text.includes(MAIN.members.slice(0, 40)))).toBe(true);
    await expect(page.locator(NAV_TRANSLATIONS)).toHaveCount(5);

    expect(mock.sentTexts).toEqual([]);
  } finally {
    await mock.close();
  }
});

test('J4.4 with a <main>, our own translations never push the scope off the body', async ({ page, context }) => {
  const mock = await startMockOpenAIServer();
  try {
    let beforeTranslation = null;
    await openLeftMenu(page, context, mock.endpoint, {
      mainTag: 'main',
      beforeAuto: async () => { beforeTranslation = await scopeProbe(context, page, { invalidate: 'round' }); },
    });
    expect(beforeTranslation.roots).toEqual(['BODY']);
    // 夹具要真的贴着门槛，否则这一条证明不了什么（见 MAIN 上方的注释）。
    expect(beforeTranslation.share).toBeGreaterThan(0.25);
    expect(beforeTranslation.share).toBeLessThan(0.3);

    const afterTranslation = await scopeProbe(context, page, { invalidate: 'round' });
    expect(afterTranslation.roots).toEqual(['BODY']);
    expect(afterTranslation.share).toBeCloseTo(beforeTranslation.share, 2);

    for (const key of ['maps', 'hours']) {
      await switchTo(page, key);
      const afterRoute = await scopeProbe(context, page, { invalidate: 'round' });
      expect(afterRoute.roots).toEqual(['BODY']);
      await expect(page.locator(NAV_TRANSLATIONS)).toHaveCount(5);
    }
    expect(navSent((await builtinTexts(context, page)).slice(6))).toBe(0);
  } finally {
    await mock.close();
  }
});

// J4.5：藏着译文时自动翻译停下（发现层整个停掉），但装回不停 —— 藏着时
// 切菜单，新左栏的译文照样从记忆装回，带着隐藏态；放出来的那一帧就是完整的，
// 不等发现层重启再补（那之前几百毫秒画的是原文）。藏着时不发请求。
test('J4.5 with translations hidden, a menu switch recalls them hidden, and showing them is whole at once', async ({ page, context }) => {
  const mock = await startMockOpenAIServer();
  try {
    await openLeftMenu(page, context, mock.endpoint);
    const setVisible = (visible) => evaluateInContentScript(context, page,
      `(window.AI_TRANSLATOR_CONTENT.setTranslationsVisible(${visible}), true)`);
    const shown = `${NAV_TRANSLATIONS}:not(.ai-translator-hidden)`;

    // 藏着时切菜单：没有任何一帧画出左栏译文。
    await setVisible(false);
    await expect(page.locator(shown)).toHaveCount(0);
    const beforeHidden = (await builtinTexts(context, page)).length;
    await startFrames(page, shown);
    await page.evaluate(() => window.go('maps'));
    await page.waitForTimeout(1500);
    const hiddenFrames = await stopFrames(page);
    expect(hiddenFrames.length).toBeGreaterThan(10);
    expect(hiddenFrames.filter((count) => count > 0)).toEqual([]);
    // 新左栏的五条译文都已经装回来了，全带隐藏态。
    await expect(page.locator(NAV_TRANSLATIONS)).toHaveCount(5);
    await expect(page.locator(shown)).toHaveCount(0);
    // 藏着就是「我现在想看原文」：自动翻译停着，不发请求（装回不是请求）。
    expect((await builtinTexts(context, page)).length).toBe(beforeHidden);

    // 放出来：从这一刻起的每一帧左栏都是 5 条译文，一串不重发；只有藏着时换掉
    // 的正文进请求。
    await setVisible(true);
    await startFrames(page, shown);
    await expect(page.locator('#main .ai-translator-inline-block')).toContainText(MAIN.maps.slice(0, 40), { timeout: 30000 });
    await page.waitForTimeout(1500);
    const shownFrames = await stopFrames(page);
    expect(shownFrames.length).toBeGreaterThan(10);
    expect(shownFrames.filter((count) => count < 5)).toEqual([]);
    const revealed = (await builtinTexts(context, page)).slice(beforeHidden);
    expect(navSent(revealed)).toBe(0);
    expect(revealed).toHaveLength(1);

    // 再藏一次、再切一次：装回观察器跟着自动翻译的判定走，藏起不摘它。
    await setVisible(false);
    const beforeSecond = (await builtinTexts(context, page)).length;
    await page.evaluate(() => window.go('hours'));
    await expect(page.locator(NAV_TRANSLATIONS)).toHaveCount(5);
    await expect(page.locator(shown)).toHaveCount(0);
    await page.waitForTimeout(1500);
    expect((await builtinTexts(context, page)).length).toBe(beforeSecond);
    expect(mock.sentTexts).toEqual([]);
  } finally {
    await mock.close();
  }
});

// 装回观察器的去留只看「藏起这一条撇开不算，自动翻译此刻跟不跟这一页」：判定是
// auto、也没被用户按停，就挂着；否则摘掉。藏着时这个判定照样会变 —— 下面两条一正
// 一反：藏着时站点改成「从不」，重建的左栏不装回，放出来也没有；改回「总是」，
// 藏着时重建的左栏照样装回，放出来就是完整的、一条不重发。
const autoStatus = (context, page) => evaluateInContentScript(context, page,
  'window.AI_TRANSLATOR_CONTENT.autoTranslate.state().status');

async function setSiteRule(page, context, endpoint, rule) {
  await setExtensionSettings(page, settings(endpoint, { siteRules: { [HOST]: rule } }));
  await expect.poll(() => evaluateInContentScript(context, page,
    `window.AI_TRANSLATOR_CONTENT.settings.siteRules[${JSON.stringify(HOST)}]`), { timeout: 10000 }).toBe(rule);
}

test('J4.5b with translations hidden, turning the site to never stops recall: a rebuilt menu stays untranslated', async ({ page, context }) => {
  const mock = await startMockOpenAIServer();
  try {
    await openLeftMenu(page, context, mock.endpoint);
    const setVisible = (visible) => evaluateInContentScript(context, page,
      `(window.AI_TRANSLATOR_CONTENT.setTranslationsVisible(${visible}), true)`);

    await setVisible(false);
    await expect.poll(() => autoStatus(context, page), { timeout: 10000 }).toBe('paused');
    await setSiteRule(page, context, mock.endpoint, 'never');
    await expect.poll(() => autoStatus(context, page), { timeout: 10000 }).toBe('off');
    const before = (await builtinTexts(context, page)).length;

    await page.evaluate(() => window.go('maps'));
    await page.waitForTimeout(1500);
    await expect(page.locator(NAV_TRANSLATIONS)).toHaveCount(0);

    await setVisible(true);
    await page.waitForTimeout(1500);
    await expect(page.locator(NAV_TRANSLATIONS)).toHaveCount(0);
    expect((await builtinTexts(context, page)).length).toBe(before);
    expect(mock.sentTexts).toEqual([]);
  } finally {
    await mock.close();
  }
});

test('J4.5c with translations hidden, never then always again: a rebuilt menu is recalled hidden and shown whole, unsent', async ({ page, context }) => {
  const mock = await startMockOpenAIServer();
  try {
    await openLeftMenu(page, context, mock.endpoint);
    const setVisible = (visible) => evaluateInContentScript(context, page,
      `(window.AI_TRANSLATOR_CONTENT.setTranslationsVisible(${visible}), true)`);
    const shown = `${NAV_TRANSLATIONS}:not(.ai-translator-hidden)`;

    await setVisible(false);
    await setSiteRule(page, context, mock.endpoint, 'never');
    await expect.poll(() => autoStatus(context, page), { timeout: 10000 }).toBe('off');
    await setSiteRule(page, context, mock.endpoint, 'always');
    // 藏着：判定回到 auto，但自动翻译仍停着（paused），装回观察器重新挂上。
    await expect.poll(() => autoStatus(context, page), { timeout: 10000 }).toBe('paused');
    const before = (await builtinTexts(context, page)).length;

    await page.evaluate(() => window.go('maps'));
    await expect(page.locator(NAV_TRANSLATIONS)).toHaveCount(5);
    await expect(page.locator(shown)).toHaveCount(0);

    await setVisible(true);
    await startFrames(page, shown);
    await expect(page.locator('#main .ai-translator-inline-block')).toContainText(MAIN.maps.slice(0, 40), { timeout: 30000 });
    await page.waitForTimeout(1500);
    const shownFrames = await stopFrames(page);
    expect(shownFrames.length).toBeGreaterThan(10);
    expect(shownFrames.filter((count) => count < 5)).toEqual([]);
    expect(navSent((await builtinTexts(context, page)).slice(before))).toBe(0);
    expect(mock.sentTexts).toEqual([]);
  } finally {
    await mock.close();
  }
});

// 页内记忆只在「这一代译法」里有效。换了引擎（或提示词、术语表、配置
// 档 —— 都走 translationProfile 换代），记忆整张清掉：重建的左栏照常送新引擎，
// 不装回上一个引擎的译文。

test('J4.6 after the engine changes, a rebuilt menu is sent to the new engine, not recalled', async ({ page, context }) => {
  const mock = await startMockOpenAIServer();
  try {
    await openLeftMenu(page, context, mock.endpoint);
    expect(navSent(await builtinTexts(context, page))).toBe(5);
    expect(mock.sentTexts).toEqual([]);

    await setExtensionSettings(page, settings(mock.endpoint, { autoTranslateEngine: 'ai', siteRules: { [HOST]: 'always' } }));
    await settingsSettled(context, page, 'autoTranslateEngine', 'ai');
    await page.waitForTimeout(1500);
    const builtinBefore = (await builtinTexts(context, page)).length;

    await page.evaluate(() => window.go('maps'));
    await expect.poll(() => navSent(mock.sentTexts), { timeout: 30000 }).toBe(5);
    const nav = page.locator(NAV_TRANSLATIONS);
    await expect(nav).toHaveCount(5, { timeout: 30000 });
    const texts = await nav.allTextContents();
    expect(texts.every((text) => text.includes('[T] '))).toBe(true);
    expect(texts.some((text) => text.includes('[B] '))).toBe(false);
    // 换引擎之后内置引擎一条也没再收到。
    expect(navSent((await builtinTexts(context, page)).slice(builtinBefore))).toBe(0);
  } finally {
    await mock.close();
  }
});

// 提示词不在自动翻译重开的那组键里：改它只换代、清记忆，在途的那一批不作废，晚到
// 的答案照样落在它的节点上。但它是上一代的译文，不进这一代的记忆（batch.js 的
// passTarget 记下发出时的代次）—— 否则菜单一重建，它就从记忆装回，那一块再也不
// 按新提示词请求。
test('J4.6b a translation requested before the prompt changed still lands, but a rebuilt menu requests it again', async ({ page, context }) => {
  const mock = await startMockOpenAIServer();
  const ai = { autoTranslateEngine: 'ai' };
  try {
    await openLeftMenu(page, context, mock.endpoint, { extra: ai });
    const generation = () => evaluateInContentScript(context, page,
      'window.AI_TRANSLATOR_CONTENT.translationProfile.generation()');
    const renamed = 'Volunteer at the archive and help us transcribe the old pilot logs.';
    const contact = page.locator('#nav a[data-key="contact"] + .ai-translator-inline-block');

    // 改了名的那一行重建后不在记忆里，送出去，答案压着不回。
    await page.evaluate((text) => window.renameNav(4, text), renamed);
    mock.setDelayMs(4000);
    const generationBefore = await generation();
    await page.evaluate(() => window.go('maps'));
    await expect.poll(() => mock.sentTexts.some((text) => text.includes(renamed)), { timeout: 10000 }).toBe(true);

    // 答案还在路上时改提示词：换代。
    await setExtensionSettings(page, settings(mock.endpoint, { ...ai, customPrompt: 'Translate tersely.', siteRules: { [HOST]: 'always' } }));
    await expect.poll(generation, { timeout: 10000 }).toBeGreaterThan(generationBefore);
    await expect(contact).toHaveCount(0);
    mock.setDelayMs(0);
    // 上一代的答案晚到，照样落下。
    await expect(contact).toContainText(`[T] ${renamed}`, { timeout: 30000 });

    // 重建：记忆在换代时清空了，晚到的那一条也没记进去 —— 五行都重新请求。
    const sentBefore = mock.sentTexts.length;
    await page.evaluate(() => window.go('hours'));
    await expect.poll(() => mock.sentTexts.slice(sentBefore).filter((text) => text.includes(renamed)).length,
      { timeout: 30000 }).toBe(1);
    expect(navSent(mock.sentTexts.slice(sentBefore))).toBe(4);
    await expect(page.locator(NAV_TRANSLATIONS)).toHaveCount(5, { timeout: 30000 });
  } finally {
    await mock.close();
  }
});

// 「跳过目标语言」开着时，已经是目标语言的那一块不装回。它在开关关着时
// 被翻过、记进了记忆；开关打开后菜单重建，那一块交给批量那条路上的检测
// （batch.js 的 isTargetLanguageText），判成目标语言 —— 不译，也不再送。
//
// 这条走 AI 引擎（mock）：内置引擎认出中文源、目标也是中文时原样退回、不插译文
// （content/content-translation-engine.js 的 src === tgt 一档），那一行根本进不了记忆。
// 两次写设置都带着同一个引擎，跳过开关本身不换代（GENERATION_KEYS 里没有它），
// 记忆留着 —— 测的正是「留着也不装回」。
test('J4.7 with skip-target-language on, a block already in the target language is not recalled', async ({ page, context }) => {
  const mock = await startMockOpenAIServer();
  const ai = { autoTranslateEngine: 'ai' };
  try {
    await openLeftMenu(page, context, mock.endpoint, { extra: ai });
    const native = '联系策展人并预约私人参观，我们会在两个工作日内回复您的申请。';
    await page.evaluate((text) => window.renameNav(4, text), native);
    await switchTo(page, 'maps');
    // 开关关着：中文那一行照样送了，也落了译文，进了记忆。
    expect(mock.sentTexts.filter((text) => text.includes(native))).toHaveLength(1);
    await expect(page.locator(NAV_TRANSLATIONS)).toHaveCount(5);
    // 块级 <a> 的译文落在它后面做兄弟（insert.js 的 element.after），不在它里面。
    const contact = page.locator('#nav a[data-key="contact"] + .ai-translator-inline-block');
    await expect(contact).toHaveCount(1);

    await setExtensionSettings(page, settings(mock.endpoint, { ...ai, skipTargetLanguageText: true, siteRules: { [HOST]: 'always' } }));
    await settingsSettled(context, page, 'skipTargetLanguageText', true);
    await page.waitForTimeout(1500);
    const before = mock.sentTexts.length;

    await switchTo(page, 'hours');
    // 四行英文照常从记忆装回；中文那一行没有译文，也没再送。
    await expect(page.locator(NAV_TRANSLATIONS)).toHaveCount(4, { timeout: 30000 });
    await expect(contact).toHaveCount(0);
    const sent = mock.sentTexts.slice(before);
    expect(sent.filter((text) => text.includes(native))).toEqual([]);
    expect(navSent(sent)).toBe(0);
  } finally {
    await mock.close();
  }
});

// 菜单夹具：go() 每次从数据把 #menu 的 innerHTML 整片重建，文字一个字不变。
// 译文节点沿用源块的标签（insert.js 按 element.tagName 建），也是 <a>，只是不带
// href：菜单项一律按 a[href] 认，样式和下标才不会把译文算进去。
const MENU_ITEMS = '#menu a[href]';
const MENU_TRANSLATIONS = '#menu .ai-translator-inline-block';

function menuHtml({ size, css }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Harbour Index</title>
<style>body{margin:0}${css}</style></head><body>
<div id="menu"></div><div id="tail"></div>
<script>
const ITEMS = Array.from({ length: ${size} }, (_, i) => 'Section ' + (i + 1) + ' of the harbour index lists the pilots and their logbooks.');
window.go = () => {
  document.getElementById('menu').innerHTML = ITEMS.map((text, i) => '<a href="/s' + i + '">' + text + '</a>').join('');
};
window.go();
</script></body></html>`;
}

// 包住 ctx.recallTranslations（装回观察器在重建那一刻调的就是它），每次调用
// 记下装回了几块、花了多久。
async function recordRecalls(context, page) {
  await evaluateInContentScript(context, page, `(() => {
    const ctx = window.AI_TRANSLATOR_CONTENT;
    const original = ctx.recallTranslations;
    self.__recallMs = [];
    self.__recalled = [];
    ctx.recallTranslations = (roots) => {
      const start = performance.now();
      const restored = original(roots);
      self.__recallMs.push(performance.now() - start);
      self.__recalled.push(restored);
      return restored;
    };
    return true;
  })()`);
}

const recalls = async (context, page) => ({
  ms: await evaluateInContentScript(context, page, 'self.__recallMs.slice()'),
  restored: await evaluateInContentScript(context, page, 'self.__recalled.slice()'),
});

// 同步装回的 16 块预算只管视口外的命中。一个 30 项的左栏
// 滚到底再整片重建，按 DOM 顺序装的话装回的是视口外的头 16 项，看得见的那几项要
// 等发现层进带才补 —— 中间那几帧视口里一条译文都没有。先装和视口相交的，再按
// DOM 顺序补视口外的。
//
// 几何是算过的：每项 100px 高，视口 720px，滚到第 22 项（视口里 22–29 共 8 项，
// 少于 16，且都在 DOM 第 16 项之后）。页尾留 2000px 的空白，重建时页面变矮也不会
// 把滚动位置夹回来；关掉滚动锚定，视口外上方装回的译文把内容往下推的那一截照实
// 算：按 DOM 顺序装的 0–15 项连同推下来的高度也够不到视口。
const LONG_MENU_SIZE = 30;
const LONG_MENU_TOP = 22;
const LONG_MENU_CSS = 'html{overflow-anchor:none}#menu a[href]{display:block;box-sizing:border-box;min-height:100px;padding:38px 0}#tail{height:2000px}';

test('J4.8 a long menu scrolled to the bottom keeps translations in view through a rebuild', async ({ page, context }) => {
  const mock = await startMockOpenAIServer();
  try {
    await openAuto(page, context, mock.endpoint, {
      url: 'https://longmenu.test/', html: menuHtml({ size: LONG_MENU_SIZE, css: LONG_MENU_CSS }),
    });
    // 发现层只翻视口上下一屏之内的：先在顶上翻头一截，再滚到底翻其余的。
    await expect.poll(() => page.locator(MENU_TRANSLATIONS).count(), { timeout: 30000 }).toBeGreaterThan(5);
    const scrollToItem = (i) => page.evaluate(({ items, index }) => {
      document.querySelectorAll(items)[index].scrollIntoView({ block: 'start' });
    }, { items: MENU_ITEMS, index: i });
    const scrollToTop = () => scrollToItem(LONG_MENU_TOP);
    for (let i = 4; i <= LONG_MENU_TOP; i += 4) {
      await scrollToItem(i);
      await page.waitForTimeout(300);
    }
    await scrollToTop();
    await expect(page.locator(MENU_TRANSLATIONS)).toHaveCount(LONG_MENU_SIZE, { timeout: 30000 });
    await page.waitForTimeout(1500);
    await scrollToTop();

    // 前提：视口里的菜单项少于 16，而且全在 DOM 第 16 项之后。
    const visible = await page.evaluate((items) => Array.from(document.querySelectorAll(items))
      .map((a, i) => ({ i, rect: a.getBoundingClientRect() }))
      .filter(({ rect }) => rect.bottom > 0 && rect.top < innerHeight)
      .map(({ i }) => i), MENU_ITEMS);
    expect(visible.length).toBeGreaterThan(0);
    expect(visible.length).toBeLessThan(16);
    expect(Math.min(...visible)).toBeGreaterThanOrEqual(16);

    const before = (await builtinTexts(context, page)).length;
    await startFrames(page, MENU_TRANSLATIONS, inView);
    await page.evaluate(() => window.go());
    await page.waitForTimeout(1500);
    const frames = await stopFrames(page);
    expect(frames.length).toBeGreaterThan(10);
    // 没有一帧视口里一条译文都没有。
    expect(frames.filter((count) => count === 0)).toEqual([]);
    // 其余的由发现层进带时逐块装回：视口上方带外的那几项要滚回去才进带。滚回顶上，
    // 整片 30 条都在，一串也没重发。
    for (let i = LONG_MENU_TOP - 4; i >= 0; i -= 4) {
      await scrollToItem(i);
      await page.waitForTimeout(300);
    }
    await scrollToItem(0);
    await expect(page.locator(MENU_TRANSLATIONS)).toHaveCount(LONG_MENU_SIZE, { timeout: 30000 });
    expect((await builtinTexts(context, page)).length).toBe(before);
    expect(mock.sentTexts).toEqual([]);
  } finally {
    await mock.close();
  }
});

// 视口里的命中不论多少都在重建那一刻同步装回，预算不截它们。40 项的密
// 菜单每项 16px 高，重建时 40 项全在 720px 的视口里；按「一共 16 块」截的话，第
// 17 项起要等发现层进带才补，那几帧视口里就有没译文的项。
const DENSE_MENU_SIZE = 40;
const DENSE_MENU_CSS = '#menu a{display:block;height:16px;line-height:16px;font-size:12px;white-space:nowrap;overflow:hidden}';

test('J4.8b a dense menu of 40 items in view is restored whole in the same frame as the rebuild', async ({ page, context }) => {
  const mock = await startMockOpenAIServer();
  try {
    await openAuto(page, context, mock.endpoint, {
      url: 'https://densemenu.test/', html: menuHtml({ size: DENSE_MENU_SIZE, css: DENSE_MENU_CSS }),
    });
    await expect(page.locator(MENU_TRANSLATIONS)).toHaveCount(DENSE_MENU_SIZE, { timeout: 30000 });
    await page.waitForTimeout(1500);

    // 前提：只数菜单项本身，40 项摞起来放得进视口 —— 重建那一刻（译文还没装回）
    // 40 项全和视口相交。
    const geometry = await page.evaluate((items) => ({
      stacked: Array.from(document.querySelectorAll(items)).reduce((sum, a) => sum + a.offsetHeight, 0),
      viewport: innerHeight,
      scrollY,
    }), MENU_ITEMS);
    expect(geometry.stacked).toBeGreaterThan(0);
    expect(geometry.stacked).toBeLessThanOrEqual(geometry.viewport);
    expect(geometry.scrollY).toBe(0);

    await recordRecalls(context, page);
    const before = (await builtinTexts(context, page)).length;
    await startFrames(page, MENU_ITEMS, missingInView);
    await page.evaluate(() => window.go());
    await page.waitForTimeout(1500);
    const frames = await stopFrames(page);
    // 重建触发的那一次同步装回把 40 项一次装齐。
    expect((await recalls(context, page)).restored).toEqual([DENSE_MENU_SIZE]);
    expect(frames.length).toBeGreaterThan(10);
    // 没有一帧视口里有菜单项缺译文。
    expect(frames.filter((count) => count > 0)).toEqual([]);
    await expect(page.locator(MENU_TRANSLATIONS)).toHaveCount(DENSE_MENU_SIZE);
    expect((await builtinTexts(context, page)).length).toBe(before);
    expect(mock.sentTexts).toEqual([]);
  } finally {
    await mock.close();
  }
});

// ≥2000 块的容器整片重建时，装回观察器里那一步同步装回要多久。
// 记忆按真实入口 ctx.rememberLanded 填满（registerTranslation 记的也是这一句），
// 发现层带宽之外的块自动翻译不会去翻，靠它们自己翻满 2000 条要几分钟。
// RERENDER_PERF_OUT 设了就把结果写进那个文件（证据目录的 perf.txt）。
const FEED_SIZE = 2000;
const RUNS = 10;
// C 段（页面版式已算完、只剩装回自己）的 p95 上限。
const RECALL_P95_CEILING_MS = 50;
// 每行 32px、没有外边距：重建时（译文还没装回）720px 的视口里 23 行（第 23 行
// 露一半），D 段 1280px 的视口里正好 40 行（要量的 40 条视口内命中）。
const FEED_ROW_PX = 32;
const TALL_VIEWPORT = { width: 1280, height: 40 * FEED_ROW_PX };

// 译文节点沿用源块的标签和 class（这里是 <p>），填记忆和挑远处那一行都得把我们
// 自己的节点排除掉，不然译文会被当原文记进去、挤掉最早的那几十条。
function feedHtml() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Feed</title>
<style>body{margin:0}#feed p{margin:0;height:${FEED_ROW_PX}px;line-height:${FEED_ROW_PX}px;white-space:nowrap;overflow:hidden}</style></head><body>
<div id="feed"></div>
<script>
const rows = Array.from({ length: ${FEED_SIZE} }, (_, i) => 'Entry ' + i + ' of the harbour ledger records a cargo of timber, salt and rope.');
function build() {
  const feed = document.createElement('div');
  feed.id = 'feed';
  feed.innerHTML = rows.map((text) => '<p>' + text + '</p>').join('');
  return feed;
}
window.rerender = () => document.getElementById('feed').replaceWith(build());
// 同一次重建，但在 MutationObserver 回调之前先把页面自己的版式算完：回调里量到
// 的就只剩装回自己的那份，不含这片新子树的首次布局（那是页面自己的开销，绘制
// 前本来就要付）。__layoutMs 记的就是那一份。
window.__layoutMs = [];
window.rerenderLaidOut = () => {
  window.rerender();
  const start = performance.now();
  void document.body.offsetHeight;
  window.__layoutMs.push(performance.now() - start);
};
document.getElementById('feed').replaceWith(build());
</script></body></html>`;
}

// 最近秩 p95：n=10 时就是最大值，报告里照实写 n。
const p95 = (values) => values.slice().sort((a, b) => a - b)[Math.ceil(0.95 * values.length) - 1];

const stats = (values) => {
  const sorted = values.slice().sort((a, b) => a - b);
  const median = (sorted[(values.length - 1) >> 1] + sorted[values.length >> 1]) / 2;
  return `median=${median.toFixed(2)}ms p95(n=${values.length})=${p95(values).toFixed(2)}ms `
    + `max=${sorted[values.length - 1].toFixed(2)}ms all=[${values.map((v) => v.toFixed(2)).join(', ')}]`;
};

test('perf: synchronous recall on a rebuilt container of 2000 blocks', async ({ page, context }) => {
  const mock = await startMockOpenAIServer();
  try {
    let idle = null;
    await openAuto(page, context, mock.endpoint, {
      url: `https://${HOST}/feed`,
      html: feedHtml(),
      // 一条都没记过的页面：装回这一步直接返回，不收块。
      beforeAuto: async () => {
        idle = await evaluateInContentScript(context, page, `(() => {
          const ctx = window.AI_TRANSLATOR_CONTENT;
          const size = globalThis.BlockIdentity.memorySize();
          const feed = document.getElementById('feed');
          const start = performance.now();
          const restored = ctx.recallTranslations([feed]);
          return { size, restored, ms: performance.now() - start };
        })()`);
      },
    });
    expect(idle.size).toBe(0);
    expect(idle.restored).toBe(0);
    await expect.poll(() => page.locator('#feed .ai-translator-inline-block').count(), { timeout: 30000 }).toBeGreaterThan(0);
    await page.waitForTimeout(1500);

    const seeded = await evaluateInContentScript(context, page, `(() => {
      const ctx = window.AI_TRANSLATOR_CONTENT;
      const lang = ctx.currentTargetLang();
      for (const p of document.querySelectorAll('#feed > p:not(' + ctx.constants.OWN_NODES_SELECTOR + ')')) {
        // 送出去的原文就是收集端的 block.text（collect.js 的 getTextWithMathPlaceholders，
        // preserveMarkup 同收集端），记忆按它和语言认。
        const source = ctx.getTextWithMathPlaceholders(p, { preserveMarkup: true }).text;
        ctx.rememberLanded(lang, { source, translation: '[B] ' + source, targetLangChecked: false });
      }
      return globalThis.BlockIdentity.memorySize();
    })()`);
    expect(seeded).toBeGreaterThanOrEqual(FEED_SIZE);
    await recordRecalls(context, page);

    const callsBefore = (await builtinTexts(context, page)).length;
    for (let i = 0; i < RUNS; i += 1) {
      await page.evaluate(() => window.rerender());
      await page.waitForTimeout(800);
    }
    for (let i = 0; i < RUNS; i += 1) {
      await page.evaluate(() => window.rerenderLaidOut());
      await page.waitForTimeout(800);
    }
    // D 段：视口拉高到 40 行以上，同样只量装回自己。
    await page.setViewportSize(TALL_VIEWPORT);
    await page.waitForTimeout(800);
    expect(await page.evaluate(() => scrollY)).toBe(0);
    for (let i = 0; i < RUNS; i += 1) {
      await page.evaluate(() => window.rerenderLaidOut());
      await page.waitForTimeout(800);
    }
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.waitForTimeout(800);

    const { ms: all, restored } = await recalls(context, page);
    const layoutMs = await page.evaluate(() => window.__layoutMs.slice());
    expect(all).toHaveLength(RUNS * 3);
    const ms = all.slice(0, RUNS);
    const ownMs = all.slice(RUNS, RUNS * 2);
    const tallMs = all.slice(RUNS * 2);
    // 每次同步装回的块数 = max(装回预算 16, 重建时视口里的行数)：视口里的全装，
    // 视口外的补到预算为止；剩下的进带时由发现层逐块从记忆装回，不发
    // 请求。同一个视口里每次重建一样多：720px 里 23 块，拉高的视口里 40 块。
    const short = restored.slice(0, RUNS * 2);
    const tall = restored.slice(RUNS * 2);
    expect(short).toEqual(Array(RUNS * 2).fill(short[0]));
    expect(short[0]).toBe(23);
    expect(tall).toEqual(Array(RUNS).fill(tall[0]));
    expect(tall[0]).toBe(40);
    // 远处那一块：滚过去，进带时装回，仍然不发请求。
    const far = page.locator('#feed > p:not(.ai-translator-inline-block)').nth(1200);
    await far.scrollIntoViewIfNeeded();
    await expect.poll(() => far.evaluate((p) => {
      const next = p.nextElementSibling;
      return !!(next && next.classList.contains('ai-translator-inline-block'))
        || !!p.querySelector('.ai-translator-inline-block');
    }), { timeout: 10000 }).toBe(true);
    expect((await builtinTexts(context, page)).length).toBe(callsBefore);

    const line = `${FEED_SIZE} blocks rebuilt in one added root, scan budget 200 / restore budget 16 (out-of-view only), runs=${RUNS}\n`
      + `A recall per mutation callback, page layout still pending (720px, restored=${short[0]}): ${stats(ms)}\n`
      + `B page's own first layout of the rebuilt root: ${stats(layoutMs.slice(0, RUNS))}\n`
      + `C recall per mutation callback, page layout already done (720px, restored=${short[RUNS]}): ${stats(ownMs)}\n`
      + `D recall per mutation callback, page layout already done (${TALL_VIEWPORT.height}px, restored=${tall[0]} = in-view hits): ${stats(tallMs)}\n`
      + `memorySize()=0 (before any translation): restored=${idle.restored} in ${idle.ms.toFixed(3)}ms`;
    console.log(`PERF ${line}`);
    if (process.env.RERENDER_PERF_OUT) fs.writeFileSync(process.env.RERENDER_PERF_OUT, `${line}\n`);
    // 只量装回自己的那两段（C、D）设上限。
    expect(p95(ownMs)).toBeLessThanOrEqual(RECALL_P95_CEILING_MS);
    expect(p95(tallMs)).toBeLessThanOrEqual(RECALL_P95_CEILING_MS);
    expect(mock.sentTexts).toEqual([]);
  } finally {
    await mock.close();
  }
});
