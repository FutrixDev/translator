// 输入框上那颗「译成 X」芯片的旅程（PRD FR-8，写回见 D-352）。
//
// 在一个英文页面上敲中文，框边冒出一颗「译成 English」，点一下，译文直接写回这个
// 框：多行的框在原文后面换一行接上，单行的框整段换掉，Ctrl/Cmd+Z 一步撤回。
//
// 这里的编辑器全是仿制品，不是真的 x.com 或 reddit：
// - 原生 textarea / input：React 受控组件读的就是它们的原生 value 和 input 事件。
// - 「模型编辑器」：一个 contenteditable，只从 beforeinput 读意图、自己维护一份
//   模型和撤销栈、每次改完从模型重画 DOM —— Draft.js、Lexical（reddit 评论框）
//   都是这个形状。模型之外的 DOM 改动会在下一次 input 时被重画抹掉，所以只改了
//   DOM 的写法在这里过不了关；断言读的是模型，不是 DOM。
// - 同一个模型编辑器放进 open shadow root：reddit 的评论框就在 shadow DOM 里。
const { test, expect } = require('./fixtures');
const { setExtensionSettings } = require('./helpers');
const { startMockOpenAIServer } = require('./mock-openai-server');

const ORIGIN = 'https://chip.test';

// 一个 Draft/Lexical 形状的编辑器：模型是一串字，撤销栈是模型的快照。
const MODEL_EDITOR = `
function mountModelEditor(el) {
  const editor = { model: '', history: [], types: [] };
  el.contentEditable = 'true';
  el.setAttribute('role', 'textbox');
  const root = el.getRootNode();

  function render() {
    el.replaceChildren(...editor.model.split('\\n').map((line) => {
      const row = document.createElement('div');
      if (line) row.textContent = line;
      else row.appendChild(document.createElement('br'));
      return row;
    }));
    const selection = document.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function commit(next) {
    editor.history.push(editor.model);
    editor.model = next;
    queueMicrotask(render);
  }

  el.addEventListener('beforeinput', (e) => {
    e.preventDefault();
    editor.types.push(e.inputType);
    const data = e.data ?? (e.dataTransfer ? e.dataTransfer.getData('text/plain') : '');
    switch (e.inputType) {
      case 'insertText':
      case 'insertReplacementText':
      case 'insertFromPaste':
        if (data) commit(editor.model + data);
        break;
      case 'insertLineBreak':
      case 'insertParagraph':
        commit(editor.model + '\\n');
        break;
      case 'deleteContentBackward':
        commit(editor.model.slice(0, -1));
        break;
      default:
        break;
    }
  });
  // 模型之外的改动（有人绕过 beforeinput 直接动了 DOM）在这里被抹掉。
  el.addEventListener('input', () => queueMicrotask(render));
  el.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (editor.history.length) {
        editor.model = editor.history.pop();
        queueMicrotask(render);
      }
    }
  });
  render();
  return editor;
}
`;

// 正文要够长、够像英语：页面语言是 chrome.i18n.detectLanguage 从整页正文里读出来
// 的，几十个字符上它很容易判错。
const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Harbour forum</title></head>
<body>
  <p>The ferry leaves the northern pier every morning at a quarter past six, and the
     afternoon crossing is posted on the noticeboard by the harbour master every Friday.</p>
  <p>Passengers who miss the early boat can wait for the second sailing or take the
     coastal road around the bay, which adds about forty minutes to the journey.</p>
  <form id="reply-form" action="/posted" method="post">
    <label>Reply <textarea id="reply" rows="4" cols="60"></textarea></label>
    <label>Subject <input id="subject" type="text" size="60"></label>
    <button type="submit">Post</button>
  </form>
  <label>Password <input id="secret" type="password"></label>
  <p>Rich editor</p>
  <div id="model-editor" style="min-height:3em;border:1px solid #999"></div>
  <p>Comment box</p>
  <div id="shadow-host"></div>
  <script>
    ${MODEL_EDITOR}
    window.submits = 0;
    window.enters = 0;
    document.getElementById('reply-form').addEventListener('submit', (e) => {
      e.preventDefault();
      window.submits += 1;
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') window.enters += 1;
    }, true);
    window.lightEditor = mountModelEditor(document.getElementById('model-editor'));
    const shadow = document.getElementById('shadow-host').attachShadow({ mode: 'open' });
    const inner = document.createElement('div');
    inner.id = 'shadow-editor';
    inner.style.cssText = 'min-height:3em;border:1px solid #999';
    shadow.appendChild(inner);
    window.shadowEditor = mountModelEditor(inner);
  </script>
</body></html>`;

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
  // 模型收到的是一次 insertText，不是一段来历不明的 DOM 变化。
  const types = await page.evaluate((name) => window[name].types, handle);
  expect(types[types.length - 1]).toBe('insertText');
  // 编辑器按模型重画之后，框里看到的也是这两段。
  await expect(page.locator(selector)).toContainText(TRANSLATION);

  await undo(page);
  await expect.poll(() => page.evaluate((name) => window[name].model, handle)).toBe(CHINESE);
}

test('输入框芯片：Draft/Lexical 形状的编辑器，译文进了它的模型', async ({ page, context }) => {
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
