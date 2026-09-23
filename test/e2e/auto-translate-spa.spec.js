// 自动翻译的第三条旅程：**路由重译**。
//
// 单页应用换页时没有 load 事件，内容脚本也不会重新注入——对我们来说，「用户翻到
// 了下一篇」和「什么都没发生」在 DOM 之外没有任何区别。shared/spa-navigation.js
// 是补上这个区别的那一层，这条 spec 检验它真的接进了调度层。
//
// 第一条用的形状能把「到底是谁发现的」分干净：**pushState 之后页面的 DOM 一个字
// 节都没变**。MutationObserver 在这条路径上没有任何记录可看，所以译文若出现，只
// 可能是路由事件让调度层重新问了一次「这一页该不该翻」。
//
// 选 arxiv.org 不是凑数：内置表里那几条规则写的是 `arxiv.org/abs/*`、
// `/html/*`、`/list/*`——**全都按路径**。首页不在任何一条下面，该问用户；摘要页
// 直接翻。两者只差一个 pathname。这正是路由变化必须重新决策的原因，也是「只在
// 首次加载时判一次」那种实现会踩空的地方。
const { test, expect } = require('./fixtures');
const { setExtensionSettings, sendMessageToActiveTab, openFloatBallMenu } = require('./helpers');
const { startMockOpenAIServer } = require('./mock-openai-server');

const ABSTRACT = 'We present a method for aligning the two halves of a long document without supervision.';
const SHELL = 'Cornell University maintains this archive and accepts submissions from any field.';
const NEXT_ABSTRACT = 'A follow-up study measures how the same method behaves on much shorter inputs.';
const GERMAN_LIST = 'Die Bibliothek veroeffentlicht jeden Morgen eine neue Liste mit Arbeiten aus dem Bereich '
  + 'der maschinellen Uebersetzung, und die Redaktion prueft jede einzelne Einreichung sehr sorgfaeltig.';

// 最后一条旅程量的是语言，不是站点规则。给它一个内置表上没有的域名。
const LIBRARY = 'https://papers.library.example';

// 这条旅程只要一个视图：页首那段不变的导航文字会一起被取样，而它正是要避开的
// 干扰项（换页之后留在页面上的旧文字不该替新的一页回答「这是什么语言」）。
const SINGLE_VIEW = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>arXiv</title></head>
<body><div id="view-box"><p id="view">${ABSTRACT}</p></div></body></html>`;

function fixtureHtml(abstract) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>arXiv</title></head>
<body>
  <div id="shell-box"><p id="shell">${SHELL}</p></div>
  <div id="view-box"><p id="view">${abstract}</p></div>
</body></html>`;
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

// 默认发 arxiv.org，因为前三条旅程要的就是「同一个站点，一个路径在内置表里、
// 一个不在」。最后一条不依赖内置表，它换一个没有任何规则的域名。
async function serve(context, html, origin = 'https://arxiv.org') {
  await context.route(`${origin}/**`, (route) => {
    route.fulfill({ status: 200, contentType: 'text/html', body: html });
  });
}

test('auto translation: an SPA route change re-decides the page, with no DOM change at all', async ({ page, context }) => {
  const { close, endpoint, sentTexts } = await startMockOpenAIServer();

  try {
    // 没有任何用户规则：这一条全靠内置表里的 `arxiv.org/abs/*`。
    await setExtensionSettings(page, settings(endpoint));
    await serve(context, fixtureHtml(ABSTRACT));

    await page.goto('https://arxiv.org/');
    await page.waitForSelector('#ai-translator-float-ball');

    // 首页不在内置表的任何一条路径下，该问用户——问的界面是下一个 PR，这里的
    // 正确行为是安静地什么都不做。
    await page.waitForTimeout(4000);
    await expect(page.locator('.ai-translator-inline-block')).toHaveCount(0);
    expect(sentTexts).toEqual([]);

    // —— 换路由。只改 URL，DOM 原封不动。——
    await page.evaluate(() => {
      history.pushState({}, '', '/abs/2401.00001');
    });

    // 兜底轮询是 800ms 一次，再加上攒批的 250ms。
    await page.waitForSelector('#view-box .ai-translator-inline-block', { timeout: 30000 });
    await expect(page.locator('#view-box .ai-translator-inline-block')).toContainText(ABSTRACT);
    expect(sentTexts.join('\n')).toContain(ABSTRACT);
  } finally {
    await close();
  }
});

test('auto translation: after a route change the unchanged shell is not paid for twice', async ({ page, context }) => {
  const { close, endpoint, sentTexts } = await startMockOpenAIServer();

  try {
    await setExtensionSettings(page, settings(endpoint));
    await serve(context, fixtureHtml(ABSTRACT));

    await page.goto('https://arxiv.org/abs/2401.00001');
    await page.waitForSelector('#ai-translator-float-ball');
    await page.waitForSelector('#shell-box .ai-translator-inline-block', { timeout: 30000 });
    await page.waitForSelector('#view-box .ai-translator-inline-block', { timeout: 30000 });

    const beforeRoute = sentTexts.length;

    // 站内跳到下一篇：URL 变了，视图换了内容，页首那段导航文字一个字没动。
    await page.evaluate((text) => {
      history.pushState({}, '', '/abs/2401.00002');
      document.getElementById('view').textContent = text;
    }, NEXT_ABSTRACT);

    await page.waitForFunction((text) => {
      const blocks = document.querySelectorAll('#view-box .ai-translator-inline-block');
      return Array.from(blocks).some((el) => el.textContent.includes(text));
    }, NEXT_ABSTRACT, { timeout: 30000 });

    // 换路由会把代次翻篇、台账清空——那本来就是为了让改动过的内容能重来一次。
    // 没改动的那一段靠内容身份拦住；拦不住的话，用户每翻一页都要为同一段页首
    // 文字再付一次钱，而页面上看不出任何异样。
    const afterRoute = sentTexts.slice(beforeRoute).join('\n');
    expect(afterRoute).toContain(NEXT_ABSTRACT);
    expect(afterRoute).not.toContain(SHELL);
  } finally {
    await close();
  }
});

test('auto translation: pausing one article does not follow the reader into the next', async ({ page, context }) => {
  const { close, endpoint, sentTexts } = await startMockOpenAIServer();

  try {
    await setExtensionSettings(page, settings(endpoint));
    await serve(context, fixtureHtml(ABSTRACT));

    await page.goto('https://arxiv.org/abs/2401.00001');
    await page.waitForSelector('#ai-translator-float-ball');
    await page.waitForSelector('#view-box .ai-translator-inline-block', { timeout: 30000 });

    // 「这一页先别翻了」——他说的是**这一页**。
    await sendMessageToActiveTab(page, { type: 'SET_AUTO_PAUSED', paused: true });
    expect((await sendMessageToActiveTab(page, { type: 'AUTO_PAGE_STATE' })).auto.status).toBe('paused');
    const beforeRoute = sentTexts.length;

    // 站内翻到下一篇。这是新的一页，他还没对它表过态——闩要是跟着走，从这一刻
    // 起这个单页应用里的每一篇都是原文，而「继续」那颗按钮指着的是他早就离开的
    // 那一页，他没有任何理由想到要去点它。
    await page.evaluate((text) => {
      history.pushState({}, '', '/abs/2401.00002');
      document.getElementById('view').textContent = text;
    }, NEXT_ABSTRACT);

    await page.waitForFunction((text) => {
      const blocks = document.querySelectorAll('#view-box .ai-translator-inline-block');
      return Array.from(blocks).some((el) => el.textContent.includes(text));
    }, NEXT_ABSTRACT, { timeout: 30000 });
    expect(sentTexts.slice(beforeRoute).join('\n')).toContain(NEXT_ABSTRACT);
  } finally {
    await close();
  }
});


test('auto translation: a hidden route change is judged on its own language, not the last page\'s', async ({ page, context }) => {
  // 换了一页，语言就得重新量 —— 上一页量到的那门语言是**那一页**的测量结果。
  // 引擎那份语言缓存早就是这么做的（content/engine/languages.js 在路由变化时
  // 自己把它清掉），调度层这一份一直漏在外面。
  //
  // 漏掉的样子：用户正把译文藏着对着原文看，此时点进下一份列表。start() 走的是
  // 「先看原文」那条捷径，判完就 return —— 于是新的一页被上一页的语言判了一次。
  // 判成 off 就再也回不来：把译文放回来那一下只叫得醒 paused / error，OFF 停在
  // 那儿，而 popup 上这一页从此写着「和目标语言相同，不用翻」，直到他整页刷新。
  //
  // 断言落在 AUTO_PAGE_STATE 上，是因为那正是 popup 那三行照着画的同一份快照。
  // 追问条这里派不上用场：它在这个文档里已经被用户表过一次态，而「表过态就不再
  // 问」是刻意管到整页导航为止的（见 content-auto-status.js 的 dismissed）。
  const { close, endpoint } = await startMockOpenAIServer();
  const auto = async () => {
    const { status, reason, pageLang } = (await sendMessageToActiveTab(page, { type: 'AUTO_PAGE_STATE' })).auto;
    return { status, reason, pageLang };
  };

  try {
    await setExtensionSettings(page, settings(endpoint));
    await serve(context, SINGLE_VIEW, LIBRARY);

    // 这个域名不在内置表里，所以要问 —— 而页面语言正是在这一问里量出来的。走内
    // 置规则直接翻的那种页面反倒量不到：那条路在语言之前就有答案了。
    // 这条旅程和内置表无关，所以它不借 arxiv.org 的路径来制造「要问」：那是别人
    // 的数据，哪天多一条规则，这里就会因为一个不相干的改动变红。
    await page.goto(`${LIBRARY}/list/cs.CL/recent`);
    await page.waitForSelector('#ai-translator-float-ball');
    const bar = page.locator('#ai-translator-auto-bar');
    await expect(bar).toBeVisible({ timeout: 30000 });
    expect(await auto()).toEqual({ status: 'ask', reason: 'DEFAULT_ASK', pageLang: 'en' });

    // 「翻这一页」（不勾「总是」：这一下只对这一页算数）。
    await bar.locator('[data-act="translate"]').click();
    await page.waitForSelector('#view-box .ai-translator-inline-block', { timeout: 30000 });

    // 对着原文看一眼。只收起译文，不撤销刚才那一下「翻译」。
    const blocks = page.locator('#view-box .ai-translator-inline-block');
    await openFloatBallMenu(page);
    await page.click('.ai-translator-menu-item[data-action="toggle-translations"]');
    await expect(blocks.first()).toHaveClass(/ai-translator-hidden/);

    // 他改了主意：目标语言换成英文。这一页他已经表过态，照旧停着。
    await setExtensionSettings(page, settings(endpoint, { targetLang: 'en' }));
    await expect.poll(async () => (await auto()).status, { timeout: 10000 }).toBe('paused');

    // 站内翻到下一份列表，德文。旧视图按单页应用的常态留在 DOM 里、只是藏起来
    // （连同它那条译文 —— 「显示译文」那一项还得有东西可显）。
    await page.evaluate((text) => {
      history.pushState({}, '', '/list/cs.AI/recent');
      document.getElementById('view-box').style.display = 'none';
      const box = document.createElement('div');
      box.id = 'next-box';
      const p = document.createElement('p');
      p.textContent = text;
      box.appendChild(p);
      document.body.appendChild(box);
    }, GERMAN_LIST);

    // 新的一页还没量过，也不该借上一页的读数：拿英文来判，这一页就是「和目标语
    // 言相同」—— off，而且是死的。停着才对。
    await expect.poll(auto, { timeout: 10000 })
      .toEqual({ status: 'paused', reason: 'UNKNOWN_LANGUAGE', pageLang: null });

    // 把译文放回来。这一页到这一刻才第一次被真正量一遍：德文 ≠ 英文，该问。
    await openFloatBallMenu(page);
    await page.click('.ai-translator-menu-item[data-action="toggle-translations"]');
    await expect.poll(auto, { timeout: 30000 })
      .toEqual({ status: 'ask', reason: 'DEFAULT_ASK', pageLang: 'de' });
  } finally {
    await close();
  }
});
