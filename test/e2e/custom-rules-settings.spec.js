// 用户站点规则（P1-B）：设置页「站点翻译规则」卡片的旅程（设计 §4、§6 J-2、J-4、
// J-5、J-6、J-7）。
//
// 规则全部在设置页的卡片里建、改、导入：点「新建规则」或某一行的「编辑」，填表，
// 点保存。服务工作者直写只出现在两处：J-4 第 3/3b 步「绕过设置页的写入」拆成了单独
// 的 `[fixture]` 用例；J-7 的 49 条预置是前提，不是旅程步骤（见
// custom-rules-fixtures.js 文件头）。
const fs = require('fs');
const { test, expect } = require('./fixtures');
const {
  setExtensionSettings,
  triggerPageTranslation,
  waitForFloatBall,
  oursIn,
  sendMessageToActiveTab,
  syncSnapshot,
  writeSyncSettings,
} = require('./helpers');
const { startMockOpenAIServer } = require('./mock-openai-server');
const {
  TRANSLATED,
  en,
  settings,
  html,
  serve,
  rule,
  writeRule,
  storedRules,
  autoAiChars,
  sent,
  sendCount,
  withinOneSecond,
  translationOf,
  isTranslated,
  openOptions,
  fillRuleEditor,
  saveRuleEditor,
  chooseAiEngine,
  newOptionsTab,
  createRule,
  presetRules,
  PRESET_COUNT,
  PER_RULE,
  fill,
} = require('./custom-rules-fixtures');

const RULES = 'https://rules.test';
const popupUrl = (extensionId) => `chrome-extension://${extensionId}/popup/popup.html`;
// ------------------------------------------------------------------ J-2

const J2 = {
  plain: 'The kettle boils water in under three minutes and switches itself off afterwards.',
  brandLead: 'Our',
  brandTail: 'kettle comes with a two year warranty and a spare filter in the box.',
  codeName: 'Project Lighthouse release candidate seven for the northern region',
  reopened: 'This reopened paragraph explains what the release candidate changes for readers.',
};

const J2_PAGE = html(`
  <div id="plain-box"><p id="plain">${J2.plain}</p></div>
  <div id="brand-box"><p id="brand">${J2.brandLead} <span class="brand">BrandX</span> ${J2.brandTail}</p></div>
  <div translate="no">
    <div id="code-box"><p id="code" class="code-name" translate="yes">${J2.codeName}</p></div>
    <div id="reopen-box"><p id="reopen" translate="yes">${J2.reopened}</p></div>
  </div>`);

test('J-2: a rule made in Settings keeps an inline brand verbatim inside the translation and a whole block untouched', async ({ page, context, extensionId }) => {
  const { close, endpoint, sentTexts } = await startMockOpenAIServer();
  try {
    await setExtensionSettings(page, settings(endpoint));
    const options = await newOptionsTab(context, extensionId);
    await createRule(options, context, { match: ['rules.test'], keepOriginal: ['.brand', '.code-name'] });
    await options.close();

    await serve(context, { [`${RULES}/kettle`]: J2_PAGE });
    await page.goto(`${RULES}/kettle`);
    await waitForFloatBall(page);

    await triggerPageTranslation(page);
    await expect(page.locator(translationOf('plain'))).toHaveText(`[T] ${J2.plain}`, { timeout: 30000 });
    // 对照：同一个 translate="no" 容器里被 translate="yes" 重新打开、但不带规则类的
    // 那一段照样翻 —— `.code-name` 没翻只能是规则的缘故。
    await expect(page.locator(translationOf('reopen'))).toHaveText(`[T] ${J2.reopened}`, { timeout: 30000 });

    // 行内 keepOriginal：段落翻了，BrandX 原样出现在译文里，名字本身没发出去。
    const brand = page.locator(translationOf('brand'));
    await expect(brand).toContainText('[T]', { timeout: 30000 });
    await expect(brand).toContainText(J2.brandTail);
    await expect(brand.locator('span.brand')).toHaveText('BrandX');
    expect(sent(sentTexts, J2.brandTail)).toBe(true);
    expect(sent(sentTexts, 'BrandX')).toBe(false);

    // 块级 keepOriginal：零我们的节点，原文不在 sentTexts 里。
    expect(await oursIn(page, 'code-box')).toBe(0);
    expect(sent(sentTexts, J2.codeName)).toBe(false);
  } finally {
    await close();
  }
});

// ------------------------------------------------------------------ J-2 排版

// 行内「保留原文」和 translate="no" 的元素在送出文本里是占位符，和公式同一种。只有
// 真公式的块，译文才只写 opacity、把排版让给页面 CSS；只有原样元素的段落，译文照样
// 套原文的字体字号颜色（RJ-5）。
//
// 断言不能用 getComputedStyle().fontFamily：两种情况它都报原文的 Times，可实际渲
// 染的字体在丢了排版时按 lang 落到目标语言的默认字体（macOS 上 zh-CN 是 PingFang
// SC）。这里用 CDP 的 CSS.getPlatformFontsForNode 问实际用的字体，再用可见文字一样
// 的孪生段量宽度：命中规则的段落和不命中的孪生段，译文字体相同、宽度差 ≤ 1 px。
const J2T = {
  sentence: 'kettle comes with a two year warranty and a spare filter in the box.',
  formula: 'is the energy each particle carries through the whole box.',
};

const J2T_PAGE = html(`
  <p id="kept">Our <span class="brand">BrandX</span> ${J2T.sentence}</p>
  <p id="kept-twin">Our <span class="other">BrandX</span> ${J2T.sentence}</p>
  <p id="notr">The <span translate="no">Acme</span> ${J2T.sentence}</p>
  <p id="notr-twin">The <span>Acme</span> ${J2T.sentence}</p>
  <p id="formula"><span class="katex">E=mc2</span> ${J2T.formula}</p>`);

async function platformFont(client, rootId, selector) {
  const { nodeId } = await client.send('DOM.querySelector', { nodeId: rootId, selector });
  expect(nodeId, selector).toBeGreaterThan(0);
  const { fonts } = await client.send('CSS.getPlatformFontsForNode', { nodeId });
  // 用得最多的那一款：译文里原样克隆回来的元素也可能带自己的字体。
  return [...fonts].sort((a, b) => b.glyphCount - a.glyphCount)[0].familyName;
}

test('J-2 typography: a verbatim placeholder keeps the page typography, a real formula keeps only opacity', async ({ page, context, extensionId }) => {
  const { close, endpoint, sentTexts } = await startMockOpenAIServer();
  try {
    await setExtensionSettings(page, settings(endpoint));
    const options = await newOptionsTab(context, extensionId);
    await createRule(options, context, { match: ['rules.test'], keepOriginal: ['.brand'] });
    await options.close();

    await serve(context, { [`${RULES}/typography`]: J2T_PAGE });
    await page.goto(`${RULES}/typography`);
    await waitForFloatBall(page);

    await triggerPageTranslation(page);
    for (const id of ['kept', 'kept-twin', 'notr', 'notr-twin', 'formula']) {
      await expect(page.locator(translationOf(id))).toContainText('[T]', { timeout: 30000 });
    }
    // 前提：两个原样元素确实走了占位符，孪生段没有——名字只随孪生段送出一次。
    expect(sendCount(sentTexts, 'BrandX')).toBe(1);
    expect(sendCount(sentTexts, 'Acme')).toBe(1);
    await expect(page.locator(translationOf('kept')).locator('span.brand')).toHaveText('BrandX');
    await expect(page.locator(translationOf('notr')).locator('span[translate="no"]')).toHaveText('Acme');

    const client = await context.newCDPSession(page);
    await client.send('DOM.enable');
    await client.send('CSS.enable');
    const { root } = await client.send('DOM.getDocument', { depth: -1 });
    for (const [hit, twin] of [['kept', 'kept-twin'], ['notr', 'notr-twin']]) {
      const hitFont = await platformFont(client, root.nodeId, `#${hit} + ${TRANSLATED}`);
      const twinFont = await platformFont(client, root.nodeId, `#${twin} + ${TRANSLATED}`);
      console.log(`[typography] ${hit}=${hitFont} ${twin}=${twinFont}`);
      // soft：两组都要报出来，一组红了另一组照样量。
      expect.soft(hitFont, `${hit} renders in the twin's font`).toBe(twinFont);
    }

    const widths = await page.evaluate((sel) => Object.fromEntries(
      ['kept', 'kept-twin', 'notr', 'notr-twin'].map((id) => {
        const node = document.querySelector(`#${id} + ${sel}`);
        const range = document.createRange();
        range.selectNodeContents(node);
        return [id, { text: node.textContent, width: range.getBoundingClientRect().width }];
      })), TRANSLATED);
    console.log(`[typography] widths=${JSON.stringify(widths)}`);
    for (const [hit, twin] of [['kept', 'kept-twin'], ['notr', 'notr-twin']]) {
      expect(widths[hit].text).toBe(widths[twin].text);
      expect.soft(Math.abs(widths[hit].width - widths[twin].width), `${hit} vs ${twin}`).toBeLessThanOrEqual(1);
    }

    // 真公式照旧：只写 opacity，不写字体。
    const formulaStyle = await page.locator(translationOf('formula')).evaluate((node) => ({
      fontFamily: node.style.fontFamily,
      opacity: node.style.opacity,
    }));
    expect(formulaStyle).toEqual({ fontFamily: '', opacity: '0.85' });
  } finally {
    await close();
  }
});

// ------------------------------------------------------------------ J-4

const J4 = {
  lead: 'The harbour office publishes the tide table for the coming week every Friday afternoon.',
  promo: 'Subscribe to the newsletter and receive the timetable changes before anybody else.',
};

const J4_PAGE = html(`
  <div id="lead-box"><p id="lead">${J4.lead}</p></div>
  <div id="promo-box" class="promo"><p id="promo">${J4.promo}</p></div>`);

// 插入译文时会把原文的计算样式（含 color）抄进译文节点的行内 style，任何选择器都
// 压不过行内样式，所以这条用户 CSS 带 `!important`（规则数据，不是我们的样式表）。
// 设计 §6 J-4 写的是不带 `!important` 的版本，那样第 1 步永远不成立（偏差已登记）。
const J4_CSS = '.ai-translator-inline-block { color: rgb(1, 2, 3) !important }';

/** J-4 两条用例共用的开头：夹具页翻好，设置页开在另一个标签页里。 */
async function j4Start(page, context, extensionId, endpoint) {
  await setExtensionSettings(page, settings(endpoint));
  await serve(context, { [`${RULES}/tides`]: J4_PAGE });
  await page.goto(`${RULES}/tides`);
  await waitForFloatBall(page);
  await triggerPageTranslation(page);
  await expect(page.locator(translationOf('lead'))).toHaveText(`[T] ${J4.lead}`, { timeout: 30000 });
  await expect(page.locator(translationOf('promo'))).toHaveText(`[T] ${J4.promo}`, { timeout: 30000 });
  expect(await j4LeadColor(page)).not.toBe('rgb(1, 2, 3)');
  return newOptionsTab(context, extensionId);
}

const j4LeadColor = (page) => page.evaluate((selector) =>
  getComputedStyle(document.querySelector(selector)).color, translationOf('lead'));

const leakUrlOf = (endpoint) => `${new URL(endpoint).origin}/leak`;

test('J-4: CSS saved in Settings restyles another translated tab within 1 s, and unsafe CSS is refused there', async ({ page, context, extensionId }) => {
  const { close, endpoint, sentTexts } = await startMockOpenAIServer();
  try {
    const options = await j4Start(page, context, extensionId, endpoint);

    // 1. 另一个标签页里的设置页：新建一条只有 CSS 的规则，点保存。已翻好的那一页
    //    1 s 内译文的计算颜色变过去，不刷新。
    await fillRuleEditor(options, { match: ['rules.test'], css: J4_CSS });
    const t0 = Date.now();
    await saveRuleEditor(options);
    await withinOneSecond(t0, async () => (await j4LeadColor(page)) === 'rgb(1, 2, 3)', 'J-4 step 1 CSS applied');
    const stored = await storedRules(context);
    const [key] = Object.keys(stored);
    const id = key.slice('customRule:'.length);

    // 2. 编辑这一条，在 CSS 后面追加一段取外链的规则：字段下出现 customRuleCssUnsafe
    //    的文案，保存被拒，编辑器还开着，存储一个字不变。
    await fillRuleEditor(options, { css: `${J4_CSS}\nbody { background: url(${leakUrlOf(endpoint)}) }` }, id);
    await options.click('.custom-rule-save');
    const cssError = options.locator('#customRule-css ~ .custom-rule-field-error');
    await expect(cssError).toBeVisible();
    await expect(cssError).toHaveText(en('customRuleCssUnsafe'));
    await expect(options.locator('.custom-rule-editor')).toHaveCount(1);
    expect(await storedRules(context)).toEqual(stored);
    await options.click('.custom-rule-cancel');
    await expect(options.locator('.custom-rule-editor')).toHaveCount(0);
    expect(await j4LeadColor(page)).toBe('rgb(1, 2, 3)');
    expect(sent(sentTexts, J4.lead)).toBe(true);
  } finally {
    await close();
  }
});

test('J-4 hint: a CSS color without !important does not reach a translation, with !important it does', async ({ page, context, extensionId }) => {
  // customRuleCssHint 的承诺：译文节点带着抄来的行内 color，不加 !important 改不动。
  // 同一段 CSS 里放一条行内样式里没有的属性（text-decoration-line）做正向对照：
  // 它 1 s 内生效，证明这段 CSS 确实挂上了，color 没变是被行内样式压住，不是没挂。
  const { close, endpoint } = await startMockOpenAIServer();
  try {
    const options = await j4Start(page, context, extensionId, endpoint);
    const lead = () => page.evaluate((selector) => {
      const style = getComputedStyle(document.querySelector(selector));
      return { color: style.color, line: style.textDecorationLine };
    }, translationOf('lead'));
    const plain = '.ai-translator-inline-block { color: rgb(1, 2, 3); text-decoration-line: underline }';
    await fillRuleEditor(options, { match: ['rules.test'], css: plain });
    let t0 = Date.now();
    await saveRuleEditor(options);
    await withinOneSecond(t0, async () => (await lead()).line === 'underline', 'the plain CSS is mounted');
    expect((await lead()).color, 'color without !important').not.toBe('rgb(1, 2, 3)');

    const [key] = Object.keys(await storedRules(context));
    const id = key.slice('customRule:'.length);
    await fillRuleEditor(options, { css: plain.replace('rgb(1, 2, 3)', 'rgb(1, 2, 3) !important') }, id);
    t0 = Date.now();
    await saveRuleEditor(options);
    await withinOneSecond(t0, async () => (await lead()).color === 'rgb(1, 2, 3)', 'color with !important');
    expect((await lead()).line).toBe('underline');
  } finally {
    await close();
  }
});

test('[fixture] J-4 steps 3/3b: unsafe CSS written around Settings is not applied, the rest of that rule is, and nothing is fetched', async ({ page, context, extensionId }) => {
  // 隔离的是 J-4 第 3/3b 步：绕过设置页的写入（别的设备或手改的 sync 数据）。设置页
  // 存不进不安全的 CSS（主用例第 2 步），所以这一步只能由服务工作者直写。前提（第
  // 1 步那条 CSS 规则）照样在设置页里建。
  const { close, endpoint } = await startMockOpenAIServer();
  // /leak 计数：context.route 截下所有指向 /leak 的请求（哪个 frame、哪个来源都算）。
  // 末尾有一步正向对照：页面自己去取一次，计数必须变成 1 —— 证明计数器是接上的。
  let leaks = 0;
  await context.route('**/leak*', (route) => {
    leaks += 1;
    return route.fulfill({ status: 200, contentType: 'image/png', body: '' });
  });
  const cssRefusals = [];
  page.on('console', (msg) => {
    if (msg.text().startsWith('Blab Translation: custom rule CSS not applied')) cssRefusals.push(msg.text());
  });
  const leakUrl = leakUrlOf(endpoint);
  try {
    const options = await j4Start(page, context, extensionId, endpoint);
    const { id } = await createRule(options, context, { match: ['rules.test'], css: J4_CSS });
    await expect.poll(() => j4LeadColor(page)).toBe('rgb(1, 2, 3)');

    // 3. 服务工作者直写同一条规则，同一条里还有 exclude。exclude 照常生效；CSS 一个
    //    字都不挂；/leak 零请求。
    const t0 = Date.now();
    await writeRule(context, id, rule(['rules.test'], {
      exclude: ['.promo'],
      css: `body { background: url(${leakUrl}) }`,
    }));
    await withinOneSecond(t0, async () => (await oursIn(page, 'promo-box')) === 0, 'J-4 step 3 exclude applied');
    expect(await isTranslated(page, 'lead')).toBe(true);
    // 第 1 步的 CSS 也随之卸下：本页生效的规则只有这一条，它的 CSS 被拒了。
    expect(await j4LeadColor(page)).not.toBe('rgb(1, 2, 3)');
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundImage)).toBe('none');
    await page.waitForTimeout(1500);
    expect(leaks).toBe(0);
    // 同一段不安全 CSS 在这个页面里只告警一次：写入那一刻挂一次，之后每一轮
    // （自动翻译那一轮也算）都用记下的清洗结果（§3.5）。
    expect(cssRefusals.length).toBe(1);

    // 3b. 同一条规则换一段 CSS：两个字符串里的 `/*` 与 `*/` 把真正生效的 url( 夹在
    //     中间。只查去掉注释后的文本会漏掉它（D-315），原文那一遍兜住。断言同上。
    await writeRule(context, id, rule(['rules.test'], {
      exclude: ['.promo'],
      css: `a { content: "/*" } body { background: url(${leakUrl}) } b { content: "*/" }`,
    }));
    await page.waitForTimeout(1500);
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundImage)).toBe('none');
    expect(leaks).toBe(0);
    // 换了一段不安全 CSS，再告警一次，恰好两条。
    expect(cssRefusals.length).toBe(2);
    expect(await oursIn(page, 'promo-box')).toBe(0);
    // 拒绝日志只带错误键，不带规则内容。
    for (const line of cssRefusals) expect(line).not.toContain('leak');

    // 正向对照：页面自己取一次 /leak，计数器看得见。
    await page.evaluate((url) => { new Image().src = `${url}?control`; }, leakUrl);
    await expect.poll(() => leaks, { timeout: 5000 }).toBe(1);
  } finally {
    await close();
  }
});

// ------------------------------------------------------------------ J-5

test('J-5: rules export from the card, and an import is previewed, merged by id, and a bad file changes nothing', async ({ page, context, extensionId }) => {
  await setExtensionSettings(page, { targetLang: 'zh-CN' });
  await openOptions(page, extensionId);
  const { id: idA } = await createRule(page, context, { match: ['rules.test'], exclude: ['.comments'] });
  const storedA = (await storedRules(context))[`customRule:${idA}`];

  // 导出：下载的文件 format / version / rules 都对，规则就是存着的那一条带上 id。
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#customRulesExport')]);
  expect(download.suggestedFilename()).toMatch(/^blab-site-rules-\d{8}\.json$/);
  const exported = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
  expect(exported.format).toBe('blab-site-rules');
  expect(exported.version).toBe(1);
  expect(exported.rules).toEqual([{ id: idA, ...storedA }]);

  // 准备一份文件：A 改一个字段并钉 AI，再加一条钉 AI 的新规则 B。AI 提示里的 K 数的
  // 是文件里全部 engine:'ai' 的条数（§6.1），替换的也算：这里是 2，新增的只有 1。
  const idB = 'jfivebee';
  const file = {
    ...exported,
    rules: [
      { ...exported.rules[0], exclude: ['.comments', '.footer'], engine: 'ai' },
      { id: idB, v: 1, match: ['other.test'], engine: 'ai' },
    ],
  };
  await page.setInputFiles('#customRulesFile', {
    name: 'blab-site-rules-20260927.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(file)),
  });
  await expect(page.locator('#customRulesPreview')).toBeVisible();
  await expect(page.locator('#customRulesPreviewText'))
    .toHaveText(fill(en('customRulesImportPreview'), { added: 1, replaced: 1 }));
  await expect(page.locator('#customRulesPreviewWarnings .transfer-warning'))
    .toHaveText([fill(en('customRulesImportAiNote'), { count: 2 })]);
  // 预览时什么都还没写。
  expect(Object.keys(await storedRules(context))).toEqual([`customRule:${idA}`]);

  await page.click('#customRulesImportConfirm');
  await expect(page.locator('#customRulesPreview')).toBeHidden();
  await expect(page.locator('#statusMessage')).toContainText(en('settingsSaved'));
  await expect(page.locator('.custom-rule')).toHaveCount(2);
  await expect(page.locator(`.custom-rule[data-rule-id="${idA}"]`)).toHaveCount(1);
  await expect(page.locator(`.custom-rule[data-rule-id="${idB}"]`)).toHaveCount(1);
  const imported = await storedRules(context);
  expect(Object.keys(imported).sort()).toEqual([`customRule:${idA}`, `customRule:${idB}`].sort());
  expect(imported[`customRule:${idA}`]).toMatchObject({ exclude: ['.comments', '.footer'], engine: 'ai' });
  expect(imported[`customRule:${idB}`]).toMatchObject({ v: 1, match: ['other.test'], engine: 'ai' });

  // 坏 JSON：报错，预览不出，存储逐字节不变。
  const before = await syncSnapshot(context);
  await page.setInputFiles('#customRulesFile', {
    name: 'broken.json', mimeType: 'application/json', buffer: Buffer.from('{"format": "blab-site-rules", '),
  });
  await expect(page.locator('#customRulesError')).toBeVisible();
  await expect(page.locator('#customRulesError')).toHaveText(en('customRulesImportInvalid'));
  await expect(page.locator('#customRulesPreview')).toBeHidden();
  await page.waitForTimeout(500);
  expect(await syncSnapshot(context)).toEqual(before);
  await expect(page.locator('.custom-rule')).toHaveCount(2);
});

// ------------------------------------------------------------------ J-6

const J6 = {
  lead: 'The river cruise leaves the old town bridge every hour between ten and four.',
};

const J6_PAGE = html(`<div id="lead-box"><p id="lead">${J6.lead}</p></div>`);

test('J-6: a rule that pins AI asks first, opens the daily budget, and auto-translates that site with AI', async ({ page, context, extensionId }) => {
  const { close, endpoint, sentTexts } = await startMockOpenAIServer();
  try {
    // 两张开关都是内置、回退只许本地：三条零点击的 AI 路全关。站点「总是」是这条
    // 旅程后半的前提，和规则无关，一起写在开头。
    await setExtensionSettings(page, settings(endpoint, {
      translationEngine: 'builtin',
      autoTranslateEngine: 'builtin',
      engineFallback: 'local-only',
      autoTranslate: true,
      siteRules: { 'rules.test': 'always' },
    }));
    const options = await newOptionsTab(context, extensionId);
    const budget = options.locator('#autoAiBudgetGroup');
    await expect(budget).toHaveClass(/(^|\s)disabled(\s|$)/);

    // 选 AI：确认框文案对；点取消，下拉框回到原值，什么都没存。
    await fillRuleEditor(options, { match: ['rules.test'] });
    await chooseAiEngine(options, false);
    await expect(options.locator('#customRule-engine')).toHaveValue('');
    expect(await storedRules(context)).toEqual({});
    await expect(budget).toHaveClass(/(^|\s)disabled(\s|$)/);

    // 再选一次并接受，保存：额度那一格亮起来。
    await chooseAiEngine(options, true);
    await expect(options.locator('#customRule-engine')).toHaveValue('ai');
    await saveRuleEditor(options);
    const stored = Object.values(await storedRules(context));
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ match: ['rules.test'], engine: 'ai' });
    await expect(budget).not.toHaveClass(/(^|\s)disabled(\s|$)/);

    // 打开夹具：没人点，自动翻译的请求打到 mock，页面出现译文，今天的 AI 用量增加。
    const charsBefore = await autoAiChars(context);
    await serve(context, { [`${RULES}/cruise`]: J6_PAGE });
    await page.bringToFront();
    await page.goto(`${RULES}/cruise`);
    await waitForFloatBall(page);
    await expect(page.locator(translationOf('lead'))).toHaveText(`[T] ${J6.lead}`, { timeout: 30000 });
    expect(sent(sentTexts, J6.lead)).toBe(true);
    await expect.poll(async () => (await autoAiChars(context)) - charsBefore, { timeout: 5000 }).toBeGreaterThan(0);

    // popup：它总是探测标签页，探测到的引擎跟随站点规则 —— 状态行是 AI 那一句。
    const probe = await sendMessageToActiveTab(page, { type: 'PROBE_ENGINE' });
    expect(probe && probe.engine).toBe('ai');
    const popup = await context.newPage();
    await popup.goto(popupUrl(extensionId));
    await page.bringToFront();
    await popup.reload();
    await expect(popup.locator('#statusText')).toHaveText(en('ready'));
    await expect(popup.locator('#statusText')).not.toHaveText(new RegExp(`^${en('statusBuiltinReady')}`));
  } finally {
    await close();
  }
});

// ------------------------------------------------------------------ J-7

test('J-7: the usage line counts KiB and rules, and a rule that would go over the budget is refused', async ({ page, context, extensionId }) => {
  await setExtensionSettings(page, { targetLang: 'zh-CN' });
  // 预置（设计点名的 SW 写入）：49 条、合计 49 × 490 = 24010 字节，贴着 24 KiB。
  await writeSyncSettings(context, presetRules());
  await openOptions(page, extensionId);

  const used = (PRESET_COUNT * PER_RULE / 1024).toLocaleString('en', { maximumFractionDigits: 1 });
  await expect(page.locator('#customRulesUsage'))
    .toHaveText(fill(en('customRulesUsage'), { used, total: '24', count: PRESET_COUNT, max: 50 }));
  await expect(page.locator('#customRulesUsage')).toContainText('49 / 50');
  await expect(page.locator('.custom-rule')).toHaveCount(PRESET_COUNT);

  // 第 50 条在条数上还放得下，字节放不下：两段 300 字的选择器。
  const before = await syncSnapshot(context);
  await fillRuleEditor(page, {
    match: ['overflow.test'],
    exclude: [`.a${'b'.repeat(300)}`, `.c${'d'.repeat(300)}`],
  });
  await page.click('.custom-rule-save');
  const general = page.locator('.custom-rule-general-error');
  await expect(general).toBeVisible();
  await expect(general).toHaveText(en('customRulesBudgetFull'));
  await expect(page.locator('.custom-rule-editor')).toHaveCount(1);
  expect(await syncSnapshot(context)).toEqual(before);
  await expect(page.locator('#customRulesUsage')).toContainText('49 / 50');
});
