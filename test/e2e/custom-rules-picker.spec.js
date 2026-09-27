// 用户站点规则（P1-B）：页内拾取器的旅程（设计 §5、§6 J-1、J-3）。
//
// 规则全部由拾取器写下：悬浮球菜单「调整本站翻译区域」或 popup 的同名按钮打开它，
// 用真指针悬停、点选，再点工具条上的动作。唯一的例外是「本站规则的 CSS 不安全」
// 那一条：设置页存不进不安全的 CSS，只能由服务工作者直写来造这个前提，所以标题
// 带 [fixture]。
const { test, expect } = require('./fixtures');
const {
  setExtensionSettings,
  triggerPageTranslation,
  waitForFloatBall,
  oursIn,
  sentSegments,
  openFloatBallMenu,
} = require('./helpers');
const { startMockOpenAIServer } = require('./mock-openai-server');
const {
  PICKER,
  en,
  fill,
  settings,
  html,
  serve,
  rule,
  writeRule,
  storedRules,
  clearTranslationCache,
  sent,
  sendCount,
  withinOneSecond,
  translationOf,
  isTranslated,
  expectMenuItemLaidOut,
  openPickerFromMenu,
  expectOutlineOn,
  expectBarInViewport,
  pickWithPointer,
  pickerButton,
  expectPickerMatches,
  expectPickerSavedNotice,
} = require('./custom-rules-fixtures');

const RULES = 'https://rules.test';

/** 拾取器拆干净了：根节点不在，页面上没有它的任何一个节点。 */
async function expectPickerGone(page) {
  await expect(page.locator(PICKER)).toHaveCount(0);
  expect(await page.locator('[class*="ai-translator-picker-"]').count()).toBe(0);
}

// ------------------------------------------------------------------ J-1

const J1 = {
  body1: 'The coastal path reopens next week after the landslide repairs near the old lighthouse.',
  body2: 'Walkers are asked to keep to the marked route while the fences are being replaced.',
  comment1: 'I walked this stretch in May and the views from the headland were worth every step.',
  comment2: 'Does anybody know whether the cafe at the far end is open during the repairs?',
};

// 评论区是一个带内边距的 section：悬停内边距里那一点，指针落在 section 自己身上，
// 生成的选择器是 `section.comments`。盒子 region-box 只给「没翻」的 DOM 一半用。
const J1_PAGE = html(`
  <div id="body-box"><p id="body1">${J1.body1}</p><p id="body2">${J1.body2}</p></div>
  <div id="region-box">
    <section class="comments" style="padding: 16px">
      <p id="comment1">${J1.comment1}</p><p id="comment2">${J1.comment2}</p>
    </section>
  </div>`);

test('J-1: the picker excludes the comments of a translated page within 1 s, and the rule holds after a reload', async ({ page, context }) => {
  const { close, endpoint, sentTexts } = await startMockOpenAIServer();
  try {
    await page.setViewportSize({ width: 1280, height: 800 });
    await setExtensionSettings(page, settings(endpoint));
    await serve(context, { [`${RULES}/coast`]: J1_PAGE });
    await page.goto(`${RULES}/coast`);
    await waitForFloatBall(page);

    // 1. 翻译：正文和评论区都有译文。
    await triggerPageTranslation(page);
    for (const id of ['body1', 'body2', 'comment1', 'comment2']) {
      await expect(page.locator(translationOf(id))).toHaveText(`[T] ${J1[id]}`, { timeout: 30000 });
    }

    // 2. 悬浮菜单里「调整本站翻译区域」在菜单盒内、菜单在视口内；点它打开拾取器。
    await openPickerFromMenu(page);
    await expectBarInViewport(page, 'J-1 open');

    // 3. 悬停评论区：描框与评论区 rect 一致；点下去锁定，工具条显示选择器和「匹配 1 处」。
    const comments = page.locator('section.comments');
    await pickWithPointer(page, comments, 'J-1 comments', { x: 6, y: 6 });
    await expect(page.locator(`${PICKER} .ai-translator-picker-input`)).toHaveValue('section.comments');
    await expectPickerMatches(page, 1);
    await expectBarInViewport(page, 'J-1 locked');
    // 两个动作各带一行看得见的说明（设计 §5.1「点选后」）。
    await expect(page.locator(`${PICKER} [data-tip="exclude"]`))
      .toHaveText(fill(en('pickerTipLine'), { label: en('pickerExclude'), tip: en('pickerExcludeTip') }));
    await expect(page.locator(`${PICKER} [data-tip="keepOriginal"]`))
      .toHaveText(fill(en('pickerTipLine'), { label: en('pickerKeepOriginal'), tip: en('pickerKeepOriginalTip') }));

    // 4. 点「不翻译这里」：1 s 内评论区译文消失、正文译文仍在，不刷新；出现保存提示，
    //    拾取器拆干净。
    const t0 = Date.now();
    await pickerButton(page, 'exclude').click();
    await withinOneSecond(t0, async () => (await oursIn(page, 'region-box')) === 0
      && isTranslated(page, 'body1'), 'J-1 exclude saved');
    expect(await isTranslated(page, 'body2')).toBe(true);
    await expectPickerSavedNotice(page);
    await expectPickerGone(page);
    // 保存提示是我们的界面，不是正文：发现层的防抖过去以后，它的文字也没被送去翻译。
    await page.waitForTimeout(1500);
    expect(sentTexts.some((text) => text.includes(en('pickerSaved'))), 'the saved notice was sent for translation')
      .toBe(false);

    // 5. sync 区里恰好一个规则键，exclude 就是这一条选择器。
    const rules = await storedRules(context);
    expect(Object.keys(rules)).toHaveLength(1);
    const [stored] = Object.values(rules);
    expect(stored.match).toEqual(['rules.test']);
    expect(stored.exclude).toEqual(['section.comments']);

    // 6. 清两半缓存后重载再翻：正文重新送出并有译文，评论区零节点、零发送。
    await clearTranslationCache(context);
    const before = sentTexts.length;
    await page.reload();
    await waitForFloatBall(page);
    await triggerPageTranslation(page);
    await expect(page.locator(translationOf('body1'))).toHaveText(`[T] ${J1.body1}`, { timeout: 30000 });
    await page.waitForTimeout(1500);
    const after = sentTexts.slice(before);
    expect(sent(after, J1.body1)).toBe(true);
    expect(await oursIn(page, 'region-box')).toBe(0);
    for (const text of [J1.comment1, J1.comment2]) expect(sent(after, text), `sent: ${text}`).toBe(false);
  } finally {
    await close();
  }
});

// ------------------------------------------------------------------ J-1 行内

// B2 第 23 条：用户 exclude 落在段落里的一个行内元素上。这一步区分 exclude 和
// keepOriginal：keepOriginal 让它以占位符送出、原样回到译文里；exclude 让它整个
// 不进送出文本，所以译文里也没有它。原文里它照旧在。
//
// 走的是「已经翻过，再排除，再翻译」这条路（设计 §6 J-1「重新翻译后」）：行内命中
// 不禁止整块，已有的译文不被清扫，新规则在下一次收块时生效。重新翻译的真实入口是
// 重载后再点「翻译」—— 同一页上再点一下是把译文藏起来，不会重收已经翻过的块。
// 缓存不清：段落的送出文本变了，旧译文不该被按原来那段文字命中。
const J1I = {
  lead: 'The ferry company publishes a new winter timetable at the start of every November.',
  before: 'Please read',
  tag: 'SPONSORED OFFER',
  after: 'the harbour safety rules before boarding the morning ferry to the island.',
};

const J1I_PAGE = html(`
  <div id="lead-box"><p id="lead">${J1I.lead}</p></div>
  <div id="inline-box"><p id="inline">${J1I.before} <span class="promo-tag">${J1I.tag}</span> ${J1I.after}</p></div>`);

/** 第 from 条请求之后送出的、含段落后半句的那一段。分隔符从全部快速批次里取。 */
function inlineSegment(sentTexts, fastBatchRequests, from) {
  return sentSegments(sentTexts.slice(from), fastBatchRequests).find((text) => text.includes(J1I.after));
}

test('J-1 inline: excluding an inline element of a translated page leaves it out of the next translation, not out of the page', async ({ page, context }) => {
  const { close, endpoint, sentTexts, fastBatchRequests } = await startMockOpenAIServer();
  try {
    await setExtensionSettings(page, settings(endpoint));
    await serve(context, { [`${RULES}/inline`]: J1I_PAGE });
    await page.goto(`${RULES}/inline`);
    await waitForFloatBall(page);
    const translation = page.locator(translationOf('inline'));

    // 1. 先翻一遍：没有规则时它在送出的文本里，也在译文里。
    await triggerPageTranslation(page);
    await expect(page.locator(translationOf('lead'))).toHaveText(`[T] ${J1I.lead}`, { timeout: 30000 });
    await expect(translation).toContainText(J1I.after, { timeout: 30000 });
    await expect(translation).toContainText(J1I.tag);
    expect(inlineSegment(sentTexts, fastBatchRequests, 0), 'first round').toContain(J1I.tag);

    // 2. 拾取器点中段落里的 span，选择器就是它，「不翻译这里」。
    await openPickerFromMenu(page);
    await pickWithPointer(page, page.locator('#inline span.promo-tag'), 'J-1 inline tag');
    await expect(page.locator(`${PICKER} .ai-translator-picker-input`)).toHaveValue('span.promo-tag');
    await expectPickerMatches(page, 1);
    await pickerButton(page, 'exclude').click();
    await expectPickerSavedNotice(page);
    await expectPickerGone(page);
    expect(Object.values(await storedRules(context)).map((r) => r.exclude)).toEqual([['span.promo-tag']]);

    // 3. 重新翻译：重载，再点「翻译」。
    const from = sentTexts.length;
    await page.reload();
    await waitForFloatBall(page);
    await triggerPageTranslation(page);
    await expect(page.locator(translationOf('lead'))).toHaveText(`[T] ${J1I.lead}`, { timeout: 30000 });
    await expect(translation).toContainText('[T]', { timeout: 30000 });
    await expect(translation).toContainText(J1I.after);

    // 3a. 这一轮送出的文本里没有它，也没有替它占位的记号（keepOriginal 会留一个 {{n}}）。
    const segment = inlineSegment(sentTexts, fastBatchRequests, from);
    expect(segment, 'the paragraph was sent again').toBeTruthy();
    expect(segment).not.toContain(J1I.tag);
    expect(segment).not.toMatch(/\{\{\d+\}\}/);
    expect(sent(sentTexts.slice(from), J1I.tag)).toBe(false);

    // 3b. 译文节点里也没有它：没有克隆回来的 span，也没有这几个字。
    await expect(translation.locator('span.promo-tag')).toHaveCount(0);
    await expect(translation).not.toContainText(J1I.tag);

    // 3c. 原文里它照旧在。
    await expect(page.locator('#inline > span.promo-tag')).toHaveText(J1I.tag);
    await expect(page.locator('#inline')).toContainText(`${J1I.before} ${J1I.tag} ${J1I.after}`);
  } finally {
    await close();
  }
});

// ------------------------------------------------------------------ J-3

const J3 = {
  nav: 'World news and politics section of the gazette',
  main1: 'The first crossing of the season left the northern pier at a quarter past six this morning.',
  main2: 'Crews spent most of the winter repairing the landing stage after the January storms.',
  faqQ: 'How early should passengers arrive before the ferry departs from the pier?',
  faqA: 'Please arrive at least twenty minutes early so the crew can load bicycles first.',
  aside: 'The most read stories of the week are collected in this sidebar panel.',
};

const J3_PAGE = html(`
  <nav id="site-nav"><ul><li id="nav1">${J3.nav}</li></ul></nav>
  <main id="main"><article><p id="main1">${J3.main1}</p><p id="main2">${J3.main2}</p></article></main>
  <aside id="sidebar">
    <div class="faq"><p id="faq-q">${J3.faqQ}</p><p id="faq-a">${J3.faqA}</p></div>
    <div id="aside-box"><p id="aside-p">${J3.aside}</p></div>
  </aside>`);

test('J-3: the picker narrows a whole-page setting to the FAQ, and "Translate Whole Page" widens it again', async ({ page, context }) => {
  const { close, endpoint, sentTexts } = await startMockOpenAIServer();
  try {
    await setExtensionSettings(page, settings(endpoint, { pageTranslateScope: 'page' }));
    await serve(context, { [`${RULES}/help`]: J3_PAGE });
    await page.goto(`${RULES}/help`);
    await waitForFloatBall(page);

    // 1. 拾取器点中 FAQ 的问题段，「↑上一层」升到 .faq，「只翻译这里」。
    await openPickerFromMenu(page);
    await pickWithPointer(page, page.locator('#faq-q'), 'J-3 question');
    await expect(page.locator(`${PICKER} .ai-translator-picker-input`)).toHaveValue('#faq-q');
    await pickerButton(page, 'parent').click();
    await expect(page.locator(`${PICKER} .ai-translator-picker-input`)).toHaveValue('div.faq');
    await expectOutlineOn(page, page.locator('div.faq'), 'J-3 parent');
    await expectPickerMatches(page, 1);
    await pickerButton(page, 'include').click();
    await expectPickerSavedNotice(page);
    await expectPickerGone(page);
    expect(Object.values(await storedRules(context)).map((r) => r.include)).toEqual([['div.faq']]);

    // 2. 翻译：只有 .faq 翻了；导航、正文、侧栏其余部分零节点、零发送。
    await triggerPageTranslation(page);
    await expect(page.locator(translationOf('faq-q'))).toHaveText(`[T] ${J3.faqQ}`, { timeout: 30000 });
    await expect(page.locator(translationOf('faq-a'))).toHaveText(`[T] ${J3.faqA}`, { timeout: 30000 });
    await page.waitForTimeout(1500);
    expect(await oursIn(page, 'site-nav')).toBe(0);
    expect(await oursIn(page, 'main')).toBe(0);
    expect(await oursIn(page, 'aside-box')).toBe(0);
    await expect(page.locator(translationOf('aside-p'))).toHaveCount(0);
    for (const text of [J3.nav, J3.main1, J3.main2, J3.aside]) {
      expect(sent(sentTexts, text), `sent: ${text}`).toBe(false);
    }

    // 3. 设置是 'page'，但规则把范围收到了 include：菜单里有「翻译整个页面」，几何
    //    在菜单盒内，菜单在视口内。
    await openFloatBallMenu(page);
    const item = await expectMenuItemLaidOut(page, 'translate-whole-page', 'Translate Whole Page');

    // 4. 点它：其余全部翻出来，FAQ 不重复发。
    const faqSends = sendCount(sentTexts, J3.faqQ);
    await item.click();
    for (const id of ['nav1', 'main1', 'main2', 'aside-p']) {
      await expect(page.locator(translationOf(id))).toContainText('[T]', { timeout: 30000 });
    }
    for (const text of [J3.nav, J3.main1, J3.main2, J3.aside]) {
      expect(sent(sentTexts, text), `sent: ${text}`).toBe(true);
    }
    expect(sendCount(sentTexts, J3.faqQ)).toBe(faqSends);
    await expect(page.locator(translationOf('faq-q'))).toHaveCount(1);
    // 正向对照：第 2 步那条 aside-box 为 0 的断言，用的是看得见我们节点的 oursIn。
    expect(await oursIn(page, 'aside-box')).toBeGreaterThan(0);
  } finally {
    await close();
  }
});

// ------------------------------------------------------------------ 几何与拆除

const GEO = {
  top: 'The lock keeper opens the upper gates at dawn so the first barges can pass through.',
  low: 'Mooring is free for the first night and charged by the metre for every night after that.',
};

// low 被一段空白推到视口底边那一带：锁定它时工具条要挪到顶边。
const GEO_PAGE = html(`
  <p id="top-p">${GEO.top} <a id="leave" href="${RULES}/elsewhere">Timetable</a></p>
  <div style="height: 560px"></div>
  <p id="low-p">${GEO.low}</p>
  <div style="height: 1200px"></div>`);

for (const viewport of [{ width: 1280, height: 800 }, { width: 375, height: 812 }]) {
  const size = `${viewport.width}x${viewport.height}`;
  test(`picker geometry ${size}: toolbar inside the viewport, outline on the target, nothing left behind`, async ({ page, context }) => {
    await page.setViewportSize(viewport);
    // 自动翻译照常开着：「要不要翻译这一页」的追问条先冒出来。375 宽时它横在底边
    // 那一带，正好压在 #low-p 上 —— 拾取器开着的时候它要让位，关掉后原样回来。
    await setExtensionSettings(page, settings('http://127.0.0.1:9'));
    await serve(context, { [`${RULES}/locks`]: GEO_PAGE });
    await page.goto(`${RULES}/locks`);
    await waitForFloatBall(page);
    const ask = page.locator('#ai-translator-auto-bar');
    await expect(ask, 'the ask bar is up before the picker opens').toHaveAttribute('data-mode', 'ask');

    // 目标在上半截：工具条贴底边。页面上的链接点不动，它只是被选中。
    await openPickerFromMenu(page);
    await expectBarInViewport(page, `${size} open`);
    await pickWithPointer(page, page.locator('#leave'), `${size} link`);
    expect(page.url()).toBe(`${RULES}/locks`);
    await expect(page.locator(`${PICKER} .ai-translator-picker-bar`)).toHaveAttribute('data-edge', 'bottom');
    await expectBarInViewport(page, `${size} top target`);

    // 「取消」拆干净。
    await pickerButton(page, 'cancel').click();
    await expectPickerGone(page);

    // 目标压在底边那一带：追问条让了位，低处的目标上面没有任何我方节点（描框不接
    // 指针，不算）；工具条挪到顶边，仍完整落在视口里，不挡住目标。
    await openPickerFromMenu(page);
    await expect(ask, 'the ask bar steps aside while the picker is open').toHaveCount(0);
    const low = page.locator('#low-p');
    const lowBox = await low.boundingBox();
    expect(lowBox.y + lowBox.height, 'the low target starts inside the viewport').toBeLessThanOrEqual(viewport.height);
    const above = await low.evaluate((el) => {
      const box = el.getBoundingClientRect();
      const y = box.top + box.height / 2;
      return [0.1, 0.5, 0.9].flatMap((at) => {
        const x = box.left + box.width * at;
        const stack = document.elementsFromPoint(x, y);
        return stack.slice(0, stack.indexOf(el))
          .filter((node) => node.closest('[id^="ai-translator-"], .ai-translator-popup'))
          .map((node) => `${Math.round(x)}: ${node.id || node.className}`);
      });
    });
    expect(above, `${size} our nodes above the low target`).toEqual([]);
    await page.mouse.move(lowBox.x + lowBox.width / 2, lowBox.y + lowBox.height / 2);
    await expectOutlineOn(page, low, `${size} low (hover)`);
    await page.mouse.click(lowBox.x + lowBox.width / 2, lowBox.y + lowBox.height / 2);
    await expect(page.locator(`${PICKER} .ai-translator-picker-input`)).toBeVisible();
    await expectOutlineOn(page, low, `${size} low (locked)`);
    await expect(page.locator(`${PICKER} .ai-translator-picker-bar`)).toHaveAttribute('data-edge', 'top');
    await expectBarInViewport(page, `${size} low target`);
    const barBox = await page.locator(`${PICKER} .ai-translator-picker-bar`).boundingBox();
    expect(barBox.y + barBox.height, 'the toolbar clears the target').toBeLessThanOrEqual(lowBox.y);

    // Esc 也拆干净，追问条按原来的样子回来；之后页面上的链接照常能点。
    await page.keyboard.press('Escape');
    await expectPickerGone(page);
    await expect(ask, 'the ask bar comes back once the picker closes').toHaveAttribute('data-mode', 'ask');

    // 存好一条后立刻再开拾取器去排低处那一块。保存提示不会自己消失，拾取器开着
    // 时它的 × 又点不动：它也得让位，低处目标的中心取到的是目标本身；关掉拾取器
    // 后那句提示照样回来。
    await openPickerFromMenu(page);
    await pickWithPointer(page, page.locator('#leave'), `${size} link to save`);
    await pickerButton(page, 'exclude').click();
    await expectPickerGone(page);
    await expect(ask, 'the saved notice shows').toHaveAttribute('data-mode', 'notice');
    await openPickerFromMenu(page);
    await expect(ask, 'the saved notice steps aside while the picker is open').toHaveCount(0);
    const lowAgain = await low.boundingBox();
    const center = { x: lowAgain.x + lowAgain.width / 2, y: lowAgain.y + lowAgain.height / 2 };
    const hit = await page.evaluate(({ x, y }) => {
      const node = document.elementFromPoint(x, y);
      if (!node) return 'nothing';
      return node.closest('#low-p') ? 'low-p' : `${node.tagName}#${node.id}.${node.className}`;
    }, center);
    expect(hit, `${size} the low target's centre after a save`).toBe('low-p');
    await page.mouse.move(center.x, center.y);
    await page.mouse.click(center.x, center.y);
    await expect(page.locator(`${PICKER} .ai-translator-picker-input`)).toBeVisible();
    await expectOutlineOn(page, low, `${size} low after a save (locked)`);
    await page.keyboard.press('Escape');
    await expectPickerGone(page);
    await expect(ask, 'the saved notice comes back once the picker closes').toHaveAttribute('data-mode', 'notice');
    await page.click('#leave');
    await expect(page).toHaveURL(`${RULES}/elsewhere`);
  });
}

// 右下角那条窄条也是我们画的界面：在它的字上划选，不该弹「划词翻译」按钮叠在
// 它上面。划词与悬停读的是 ctx.constants.OWN_NODES_SELECTOR，同一份界面根清单。
test('selecting the ask bar\'s own text shows no selection button', async ({ page, context }) => {
  await setExtensionSettings(page, settings('http://127.0.0.1:9', { enableSelection: true }));
  await serve(context, { [`${RULES}/locks`]: GEO_PAGE });
  await page.goto(`${RULES}/locks`);
  await waitForFloatBall(page);
  const ask = page.locator('#ai-translator-auto-bar');
  await expect(ask).toHaveAttribute('data-mode', 'ask');
  const button = page.locator('#ai-translator-selection-btn');

  async function dragAcross(target) {
    const box = await target.boundingBox();
    await page.evaluate(() => window.getSelection().removeAllRanges());
    await page.mouse.move(box.x + 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2, { steps: 12 });
    await page.mouse.up();
  }

  // 对照：页面正文上划选，按钮照常出来 —— 这一页的划词是开着的。
  await dragAcross(page.locator('#top-p'));
  await expect(button, 'selecting page text shows the button').toBeVisible();
  await page.keyboard.press('Escape');
  await expect(button).toHaveCount(0);

  const prompt = ask.locator('.ai-translator-auto-text');
  await dragAcross(prompt);
  const selected = await page.evaluate(() => window.getSelection().toString());
  expect(selected.length, 'the drag selected text on the ask bar').toBeGreaterThan(1);
  expect(en('autoAskPrompt')).toContain(selected.trim());
  // 划词在 mouseup 后等 100 ms 才决定出不出按钮。
  await page.waitForTimeout(400);
  await expect(button, 'no selection button over our own ask bar').toHaveCount(0);
  await expect(ask).toHaveAttribute('data-mode', 'ask');
});

// ------------------------------------------------------------------ 置灰

const GREY = {
  lead: 'The ferry leaves the north pier every hour on the hour between April and October.',
};

test('picker: a selector that is invalid or matches nothing greys the three actions (§5.1)', async ({ page, context }) => {
  await setExtensionSettings(page, settings('http://127.0.0.1:9'));
  await serve(context, { [`${RULES}/ferry`]: html(`<p id="lead">${GREY.lead}</p>`) });
  await page.goto(`${RULES}/ferry`);
  await waitForFloatBall(page);

  await openPickerFromMenu(page);
  await pickWithPointer(page, page.locator('#lead'), 'grey lead');
  const input = page.locator(`${PICKER} .ai-translator-picker-input`);
  const count = page.locator(`${PICKER} .ai-translator-picker-count`);
  const actions = ['exclude', 'keepOriginal', 'include'];
  const expectActions = async (enabled, label) => {
    for (const act of actions) {
      const button = pickerButton(page, act);
      if (enabled) await expect(button, `${label}: ${act}`).toBeEnabled();
      else await expect(button, `${label}: ${act}`).toBeDisabled();
    }
  };
  await expectPickerMatches(page, 1);
  await expectActions(true, 'one match');

  // 改成一条页面上找不到的：计数 0，三个动作灰掉；「上一层」和「取消」不受影响。
  await input.fill('#no-such-element');
  await expectPickerMatches(page, 0);
  await expect(count).toHaveAttribute('data-invalid', 'false');
  await expectActions(false, 'zero matches');
  await expect(pickerButton(page, 'parent')).toBeEnabled();
  await expect(pickerButton(page, 'cancel')).toBeEnabled();

  // 写坏的选择器：计数那里换成 customRuleSelectorInvalid 的文案，三个动作灰掉。
  await input.fill('p[');
  await expect(count).toHaveText(en('customRuleSelectorInvalid').replace('{selector}', 'p['));
  await expect(count).toHaveAttribute('data-invalid', 'true');
  await expectActions(false, 'invalid');

  // 改回能命中的，三个动作回来。整个过程存储里一条规则都没有。
  await input.fill('#lead');
  await expectPickerMatches(page, 1);
  await expectActions(true, 'back to one match');
  expect(await storedRules(context)).toEqual({});
});

// ------------------------------------------------------------------ 只认真实点击

const TRUSTED = {
  lead: 'The night bus runs every thirty minutes from the station square until two in the morning.',
};

test('picker: a click the page script makes neither locks a target nor writes a rule', async ({ page, context }) => {
  await setExtensionSettings(page, settings('http://127.0.0.1:9'));
  await serve(context, { [`${RULES}/night`]: html(`<p id="lead">${TRUSTED.lead}</p>`) });
  await page.goto(`${RULES}/night`);
  await waitForFloatBall(page);
  await openPickerFromMenu(page);
  const input = page.locator(`${PICKER} .ai-translator-picker-input`);

  // 页面脚本点页面元素：截下了（isTrusted 为假），但什么都没锁上。
  await page.evaluate(() => document.getElementById('lead').click());
  await expect(input).toBeHidden();

  // 真指针锁定；页面脚本再去点工具条上的「排除」：规则不写，拾取器还开着。
  await pickWithPointer(page, page.locator('#lead'), 'trusted lead');
  await page.evaluate((root) => document.querySelector(`${root} [data-act="exclude"]`).click(), PICKER);
  await page.waitForTimeout(500);
  expect(await storedRules(context)).toEqual({});
  await expect(page.locator(PICKER)).toHaveCount(1);

  // 正向对照：同一个按钮用户真点一下，规则写进去。
  await pickerButton(page, 'exclude').click();
  await expectPickerSavedNotice(page);
  await expect.poll(async () => Object.values(await storedRules(context)).map((r) => r.exclude))
    .toEqual([['#lead']]);
});

// ------------------------------------------------------------------ 键盘焦点

const FOCUS = {
  lead: 'The harbour ferry leaves the pier every hour and returns at twenty past.',
};

test('picker: Tab and Shift+Tab cycle through the toolbar and never leave it', async ({ page, context }) => {
  await setExtensionSettings(page, settings('http://127.0.0.1:9', { theme: 'light' }));
  await serve(context, { [`${RULES}/harbour`]: html(`<p id="lead">${FOCUS.lead}</p><a href="#x">a page link</a>`) });
  await page.goto(`${RULES}/harbour`);
  await waitForFloatBall(page);
  await openPickerFromMenu(page);

  // 焦点落在哪：工具条控件报 data-act（输入框报 input），别的报标签名（BODY、A…）。
  const focused = () => page.evaluate((root) => {
    const el = document.activeElement;
    if (!el || !el.closest(root)) return el ? el.tagName : null;
    return el.dataset.act || (el.classList.contains('ai-translator-picker-input') ? 'input' : el.tagName);
  }, PICKER);
  const walk = async (key, times) => {
    const seen = [];
    for (let i = 0; i < times; i += 1) {
      await page.keyboard.press(key);
      seen.push(await focused());
    }
    return seen;
  };

  // 还没点中：工具条上只有「取消」。焦点从页面上被 Tab 带进来，之后停在它身上。
  expect(await walk('Tab', 2)).toEqual(['cancel', 'cancel']);
  expect(await walk('Shift+Tab', 1)).toEqual(['cancel']);

  // 点中后焦点在输入框。Tab 走完一圈绕回来，Shift+Tab 反着绕，一步都不落到页面上。
  await pickWithPointer(page, page.locator('#lead'), 'focus lead');
  expect(await focused()).toBe('input');
  // 浅色主题下 Tab 回到输入框时看得出焦点在它身上：outline 或边框颜色和它没焦点时不一样。
  const input = page.locator(`${PICKER} .ai-translator-picker-input`);
  const look = () => input.evaluate((el) => {
    const style = getComputedStyle(el);
    return { outline: style.outlineStyle, border: style.borderTopColor };
  });
  expect(await page.evaluate(() => document.documentElement.getAttribute('data-ai-translator-theme'))).toBe('light');
  expect(await walk('Tab', 5)).toEqual(['parent', 'exclude', 'keepOriginal', 'include', 'cancel']);
  const idle = await look();
  expect(await walk('Tab', 1)).toEqual(['input']);
  const focusedLook = await look();
  expect(focusedLook.outline !== 'none' || focusedLook.border !== idle.border,
    `the focused input looks exactly like the idle one in the light theme: ${JSON.stringify(focusedLook)}`).toBe(true);
  expect(await walk('Tab', 1)).toEqual(['parent']);
  expect(await walk('Shift+Tab', 3)).toEqual(['input', 'cancel', 'include']);

  // 三个动作置灰时它们不在这一圈里。
  await input.fill('#no-such-element');
  await expectPickerMatches(page, 0);
  await input.focus();
  expect(await walk('Tab', 3)).toEqual(['parent', 'cancel', 'input']);

  // Esc 照旧关掉；关掉之后 Tab 还给页面。
  await page.keyboard.press('Escape');
  await expectPickerGone(page);
  expect(await walk('Tab', 1)).not.toEqual(['cancel']);
});

// ------------------------------------------------------------------ popup 入口

test('the popup button opens the picker on the page in front', async ({ context, extensionId }) => {
  await setExtensionSettings(await context.newPage(), settings('http://127.0.0.1:9'));
  await serve(context, { [`${RULES}/popup`]: J1_PAGE });
  const content = await context.newPage();
  await content.goto(`${RULES}/popup`);
  await waitForFloatBall(content);

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  // 对照：popup 自己的标签页在前面时，那一页没有内容脚本，按钮不露。
  await expect(popup.locator('#openSettings')).toBeVisible();
  await expect(popup.locator('#pickSiteRegion')).toBeHidden();

  // 把窗口还给夹具页，popup 再问一次：按钮露出来，文案是 pickSiteRegion。
  await content.bringToFront();
  await popup.reload();
  const button = popup.locator('#pickSiteRegion');
  await expect(button).toBeVisible();
  await expect(button).toHaveText(en('pickSiteRegion'));
  await button.click();

  await expect(content.locator(PICKER)).toHaveCount(1);
  await expect(content.locator(`${PICKER} .ai-translator-picker-bar`)).toBeVisible();
  await expect(content.locator(`${PICKER} .ai-translator-picker-hint`)).toHaveText(en('pickerHint'));
});

// ------------------------------------------------------------------ CSS 不安全

const UNSAFE = {
  lead: 'Bicycles travel free on every crossing outside the summer season.',
};

test('[fixture] picker: when this site\'s rule has unsafe CSS, saving says where to fix it and stores nothing', async ({ page, context }) => {
  // 前提（隔离子步骤）：本站胜出的那条规则带着不安全的 CSS。设置页存不进这种 CSS，
  // 只能由服务工作者直写（等于别的设备或手改的 sync 数据）。之后的每一步都是真实入口。
  await setExtensionSettings(page, settings('http://127.0.0.1:9'));
  await writeRule(context, 'unsafe', rule(['rules.test'], {
    keepOriginal: ['.brand'],
    css: 'body { background: url(http://127.0.0.1:9/leak) }',
  }));
  await serve(context, { [`${RULES}/bikes`]: html(`<p id="lead">${UNSAFE.lead}</p>`) });
  await page.goto(`${RULES}/bikes`);
  await waitForFloatBall(page);
  const before = await storedRules(context);

  await openPickerFromMenu(page);
  await pickWithPointer(page, page.locator('#lead'), 'unsafe lead');
  await pickerButton(page, 'exclude').click();

  // 一句能让用户动手的话，指到设置页；拾取器还开着，还锁着同一个目标；存储不变。
  const status = page.locator(`${PICKER} .ai-translator-picker-status`);
  await expect(status).toBeVisible();
  await expect(status).toHaveText(en('pickerCssUnsafe'));
  await expect(page.locator(`${PICKER} .ai-translator-picker-input`)).toHaveValue('#lead');
  await expect(pickerButton(page, 'exclude')).toBeEnabled();
  expect(await storedRules(context)).toEqual(before);
});
