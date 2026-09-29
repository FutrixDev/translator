// P1-C C4：划词卡片「加入术语表」（设计 docs/plans/2026-09-25-p1-c-glossary.md §5、
// §6.1 C-J7）。J-D9 的点击清单（点「加入术语表」保存后动作行几何不变）在
// test/e2e/selection-card.spec.js 的 J-D9 里，十种界面语言各点一次。
//
// 全部走真实界面：真实拖选出图标、点图标出卡片、点按钮展开表单、在表单里改字选
// 范围、点保存。只有观察点用辅助函数：读 mock 收到的 system prompt、读存储里的
// 词条、读内容脚本的 generation / topHost（用来等「页面的词表镜像已经更新」「子帧
// 拿到了顶层指令」这两个异步事实，而不是睡一觉）。顶替用户动作的只有一处，标
// [fixture] 并写了理由。
//
// 页面全部由 context.route 供给（https：内置引擎是 SecureContext API，换引擎那一步
// 只在 https 上存在）；AI 走 mock-openai-server.js，答 `[T] <原文>`；内置引擎是
// stubBuiltinTranslator 的替身，答 `[B] <原文>`。
const { test, expect } = require('./fixtures');
const {
  evaluateInContentScript,
  setExtensionSettings,
  storedGlossary,
  stubBuiltinTranslator,
  waitForContentReady,
} = require('./helpers');
const { expectLaidOut } = require('./layout-checks');
const { startMockOpenAIServer } = require('./mock-openai-server');
const { getMessage } = require('../../i18n/messages');

const SITE = 'https://terms.test';
const SITE_HOST = 'terms.test';
const EMBED = 'https://terms-embed.test';

const STYLE = `
  body { margin: 0; padding: 40px 60px; font: 18px/28px Georgia, serif; color: #222; background: #fff; }
  p { width: 640px; margin: 0 0 28px; }
`;

// 超过 80 字（Glossary.LIMITS.source）的一段：卡片照样翻，但不给「加入术语表」。
const LONG = 'The Transformer architecture changed how machine translation systems are built, '
  + 'because every token can look at every other token in the sentence at once.';

// Glossary.LIMITS.source 的两边（D-384 A1）：正好 80 字给按钮，81 字不给。全是
// ASCII，JS 的 length 和 normalizeSource 数的一样；测试里再断言一次长度，改字时
// 夹具不会悄悄偏到别处。
const AT_LIMIT = 'Attention lets each token weigh all the other tokens in one sentence at once. Ok';
const OVER_LIMIT = `${AT_LIMIT}!`;

// 主机当不了术语表键的页面（D-384 A6）：IPv6 字面量。
const IPV6 = 'https://[::1]';

const html = (body) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Term notes</title><style>${STYLE}</style></head>
<body>${body}</body></html>`;

const PAGES = {
  [`${SITE}/`]: html(`
    <p id="lead"><span id="term">Transformer</span> models read a whole sentence at once.</p>
    <p id="long">${LONG}</p>`),
  [`${SITE}/framed`]: html(`
    <p id="intro">Notes from readers, embedded from another site.</p>
    <iframe id="embed" src="${EMBED}/note" width="900" height="480" style="border:0;display:block"></iframe>`),
  [`${SITE}/more`]: html(`
    <p id="at-limit">${AT_LIMIT}</p>
    <p id="over-limit">${OVER_LIMIT}</p>
    <p id="lower-p"><span id="lower">attention</span> decides which tokens matter.</p>`),
  [`${IPV6}/`]: html(`
    <p id="lead"><span id="term">Transformer</span> models read a whole sentence at once.</p>`),
  [`${EMBED}/note`]: html(`
    <p id="note"><span id="embed-term">Transformer</span> layers stack attention and feed-forward blocks.</p>`),
};

function fulfill(route) {
  const body = PAGES[route.request().url().split(/[?#]/)[0]];
  if (!body) return route.fulfill({ status: 404, body: 'not found' });
  return route.fulfill({ status: 200, contentType: 'text/html', body });
}

async function serve(context) {
  for (const origin of [SITE, EMBED]) {
    await context.route(`${origin}/**`, fulfill);
  }
  // glob 里的方括号是字符类，IPv6 主机只能按 hostname 认。
  await context.route((url) => url.hostname === '[::1]', fulfill);
}

function settings(endpoint, extra = {}) {
  return {
    provider: 'custom',
    apiEndpoint: endpoint,
    apiKey: 'test-key',
    modelName: 'gpt-4.1-mini',
    targetLang: 'zh-CN',
    enableSelection: true,
    selectionTranslationMode: 'popup',
    // 就绪信号（设计 §6）：内容脚本读完设置就把它写到 <html>，见 waitForContentReady。
    translationStyle: 'underline',
    ...extra,
  };
}

// 真实拖选：从元素第一行开头拖到最后一行末尾（行高 28px，取行中）。元素可以在
// 子 frame 里：量的是它在页面上的框，鼠标在页面上。
async function dragAcross(page, target) {
  const box = await target.boundingBox();
  const lastLine = box.y + box.height - 14;
  const end = await target.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const rects = range.getClientRects();
    const last = rects[rects.length - 1];
    return { right: last.right, left: el.getBoundingClientRect().left };
  });
  await page.mouse.move(box.x + 2, box.y + 14);
  await page.mouse.down();
  await page.mouse.move(box.x + (end.right - end.left) - 2, lastLine, { steps: 12 });
  await page.mouse.up();
}

// 这些定位器既能挂在 page 上，也能挂在子 frame 上（卡片在哪个文档里就挂哪个）。
const icon = (root) => root.locator('#ai-translator-selection-btn .ai-translator-selection-icon');
const cardText = (root) => root.locator('.ai-translator-popup .ai-translator-translation-text');
const retranslateBtn = (root) => root.locator('.ai-translator-popup .ai-translator-retranslate');
const switchBtn = (root) => root.locator('.ai-translator-popup .ai-translator-switch-engine');
const addTermBtn = (root) => root.locator('.ai-translator-popup .ai-translator-add-term');
const form = (root) => root.locator('.ai-translator-popup .ai-translator-term-form');
const formSource = (root) => form(root).locator('.ai-translator-term-source');
const formInput = (root) => form(root).locator('.ai-translator-term-input');
const formScope = (root) => form(root).locator('.ai-translator-term-scope');
const formError = (root) => form(root).locator('.ai-translator-term-error');
const formSave = (root) => form(root).locator('.ai-translator-term-save');
const cardError = (root) => root.locator('.ai-translator-popup .ai-translator-error');

// 表单里并排的每一样（没有谁包着谁），给 expectLaidOut 量「露出、在视口里、互不
// 重叠、字对底色 ≥ 4.5:1」。
const FORM_PARTS = [
  '.ai-translator-term-row:nth-child(1) .ai-translator-term-label',
  '.ai-translator-term-source',
  '.ai-translator-term-row:nth-child(2) .ai-translator-term-label',
  '.ai-translator-term-input',
  '.ai-translator-term-row:nth-child(3) .ai-translator-term-label',
  '.ai-translator-term-scope',
  '.ai-translator-term-cancel',
  '.ai-translator-term-save',
];

/** 范围下拉框的选项：[value, 文字]。 */
function scopeOptions(root) {
  return formScope(root).locator('option').evaluateAll(
    (options) => options.map((o) => [o.value, o.textContent]));
}

/** 这一页内容脚本的词表代数（ctx.translationProfile.generation()）。 */
function generation(context, root) {
  return evaluateInContentScript(context, root, 'window.AI_TRANSLATOR_CONTENT.translationProfile.generation()');
}

/**
 * 范围下拉框有下拉箭头（D-384 A7-b）：重置把 appearance 设成 none 之后，箭头是
 * 包着下拉框那一层的 ::after，落在下拉框右边留出的位置里，颜色是次要文字色。
 */
async function expectScopeCaret(root) {
  const look = await formScope(root).evaluate((el) => {
    const style = getComputedStyle(el);
    const caret = getComputedStyle(el.parentElement, '::after');
    const box = el.getBoundingClientRect();
    return {
      appearance: style.appearance,
      padRight: parseFloat(style.paddingRight),
      content: caret.content,
      border: caret.borderBottomStyle,
      color: caret.borderBottomColor,
      label: getComputedStyle(el.closest('.ai-translator-term-row').querySelector('.ai-translator-term-label')).color,
      right: parseFloat(caret.right),
      height: box.height,
      wrapperHeight: el.parentElement.getBoundingClientRect().height,
    };
  });
  expect(look.appearance).toBe('none');
  expect(look.content).toBe('""');
  expect(look.border).toBe('solid');
  expect(look.color).toBe(look.label);
  expect(look.padRight).toBeGreaterThanOrEqual(24);
  expect(look.right).toBeLessThan(look.padRight);
  // 包层和下拉框一样高：箭头的 top: 50% 就是下拉框的竖直中线。
  expect(look.wrapperHeight).toBeCloseTo(look.height, 0);
}

async function openCard(page, selector) {
  await waitForContentReady(page);
  await dragAcross(page, page.locator(selector));
  await icon(page).click();
  await expect(cardText(page)).toContainText('[T]');
}

test.describe('P1-C C4 add a term from the selection card', () => {
  let mock;

  test.beforeEach(async () => {
    mock = await startMockOpenAIServer();
  });

  test.afterEach(async () => {
    await mock.close();
  });

  test('C-J7 a selected term is added for this site, added again as an update, and the retranslation carries it', async ({ page, context }) => {
    const zh = (key) => getMessage(key, 'zh-CN');
    await serve(context);
    await setExtensionSettings(page, settings(mock.endpoint, { uiLanguage: 'zh-CN' }));
    await page.goto(`${SITE}/`);

    // 1. 划 "Transformer"，卡片出译文：按钮露出。
    await openCard(page, '#term');
    await expect(addTermBtn(page)).toBeVisible();
    await expect(addTermBtn(page)).toHaveText(zh('glossaryAdd'));
    const buttonBox = await addTermBtn(page).boundingBox();

    // 2. 点「加入术语表」：表单在卡片里展开，原文只读、译文预填、范围默认仅本站。
    await addTermBtn(page).click();
    await expect(form(page)).toBeVisible();
    await expect(addTermBtn(page)).toHaveAttribute('aria-expanded', 'true');
    await expect(formSource(page)).toHaveText('Transformer');
    await expect(formInput(page)).toHaveValue(await cardText(page).textContent());
    await expect(formInput(page)).toBeFocused();
    expect(await scopeOptions(page)).toEqual([
      ['site', zh('glossaryScopeSite').replace('{host}', SITE_HOST)],
      ['all', zh('glossaryScopeAll')],
    ]);
    await expect(formScope(page)).toHaveValue('site');
    // 浅色主题（缺省）下表单可读、不溢出、不重叠。
    console.log(`C-J7 light form contrast: ${await expectLaidOut(page, FORM_PARTS, 'C-J7 light form')}`);
    await expectScopeCaret(page);

    // 译文改成「变换器」，保持仅本站，保存。
    const before = await generation(context, page);
    await formInput(page).fill('变换器');
    await formSave(page).click();
    await expect(addTermBtn(page)).toHaveText(zh('glossaryAdded'));
    await expect(form(page)).toBeHidden();
    await expect(addTermBtn(page)).toHaveAttribute('aria-expanded', 'false');
    // 改字不改宽（fitLabel）：按钮还在原处、原宽。
    expect(await addTermBtn(page).boundingBox()).toEqual(buttonBox);
    // 存储里多一条 h 为本页主机的词条；原文含大写，按缺省规则区分大小写；目标语言
    // 是这张卡片的目标语言，不是 *。
    let stored = await storedGlossary(context);
    expect(Object.values(stored)).toEqual([
      { s: 'Transformer', t: '变换器', c: 1, h: SITE_HOST, l: 'zh-CN', u: expect.any(Number) },
    ]);
    const [id] = Object.keys(stored);

    // 同原文再加一次：「已更新已有词条」，存储仍是一条（同一个键）。
    await addTermBtn(page).click();
    await expect(form(page)).toBeVisible();
    await formInput(page).fill('变换器');
    await formSave(page).click();
    await expect(addTermBtn(page)).toHaveText(zh('glossaryUpdated'));
    await expect(form(page)).toBeHidden();
    stored = await storedGlossary(context);
    expect(Object.keys(stored)).toEqual([id]);
    expect(stored[id]).toEqual({ s: 'Transformer', t: '变换器', c: 1, h: SITE_HOST, l: 'zh-CN', u: expect.any(Number) });

    // 保存不自动重译：一个请求都没多发。
    expect(mock.sentTexts).toHaveLength(1);
    expect(mock.systemPrompts[0]).not.toContain('"Transformer" → "变换器"');

    // 3. 页面的词表镜像跟上（storage.onChanged → generation 递增）之后点「重译」：
    // mock 收到的 prompt 带这一条。
    await expect.poll(() => generation(context, page)).toBeGreaterThan(before);
    await retranslateBtn(page).click();
    await expect.poll(() => mock.sentTexts.length).toBe(2);
    await expect(cardText(page)).toContainText('[T]');
    expect(mock.sentTexts[1]).toContain('Transformer');
    expect(mock.systemPrompts[1]).toContain('- "Transformer" → "变换器"');
  });

  test('C-J7 a selection over 80 characters is translated but offers no add-to-glossary', async ({ page, context }) => {
    await serve(context);
    await setExtensionSettings(page, settings(mock.endpoint));
    await page.goto(`${SITE}/`);
    await openCard(page, '#long');
    // 整段都选上了（卡片按原文翻的就是整段），而不是只拖到第一行。
    expect(mock.sentTexts.at(-1)).toContain('at once.');
    await expect(retranslateBtn(page)).toBeVisible();
    await expect(addTermBtn(page)).toHaveCount(1);
    await expect(addTermBtn(page)).toBeHidden();
  });

  test('C-J7 a save the service worker refuses keeps the form open with the localized error; "All sites" stores no site (dark theme)', async ({ page, context }) => {
    const en = (key) => getMessage(key, 'en');
    await serve(context);
    await setExtensionSettings(page, settings(mock.endpoint, { theme: 'dark' }));
    await page.goto(`${SITE}/`);
    await openCard(page, '#term');
    await addTermBtn(page).click();
    await expect(form(page)).toBeVisible();

    // 超过 160 字的译文照样能填、照样送出：拒绝它的是服务工作者（同一份
    // Glossary.LIMITS），错误句显示在表单里，表单不收，存储不变，按钮不改字。
    await formInput(page).fill('变换器'.repeat(54));
    await formSave(page).click();
    await expect(formError(page)).toHaveText(en('glossaryEntryInvalid'));
    await expect(form(page)).toBeVisible();
    await expect(formSave(page)).toBeEnabled();
    await expect(addTermBtn(page)).toHaveText(en('glossaryAdd'));
    expect(await storedGlossary(context)).toEqual({});
    // 深色主题下表单（连同错误句）可读、不溢出、不重叠。
    console.log(`C-J7 dark form contrast: ${await expectLaidOut(page, [...FORM_PARTS, '.ai-translator-term-error'], 'C-J7 dark form')}`);
    await expectScopeCaret(page);

    // 改短、选「所有网站」，在输入框里按回车保存：存进去的词条没有 h。
    await formInput(page).fill('变换器');
    await formScope(page).selectOption('all');
    await formInput(page).press('Enter');
    await expect(addTermBtn(page)).toHaveText(en('glossaryAdded'));
    await expect(form(page)).toBeHidden();
    expect(Object.values(await storedGlossary(context))).toEqual([
      { s: 'Transformer', t: '变换器', c: 1, l: 'zh-CN', u: expect.any(Number) },
    ]);
  });

  test('C-J7 in a cross-origin frame the form offers the top page\'s site, and the entry is stored under it', async ({ page, context }) => {
    const en = (key) => getMessage(key, 'en');
    await serve(context);
    await setExtensionSettings(page, settings(mock.endpoint));
    await page.goto(`${SITE}/framed`);
    await expect(page.frameLocator('#embed').locator('#note')).toBeVisible();
    const frame = page.frames().find((f) => f.url().startsWith(EMBED));
    await expect.poll(() => frame.evaluate(
      () => document.documentElement.getAttribute('data-ai-translator-style'))).toBe('underline');
    // 子帧只从顶层指令里知道顶层的主机：等指令到了再点（用户从来不会快过它）。
    await expect.poll(() => evaluateInContentScript(context, frame,
      'window.AI_TRANSLATOR_CONTENT.frames.topHost()')).toBe(SITE_HOST);

    await dragAcross(page, frame.locator('#embed-term'));
    await icon(frame).click();
    await expect(cardText(frame)).toContainText('[T]');
    await expect(addTermBtn(frame)).toBeVisible();
    await addTermBtn(frame).click();
    await expect(form(frame)).toBeVisible();
    expect(await scopeOptions(frame)).toEqual([
      ['site', en('glossaryScopeSite').replace('{host}', SITE_HOST)],
      ['all', en('glossaryScopeAll')],
    ]);
    await formInput(frame).fill('变换器');
    await formSave(frame).click();
    await expect(addTermBtn(frame)).toHaveText(en('glossaryAdded'));
    // 顶层的主机，不是子帧的 terms-embed.test。
    expect(Object.values(await storedGlossary(context))).toEqual([
      { s: 'Transformer', t: '变换器', c: 1, h: SITE_HOST, l: 'zh-CN', u: expect.any(Number) },
    ]);
  });

  // 夹具理由：无主机的页面（file:、about:blank）在这套 e2e 里到不了 ——
  // file: 要在扩展管理页手动打开「允许访问文件网址」，Playwright 开不了；about:blank
  // 不在内容脚本的匹配范围内。所以在一个正常页面上把 ctx.frames.topHost 换成
  // 无主机页面的答案（top.js 对空 hostname 给 ''，单测 frame-engine-via 证过）。
  test('[fixture] C-J7 a page with no host offers only "All sites"', async ({ page, context }) => {
    const en = (key) => getMessage(key, 'en');
    await serve(context);
    await setExtensionSettings(page, settings(mock.endpoint));
    await page.goto(`${SITE}/`);
    await openCard(page, '#term');
    await evaluateInContentScript(context, page, 'window.AI_TRANSLATOR_CONTENT.frames.topHost = () => ""');
    await addTermBtn(page).click();
    expect(await scopeOptions(page)).toEqual([['all', en('glossaryScopeAll')]]);
    await expect(formScope(page)).toHaveValue('all');
    await formInput(page).fill('变换器');
    await formSave(page).click();
    await expect(addTermBtn(page)).toHaveText(en('glossaryAdded'));
    expect(Object.values(await storedGlossary(context))).toEqual([
      { s: 'Transformer', t: '变换器', c: 1, l: 'zh-CN', u: expect.any(Number) },
    ]);
  });

  test('C-J7 the button never blinks out while a retranslation or an engine switch is in flight, and a new request folds the form', async ({ page, context }) => {
    await serve(context);
    await setExtensionSettings(page, settings(mock.endpoint));
    await page.goto(`${SITE}/`);
    await stubBuiltinTranslator(page);
    await openCard(page, '#term');
    await expect(addTermBtn(page)).toBeVisible();
    await page.evaluate(() => {
      window.__addTermHides = [];
      const btn = document.querySelector('.ai-translator-popup .ai-translator-add-term');
      new MutationObserver((records) => {
        for (const r of records) if (r.oldValue === null) window.__addTermHides.push(r.attributeName);
      }).observe(btn, { attributes: true, attributeFilter: ['hidden'], attributeOldValue: true });
    });

    // 表单开着时发出新请求：表单收起（它预填的是上一次的译文）。
    await addTermBtn(page).click();
    await expect(form(page)).toBeVisible();
    await retranslateBtn(page).click();
    await expect(form(page)).toBeHidden();
    await expect.poll(() => mock.sentTexts.length).toBe(2);
    await expect(retranslateBtn(page)).toBeEnabled();
    await expect(addTermBtn(page)).toBeEnabled();

    await switchBtn(page).click();
    await expect(cardText(page)).toHaveText(/^\[B\] /);
    await expect(switchBtn(page)).toBeEnabled();
    await expect(addTermBtn(page)).toBeVisible();
    await expect(addTermBtn(page)).toBeEnabled();
    expect(await page.evaluate(() => window.__addTermHides)).toEqual([]);
  });

  test('C-J7 the 80-character limit: exactly 80 offers add-to-glossary, 81 does not (D-384 A1)', async ({ page, context }) => {
    expect(AT_LIMIT).toHaveLength(80);
    expect(OVER_LIMIT).toHaveLength(81);
    await serve(context);
    await setExtensionSettings(page, settings(mock.endpoint));
    await page.goto(`${SITE}/more`);
    await openCard(page, '#at-limit');
    expect(mock.sentTexts.at(-1)).toBe(AT_LIMIT);
    await expect(addTermBtn(page)).toBeVisible();
    await addTermBtn(page).click();
    await expect(formSource(page)).toHaveText(AT_LIMIT);

    await page.keyboard.press('Escape');
    await expect(cardText(page)).toHaveCount(0);
    await dragAcross(page, page.locator('#over-limit'));
    await icon(page).click();
    await expect(cardText(page)).toContainText('[T]');
    expect(mock.sentTexts.at(-1)).toBe(OVER_LIMIT);
    await expect(retranslateBtn(page)).toBeVisible();
    await expect(addTermBtn(page)).toHaveCount(1);
    await expect(addTermBtn(page)).toBeHidden();
  });

  test('C-J7 add-to-glossary is disabled while a retranslation is in flight (D-384 A2)', async ({ page, context }) => {
    const slow = await startMockOpenAIServer({ delayMs: 1500 });
    try {
      await serve(context);
      await setExtensionSettings(page, settings(slow.endpoint));
      await page.goto(`${SITE}/`);
      await openCard(page, '#term');
      await expect(addTermBtn(page)).toBeEnabled();
      await retranslateBtn(page).click();
      // 请求还在路上（mock 拖 1.5 秒才答）：按钮还在，只是忙。
      await expect(addTermBtn(page)).toBeVisible();
      await expect(addTermBtn(page)).toBeDisabled();
      await expect.poll(() => slow.sentTexts.length).toBe(2);
      await expect(addTermBtn(page)).toBeDisabled();
      await expect(retranslateBtn(page)).toBeEnabled();
      await expect(addTermBtn(page)).toBeEnabled();
    } finally {
      await slow.close();
    }
  });

  test('C-J7 an all-lowercase term is stored without c, and a new target language puts the label back (D-384 A3, A4)', async ({ page, context }) => {
    const en = (key) => getMessage(key, 'en');
    await serve(context);
    await setExtensionSettings(page, settings(mock.endpoint));
    await page.goto(`${SITE}/more`);
    await openCard(page, '#lower');
    await addTermBtn(page).click();
    await expect(formSource(page)).toHaveText('attention');
    await formInput(page).fill('注意力');
    await formSave(page).click();
    await expect(addTermBtn(page)).toHaveText(en('glossaryAdded'));
    // 原文没有大写字母：缺省不区分大小写，存下的词条里没有 c。
    expect(Object.values(await storedGlossary(context))).toEqual([
      { s: 'attention', t: '注意力', h: SITE_HOST, l: 'zh-CN', u: expect.any(Number) },
    ]);

    // 卡片换成法语：「已加入」说的是中文那一条，按钮回到「加入术语表」。
    await page.locator('.ai-translator-popup .ai-translator-lang-trigger').click();
    await page.locator('.ai-translator-popup .ai-translator-lang-item[data-lang="fr"]').click();
    await expect(cardText(page)).toHaveAttribute('lang', 'fr');
    await expect(cardText(page)).toContainText('[T]');
    await expect(addTermBtn(page)).toHaveText(en('glossaryAdd'));
    // 在法语下再存一次，是另一条（l 是 fr），按钮说「已加入」而不是「已更新」。
    await addTermBtn(page).click();
    await formInput(page).fill('attention');
    await formSave(page).click();
    await expect(addTermBtn(page)).toHaveText(en('glossaryAdded'));
    const stored = Object.values(await storedGlossary(context));
    expect(stored).toHaveLength(2);
    expect(stored).toContainEqual({ s: 'attention', t: 'attention', h: SITE_HOST, l: 'fr', u: expect.any(Number) });
  });

  test('C-J7 on a page whose host cannot be a site key (an IPv6 literal) the form offers only "All sites" (D-384 A6)', async ({ page, context }) => {
    const en = (key) => getMessage(key, 'en');
    await serve(context);
    await setExtensionSettings(page, settings(mock.endpoint));
    await page.goto(`${IPV6}/`);
    await openCard(page, '#term');
    // 页面自己的主机就是 [::1]：印出来的主机和写入口收的主机是同一个谓词，
    // 当不了键就和「没拿到指令」一样只给「所有网站」。
    expect(await evaluateInContentScript(context, page, 'window.AI_TRANSLATOR_CONTENT.frames.topHost()')).toBe('[::1]');
    await addTermBtn(page).click();
    await expect(form(page)).toBeVisible();
    expect(await scopeOptions(page)).toEqual([['all', en('glossaryScopeAll')]]);
    await expect(formScope(page)).toHaveValue('all');
    await formInput(page).fill('变换器');
    await formSave(page).click();
    await expect(addTermBtn(page)).toHaveText(en('glossaryAdded'));
    expect(Object.values(await storedGlossary(context))).toEqual([
      { s: 'Transformer', t: '变换器', c: 1, l: 'zh-CN', u: expect.any(Number) },
    ]);
  });

  test('C-J7 in the light theme both error lines on the card read at 4.5:1 or better (D-384 A11)', async ({ page, context }) => {
    // 400 不重试（D2）：第一次请求就是卡片上的失败。
    const failing = await startMockOpenAIServer({ failRequests: 1, failStatus: 400 });
    try {
      await serve(context);
      await setExtensionSettings(page, settings(failing.endpoint, { theme: 'light' }));
      await page.goto(`${SITE}/`);
      await waitForContentReady(page);
      // 第一次请求失败：卡片的错误句。
      await dragAcross(page, page.locator('#term'));
      await icon(page).click();
      await expect(cardError(page)).toBeVisible();
      await expect(cardError(page)).not.toHaveText('');
      console.log(`C-J7 light card error contrast: ${await expectLaidOut(page, ['.ai-translator-popup .ai-translator-error'], 'C-J7 light card error')}`);

      // 重译成功后，表单里被服务工作者拒绝的保存：表单的错误句。
      await retranslateBtn(page).click();
      await expect(cardText(page)).toContainText('[T]');
      await addTermBtn(page).click();
      await formInput(page).fill('变换器'.repeat(54));
      await formSave(page).click();
      await expect(formError(page)).not.toHaveText('');
      console.log(`C-J7 light form error contrast: ${await expectLaidOut(page, ['.ai-translator-term-error'], 'C-J7 light form error')}`);
    } finally {
      await failing.close();
    }
  });
});
