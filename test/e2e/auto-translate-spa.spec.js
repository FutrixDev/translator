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
// 选 arxiv.org 不是凑数：内置表里那条规则写的是 `arxiv.org/abs/*`——**按路径**。
// 列表页该问用户，摘要页直接翻，两者只差一个 pathname。这正是路由变化必须重新
// 决策的原因，也是「只在首次加载时判一次」那种实现会踩空的地方。
const { test, expect } = require('./fixtures');
const { setExtensionSettings } = require('./helpers');
const { startMockOpenAIServer } = require('./mock-openai-server');

const ABSTRACT = 'We present a method for aligning the two halves of a long document without supervision.';
const SHELL = 'Cornell University maintains this archive and accepts submissions from any field.';
const NEXT_ABSTRACT = 'A follow-up study measures how the same method behaves on much shorter inputs.';

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

async function serve(context, html) {
  await context.route('https://arxiv.org/**', (route) => {
    route.fulfill({ status: 200, contentType: 'text/html', body: html });
  });
}

test('auto translation: an SPA route change re-decides the page, with no DOM change at all', async ({ page, context }) => {
  const { close, endpoint, sentTexts } = await startMockOpenAIServer();

  try {
    // 没有任何用户规则：这一条全靠内置表里的 `arxiv.org/abs/*`。
    await setExtensionSettings(page, settings(endpoint));
    await serve(context, fixtureHtml(ABSTRACT));

    await page.goto('https://arxiv.org/list/cs.CL/recent');
    await page.waitForSelector('#ai-translator-float-ball');

    // 列表页不在 `/abs/*` 下，该问用户——问的界面是下一个 PR，这里的正确行为是
    // 安静地什么都不做。
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
