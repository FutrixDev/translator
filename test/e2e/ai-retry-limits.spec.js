// P1-D 批次 D2 的端到端旅程：超时重试与限速（编号同设计
// docs/plans/2026-09-26-p1-d-engine-layer.md §7.1 与任务书 p1-d-d2 §4）：
//
//   D-J7   429 重试：前两次 429、Retry-After 1，卡片最终出译文，三次请求，间隔 ≥ 1 秒
//   D-J7b  429 要等 120 秒：超过 60 秒不等，一次请求就失败，卡片说出 120
//   D-J8   不可重试：401 只发一次，卡片说 Key 不对
//   D-J9   限速：设置页把并发设 1、每分钟 600，整页翻译时在途最多 1 个；对照：不限时 > 1
//
// 假主机全部由 context.route 供给，AI 全部是 test/e2e/mock-openai-server.js。
// 划词走真实的拖选和选区图标、卡片；整页翻译走悬浮球。
const { test, expect } = require('./fixtures');
const {
  setExtensionSettings,
  getDefaultProfile,
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

const PAGES = {
  '/': html(`<p id="lead">${LEAD}</p>`),
  '/log': html(PARAGRAPHS.map((text, i) => `<p id="p${i + 1}">${text}</p>`).join('\n')),
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
