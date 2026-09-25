// 整页翻译覆盖面（P1-A2）：整扩展旅程 J-5～J-8。
//
// 夹具走 context.route，翻译走 mock-openai-server（回 `[T] 原文`）。
//   - 「翻了」= 对应位置出现带 `[T]` 的译文节点；
//   - 「没翻」= 那一片零 ai-translator 节点，**并且**原文不在 sentTexts 里——只看
//     DOM 证明不了「没发出去」，而钱是在发出去那一刻花掉的。
//
// DOM 夹具部分（不变式、notranslate 判定表、MAIN_TEXT_SHARE 调参）在
// page-coverage-harness.spec.js。
const { test, expect } = require('./fixtures');
const {
  setExtensionSettings,
  openFloatBallMenu,
  triggerPageTranslation,
  waitForTranslationComplete,
  sendMessageToActiveTab,
  getSyncSetting,
} = require('./helpers');
const { startMockOpenAIServer } = require('./mock-openai-server');

const ORIGIN = 'https://coverage.test';
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

async function serve(context, pages) {
  await context.route(`${ORIGIN}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = pages[path];
    if (!body) return route.fulfill({ status: 404, body: 'not found' });
    return route.fulfill({ status: 200, contentType: 'text/html', body });
  });
}

const sent = (sentTexts, text) => sentTexts.some((chunk) => chunk.includes(text));

// ---- J-5 Shadow DOM ----

const OPEN_TEXT = 'A paragraph living inside an open shadow root component.';
const CLOSED_TEXT = 'A paragraph hidden inside a closed shadow root component.';
const SLOTTED_TEXT = 'A slotted paragraph that the component shows in its body slot.';
const LATE_TEXT = 'A late paragraph appended to the open shadow root after translation.';

const SHADOW_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Components</title></head>
<body>
  <p id="light">A light paragraph that sits outside every component on this page.</p>
  <open-card id="open-host"></open-card>
  <closed-card id="closed-host"></closed-card>
  <slot-card id="slot-host"><p id="slotted" slot="body">${SLOTTED_TEXT}</p></slot-card>
  <script>
    customElements.define('open-card', class extends HTMLElement {
      constructor() {
        super();
        this.attachShadow({ mode: 'open' }).innerHTML =
          '<div class="wrap"><p id="open-p">${OPEN_TEXT}</p></div>';
      }
    });
    customElements.define('closed-card', class extends HTMLElement {
      constructor() {
        super();
        const root = this.attachShadow({ mode: 'closed' });
        root.innerHTML = '<p id="closed-p">${CLOSED_TEXT}</p>';
        window.__closedRoot = root;
      }
    });
    // 具名 slot，外加一个默认 slot 都没有：译文不带同一个 slot 属性就根本不渲染。
    customElements.define('slot-card', class extends HTMLElement {
      constructor() {
        super();
        this.attachShadow({ mode: 'open' }).innerHTML =
          '<div class="frame" style="padding:8px;border:1px solid #ccc"><slot name="body"></slot></div>';
      }
    });
  </script>
</body></html>`;

test('J-5 shadow DOM: open, closed and slotted components are translated, styled and followed', async ({ page, context }) => {
  const { close, endpoint, sentTexts } = await startMockOpenAIServer();
  try {
    await setExtensionSettings(page, settings(endpoint));
    await serve(context, { '/components': SHADOW_PAGE });
    await page.goto(`${ORIGIN}/components`);
    await page.waitForSelector('#ai-translator-float-ball');

    await triggerPageTranslation(page);
    await waitForTranslationComplete(page);

    // 2. 三个组件都有译文（译文在 shadow 里的，从 root 里取）。
    const translations = () => page.evaluate(() => {
      const text = (el) => (el ? el.textContent : null);
      return {
        open: text(document.getElementById('open-host').shadowRoot.querySelector('.ai-translator-inline-block')),
        closed: text(window.__closedRoot.querySelector('.ai-translator-inline-block')),
        // 带 slot 属性的块，insert.js 把译文插在块内部（:520）；若是兄弟，就得带同一个 slot。
        slotted: text(document.querySelector('#slot-host .ai-translator-inline-block')),
      };
    });
    await expect.poll(translations, { timeout: 30000 }).toEqual({
      open: `[T] ${OPEN_TEXT}`,
      closed: `[T] ${CLOSED_TEXT}`,
      slotted: `[T] ${SLOTTED_TEXT}`,
    });
    expect(sent(sentTexts, OPEN_TEXT)).toBe(true);
    expect(sent(sentTexts, CLOSED_TEXT)).toBe(true);

    // 3. shadow 里的译文吃到了 translation.css：文档里的样式表进不了 shadow 树，
    //    没有我们装进去的那份，animation-name 只会是 none。
    const animation = () => page.evaluate(() => {
      const open = document.getElementById('open-host').shadowRoot.querySelector('.ai-translator-inline-block');
      const closed = window.__closedRoot.querySelector('.ai-translator-inline-block');
      return [getComputedStyle(open).animationName, getComputedStyle(closed).animationName];
    });
    await expect.poll(animation, { timeout: 10000 })
      .toEqual(['ai-translator-block-fade-in', 'ai-translator-block-fade-in']);

    // 4. slot 译文真的渲染出来了：盒子非零，且落在宿主的盒子里。
    const slot = await page.evaluate(() => {
      const host = document.getElementById('slot-host').getBoundingClientRect();
      const el = document.querySelector('#slot-host .ai-translator-inline-block');
      const box = el.getBoundingClientRect();
      return {
        // 译文是宿主的直接子节点（块的兄弟）时，必须和块进同一个具名 slot。
        slotOk: el.parentElement.id !== 'slot-host' || el.getAttribute('slot') === 'body',
        width: box.width,
        height: box.height,
        inside: box.left >= host.left - 0.5 && box.right <= host.right + 0.5 &&
          box.top >= host.top - 0.5 && box.bottom <= host.bottom + 0.5,
      };
    });
    expect(slot.slotOk).toBe(true);
    expect(slot.width).toBeGreaterThan(0);
    expect(slot.height).toBeGreaterThan(0);
    expect(slot.inside).toBe(true);

    // 5. 翻完之后往 open root 里追加一段外文，它也被跟翻。跟翻走的是 light DOM
    //    新内容今天的同一条路：点过「翻译整页」的页面（markPageExplicit）由发现层
    //    接着翻长出来的内容，发现层现在也观察登记过的 shadow root。
    await page.evaluate((text) => {
      const wrap = document.getElementById('open-host').shadowRoot.querySelector('.wrap');
      const p = document.createElement('p');
      p.id = 'late';
      p.textContent = text;
      wrap.appendChild(p);
    }, LATE_TEXT);
    await expect.poll(() => page.evaluate(() => {
      const late = document.getElementById('open-host').shadowRoot.getElementById('late');
      const next = late && late.nextElementSibling;
      return next && next.classList.contains('ai-translator-inline-block') ? next.textContent : null;
    }), { timeout: 30000 }).toBe(`[T] ${LATE_TEXT}`);
    expect(sent(sentTexts, LATE_TEXT)).toBe(true);
  } finally {
    await close();
  }
});

// ---- J-6 notranslate ----

const NT = {
  plain: 'A plain paragraph on a page whose html element says translate no.',
  attrNo: 'The author marked this paragraph with translate equals no.',
  classNo: 'Everything inside this notranslate container stays in English.',
  reopen: 'This paragraph is reopened with translate equals yes inside a closed box.',
  brandLead: 'Our new release of',
  brandTail: 'loads the dashboard twice as fast.',
};

const NOTRANSLATE_PAGE = `<!doctype html>
<html lang="en" translate="no"><head><meta charset="utf-8"><title>Release notes</title></head>
<body>
  <p id="plain">${NT.plain}</p>
  <p id="attr-no" translate="no">${NT.attrNo}</p>
  <div id="class-box" class="notranslate"><p id="class-no">${NT.classNo}</p></div>
  <div id="reopen-box" translate="no"><p id="reopen" translate="yes">${NT.reopen}</p></div>
  <p id="brand">${NT.brandLead} <span class="notranslate">BrandX</span> ${NT.brandTail}</p>
</body></html>`;

test('J-6 notranslate: element-level declarations are honoured, the page-level one is not', async ({ page, context }) => {
  const { close, endpoint, sentTexts } = await startMockOpenAIServer();
  try {
    await setExtensionSettings(page, settings(endpoint));
    await serve(context, { '/notes': NOTRANSLATE_PAGE });
    await page.goto(`${ORIGIN}/notes`);
    await page.waitForSelector('#ai-translator-float-ball');

    await triggerPageTranslation(page);
    await waitForTranslationComplete(page);

    // 1. <html translate="no"> 的页面照样翻。
    await expect(page.locator('#plain + .ai-translator-inline-block')).toHaveText(`[T] ${NT.plain}`, { timeout: 30000 });
    // 3. translate="no" 容器里被 translate="yes" 重新打开的段落被翻。
    await expect(page.locator('#reopen + .ai-translator-inline-block')).toHaveText(`[T] ${NT.reopen}`);
    // 4. 行内 notranslate 原样出现在译文里，且名字本身没有发出去。
    const brand = page.locator('#brand + .ai-translator-inline-block');
    await expect(brand).toContainText('[T]');
    await expect(brand).toContainText(NT.brandTail);
    await expect(brand.locator('span.notranslate')).toHaveText('BrandX');
    expect(sent(sentTexts, NT.brandLead)).toBe(true);
    expect(sentTexts.some((chunk) => chunk.includes('BrandX'))).toBe(false);

    // 2. translate="no" 段落与 .notranslate 容器：零译文节点，也不在 sentTexts 里。
    await expect(page.locator(`#attr-no ${ANY_OURS}, #attr-no${ANY_OURS}`)).toHaveCount(0);
    await expect(page.locator(`#class-box ${ANY_OURS}, #class-box${ANY_OURS}`)).toHaveCount(0);
    await expect(page.locator('#attr-no + .ai-translator-inline-block')).toHaveCount(0);
    expect(sent(sentTexts, NT.attrNo)).toBe(false);
    expect(sent(sentTexts, NT.classNo)).toBe(false);
  } finally {
    await close();
  }
});

// ---- J-7 / J-8 正文范围 ----

const NEWS = {
  siteTitle: 'The Harbour Gazette daily edition',
  tagline: 'Independent reporting from the northern coast since the year 1921.',
  nav1: 'World news and politics section',
  nav2: 'Sport results and fixtures section',
  storyTitle: 'Ferry service resumes after the long winter storms',
  byline: 'Reported by our harbour correspondent early this morning.',
  p1: 'The first crossing of the season left the northern pier at a quarter past six, carrying more passengers than the harbour office had expected for a weekday morning.',
  p2: 'Crews spent most of the winter repairing the landing stage, which was damaged twice in January when the storms pushed waves over the breakwater and into the car park.',
  p3: 'The operator says the afternoon service will return next week, once the second vessel has passed its safety inspection at the yard across the bay.',
  storyNote: 'Additional reporting for this story was contributed by the regional desk.',
  aside: 'The most read stories of the week are collected in this sidebar panel.',
  footer: 'Copyright notice and contact details for the newspaper office.',
};

function newsPage({ withMain }) {
  const article = `<article id="story">
      <header id="story-header"><h2 id="story-title">${NEWS.storyTitle}</h2><p id="byline">${NEWS.byline}</p></header>
      <p id="p1">${NEWS.p1}</p>
      <p id="p2">${NEWS.p2}</p>
      <p id="p3">${NEWS.p3}</p>
      <footer id="story-footer"><p id="story-note">${NEWS.storyNote}</p></footer>
    </article>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Harbour Gazette</title></head>
<body>
  <header id="site-header"><h1 id="site-title">${NEWS.siteTitle}</h1><p id="tagline">${NEWS.tagline}</p></header>
  <nav id="site-nav"><ul><li id="nav1">${NEWS.nav1}</li><li id="nav2">${NEWS.nav2}</li></ul></nav>
  ${withMain ? `<main id="main">${article}</main>` : article}
  <aside id="sidebar"><p id="aside-p">${NEWS.aside}</p></aside>
  <footer id="site-footer"><p id="footer-p">${NEWS.footer}</p></footer>
</body></html>`;
}

const NEWS_PAGES = { '/news': newsPage({ withMain: true }), '/news-nomain': newsPage({ withMain: false }) };

// 段落的译文是兄弟节点；列表项的译文插在条目内部（insert.js 的 INSIDE_ONLY_TAGS）。
const translationAfter = (page, id) =>
  page.locator(`#${id} + .ai-translator-inline-block, #${id} > .ai-translator-inline-block`);

// 正文、文章自己的页眉页脚、站点页眉里的 h1：翻了。
async function expectArticleTranslated(page) {
  for (const id of ['p1', 'p2', 'p3', 'story-title', 'byline', 'story-note', 'site-title']) {
    await expect(translationAfter(page, id)).toContainText('[T]', { timeout: 30000 });
  }
}

// 导航、侧栏、站点页眉的其余内容、站点页脚：零译文节点，原文也没发出去。
async function expectChromeUntranslated(page, sentTexts) {
  for (const id of ['site-nav', 'sidebar', 'site-footer']) {
    await expect(page.locator(`#${id} ${ANY_OURS}`)).toHaveCount(0);
  }
  await expect(page.locator(`#tagline${ANY_OURS}, #tagline ~ ${ANY_OURS}`)).toHaveCount(0);
  for (const text of [NEWS.nav1, NEWS.nav2, NEWS.aside, NEWS.footer, NEWS.tagline]) {
    expect(sent(sentTexts, text), `sent: ${text}`).toBe(false);
  }
}

async function expectChromeTranslated(page) {
  for (const id of ['nav1', 'nav2', 'aside-p']) {
    await expect(translationAfter(page, id)).toContainText('[T]', { timeout: 30000 });
  }
}

const WHOLE_PAGE_ITEM = '.ai-translator-menu-item[data-action="translate-whole-page"]';

test('J-7 main-content scope: the article is translated, site chrome is not, and the whole page is one click away', async ({ page, context }) => {
  const { close, endpoint, sentTexts } = await startMockOpenAIServer();
  try {
    await setExtensionSettings(page, settings(endpoint));
    await serve(context, NEWS_PAGES);
    await page.goto(`${ORIGIN}/news`);
    await page.waitForSelector('#ai-translator-float-ball');

    // 2. 默认 'main'：正文 + 文章页眉 + 站点 h1 翻了，其余零译文、零发送。
    await triggerPageTranslation(page);
    await waitForTranslationComplete(page);
    await expectArticleTranslated(page);
    await expectChromeUntranslated(page, sentTexts);

    // 3. 悬浮菜单里有「翻译整个页面」，它在菜单盒子里，菜单在视口里。
    await openFloatBallMenu(page);
    const item = page.locator(WHOLE_PAGE_ITEM);
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

    // 4. 真点这一项：导航、侧栏补翻出来，正文不重复发。
    const p1Sends = sentTexts.filter((chunk) => chunk.includes(NEWS.p1)).length;
    await item.click();
    await expectChromeTranslated(page);
    expect(sent(sentTexts, NEWS.nav1)).toBe(true);
    expect(sent(sentTexts, NEWS.aside)).toBe(true);
    expect(sentTexts.filter((chunk) => chunk.includes(NEWS.p1)).length).toBe(p1Sends);
    await expect(translationAfter(page, 'p1')).toHaveCount(1);
  } finally {
    await close();
  }
});

test('J-7 Alt+W path: TRANSLATE_WHOLE_PAGE translates the chrome too', async ({ page, context }) => {
  const { close, endpoint, sentTexts } = await startMockOpenAIServer();
  try {
    await setExtensionSettings(page, settings(endpoint));
    await serve(context, NEWS_PAGES);
    await page.goto(`${ORIGIN}/news`);
    await page.waitForSelector('#ai-translator-float-ball');

    // 5. 夹具隔离子步骤：e2e 合成不了 chrome.commands 的 Alt+W，这里直接发
    //    命令处理器会发的那条消息。处理器只发给顶层 frame（{ frameId: 0 }）
    //    由 test/unit/page-coverage.test.mjs 守着。
    await sendMessageToActiveTab(page, { type: 'TRANSLATE_WHOLE_PAGE' });
    await expectArticleTranslated(page);
    await expectChromeTranslated(page);
    expect(sent(sentTexts, NEWS.nav1)).toBe(true);
    expect(sent(sentTexts, NEWS.footer)).toBe(true);

    // 本页已是整页范围：菜单里不再给「翻译整个页面」。
    await openFloatBallMenu(page);
    await expect(page.locator(WHOLE_PAGE_ITEM)).toHaveCount(0);
  } finally {
    await close();
  }
});

test('J-7 without <main>: the scope falls back to body with the same distribution', async ({ page, context }) => {
  const { close, endpoint, sentTexts } = await startMockOpenAIServer();
  try {
    await setExtensionSettings(page, settings(endpoint));
    await serve(context, NEWS_PAGES);
    await page.goto(`${ORIGIN}/news-nomain`);
    await page.waitForSelector('#ai-translator-float-ball');

    // 6. 没有 <main>：根退回 body，跳过规则照旧；页面级 <header> 里的 h1 照翻。
    await triggerPageTranslation(page);
    await waitForTranslationComplete(page);
    await expectArticleTranslated(page);
    await expectChromeUntranslated(page, sentTexts);
  } finally {
    await close();
  }
});

test('J-7 in an iframe: the whole-page menu item carries the scope into the child frame', async ({ page, context }) => {
  // 顶层把整页覆盖放进指令（content/frames/top.js），子 frame 照着设和清
  // （content/frames/child.js 的 applyDirective）。iframe 给足尺寸：尺寸闸是
  // content/frames/shelf.js 的 120×40，这里远远超过，它不是翻或不翻的原因。
  const TOP_LEAD = 'This page embeds the harbour newspaper below so readers can follow it here.';
  const pages = {
    ...NEWS_PAGES,
    '/framed': `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Framed gazette</title></head>
<body>
  <p id="top-lead">${TOP_LEAD}</p>
  <iframe id="news-frame" src="${ORIGIN}/news" width="1000" height="900" style="border:0;display:block"></iframe>
</body></html>`,
  };
  const { close, endpoint, sentTexts } = await startMockOpenAIServer();
  try {
    await setExtensionSettings(page, settings(endpoint));
    await serve(context, pages);
    await page.goto(`${ORIGIN}/framed`);
    await page.waitForSelector('#ai-translator-float-ball');
    const frame = page.frameLocator('#news-frame');
    await expect(frame.locator('#p1')).toBeVisible();

    // 1. 正常入口（悬浮菜单「翻译此页面」）：iframe 里正文翻了，导航没翻、没发。
    await triggerPageTranslation(page);
    await expect(frame.locator('#p1 + .ai-translator-inline-block')).toContainText('[T]', { timeout: 30000 });
    await expect(frame.locator('#story-title + .ai-translator-inline-block')).toContainText('[T]', { timeout: 30000 });
    await expect(frame.locator(`#site-nav ${ANY_OURS}`)).toHaveCount(0);
    await expect(frame.locator(`#sidebar ${ANY_OURS}`)).toHaveCount(0);
    expect(sent(sentTexts, NEWS.nav1)).toBe(false);
    expect(sent(sentTexts, NEWS.aside)).toBe(false);

    // 2. 真点顶层悬浮菜单的「翻译整个页面」：iframe 里的导航、侧栏也翻了。
    await openFloatBallMenu(page);
    await page.locator(WHOLE_PAGE_ITEM).click();
    for (const id of ['nav1', 'nav2']) {
      await expect(frame.locator(`#${id} > .ai-translator-inline-block`)).toContainText('[T]', { timeout: 30000 });
    }
    await expect(frame.locator('#aside-p + .ai-translator-inline-block')).toContainText('[T]', { timeout: 30000 });
    expect(sent(sentTexts, NEWS.nav1)).toBe(true);
    // 正文没有再发一遍。
    await expect(frame.locator('#p1 + .ai-translator-inline-block')).toHaveCount(1);
  } finally {
    await close();
  }
});

test('J-8 options: choosing "Whole page" is stored and takes effect on the next page', async ({ page, context, extensionId }) => {
  const { close, endpoint, sentTexts } = await startMockOpenAIServer();
  try {
    // 选项页每次自动保存都写整张表单：服务商不是 custom 时，接口地址会被换成
    // 服务商的官方地址。mock 端点是自定义接口，照真实用户那样存成 custom。
    await setExtensionSettings(page, settings(endpoint, { provider: 'custom' }));
    await serve(context, NEWS_PAGES);

    // 1. 在选项页的真实控件上选「翻译整个页面」。
    await page.goto(`chrome-extension://${extensionId}/options/options.html`);
    const select = page.locator('#pageTranslateScope');
    await expect(select).toBeVisible();
    await expect(select).toHaveValue('main');
    await select.selectOption('page');

    // 2. 没有保存按钮：选了就存。
    await expect.poll(() => getSyncSetting(context, 'pageTranslateScope')).toBe('page');

    // 3. 重新打开新闻夹具：菜单里没有「翻译整个页面」（整页已是默认），翻译后导航也翻了。
    await page.goto(`${ORIGIN}/news`);
    await page.waitForSelector('#ai-translator-float-ball');
    await openFloatBallMenu(page);
    await expect(page.locator(WHOLE_PAGE_ITEM)).toHaveCount(0);
    await page.click('.ai-translator-menu-item[data-action="translate-page"]');
    await waitForTranslationComplete(page);
    await expectArticleTranslated(page);
    await expectChromeTranslated(page);
    expect(sent(sentTexts, NEWS.nav1)).toBe(true);
  } finally {
    await close();
  }
});
