// 自动翻译的路由重建旅程（J4.1–J4.5）：单页应用切菜单时把左栏整片重建，文字一个
// 字没变，节点全是新的。
//
// 在这之前，按节点认身份的那张表查不到新节点：五个菜单名再翻一遍，翻回来之前左栏
// 闪一下原文；更糟的是 <main> 的占比算进了我们自己的译文，左栏连译文一起被重建掉
// 的那一刻 <main> 被推过门槛，范围翻到 <main>，左栏从此不翻。
//
// 夹具照真实左栏写：`<div>` 不是 `<nav>`（`'main'` 范围本来就跳过 <nav>，那样测不
// 到问题），每次 go() 从数据重建 innerHTML。闪白用页面主世界的 rAF 逐帧计数 ——
// 判据是「有没有一帧画出来的左栏少于 5 条译文」，不是最后数一遍。
//
// 内置引擎桩（默认的自动引擎）：每段一次调用，计数和送出的原文都在内容脚本世界里
// （self.__builtinCalls / __builtinTexts）。mock AI 服务只是兜底，断言它一条也没收到。
const fs = require('fs');
const { test, expect } = require('./fixtures');
const { setExtensionSettings, evaluateInContentScript, stubBuiltinTranslator, waitForContentReady } = require('./helpers');
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
// 逐帧数左栏的译文：每一帧记一个数。frames 里出现 < 5 就是有一帧画出了原文。
window.startFrames = (selector) => {
  window.__frames = [];
  window.__framing = true;
  const tick = () => {
    window.__frames.push(document.querySelectorAll(selector).length);
    if (window.__framing) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
};
window.stopFrames = () => { window.__framing = false; return window.__frames; };
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

async function openLeftMenu(page, context, endpoint, { mainTag = 'div', beforeAuto } = {}) {
  await setExtensionSettings(page, settings(endpoint));
  await context.route(`https://${HOST}/**`, (route) => route.fulfill({
    status: 200, contentType: 'text/html', body: leftMenuHtml({ mainTag }),
  }));
  await page.goto(`https://${HOST}/home`);
  await waitForContentReady(page);
  await stubBuiltinTranslator(page);
  if (beforeAuto) await beforeAuto();
  await setExtensionSettings(page, settings(endpoint, { siteRules: { [HOST]: 'always' } }));
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

// 范围探针：每次先作废「退回 body」的缓存（发现层每一轮开头也是这一步），再问。
const SCOPE_PROBE = `(() => {
  const ctx = window.AI_TRANSLATOR_CONTENT;
  ctx.beginScopeRound();
  const scope = ctx.resolvePageScope();
  return { roots: scope.roots.map((root) => root.tagName), share: scope.share };
})()`;

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
      await page.evaluate((selector) => window.startFrames(selector), NAV_TRANSLATIONS);
      await switchTo(page, key);
      const frames = await page.evaluate(() => window.stopFrames());
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
      beforeAuto: async () => { beforeTranslation = await evaluateInContentScript(context, page, SCOPE_PROBE); },
    });
    expect(beforeTranslation.roots).toEqual(['BODY']);
    // 夹具要真的贴着门槛，否则这一条证明不了什么（见 MAIN 上方的注释）。
    expect(beforeTranslation.share).toBeGreaterThan(0.25);
    expect(beforeTranslation.share).toBeLessThan(0.3);

    const afterTranslation = await evaluateInContentScript(context, page, SCOPE_PROBE);
    expect(afterTranslation.roots).toEqual(['BODY']);
    expect(afterTranslation.share).toBeCloseTo(beforeTranslation.share, 2);

    for (const key of ['maps', 'hours']) {
      await switchTo(page, key);
      const afterRoute = await evaluateInContentScript(context, page, SCOPE_PROBE);
      expect(afterRoute.roots).toEqual(['BODY']);
      await expect(page.locator(NAV_TRANSLATIONS)).toHaveCount(5);
    }
    expect(navSent((await builtinTexts(context, page)).slice(6))).toBe(0);
  } finally {
    await mock.close();
  }
});

test('J4.5 with translations hidden, a menu switch shows no translation and restores them hidden', async ({ page, context }) => {
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
    await page.evaluate((selector) => window.startFrames(selector), shown);
    await page.evaluate(() => window.go('maps'));
    await page.waitForTimeout(1500);
    const frames = await page.evaluate(() => window.stopFrames());
    expect(frames.length).toBeGreaterThan(10);
    expect(frames.filter((count) => count > 0)).toEqual([]);
    // 藏着就是「我现在想看原文」：自动翻译停着，不发请求。
    expect((await builtinTexts(context, page)).length).toBe(beforeHidden);

    // 放出来：左栏从记忆里装回，一串不重发；只有藏着时换掉的正文进请求。
    await setVisible(true);
    await expect(page.locator(shown)).toHaveCount(5, { timeout: 30000 });
    await expect(page.locator('#main .ai-translator-inline-block')).toContainText(MAIN.maps.slice(0, 40), { timeout: 30000 });
    await page.waitForTimeout(1500);
    const revealed = (await builtinTexts(context, page)).slice(beforeHidden);
    expect(navSent(revealed)).toBe(0);
    expect(revealed).toHaveLength(1);

    // 装回走的是正常插入路径，隐藏态跟着插入走：藏着时装回的每一条都带隐藏态。
    // （藏着时发现层不跑，这里直接调装回入口 —— 它就是 onMutations 里那一步。）
    await setVisible(false);
    await page.evaluate(() => window.go('hours'));
    await expect(page.locator(NAV_TRANSLATIONS)).toHaveCount(0);
    const restored = await evaluateInContentScript(context, page,
      'window.AI_TRANSLATOR_CONTENT.recallTranslations([document.getElementById("nav")])');
    expect(restored).toBe(5);
    await expect(page.locator(NAV_TRANSLATIONS)).toHaveCount(5);
    await expect(page.locator(shown)).toHaveCount(0);
    expect(mock.sentTexts).toEqual([]);
  } finally {
    await mock.close();
  }
});

// D-543 第 6 点：≥2000 块的容器整片重建时，onMutations 里那一步同步装回要多久。
// 记忆先按真实入口填满（BlockIdentity.remember，键和 registerTranslation 写的一样），
// 发现层带宽之外的块自动翻译不会去翻，靠它们自己翻满 2000 条要几分钟。
// RERENDER_PERF_OUT 设了就把结果写进那个文件（证据目录的 perf.txt）。
const FEED_SIZE = 2000;
// 译文节点沿用源块的标签和 class（这里是 <p>），填记忆和挑远处那一行都得把我们
// 自己的节点排除掉，不然译文会被当原文记进去、挤掉最早的那几十条。

function feedHtml() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Feed</title></head><body>
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

test('D-543 perf: synchronous recall on a rebuilt container of 2000 blocks', async ({ page, context }) => {
  const mock = await startMockOpenAIServer();
  try {
    await setExtensionSettings(page, settings(mock.endpoint));
    await context.route(`https://${HOST}/**`, (route) => route.fulfill({
      status: 200, contentType: 'text/html', body: feedHtml(),
    }));
    await page.goto(`https://${HOST}/feed`);
    await waitForContentReady(page);
    await stubBuiltinTranslator(page);
    // 一条都没记过的页面：装回这一步直接返回，不收块。
    const idle = await evaluateInContentScript(context, page, `(() => {
      const ctx = window.AI_TRANSLATOR_CONTENT;
      const size = globalThis.BlockIdentity.memorySize();
      const feed = document.getElementById('feed');
      const start = performance.now();
      const restored = ctx.recallTranslations([feed]);
      return { size, restored, ms: performance.now() - start };
    })()`);
    expect(idle.size).toBe(0);
    expect(idle.restored).toBe(0);
    await setExtensionSettings(page, settings(mock.endpoint, { siteRules: { [HOST]: 'always' } }));
    await expect.poll(() => page.locator('#feed .ai-translator-inline-block').count(), { timeout: 30000 }).toBeGreaterThan(0);
    await page.waitForTimeout(1500);

    const seeded = await evaluateInContentScript(context, page, `(() => {
      const ctx = window.AI_TRANSLATOR_CONTENT;
      const identity = globalThis.BlockIdentity;
      const lang = ctx.currentTargetLang();
      for (const p of document.querySelectorAll('#feed > p:not(' + ctx.constants.OWN_NODES_SELECTOR + ')')) {
        const text = ctx.readSourceText(p);
        identity.remember(identity.fingerprint(text), lang, '[B] ' + text);
      }
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
      return identity.memorySize();
    })()`);
    expect(seeded).toBeGreaterThanOrEqual(FEED_SIZE);

    const callsBefore = (await builtinTexts(context, page)).length;
    const RUNS = 10;
    for (let i = 0; i < RUNS; i += 1) {
      await page.evaluate(() => window.rerender());
      await page.waitForTimeout(800);
    }
    for (let i = 0; i < RUNS; i += 1) {
      await page.evaluate(() => window.rerenderLaidOut());
      await page.waitForTimeout(800);
    }
    const all = await evaluateInContentScript(context, page, 'self.__recallMs.slice()');
    const recalled = await evaluateInContentScript(context, page, 'self.__recalled.slice()');
    const layoutMs = await page.evaluate(() => window.__layoutMs.slice());
    expect(all).toHaveLength(RUNS * 2);
    const ms = all.slice(0, RUNS);
    const ownMs = all.slice(RUNS);
    // 每次同步装回顶到装回预算（scope.js 的 RECALL_RESTORE_BUDGET）为止；剩下的
    // 进带时由发现层逐块从记忆装回，不发请求。
    expect(recalled.every((n) => n === 16)).toBe(true);
    // 远处那一块：滚过去，进带时装回，仍然不发请求。
    const far = page.locator('#feed > p:not(.ai-translator-inline-block)').nth(1200);
    await far.scrollIntoViewIfNeeded();
    await expect.poll(() => far.evaluate((p) => {
      const next = p.nextElementSibling;
      return !!(next && next.classList.contains('ai-translator-inline-block'))
        || !!p.querySelector('.ai-translator-inline-block');
    }), { timeout: 10000 }).toBe(true);
    expect((await builtinTexts(context, page)).length).toBe(callsBefore);

    const stats = (values) => {
      const sorted = values.slice().sort((a, b) => a - b);
      const median = (sorted[(values.length - 1) >> 1] + sorted[values.length >> 1]) / 2;
      return `median=${median.toFixed(2)}ms max=${sorted[values.length - 1].toFixed(2)}ms `
        + `all=[${values.map((v) => v.toFixed(2)).join(', ')}]`;
    };
    const line = `${FEED_SIZE} blocks rebuilt in one added root, scan budget 200 / restore budget 16, runs=${RUNS}\n`
      + `A recall per onMutations, page layout still pending: ${stats(ms)}\n`
      + `B page's own first layout of the rebuilt root: ${stats(layoutMs)}\n`
      + `C recall per onMutations, page layout already done: ${stats(ownMs)}\n`
      + `memorySize()=0 (before any translation): restored=${idle.restored} in ${idle.ms.toFixed(3)}ms`;
    console.log(`PERF ${line}`);
    if (process.env.RERENDER_PERF_OUT) fs.writeFileSync(process.env.RERENDER_PERF_OUT, `${line}\n`);
    expect(mock.sentTexts).toEqual([]);
  } finally {
    await mock.close();
  }
});
