// P1-C C3 的旅程（设计 docs/plans/2026-09-25-p1-c-glossary.md §3.5、§3.8、§6.1 C-J6）：
// 领域预设与页面上下文。
//
// C-J6 五步全走真实入口：设置页「自定义提示词」卡片里的领域下拉和「附带页面上下文」
// 开关、站点规则卡片表单里的领域下拉、悬浮球整页翻译、悬浮球菜单里的输入框翻译。
// 夹具只用在观察点：mock-openai-server 记下的系统提示词（DOMAIN 行、PAGE CONTEXT
// 块）、服务工作者里 chrome.storage 的设置 / 规则 / autoStats.aiChars。API 端点和
// Key 用 setExtensionSettings 铺设 —— 那是运行环境，不是这条旅程的步骤。
//
// 页面由 context.route 供给：三段在首屏，隔 4000px 再三段，于是首屏一批、视口外一批
// （content/page/batch.js 的 splitBlocksByViewport），两批各有一侧邻段。每段都长于
// 300 字，截断看得见。
//
// 标题带 [fixture] 的用例顶替了用户动作，理由写在用例上面。
const { test, expect } = require('./fixtures');
const path = require('path');
const {
  REPO_ROOT,
  evaluateInContentScript,
  getServiceWorker,
  getSyncSetting,
  openFloatBallMenu,
  sentSegments,
  setExtensionSettings,
  stubBuiltinTranslator,
  waitForContentReady,
} = require('./helpers');
const {
  en,
  serve,
  storedRules,
  newOptionsTab,
  fillRuleEditor,
  saveRuleEditor,
} = require('./custom-rules-fixtures');
const { startMockOpenAIServer } = require('./mock-openai-server');

// 领域 id、句子、块标题和上限只有 shared/prompt-addenda.js 一份，这里装它来读。
require(path.join(REPO_ROOT, 'shared/prompt-addenda.js'));
const { DOMAINS, SENTENCES, HEADINGS, LIMITS } = globalThis.PromptAddenda;

const SITE = 'https://addenda.test';
const FOLLOW = 'https://follow.test';
const TITLE = 'Supply agreement notes';

const para = (n) => [
  `Paragraph ${n} begins with the parties to the agreement and the date on which it takes effect.`,
  `Each party keeps its own records of every payment made under clause ${n} and shares them on request.`,
  `Notices under this clause are given in writing and delivered to the address listed in the schedule.`,
  `A party that breaches clause ${n} must remedy the breach within thirty days of receiving notice.`,
  `Paragraph ${n} ends once both parties have signed and dated the final page of the agreement.`,
].join(' ');

const IDS = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'];
const PARAS = IDS.map((_, i) => para(i + 1));
for (const text of PARAS) {
  if (text.length <= LIMITS.before) throw new Error('fixture paragraphs must be longer than the context limit');
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${TITLE}</title></head>
<body>
  ${PARAS.slice(0, 3).map((text, i) => `<p id="${IDS[i]}">${text}</p>`).join('\n  ')}
  <div style="height:4000px"></div>
  ${PARAS.slice(3).map((text, i) => `<p id="${IDS[i + 3]}">${text}</p>`).join('\n  ')}
</body></html>`;

const INPUT_TEXT = 'Please confirm that the signed agreement reached the supplier before the end of the week.';

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

const contextChars = (context) => Object.values(context).reduce((sum, value) => sum + value.length, 0);

/** 服务工作者里的「发给模型的字数」：chrome.storage.local 的 autoStats.aiChars。 */
async function aiChars(context) {
  const worker = await getServiceWorker(context);
  return worker.evaluate(async () => {
    const { autoStats } = await chrome.storage.local.get({ autoStats: null });
    return (autoStats && autoStats.aiChars) || 0;
  });
}

async function openPromptCard(context, extensionId) {
  const options = await newOptionsTab(context, extensionId);
  await options.bringToFront();
  await options.locator('#promptDomain').scrollIntoViewIfNeeded();
  return options;
}

test.describe('P1-C prompt domain and page context', () => {
  let mock;

  test.beforeEach(async () => {
    mock = await startMockOpenAIServer();
  });

  test.afterEach(async () => {
    await mock.close();
  });

  /**
   * 打开页面、点悬浮球、等六段都译完。返回这一程的请求（原文 + 系统提示词）、
   * 原文字数（按分隔符切回每一段）和 aiChars 的增量。
   */
  async function translatePage(page, context, url) {
    const mark = mock.sentTexts.length;
    const charsBefore = await aiChars(context);
    // 设置页开在另一个标签里；后台标签的页面不开始整页翻译，先把它切到前面。
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

  test('C-J6 the domain and the page context go with every AI batch; a site rule wins; the input box and the switch keep the context out', async ({ page, context, extensionId }) => {
    await serve(context, { [`${SITE}/contract`]: PAGE });
    await setExtensionSettings(page, settings(mock.endpoint));

    // 0. 对照程：全局「通用」、上下文关着（出厂值）。没有 DOMAIN 行、没有 PAGE
    // CONTEXT 块；aiChars 恰好是原文字数。
    const plain = await translatePage(page, context, `${SITE}/contract`);
    expect(plain.requests).toHaveLength(2);
    for (const { prompt } of plain.requests) {
      expect(domainLines(prompt), 'global general sends no DOMAIN line').toEqual([]);
      expect(contextOf(prompt)).toBeNull();
    }
    await expect.poll(() => aiChars(context)).toBe(plain.charsBefore + plain.sourceChars);

    // 1. 设置页「自定义提示词」卡片：领域下拉的选项就是 PromptAddenda.DOMAINS，
    // 选「法律」立刻落盘（不等别的控件）；再打开「附带页面上下文」。
    const options = await openPromptCard(context, extensionId);
    const domainOptions = options.locator('#promptDomain option');
    await expect(domainOptions).toHaveCount(DOMAINS.length);
    expect(await domainOptions.evaluateAll((nodes) => nodes.map((node) => node.value))).toEqual([...DOMAINS]);
    await expect(options.locator('#promptDomain option[value="legal"]')).toHaveText(en('promptDomainLegal'));
    await expect(options.locator('#promptDomain')).toHaveValue('general');
    await expect(options.locator('#aiPageContext')).not.toBeChecked();
    await options.selectOption('#promptDomain', 'legal');
    await expect.poll(() => getSyncSetting(context, 'promptDomain'), { timeout: 5000 }).toBe('legal');
    expect(await getSyncSetting(context, 'aiPageContext'), 'the domain was saved on its own').not.toBe(true);
    await options.click('label:has(#aiPageContext)');
    await expect(options.locator('#aiPageContext')).toBeChecked();
    await expect.poll(() => getSyncSetting(context, 'aiPageContext'), { timeout: 5000 }).toBe(true);

    // 2. 悬浮球整页翻译：每一批都带法律的 DOMAIN 句子和 PAGE CONTEXT —— 标题、
    // 首屏那批的后文（视口外第一段的前 300 字）、视口外那批的前文（首屏最后一段
    // 的后 300 字）。aiChars 比对照程恰好多出上下文的字数。
    const legal = await translatePage(page, context, `${SITE}/contract`);
    expect(legal.requests).toHaveLength(plain.requests.length);
    expect(legal.sourceChars).toBe(plain.sourceChars);
    for (const { prompt } of legal.requests) {
      expect(domainLines(prompt)).toEqual([domainLine('legal')]);
    }
    const contexts = legal.requests.map(({ prompt }) => contextOf(prompt));
    const byKey = (a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b));
    expect([...contexts].sort(byKey)).toEqual([
      { title: TITLE, after: PARAS[3].slice(0, LIMITS.after) },
      { title: TITLE, before: PARAS[2].slice(-LIMITS.before) },
    ].sort(byKey));
    for (const context of contexts) {
      if (context.before !== undefined) expect(context.before).toHaveLength(LIMITS.before);
      if (context.after !== undefined) expect(context.after).toHaveLength(LIMITS.after);
    }
    const contextTotal = contexts.reduce((sum, context) => sum + contextChars(context), 0);
    expect(contextTotal).toBe(2 * TITLE.length + LIMITS.before + LIMITS.after);
    await expect.poll(() => aiChars(context)).toBe(legal.charsBefore + plain.sourceChars + contextTotal);

    // 3. 规则卡片：给这个站点新建一条规则，领域选「医学」、点保存。存下来的是 v2、
    // 带 domain；重新翻译后 DOMAIN 句子换成医学的（站点规则里设了领域的网站，以规则
    // 为准），上下文照旧。
    await options.bringToFront();
    await expect(options.locator('#customRulesUsage')).not.toBeEmpty();
    await fillRuleEditor(options, { match: ['addenda.test'] });
    const ruleDomain = options.locator('#customRule-domain');
    await expect(ruleDomain.locator('option').first()).toHaveText(en('customRuleDomainInherit'));
    await expect(ruleDomain.locator('option').first()).toHaveAttribute('value', '');
    expect(await ruleDomain.locator('option').evaluateAll((nodes) => nodes.slice(1).map((node) => node.value)))
      .toEqual([...DOMAINS]);
    await options.selectOption('#customRule-domain', 'medical');
    await saveRuleEditor(options);
    const rules = Object.values(await storedRules(context));
    expect(rules).toEqual([{ v: 2, match: ['addenda.test'], domain: 'medical', updatedAt: expect.any(Number) }]);

    const medical = await translatePage(page, context, `${SITE}/contract`);
    for (const { prompt } of medical.requests) {
      expect(domainLines(prompt)).toEqual([domainLine('medical')]);
      expect(contextOf(prompt)).not.toBeNull();
    }
    await expect.poll(() => aiChars(context)).toBe(medical.charsBefore + medical.sourceChars + contextTotal);

    // 4. 悬浮球菜单里的输入框翻译：领域照样按规则，但不带页面上下文，字数只算
    // 敲进去的那句。
    const inputMark = mock.sentTexts.length;
    const inputCharsBefore = await aiChars(context);
    await openFloatBallMenu(page);
    await page.click('.ai-translator-menu-item[data-action="translate-input"]');
    await page.waitForSelector('#ai-translator-input-dialog', { state: 'visible' });
    await page.fill('#ai-translator-input-text', INPUT_TEXT);
    await page.click('#ai-translator-do-translate');
    await expect(page.locator('#ai-translator-result-text')).toHaveText(`[T] ${INPUT_TEXT}`);
    expect(mock.sentTexts.slice(inputMark)).toEqual([INPUT_TEXT]);
    const inputPrompt = mock.systemPrompts[inputMark];
    expect(domainLines(inputPrompt)).toEqual([domainLine('medical')]);
    expect(contextOf(inputPrompt), 'the input box never carries page context').toBeNull();
    await expect.poll(() => aiChars(context)).toBe(inputCharsBefore + INPUT_TEXT.length);

    // 5. 设置页关掉「附带页面上下文」，重新翻译：不再有 PAGE CONTEXT，字数回到只算
    // 原文。
    await options.bringToFront();
    await options.click('label:has(#aiPageContext)');
    await expect(options.locator('#aiPageContext')).not.toBeChecked();
    await expect.poll(() => getSyncSetting(context, 'aiPageContext'), { timeout: 5000 }).toBe(false);
    const off = await translatePage(page, context, `${SITE}/contract`);
    for (const { prompt } of off.requests) {
      expect(contextOf(prompt), 'switch off, no context').toBeNull();
      expect(domainLines(prompt)).toEqual([domainLine('medical')]);
    }
    await expect.poll(() => aiChars(context)).toBe(off.charsBefore + off.sourceChars);
    await options.close();
  });

  test('a rule left on "follow the global setting" is stored as v1 without a domain, and the global domain applies on its site', async ({ page, context, extensionId }) => {
    await serve(context, { [`${FOLLOW}/contract`]: PAGE });
    await setExtensionSettings(page, settings(mock.endpoint));

    const options = await openPromptCard(context, extensionId);
    await options.selectOption('#promptDomain', 'legal');
    await expect.poll(() => getSyncSetting(context, 'promptDomain'), { timeout: 5000 }).toBe('legal');

    await fillRuleEditor(options, { match: ['follow.test'], exclude: ['.not-on-this-page'] });
    await expect(options.locator('#customRule-domain')).toHaveValue('');
    await saveRuleEditor(options);
    const rules = Object.values(await storedRules(context));
    expect(rules).toEqual([
      { v: 1, match: ['follow.test'], exclude: ['.not-on-this-page'], updatedAt: expect.any(Number) },
    ]);
    await options.close();

    const run = await translatePage(page, context, `${FOLLOW}/contract`);
    for (const { prompt } of run.requests) {
      expect(domainLines(prompt)).toEqual([domainLine('legal')]);
      expect(contextOf(prompt), 'the context switch is still off').toBeNull();
    }
  });

  // [fixture] 引擎选内置、领域和上下文开着这三项用 setExtensionSettings 铺设：两个
  // 控件在 C-J6 第 1 步已经走过真实入口，这里要证的是内置引擎那一头什么也不带；
  // e2e 的 Chromium 没有端上模型，内置引擎只能是 stubBuiltinTranslator 的替身。
  test('[fixture] the built-in engine gets the page text and nothing else, with the domain and the context switched on', async ({ page, context }) => {
    await serve(context, { [`${SITE}/contract`]: PAGE });
    await setExtensionSettings(page, settings(mock.endpoint, {
      translationEngine: 'builtin',
      promptDomain: 'legal',
      aiPageContext: true,
    }));

    await page.goto(`${SITE}/contract`);
    await waitForContentReady(page);
    await stubBuiltinTranslator(page);
    await page.click('#ai-translator-float-ball', { position: { x: 18, y: 18 } });
    for (const id of IDS) {
      await expect(page.locator(`#${id} + .ai-translator-inline-block`)).toContainText('[B]', { timeout: 30000 });
    }
    await page.waitForSelector('#ai-translator-progress', { state: 'hidden', timeout: 30000 });

    const texts = await evaluateInContentScript(context, page, 'self.__builtinTexts');
    expect([...texts].sort()).toEqual([...PARAS].sort());
    expect(mock.sentTexts).toEqual([]);
  });
});
