// P1-C C3 领域与页面上下文的回归护栏（设计 docs/plans/2026-09-25-p1-c-glossary.md
// §4.3、§6.2；C3 修复回合 1 的第 1、2、8 项）。
//
// prompt-domain-context.spec.js 走的是 C-J6 五步主干。这里补主干没钉住的几处，
// 每条都对着一个会悄悄坏掉而主干照样绿的地方：
//   - 存储里的领域不认得：设置页看得见、保存被拒、不写空串也不强转「通用」；整页
//     翻译在进度条上报出来，而不是静悄悄地「翻完了」什么也没有；
//   - 重开设置页 / 编辑规则时两项新设置和规则领域的预填，规则钉住「通用」也算钉住；
//   - 发出去的前后文和标题去掉了行内标记，标题截到 200；
//   - 悬停、划词卡片只带标题，页面不刷新改了规则的领域，悬停拿到的是新领域；
//   - 自动翻译只带标题（一轮拆成多批也一样），额度账算进实发的上下文。
//
// 用户动作都走真实界面；标 [fixture] 的只是运行环境或观察点，理由写在旁边。
const { test, expect } = require('./fixtures');
const path = require('path');
const {
  REPO_ROOT,
  evaluateInContentScript,
  getServiceWorker,
  getSyncSetting,
  sentSegments,
  setExtensionSettings,
  waitForContentReady,
} = require('./helpers');
const {
  en,
  serve,
  storedRules,
  newOptionsTab,
  fillRuleEditor,
  saveRuleEditor,
  autoAiChars,
  clearTranslationCache,
} = require('./custom-rules-fixtures');
const { startMockOpenAIServer } = require('./mock-openai-server');

require(path.join(REPO_ROOT, 'shared/prompt-addenda.js'));
const { SENTENCES, HEADINGS, LIMITS } = globalThis.PromptAddenda;

function settings(endpoint, extra) {
  return {
    // 设置页每次落盘都把整张表单写回去：服务商不钉成 custom，表单会按默认的
    // openai 把端点写回官方地址，mock 就收不到请求了。
    provider: 'custom',
    apiEndpoint: endpoint,
    apiKey: 'test-key',
    modelName: 'gpt-4.1-mini',
    targetLang: 'zh-CN',
    skipTargetLanguageText: false,
    // 就绪信号：内容脚本读完设置就把它写到 <html>，见 waitForContentReady。
    translationStyle: 'underline',
    ...extra,
  };
}

const domainLine = (domain) => `${HEADINGS.domain} ${SENTENCES[domain]}`;
const domainLines = (prompt) => prompt.split('\n').filter((line) => line.startsWith(HEADINGS.domain));

/** 系统提示词里 PAGE CONTEXT 块的那一行 JSON；没有这个块是 null。 */
function contextOf(prompt) {
  const lines = prompt.split('\n');
  const at = lines.indexOf(HEADINGS.context);
  return at < 0 ? null : JSON.parse(lines[at + 1]);
}

const contextChars = (context) => (context ? Object.values(context).reduce((sum, value) => sum + value.length, 0) : 0);
// 与 shared/text-markers.js 同形：{{n}} 占位符、<tagN>/</tagN> 标记。
const stripMarkers = (text) => text.replace(/\{\{\d+\}\}/g, '').replace(/<\/?[a-z]+\d+>/gi, '');
const byKey = (a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b));

/** 服务工作者里的「发给模型的字数」：chrome.storage.local 的 autoStats.aiChars。 */
async function aiChars(context) {
  const worker = await getServiceWorker(context);
  return worker.evaluate(async () => {
    const { autoStats } = await chrome.storage.local.get({ autoStats: null });
    return (autoStats && autoStats.aiChars) || 0;
  });
}

// —— 夹具页：每段长于 300 字；p3 中间、p4 开头带行内元素，发出去是 <em1> 这类
// 标记 —— 前后文取到的正是这两段的尾巴和开头。三段在首屏，隔 4000px 再三段，于是
// 整页翻译首屏一批、视口外一批，两批各有一侧邻段。——
const sentences = (n) => [
  `Section ${n} of the supply memo sets out who is responsible for the goods and when delivery is due.`,
  `The buyer inspects every shipment within five working days and reports any defect to the seller in writing.`,
  `Any dispute about section ${n} is first discussed between the two managers before either side calls a lawyer.`,
  `Payment for section ${n} falls due thirty days after the invoice date unless both parties agree otherwise.`,
];
const IDS = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'];
const PLAIN = IDS.map((_, i) => sentences(i + 1).join(' '));
const MARKED = PLAIN.slice();
MARKED[2] = PLAIN[2].replace('unless both parties agree otherwise.', 'unless <em>both parties</em> agree otherwise.');
MARKED[3] = PLAIN[3].replace('Section 4 of the', '<strong>Section 4</strong> of the');
for (const text of PLAIN) {
  if (text.length <= LIMITS.before) throw new Error('fixture paragraphs must be longer than the context limit');
}

const TITLE = 'Supply memo guards';
const pageOf = (title, paragraphs = MARKED) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title></head>
<body>
  ${paragraphs.slice(0, 3).map((html, i) => `<p id="${IDS[i]}">${html}</p>`).join('\n  ')}
  <div style="height:4000px"></div>
  ${paragraphs.slice(3).map((html, i) => `<p id="${IDS[i + 3]}">${html}</p>`).join('\n  ')}
</body></html>`;

// 带标记的长标题：<title> 里是纯文本，标记和占位符原样出现在 document.title 里。
const RAW_LONG_TITLE = `Quarterly <b1>supply</b1> review {{3}} ${Array.from({ length: 30 }, (_, i) => `item${i}`).join(' ')}`;
const LONG_TITLE = stripMarkers(RAW_LONG_TITLE).slice(0, LIMITS.title);
if (stripMarkers(RAW_LONG_TITLE).length <= LIMITS.title) throw new Error('the long title must be longer than the limit');

async function openPromptCard(context, extensionId) {
  const options = await newOptionsTab(context, extensionId);
  await options.bringToFront();
  await options.locator('#promptDomain').scrollIntoViewIfNeeded();
  return options;
}

async function editRule(options, id) {
  await options.click(`.custom-rule[data-rule-id="${id}"] .custom-rule-edit`);
  await expect(options.locator('.custom-rule-editor')).toHaveCount(1);
}

/** 设置页里一个与领域无关、改了就立刻落盘的控件：划词翻译的显示方式。 */
async function flipSelectionMode(options) {
  const mode = await options.inputValue('#selectionTranslationMode');
  const other = mode === 'popup' ? 'inline' : 'popup';
  await options.selectOption('#selectionTranslationMode', other);
  return { mode, other };
}

test.describe('P1-C prompt domain and page context: regression guards', () => {
  let mock;

  test.beforeEach(async () => {
    mock = await startMockOpenAIServer();
  });

  test.afterEach(async () => {
    await mock.close();
  });

  /**
   * 打开页面、点悬浮球、等六段都译完。返回这一程的请求（原文 + 系统提示词）和
   * aiChars 的增量应有的原文字数。
   */
  async function translatePage(page, context, url) {
    const mark = mock.sentTexts.length;
    const charsBefore = await aiChars(context);
    await page.bringToFront();
    await page.goto(url);
    await waitForContentReady(page);
    await page.click('#ai-translator-float-ball', { position: { x: 18, y: 18 } });
    for (const id of IDS) {
      await expect(page.locator(`#${id} + .ai-translator-inline-block`)).toContainText('[T]', { timeout: 30000 });
    }
    await page.waitForSelector('#ai-translator-progress', { state: 'hidden', timeout: 30000 });
    const requests = mock.sentTexts.slice(mark).map((text, i) => ({ text, prompt: mock.systemPrompts[mark + i] }));
    expect(requests.length, 'this run reached the model').toBeGreaterThan(0);
    const sourceChars = sentSegments(requests.map((r) => r.text), mock.fastBatchRequests)
      .reduce((sum, segment) => sum + segment.length, 0);
    return { requests, sourceChars, charsBefore };
  }

  // [fixture] 不认得的领域只能由 setExtensionSettings 铺进存储：设置页的任何入口都
  // 写不出它（这正是要证的）。它来自旧版本、另一台设备的同步或手改的导入文件。
  test('[fixture] an unrecognised stored domain: the settings page shows it, refuses every save, and a real domain clears it', async ({ page, context, extensionId }) => {
    await setExtensionSettings(page, settings('http://127.0.0.1:9/v1/chat/completions', { promptDomain: 'astrology' }));
    const options = await openPromptCard(context, extensionId);
    const error = options.locator('#promptDomainError');
    await expect(error).toBeVisible();
    await expect(error).toHaveText(en('promptDomainUnknown'));
    await expect(error).toHaveAttribute('role', 'alert');

    // 改一个无关的立即保存控件：整份被拒，状态条说同一句，存储一个字节都没动
    // —— 领域没被写成空串，也没被悄悄换成「通用」。
    const storedMode = await getSyncSetting(context, 'selectionTranslationMode');
    await flipSelectionMode(options);
    await expect(options.locator('#statusMessage')).toHaveText(en('promptDomainUnknown'));
    await expect(options.locator('#statusMessage')).toHaveClass(/\berror\b/);
    expect(await getSyncSetting(context, 'promptDomain')).toBe('astrology');
    expect(await getSyncSetting(context, 'selectionTranslationMode')).toBe(storedMode);
    await expect(error).toBeVisible();

    // 选一个合法领域：立刻落盘，报错收起。刚才被拒的那一改是表单上的当前值，跟着
    // 这一次整表写回一起存下。
    await options.selectOption('#promptDomain', 'legal');
    await expect.poll(() => getSyncSetting(context, 'promptDomain'), { timeout: 5000 }).toBe('legal');
    await expect(error).toBeHidden();
    // 保存本来是静默的；刚才那句拒绝不能一直挂在状态条上。
    await expect(options.locator('#statusMessage')).toBeHidden();

    // 重开：存的是合法值，报错不出现。
    await options.close();
    const reopened = await openPromptCard(context, extensionId);
    await expect(reopened.locator('#promptDomain')).toHaveValue('legal');
    await expect(reopened.locator('#promptDomainError')).toBeHidden();
    await reopened.close();
  });

  // [fixture] 同上：不认得的领域由 setExtensionSettings 铺进存储。
  test('[fixture] an unrecognised stored domain stops whole-page translation with a visible error, nothing is sent, and a real domain lets the retry through', async ({ page, context, extensionId }) => {
    const SITE = 'https://domain-unknown.test';
    await serve(context, { [`${SITE}/memo`]: pageOf(TITLE) });
    await setExtensionSettings(page, settings(mock.endpoint, { promptDomain: 'astrology' }));
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));

    await page.goto(`${SITE}/memo`);
    await waitForContentReady(page);
    await page.click('#ai-translator-float-ball', { position: { x: 18, y: 18 } });
    const progress = page.locator('#ai-translator-progress');
    await expect(progress).toHaveClass(/ai-translator-progress-error-state/, { timeout: 15000 });
    await expect(progress.locator('.ai-translator-progress-error-text')).toHaveText(en('promptDomainUnknown'));
    expect(mock.sentTexts, 'nothing reached the model').toEqual([]);
    await expect(page.locator('.ai-translator-inline-block')).toHaveCount(0);
    expect(errors, 'no uncaught error on the page').toEqual([]);

    // 设置页选一个合法领域，再点悬浮球：这一次照常翻完。
    const options = await openPromptCard(context, extensionId);
    await expect(options.locator('#promptDomainError')).toBeVisible();
    await options.selectOption('#promptDomain', 'legal');
    await expect.poll(() => getSyncSetting(context, 'promptDomain'), { timeout: 5000 }).toBe('legal');
    await options.close();
    const retry = await translatePage(page, context, `${SITE}/memo`);
    for (const { prompt } of retry.requests) expect(domainLines(prompt)).toEqual([domainLine('legal')]);
  });

  test('reopened settings and rule editor keep what was saved; the sent context is stripped of markers; a rule pinned to "general" is still pinned', async ({ page, context, extensionId }) => {
    test.setTimeout(180000);
    const SITE = 'https://guards-c3.test';
    await serve(context, { [`${SITE}/memo`]: pageOf(TITLE) });
    await setExtensionSettings(page, settings(mock.endpoint));

    // 1. 设置页选「法律」、打开上下文。
    const options = await openPromptCard(context, extensionId);
    await options.selectOption('#promptDomain', 'legal');
    await expect.poll(() => getSyncSetting(context, 'promptDomain'), { timeout: 5000 }).toBe('legal');
    await options.click('label:has(#aiPageContext)');
    await expect.poll(() => getSyncSetting(context, 'aiPageContext'), { timeout: 5000 }).toBe(true);
    await options.close();

    // 2. 重开：两项都预填；再改一个无关的立即保存控件，整表写回不把它们冲掉。
    const reopened = await openPromptCard(context, extensionId);
    await expect(reopened.locator('#promptDomain')).toHaveValue('legal');
    await expect(reopened.locator('#aiPageContext')).toBeChecked();
    const { mode, other } = await flipSelectionMode(reopened);
    await expect.poll(() => getSyncSetting(context, 'selectionTranslationMode'), { timeout: 5000 }).toBe(other);
    await reopened.selectOption('#selectionTranslationMode', mode);
    await expect.poll(() => getSyncSetting(context, 'selectionTranslationMode'), { timeout: 5000 }).toBe(mode);
    expect(await getSyncSetting(context, 'promptDomain')).toBe('legal');
    expect(await getSyncSetting(context, 'aiPageContext')).toBe(true);

    // 3. 整页翻译：前后文是邻段去掉标记后的纯文本，一个字符都不差；额度按实发计。
    const legal = await translatePage(page, context, `${SITE}/memo`);
    for (const { prompt } of legal.requests) expect(domainLines(prompt)).toEqual([domainLine('legal')]);
    const contexts = legal.requests.map(({ prompt }) => contextOf(prompt));
    expect([...contexts].sort(byKey)).toEqual([
      { title: TITLE, after: PLAIN[3].slice(0, LIMITS.after) },
      { title: TITLE, before: PLAIN[2].slice(-LIMITS.before) },
    ].sort(byKey));
    const contextTotal = contexts.reduce((sum, c) => sum + contextChars(c), 0);
    await expect.poll(() => aiChars(context)).toBe(legal.charsBefore + legal.sourceChars + contextTotal);

    // 4. 规则卡片：本站规则选「医学」；再点编辑，下拉预填医学，不动它保存，存储不变。
    await reopened.bringToFront();
    await expect(reopened.locator('#customRulesUsage')).not.toBeEmpty();
    await fillRuleEditor(reopened, { match: ['guards-c3.test'] });
    await reopened.selectOption('#customRule-domain', 'medical');
    await saveRuleEditor(reopened);
    const ruleId = Object.keys(await storedRules(context))[0].slice('customRule:'.length);
    await editRule(reopened, ruleId);
    await expect(reopened.locator('#customRule-domain')).toHaveValue('medical');
    await saveRuleEditor(reopened);
    expect(Object.values(await storedRules(context))).toEqual([
      { v: 2, match: ['guards-c3.test'], domain: 'medical', updatedAt: expect.any(Number) },
    ]);

    // 5. 规则改成「通用」（全局仍是法律）：规则钉住 general 也算钉住，不发 DOMAIN 行。
    await editRule(reopened, ruleId);
    await reopened.selectOption('#customRule-domain', 'general');
    await saveRuleEditor(reopened);
    expect(Object.values(await storedRules(context))[0]).toMatchObject({ v: 2, domain: 'general' });
    // [fixture] 清缓存只为让请求真的到 mock：错把 general 当「没钉」时，有效领域是
    // 法律，第 3 步那一程已经缓存了，没有请求可看。
    await clearTranslationCache(context);
    const pinnedGeneral = await translatePage(page, context, `${SITE}/memo`);
    for (const { prompt } of pinnedGeneral.requests) {
      expect(domainLines(prompt), 'a rule pinned to general sends no DOMAIN line').toEqual([]);
    }
    await reopened.close();
  });

  // [fixture] 两个开关在 C-J6 第 1 步已走过真实入口；悬停热键与划词弹卡是运行环境。
  test('[fixture] hover and the selection card send the title only; a rule domain change on the open page reaches hover without a reload', async ({ page, context, extensionId }) => {
    test.setTimeout(120000);
    const SITE = 'https://hover-guards.test';
    await serve(context, { [`${SITE}/memo`]: pageOf(RAW_LONG_TITLE) });
    await setExtensionSettings(page, settings(mock.endpoint, {
      aiPageContext: true,
      promptDomain: 'general',
      enableHoverTranslation: true,
      hoverTranslationHotkey: 'Shift',
      enableSelection: true,
      selectionTranslationMode: 'popup',
    }));
    await page.goto(`${SITE}/memo`);
    await waitForContentReady(page);
    // p3 带 <em>：悬停发出去的文本带标记，但它仍是页面上的一段，照样带标题。
    const target = page.locator('#p3');
    const hoverOnce = async () => {
      await page.mouse.move(5, 5);
      await page.keyboard.down('Shift');
      await target.hover();
      await page.waitForSelector('.ai-translator-hover-translation', { state: 'attached', timeout: 15000 });
      await page.keyboard.up('Shift');
      await expect(page.locator('.ai-translator-hover-translation').first()).toContainText('[T]', { timeout: 15000 });
    };
    const hoverOff = async () => {
      await target.hover();
      await page.keyboard.down('Shift');
      await page.waitForSelector('.ai-translator-hover-translation', { state: 'detached', timeout: 10000 });
      await page.keyboard.up('Shift');
    };
    const since = (mark) => ({
      sent: mock.sentTexts.slice(mark),
      contexts: mock.systemPrompts.slice(mark).map(contextOf),
      domainLines: mock.systemPrompts.slice(mark).map(domainLines),
    });

    let mark = mock.sentTexts.length;
    await hoverOnce();
    const first = since(mark);
    expect(first.sent).toHaveLength(1);
    expect(first.contexts).toEqual([{ title: LONG_TITLE }]);
    expect(first.domainLines).toEqual([[]]);

    // 对照：什么都不改，再悬停同一段 —— 本地记忆命中，不发请求。
    await hoverOff();
    mark = mock.sentTexts.length;
    await hoverOnce();
    expect(mock.sentTexts.length - mark).toBe(0);

    // 设置页新建本站规则（医学），页面不刷新。
    const options = await newOptionsTab(context, extensionId);
    await fillRuleEditor(options, { match: ['hover-guards.test'] });
    await options.selectOption('#customRule-domain', 'medical');
    await saveRuleEditor(options);
    await page.bringToFront();
    // [fixture] 观察点：等本页的规则镜像读到新领域。
    await expect.poll(() => evaluateInContentScript(context, page, 'window.AI_TRANSLATOR_CONTENT.customRules.domain()'), { timeout: 5000 }).toBe('medical');

    await hoverOff();
    mark = mock.sentTexts.length;
    await hoverOnce();
    const afterRule = since(mark);
    expect(afterRule.sent, 'the rule change invalidated the hover memory').toHaveLength(1);
    expect(afterRule.domainLines).toEqual([[domainLine('medical')]]);
    expect(afterRule.contexts).toEqual([{ title: LONG_TITLE }]);

    // 划词卡片：同样只带标题。
    await hoverOff();
    await page.mouse.move(5, 5);
    const box = await page.locator('#p2').boundingBox();
    await page.mouse.move(box.x + 2, box.y + 10);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.6, box.y + 10, { steps: 12 });
    await page.mouse.up();
    const icon = page.locator('#ai-translator-selection-btn .ai-translator-selection-icon');
    await expect(icon).toBeVisible({ timeout: 10000 });
    mark = mock.sentTexts.length;
    await icon.click();
    await expect(page.locator('.ai-translator-popup .ai-translator-translation-text')).toContainText('[T]', { timeout: 15000 });
    const card = since(mark);
    expect(card.contexts).toEqual([{ title: LONG_TITLE }]);
    expect(card.domainLines).toEqual([[domainLine('medical')]]);
    await options.close();
  });

  // [fixture] 自动翻译的触发条件（站点「总是翻译」、自动引擎选 AI）是运行环境；
  // 打开页面本身就是这一步的用户动作。视口拉到 6000px 高，让一轮自动翻译收齐整页：
  // 段落多到一批装不下，这一轮就拆成几批 —— 批与批之间有邻段，仍然只带标题。
  test('[fixture] automatic translation sends the stripped, capped title and nothing else, even when one round is split into several batches; the budget counts it', async ({ page, context }) => {
    test.setTimeout(120000);
    const SITE = 'https://auto-guards.test';
    const MANY = Array.from({ length: 24 }, (_, i) => sentences(i + 1).join(' '));
    const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${RAW_LONG_TITLE}</title></head>
<body>
  ${MANY.map((text, i) => `<p id="q${i + 1}">${text}</p>`).join('\n  ')}
</body></html>`;
    await serve(context, { [`${SITE}/memo`]: html });
    await setExtensionSettings(page, settings(mock.endpoint, {
      aiPageContext: true,
      autoTranslate: true,
      autoTranslateEngine: 'ai',
      siteRules: { 'auto-guards.test': 'always' },
    }));
    await page.setViewportSize({ width: 1280, height: 6000 });
    const autoBefore = await autoAiChars(context);
    const aiBefore = await aiChars(context);
    const mark = mock.sentTexts.length;
    await page.goto(`${SITE}/memo`);
    await waitForContentReady(page);
    for (let i = 1; i <= MANY.length; i++) {
      await expect(page.locator(`#q${i} + .ai-translator-inline-block`)).toContainText('[T]', { timeout: 30000 });
    }
    const texts = mock.sentTexts.slice(mark);
    const contexts = mock.systemPrompts.slice(mark).map(contextOf);
    expect(texts.length, 'the round was split into more than one batch').toBeGreaterThan(1);
    for (const c of contexts) expect(c).toEqual({ title: LONG_TITLE });
    const source = sentSegments(texts, mock.fastBatchRequests).reduce((sum, segment) => sum + segment.length, 0);
    const spent = source + contexts.reduce((sum, c) => sum + contextChars(c), 0);
    await expect.poll(() => autoAiChars(context)).toBe(autoBefore + spent);
    await expect.poll(() => aiChars(context)).toBe(aiBefore + spent);
  });
});
