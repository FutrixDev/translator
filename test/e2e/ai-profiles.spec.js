// AI 配置档（P1-D 批次 D1）的端到端旅程，编号同设计
// docs/plans/2026-09-26-p1-d-engine-layer.md §7.1 与任务书 §5：
//
//   D-J1   旧配置迁移：四个旧键 → aiProfile:legacy，设置页显示它，整页请求打到它
//   D-J1b  从没配过：不生成配置档，弹出窗口和页面说同一句 configureApiKeyFirst
//   D-J6   超时：设置页把超时设成 15 秒，卡片说「请求超时（15 秒）」，SW 只记一条
//   D-J15  导入导出：不带 Key 的整份导出、删掉的一档从文件回来、旧格式文件升成 legacy 档
//   D-J16  帧与站点规则：跨源 iframe 的请求经顶层解析；v3 规则把一个主机钉到第二档；
//          指向不存在的档的规则被拒
//
// 假主机全部由 context.route 供给，AI 全部是 test/e2e/mock-openai-server.js。mock
// 在任何路径上都作答，所以两档指向同一台 mock 的 /legacy/… 和 /second/…，
// requestPaths 就说得出每个请求打到了哪一档。
//
// 这里写进来的 Key 都是占位字符串，没有任何真凭据。
const fs = require('fs');
const { chromium } = require('@playwright/test');
const { test, expect, extensionPath } = require('./fixtures');
const { getMessage } = require('../../i18n/messages');
const {
  getServiceWorker,
  writeSyncSettings,
  setExtensionSettings,
  syncSnapshot,
  getDefaultProfile,
  E2E_BASE_SETTINGS,
  openFloatBallMenu,
  waitForFloatBall,
} = require('./helpers');
const { startMockOpenAIServer } = require('./mock-openai-server');
const { openOptions: openRulesCard } = require('./custom-rules-fixtures');

const en = (key) => getMessage(key, 'en');
const zh = (key) => getMessage(key, 'zh-CN');
const optionsUrl = (extensionId) => `chrome-extension://${extensionId}/options/options.html`;
const popupUrl = (extensionId) => `chrome-extension://${extensionId}/popup/popup.html`;

const LEGACY_PATH = '/legacy/v1/chat/completions';
const SECOND_PATH = '/second/v1/chat/completions';
const LEGACY_KEYS = ['provider', 'apiEndpoint', 'apiKey', 'modelName'];
const LEGACY_KEY_VALUE = 'e2e-legacy-placeholder';
const SECOND_KEY_VALUE = 'e2e-second-placeholder';

const TOP = 'https://frames.test';
const EMBED = 'https://embed.test';
const OTHER = 'https://other.test';

const TOP_LEAD = 'The ferry leaves the northern pier every morning at a quarter past six.';
const EMBED_LEAD = 'I took the afternoon crossing last week and the sea was perfectly calm the whole way.';
const OTHER_LEAD = 'The lighthouse keeper writes the weather into a notebook twice a day.';
const HEADING = 'Harbour timetable for the winter season';

const TRANSLATED = '.ai-translator-inline-block';

const html = (body) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Harbour notes</title></head>
<body>${body}</body></html>`;

const FRAME_ATTRS = 'width="640" height="220" style="border:0;display:block"';

const PAGES = {
  [`${TOP}/article`]: html(`<h1 id="heading">${HEADING}</h1><p id="top-lead">${TOP_LEAD}</p>`),
  [`${TOP}/cross-origin`]: html(`
    <p id="top-lead">${TOP_LEAD}</p>
    <iframe id="embed" src="${EMBED}/comments" ${FRAME_ATTRS}></iframe>`),
  [`${EMBED}/comments`]: html(`<p id="embed-lead">${EMBED_LEAD}</p>`),
  [`${OTHER}/article`]: html(`<p id="other-lead">${OTHER_LEAD}</p>`),
};

async function serve(context) {
  for (const origin of [TOP, EMBED, OTHER]) {
    await context.route(`${origin}/**`, (route) => {
      const body = PAGES[route.request().url().split(/[?#]/)[0]];
      if (!body) return route.fulfill({ status: 404, body: 'not found' });
      return route.fulfill({ status: 200, contentType: 'text/html', body });
    });
  }
}

// 翻译相关、与 AI 配置档无关的设置：每条旅程都一样。
const PAGE_SETTINGS = Object.freeze({
  targetLang: 'zh-CN',
  skipTargetLanguageText: false,
  enableSelection: true,
  selectionTranslationMode: 'popup',
});

/** 点球本身：单击球是「翻译 / 还原」（菜单在球上那颗 ···）。 */
async function clickFloatBall(page) {
  await waitForFloatBall(page);
  await page.click('#ai-translator-float-ball', { position: { x: 18, y: 18 } });
}

/** 选中标题，从悬浮球菜单要它的译文，返回那张卡片。 */
async function translateHeadingSelection(page) {
  await page.goto(`${TOP}/article`);
  await waitForFloatBall(page);
  const heading = await page.locator('#heading').boundingBox();
  await page.mouse.move(heading.x + 2, heading.y + heading.height / 2);
  await page.mouse.down();
  await page.mouse.move(heading.x + heading.width - 2, heading.y + heading.height / 2, { steps: 12 });
  await page.mouse.up();
  await openFloatBallMenu(page);
  await page.click('.ai-translator-menu-item[data-action="translate-selection"]');
  return page.locator('.ai-translator-popup');
}

/** SW 眼里此刻的全部配置档（含 Key），按 id 排序。 */
async function storedProfiles(context) {
  const worker = await getServiceWorker(context);
  return worker.evaluate(async () => (await globalThis.AIProfiles.collection.cached())
    .map((profile) => ({ ...profile })).sort((a, b) => a.id.localeCompare(b.id)));
}

/** 写一档非默认的配置档，走 SW 的写队列（AIProfiles.applyWrite，与 AI_PROFILES_WRITE 同一个入口）。 */
async function putProfile(context, profile) {
  const worker = await getServiceWorker(context);
  await worker.evaluate((fields) => globalThis.AIProfiles.applyWrite({
    type: 'AI_PROFILES_WRITE',
    kind: 'put',
    profile: {
      v: 1, features: [], default: false, rpm: 0, concurrency: 0, timeoutSec: 120, ...fields,
    },
  }), profile);
}

async function removeProfile(context, id) {
  const worker = await getServiceWorker(context);
  await worker.evaluate((profileId) => globalThis.AIProfiles.applyWrite({
    type: 'AI_PROFILES_WRITE', kind: 'remove', id: profileId,
  }), id);
}

/**
 * 在一个自己管的配置目录上起浏览器（和 fixtures.js 同一套参数）。D-J1 要的是「同一个
 * 配置目录关掉再打开」—— fixture 给的 context 每条测试一个全新的临时目录，关了就没了。
 */
async function launchOnProfile(userDataDir) {
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: !process.env.HEADED,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--no-sandbox',
      '--disable-setuid-sandbox',
    ],
    viewport: { width: 1280, height: 720 },
  });
  const worker = await getServiceWorker(context);
  const extensionId = new URL(worker.url()).host;
  return { context, extensionId };
}

/** 设置页导出一份文件，读回它的 JSON。 */
async function exportFile(page) {
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#transferExport')]);
  return JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
}

async function chooseFile(page, content) {
  await page.setInputFiles('#transferFile', {
    name: 'blab-settings-20260928.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(content)),
  });
}

/**
 * SW 收到的每条翻译消息：类型、feature、profileId、从哪个 frame 发来、带没带某段文字。
 * 只是旁听（监听器不回复），翻译照常由 background.js 的监听器作答。
 */
async function spyOnTranslateMessages(context, marker) {
  const worker = await getServiceWorker(context);
  await worker.evaluate((needle) => {
    globalThis.__aiProfileSpy = [];
    chrome.runtime.onMessage.addListener((message, sender) => {
      if (!message || !String(message.type).startsWith('TRANSLATE')) return;
      globalThis.__aiProfileSpy.push({
        type: message.type,
        feature: message.feature,
        profileId: message.profileId,
        frameId: sender.frameId,
        carriesMarker: JSON.stringify(message).includes(needle),
      });
    });
  }, marker);
  return worker;
}

// ------------------------------------------------------------------ D-J1

test('D-J1 [fixture] a legacy setup is migrated into the default profile, shown by the form and used by the page', async ({}, testInfo) => {
  // 这一条不用 fixture 的 context：要的是同一个配置目录关掉再打开。
  const userDataDir = testInfo.outputPath('profile');
  const mock = await startMockOpenAIServer();
  let context = null;
  try {
    // [fixture] 第 1 步：一个用旧版本配过 AI 的浏览器。隔离的是「旧版本把四个旧键写
    // 进 sync」：旧版本已不存在，所以四个旧键由 SW 直接写。之后浏览器整个关掉、在
    // 同一个配置目录上重新打开 —— 新 SW 的第一个生命期里 runtime.onStartup 跑
    // ensureMigrated()，和用户升级后第一次开浏览器是同一条路。D2 不改这一步。
    const first = await launchOnProfile(userDataDir);
    ({ context } = first);
    // onInstalled 偶尔晚于下面写四键才到、在这一生命期就迁走：先等这一生命期的迁移（此刻无旧键）落定。
    const settle = await context.newPage();
    await settle.goto(optionsUrl(first.extensionId));
    await settle.evaluate(() => chrome.runtime.sendMessage({ type: 'AI_PROFILES_PUBLIC' }));
    await settle.close();
    await writeSyncSettings(context, {
      ...E2E_BASE_SETTINGS,
      ...PAGE_SETTINGS,
      provider: 'custom',
      apiEndpoint: `${mock.origin}${LEGACY_PATH}`,
      apiKey: LEGACY_KEY_VALUE,
      modelName: 'legacy-model',
    });
    // 旧版本的存储里没有配置档（这一次安装的 onInstalled 在四键写进来之前就跑完了）。
    expect(Object.keys((await syncSnapshot(context)).items).filter((key) => key.startsWith('aiProfile:'))).toEqual([]);
    await context.close();

    const relaunched = await launchOnProfile(userDataDir);
    context = relaunched.context;
    await serve(context);

    // 第 2 步：打开设置页，表单显示的就是旧的那一套。
    const options = await context.newPage();
    await options.goto(optionsUrl(relaunched.extensionId));
    await expect(options.locator('#provider')).toHaveValue('custom');
    await expect(options.locator('#apiEndpoint')).toHaveValue(`${mock.origin}${LEGACY_PATH}`);
    await expect(options.locator('#modelName')).toHaveValue('legacy-model');
    await expect(options.locator('#apiKey')).toHaveValue(LEGACY_KEY_VALUE);

    const { items } = await syncSnapshot(context);
    for (const key of LEGACY_KEYS) expect(items).not.toHaveProperty(key);
    expect(items['aiProfile:legacy']).toBeDefined();
    expect(await storedProfiles(context)).toEqual([expect.objectContaining({
      id: 'legacy', default: true, provider: 'custom',
      apiEndpoint: `${mock.origin}${LEGACY_PATH}`, modelName: 'legacy-model', apiKey: LEGACY_KEY_VALUE,
    })]);

    // 第 3 步：整页翻译，请求打到这一档的地址。
    const page = await context.newPage();
    await page.goto(`${TOP}/article`);
    await clickFloatBall(page);
    await expect(page.locator(TRANSLATED).first()).toContainText(HEADING, { timeout: 30000 });
    expect(mock.requestPaths.length).toBeGreaterThan(0);
    expect([...new Set(mock.requestPaths)]).toEqual([LEGACY_PATH]);
  } finally {
    if (context) await context.close();
    await mock.close();
  }
});

test('D-J1b a setup that never had a key makes no profile, and the popup and the page say the same sentence', async ({ page, context, extensionId }) => {
  const mock = await startMockOpenAIServer();
  try {
    await serve(context);
    // 全新安装：onInstalled 已经跑过一次迁移，没有旧键可迁，什么也没生成。
    await writeSyncSettings(context, PAGE_SETTINGS);

    const popup = await context.newPage();
    await popup.goto(popupUrl(extensionId));
    await expect(popup.locator('#translatePage')).toBeVisible();
    const optionsOpened = context.waitForEvent('page');
    await popup.click('#translatePage');
    await expect(popup.locator('#statusText')).toHaveText(en('configureApiKeyFirst'));
    // 同一下还把设置页打开了（D1 之前也是这样）。
    expect((await optionsOpened).url()).toContain('/options/options.html');

    const card = await translateHeadingSelection(page);
    await expect(card.locator('.ai-translator-error')).toHaveText(en('configureApiKeyFirst'));

    const { items } = await syncSnapshot(context);
    expect(Object.keys(items).filter((key) => key.startsWith('aiProfile:'))).toEqual([]);
    for (const key of LEGACY_KEYS) expect(items).not.toHaveProperty(key);
    expect(mock.requestPaths).toEqual([]);
  } finally {
    await mock.close();
  }
});

// ------------------------------------------------------------------ D-J6

test('D-J6 a profile timed out at 15 s on the settings page says so on the card, and the worker logs it once', async ({ page, context, extensionId }) => {
  // D2：超时可重试（设计 §3.9），三次都超时才上卡片：约 15 + 1 + 15 + 2 + 15 秒。
  test.setTimeout(150000);
  const mock = await startMockOpenAIServer({ delayMs: 30000 });
  try {
    await serve(context);
    await setExtensionSettings(page, {
      ...PAGE_SETTINGS,
      uiLanguage: 'zh-CN',
      provider: 'custom',
      apiEndpoint: `${mock.origin}${LEGACY_PATH}`,
      apiKey: LEGACY_KEY_VALUE,
      modelName: 'slow-model',
    });

    // 设置页表单：超时那一格填 15，离开这一格就存。
    const options = await context.newPage();
    await options.goto(optionsUrl(extensionId));
    await expect(options.locator('#aiProfileTimeout')).toHaveValue('120');
    await options.locator('#aiProfileTimeout').fill('15');
    await options.locator('#aiProfileTimeout').blur();
    await expect.poll(async () => (await getDefaultProfile(context)).timeoutSec).toBe(15);
    await options.close();

    const worker = await getServiceWorker(context);
    const failures = [];
    worker.on('console', (message) => {
      if (/^TRANSLATE\w* failed( after \d+ attempts)? \(profile /.test(message.text())) failures.push(message.text());
    });

    const started = Date.now();
    const card = await translateHeadingSelection(page);
    const expected = zh('apiErrorTimeout').replace('{seconds}', '15');
    expect(expected).toBe('请求超时（15 秒）');
    await expect(card.locator('.ai-translator-error')).toHaveText(expected, { timeout: 70000 });
    const elapsed = Date.now() - started;
    // 三次尝试，每次都在 15 秒上被掐断（不是等到 mock 30 秒后才作答），
    // 中间隔着 1 秒、2 秒（各 ±20%）的退避。
    expect(mock.requestTimes).toHaveLength(3);
    const gaps = [mock.requestTimes[1] - mock.requestTimes[0], mock.requestTimes[2] - mock.requestTimes[1]];
    expect(gaps[0]).toBeGreaterThanOrEqual(15800);
    expect(gaps[0]).toBeLessThan(17500);
    expect(gaps[1]).toBeGreaterThanOrEqual(16600);
    expect(gaps[1]).toBeLessThan(18500);
    expect(elapsed).toBeGreaterThanOrEqual(47000);
    console.log(`[D-J6] card error after ${elapsed} ms, gaps ${gaps.join(' / ')} ms`);

    // SW 只有一条：接住错误的那一层（api-errors.js replyError）记一次。
    await page.waitForTimeout(1000);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/^TRANSLATE failed after 3 attempts \(profile legacy, feature selection\):/);
    expect(failures[0]).not.toContain(LEGACY_KEY_VALUE);
  } finally {
    await mock.close();
  }
});

// ------------------------------------------------------------------ D-J15

test('D-J15 [fixture] export leaves the key out, a removed profile comes back from the file, an old file becomes the legacy profile', async ({ page, context, extensionId }) => {
  await setExtensionSettings(page, {
    uiLanguage: 'zh-CN',
    provider: 'custom',
    apiEndpoint: 'https://legacy.test/v1/chat/completions',
    apiKey: LEGACY_KEY_VALUE,
    modelName: 'legacy-model',
  });
  await openRulesCard(page, extensionId);

  // 第 1 步：整份导出，不勾「包含 API Key」。
  await expect(page.locator('#transferIncludeApiKey')).not.toBeChecked();
  const plain = await exportFile(page);
  expect(plain.aiProfiles.map((profile) => profile.id)).toEqual(['legacy']);
  expect(plain.aiProfiles.every((profile) => !('apiKey' in profile))).toBe(true);
  expect(JSON.stringify(plain)).not.toContain(LEGACY_KEY_VALUE);
  expect(JSON.stringify(plain)).not.toMatch(/"apiKey"/);

  // [fixture] 第 2 步：造第二档、导出、再删掉它。隔离的是「新建第二档」和「删档」
  // 两次写：D1 的设置页只编辑默认档，所以这两次写直接走 SW 的 AI_PROFILES_WRITE
  // 入口；D2 的配置档列表上线后改成在列表里点。
  await putProfile(context, {
    id: 'second',
    name: 'Second relay',
    provider: 'custom',
    apiEndpoint: 'https://second.test/v1/chat/completions',
    apiKey: SECOND_KEY_VALUE,
    modelName: 'second-model',
  });
  await openRulesCard(page, extensionId);
  const both = await exportFile(page);
  expect(both.aiProfiles.map((profile) => profile.id).sort()).toEqual(['legacy', 'second']);
  expect(JSON.stringify(both)).not.toContain(SECOND_KEY_VALUE);
  await removeProfile(context, 'second');
  expect((await storedProfiles(context)).map((profile) => profile.id)).toEqual(['legacy']);

  await openRulesCard(page, extensionId);
  await chooseFile(page, both);
  await expect(page.locator('#transferPreview')).toBeVisible();
  await expect(page.locator('#transferPreviewList')).toContainText('将新增 1 个 AI 配置档');
  await expect(page.locator('#transferWarnings .transfer-warning')).toHaveText([
    zh('aiProfileKeyMissing').replace('{name}', 'Second relay'),
  ]);
  await expect(page.locator('#transferWarnings')).toContainText('未填 Key');
  await page.click('#transferConfirm');
  await expect(page.locator('#transferPreview')).toBeHidden();
  await expect.poll(async () => (await storedProfiles(context))
    .map((profile) => [profile.id, profile.apiKey]).sort()).toEqual([
    ['legacy', LEGACY_KEY_VALUE], // 文件里没带 Key：沿用本机同一档的
    ['second', ''],
  ]);

  // 第 3 步：[fixture] 旧格式文件 —— D1 之前的导出，settings 里带四个旧键。
  // 隔离的只是「旧版本导出」这一步（旧版本已不存在）；导入本身走 UI。
  await removeProfile(context, 'second');
  const oldFile = {
    format: 'blab-settings',
    version: 1,
    exportedAt: '2026-09-20T08:00:00.000Z',
    settings: {
      targetLang: 'ja',
      provider: 'custom',
      apiEndpoint: 'https://old-export.test/v1/chat/completions',
      apiKey: 'e2e-old-file-placeholder',
      modelName: 'old-model',
    },
  };
  await openRulesCard(page, extensionId);
  await chooseFile(page, oldFile);
  await expect(page.locator('#transferPreview')).toBeVisible();
  // 本机已有 legacy 档：这一档是「替换」。
  await expect(page.locator('#transferPreviewList')).toContainText(
    zh('transferPreviewAiProfiles').replace('{added}', 0).replace('{replaced}', 1));
  await page.click('#transferConfirm');
  await expect(page.locator('#transferPreview')).toBeHidden();
  await expect.poll(async () => (await storedProfiles(context)).map((profile) => [profile.id, profile.apiEndpoint])).toEqual([
    ['legacy', 'https://old-export.test/v1/chat/completions'],
  ]);
  const { items } = await syncSnapshot(context);
  expect(items.targetLang).toBe('ja');
  for (const key of LEGACY_KEYS) expect(items).not.toHaveProperty(key);
});

// ------------------------------------------------------------------ D-J16

test('D-J16 [fixture] a cross-origin frame resolves at the top, a v3 rule pins one host to the second profile', async ({ page, context, extensionId }) => {
  const mock = await startMockOpenAIServer();
  try {
    await serve(context);
    await setExtensionSettings(page, {
      ...PAGE_SETTINGS,
      provider: 'custom',
      apiEndpoint: `${mock.origin}${LEGACY_PATH}`,
      apiKey: LEGACY_KEY_VALUE,
      modelName: 'legacy-model',
    });

    // 1. 没有规则：跨源 iframe 的整页请求也经顶层解析，用默认档。
    const worker = await spyOnTranslateMessages(context, EMBED_LEAD);
    await page.goto(`${TOP}/cross-origin`);
    const embed = page.frameLocator('#embed');
    await expect(embed.locator('#embed-lead')).toBeVisible();
    await clickFloatBall(page);
    await expect(embed.locator(TRANSLATED).first()).toContainText(EMBED_LEAD, { timeout: 30000 });
    await expect(page.locator(TRANSLATED).first()).toContainText(TOP_LEAD, { timeout: 30000 });
    const seen = await worker.evaluate(() => globalThis.__aiProfileSpy);
    expect(seen.some((message) => message.carriesMarker)).toBe(true);
    for (const message of seen) {
      expect(message).toMatchObject({ frameId: 0, feature: 'page', profileId: 'legacy' });
    }
    expect([...new Set(mock.requestPaths)]).toEqual([LEGACY_PATH]);

    // [fixture] 2. 第二档 + 一条 v3 规则。隔离的是「新建第二档」（D1 的设置页只编辑
    // 默认档，D2 的列表上线后改走 UI）和「规则卡里选档」（D2 给规则卡加档位下拉）；
    // 规则经真实的写入消息 CUSTOM_RULES_WRITE 从设置页发出。
    await putProfile(context, {
      id: 'second',
      name: 'Second relay',
      provider: 'custom',
      apiEndpoint: `${mock.origin}${SECOND_PATH}`,
      apiKey: SECOND_KEY_VALUE,
      modelName: 'second-model',
    });
    const options = await context.newPage();
    await options.goto(optionsUrl(extensionId));
    const writeRule = (rule) => options.evaluate((r) => chrome.runtime.sendMessage({
      type: 'CUSTOM_RULES_WRITE', kind: 'put', rule: r,
    }), rule);
    const written = await writeRule({ v: 3, match: ['frames.test'], profile: 'second' });
    expect(written.error).toBeUndefined();

    // 3. 指向不存在的档：被拒，什么也没写。
    const refused = await writeRule({ v: 3, match: ['other.test'], profile: 'nosuchprofile' });
    expect(refused).toEqual({ error: 'customRuleProfileMissing' });
    const rules = Object.entries((await syncSnapshot(context)).items).filter(([key]) => key.startsWith('customRule:'));
    expect(rules.map(([, rule]) => rule.profile)).toEqual(['second']);
    await options.close();

    // 这一主机（顶层和它的跨源 iframe）去第二档。
    mock.requestPaths.length = 0;
    await worker.evaluate(() => { globalThis.__aiProfileSpy.length = 0; });
    await page.goto(`${TOP}/cross-origin`);
    await expect(embed.locator('#embed-lead')).toBeVisible();
    await clickFloatBall(page);
    await expect(embed.locator(TRANSLATED).first()).toContainText(EMBED_LEAD, { timeout: 30000 });
    await expect(page.locator(TRANSLATED).first()).toContainText(TOP_LEAD, { timeout: 30000 });
    const pinned = await worker.evaluate(() => globalThis.__aiProfileSpy);
    expect(pinned.some((message) => message.carriesMarker)).toBe(true);
    for (const message of pinned) {
      expect(message).toMatchObject({ frameId: 0, feature: 'page', profileId: 'second' });
    }
    expect([...new Set(mock.requestPaths)]).toEqual([SECOND_PATH]);

    // 另一主机仍然去默认档。
    mock.requestPaths.length = 0;
    await page.goto(`${OTHER}/article`);
    await clickFloatBall(page);
    await expect(page.locator(TRANSLATED).first()).toContainText(OTHER_LEAD, { timeout: 30000 });
    expect([...new Set(mock.requestPaths)]).toEqual([LEGACY_PATH]);
  } finally {
    await mock.close();
  }
});
