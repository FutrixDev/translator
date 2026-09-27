// 用户站点规则（P1-B）：规则在已经打开的页面上生效（设计 §3.6、§6 J-3 的迟到区域、
// J-8、J-9、J-10）。
//
// 规则在设置页的卡片里建（多数是另一个标签页里的设置页，页面不刷新）。服务工作者
// 直写只有 J-8 的「另一台设备同步下来的删除」这一处，是设计点名的（见
// custom-rules-fixtures.js 文件头）。
const { test, expect } = require('./fixtures');
const {
  setExtensionSettings,
  triggerPageTranslation,
  waitForFloatBall,
  oursIn,
} = require('./helpers');
const { startMockOpenAIServer } = require('./mock-openai-server');
const {
  TRANSLATED,
  settings,
  html,
  serve,
  removeRules,
  clearTranslationCache,
  autoAiChars,
  sent,
  sendCount,
  withinOneSecond,
  translationOf,
  isTranslated,
  newOptionsTab,
  createRule,
} = require('./custom-rules-fixtures');

const RULES = 'https://rules.test';

// ------------------------------------------------------------------ J-3 迟到的区域

const LATE = {
  outside: 'The timetable office on the quay is open from eight in the morning until noon.',
  faqQ: 'Can passengers bring a dog on board the morning ferry to the island?',
};

const LATE_PAGE = html(`
  <div id="outside-box"><p id="outside">${LATE.outside}</p></div>
  <div id="slot"></div>`);

test('J-3 late include: when the included region renders late, the translations outside it are taken back within 1 s', async ({ page, context, extensionId }) => {
  const { close, endpoint, sentTexts } = await startMockOpenAIServer();
  try {
    await setExtensionSettings(page, settings(endpoint, {
      autoTranslate: true,
      autoTranslateEngine: 'ai',
      siteRules: { 'rules.test': 'always' },
    }));
    const options = await newOptionsTab(context, extensionId);
    await createRule(options, context, { match: ['rules.test/late'], include: ['.faq'] });
    await options.close();

    await serve(context, { [`${RULES}/late`]: LATE_PAGE });
    await page.goto(`${RULES}/late`);
    await waitForFloatBall(page);

    // 区域还没渲染：范围退回正文 / 整页，自动翻译把区域外的段落翻上。
    await expect(page.locator(translationOf('outside'))).toHaveText(`[T] ${LATE.outside}`, { timeout: 30000 });

    // 区域长出来：1 s 内区域外零节点，区域里出现译文，不刷新。
    // 「没翻」这里只断言 DOM 一半：区域外那段原文在区域出现之前确实送过，发送一半不适用。
    const t0 = Date.now();
    await page.evaluate((text) => {
      const box = document.createElement('div');
      box.className = 'faq';
      box.id = 'faq-box';
      box.innerHTML = `<p id="faq-q">${text}</p>`;
      document.getElementById('slot').appendChild(box);
    }, LATE.faqQ);
    await withinOneSecond(t0, async () => (await oursIn(page, 'outside-box')) === 0
      && isTranslated(page, 'faq-q'), 'J-3 late include swept');
    expect(sent(sentTexts, LATE.faqQ)).toBe(true);
  } finally {
    await close();
  }
});

// ------------------------------------------------------------------ J-8

const J8 = {
  keep: 'The ferry timetable changes twice a year, in April and again in October.',
  region: 'Readers can leave comments about the crossing in the discussion area below.',
};

const J8_PAGE = html(`
  <div id="keep-box"><p id="keep">${J8.keep}</p></div>
  <div id="region-box" class="comments"><p id="region">${J8.region}</p></div>`);

/**
 * 一轮：手动翻 → 另一个标签页的设置页加 exclude（1 s 内收回）→ 清两半缓存 → SW
 * 删规则（另一台设备同步下来的变化；1 s 内回来，原文恰好多发一次）。
 * byScheduler：这次重译必须是调度器收的，也就是记在自动翻译的用量里 —— 「恰好多
 * 发一次」分不出是调度器还是补翻轮收的（两条路收同一块）。
 */
async function excludeRoundTrip(page, options, context, sentTexts, label, { byScheduler = false } = {}) {
  await triggerPageTranslation(page);
  await expect(page.locator(translationOf('keep'))).toHaveText(`[T] ${J8.keep}`, { timeout: 30000 });
  await expect(page.locator(translationOf('region'))).toHaveText(`[T] ${J8.region}`, { timeout: 30000 });

  const { id, t0: saved } = await createRule(options, context, { match: ['rules.test'], exclude: ['.comments'] });
  await withinOneSecond(saved, async () => (await oursIn(page, 'region-box')) === 0, `${label} exclude added`);
  expect(await isTranslated(page, 'keep')).toBe(true);

  // 基线：清掉两半缓存之后再数一次原文发出去几次。不清的话，删规则后那一块直接
  // 从缓存里回来，「恰好一次」就没法断言。
  await clearTranslationCache(context);
  const before = sendCount(sentTexts, J8.region);
  const keepBefore = sendCount(sentTexts, J8.keep);
  const charsBefore = await autoAiChars(context);

  const t0 = Date.now();
  await removeRules(context, [id]);
  await withinOneSecond(t0, () => isTranslated(page, 'region'), `${label} exclude removed`);
  // 再等一会儿：确认没有第二条路径把同一块再送一次。
  await page.waitForTimeout(1500);
  expect(sendCount(sentTexts, J8.region)).toBe(before + 1);
  expect(sendCount(sentTexts, J8.keep)).toBe(keepBefore);
  if (byScheduler) {
    const delta = (await autoAiChars(context)) - charsBefore;
    console.log(`[J-8] ${label}: autoStats.autoAiChars +${delta}`);
    expect(delta).toBeGreaterThan(0);
  }
  await expect(page.locator(translationOf('region'))).toHaveCount(1);
  // 设置页那一头也跟着删除重画：列表里不再有这一条。
  await expect(options.locator(`.custom-rule[data-rule-id="${id}"]`)).toHaveCount(0);
}

test('J-8: an exclude added in Settings in another tab takes a translation back within 1 s, and a synced delete brings it back within 1 s', async ({ page, context, extensionId }) => {
  const { close, endpoint, sentTexts } = await startMockOpenAIServer();
  try {
    await serve(context, { [`${RULES}/ferry`]: J8_PAGE });

    // 自动翻译总开关关着：删规则后由 custom-rule.js 自己补的那一轮接回来。
    await setExtensionSettings(page, settings(endpoint, { autoTranslate: false }));
    await page.goto(`${RULES}/ferry`);
    await waitForFloatBall(page);
    const options = await newOptionsTab(context, extensionId);
    await excludeRoundTrip(page, options, context, sentTexts, 'J-8 autoTranslate off');

    // 总开关开着：手动翻译把本页交给调度器（markPageExplicit），删规则后由调度器
    // 重启接回来 —— 两条路不收同一批块，所以原文依旧恰好多发一次。
    await setExtensionSettings(page, settings(endpoint, { autoTranslate: true }));
    await page.goto(`${RULES}/ferry`);
    await waitForFloatBall(page);
    await excludeRoundTrip(page, options, context, sentTexts, 'J-8 autoTranslate on', { byScheduler: true });
  } finally {
    await close();
  }
});

// ------------------------------------------------------------------ J-9

const TOP = 'https://rules-top.test';
const NOTE = 'https://rules-note.test';
const J9 = {
  top: 'The museum reopens its maritime gallery to visitors on the first Saturday of May.',
  body: 'The embedded guide lists every ship model on display along with its year of launch.',
  more: 'Audio commentary for the gallery is available in six languages at the front desk.',
  side: 'Internal note for editors about image licensing which should never be shown translated.',
};

/** 顶层页面嵌一个另一主机的 iframe；两条 J-9 用同一对页面，只是协议不同。 */
function j9Pages(top, note) {
  return {
    [`${top}/museum`]: html(`
      <p id="top-lead">${J9.top}</p>
      <iframe id="note-frame" src="${note}/guide" width="640" height="260" style="border:0;display:block"></iframe>`),
    [`${note}/guide`]: html(`
      <p id="guide-body">${J9.body}</p>
      <div id="side-box" class="side-note"><p id="side">${J9.side}</p></div>
      <p id="guide-more">${J9.more}</p>`),
  };
}

/** J-9 的两条规则，都在设置页建：iframe 主机排除 .side-note，顶层主机钉 AI。 */
async function saveJ9Rules(context, extensionId) {
  const options = await newOptionsTab(context, extensionId);
  await createRule(options, context, { match: ['rules-note.test'], exclude: ['.side-note'] });
  await createRule(options, context, { match: ['rules-top.test'] }, { engineAi: true });
  await options.close();
}

test('J-9 manual: an iframe follows its own host rule for regions', async ({ page, context, extensionId }) => {
  const { close, endpoint, sentTexts } = await startMockOpenAIServer();
  try {
    // 这一条不证明 iframe 继承了顶层钉住的引擎：手动路径上，子 frame 的翻译请求转给
    // 顶层、用顶层自己的引擎，继承与否结果都一样；https 页面上 e2e Chromium 的
    // Translator 也在，内置引擎算「可用」，也区分不出来。它证明的是 iframe 主机自己
    // 的区域规则。继承由下面那条 http 自动模式的用例证明。
    await setExtensionSettings(page, settings(endpoint, {
      translationEngine: 'builtin',
      autoTranslateEngine: 'builtin',
    }));
    await saveJ9Rules(context, extensionId);
    await serve(context, j9Pages(TOP, NOTE));
    await page.bringToFront();
    await page.goto(`${TOP}/museum`);
    await waitForFloatBall(page);
    const frame = page.frameLocator('#note-frame');
    await expect(frame.locator('#guide-body')).toBeVisible();

    await page.click('#ai-translator-float-ball', { position: { x: 18, y: 18 } });
    await expect(page.locator(translationOf('top-lead'))).toHaveText(`[T] ${J9.top}`, { timeout: 30000 });
    await expect(frame.locator(translationOf('guide-body'))).toHaveText(`[T] ${J9.body}`, { timeout: 30000 });
    await expect(frame.locator(translationOf('guide-more'))).toHaveText(`[T] ${J9.more}`, { timeout: 30000 });
    expect(sent(sentTexts, J9.body)).toBe(true);
    expect(sent(sentTexts, J9.more)).toBe(true);

    // iframe 自己主机的规则：.side-note 零节点、零发送。
    await page.waitForTimeout(1500);
    const noteFrame = page.frames().find((f) => f.url().startsWith(NOTE));
    expect(noteFrame, 'the rules-note.test frame').toBeTruthy();
    expect(await oursIn(noteFrame, 'side-box')).toBe(0);
    expect(sent(sentTexts, J9.side)).toBe(false);
  } finally {
    await close();
  }
});

const TOP_HTTP = 'http://rules-top.test';
const NOTE_HTTP = 'http://rules-note.test';

test('J-9 auto: on http an iframe translates with the engine the top host rule pins', async ({ page, context, extensionId }) => {
  const { close, endpoint, sentTexts } = await startMockOpenAIServer();
  try {
    // 自动模式、http：子 frame 自己的调度器先问自己的 effectiveEngine({ auto: true })
    // 再送块。两张开关都是内置、回退只许本地，http 页面没有 Translator —— 除了从顶层
    // 指令继承来的 'ai'，子 frame 没有可用的引擎。不点悬浮球。
    await setExtensionSettings(page, settings(endpoint, {
      translationEngine: 'builtin',
      autoTranslateEngine: 'builtin',
      engineFallback: 'local-only',
      autoTranslate: true,
      siteRules: { 'rules-top.test': 'always' },
    }));
    await saveJ9Rules(context, extensionId);
    await serve(context, j9Pages(TOP_HTTP, NOTE_HTTP));
    await page.bringToFront();
    await page.goto(`${TOP_HTTP}/museum`);
    await waitForFloatBall(page);
    const frame = page.frameLocator('#note-frame');
    await expect(frame.locator('#guide-body')).toBeVisible();

    // 前提：iframe 里内置引擎确实不可用。
    const noteFrame = page.frames().find((f) => f.url().startsWith(NOTE_HTTP));
    expect(noteFrame, 'the rules-note.test frame').toBeTruthy();
    expect(await noteFrame.evaluate(() => self.isSecureContext)).toBe(false);
    expect(await noteFrame.evaluate(() => typeof self.Translator)).toBe('undefined');

    await expect(page.locator(translationOf('top-lead'))).toHaveText(`[T] ${J9.top}`, { timeout: 30000 });
    await expect(frame.locator(translationOf('guide-body'))).toHaveText(`[T] ${J9.body}`, { timeout: 30000 });
    expect(sent(sentTexts, J9.body)).toBe(true);

    // iframe 主机自己的规则照样生效：.side-note 零节点、零发送。
    await page.waitForTimeout(1500);
    expect(await oursIn(noteFrame, 'side-box')).toBe(0);
    expect(sent(sentTexts, J9.side)).toBe(false);
  } finally {
    await close();
  }
});

// ------------------------------------------------------------------ J-10

const PLAIN = 'http://rules-plain.test';
const J10 = {
  lead: 'The lighthouse keeper recorded the weather at dawn and at dusk for forty years.',
  body: 'His notebooks are now kept in the county archive and can be read by appointment.',
};

const J10_PAGE = html(`
  <div id="lead-box"><p id="lead">${J10.lead}</p></div>
  <div id="body-box"><p id="body">${J10.body}</p></div>`);

test('J-10: on an http page with no usable engine, a rule pinning AI saved in Settings starts translation within 1 s', async ({ page, context, extensionId }) => {
  const { close, endpoint, sentTexts } = await startMockOpenAIServer();
  try {
    // 两张开关都是内置、回退只许本地、站点「总是」；http 页面不是安全上下文，内置
    // 引擎不可用 —— 于是没有引擎，页面保持原文，mock 零请求。
    await setExtensionSettings(page, settings(endpoint, {
      translationEngine: 'builtin',
      autoTranslateEngine: 'builtin',
      engineFallback: 'local-only',
      siteRules: { 'rules-plain.test': 'always' },
    }));
    await serve(context, { [`${PLAIN}/keeper`]: J10_PAGE });
    await page.goto(`${PLAIN}/keeper`);
    await waitForFloatBall(page);
    expect(await page.evaluate(() => window.isSecureContext)).toBe(false);

    // 探语言最多等 1.2 s，再过一轮攒批防抖；给到 4 s。
    await page.waitForTimeout(4000);
    await expect(page.locator(TRANSLATED)).toHaveCount(0);
    expect(await oursIn(page, 'lead-box')).toBe(0);
    expect(await oursIn(page, 'body-box')).toBe(0);
    expect(sentTexts).toEqual([]);

    // 另一个标签页的设置页：给这个主机建一条钉 AI 的规则，接受确认，点保存。
    // 1 s 内、不刷新，译文出现，mock 收到请求。
    const options = await newOptionsTab(context, extensionId);
    const { t0 } = await createRule(options, context, { match: ['rules-plain.test'] }, { engineAi: true });
    await withinOneSecond(t0, () => isTranslated(page, 'lead'), 'J-10 AI pinned');
    expect(sent(sentTexts, J10.lead)).toBe(true);
    await expect(page.locator(translationOf('body'))).toHaveText(`[T] ${J10.body}`, { timeout: 30000 });
    // 正向对照：停住期间那两条 oursIn 为 0，用的是叫醒后看得见译文的同一个查询。
    expect(await oursIn(page, 'lead-box')).toBeGreaterThan(0);
    expect(await oursIn(page, 'body-box')).toBeGreaterThan(0);
  } finally {
    await close();
  }
});
