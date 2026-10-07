// 内置引擎把占位符的花括号掉了一边，公式和「保留原文」的元素照样回到译文里。
//
// 实测（2026-10-07，Chrome 内置 Translator en→pt，7 个真页面）：带占位符的块有
// 22% 丢了至少一个占位符，丢法全是掉括号（`{n}}`、`{{n}`、`{n}`），最常见的位置
// 就是这一页铺的几种 —— 句点后紧贴的行内公式、句点后紧贴的 translate="no"、
// 两个紧挨着的占位符、链接里只有一个占位符。修之前这些块整块判失败，留着原文
// 挂「翻译失败」。
//
// e2e 的 Chromium 没有端侧模型，引擎是替身（stubBuiltinTranslator 的
// dropBraces：按实测的三种形状轮流掉括号）。页面由 context.route 供给；AI 走
// mock-openai-server.js，只用来证明没有回落过去。
const { test, expect } = require('./fixtures');
const {
  evaluateInContentScript,
  setExtensionSettings,
  stubBuiltinTranslator,
  waitForContentReady,
} = require('./helpers');
const { startMockOpenAIServer } = require('./mock-openai-server');

const SITE = 'https://placeholder-braces.test';

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Placeholder braces</title></head>
<body>
  <p id="math">The series converges for every bounded input sequence.<math><mi>x</mi><mo>=</mo><mn>1</mn></math> The remaining cases follow from the lemma above.</p>
  <p id="adjacent">Every customer receives <span translate="no">Blab</span><span translate="no">Pro</span> with the default installation of the extension.</p>
  <p id="linked">Please read the <a href="/guide"><span translate="no">Quickstart</span></a> guide before installing the extension on a new profile.</p>
</body></html>`;

const BLOCKS = ['math', 'adjacent', 'linked'];

async function serve(context) {
  await context.route(`${SITE}/**`, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: PAGE }));
}

function translationOf(page, id) {
  return page.locator(`#${id} + .ai-translator-inline-block`);
}

test.describe('built-in engine placeholder braces', () => {
  let mock;

  test.beforeEach(async () => {
    mock = await startMockOpenAIServer();
  });

  test.afterEach(async () => {
    await mock.close();
  });

  test('placeholders that come back with a brace missing still put the formula and the kept words back', async ({ page, context }) => {
    await serve(context);
    await setExtensionSettings(page, {
      apiEndpoint: mock.endpoint,
      apiKey: 'test-key',
      modelName: 'gpt-4.1-mini',
      targetLang: 'zh-CN',
      skipTargetLanguageText: false,
      translationStyle: 'underline',
      translationEngine: 'builtin',
      autoTranslateEngine: 'builtin',
    });

    await page.goto(`${SITE}/doc`);
    await waitForContentReady(page);
    await stubBuiltinTranslator(page, { dropBraces: true });
    await page.click('#ai-translator-float-ball', { position: { x: 18, y: 18 } });
    for (const id of BLOCKS) await expect(translationOf(page, id)).toContainText('[B]');
    await page.waitForSelector('#ai-translator-progress', { state: 'hidden', timeout: 30000 });

    // 替身真的收到了占位符（掉括号是它做的，不是没东西可掉）：句点后紧贴的
    // {{1}}、紧挨着的一对、链接里单独一个。
    const sent = await evaluateInContentScript(context, page, 'self.__builtinTexts');
    expect(sent.join('\n')).toMatch(/\.\{\{\d+\}\}/);
    expect(sent.join('\n')).toMatch(/\{\{\d+\}\}\{\{\d+\}\}/);
    expect(sent.join('\n')).toMatch(/<a\d+>\{\{\d+\}\}<\/a\d+>/);

    // 每一块都译了、没有一块挂「翻译失败」，也没有回落到 AI。
    await expect(page.locator('.ai-translator-failed')).toHaveCount(0);
    expect(mock.sentTexts).toEqual([]);

    // 元素一个不少地克隆回译文，花括号残片一个不剩。
    await expect(translationOf(page, 'math').locator('math')).toHaveCount(1);
    await expect(translationOf(page, 'adjacent').locator('span[translate="no"]')).toHaveText(['Blab', 'Pro']);
    await expect(translationOf(page, 'linked').locator('a span[translate="no"]')).toHaveText('Quickstart');
    for (const id of BLOCKS) {
      await expect(translationOf(page, id)).not.toContainText('{');
      await expect(translationOf(page, id)).not.toContainText('}');
    }
  });
});
