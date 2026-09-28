// P1-C 词表 C1 的 C-J5（设计 docs/plans/2026-09-25-p1-c-glossary.md §6、需求第 16 行
// 「改词表不重译已显示的译文，新请求立刻用新词表」）：
//
//   一程：整页翻译（外加字幕自动译第一句），落盘；
//   二程：重新加载再翻，一个请求都不发 —— 持久缓存照常命中；
//   三程：划词悬停与字幕先各译一次（内存缓存建立），加一条命中的词条，
//         ctx.translationProfile.generation() 加一；同一页上悬停、字幕、再点一次
//         整页翻译都发新请求并带上词条，不从旧的内存缓存里拿。没命中词条的段落
//         照旧命中持久缓存，不重发。
//
// 字幕夹具：和 video-caption-translation.spec.js 同一个做法 —— 一个没有媒体源的
// <video> 加一条同源 <track>（context.route 供 VTT），不播放，播放头靠改
// currentTime 并派发 timeupdate 推。请求走 mock-openai-server.js，而不是那份
// spec 拦 api.openai.com 的写法：这里要读每次请求的系统提示词。
//
// 加词条（二程之后那一步）在另开的设置页标签里、术语表卡片上点选完成
// （addGlossaryEntryInCard），页面这一张不刷新。标题仍带 [fixture]：设计 §6.1 把
// 第 3 步的「字幕同一句」标为夹具 —— 播放头靠改 currentTime、派发 timeupdate 推，
// 不是用户播放。
const { test, expect } = require('./fixtures');
const {
  addGlossaryEntryInCard,
  countPersistentCacheKeys,
  evaluateInContentScript,
  openGlossaryCard,
  sentSegments,
  setExtensionSettings,
  waitForContentReady,
} = require('./helpers');
const { startMockOpenAIServer } = require('./mock-openai-server');

const ORIGIN = 'https://glossary-video.test';

const ATTENTION_LINE = '- "attention" → "注意力"';

const HIT_TEXT = 'Self attention lets every token look at every other token in the sequence.';
const PLAIN_TEXT = 'The weather on the northern coast was calm for the whole of the afternoon.';
const HOVER_TEXT = 'Paying attention to the order of the words is what the model learns first.';
const CUE_TEXT = 'Everyone paid attention to the speaker.';

const VTT = `WEBVTT

00:00:00.000 --> 00:00:04.000
${CUE_TEXT}
`;

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Glossary lecture</title><style>
  body { margin: 0; }
  video { width: 640px; height: 360px; background: #123; display: block; }
</style></head><body>
  <video id="v" width="640" height="360">
    <track id="t" default kind="subtitles" srclang="en" label="English" src="/subs.vtt">
  </video>
  <p id="hit">${HIT_TEXT}</p>
  <p id="plain">${PLAIN_TEXT}</p>
  <p id="hover">${HOVER_TEXT}</p>
</body></html>`;

async function serve(context) {
  await context.route(`${ORIGIN}/page.html`, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: PAGE }));
  await context.route(`${ORIGIN}/subs.vtt`, (route) => route.fulfill({ status: 200, contentType: 'text/vtt', body: VTT }));
}

async function clickFloatBall(page) {
  await waitForContentReady(page);
  await page.click('#ai-translator-float-ball', { position: { x: 18, y: 18 } });
}

function translationOf(page, id) {
  return page.locator(`#${id} + .ai-translator-inline-block`);
}

async function translatePage(page) {
  await clickFloatBall(page);
  for (const id of ['hit', 'plain', 'hover']) {
    await expect(translationOf(page, id)).toContainText('[T]');
  }
  await page.waitForSelector('#ai-translator-progress', { state: 'hidden', timeout: 30000 });
}

/** 把播放头放进第一句字幕。 */
async function seekIntoFirstCue(page) {
  await page.evaluate(() => {
    const video = document.querySelector('video');
    video.currentTime = 1;
    video.dispatchEvent(new Event('timeupdate'));
  });
}

const overlay = (page) => page.locator('#ai-translator-caption-overlay');
const hoverTranslation = (page) => page.locator('#hover + .ai-translator-hover-translation');

/** 指着 #hover 单按一下 Shift：没有译文时译出来，有译文时收起（runHoverHotkey）。 */
async function pressHoverHotkey(page, { expectShown }) {
  await page.locator('#hover').hover();
  await page.keyboard.press('Shift');
  await page.waitForSelector('#hover + .ai-translator-hover-translation', {
    state: expectShown ? 'attached' : 'detached',
  });
}

const generation = (context, page) => evaluateInContentScript(context, page,
  'window.AI_TRANSLATOR_CONTENT.translationProfile.generation()');

test.describe('P1-C glossary and the translation caches', () => {
  let mock;

  test.beforeEach(async () => {
    mock = await startMockOpenAIServer();
  });

  test.afterEach(async () => {
    await mock.close();
  });

  // 夹具隔离子步骤：字幕的播放头由脚本推（设计 §6.1 第 3 步的 [fixture]）
  test('[fixture] C-J5 a glossary change leaves the persistent cache alone and makes hover, captions and the page ask again', async ({ page, context, extensionId }) => {
    await serve(context);
    await setExtensionSettings(page, {
      apiEndpoint: mock.endpoint,
      apiKey: 'test-key',
      modelName: 'gpt-4.1-mini',
      targetLang: 'zh-CN',
      skipTargetLanguageText: false,
      // 就绪信号（设计 §6）：内容脚本读完设置就把它写到 <html>，见 waitForContentReady。
      translationStyle: 'underline',
    });

    // 一程：整页 + 字幕第一句，全部送出、全部落盘。
    await page.goto(`${ORIGIN}/page.html`);
    await waitForContentReady(page);
    await seekIntoFirstCue(page);
    await expect(overlay(page)).toContainText('[T]');
    await translatePage(page);
    expect(mock.sentTexts.length).toBeGreaterThan(0);
    // 落盘 = 送出去的每一段（三段正文加一句字幕）都有了自己的 tc: 键。
    const persisted = new Set(sentSegments(mock.sentTexts, mock.fastBatchRequests)).size;
    expect(persisted).toBe(4);
    await expect.poll(() => countPersistentCacheKeys(context)).toBe(persisted);

    // 二程：同一页再来一遍，一个请求都不发。
    const afterFirst = mock.sentTexts.length;
    await page.reload();
    await waitForContentReady(page);
    await seekIntoFirstCue(page);
    await expect(overlay(page)).toContainText('[T]');
    await translatePage(page);
    expect(mock.sentTexts.length).toBe(afterFirst);

    // 三程要一张没整页翻过的页：悬停翻译不接已经整页翻过的块（hover/blocks.js 的
    // isValidBlock 认 ai-translator-translated）。
    await page.reload();
    await waitForContentReady(page);
    await seekIntoFirstCue(page);
    await expect(overlay(page)).toContainText('[T]');
    expect(mock.sentTexts.length).toBe(afterFirst);

    // 悬停先译一次（没有词条：请求不带 GLOSSARY），收起，再按一次从内存缓存里
    // 拿回来（不发请求），再收起。
    await pressHoverHotkey(page, { expectShown: true });
    await expect(hoverTranslation(page)).toContainText('[T]');
    const hoverFirst = mock.sentTexts.slice(afterFirst).map((text, k) => ({ text, prompt: mock.systemPrompts[afterFirst + k] }));
    expect(hoverFirst).toHaveLength(1);
    expect(hoverFirst[0].text).toContain(HOVER_TEXT);
    expect(hoverFirst[0].prompt).not.toContain('GLOSSARY');
    await pressHoverHotkey(page, { expectShown: false });
    await pressHoverHotkey(page, { expectShown: true });
    await pressHoverHotkey(page, { expectShown: false });
    const beforeEntry = mock.sentTexts.length;
    expect(beforeEntry).toBe(afterFirst + 1);

    // 2. 不刷新，另开设置页、在术语表卡片上加一条命中的词条：顶层的代数加一。
    const g0 = await generation(context, page);
    const options = await openGlossaryCard(await context.newPage(), extensionId);
    const added = await addGlossaryEntryInCard(options, context, { s: 'attention', t: '注意力' });
    expect(added.stored).toEqual({ s: 'attention', t: '注意力', l: '*', u: expect.any(Number) });
    await options.close();
    await page.bringToFront();
    await expect.poll(() => generation(context, page)).toBe(g0 + 1);
    // 页面上已经显示的字幕不重译：没有新请求（没人推播放头之前）。
    expect(mock.sentTexts.length).toBe(beforeEntry);

    const since = (from) => mock.sentTexts.slice(from)
      .map((text, k) => ({ text, prompt: mock.systemPrompts[from + k] }));

    // 悬停：同一块、同一段文字，这次发新请求，带着词条。
    await pressHoverHotkey(page, { expectShown: true });
    await expect(hoverTranslation(page)).toContainText('[T]');
    const hoverSecond = since(beforeEntry);
    expect(hoverSecond).toHaveLength(1);
    expect(hoverSecond[0].text).toContain(HOVER_TEXT);
    expect(hoverSecond[0].prompt).toContain(ATTENTION_LINE);

    // 字幕：同一句，下一次触发（节流 2 s）发新请求，带着词条。每一轮都派发一次
    // timeupdate，直到它发出去。
    const beforeCaption = mock.sentTexts.length;
    await expect.poll(async () => {
      await seekIntoFirstCue(page);
      return since(beforeCaption).filter((r) => r.text.includes(CUE_TEXT)).length;
    }, { timeout: 15000 }).toBeGreaterThan(0);
    for (const r of since(beforeCaption).filter((each) => each.text.includes(CUE_TEXT))) {
      expect(r.prompt).toContain(ATTENTION_LINE);
    }
    await expect(overlay(page)).toContainText('[T]');

    // 整页：命中的段重发并带词条；没命中的段照旧从持久缓存来，不重发。
    const beforePage = mock.sentTexts.length;
    await clickFloatBall(page);
    await expect(translationOf(page, 'hit')).toContainText('[T]');
    await expect(translationOf(page, 'plain')).toContainText('[T]');
    await page.waitForSelector('#ai-translator-progress', { state: 'hidden', timeout: 30000 });
    const pageRequests = since(beforePage);
    const segments = sentSegments(pageRequests.map((r) => r.text), mock.fastBatchRequests);
    expect(segments.some((segment) => segment.includes(HIT_TEXT))).toBe(true);
    expect(segments.some((segment) => segment.includes(PLAIN_TEXT))).toBe(false);
    for (const r of pageRequests.filter((each) => each.text.includes(HIT_TEXT))) {
      expect(r.prompt).toContain(ATTENTION_LINE);
    }
  });
});
