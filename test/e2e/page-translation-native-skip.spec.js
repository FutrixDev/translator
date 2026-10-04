// 「主体是母语、夹着几个外文名词」的段落不翻 —— 用真的 chrome.i18n.detectLanguage。
//
// 单元测试（test/unit/native-text-skip.test.mjs）用的是一个假的检测器，读数是在
// 这套 e2e 的 Chrome 里量来的几条。这条 spec 守的是真检测器在摘过名词的正文上
// 真的过得了 85 那道门 —— 整段直接问，下面几段中文只拿到 zh:55、kk:47，会被翻。
//
// 几段一起上，缺一不可：母语那几段必须留下，夹了一整句英文的那段和纯英文那段
// 必须送出去。只断言前者会被「把闸门整个关死」蒙混过关。
const { test, expect } = require('./fixtures');
const { setExtensionSettings, triggerPageTranslation } = require('./helpers');
const { startMockOpenAIServer } = require('./mock-openai-server');

const NATIVE = [
  '我最近在用 React Server Components 和 Next.js App Router 重写博客，SSR 的性能提升很明显。',
  '这个 bug 是 TypeScript 的 strictNullChecks 引起的，改完以后编译就通过了。',
  '用 kubectl apply -f deployment.yaml 部署到 Kubernetes 集群，然后观察每个服务的日志。',
  '我们在 Hacker News 上看到一篇关于 Rust async runtime 的文章，作者对比了 tokio、async-std 和 smol 三个库的 benchmark。',
];
const MIXED = '今天天气很好，我们一起出门散步。I went to the park with my friends and we had a great picnic by the lake. 然后我们就回家了。';
const ENGLISH = 'The quick brown fox jumps over the lazy dog while the farmer watches from the porch.';

const PAGE = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>Native skip</title></head>
<body>
  ${NATIVE.map((text, i) => `<p id="native${i}">${text}</p>`).join('\n  ')}
  <p id="mixed">${MIXED}</p>
  <p id="english">${ENGLISH}</p>
</body></html>`;

test('中文正文夹英文名词不翻，夹了一整句英文的段落和英文段落照翻', async ({ page, context }) => {
  const { close, endpoint, sentTexts } = await startMockOpenAIServer();

  try {
    await setExtensionSettings(page, {
      apiEndpoint: endpoint,
      apiKey: 'test-key',
      modelName: 'gpt-4.1-mini',
      targetLang: 'zh-CN',
      skipTargetLanguageText: true,
    });

    await context.route('https://example.com/**', (route) => {
      route.fulfill({ status: 200, contentType: 'text/html', body: PAGE });
    });

    await page.goto('https://example.com/native-skip');
    await page.waitForSelector('#ai-translator-float-ball');
    await triggerPageTranslation(page);

    await page.waitForSelector('#mixed.ai-translator-translated', { timeout: 30000 });
    await page.waitForSelector('#english.ai-translator-translated', { timeout: 30000 });

    const all = sentTexts.join('\n');
    expect(all).toContain('I went to the park');
    expect(all).toContain('The quick brown fox');
    for (let i = 0; i < NATIVE.length; i++) {
      expect(all, `第 ${i} 段母语被送出去了`).not.toContain(NATIVE[i].slice(0, 12));
      await expect(page.locator(`#native${i}`)).not.toHaveClass(/ai-translator-translated/);
    }
  } finally {
    await close();
  }
});
