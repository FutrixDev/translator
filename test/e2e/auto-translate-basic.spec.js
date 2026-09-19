// 自动翻译的第一条旅程：**打开即译**。
//
// 这条 spec 里没有一次点击。整页翻译的所有既有 spec 都从 triggerPageTranslation()
// 开始，那一行本身就是「用户表过态」；这里刻意一行都不写——页面加载完，译文自己
// 出现，否则这个功能不成立。
//
// 另一半同样重要，而且更容易写漏：**没有规则的站点上，我们什么都不做**。默认开
// 的是「这套机器转起来」，不是「见到外文就翻」。少了这一条，一个把 autoTranslate
// 判成 auto 的回归会让插件在用户的每一个网页上自说自话地插节点、烧 API 额度，而
// 上面那条正向断言照样绿。
//
// 断言 sentTexts 而不只看 DOM：DOM 只能证明「没画出译文」，那在「发出去了但没落
// 地」时也成立——而钱是在发出去那一刻花掉的。
const { test, expect } = require('./fixtures');
const { setExtensionSettings } = require('./helpers');
const { startMockOpenAIServer } = require('./mock-openai-server');

const ORIGIN = 'https://auto.test';

const LEAD = 'The ferry leaves the northern pier every morning at a quarter past six.';
const BODY = 'Passengers who miss it can wait for the afternoon crossing or take the coastal road instead.';
// 第三段刻意带内联标记，而且正文缩进在标签里边。这两样东西都会让「送去翻译的
// 文本」和「页面上原样的文字」长得不一样：前者带内联标记、且 trim 过（见
// content/page/collect.js 的 getTextWithMathPlaceholders）。调度层开跑前要认出
// 「这个节点被回收了」，两边必须取同一个表示法 —— 取错了，带链接的段落和所有
// 含公式的段落会被一律丢掉，而且再也没有东西把它们送回来。
const RICH_MIDDLE = 'is posted on the noticeboard by the';

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Harbour notes</title></head>
<body>
  <div id="lead-box"><p id="lead">${LEAD}</p></div>
  <div id="body-box"><p id="body">${BODY}</p></div>
  <div id="rich-box">
    <p id="rich">
      The <a href="/tide">printed tide table</a> ${RICH_MIDDLE} <em>harbour master</em> every Friday.
    </p>
  </div>
</body></html>`;

async function serve(context) {
  await context.route(`${ORIGIN}/**`, (route) => {
    route.fulfill({ status: 200, contentType: 'text/html', body: PAGE });
  });
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

test('auto translation: a page the user marked "always" translates itself on open', async ({ page, context }) => {
  const { close, endpoint, sentTexts } = await startMockOpenAIServer();

  try {
    await setExtensionSettings(page, settings(endpoint, {
      siteRules: { 'auto.test': 'always' },
    }));
    await serve(context);

    await page.goto(`${ORIGIN}/article`);
    await page.waitForSelector('#ai-translator-float-ball');

    // 没有任何触发动作。悬浮球在那儿，谁也没碰它。
    await page.waitForSelector('#lead-box .ai-translator-inline-block', { timeout: 30000 });
    await page.waitForSelector('#body-box .ai-translator-inline-block', { timeout: 30000 });
    await page.waitForSelector('#rich-box .ai-translator-inline-block', { timeout: 30000 });

    await expect(page.locator('#lead-box .ai-translator-inline-block')).toContainText(LEAD);
    expect(sentTexts.join('\n')).toContain(LEAD);
    expect(sentTexts.join('\n')).toContain(BODY);
    // 内联标记怎么编码是收集器的事，这里只认标记之间那段素文字。
    expect(sentTexts.join('\n')).toContain(RICH_MIDDLE);
  } finally {
    await close();
  }
});

test('auto translation: a page with no rule is left alone — nothing rendered, nothing sent', async ({ page, context }) => {
  const { close, endpoint, sentTexts } = await startMockOpenAIServer();

  try {
    // 和上一条唯一的差别就是没有那条站点规则。
    await setExtensionSettings(page, settings(endpoint));
    await serve(context);

    await page.goto(`${ORIGIN}/article`);
    await page.waitForSelector('#ai-translator-float-ball');

    // 探语言最多等 1.2s（SAMPLE_WAIT_MS），判完还要过一轮 250ms 的攒批防抖。
    // 给到 4s，足够让一个判错了的实现把请求发出去。
    await page.waitForTimeout(4000);

    await expect(page.locator('.ai-translator-inline-block')).toHaveCount(0);
    expect(sentTexts).toEqual([]);
  } finally {
    await close();
  }
});
