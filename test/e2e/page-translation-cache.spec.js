const { test, expect } = require('./fixtures');
const { setExtensionSettings, triggerPageTranslation } = require('./helpers');
const { startMockOpenAIServer } = require('./mock-openai-server');

// 译文缓存（shared/translation-cache.js + content/content-translation-cache.js）的
// 那一条旅程：同一段文字翻译过一次之后，第二次不该再向接口要。
//
// **这里刻意用 reload 而不是再点一次翻译。** L1 是页面进程内的 Map，同一个页面上
// 第二次翻译命中 L1 是显然的，证明不了什么；页面一刷新 L1 就没了，这时候还不发请求，
// 说明译文真的走完了 chrome.storage.local 的一圈 —— 那才是用户关机第二天回来、
// 或者在另一个标签页打开同一篇文章时走的路。
//
// 断言落在 sentTexts（真正离开浏览器的文本）而不是 DOM 上：DOM 只能证明
// “页面上有译文”，而缓存要证明的恰恰是“没有发生请求”。
test('page translation cache: a reloaded page renders from cache without a single new request', async ({ page }) => {
  const { close, endpoint, fastBatchRequests, sentTexts } = await startMockOpenAIServer();

  // 两遍必须是逐字相同的文本，缓存才有可能命中；同时带一个随机串，
  // 免得同一个浏览器 profile 里别的东西恰好也翻译过这几句。
  const nonce = Math.random().toString(36).slice(2, 10);
  const paragraphs = [
    `Cache probe one ${nonce}: the quick brown fox jumps over the lazy dog.`,
    `Cache probe two ${nonce}: benchmarking voice models takes careful work.`,
    `Cache probe three ${nonce}: every paragraph here is translated exactly once.`
  ];

  const inject = async () => {
    await page.evaluate((texts) => {
      const container = document.createElement('div');
      container.id = 'cache-probe';
      for (const text of texts) {
        const p = document.createElement('p');
        p.className = 'cache-probe-para';
        p.textContent = text;
        container.appendChild(p);
      }
      document.body.appendChild(container);
    }, paragraphs);
  };

  const translateAndSettle = async () => {
    await triggerPageTranslation(page);
    await expect(page.locator('#cache-probe .ai-translator-inline-block'))
      .toHaveCount(paragraphs.length, { timeout: 30000 });
    // 整轮跑完（进度条自己收掉）之后再读计数，否则读到的是“还没发完”。
    await page.waitForSelector('#ai-translator-progress', { state: 'hidden', timeout: 30000 });
  };

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
    await inject();
    await translateAndSettle();

    // 提示词措辞漂了、mock 认不出分隔符时，下面的计数断言会变成一句莫名其妙的
    // “0 === 0 通过”。先钉住这一遍真的走了快速批量。
    expect(fastBatchRequests.length).toBeGreaterThan(0);
    for (const text of paragraphs) {
      expect(sentTexts.join('\n')).toContain(text);
    }
    const sentAfterFirstPass = sentTexts.length;

    // 落盘是攒 500ms 再写的（见 shared/translation-cache.js 的 FLUSH_DELAY_MS）。
    // 不等这一下就刷新，写入会随页面一起消失，第二遍自然还要重发 ——
    // 那时失败的是测试的时序，不是缓存。
    await page.waitForTimeout(1500);

    await page.reload();
    await page.waitForSelector('#ai-translator-float-ball');
    await inject();
    await translateAndSettle();

    expect(sentTexts.length).toBe(sentAfterFirstPass);
    // 译文也得真的在页面上：一条请求都没发但页面空着，那是没翻译，不是命中缓存。
    await expect(page.locator('#cache-probe .ai-translator-inline-block').first())
      .toContainText('[T]');
  } finally {
    await close();
  }
});
