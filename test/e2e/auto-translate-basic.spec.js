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
const { setExtensionSettings, writeSyncSettings } = require('./helpers');
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

test('auto translation: changing the target language re-translates what is already on the page', async ({ page, context }) => {
  // 换目标语言之前翻过的那一片，是**上一门语言**的译文。只把调度层重启一遍不
  // 够：页面上每一块的身份登记还在，原文一个字没变，指纹自然一致 —— 收集那一层
  // 一看「登记过、不陈旧」就跳过，于是用户改完设置，已经翻出来的部分永远停在中
  // 文，只有之后新滚出来的那些才是日文。页面上看不出异样（两种语言都是「译文」），
  // 也没有任何报错。
  //
  // 断言的是「同一段原文又发出去了一次」：这件事只有在旧译文被判成陈旧、放开、
  // 重新收集之后才可能发生。
  const { close, endpoint, sentTexts } = await startMockOpenAIServer();

  try {
    await setExtensionSettings(page, settings(endpoint, {
      siteRules: { 'auto.test': 'always' },
    }));
    await serve(context);

    await page.goto(`${ORIGIN}/article`);
    await page.waitForSelector('#ai-translator-float-ball');
    await page.waitForSelector('#lead-box .ai-translator-inline-block', { timeout: 30000 });

    const countLead = () => sentTexts.filter((text) => text.includes(LEAD)).length;
    await expect.poll(countLead, { timeout: 30000 }).toBe(1);

    // 只写这一个键：storage 的变更通知里就只有 targetLang，和用户在设置页改它
    // 时到达的是同一份东西。
    await writeSyncSettings(context, { targetLang: 'ja' });

    await expect.poll(countLead, { timeout: 30000 }).toBeGreaterThanOrEqual(2);
    // 译文还在页面上 —— 重翻是「放开再插一条」，不是「删掉就完了」。
    await expect(page.locator('#lead-box .ai-translator-inline-block')).toHaveCount(1);
  } finally {
    await close();
  }
});

test('auto translation: a block whose batch failed gets another chance, not a silent hole', async ({ page, context }) => {
  // 一轮里失败不到三次不算整体故障（content/page/batch.js 的 MAX_BATCH_FAILURES）：
  // 这一轮照样「成功」结束，只是那几块一个字都没翻。台账要是在**发出去那一刻**
  // 就记上，它们从此被当成翻过了 —— 发现层下一轮送回来，调度层一看台账，跳过。
  // 页面上那一片永远是原文，没有报错，没有重试，什么痕迹都没有。
  //
  // 所以记账要等结果：翻好了算、模型说不用翻算，失败不算。
  const { close, endpoint, sentTexts } = await startMockOpenAIServer({ failRequests: 1 });

  try {
    await setExtensionSettings(page, settings(endpoint, {
      siteRules: { 'auto.test': 'always' },
    }));
    await serve(context);

    await page.goto(`${ORIGIN}/article`);
    await page.waitForSelector('#ai-translator-float-ball');

    const countLead = () => sentTexts.filter((text) => text.includes(LEAD)).length;
    // 第一批发出去了，服务器 500 —— 文字花了钱，页面上什么也没落地。
    await expect.poll(countLead, { timeout: 30000 }).toBeGreaterThanOrEqual(1);
    await expect(page.locator('#lead-box .ai-translator-inline-block')).toHaveCount(0);

    // 页面自己动一下（评论区追加、信息流插入……）。脏根是 #lead-box，重新收集时
    // #lead 还没有译文、也没有身份登记，于是又一次被送到调度层门口 —— 从这里往
    // 后，唯一决定它会不会被再发一次的就是台账。
    await page.evaluate(() => {
      const box = document.getElementById('lead-box');
      const note = document.createElement('p');
      note.id = 'late-note';
      note.textContent = 'The harbour office posts a notice whenever the schedule changes.';
      box.appendChild(note);
    });

    await expect.poll(countLead, { timeout: 30000 }).toBeGreaterThanOrEqual(2);
    await page.waitForSelector('#lead-box .ai-translator-inline-block', { timeout: 30000 });
    await expect(page.locator('#lead')).toContainText(LEAD);
  } finally {
    await close();
  }
});
