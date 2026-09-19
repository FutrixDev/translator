const { test, expect } = require('./fixtures');
const { setExtensionSettings, triggerPageTranslation } = require('./helpers');
const { startMockOpenAIServer } = require('./mock-openai-server');

// 内容身份（shared/block-identity.js）在真浏览器里的那一条旅程。
//
// 在这之前，“翻过了”只记在源元素的 `.ai-translator-translated` 类上——那是**节点
// 身份**。X / Reddit 是虚拟列表：滚动时同一个 DOM 节点被回收，类名还在，里面已经
// 换成另一条推文了，于是新内容被静默跳过，永远不翻。整页翻译点一次就结束，所以
// 这个洞在手动时代一直没露出来；自动翻译要一直跟着页面跑，它就是地基。
//
// 这条 spec 从两个方向同时钉住，缺一个方向都会漏掉一类退化：
//
//   · 文字变了的那块 → 必须重翻，且**旧译文节点被摘掉**（不是旁边再长一个）。
//     只断言“新译文出现了”会放过“新旧两条译文并排”的实现。
//   · 文字没变的那块 → 必须原样跳过，**且这一轮根本没有把它发出去**。指纹的登记
//     口径和比对口径只要有一点不一致，每一块都会被判成陈旧，翻完立刻重翻——
//     一个会烧钱的死循环，而它在 DOM 上看起来和“正常”一模一样。
//
// 断言发出去的文本（sentTexts）而不是只看 DOM：DOM 只能证明“没画出第二份译文”，
// 那在“发出去了但回包没落地”时也成立。
const STABLE_TEXT = 'The harbour lights stayed exactly where the evening tide had left them.';
const RECYCLED_BEFORE = 'First tweet in the recycled row, about a seasonal cider festival.';
const RECYCLED_AFTER = 'Second tweet in the same recycled row, about winter railway timetables.';

test('page translation: a recycled block is retranslated, an unchanged one is not resent', async ({ page }) => {
  const { close, endpoint, sentTexts } = await startMockOpenAIServer();

  try {
    await setExtensionSettings(page, {
      apiEndpoint: endpoint,
      apiKey: 'test-key',
      modelName: 'gpt-4.1-mini',
      targetLang: 'zh-CN',
      skipTargetLanguageText: false
    });

    await page.goto('https://example.com');
    await page.waitForSelector('#ai-translator-float-ball');

    await page.evaluate(({ stable, recycled }) => {
      const container = document.createElement('div');
      container.id = 'recycle-test';
      const stablePara = document.createElement('p');
      stablePara.id = 'stable-para';
      stablePara.textContent = stable;
      const recycledPara = document.createElement('p');
      recycledPara.id = 'recycled-para';
      recycledPara.textContent = recycled;
      container.append(stablePara, recycledPara);
      document.body.appendChild(container);
    }, { stable: STABLE_TEXT, recycled: RECYCLED_BEFORE });

    await triggerPageTranslation(page);

    for (const id of ['stable-para', 'recycled-para']) {
      await page.waitForFunction(
        (paraId) => document.getElementById(paraId)?.classList.contains('ai-translator-translated'),
        id,
        { timeout: 30000 }
      );
    }
    // 第一轮整体落停，否则下面记下的请求数会把还在路上的那一份算进第二轮。
    await page.waitForSelector('#ai-translator-progress', { state: 'hidden', timeout: 30000 });
    await expect(page.locator('#recycle-test .ai-translator-inline-block')).toHaveCount(2);

    const firstPassRequests = sentTexts.length;

    // 虚拟列表回收这一行：节点、类名、我们插的译文节点全都原地不动，只有文字换了。
    // 只改源文本节点（跳过我们自己插进去的译文），因为指纹读的就是源子树。
    await page.evaluate((text) => {
      const el = document.getElementById('recycled-para');
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      const sourceNodes = [];
      let node;
      while ((node = walker.nextNode())) {
        if (!node.parentElement.closest('.ai-translator-inline-block')) sourceNodes.push(node);
      }
      sourceNodes.forEach((textNode, index) => {
        textNode.nodeValue = index === 0 ? text : '';
      });
    }, RECYCLED_AFTER);

    await triggerPageTranslation(page);

    await page.waitForFunction(
      (text) => {
        const blocks = document.querySelectorAll('#recycle-test .ai-translator-inline-block');
        return Array.from(blocks).some((el) => el.textContent.includes(text));
      },
      RECYCLED_AFTER,
      { timeout: 30000 }
    );
    await page.waitForSelector('#ai-translator-progress', { state: 'hidden', timeout: 30000 });

    // 旧译文被摘掉了，不是旁边再长一条：两块内容 → 还是两条译文。
    await expect(page.locator('#recycle-test .ai-translator-inline-block')).toHaveCount(2);
    await expect(
      page.locator('#recycle-test .ai-translator-inline-block', { hasText: RECYCLED_AFTER })
    ).toHaveCount(1);
    await expect(
      page.locator('#recycle-test .ai-translator-inline-block', { hasText: RECYCLED_BEFORE })
    ).toHaveCount(0);
    await expect(
      page.locator('#recycle-test .ai-translator-inline-block', { hasText: STABLE_TEXT })
    ).toHaveCount(1);
    await expect(page.locator('#recycled-para')).toHaveClass(/ai-translator-translated/);

    const secondPassSent = sentTexts.slice(firstPassRequests).join('\n');
    expect(secondPassSent).toContain(RECYCLED_AFTER);
    expect(secondPassSent).not.toContain(STABLE_TEXT);
  } finally {
    await close();
  }
});
