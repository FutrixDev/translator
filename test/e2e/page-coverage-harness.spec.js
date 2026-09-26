// 整页翻译覆盖面（P1-A2）的 DOM 夹具部分：真收集器、真范围模块，普通无头页面，
// 不装扩展、不走网络。整扩展的旅程（J-5～J-8）在 page-coverage.spec.js。
//
// 这里守三件浏览器之外看不出、浏览器里一眼就能量的事：
//
//   1. 不变式：一个既没有 <main>、也没有任何跳过元素的页面，'main' 与 'page'
//      收到的块逐个相同（按元素身份）。正文范围只减去页面自己标明的非正文，不做
//      启发式抽取——这条不变式就是「不做」的可检验形式。
//   2. notranslate 判定表：class / 属性 / yes 重开 / 行内 / 跨 shadow 边界，
//      每种一正一反。
//   3. MAIN_TEXT_SHARE 的调参夹具：几种常见版式各自算出的正文占比，和据此选出的根。
//   4. shadow 样式的改写（background/page-coverage.js 的 toShadowCss）在真浏览器里
//      生效：挂在 <html> 上的条件经 :host-context 进得了 shadow root。
//   5. 我们自己的界面（原文速览卡）不进收集。
//   6. 正文范围的缓存接在真入口上：发现层一批只数一次 body，后来长大的 <main>
//      下一批发现、下一次手动翻译都认得出。
//   7. 分进 shadow 里隐藏 slot 的内容不读：它自己的 display 正常，藏住它的是
//      shadow 树里 slot 的祖先。
const path = require('path');
const fs = require('fs');
const { test, expect } = require('@playwright/test');
const { contentHarnessScripts, PAGE_TRANSLATION_MODULES } = require('./helpers');

const REPO = path.resolve(__dirname, '../..');

const SCRIPTS = contentHarnessScripts(...PAGE_TRANSLATION_MODULES);

async function loadHarness(page, html, scripts = SCRIPTS) {
  await page.setContent(html, { waitUntil: 'load' });
  for (const s of scripts) await page.addScriptTag({ path: s });
}

function doc(body, htmlAttrs = 'lang="en"') {
  return `<!doctype html><html ${htmlAttrs}><head><meta charset="utf-8"></head><body>${body}</body></html>`;
}

// 两种设置各收一遍，按元素身份逐个比。
async function blocksUnderBothModes(page) {
  return page.evaluate(() => {
    const ctx = window.AI_TRANSLATOR_CONTENT;
    const collect = (mode) => {
      ctx.settings.pageTranslateScope = mode;
      ctx.invalidatePageScope();
      const scope = ctx.resolvePageScope();
      return { mode: scope.mode, root: scope.roots[0].localName, elements: ctx.collectPageBlocks().map((b) => b.element) };
    };
    const main = collect('main');
    const page = collect('page');
    return {
      mainMode: main.mode,
      pageMode: page.mode,
      mainRoot: main.root,
      count: main.elements.length,
      sameLength: main.elements.length === page.elements.length,
      sameElements: main.elements.every((el, i) => el === page.elements[i]),
      ids: main.elements.map((el) => el.id || el.localName),
    };
  });
}

const PLAIN_FIXTURES = {
  'blog post in divs': doc(`
    <div class="site-title"><h1 id="t">Notes from a small workshop by the river</h1></div>
    <div class="menu-bar"><a href="/a">Archive of older posts</a> <a href="/b">About the author</a></div>
    <div class="post">
      <h2 id="h">Sharpening a plane iron by hand</h2>
      <p id="p1">The first thing to check is whether the back of the iron is flat enough to hold an edge.</p>
      <p id="p2">After that, a few passes on the finer stone are usually all that the bevel needs.</p>
      <ul><li id="l1">A coarse stone for shaping the bevel</li><li id="l2">A fine stone for polishing the edge</li></ul>
    </div>
    <div class="bottom"><p id="c">Written in the spring and revised over the following summer.</p></div>`),
  'product page with a table': doc(`
    <div id="top"><span class="brand">Riverside Tools Company</span></div>
    <div class="product">
      <h1 id="name">Block plane with an adjustable mouth</h1>
      <p id="desc">This small plane fits in one hand and trims end grain without tearing the fibres.</p>
      <table><tr><th id="th1">Length of the body</th><td id="td1">Six and a half inches overall</td></tr>
        <tr><th id="th2">Weight of the plane</th><td id="td2">Just over one pound in total</td></tr></table>
      <blockquote id="q">It is the plane I reach for first whenever a joint needs fitting.</blockquote>
    </div>`),
  'forum thread with sections only': doc(`
    <section class="thread">
      <h2 id="subject">Which finish holds up best on a kitchen table?</h2>
      <div class="post"><p id="m1">I have tried oil and wax, but both wear through near the edges within a year.</p></div>
      <div class="post"><p id="m2">A hard varnish lasts longer, though it is harder to repair when it scratches.</p></div>
      <div class="post"><p id="m3">We use a hardwax oil and simply reapply it every spring after cleaning.</p></div>
    </section>
    <div class="legal"><p id="legal">Posts are the opinions of their authors and not of the forum.</p></div>`),
};

test.describe('scope invariant: no <main>, nothing to skip', () => {
  for (const [name, html] of Object.entries(PLAIN_FIXTURES)) {
    test(`'main' and 'page' collect the same blocks: ${name}`, async ({ page }) => {
      await loadHarness(page, html);
      const r = await blocksUnderBothModes(page);
      expect(r.mainMode).toBe('main');
      expect(r.pageMode).toBe('page');
      // 退回 body：没有 <main>。
      expect(r.mainRoot).toBe('body');
      expect(r.count).toBeGreaterThan(3);
      expect(r.sameLength).toBe(true);
      expect(r.sameElements).toBe(true);
    });
  }
});

// ---- notranslate 判定表 ----

const NOTRANSLATE_FIXTURE = doc(`
  <p id="plain">A plain paragraph with nothing declared anywhere above it.</p>

  <p id="attr-no" translate="no">A paragraph that its author marked with translate equals no.</p>
  <p id="attr-maybe" translate="maybe">An invalid translate value counts as if nothing was written.</p>
  <div translate="no"><p id="attr-inherit">A child of a translate equals no container is left alone.</p></div>

  <div class="notranslate"><p id="class-no">A child of a notranslate container is left alone as well.</p></div>
  <p id="class-beats-attr" class="notranslate" translate="yes">The class wins when both appear on one element.</p>
  <div class="notranslateish"><p id="class-lookalike">A class that only looks like notranslate means nothing.</p></div>

  <div translate="no">
    <p id="reopen" translate="yes">A paragraph reopened with translate equals yes inside a closed box.</p>
    <p id="reopen-sibling">Its sibling without a declaration stays closed like the box.</p>
    <div translate=""><p id="reopen-empty">An empty translate attribute reopens the subtree as well.</p></div>
  </div>

  <p id="inline">Our new release of <span class="notranslate">BrandX</span> loads the dashboard twice as fast.</p>
  <p id="inline-attr">Please ask <b translate="no">Ada Lovelace</b> before you change the schedule.</p>
  <p id="inline-nested">Try <span translate="no">Studio <span translate="yes">Pro</span></span> for the larger projects.</p>
  <p id="inline-none">Nothing here is marked, so every word of this sentence is sent out.</p>
  <p id="inline-only"><span class="notranslate">BrandX Studio</span></p>

  <div translate="no"><x-card id="host-closed"></x-card></div>
  <x-card id="host-open"></x-card>
  <div translate="no"><x-card id="host-reopen" data-inner-yes></x-card></div>
  <x-card id="host-inner-no" data-inner-no></x-card>
`, 'lang="en" translate="no"');

// 组件在夹具的 addScriptTag 之前定义：收集器第一次遍历时 shadow root 已经在了。
async function defineCards(page) {
  await page.evaluate(() => {
    customElements.define('x-card', class extends HTMLElement {
      connectedCallback() {
        if (this.shadowRoot) return;
        const root = this.attachShadow({ mode: 'open' });
        const id = this.id;
        const attr = this.hasAttribute('data-inner-yes') ? ' translate="yes"'
          : this.hasAttribute('data-inner-no') ? ' translate="no"' : '';
        root.innerHTML = `<div><p id="${id}-p"${attr}>A paragraph rendered inside the shadow root of ${id}.</p></div>`;
      }
    });
  });
}

test('notranslate: the ruling table', async ({ page }) => {
  await page.setContent(NOTRANSLATE_FIXTURE, { waitUntil: 'load' });
  await defineCards(page);
  for (const s of SCRIPTS) await page.addScriptTag({ path: s });

  const r = await page.evaluate(() => {
    const ctx = window.AI_TRANSLATOR_CONTENT;
    // 不带 scope 的调用：notranslate 与范围无关，直接调收集器也照样判。
    const blocks = ctx.collectTranslatableBlocks(document.body);
    const byId = Object.fromEntries(blocks.map((b) => [b.element.id, b]));
    return {
      ids: blocks.map((b) => b.element.id),
      inlineText: byId.inline && byId.inline.text,
      inlineAttrText: byId['inline-attr'] && byId['inline-attr'].text,
      nestedText: byId['inline-nested'] && byId['inline-nested'].text,
      noneText: byId['inline-none'] && byId['inline-none'].text,
    };
  });

  // <html translate="no"> 不认：页面照翻。
  expect(r.ids).toContain('plain');
  // 属性：no 不翻，无效值等于没写，no 往下继承。
  expect(r.ids).not.toContain('attr-no');
  expect(r.ids).toContain('attr-maybe');
  expect(r.ids).not.toContain('attr-inherit');
  // class：notranslate 不翻；同一元素上 class 压过 translate="yes"；形似的类名不算。
  expect(r.ids).not.toContain('class-no');
  expect(r.ids).not.toContain('class-beats-attr');
  expect(r.ids).toContain('class-lookalike');
  // yes 重开：yes 与空串重开子树，没声明的兄弟仍随外层关着。
  expect(r.ids).toContain('reopen');
  expect(r.ids).toContain('reopen-empty');
  expect(r.ids).not.toContain('reopen-sibling');
  // 行内：no 变成元素占位符，名字本身不进待翻文本。
  expect(r.inlineText).toMatch(/\{\{\d+\}\}/);
  expect(r.inlineText).not.toContain('BrandX');
  expect(r.inlineAttrText).not.toContain('Ada Lovelace');
  // 行内 no 里嵌行内 yes：整个 no 元素原样保留（不在一句话里挖洞翻一个词）。
  expect(r.nestedText).not.toContain('Studio');
  expect(r.nestedText).not.toContain('Pro');
  // 反例：没声明的行内内容一字不少。
  expect(r.noneText).not.toMatch(/\{\{\d+\}\}/);
  // 整块只剩一个 notranslate 行内元素：不收，不发请求。
  expect(r.ids).not.toContain('inline-only');
  // 跨 shadow 边界：外层 no 管到 shadow 里；没被管的组件照收；shadow 里的 yes 重开、no 关掉。
  expect(r.ids).not.toContain('host-closed-p');
  expect(r.ids).toContain('host-open-p');
  expect(r.ids).toContain('host-reopen-p');
  expect(r.ids).not.toContain('host-inner-no-p');
});

test('notranslate: <body class="notranslate"> is a document-level declaration and is ignored', async ({ page }) => {
  await loadHarness(page, doc(`<p id="p">A paragraph on a page whose body says notranslate.</p>`));
  const ids = await page.evaluate(() => {
    document.body.classList.add('notranslate');
    document.body.setAttribute('translate', 'no');
    return window.AI_TRANSLATOR_CONTENT.collectTranslatableBlocks(document.body).map((b) => b.element.id);
  });
  expect(ids).toEqual(['p']);
});

// ---- 分进隐藏 slot 的内容 ----
//
// Reddit 卡片头那一行（`span[slot=credit-bar]`）直属子元素全是 <span>，整行是一个
// 内联块。行里的「更多」菜单是 <faceplate-menu slot="content">，分进 <rpl-dropdown>
// shadow 里一个 hidden 的弹层——菜单项自己的 computed display 是 inline，逐个看
// display 的判断看不出它不渲染，于是「Award / Share / Report」进了这一行的原文。
// 这里用同形的组件夹具：一个弹层 hidden，一个不 hidden，只差这一处。
async function defineMenus(page) {
  await page.evaluate(() => {
    const define = (name, popover) => customElements.define(name, class extends HTMLElement {
      connectedCallback() {
        if (this.shadowRoot) return;
        this.attachShadow({ mode: 'open' }).innerHTML = `<slot></slot><div ${popover}><slot name="content"></slot></div>`;
      }
    });
    define('x-menu-closed', 'hidden');
    define('x-menu-open', '');
  });
}

// 行本身是 <span>、直属子元素也只有 <span>，和真页面一样：整行走内联分支，一次读完。
const HIDDEN_SLOT_FIXTURE = doc(`
  <div><span id="closed-row"><span class="author">Posted by a reader who likes long walks by the river</span>
    <span class="menu"><x-menu-closed><button>More</button><span slot="content" id="closed-item">Award this post</span></x-menu-closed></span></span></div>
  <div><span id="open-row"><span class="author">Posted by another reader who prefers the mountains</span>
    <span class="menu"><x-menu-open><button>More</button><span slot="content" id="open-item">Share this post</span></x-menu-open></span></span></div>
`);

test('hidden slot: text slotted into a hidden part of a shadow tree is not read into its row', async ({ page }) => {
  await page.setContent(HIDDEN_SLOT_FIXTURE, { waitUntil: 'load' });
  await defineMenus(page);
  for (const s of SCRIPTS) await page.addScriptTag({ path: s });

  const r = await page.evaluate(() => {
    const ctx = window.AI_TRANSLATOR_CONTENT;
    const blocks = ctx.collectTranslatableBlocks(document.body);
    const textOf = (id) => (blocks.find((b) => b.element.id === id) || {}).text;
    const closedItem = document.getElementById('closed-item');
    return {
      ids: blocks.map((b) => b.element.id || b.element.localName),
      closedRow: textOf('closed-row'),
      openRow: textOf('open-row'),
      // 根因的形状：菜单项自己的 display 正常，藏住它的是 shadow 里 slot 的祖先。
      ownDisplay: getComputedStyle(closedItem).display,
      closedHidden: ctx.inHiddenSlot(closedItem),
      openHidden: ctx.inHiddenSlot(document.getElementById('open-item')),
      authorHidden: ctx.inHiddenSlot(document.querySelector('#closed-row .author')),
    };
  });

  expect(r.ownDisplay).toBe('inline');
  expect(r.closedHidden).toBe(true);
  expect(r.openHidden).toBe(false);
  expect(r.authorHidden).toBe(false);

  // 两行各是一块，菜单项没有被拆出去单独成块。
  expect(r.ids).toEqual(['closed-row', 'open-row']);
  expect(r.closedRow).toContain('long walks by the river');
  expect(r.closedRow).not.toContain('Award this post');
  // 反例：弹层没藏，分进去的字就是看得见的字，照读。
  expect(r.openRow).toContain('Share this post');
});

// ---- 我们自己的界面不进收集 ----

test('own UI: the text in the source peek card is never collected', async ({ page }) => {
  // 卡走 content/page/display.js 的真路径：仅译文下一条整页译文的原文藏着，鼠标停在
  // 译文上，卡挂进页面文档，里面装着原文。原文段落本身已翻过、不再收，所以收到的
  // 块里只要出现这段原文，就只能是从卡里收来的。
  const SOURCE = 'The original text shown back to the reader in the peek card.';
  await loadHarness(page, doc(`
    <p id="page-p">A paragraph of the page itself, which is collected as usual.</p>
    <p id="source-p">${SOURCE}</p>`));
  await page.evaluate(() => {
    const ctx = window.AI_TRANSLATOR_CONTENT;
    ctx.settings.showTranslationOnly = true;
    const block = ctx.collectTranslatableBlocks(document.body).find((b) => b.element.id === 'source-p');
    // textLang 取这个夹具真会请求的那门语言，和 content/page/batch.js 落笔时同一个来源。
    ctx.insertTranslationBlock(block, '[T] The reader sees this translation instead.',
      { textLang: ctx.getEffectiveTargetLang() });
  });
  const translation = page.locator('#source-p + .ai-translator-inline-block');
  const box = await translation.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const card = page.locator('#ai-translator-source-peek');
  await expect(card.locator('.ai-translator-source-peek-text')).toHaveText(SOURCE);

  const r = await page.evaluate(() => {
    const ctx = window.AI_TRANSLATOR_CONTENT;
    const texts = (blocks) => blocks.map((b) => b.text);
    ctx.invalidatePageScope();
    return {
      ids: ctx.collectPageBlocks().map((b) => b.element.id),
      texts: texts(ctx.collectTranslatableBlocks(document.body)),
      // 发现层按新增根调收集器：peek 卡自己作根时也不收。
      asRoot: texts(ctx.collectPageBlocks(document.getElementById('ai-translator-source-peek'))),
    };
  });
  expect(r.ids).toEqual(['page-p']);
  expect(r.texts.join('\n')).not.toContain('peek card');
  expect(r.asRoot).toEqual([]);
  // 收集时卡一直开着：上面的空结果不是因为卡已经收走了。
  await expect(card).toHaveCount(1);
});

// ---- MAIN_TEXT_SHARE 调参夹具 ----
//
// 每个夹具记下两样：scope.js 算出的占比（<main> 的可见字数 / body 的可见字数），
// 以及这个版式下「正文的根应该是谁」。阈值取在「<main> 真是正文」那一组的最小值
// 与「<main> 只是个壳」那一组的最大值之间。占比打到测试输出里（[share] 行），调
// 参时看这一列。

const LONG = (seed) => Array.from({ length: 4 }, (_, i) =>
  `<p>${seed} paragraph ${i + 1} explains the matter in enough detail that a reader can follow it without the rest of the page.</p>`).join('');
const LINKS = (n) => `<ul>${Array.from({ length: n }, (_, i) => `<li><a href="/x${i}">Reference section number ${i + 1}</a></li>`).join('')}</ul>`;

const SHARE_FIXTURES = [
  {
    name: 'news article: header, nav, main > article, aside, footer',
    expectRoot: 'main',
    html: doc(`<header><h1>The Harbour Gazette</h1><p>Independent reporting since 1921.</p></header>
      <nav>${LINKS(6)}</nav>
      <main><article><h2>Ferry service resumes</h2>${LONG('News')}</article></main>
      <aside><h3>Most read</h3>${LINKS(5)}</aside>
      <footer><p>Copyright and contact details for the newspaper office.</p></footer>`),
  },
  {
    name: 'documentation: short sidebar nav, main with one article',
    expectRoot: 'main',
    html: doc(`<header><a href="/">Docs home</a></header>
      <nav>${LINKS(15)}</nav>
      <main><h1>Configuring the build</h1>${LONG('Docs')}</main>
      <footer><p>Edit this page on the repository.</p></footer>`),
  },
  {
    // 导航比正文还长：<main> 的占比掉到阈值以下、退回 body。代价为零——导航、
    // 页眉页脚本来就被跳过，收到的块仍然全在 <main> 里（下面 onlyMainBlocks 断言）。
    name: 'documentation: 40-link sidebar nav outweighs the article',
    expectRoot: 'body',
    onlyMainBlocks: true,
    html: doc(`<header><a href="/">Docs home</a></header>
      <nav>${LINKS(40)}</nav>
      <main><h1>Configuring the build</h1>${LONG('Docs')}</main>
      <footer><p>Edit this page on the repository.</p></footer>`),
  },
  {
    name: 'forum listing: main of short titles, a text-heavy aside',
    expectRoot: 'main',
    html: doc(`<nav>${LINKS(5)}</nav>
      <main>${LINKS(15)}</main>
      <aside>${LONG('Community rules')}</aside>`),
  },
  {
    name: 'app shell: <main> holds a sign-in box, the feed sits outside it',
    expectRoot: 'body',
    html: doc(`<header><a href="/">Home</a></header>
      <main><h2>Welcome back</h2><p>Sign in to continue.</p></main>
      <div class="feed">${LONG('Feed')}${LONG('More feed')}</div>`),
  },
  {
    name: 'landing page: <main> wraps a hero only, content in sections after it',
    expectRoot: 'body',
    html: doc(`<main><h1>Build faster</h1><p>Start your free trial today.</p></main>
      <section>${LONG('Feature')}</section><section>${LONG('Pricing')}</section>`),
  },
  {
    name: 'two sibling <main> elements (no single root)',
    expectRoot: 'body',
    html: doc(`<main>${LONG('Left')}</main><main>${LONG('Right')}</main>`),
  },
];

test.describe('MAIN_TEXT_SHARE tuning fixtures', () => {
  for (const fixture of SHARE_FIXTURES) {
    test(`root choice: ${fixture.name}`, async ({ page }) => {
      await loadHarness(page, fixture.html);
      const r = await page.evaluate(() => {
        const ctx = window.AI_TRANSLATOR_CONTENT;
        ctx.invalidatePageScope();
        const scope = ctx.resolvePageScope();
        const main = document.querySelector('main');
        const blocks = ctx.collectPageBlocks();
        return {
          threshold: ctx.MAIN_TEXT_SHARE,
          share: scope.share,
          root: scope.roots[0].localName,
          mode: scope.mode,
          blocks: blocks.length,
          outsideMain: main ? blocks.filter((b) => !main.contains(b.element)).length : null,
        };
      });
      console.log(`[share] ${fixture.name}: share=${r.share === null ? 'n/a' : r.share.toFixed(3)} root=${r.root} (threshold ${r.threshold})`);
      expect(r.mode).toBe('main');
      expect(r.root).toBe(fixture.expectRoot);
      if (fixture.onlyMainBlocks) {
        expect(r.blocks).toBeGreaterThan(0);
        expect(r.outsideMain).toBe(0);
      }
    });
  }
});

// ---- 正文范围的缓存：退回 body 也缓存，一轮只数一次 body ----
//
// 缓存规则的单测（计数器、各种作废）在 test/unit/page-scope-cache.test.mjs。这里在
// 真浏览器里量两条只有接上真入口才看得见的：
//   (e) 发现层的一批里有好几个脏根，body 的字数只数一次；
//   (b) 首屏只是个壳的 <main> 后来长出了正文，下一批发现、下一次手动整页翻译都认得出。
// 「认出来」的判据：同时在 <main> 外面新加一段——范围根还是 body 时它会被收进来，
// 认出 <main> 之后它不在范围里（nav/aside 之外的非正文，要靠 <main> 才减得掉）。

const FEED = (id) => `<p id="${id}">A feed item ${id} that sits beside the main column and says a little about a story.</p>`;
const GROWN = (i) => `<p id="grown-${i}">Grown paragraph ${i} of the article, rendered after the shell, with enough words to carry the page.</p>`;

const LATE_MAIN_PAGE = doc(`
  <header><a href="/">Home</a></header>
  <main id="shell"><p id="hero">Loading your reading list, one moment please.</p></main>
  <div class="feed">
    <div id="col-a">${FEED('feed-1')}</div>
    <div id="col-b">${FEED('feed-2')}</div>
    <div id="col-c">${FEED('feed-3')}</div>
  </div>`);

// 探针：body 的字数每数一次，body.querySelectorAll('script, style, noscript') 就被调
// 一次（scope.js 的 textLength）；每次 collectPageBlocks 记下它属于哪一轮、从哪个根
// 收、范围根是谁、收到了谁。beginScopeRound 同步开一轮，收集都在同一个任务里，
// 微任务一到就关——之后进带时的重收（onBand）不算进任何一轮。
async function installScopeProbe(page) {
  await page.evaluate(() => {
    const ctx = window.AI_TRANSLATOR_CONTENT;
    const probe = { bodyCounts: 0, round: 0, open: null, calls: [] };
    window.__scopeProbe = probe;
    const qsa = Element.prototype.querySelectorAll;
    document.body.querySelectorAll = function (selector) {
      if (selector === 'script, style, noscript') probe.bodyCounts += 1;
      return qsa.call(this, selector);
    };
    const begin = ctx.beginScopeRound;
    ctx.beginScopeRound = () => {
      probe.round += 1;
      probe.open = probe.round;
      queueMicrotask(() => { probe.open = null; });
      begin();
    };
    const collect = ctx.collectPageBlocks;
    ctx.collectPageBlocks = (root) => {
      const blocks = collect(root);
      probe.calls.push({
        round: probe.open,
        root: root ? (root.id || root.localName) : 'body',
        scopeRoot: ctx.resolvePageScope().roots[0].localName,
        ids: blocks.map((b) => b.element.id),
        bodyCounts: probe.bodyCounts,
      });
      return probe.stopManualRound ? [] : blocks;
    };
    // 先求一次：缓存里是「退回 body」。
    ctx.invalidatePageScope();
    probe.seed = ctx.resolvePageScope().roots[0].localName;
  });
}

// 同一个任务里：<main> 长出正文，<main> 外面也多出一段。
async function growMainAndFeed(page) {
  await page.evaluate(({ grown, late }) => {
    document.getElementById('shell').insertAdjacentHTML('beforeend', grown);
    document.getElementById('col-a').insertAdjacentHTML('beforeend', late);
  }, { grown: [1, 2, 3, 4, 5, 6].map(GROWN).join(''), late: FEED('feed-late') });
}

const roundCalls = (page, round) => page.evaluate((round) =>
  window.__scopeProbe.calls.filter((call) => call.round === round), round);

test('scope cache (e)+(b): one discovery batch counts body once, and the next batch sees a <main> that grew', async ({ page }) => {
  await loadHarness(page, LATE_MAIN_PAGE, contentHarnessScripts(...PAGE_TRANSLATION_MODULES, 'content/content-auto-discover.js'));
  await installScopeProbe(page);
  expect(await page.evaluate(() => window.__scopeProbe.seed)).toBe('body');
  await page.evaluate(() => {
    window.__discovery = window.AI_TRANSLATOR_CONTENT.setupAutoDiscovery({ onCandidates: () => {} });
  });

  // 第一批：三个互不嵌套的脏根。
  await page.evaluate((items) => {
    ['col-a', 'col-b', 'col-c'].forEach((id, i) => document.getElementById(id).insertAdjacentHTML('beforeend', items[i]));
  }, [FEED('feed-4'), FEED('feed-5'), FEED('feed-6')]);
  await expect.poll(() => roundCalls(page, 1).then((calls) => calls.length), { timeout: 5000 }).toBe(3);
  const first = await roundCalls(page, 1);
  expect(first.map((call) => call.root).sort()).toEqual(['col-a', 'col-b', 'col-c']);
  expect(first.map((call) => call.scopeRoot)).toEqual(['body', 'body', 'body']);
  // 求种子时数了一次，这一批三个根一共再数一次。
  expect(first.map((call) => call.bodyCounts)).toEqual([2, 2, 2]);
  // 脏根是整栏：栏里原有的那段也在（发现层按元素去重，不按根）。
  expect(first.flatMap((call) => call.ids).sort()).toEqual(['feed-1', 'feed-2', 'feed-3', 'feed-4', 'feed-5', 'feed-6']);

  // 第二批：<main> 长大了，同时 <main> 外面多出一段。
  await growMainAndFeed(page);
  await expect.poll(() => roundCalls(page, 2).then((calls) => calls.length), { timeout: 5000 }).toBe(2);
  const second = await roundCalls(page, 2);
  expect(second.map((call) => call.scopeRoot)).toEqual(['main', 'main']);
  expect(second.map((call) => call.bodyCounts)).toEqual([3, 3]);
  const collected = second.flatMap((call) => call.ids);
  expect(collected).toContain('grown-1');
  expect(collected).toContain('grown-6');
  expect(collected).not.toContain('feed-late');

  // 批与批之间，进带时的重收（不开新一轮）没有再数过 body。
  expect(await page.evaluate(() => window.__scopeProbe.bodyCounts)).toBe(3);
  await page.evaluate(() => window.__discovery.stop());
});

test('scope cache (b): the next manual page translation sees a <main> that grew', async ({ page }) => {
  // 不装发现层：两次手动翻译之间没有任何东西开新一轮，只能靠手动轮自己。
  await loadHarness(page, LATE_MAIN_PAGE);
  await installScopeProbe(page);
  expect(await page.evaluate(() => window.__scopeProbe.seed)).toBe('body');
  await growMainAndFeed(page);

  // 只看手动轮收到了谁：收完就回空，门面走「没有可译内容」那条路收尾，不发请求。
  const { calls, sent, notices } = await page.evaluate(async () => {
    window.__scopeProbe.stopManualRound = true;
    // 夹具：门面进门先问扩展上下文在不在（ctx.isExtensionContextAvailable 只看
    // chrome.runtime.sendMessage 有没有）。普通页面没有，这里给一个只记账的桩；
    // 收到空列表的这一轮不该发任何消息。
    const sent = [];
    window.chrome = Object.assign(window.chrome || {}, { runtime: { sendMessage: (message) => { sent.push(message.type); } } });
    // 夹具：「无可译内容」的提示条要 ctx.escapeHtml（content-utils.js，不在整页
    // 翻译这串模块里）。这里只记下门面走到了这一步。
    const ctx = window.AI_TRANSLATOR_CONTENT;
    const notices = [];
    ctx.showPageNotice = (text) => notices.push(text);
    await ctx.translatePage();
    return { calls: window.__scopeProbe.calls, sent, notices };
  });
  expect(sent).toEqual([]);
  expect(notices).toHaveLength(1);
  expect(calls).toHaveLength(1);
  expect(calls[0].round).toBe(1);
  expect(calls[0].scopeRoot).toBe('main');
  expect(calls[0].ids).toContain('hero');
  expect(calls[0].ids).toContain('grown-6');
  expect(calls[0].ids).not.toContain('feed-1');
  expect(calls[0].ids).not.toContain('feed-late');
  expect(calls[0].bodyCounts).toBe(2);
});

// ---- shadow 样式：:host-context 改写真的生效 ----

test('shadow styles: :host-context rules follow <html>, and the real stylesheet applies in a root', async ({ page }) => {
  // Node 这一侧用生产的那一个改写函数，不在测试里另写一份。Playwright 的加载器
  // 把仓库里的 .js 一律按 CommonJS 编（package.json 没有 "type": "module"），直接
  // import 文件路径会在 `export` 上报语法错；按原文件的字节以 data: 模块导入，
  // 拿到的是同一份源码。
  const source = fs.readFileSync(path.join(REPO, 'background/page-coverage.js'), 'utf8');
  const { toShadowCss } = await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`);
  const css = toShadowCss(fs.readFileSync(path.join(REPO, 'content/css/translation.css'), 'utf8'));
  // blur 的值照 translation.css 里真写的读，不在这里另记一份。
  const blur = /filter:\s*(blur\([^)]*\))/.exec(css)[1];

  await page.setContent(doc('<div id="host"></div>'), { waitUntil: 'load' });
  await page.evaluate((css) => {
    const root = document.getElementById('host').attachShadow({ mode: 'open' });
    root.innerHTML = '<p class="ai-translator-inline-block">translation</p><span class="ai-translator-inline-block">span</span>';
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    root.adoptedStyleSheets = [sheet];
  }, css);

  // blur 那条带 `transition: filter`：切换属性后读到的可能是过渡中的值，所以轮询到
  // 终值为止。
  const read = () => page.evaluate(() => {
    const style = getComputedStyle(document.getElementById('host').shadowRoot.querySelector('p'));
    return { line: style.textDecorationLine, filter: style.filter };
  });
  const html = (attrs) => page.evaluate((attrs) => {
    const el = document.documentElement;
    el.removeAttribute('data-ai-translator-style');
    el.removeAttribute('data-ai-translator-only');
    for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value);
  }, attrs);

  // 1. 宿主文档 <html> 上的译文样式一变，shadow 里的译文跟着变。
  await expect.poll(read).toEqual({ line: 'none', filter: 'none' });
  await html({ 'data-ai-translator-style': 'underline' });
  await expect.poll(read).toEqual({ line: 'underline', filter: 'none' });
  await html({ 'data-ai-translator-style': 'blur' });
  await expect.poll(read).toEqual({ line: 'none', filter: blur });
  // 2. 仅显示译文（<html data-ai-translator-only>）关掉 blur 那一条。
  await html({ 'data-ai-translator-style': 'blur', 'data-ai-translator-only': '' });
  await expect.poll(read).toEqual({ line: 'none', filter: 'none' });

  // 3. 没有条件的那条也生效：
  //    `.ai-translator-inline-block { display: block !important; animation: ... }`。
  const real = await page.evaluate(() => {
    const span = getComputedStyle(document.getElementById('host').shadowRoot.querySelector('span'));
    return { display: span.display, animation: span.animationName };
  });
  expect(real).toEqual({ display: 'block', animation: 'ai-translator-block-fade-in' });
});
