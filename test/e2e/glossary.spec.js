// P1-C 词表的旅程（设计 docs/plans/2026-09-25-p1-c-glossary.md §6）：
// C-J1 AI 提示词带词表、C-J2 站点词条压过全局且别站词条不送、C-J3 内置引擎的
// 占位保护与丢占位后重译、C-J8 跨源子 frame 经顶层取词表。C-J5（改词表后的缓存
// 与 generation）在 glossary-cache.spec.js。
//
// 页面全部由 context.route 供给；AI 走 mock-openai-server.js。「翻了」= 译文节点
// 里有 `[T] `（内置引擎的替身是 `[B] `）；「没送」= 不在 sentTexts / systemPrompts 里。
//
// 加词条：C-J1、C-J2 在设置页的术语表卡片上点选（addGlossaryEntryInCard），是
// 旅程步骤本身。C-J3、C-J8 的词条只是铺设，标 [fixture]：从设置页发生产写入消息
// GLOSSARY_WRITE（addGlossaryEntry），经服务工作者的单写者队列落到
// storage.sync —— 不直接往存储里写词条键。
const { test, expect } = require('./fixtures');
const {
  addGlossaryEntry,
  addGlossaryEntryInCard,
  countPersistentCacheKeys,
  evaluateInContentScript,
  openGlossaryCard,
  sentSegments,
  setExtensionSettings,
  stubBuiltinTranslator,
  waitForContentReady,
} = require('./helpers');
const { startMockOpenAIServer } = require('./mock-openai-server');

const SITE = 'https://glossary.test';
const EMBED = 'https://glossary-embed.test';

const HEADING = 'GLOSSARY (user-defined; overrides any general rule about keeping terms in their original form):';
const ATTENTION_LINE = '- "attention" → "注意力"';

// 正文里只有首字母大写的 "Attention"，词条是小写的 attention：不含大写的原文
// 不分大小写匹配（设计 §2.2），这一段命中才算数。
const HIT_TEXT = 'Attention is all you need, so every token looks at every other token in the sequence.';
const PLAIN_TEXT = 'The weather on the northern coast was calm for the whole of the afternoon.';
const FERRY_TEXT = 'The ferry and the attention of its crew kept everyone safe on the crossing.';
const TERM_TEXT = 'The Transformer architecture changed how machine translation systems are built.';
const EMBED_TEXT = 'Readers in the comment box paid close attention to the timetable change.';

const html = (body) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Glossary notes</title></head>
<body>${body}</body></html>`;

const FRAME_ATTRS = 'width="640" height="220" style="border:0;display:block"';

// C-J1：命中段在最上面（首屏优先批），隔 4000px 之后才是不命中的段 —— 视口外
// 的块单独成批（content/page/batch.js 的 splitBlocksByViewport），于是一定有一批
// 一个词条都不命中，它的请求不该带 GLOSSARY 块。
const PAGES = {
  [`${SITE}/split`]: html(`
    <p id="hit">${HIT_TEXT}</p>
    <div style="height:4000px"></div>
    <p id="plain">${PLAIN_TEXT}</p>`),
  [`${SITE}/ferry`]: html(`<p id="ferry">${FERRY_TEXT}</p>`),
  [`${SITE}/term`]: html(`<p id="term">${TERM_TEXT}</p>`),
  [`${SITE}/framed`]: html(`
    <p id="plain">${PLAIN_TEXT}</p>
    <iframe id="embed" src="${EMBED}/comments" ${FRAME_ATTRS}></iframe>`),
  [`${EMBED}/comments`]: html(`<p id="embed-lead">${EMBED_TEXT}</p>`),
};

async function serve(context) {
  for (const origin of [SITE, EMBED]) {
    await context.route(`${origin}/**`, (route) => {
      const body = PAGES[route.request().url().split(/[?#]/)[0]];
      if (!body) return route.fulfill({ status: 404, body: 'not found' });
      return route.fulfill({ status: 200, contentType: 'text/html', body });
    });
  }
}

function settings(endpoint, extra) {
  return {
    apiEndpoint: endpoint,
    apiKey: 'test-key',
    modelName: 'gpt-4.1-mini',
    targetLang: 'zh-CN',
    skipTargetLanguageText: false,
    // 就绪信号（设计 §6）：内容脚本读完设置就把它写到 <html>，见 waitForContentReady。
    translationStyle: 'underline',
    ...extra,
  };
}

async function clickFloatBall(page) {
  await waitForContentReady(page);
  await page.click('#ai-translator-float-ball', { position: { x: 18, y: 18 } });
}

async function waitRoundDone(page) {
  await page.waitForSelector('#ai-translator-progress', { state: 'hidden', timeout: 30000 });
}

function translationOf(target, id) {
  return target.locator(`#${id} + .ai-translator-inline-block`);
}

/** 第 i 次请求的原文和系统提示词。 */
function requests(mock) {
  return mock.sentTexts.map((text, i) => ({ text, prompt: mock.systemPrompts[i] }));
}

test.describe('P1-C glossary journeys', () => {
  let mock;

  test.beforeEach(async () => {
    mock = await startMockOpenAIServer();
  });

  test.afterEach(async () => {
    await mock.close();
  });

  test('C-J1 a batch that hits the glossary carries it in the system prompt, a batch that does not carries none', async ({ page, context, extensionId }) => {
    await serve(context);
    await setExtensionSettings(page, settings(mock.endpoint));
    // 1. 设置页卡片「添加词条」：attention → 注意力，所有网站，zh-CN。列表出现这一
    // 条，用量变成 1 / 300。
    const options = await openGlossaryCard(await context.newPage(), extensionId);
    await expect(options.locator('#glossaryUsage')).toContainText('· 0 / 300');
    const added = await addGlossaryEntryInCard(options, context, { s: 'attention', t: '注意力', l: 'zh-CN' });
    expect(added.stored).toEqual({ s: 'attention', t: '注意力', l: 'zh-CN', u: expect.any(Number) });
    const rows = options.locator('#glossaryList .glossary-entry');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toHaveAttribute('data-entry-id', added.id);
    await expect(rows.first().locator('.glossary-source')).toHaveText('attention');
    await expect(rows.first().locator('.glossary-target')).toHaveText('注意力');
    await expect(options.locator('#glossaryUsage')).toContainText('· 1 / 300');
    await options.close();

    await page.goto(`${SITE}/split`);
    await clickFloatBall(page);
    await expect(translationOf(page, 'hit')).toContainText('[T]');
    await expect(translationOf(page, 'plain')).toContainText('[T]');
    await waitRoundDone(page);

    const sent = requests(mock);
    const hits = sent.filter((r) => /attention/i.test(r.text));
    const misses = sent.filter((r) => !/attention/i.test(r.text));
    expect(hits.length).toBeGreaterThan(0);
    expect(misses.length).toBeGreaterThan(0);
    for (const r of hits) {
      expect(r.prompt).toContain(HEADING);
      expect(r.prompt).toContain(ATTENTION_LINE);
    }
    for (const r of misses) {
      expect(r.prompt).not.toContain('GLOSSARY');
    }
  });

  test('C-J2 a site entry beats a newer global entry with the same source, and another site\'s entry is never sent', async ({ page, context, extensionId }) => {
    await serve(context);
    await setExtensionSettings(page, settings(mock.endpoint));
    // 1–2. 都在设置页卡片上加。先加站点词条、再加全局词条：全局那条更新（u 更大）。
    // 排序若不先看主机，赢的就是它。
    const options = await openGlossaryCard(await context.newPage(), extensionId);
    const site = await addGlossaryEntryInCard(options, context, { s: 'attention', t: '注意力', h: 'glossary.test' });
    const global = await addGlossaryEntryInCard(options, context, { s: 'attention', t: '关注' });
    const other = await addGlossaryEntryInCard(options, context, { s: 'ferry', t: '渡轮', h: 'other.test' });
    expect(site.stored).toEqual({ s: 'attention', t: '注意力', h: 'glossary.test', l: '*', u: expect.any(Number) });
    expect(global.stored).toEqual({ s: 'attention', t: '关注', l: '*', u: expect.any(Number) });
    expect(other.stored).toEqual({ s: 'ferry', t: '渡轮', h: 'other.test', l: '*', u: expect.any(Number) });
    expect(global.stored.u).toBeGreaterThan(site.stored.u);
    await expect(options.locator('#glossaryList .glossary-entry')).toHaveCount(3);
    await expect(options.locator('#glossaryUsage')).toContainText('· 3 / 300');
    await options.close();

    await page.goto(`${SITE}/ferry`);
    await clickFloatBall(page);
    await expect(translationOf(page, 'ferry')).toContainText('[T]');
    await waitRoundDone(page);

    const sent = requests(mock).filter((r) => r.text.includes('ferry'));
    expect(sent.length).toBeGreaterThan(0);
    for (const r of sent) {
      expect(r.prompt).toContain(HEADING);
      expect(r.prompt).toContain(ATTENTION_LINE);
      expect(r.prompt).not.toContain('"关注"');
      // 原文里有 ferry，可那条词条属于 other.test：一个字都不该出现在提示词里。
      expect(r.prompt).not.toContain('"ferry"');
      expect(r.prompt).not.toContain('渡轮');
    }
  });

  // 夹具隔离子步骤：加词条是铺设，不是这条旅程的步骤（设计 §6.1），走 addGlossaryEntry
  test('[fixture] C-J3 the built-in engine gets the term as a placeholder, and a dropped placeholder is retried once without the glossary', async ({ page, context, extensionId }) => {
    await serve(context);
    await setExtensionSettings(page, settings(mock.endpoint, {
      translationEngine: 'builtin',
      autoTranslateEngine: 'builtin',
    }));
    const added = await addGlossaryEntry(context, extensionId, { s: 'Transformer' });
    expect(added.stored.t).toBeUndefined();

    const warnings = [];
    context.on('console', (msg) => {
      if (msg.type() === 'warning' && msg.text().startsWith('Blab Translation: builtin translator dropped glossary placeholders')) {
        warnings.push(msg.text());
      }
    });

    // 第一程：替身照常作答。送进引擎的是占位符，页面上换回原样的词。
    await page.goto(`${SITE}/term`);
    await waitForContentReady(page);
    await stubBuiltinTranslator(page);
    await clickFloatBall(page);
    await expect(translationOf(page, 'term')).toContainText('[B]');
    await expect(translationOf(page, 'term')).toContainText('Transformer');
    await waitRoundDone(page);
    // 引擎收到的恰好是这一段、词条被占住，前后没有任何附加说明。
    const firstTexts = await evaluateInContentScript(context, page, 'self.__builtinTexts');
    expect(firstTexts).toEqual([TERM_TEXT.replace('Transformer', '{{1}}')]);
    expect(mock.sentTexts).toEqual([]);
    expect(warnings).toEqual([]);

    // 第二程（重新加载，计数器归零）：替身吃掉占位符。一条警告、一次不带词表的
    // 重译，页面照样有译文。
    await page.reload();
    await waitForContentReady(page);
    await stubBuiltinTranslator(page, { dropPlaceholders: true });
    await clickFloatBall(page);
    await expect(translationOf(page, 'term')).toContainText('[B]');
    await expect(translationOf(page, 'term')).toContainText('Transformer');
    await waitRoundDone(page);
    // 先是带占位的那一次，再是原样、不带词表的那一次重译，此外什么都没有。
    const secondTexts = await evaluateInContentScript(context, page, 'self.__builtinTexts');
    expect(secondTexts).toEqual([TERM_TEXT.replace('Transformer', '{{1}}'), TERM_TEXT]);
    // 「丢了一次、只重译一次」钉在上面那条精确序列和下面的 placeholderLosses 上：
    // 多一次重译，序列就多一项；多丢一次，计数就是 2。控制台警告异步到达，这里
    // 只等到它出现一次 —— 它证明的是「丢占位会警告」，不负责数次数：迟到的第二条
    // 警告在 poll 返回之后才到的话，这一行看不见它。
    await expect.poll(() => warnings.length).toBe(1);
    const stats = await evaluateInContentScript(context, page,
      'window.AI_TRANSLATOR_CONTENT.engine.glossary.stats()');
    expect(stats.placeholderLosses).toBe(1);
    expect(stats.protectedSegments).toBe(1);
    expect(mock.sentTexts).toEqual([]);
  });

  // 夹具隔离子步骤：加词条是铺设，不是这条旅程的步骤（设计 §6.1），走 addGlossaryEntry
  test('[fixture] C-J8 a cross-origin frame is translated with the top frame\'s glossary and cache', async ({ page, context, extensionId }) => {
    await serve(context);
    await setExtensionSettings(page, settings(mock.endpoint));
    await addGlossaryEntry(context, extensionId, { s: 'attention', t: '注意力' });

    await page.goto(`${SITE}/framed`);
    await clickFloatBall(page);
    const frame = page.frames().find((f) => f.url().startsWith(EMBED));
    expect(frame).toBeTruthy();
    await expect(translationOf(frame, 'embed-lead')).toContainText('[T]');
    await expect(translationOf(page, 'plain')).toContainText('[T]');
    await waitRoundDone(page);

    const embedded = requests(mock).filter((r) => r.text.includes('comment box'));
    expect(embedded.length).toBeGreaterThan(0);
    for (const r of embedded) {
      expect(r.prompt).toContain(HEADING);
      expect(r.prompt).toContain(ATTENTION_LINE);
    }
    // 子 frame 自己没有词表镜像：词表只在顶层。
    expect(await evaluateInContentScript(context, frame,
      'window.AI_TRANSLATOR_CONTENT.glossary.entries().length')).toBe(0);

    // 缓存也在顶层：落盘之后重新加载、再翻一次，一个请求都不发（子 frame 的
    // 查询走 via 'cached'）。落盘 = 送出去的每一段都有了自己的 tc: 键。
    const persisted = new Set(sentSegments(mock.sentTexts, mock.fastBatchRequests)).size;
    await expect.poll(() => countPersistentCacheKeys(context)).toBe(persisted);
    const before = mock.sentTexts.length;
    await page.reload();
    await clickFloatBall(page);
    const again = page.frames().find((f) => f.url().startsWith(EMBED));
    await expect(translationOf(again, 'embed-lead')).toContainText('[T]');
    await expect(translationOf(page, 'plain')).toContainText('[T]');
    await waitRoundDone(page);
    expect(mock.sentTexts.length).toBe(before);
  });
});
