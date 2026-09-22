// 输入框上那颗「译成 X」芯片的旅程（PRD FR-8）。
//
// 输入翻译这个功能本来就有，可它唯一的入口是悬浮球菜单里的一行——要想起它存在，
// 要点两次，还要把刚敲的字再复制一遍。这条 spec 走的是那扇开在门本来该在的地方
// 的门：在一个英文页面上敲中文，框边冒出一颗芯片，点一下，译文就在对话框里。
//
// 三件「它不做的事」和那一件「它做的事」同样重要，所以都在这里走一遍：原框里的
// 字一个都没动；点下去之前一个请求都没发；写的就是这一页的语言时它不出声。
const { test, expect } = require('./fixtures');
const { setExtensionSettings } = require('./helpers');
const { startMockOpenAIServer } = require('./mock-openai-server');

const ORIGIN = 'https://chip.test';

// 正文要够长、够像英语：页面语言是 chrome.i18n.detectLanguage 从整页正文里读出来
// 的，几十个字符上它很容易判错。
const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Harbour forum</title></head>
<body>
  <p>The ferry leaves the northern pier every morning at a quarter past six, and the
     afternoon crossing is posted on the noticeboard by the harbour master every Friday.</p>
  <p>Passengers who miss the early boat can wait for the second sailing or take the
     coastal road around the bay, which adds about forty minutes to the journey.</p>
  <label>Reply <textarea id="reply" rows="4" cols="60"></textarea></label>
  <label>Password <input id="secret" type="password"></label>
</body></html>`;

const CHINESE = '请问下午那班船还有座位吗，我想带两个孩子一起过去。';
const CHIP = '#ai-translator-input-chip';

async function serve(context) {
  await context.route(`${ORIGIN}/**`, (route) => {
    route.fulfill({ status: 200, contentType: 'text/html', body: PAGE });
  });
}

async function typeInto(page, selector, text) {
  await page.click(selector);
  await page.fill(selector, text);
}

test('输入框芯片：英文页面上敲中文，框边出现「译成 English」', async ({ page, context }) => {
  const { close, endpoint, sentTexts } = await startMockOpenAIServer();

  try {
    await setExtensionSettings(page, {
      apiEndpoint: endpoint,
      apiKey: 'test-key',
      modelName: 'gpt-4.1-mini',
      // 设置里的目标语言是中文，而芯片说的是「译成 English」：芯片的方向是从
      // **页面语言**算出来的，不是从这一条。下面那句 toContainText 守的就是它。
      targetLang: 'zh-CN',
    });
    await serve(context);
    await page.goto(`${ORIGIN}/thread`);
    await page.waitForSelector('#ai-translator-float-ball');

    await typeInto(page, '#reply', CHINESE);

    const chip = page.locator(CHIP);
    await expect(chip).toBeVisible({ timeout: 10000 });
    await expect(chip).toContainText('English');

    // 永不自动改写用户输入。
    await expect(page.locator('#reply')).toHaveValue(CHINESE);
    // 点击才译：到这一刻为止，一个字都没出过这台机器。
    expect(sentTexts).toEqual([]);

    // 芯片贴在输入框右下角外侧，压不到用户正在写的那一行。
    const boxes = await page.evaluate((sel) => {
      const field = document.querySelector('#reply').getBoundingClientRect();
      const node = document.querySelector(sel).getBoundingClientRect();
      return { field: { right: field.right, bottom: field.bottom }, node: { top: node.top, right: node.right } };
    }, CHIP);
    expect(boxes.node.top).toBeGreaterThanOrEqual(boxes.field.bottom);
    expect(Math.abs(boxes.node.right - boxes.field.right)).toBeLessThan(12);

    await chip.click();

    await page.waitForSelector('#ai-translator-input-dialog', { state: 'visible' });
    // 文字是**复制**进来的，原框照旧。
    await expect(page.locator('#ai-translator-input-text')).toHaveValue(CHINESE);
    await expect(page.locator('#reply')).toHaveValue(CHINESE);
    // 目标语言跟着芯片走，不是设置里的中文。
    await expect(page.locator('#ai-translator-input-dialog .ai-translator-lang-label')).toHaveText('English');
    // 点芯片就是那一下「点击才译」，不用在框里再按一次翻译。
    await expect(page.locator('#ai-translator-input-dialog #ai-translator-result-text'))
      .toContainText(CHINESE.slice(0, 6), { timeout: 15000 });
    expect(sentTexts.join('\n')).toContain(CHINESE);

    // 芯片自己在点下去的那一刻就退场了。
    await expect(chip).toHaveCount(0);
  } finally {
    await close();
  }
});

test('输入框芯片：写的就是这一页的语言，就没有芯片', async ({ page, context }) => {
  const { close, endpoint, sentTexts } = await startMockOpenAIServer();

  try {
    await setExtensionSettings(page, { apiEndpoint: endpoint, apiKey: 'test-key', targetLang: 'zh-CN' });
    await serve(context);
    await page.goto(`${ORIGIN}/thread`);
    await page.waitForSelector('#ai-translator-float-ball');

    await typeInto(page, '#reply',
      'There are still seats on the afternoon crossing, and children under five travel free.');
    // 判断是防抖的（400ms），给它足够长的时间去做出「出现」这个动作。
    await page.waitForTimeout(2500);
    await expect(page.locator(CHIP)).toHaveCount(0);
    expect(sentTexts).toEqual([]);
  } finally {
    await close();
  }
});

test('输入框芯片：密码框上不长，开关关掉后哪儿都不长', async ({ page, context }) => {
  const { close, endpoint } = await startMockOpenAIServer();

  try {
    await setExtensionSettings(page, { apiEndpoint: endpoint, apiKey: 'test-key', targetLang: 'zh-CN' });
    await serve(context);
    await page.goto(`${ORIGIN}/thread`);
    await page.waitForSelector('#ai-translator-float-ball');

    await typeInto(page, '#secret', CHINESE);
    await page.waitForTimeout(2500);
    await expect(page.locator(CHIP)).toHaveCount(0);

    // 同一段字，换到正经的输入框里就该有芯片 —— 否则上面那条断言证明不了
    // 「密码框被挡住了」，只能证明「这台机器今天判不出中文」。
    await typeInto(page, '#reply', CHINESE);
    await expect(page.locator(CHIP)).toBeVisible({ timeout: 10000 });

    await setExtensionSettings(page, {
      apiEndpoint: endpoint,
      apiKey: 'test-key',
      targetLang: 'zh-CN',
      showInputTranslateChip: false,
    });
    // 关开关的人多半正看着那颗芯片：它得当场消失，而不是等下一次敲键。
    await expect(page.locator(CHIP)).toHaveCount(0, { timeout: 10000 });

    await typeInto(page, '#reply', `${CHINESE}再问一句。`);
    await page.waitForTimeout(2500);
    await expect(page.locator(CHIP)).toHaveCount(0);
  } finally {
    await close();
  }
});
