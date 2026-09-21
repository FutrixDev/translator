// 繁体的一页，简体的目标语言 —— 这是一次真的翻译，不是「本来就是你的语言」。
//
// 「跳过已经是目标语言的段落」这道闸门要先问一句「这一段是什么语言」。问的是
// chrome.i18n.detectLanguage，而它**分不出简繁**：繁体和简体都回答 `zh`，两边都
// 是 100%、isReliable（在这套 e2e 的真实 Chrome 里实测过）。于是一整页繁体配
// zh-CN 的目标，闸门读到的是「zh 对 zh-CN，同一门语言」，一个字都不送出去。
//
// 补简繁的那一步在 shared/lang-tags.js（refineScript：按正文里的字把 `zh` 补成
// zh-Hans / zh-Hant），batch.js 的 detectReliableLanguage 交出去之前过一道。这条
// spec 守的是那一步真的在链路上 —— 单元测试只能证明函数本身对，证不了真实的
// detectLanguage 回来的那个 `zh` 有人接。
//
// 两段正文一起上，缺一不可：繁体那段必须送出去，简体那段必须留下。只断言前者
// 会被「把闸门整个关掉」蒙混过关，那时候这条 spec 照样绿。
const { test, expect } = require('./fixtures');
const { setExtensionSettings, triggerPageTranslation } = require('./helpers');
const { startMockOpenAIServer } = require('./mock-openai-server');

const HANT = '這個網站說明了兩個系統之間的關係，並且詳細記錄了每一個實驗的結果與數據。';
const HANS = '这个网站说明了两个系统之间的关系，并且详细记录了每一个实验的结果与数据。';

const PAGE = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>Han script</title></head>
<body>
  <p id="hant">${HANT}</p>
  <p id="hans">${HANS}</p>
</body></html>`;

test('繁体正文配简体目标：正文照翻，而同为简体的那一段仍然跳过', async ({ page, context }) => {
  const { close, endpoint, sentTexts } = await startMockOpenAIServer();

  try {
    await setExtensionSettings(page, {
      apiEndpoint: endpoint,
      apiKey: 'test-key',
      modelName: 'gpt-4.1-mini',
      targetLang: 'zh-CN',
      // 这道闸门开着才有这条 spec：关着的话两段都会送出去，什么也证明不了。
      skipTargetLanguageText: true,
    });

    await context.route('https://example.com/**', (route) => {
      route.fulfill({ status: 200, contentType: 'text/html', body: PAGE });
    });

    await page.goto('https://example.com/han');
    await page.waitForSelector('#ai-translator-float-ball');
    await triggerPageTranslation(page);

    await page.waitForSelector('#hant.ai-translator-translated', { timeout: 30000 });

    const all = sentTexts.join('\n');
    expect(all).toContain(HANT);
    expect(all).not.toContain(HANS);
    await expect(page.locator('#hans')).not.toHaveClass(/ai-translator-translated/);
  } finally {
    await close();
  }
});
