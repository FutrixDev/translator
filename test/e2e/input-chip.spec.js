// 输入框上那颗「译成 X」芯片的旅程（PRD FR-8，写回见 D-352、D-357）。
//
// 在一个英文页面上敲中文，框边冒出一颗「译成 English」，点一下，译文直接写回这个
// 框：多行的框在原文后面换一行接上，单行的框整段换掉，Ctrl/Cmd+Z 一步撤回。
//
// 这里的编辑器全是仿制品，不是真的 x.com 或 reddit（页面和仿制编辑器在
// test/e2e/input-chip-fixtures.js）。覆盖的形状只有这些：
// - 原生 textarea / input，含设了 maxlength 的各一个：React 受控组件读的就是它们的
//   原生 value 和 input 事件。
// - Lexical 形状的模型编辑器：只从 beforeinput 读意图、接 paste、自己维护模型和
//   撤销栈、每次改完从模型重画 DOM；同一个放进 open shadow root 再来一遍（reddit
//   的评论框在 shadow DOM 里）；再来一个晚一拍才把 paste 写进模型的。
// - Draft 形状的块编辑器：不看原生 beforeinput，input 时按锚点所在的块从 DOM 反推
//   模型，光标只从 selectionchange 学，接 paste。
// 模型之外的 DOM 改动会被重画抹掉，所以断言读的是模型，不是 DOM。真 Draft、真
// Lexical 不在这里：它们的回归靠 evidence/r33/b/controller-walk 的真站复走。
const { test, expect } = require('./fixtures');
const { setExtensionSettings } = require('./helpers');
const { startMockOpenAIServer } = require('./mock-openai-server');
const { PAGE } = require('./input-chip-fixtures');

const ORIGIN = 'https://chip.test';

const CHINESE = '请问下午那班船还有座位吗，我想带两个孩子一起过去。';
const TRANSLATION = `[T] ${CHINESE}`;
const CHIP = '#ai-translator-input-chip';

async function serve(context) {
  await context.route(`${ORIGIN}/**`, (route) => {
    route.fulfill({ status: 200, contentType: 'text/html', body: PAGE });
  });
}

async function openPage(page, context, endpoint, extra = {}) {
  await setExtensionSettings(page, {
    apiEndpoint: endpoint,
    apiKey: 'test-key',
    modelName: 'gpt-4.1-mini',
    // 设置里的目标语言是中文，而芯片说的是「译成 English」：芯片的方向是从
    // **页面语言**算出来的，不是从这一条。
    targetLang: 'zh-CN',
    ...extra,
  });
  await serve(context);
  await page.goto(`${ORIGIN}/thread`);
  await page.waitForSelector('#ai-translator-float-ball');
}

async function typeInto(page, selector, text) {
  await page.click(selector);
  await page.fill(selector, text);
}

const undo = (page) => page.keyboard.press('ControlOrMeta+z');

test('输入框芯片：textarea 点一下，原文后换一行接上译文，一步撤回', async ({ page, context }) => {
  const { close, endpoint, sentTexts } = await startMockOpenAIServer();

  try {
    await openPage(page, context, endpoint);
    await typeInto(page, '#reply', CHINESE);

    const chip = page.locator(CHIP);
    await expect(chip).toBeVisible({ timeout: 10000 });
    await expect(chip).toContainText('English');
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

    await expect(page.locator('#reply')).toHaveValue(`${CHINESE}\n${TRANSLATION}`, { timeout: 15000 });
    expect(sentTexts.join('\n')).toContain(CHINESE);
    // 写完芯片就退场，也不会对「原文 + 译文」再冒出来。
    await expect(chip).toHaveCount(0);
    await page.waitForTimeout(1500);
    await expect(chip).toHaveCount(0);

    // 不开对话框、不提交、不按 Enter、焦点还在原来的框里。
    await expect(page.locator('#ai-translator-input-dialog')).toHaveCount(0);
    const quiet = await page.evaluate(() => ({
      submits: window.submits,
      enters: window.enters,
      focused: document.activeElement && document.activeElement.id,
    }));
    expect(quiet).toEqual({ submits: 0, enters: 0, focused: 'reply' });

    await undo(page);
    await expect(page.locator('#reply')).toHaveValue(CHINESE);
    expect(sentTexts).toHaveLength(1);
  } finally {
    await close();
  }
});

test('输入框芯片：单行 input 用译文替换原文，一步撤回', async ({ page, context }) => {
  const { close, endpoint } = await startMockOpenAIServer();

  try {
    await openPage(page, context, endpoint);
    await typeInto(page, '#subject', CHINESE);

    const chip = page.locator(CHIP);
    await expect(chip).toBeVisible({ timeout: 10000 });
    await chip.click();

    await expect(page.locator('#subject')).toHaveValue(TRANSLATION, { timeout: 15000 });
    await expect(chip).toHaveCount(0);
    expect(await page.evaluate(() => window.submits)).toBe(0);

    await undo(page);
    await expect(page.locator('#subject')).toHaveValue(CHINESE);
  } finally {
    await close();
  }
});

// 模型编辑器读的是它自己那份模型。断言也读模型：DOM 上有字而模型里没有，发出去的
// 帖子里就没有译文。
async function writeIntoModelEditor(page, { selector, handle }) {
  await page.click(selector);
  // 聚焦之后先停一会儿，让 focusin 那一轮判定（400ms 防抖）在空框上跑完；不然字在
  // 防抖窗口里就进了框，芯片是 focusin 叫醒的，beforeinput 那条路就没被测到。这类
  // 编辑器取消 beforeinput，不再有 input 事件，之后能叫醒芯片的只有 beforeinput。
  await page.waitForTimeout(1000);
  await page.keyboard.insertText(CHINESE);
  await expect.poll(() => page.evaluate((name) => window[name].model, handle)).toBe(CHINESE);

  const chip = page.locator(CHIP);
  await expect(chip).toBeVisible({ timeout: 10000 });
  await chip.click();

  await expect.poll(() => page.evaluate((name) => window[name].model, handle), { timeout: 15000 })
    .toBe(`${CHINESE}\n${TRANSLATION}`);
  await expect(chip).toHaveCount(0);
  // 判语言有 400ms 防抖：等过去再看，芯片也没对「原文 + 译文」再冒出来。
  await page.waitForTimeout(1500);
  await expect(chip).toHaveCount(0);
  // 模型收到的是一次 paste，不是一段来历不明的 DOM 变化。
  const types = await page.evaluate((name) => window[name].types, handle);
  expect(types[types.length - 1]).toBe('paste');
  // 编辑器按模型重画之后，框里看到的也是这两段。
  await expect(page.locator(selector)).toContainText(TRANSLATION);

  await undo(page);
  await expect.poll(() => page.evaluate((name) => window[name].model, handle)).toBe(CHINESE);
}

test('输入框芯片：Lexical 形状的编辑器，译文进了它的模型', async ({ page, context }) => {
  const { close, endpoint } = await startMockOpenAIServer();

  try {
    await openPage(page, context, endpoint);
    await writeIntoModelEditor(page, { selector: '#model-editor', handle: 'lightEditor' });
    expect(await page.evaluate(() => ({ submits: window.submits, enters: window.enters })))
      .toEqual({ submits: 0, enters: 0 });
  } finally {
    await close();
  }
});

test('输入框芯片：open shadow root 里的编辑器，芯片出现，译文写进模型', async ({ page, context }) => {
  const { close, endpoint } = await startMockOpenAIServer();

  try {
    await openPage(page, context, endpoint);
    await writeIntoModelEditor(page, { selector: '#shadow-host #shadow-editor', handle: 'shadowEditor' });
  } finally {
    await close();
  }
});

// x.com 的发帖框就是这个形状。c5d37ea 在这里用 execCommand 插「\n译文」：Chromium
// 把块连同 data-offset-key 复制一份，编辑器按锚点那一块从 DOM 反推，原文被冲掉。
test('输入框芯片：Draft 形状的编辑器，原文还在、译文一份、一步撤回', async ({ page, context }) => {
  const { close, endpoint, sentTexts } = await startMockOpenAIServer();
  const model = () => page.evaluate(() => window.draftEditor.text());

  try {
    await openPage(page, context, endpoint);
    await page.click('#draft-editor');
    await page.waitForTimeout(1000);
    await page.keyboard.insertText(CHINESE);
    await expect.poll(model).toBe(CHINESE);

    const chip = page.locator(CHIP);
    await expect(chip).toBeVisible({ timeout: 10000 });
    // 光标停在开头：译文仍要接在末尾，而不是插在编辑器以为的光标处。
    await page.keyboard.press('Home');
    await expect.poll(() => page.evaluate(() => window.draftEditor.caret.offset)).toBe(0);
    await chip.click();

    await expect.poll(model, { timeout: 15000 }).toBe(`${CHINESE}\n${TRANSLATION}`);
    expect(await page.evaluate(() => window.draftEditor.pastes)).toBe(1);
    await expect(page.locator('#draft-editor > div')).toHaveCount(2);
    await expect(chip).toHaveCount(0);
    await page.waitForTimeout(1500);
    await expect(chip).toHaveCount(0);
    expect(sentTexts).toHaveLength(1);
    expect(await page.evaluate(() => ({ submits: window.submits, enters: window.enters })))
      .toEqual({ submits: 0, enters: 0 });

    await undo(page);
    await expect.poll(model).toBe(CHINESE);
  } finally {
    await close();
  }
});

// 编辑器接了 paste，却晚一拍才写进模型：写回那一刻核对不过，芯片报错。可字随后就
// 落进来了 —— 用户再点一下，芯片认出这一份已经写了：不再发请求，不再追加。
test('输入框芯片：编辑器晚一拍才写进去，报错；再点一下认出已经写了，不再追加', async ({ page, context }) => {
  const { close, endpoint, sentTexts } = await startMockOpenAIServer();
  const model = () => page.evaluate(() => window.lateEditor.model);

  try {
    await openPage(page, context, endpoint);
    await page.click('#late-editor');
    await page.waitForTimeout(1000);
    await page.keyboard.insertText(CHINESE);
    await expect.poll(model).toBe(CHINESE);

    const chip = page.locator(CHIP);
    await expect(chip).toBeVisible({ timeout: 10000 });
    await chip.click();
    await expect(chip).toHaveAttribute('data-state', 'error', { timeout: 15000 });
    await expect.poll(model).toBe(`${CHINESE}\n${TRANSLATION}`);

    await chip.click();
    await expect(chip).toHaveCount(0);
    await page.waitForTimeout(1500);
    await expect(chip).toHaveCount(0);
    expect(await model()).toBe(`${CHINESE}\n${TRANSLATION}`);
    expect(sentTexts).toHaveLength(1);
  } finally {
    await close();
  }
});

// 浏览器会把超出 maxlength 的那一截悄悄截掉。写回在动手之前就量好：装不下就一个字
// 都不碰，芯片报错。
test('输入框芯片：maxlength 装不下，框里的字一个不动，芯片显示出错', async ({ page, context }) => {
  const { close, endpoint, sentTexts } = await startMockOpenAIServer();

  try {
    await openPage(page, context, endpoint);
    const chip = page.locator(CHIP);
    // 原文 25 个字装得下；「原文 + 换行 + 译文」55 个装不进 50，译文 29 个装不进 28。
    for (const [selector, max] of [['#short-reply', 50], ['#short-subject', 28]]) {
      await typeInto(page, selector, CHINESE);
      await expect(page.locator(selector)).toHaveAttribute('maxlength', String(max));
      await expect(chip).toBeVisible({ timeout: 10000 });
      await expect(chip).not.toHaveAttribute('data-state', /.+/);
      await chip.click();
      await expect(chip).toHaveAttribute('data-state', 'error', { timeout: 15000 });
      await expect(page.locator(selector)).toHaveValue(CHINESE);
    }
    expect(sentTexts).toHaveLength(2);
  } finally {
    await close();
  }
});

test('输入框芯片：译文回来之前框里的字变了，就不写，芯片回到可点', async ({ page, context }) => {
  const { close, endpoint, sentTexts } = await startMockOpenAIServer({ delayMs: 4000 });

  try {
    await openPage(page, context, endpoint);
    await typeInto(page, '#reply', CHINESE);

    const chip = page.locator(CHIP);
    await expect(chip).toBeVisible({ timeout: 10000 });
    await chip.click();
    await expect(chip).toHaveAttribute('data-state', 'busy');

    // 焦点从没离开过 textarea（芯片按下去时拦住了 mousedown），接着敲就是接着写。
    await page.keyboard.type('!');
    // 芯片当场回到可点，不用等那份作废的译文回来。
    await expect(chip).not.toHaveAttribute('data-state', /.+/, { timeout: 2000 });
    await expect.poll(() => sentTexts.length, { timeout: 10000 }).toBe(1);
    // 那份迟到的译文回来之后也不许写进去。
    await page.waitForTimeout(5000);
    await expect(page.locator('#reply')).toHaveValue(`${CHINESE}!`);
    await expect(chip).toBeVisible();
    await expect(chip).not.toHaveAttribute('data-state', /.+/);
    await expect(chip).toContainText('English');

    // 焦点换了框：同样不写。
    await chip.click();
    await expect(chip).toHaveAttribute('data-state', 'busy');
    await page.click('#subject');
    await expect.poll(() => sentTexts.length, { timeout: 10000 }).toBe(2);
    await page.waitForTimeout(5000);
    await expect(page.locator('#reply')).toHaveValue(`${CHINESE}!`);
    await expect(page.locator('#subject')).toHaveValue('');

    // 页面自己的脚本改了框里的字（自动格式化、草稿恢复），不发 input 事件：
    // 芯片没机会提前作废这次请求，译文回来时拿快照一比，照样不写。
    await page.click('#reply');
    await expect(chip).toBeVisible({ timeout: 10000 });
    await chip.click();
    await expect(chip).toHaveAttribute('data-state', 'busy');
    await page.evaluate(() => { document.querySelector('#reply').value += '?'; });
    await expect.poll(() => sentTexts.length, { timeout: 10000 }).toBe(3);
    await expect(chip).not.toHaveAttribute('data-state', /.+/, { timeout: 15000 });
    await expect(page.locator('#reply')).toHaveValue(`${CHINESE}!?`);
    await expect(chip).toContainText('English');
  } finally {
    await close();
  }
});

test('输入框芯片：翻译失败，框里的字不动，芯片显示出错，再点一下重试', async ({ page, context }) => {
  let refuse = true;
  const { close, endpoint } = await startMockOpenAIServer({ failWhen: () => refuse });

  try {
    await openPage(page, context, endpoint);
    await typeInto(page, '#reply', CHINESE);

    const chip = page.locator(CHIP);
    await expect(chip).toBeVisible({ timeout: 10000 });
    await chip.click();

    await expect(chip).toHaveAttribute('data-state', 'error', { timeout: 15000 });
    await expect(page.locator('#reply')).toHaveValue(CHINESE);

    refuse = false;
    await chip.click();
    await expect(page.locator('#reply')).toHaveValue(`${CHINESE}\n${TRANSLATION}`, { timeout: 15000 });
    await expect(chip).toHaveCount(0);
  } finally {
    await close();
  }
});

test('输入框芯片：写的就是这一页的语言，就没有芯片', async ({ page, context }) => {
  const { close, endpoint, sentTexts } = await startMockOpenAIServer();

  try {
    await openPage(page, context, endpoint);
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
    await openPage(page, context, endpoint);
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
