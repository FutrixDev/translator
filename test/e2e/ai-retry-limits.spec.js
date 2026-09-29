// P1-D 批次 D2 的端到端旅程：超时重试与限速（编号同设计
// docs/plans/2026-09-26-p1-d-engine-layer.md §7.1 与任务书 p1-d-d2 §4）：
//
//   D-J7   429 重试：前两次 429、Retry-After 1，卡片最终出译文，三次请求，间隔 ≥ 1 秒
//   D-J7b  429 要等 120 秒：超过 60 秒不等，一次请求就失败，卡片说出 120
//   D-J8   不可重试：401 只发一次，卡片说 Key 不对
//   D-J9   限速：设置页把并发设 1、每分钟 600，整页翻译时在途最多 1 个；对照：不限时 > 1
//   D-J10  失败段落原地重试：一批失败只标那几段；点标记（鼠标 / Tab+Enter）只重发那一段；
//          标记和译文一起藏、一起回来
//   D-J11  只剩失败：所有批次失败，发出去的段落都是标记，整页报错照旧，悬浮球仍是「翻译」
//   D-J12  自动翻译的第二次机会：第一次失败不放标记，第二次失败才放
//
// 假主机全部由 context.route 供给，AI 全部是 test/e2e/mock-openai-server.js。
// 划词走真实的拖选和选区图标、卡片；整页翻译走悬浮球。
const { test, expect } = require('./fixtures');
const {
  setExtensionSettings,
  getDefaultProfile,
  getServiceWorker,
  openFloatBallMenu,
  waitForFloatBall,
} = require('./helpers');
const { startMockOpenAIServer } = require('./mock-openai-server');
const { getMessage } = require('../../i18n/messages');

const en = (key) => getMessage(key, 'en');
const optionsUrl = (extensionId) => `chrome-extension://${extensionId}/options/options.html`;

const ORIGIN = 'https://retry.test';
const LEAD = 'The harbour master posts the tide table every Friday morning before the ferry leaves.';
const PARAGRAPHS = Array.from({ length: 100 }, (_, i) =>
  `Paragraph ${i + 1} of the harbour log notes the wind, the tide and the ferries that left on time.`);

const html = (body) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Harbour log</title>
<style>body { font: 16px/1.5 sans-serif; margin: 24px; max-width: 760px; }</style></head>
<body>${body}</body></html>`;

// D-J10：前两段在首屏，三段「Broken buoy」在 3000px 的空白之后。整页翻译按视口
// 分成「优先」和「延后」两组各自成批（content/page/batch.js 的
// splitBlocksByViewport），于是三段坏的自成一批，失败只落在它们身上。
// #card 和 document 上的计数器是宿主页面自己的点击 / 按键处理：标记上的交互一次
// 也不该走到它们。
const BROKEN = ['Broken buoy one drifted past the harbour mouth during the night.',
  'Broken buoy two was found tangled in the nets of a trawler at dawn.',
  'Broken buoy three still blinks its light somewhere beyond the reef.'];
const BROKEN_PAGE = html(`
<p id="a">Alpha: the lighthouse keeper logs every passing ship before dawn.</p>
<p id="b">Bravo: the pilot boat waits at the breakwater until the tide turns.</p>
<div style="height:3000px"></div>
<div id="card"><p id="t1">${BROKEN[0]}</p></div>
<p id="t2" tabindex="-1">${BROKEN[1]}</p>
<p id="t3">${BROKEN[2]}</p>
<script>
  window.hostEvents = { click: 0, mousedown: 0, enter: 0 };
  const card = document.getElementById('card');
  card.addEventListener('click', () => { window.hostEvents.click += 1; });
  card.addEventListener('mousedown', () => { window.hostEvents.mousedown += 1; });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') window.hostEvents.enter += 1;
  });
</script>`);

// D-J11：130 个列表项，首屏内外各六十来个，按每批 40 项切成四批 —— 超过
// MAX_BATCH_FAILURES（3），整页报错。页面是深色的：标记的字色跟正文走，对比度
// 在这里量。
const LIST_ITEMS = Array.from({ length: 130 }, (_, i) =>
  `List item ${i + 1}: the ferry to the outer island leaves at dawn and returns by noon.`);
const LIST_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Ferry list</title>
<style>html, body { background: #16181d; color: #e6e6e6; }
body { font: 16px/1.5 sans-serif; margin: 24px; max-width: 760px; }</style></head>
<body><ul>${LIST_ITEMS.map((text, i) => `<li id="li${i + 1}">${text}</li>`).join('\n')}</ul></body></html>`;

// D-J12：自动翻译，一页一段。
const FLAKY_ONCE = 'Flaky pier one: the planks were replaced after the winter storms.';
const FLAKY_TWICE = 'Flaky pier two: the lamp at its end has not been lit this season.';

const PAGES = {
  '/': html(`<p id="lead">${LEAD}</p>`),
  '/log': html(PARAGRAPHS.map((text, i) => `<p id="p${i + 1}">${text}</p>`).join('\n')),
  '/broken': BROKEN_PAGE,
  '/list': LIST_PAGE,
  '/auto-once': html(`<p id="flaky">${FLAKY_ONCE}</p>`),
  '/auto-twice': html(`<p id="flaky">${FLAKY_TWICE}</p>`),
};

async function serve(context) {
  await context.route(`${ORIGIN}/**`, (route) => {
    const body = PAGES[new URL(route.request().url()).pathname];
    if (!body) return route.fulfill({ status: 404, body: 'not found' });
    return route.fulfill({ status: 200, contentType: 'text/html', body });
  });
}

function aiSettings(endpoint) {
  return {
    provider: 'custom',
    apiEndpoint: endpoint,
    apiKey: 'e2e-retry-placeholder',
    modelName: 'gpt-4.1-mini',
    targetLang: 'zh-CN',
    skipTargetLanguageText: false,
    enableSelection: true,
    selectionTranslationMode: 'popup',
  };
}

const icon = (page) => page.locator('#ai-translator-selection-btn .ai-translator-selection-icon');
const cardText = (page) => page.locator('.ai-translator-popup .ai-translator-translation-text');
const cardError = (page) => page.locator('.ai-translator-popup .ai-translator-error');

/** 拖选 #lead 的整行，点选区图标，卡片打开。 */
async function selectLeadAndOpenCard(page) {
  await page.goto(`${ORIGIN}/`);
  await waitForFloatBall(page);
  const box = await page.locator('#lead').boundingBox();
  await page.mouse.move(box.x + 2, box.y + 12);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 2, box.y + 12, { steps: 12 });
  await page.mouse.up();
  await icon(page).click();
}

/** 点球本身：单击球是「翻译 / 还原」。 */
async function clickFloatBall(page) {
  await waitForFloatBall(page);
  await page.click('#ai-translator-float-ball', { position: { x: 18, y: 18 } });
}

/** 这一页上带 mock 译文（[T]）的译文块数。 */
function translatedCount(page) {
  return page.locator('.ai-translator-inline-block', { hasText: '[T]' }).count();
}

// ------------------------------------------------------------------ D-J7

test('D-J7 two 429s with Retry-After 1 are waited out: the card gets its translation on the third request', async ({ page, context }) => {
  const mock = await startMockOpenAIServer({ rateLimit: { count: 2, retryAfter: 1 } });
  try {
    await serve(context);
    await setExtensionSettings(page, aiSettings(mock.endpoint));
    await selectLeadAndOpenCard(page);

    await expect(cardText(page)).toContainText('[T]', { timeout: 20000 });
    await expect(cardError(page)).toBeHidden();
    // 「会自动重试」（aiProfileLimitsHint）的兑现：三次请求，每次都等够服务端说的 1 秒。
    expect(mock.requestTimes).toHaveLength(3);
    const gaps = [mock.requestTimes[1] - mock.requestTimes[0], mock.requestTimes[2] - mock.requestTimes[1]];
    console.log(`[D-J7] gaps ${gaps.join(' / ')} ms`);
    for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(1000);
  } finally {
    await mock.close();
  }
});

test('D-J7b a 429 that asks for 120 s is not waited for: one request, and the card names the 120 seconds', async ({ page, context }) => {
  const mock = await startMockOpenAIServer({ rateLimit: { count: 5, retryAfter: 120 } });
  try {
    await serve(context);
    await setExtensionSettings(page, aiSettings(mock.endpoint));
    await selectLeadAndOpenCard(page);

    const expected = en('apiErrorRateLimitedWait').replace('{seconds}', '120');
    await expect(cardError(page)).toHaveText(expected);
    await page.waitForTimeout(2500);
    expect(mock.requestTimes).toHaveLength(1);
  } finally {
    await mock.close();
  }
});

// ------------------------------------------------------------------ D-J8

test('D-J8 a 401 is not retried: one request, and the card says the key is wrong', async ({ page, context }) => {
  const mock = await startMockOpenAIServer({ status: 401 });
  try {
    await serve(context);
    await setExtensionSettings(page, aiSettings(mock.endpoint));
    await selectLeadAndOpenCard(page);

    await expect(cardError(page)).toContainText(en('apiErrorAuth'));
    // 重试的第一次退避是 1 秒（±20%）：等过它，确认没有第二次。
    await page.waitForTimeout(2500);
    expect(mock.requestTimes).toHaveLength(1);
  } finally {
    await mock.close();
  }
});

// ------------------------------------------------------------------ D-J9

/** 整页翻译 /log，等到 100 段都出译文。 */
async function translateLog(page) {
  await page.goto(`${ORIGIN}/log`);
  await clickFloatBall(page);
  await expect.poll(() => translatedCount(page), { timeout: 60000 }).toBe(PARAGRAPHS.length);
}

test('D-J9 concurrency 1 / 600 per minute set on the settings page: a whole-page translation never has two requests in flight', async ({ page, context, extensionId }) => {
  test.setTimeout(120000);
  const mock = await startMockOpenAIServer({ delayMs: 400 });
  try {
    await serve(context);
    await setExtensionSettings(page, aiSettings(mock.endpoint));

    // 设置页表单：并发 1、每分钟 600，离开格子就存。
    const options = await context.newPage();
    await options.goto(optionsUrl(extensionId));
    await expect(options.locator('#aiProfileConcurrency')).toHaveValue('0');
    await options.locator('#aiProfileConcurrency').fill('1');
    await options.locator('#aiProfileConcurrency').blur();
    await options.locator('#aiProfileRpm').fill('600');
    await options.locator('#aiProfileRpm').blur();
    await expect.poll(async () => {
      const profile = await getDefaultProfile(context);
      return profile && [profile.concurrency, profile.rpm];
    }).toEqual([1, 600]);
    await expect(options.locator('#aiProfileLimitsHint')).toHaveText(en('aiProfileLimitsHint'));
    await options.close();

    await translateLog(page);
    console.log(`[D-J9] ${mock.requestTimes.length} requests, max in flight ${mock.maxInFlight}`);
    expect(mock.requestTimes.length).toBeGreaterThan(1);
    expect(mock.maxInFlight).toBe(1);
  } finally {
    await mock.close();
  }
});

test('D-J9 [fixture] control: the same page with no limit has more than one request in flight', async ({ page, context }) => {
  // 对照：没有这一条，「最多 1 个」也可能只是因为这一页本来就串行。
  // 夹具只隔离了一件事：配置档保持缺省的不限（并发 0、每分钟 0）。
  test.setTimeout(120000);
  const mock = await startMockOpenAIServer({ delayMs: 400 });
  try {
    await serve(context);
    await setExtensionSettings(page, aiSettings(mock.endpoint));
    const profile = await getDefaultProfile(context);
    expect([profile.concurrency, profile.rpm]).toEqual([0, 0]);

    await translateLog(page);
    console.log(`[D-J9 control] ${mock.requestTimes.length} requests, max in flight ${mock.maxInFlight}`);
    expect(mock.maxInFlight).toBeGreaterThan(1);
  } finally {
    await mock.close();
  }
});

// ----------------------------------------------------------------- D-J10

/** 紧跟在 #id 后面的失败标记（标记放在原文元素之后，content/page/insert.js 的 placeFailureMarker）。 */
const markerAfter = (page, id) => page.locator(`#${id} + .ai-translator-failed`);
/** #id 那一段的译文（不是失败标记）。 */
const translationAfter = (page, id) =>
  page.locator(`#${id} + .ai-translator-inline-block:not(.ai-translator-failed)`);

test('D-J10 a failed batch marks only its own paragraphs; a click or Tab+Enter on a marker resends only that paragraph; markers hide and show with the translations', async ({ page, context }) => {
  test.setTimeout(120000);
  // failStatus 400：不可重试，service worker 不会把一次失败放大成三次请求，
  // 「只重发这一段」按请求数数得清。
  const mock = await startMockOpenAIServer({ failWhen: (text) => text.includes('Broken buoy'), failStatus: 400 });
  try {
    await serve(context);
    await setExtensionSettings(page, aiSettings(mock.endpoint));
    await page.goto(`${ORIGIN}/broken`);
    await clickFloatBall(page);

    // 首屏两段出译文；三段坏的各自一个标记，其余什么都不多。
    await expect(translationAfter(page, 'a')).toContainText('[T]', { timeout: 30000 });
    await expect(translationAfter(page, 'b')).toContainText('[T]');
    for (const id of ['t1', 't2', 't3']) {
      const marker = markerAfter(page, id);
      await expect(marker).toHaveText(en('translationFailedRetry'), { timeout: 30000 });
      await expect(marker).toHaveAttribute('role', 'button');
      await expect(marker).toHaveAttribute('tabindex', '0');
      await expect(marker).toHaveAttribute('title', /upstream refused this batch/);
      await expect(translationAfter(page, id)).toHaveCount(0);
    }
    await expect(page.locator('.ai-translator-failed')).toHaveCount(3);
    await expect(page.locator('#ai-translator-progress')).not.toHaveClass(/ai-translator-progress-error-state/);

    // 鼠标：mock 恢复正常，点 t1 的标记。只有 t1 被重发，卡片自己的点击处理一次都没跑。
    mock.setFailWhen(null);
    let before = mock.sentTexts.length;
    await markerAfter(page, 't1').click();
    await expect(translationAfter(page, 't1')).toContainText('[T]', { timeout: 20000 });
    await expect(markerAfter(page, 't1')).toHaveCount(0);
    let resent = mock.sentTexts.slice(before);
    expect(resent).toHaveLength(1);
    expect(resent[0]).toContain(BROKEN[0]);
    for (const other of [BROKEN[1], BROKEN[2], 'Alpha', 'Bravo']) expect(resent[0]).not.toContain(other);
    expect(await page.evaluate(() => ({ ...window.hostEvents }))).toMatchObject({ click: 0, mousedown: 0 });

    // 键盘：焦点放在 t2 上，Tab 到它的标记（有可见的焦点环），Enter。
    await page.locator('#t2').focus();
    await page.keyboard.press('Tab');
    const marker2 = markerAfter(page, 't2');
    await expect(marker2).toBeFocused();
    expect(await marker2.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid');
    before = mock.sentTexts.length;
    await page.keyboard.press('Enter');
    await expect(translationAfter(page, 't2')).toContainText('[T]', { timeout: 20000 });
    await expect(marker2).toHaveCount(0);
    resent = mock.sentTexts.slice(before);
    expect(resent).toHaveLength(1);
    expect(resent[0]).toContain(BROKEN[1]);
    for (const other of [BROKEN[0], BROKEN[2], 'Alpha', 'Bravo']) expect(resent[0]).not.toContain(other);
    expect(await page.evaluate(() => window.hostEvents.enter)).toBe(0);

    // 收起 / 展开：t3 仍是标记。收起时它和译文一起藏；展开时一起回来。
    // 展开就是再点一次「翻译」，没有译文的 t3 会被重新请求（今天的 translatePage
    // 本来如此）；让它照旧失败，于是回来的是一个新标记。
    mock.setFailWhen((text) => text.includes('Broken buoy'));
    await markerAfter(page, 't3').evaluate((el) => el.setAttribute('data-old', '1'));
    before = mock.sentTexts.length;
    await clickFloatBall(page);
    for (const id of ['a', 'b', 't1', 't2']) await expect(translationAfter(page, id)).toBeHidden();
    await expect(markerAfter(page, 't3')).toBeHidden();

    await clickFloatBall(page);
    for (const id of ['a', 'b', 't1', 't2']) await expect(translationAfter(page, id)).toBeVisible();
    await expect(page.locator('#t3 + .ai-translator-failed:not([data-old])')).toBeVisible({ timeout: 20000 });
    await expect(page.locator('.ai-translator-failed')).toHaveCount(1);
    for (const text of mock.sentTexts.slice(before)) {
      for (const other of [BROKEN[0], BROKEN[1], 'Alpha', 'Bravo']) expect(text).not.toContain(other);
    }
  } finally {
    await mock.close();
  }
});

// ----------------------------------------------------------------- D-J11

/** WCAG 2 相对亮度对比度，输入是 computed 的 rgb()/rgba() 串（前景的 alpha 先叠到背景上）。 */
function contrastRatio(foreground, background) {
  const parse = (value) => value.match(/[\d.]+/g).map(Number);
  const [br, bg, bb] = parse(background);
  const [fr, fg, fb, fa = 1] = parse(foreground);
  const blend = [fr * fa + br * (1 - fa), fg * fa + bg * (1 - fa), fb * fa + bb * (1 - fa)];
  const luminance = ([r, g, b]) => {
    const channel = (c) => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  };
  const [light, dark] = [luminance(blend), luminance([br, bg, bb])].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

test('D-J11 only failures left: every sent item is a marker, the page error is unchanged, and the float ball still says Translate', async ({ page, context }) => {
  test.setTimeout(120000);
  // 缺省 500：可重试，service worker 照常重试后才算失败 —— 就是今天真实的那条路。
  const mock = await startMockOpenAIServer({ failWhen: () => true });
  try {
    await serve(context);
    await setExtensionSettings(page, { ...aiSettings(mock.endpoint), theme: 'dark' });
    await page.goto(`${ORIGIN}/list`);
    await clickFloatBall(page);

    // 整页报错与今天相同：进度条进错误态，写的是第一批失败的原因。
    const progress = page.locator('#ai-translator-progress');
    await expect(progress).toHaveClass(/ai-translator-progress-error-state/, { timeout: 60000 });
    const errorText = progress.locator('.ai-translator-progress-error-text');
    await expect(errorText).toContainText(en('apiErrorServer'));
    await expect(errorText).toContainText('upstream refused this batch');

    // 发出去过的每一项都是标记，没发出去的一项也没有；没有一个 [T]。
    await expect.poll(async () => {
      const sent = LIST_ITEMS.filter((text) => mock.sentTexts.some((body) => body.includes(text))).length;
      const marked = await page.locator('li + .ai-translator-failed, li > .ai-translator-failed').count();
      return { sent, marked, same: sent === marked };
    }, { timeout: 20000 }).toMatchObject({ same: true });
    const sentIds = LIST_ITEMS
      .map((text, i) => (mock.sentTexts.some((body) => body.includes(text)) ? `li${i + 1}` : null))
      .filter(Boolean);
    console.log(`[D-J11] ${mock.sentTexts.length} requests, ${sentIds.length} items sent`);
    expect(sentIds.length).toBeGreaterThanOrEqual(40 * 2);
    for (const id of sentIds) {
      await expect(page.locator(`#${id} .ai-translator-failed, #${id} + .ai-translator-failed`))
        .toHaveText(en('translationFailedRetry'));
    }
    expect(await translatedCount(page)).toBe(0);

    // 深色页面上标记的字色对比度 ≥ 4.5:1（标记跟正文取色，背景取最近的不透明祖先）。
    const firstMarker = page.locator('#li1 .ai-translator-failed, #li1 + .ai-translator-failed');
    const colors = await firstMarker.evaluate((el) => {
      let node = el;
      let background = 'rgba(0, 0, 0, 0)';
      while (node) {
        const value = getComputedStyle(node).backgroundColor;
        if (!/rgba\(.*,\s*0\)$/.test(value) && value !== 'transparent') {
          background = value;
          break;
        }
        node = node.parentElement;
      }
      return { color: getComputedStyle(el).color, opacity: getComputedStyle(el).opacity, background };
    });
    const ratio = contrastRatio(colors.color, colors.background);
    console.log(`[D-J11] marker ${colors.color} on ${colors.background}: ${ratio.toFixed(2)}:1`);
    expect(colors.opacity).toBe('1');
    expect(ratio).toBeGreaterThanOrEqual(4.5);

    // 悬浮球：标记不算译文。菜单里没有「收起译文」，单击是「翻译」，会重新请求。
    await openFloatBallMenu(page);
    await expect(page.locator('#ai-translator-float-menu [data-action="toggle-translations"]')).toHaveCount(0);
    await expect(page.locator('#ai-translator-float-menu [data-action="translate-page"]')).toBeVisible();
    await page.click('#ai-translator-float-ball .ai-translator-ball-more');
    await expect(page.locator('#ai-translator-float-menu')).toBeHidden();
    // 这一次服务恢复了：重新翻译整页时，每一段的标记都让位给译文（insertTranslation
    // 先摘标记，batch.js）—— 不会出现标记和译文并排。
    mock.setFailWhen(() => false);
    const before = mock.sentTexts.length;
    await clickFloatBall(page);
    await expect.poll(() => mock.sentTexts.length, { timeout: 20000 }).toBeGreaterThan(before);
    await expect.poll(async () => page.evaluate(() => ({
      markers: document.querySelectorAll('.ai-translator-failed').length,
      translated: document.querySelectorAll('li.ai-translator-translated').length,
    })), { timeout: 30000 }).toEqual({ markers: 0, translated: LIST_ITEMS.length });

    // 标记的字从来不会被当成原文送出去。
    for (const body of mock.sentTexts) expect(body).not.toContain(en('translationFailedRetry'));
  } finally {
    await mock.close();
  }
});

// ----------------------------------------------------------------- D-J12

/**
 * 按请求计数的失败夹具：含 needle 的请求，前 limit 次失败，之后正常。
 * 返回 mock 的 failWhen 与失败发生的时刻（本机时钟，与页面里 Date.now() 同一个钟）。
 */
function failTimes(needle, limit) {
  const times = [];
  let seen = 0;
  return {
    times,
    failWhen: (text) => {
      if (!text.includes(needle)) return false;
      seen += 1;
      if (seen > limit) return false;
      times.push(Date.now());
      return true;
    },
  };
}

test('D-J12 auto-translate gets a second chance: one failure never shows a marker, the second failure does', async ({ page, context }) => {
  test.setTimeout(120000);
  // [fixture] 夹具：failStatus 400（不可重试），「一次失败」就是一次请求，不被
  // service worker 的重试放大；failWhen 按请求计数，不按内容恒真恒假。
  const once = failTimes(FLAKY_ONCE, 1);
  const mock = await startMockOpenAIServer({ failWhen: once.failWhen, failStatus: 400 });
  // 标记出现过没有，不能只看终态：MutationObserver 记下每一次插入。
  await page.addInitScript(() => {
    window.markerLog = [];
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.matches('.ai-translator-failed') || node.querySelector('.ai-translator-failed')) {
            window.markerLog.push(Date.now());
          }
        }
      }
    }).observe(document, { childList: true, subtree: true });
  });
  try {
    await serve(context);
    await setExtensionSettings(page, aiSettings(mock.endpoint));
    const worker = await getServiceWorker(context);
    await worker.evaluate(() => globalThis.SiteRules.writeUserRule('retry.test', 'always'));

    // 第一次失败、第二次成功：最终有译文，标记从没出现过。
    await page.goto(`${ORIGIN}/auto-once`);
    await expect(translationAfter(page, 'flaky')).toContainText('[T]', { timeout: 30000 });
    expect(once.times).toHaveLength(1);
    expect(mock.sentTexts.filter((text) => text.includes(FLAKY_ONCE))).toHaveLength(2);
    expect(await page.evaluate(() => window.markerLog)).toEqual([]);
    await expect(page.locator('.ai-translator-failed')).toHaveCount(0);

    // 两次都失败：第二次失败之后才出现标记，之后不再自己送第三次。
    const twice = failTimes(FLAKY_TWICE, 2);
    mock.setFailWhen(twice.failWhen);
    await page.goto(`${ORIGIN}/auto-twice`);
    await expect(markerAfter(page, 'flaky')).toHaveText(en('translationFailedRetry'), { timeout: 30000 });
    expect(twice.times).toHaveLength(2);
    const log = await page.evaluate(() => window.markerLog);
    expect(log.length).toBeGreaterThanOrEqual(1);
    expect(log[0]).toBeGreaterThanOrEqual(twice.times[1]);
    await page.waitForTimeout(2000);
    expect(mock.sentTexts.filter((text) => text.includes(FLAKY_TWICE))).toHaveLength(2);
  } finally {
    await mock.close();
  }
});
