// 输入框芯片的 ▾ 菜单：译成别的语言、调语气、在此网站不显示（D-1031 / D-1032，
// docs/design/input-tone-rewrite.md §4）。芯片主体那一下（译成默认目标、写回、
// 撤回）在 test/e2e/input-chip.spec.js。
//
// 语气请求从 service worker 发出，context.route 拦不到：服务端由一个本地 mock 站
// 着（startMockServer），记下每一次 /api/compose/tone 的请求体和 Authorization，
// 按测试排好的状态码作答。翻译走用户自己的 AI 端点（startMockOpenAIServer），它
// 只回 `[T] 原文`。改写的回声是 `[语气·语言·第几次] 原文`：看一眼就知道是从哪段
// 字、按哪个语气、第几次请求改出来的。
//
// 页面是这里自己写的英文页（lang="en"）和一张中文页（PAGE_ZH），不下载任何东西。
const { test, expect } = require('./fixtures');
const { connectExtension, setExtensionSettings, getServiceWorker, openInputDialog, translateInput } = require('./helpers');
const { startMockServer, serveExtConnect } = require('./mock-server');
const { startMockOpenAIServer } = require('./mock-openai-server');
const { getMessage } = require('../../i18n/messages');
const fs = require('node:fs');
const path = require('node:path');

const en = (key) => getMessage(key, 'en');
const ORIGIN = 'https://tone.test';

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Harbour notes</title>
<style>body { margin: 0; padding: 32px 48px; font: 16px/24px system-ui, sans-serif; color: #222; background: #fff; }
label { display: block; margin: 12px 0; } [contenteditable] { min-height: 3em; border: 1px solid #999; padding: 4px; width: 520px; }</style></head>
<body>
  <p>The afternoon ferry leaves the harbour at three and comes back before dark.</p>
  <label>Reply <textarea id="reply" rows="5" cols="60"></textarea></label>
  <label>Subject <input id="subject" type="text" size="60"></label>
  <label>Search <input id="search" type="search" size="60"></label>
  <label>Destination <input id="combo" type="text" role="combobox" aria-autocomplete="list" size="60"></label>
  <div id="linked-editor" contenteditable="true">Please check <a href="/timetable">the timetable</a> before you book the afternoon ferry.</div>
  <div id="plain-editor" contenteditable="true"></div>
</body></html>`;

// 中文页：中文页上写中文，芯片默认译成英文，语气却按原文的语言（zh-Hans）改。
const PAGE_ZH = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>码头笔记</title>
<style>body { margin: 0; padding: 32px 48px; font: 16px/24px system-ui, sans-serif; color: #222; background: #fff; }</style></head>
<body>
  <p>下午三点的渡船从码头出发，天黑前回来。周末人多，最好提前一天订票。</p>
  <label>回复 <textarea id="reply" rows="5" cols="60"></textarea></label>
</body></html>`;
// 能滚的页：菜单开着时滚页面，要跟着芯片走。
const PAGE_TALL = PAGE.replace('</body>', '<div style="height: 2400px"></div></body>');

const CHINESE = '请问下午那班船还有座位吗，我想带两个孩子一起过去。';
const ENGLISH = 'Hi, are there still seats on the afternoon ferry? I want to bring my two kids along.';
const CHIP = '#ai-translator-input-chip';
const MENU = '#ai-translator-input-menu';

const walkDir = process.env.TONE_WALK_DIR;
async function walkShot(page, name) {
  if (!walkDir) return;
  fs.mkdirSync(walkDir, { recursive: true });
  await page.screenshot({ path: path.join(walkDir, `${name}.png`), animations: 'disabled' });
}

/**
 * The compose endpoint and the sign-in page. `answers` is a queue: each tone
 * request takes the next one ({ status, body }); an empty queue answers 200
 * with the echo. `delayMs` holds every answer that long.
 */
async function startComposeService() {
  const state = { bodies: [], auths: [], connects: [], answers: [], delayMs: 0 };
  const server = await startMockServer((req, res) => {
    const url = new URL(req.url, 'http://mock');
    if (url.pathname === '/ext/connect') {
      state.connects.push(`${url.pathname}${url.search}`);
      return serveExtConnect(url, res);
    }
    if (url.pathname === '/api/compose/tone' && req.method === 'POST') {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        const body = JSON.parse(raw);
        state.bodies.push(body);
        state.auths.push(req.headers.authorization || '');
        const answer = state.answers.shift() || { status: 200 };
        const reply = answer.status === 200
          ? { text: `[${body.tone}·${body.targetLang}·${state.bodies.length}] ${body.text}`, tone: body.tone, usage: { used: state.bodies.length, limit: 20 } }
          : answer.body;
        const send = () => {
          res.writeHead(answer.status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
          res.end(JSON.stringify(reply));
        };
        if (state.delayMs) setTimeout(send, state.delayMs);
        else send();
      });
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });
  return { ...server, state };
}

async function setUp(page, context, { signedIn = true, settings = {}, html = PAGE } = {}) {
  const ai = await startMockOpenAIServer();
  const compose = await startComposeService();
  await connectExtension(context, compose.origin, { signedIn });
  await setExtensionSettings(page, {
    apiEndpoint: ai.endpoint,
    apiKey: 'test-key',
    modelName: 'gpt-4.1-mini',
    targetLang: 'zh-CN',
    ...settings,
  });
  await context.route(`${ORIGIN}/**`, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: html }));
  await page.goto(`${ORIGIN}/harbour`);
  await page.waitForSelector('#ai-translator-float-ball');
  return {
    ai,
    compose,
    close: async () => {
      await ai.close();
      await compose.close();
    },
  };
}

async function typeInto(page, selector, text) {
  await page.click(selector);
  await page.fill(selector, text);
}

const chip = (page) => page.locator(CHIP);
const chipLabel = (page) => page.locator(`${CHIP} .ai-translator-input-chip-label`);
const menu = (page) => page.locator(MENU);
const note = (page) => page.locator(`${MENU} .ai-translator-input-menu-note-text`);
const undo = (page) => page.keyboard.press('ControlOrMeta+z');

async function openMenu(page) {
  await page.locator(`${CHIP} .ai-translator-input-chip-caret`).click();
  await expect(menu(page)).toBeVisible();
}

// 点语气那一项的文字，不碰行尾的 ↻。置灰的那几项（aria-disabled）用户照样点得到，
// Playwright 却会一直等它「可用」，所以那种情况要 force。
async function pickTone(page, tone, { force = false } = {}) {
  await page.locator(`${MENU} [data-tone="${tone}"]`).click({ position: { x: 6, y: 6 }, force });
}

async function waitForChip(page, targetLang) {
  await expect(chip(page)).toBeVisible({ timeout: 10000 });
  if (targetLang) await expect(chip(page)).toHaveAttribute('data-target-lang', targetLang);
}

// 「不出现」要等过防抖和判语言那一轮才算数。
async function expectNoChip(page) {
  await page.waitForTimeout(2000);
  await expect(chip(page)).toHaveCount(0);
}

test('J1 英文页上写中文，点主体：只翻译，一条语气请求都不发', async ({ page, context }) => {
  const { ai, compose, close } = await setUp(page, context);
  try {
    await typeInto(page, '#reply', CHINESE);
    await waitForChip(page, 'en');
    await expect(chipLabel(page)).toHaveText(en('inputChipTranslateTo').replace('{lang}', 'English'));
    await chipLabel(page).click();
    await expect(page.locator('#reply')).toHaveValue(`${CHINESE}\n[T] ${CHINESE}`, { timeout: 15000 });
    expect(ai.sentTexts).toEqual([CHINESE]);
    await page.waitForTimeout(1000);
    expect(compose.state.bodies).toEqual([]);
  } finally {
    await close();
  }
});

test('J2 菜单里选「译成 日本語」：译成日文、芯片改口、刷新后还记得', async ({ page, context }) => {
  const { ai, close } = await setUp(page, context);
  try {
    await typeInto(page, '#reply', ENGLISH);
    await waitForChip(page, 'zh-CN');
    await openMenu(page);
    await expect(page.locator(`${MENU} .ai-translator-input-menu-lang.is-current`)).toHaveAttribute('data-lang', 'zh-CN');
    await page.locator(`${MENU} [data-action="other"]`).click();
    await page.locator(`${MENU} .ai-translator-input-menu-langs [data-lang="ja"]`).click();
    await expect(menu(page)).toHaveCount(0);

    await expect(page.locator('#reply')).toHaveValue(`${ENGLISH}\n[T] ${ENGLISH}`, { timeout: 15000 });
    expect(ai.sentTexts).toEqual([ENGLISH]);
    expect(ai.systemPrompts[0]).toMatch(/Japanese/);
    await expect(chip(page)).toHaveAttribute('data-target-lang', 'ja');
    await expect(chipLabel(page)).toHaveText(en('inputChipTranslateTo').replace('{lang}', 'Japanese'));

    const worker = await getServiceWorker(context);
    expect(await worker.evaluate(() => chrome.storage.local.get('inputTargetLang'))).toEqual({ inputTargetLang: 'ja' });

    await page.reload();
    await page.waitForSelector('#ai-translator-float-ball');
    await typeInto(page, '#reply', ENGLISH);
    await waitForChip(page, 'ja');
    await openMenu(page);
    await expect(page.locator(`${MENU} .ai-translator-input-menu-lang.is-current`)).toHaveAttribute('data-lang', 'ja');
  } finally {
    await close();
  }
});

test('J3 登录、翻译过，选「更正式」：只发四个字段、只换译文段、撤回一版', async ({ page, context }) => {
  const { ai, compose, close } = await setUp(page, context);
  try {
    await typeInto(page, '#reply', CHINESE);
    await waitForChip(page, 'en');
    await chipLabel(page).click();
    const translated = `${CHINESE}\n[T] ${CHINESE}`;
    await expect(page.locator('#reply')).toHaveValue(translated, { timeout: 15000 });

    await openMenu(page);
    await expect(page.locator(`${MENU} .ai-translator-input-menu-lock`)).toBeHidden();
    await walkShot(page, 'J3-1-menu-after-translate');
    await pickTone(page, 'formal');
    await expect(page.locator('#reply')).toHaveValue(`${CHINESE}\n[formal·en·1] ${CHINESE}`, { timeout: 15000 });
    await expect(menu(page)).toHaveCount(0);
    expect(compose.state.bodies).toEqual([
      { text: CHINESE, targetLang: 'en', tone: 'formal', sourceLang: 'zh-Hans' },
    ]);
    expect(Object.keys(compose.state.bodies[0]).sort()).toEqual(['sourceLang', 'targetLang', 'text', 'tone']);
    expect(compose.state.auths).toEqual(['Bearer test-token']);
    expect(ai.sentTexts).toEqual([CHINESE]);
    await walkShot(page, 'J3-2-formal-replaced-translation');

    await undo(page);
    await expect(page.locator('#reply')).toHaveValue(translated);
  } finally {
    await close();
  }
});

test('J4 英文页写英文，选「更友好」：targetLang 就是原文语言，整段替换，撤回一版', async ({ page, context }) => {
  const { ai, compose, close } = await setUp(page, context);
  try {
    await typeInto(page, '#reply', ENGLISH);
    await waitForChip(page, 'zh-CN');
    await openMenu(page);
    await walkShot(page, 'J4-1-menu-untranslated');
    await pickTone(page, 'friendly');
    await expect(page.locator('#reply')).toHaveValue(`[friendly·en·1] ${ENGLISH}`, { timeout: 15000 });
    expect(compose.state.bodies).toEqual([{ text: ENGLISH, targetLang: 'en', tone: 'friendly', sourceLang: 'en' }]);
    expect(ai.sentTexts).toEqual([]);
    await walkShot(page, 'J4-2-friendly-whole-text');

    await undo(page);
    await expect(page.locator('#reply')).toHaveValue(ENGLISH);
  } finally {
    await close();
  }
});

test('J5 更友好再更简洁：第二次仍送原文；再选更友好走缓存；↻ 才重新要', async ({ page, context }) => {
  const { compose, close } = await setUp(page, context);
  try {
    await typeInto(page, '#reply', ENGLISH);
    await waitForChip(page, 'zh-CN');
    await openMenu(page);
    await pickTone(page, 'friendly');
    await expect(page.locator('#reply')).toHaveValue(`[friendly·en·1] ${ENGLISH}`, { timeout: 15000 });

    await openMenu(page);
    await expect(page.locator(`${MENU} [data-tone="friendly"]`)).toHaveAttribute('aria-checked', 'true');
    await pickTone(page, 'concise');
    await expect(page.locator('#reply')).toHaveValue(`[concise·en·2] ${ENGLISH}`, { timeout: 15000 });
    expect(compose.state.bodies.map((body) => body.text)).toEqual([ENGLISH, ENGLISH]);

    await openMenu(page);
    await pickTone(page, 'friendly');
    await expect(page.locator('#reply')).toHaveValue(`[friendly·en·1] ${ENGLISH}`, { timeout: 15000 });
    await page.waitForTimeout(500);
    expect(compose.state.bodies).toHaveLength(2);

    await openMenu(page);
    await page.locator(`${MENU} [data-regenerate="friendly"]`).click();
    await expect(page.locator('#reply')).toHaveValue(`[friendly·en·3] ${ENGLISH}`, { timeout: 15000 });
    expect(compose.state.bodies).toHaveLength(3);
    expect(compose.state.bodies[2]).toEqual({ text: ENGLISH, targetLang: 'en', tone: 'friendly', sourceLang: 'en' });
  } finally {
    await close();
  }
});

test('J6 用户改过译文再选语气：以框里现在的字为新原文；等结果时又改字就一个字不写', async ({ page, context }) => {
  const { compose, close } = await setUp(page, context);
  try {
    await typeInto(page, '#subject', CHINESE);
    await waitForChip(page, 'en');
    await chipLabel(page).click();
    await expect(page.locator('#subject')).toHaveValue(`[T] ${CHINESE}`, { timeout: 15000 });

    const edited = 'Is the afternoon ferry still taking people? Two kids are coming with me.';
    await page.fill('#subject', edited);
    await waitForChip(page);
    await openMenu(page);
    await pickTone(page, 'polite');
    await expect(page.locator('#subject')).toHaveValue(`[polite·en·1] ${edited}`, { timeout: 15000 });
    expect(compose.state.bodies).toEqual([{ text: edited, targetLang: 'en', tone: 'polite', sourceLang: 'en' }]);

    // 结果还在路上，用户又动了字：那份结果没有落点，框里是用户的字，不自动重发。
    compose.state.delayMs = 1500;
    await openMenu(page);
    await pickTone(page, 'casual');
    await expect.poll(() => compose.state.bodies.length).toBe(2);
    const mine = 'Actually, never mind the ferry, we will drive around the bay instead.';
    await page.fill('#subject', mine);
    await page.waitForTimeout(3000);
    await expect(page.locator('#subject')).toHaveValue(mine);
    expect(compose.state.bodies).toHaveLength(2);
    // 第二次仍从这份会话的原文出发（无状态），不是上一版的改写。
    expect(compose.state.bodies[1]).toEqual({ text: edited, targetLang: 'en', tone: 'casual', sourceLang: 'en' });
  } finally {
    await close();
  }
});

test('J7 没登录：菜单画锁，点语气只提示登录不发请求，点登录走 /ext/connect', async ({ page, context }) => {
  const { compose, close } = await setUp(page, context, { signedIn: false });
  try {
    await typeInto(page, '#reply', ENGLISH);
    await waitForChip(page, 'zh-CN');
    await openMenu(page);
    await expect(page.locator(`${MENU} .ai-translator-input-menu-lock`)).toBeVisible();
    await pickTone(page, 'formal');
    await expect(note(page)).toHaveText(en('toneLoginRequired'));
    const signIn = page.locator(`${MENU} [data-account-action="signin"]`);
    await expect(signIn).toBeVisible();
    await walkShot(page, 'J7-1-signed-out-lock-and-prompt');
    await page.waitForTimeout(500);
    expect(compose.state.bodies).toEqual([]);
    await expect(page.locator('#reply')).toHaveValue(ENGLISH);

    const [tab] = await Promise.all([context.waitForEvent('page'), signIn.click()]);
    expect(tab).toBeTruthy();
    await expect.poll(() => compose.state.connects.length).toBe(1);
    expect(compose.state.connects[0]).toMatch(
      /^\/ext\/connect\?utm_source=extension&utm_medium=signin&state=[^&]+&redirect_uri=https%3A%2F%2F[a-p]{32}\.chromiumapp\.org%2F$/,
    );
    const worker = await getServiceWorker(context);
    await expect.poll(() => worker.evaluate(() => chrome.storage.local.get('comicToken').then((r) => r.comicToken)))
      .toBe('granted-token');

    // 登上之后回到这一页：锁没了，语气照常发出去，带的是新拿到的 token。
    await page.bringToFront();
    await page.click('#reply');
    await waitForChip(page);
    await openMenu(page);
    await expect(page.locator(`${MENU} .ai-translator-input-menu-lock`)).toBeHidden();
    await pickTone(page, 'formal');
    await expect(page.locator('#reply')).toHaveValue(`[formal·en·1] ${ENGLISH}`, { timeout: 15000 });
    expect(compose.state.auths).toEqual(['Bearer granted-token']);
  } finally {
    await close();
  }
});

test('J8 出错：免费版额度给升级、付费版说明天恢复、413/422/502 各有一句，框里的字不动', async ({ page, context }) => {
  const { compose, close } = await setUp(page, context);
  try {
    await typeInto(page, '#reply', ENGLISH);
    await waitForChip(page, 'zh-CN');
    compose.state.answers.push(
      { status: 429, body: { error: 'daily_limit', plan: 'free', limit: 20, used: 20, resetsAt: '2026-11-08T00:00:00Z' } },
      { status: 429, body: { error: 'daily_limit', plan: 'standard', limit: 200, used: 200, resetsAt: '2026-11-08T00:00:00Z' } },
      { status: 413, body: { error: 'text_too_long', limit: 4000 } },
      { status: 422, body: { error: 'content_blocked' } },
      { status: 502, body: { error: 'upstream_failed' } },
    );
    await openMenu(page);

    await pickTone(page, 'formal');
    await expect(note(page)).toHaveText(en('toneDailyLimitFree').replace('{limit}', '20'));
    await expect(page.locator(`${MENU} [data-account-action="subscribe"]`)).toBeVisible();
    await walkShot(page, 'J8-1-free-daily-limit');

    await pickTone(page, 'formal');
    await expect(note(page)).toHaveText(en('toneDailyLimitPaid'));
    await expect(page.locator(`${MENU} [data-account-action]`)).toHaveCount(0);
    await walkShot(page, 'J8-2-paid-daily-limit');

    await pickTone(page, 'formal');
    await expect(note(page)).toHaveText(en('toneTextTooLong').replace('{limit}', '4000'));
    await pickTone(page, 'formal');
    await expect(note(page)).toHaveText(en('toneContentBlocked'));
    await pickTone(page, 'formal');
    await expect(note(page)).toHaveText(en('toneFailed'));
    await expect(page.locator(`${MENU} [data-account-action]`)).toHaveCount(0);
    await walkShot(page, 'J8-3-upstream-failed');

    expect(compose.state.bodies).toHaveLength(5);
    await expect(page.locator('#reply')).toHaveValue(ENGLISH);
  } finally {
    await close();
  }
});

test('J9 不出芯片：字太短、type=search、role=combobox、开关关了、在此网站不显示之后', async ({ page, context }) => {
  const { close } = await setUp(page, context);
  try {
    await typeInto(page, '#reply', 'ok thanks');
    await expectNoChip(page);
    await typeInto(page, '#search', ENGLISH);
    await expectNoChip(page);
    await typeInto(page, '#combo', ENGLISH);
    await expectNoChip(page);
    // 对照：同一段字在正经的框里就有芯片。
    await typeInto(page, '#reply', ENGLISH);
    await waitForChip(page);

    // 在此网站不显示：当场收起，刷新后也不再长。
    await openMenu(page);
    await page.locator(`${MENU} [data-action="hide-site"]`).click();
    await expect(chip(page)).toHaveCount(0);
    await expect(menu(page)).toHaveCount(0);
    const worker = await getServiceWorker(context);
    await expect.poll(() => worker.evaluate(async () => {
      const all = await chrome.storage.sync.get(null);
      return JSON.stringify(all).includes('"inputChip":"off"');
    })).toBe(true);
    await page.reload();
    await page.waitForSelector('#ai-translator-float-ball');
    await typeInto(page, '#reply', `${ENGLISH} See you there.`);
    await expectNoChip(page);
  } finally {
    await close();
  }
});

test('J9b 开关关掉后，够长的字也不出芯片', async ({ page, context }) => {
  const { close } = await setUp(page, context, { settings: { showInputTranslateChip: false } });
  try {
    await typeInto(page, '#reply', ENGLISH);
    await expectNoChip(page);
    await typeInto(page, '#reply', CHINESE);
    await expectNoChip(page);
  } finally {
    await close();
  }
});

test('J10 带链接的 contenteditable：语气置灰、翻译照常；纯文本的照常能调语气', async ({ page, context }) => {
  const { ai, compose, close } = await setUp(page, context);
  try {
    await page.click('#linked-editor');
    await page.keyboard.press('End');
    await page.keyboard.type(' Thanks.');
    await waitForChip(page, 'zh-CN');
    await openMenu(page);
    const formal = page.locator(`${MENU} [data-tone="formal"]`);
    await expect(formal).toHaveAttribute('aria-disabled', 'true');
    await expect(page.locator(`${MENU} .ai-translator-input-menu-hint`)).toHaveText(en('toneFormattedUnsupported'));
    await pickTone(page, 'formal', { force: true });
    await expect(note(page)).toHaveText(en('toneFormattedUnsupported'));
    await page.waitForTimeout(500);
    expect(compose.state.bodies).toEqual([]);

    // 翻译不受影响：链接留着，译文接在后面。
    await page.keyboard.press('Escape');
    await expect(menu(page)).toHaveCount(0);
    await chipLabel(page).click();
    await expect(page.locator('#linked-editor')).toContainText('[T] ', { timeout: 15000 });
    await expect(page.locator('#linked-editor a[href="/timetable"]')).toHaveCount(1);
    expect(ai.sentTexts).toHaveLength(1);

    await page.click('#plain-editor');
    await page.keyboard.type(ENGLISH);
    await waitForChip(page, 'zh-CN');
    await openMenu(page);
    await expect(page.locator(`${MENU} [data-tone="friendly"]`)).not.toHaveAttribute('aria-disabled', /.*/);
    await expect(page.locator(`${MENU} .ai-translator-input-menu-hint`)).toHaveCount(0);
    await pickTone(page, 'friendly');
    await expect.poll(() => page.locator('#plain-editor').innerText()).toBe(`[friendly·en·1] ${ENGLISH}`);
    expect(compose.state.bodies).toEqual([{ text: ENGLISH, targetLang: 'en', tone: 'friendly', sourceLang: 'en' }]);
  } finally {
    await close();
  }
});

test('J11 便签对话框：结果区的 ▾ 是同一份菜单，选语气发请求、换掉结果', async ({ page, context }) => {
  const { ai, compose, close } = await setUp(page, context);
  try {
    await openInputDialog(page);
    await translateInput(page, ENGLISH);
    const result = page.locator('#ai-translator-result-text');
    await expect(result).toHaveText(`[T] ${ENGLISH}`, { timeout: 15000 });
    expect(ai.sentTexts).toEqual([ENGLISH]);

    await page.locator('#ai-translator-input-result-menu').click();
    await expect(menu(page)).toBeVisible();
    await expect(page.locator(`${MENU} [data-action="hide-site"]`)).toHaveCount(0);
    await expect(page.locator(`${MENU} .ai-translator-input-menu-lang.is-current`)).toHaveAttribute('data-lang', 'zh-CN');
    await pickTone(page, 'formal');
    await expect(result).toHaveText(`[formal·zh-CN·1] ${ENGLISH}`, { timeout: 15000 });
    expect(compose.state.bodies).toEqual([{ text: ENGLISH, targetLang: 'zh-CN', tone: 'formal', sourceLang: 'en' }]);
    expect(ai.sentTexts).toHaveLength(1);

    // 换一个语气：缓存按 (语言, 语气) 分，第二个语气要再发一次、结果跟着换。
    await page.locator('#ai-translator-input-result-menu').click();
    await expect(menu(page)).toBeVisible();
    await pickTone(page, 'concise');
    await expect(result).toHaveText(`[concise·zh-CN·2] ${ENGLISH}`, { timeout: 15000 });
    expect(compose.state.bodies).toHaveLength(2);
    expect(compose.state.bodies[1]).toEqual({ text: ENGLISH, targetLang: 'zh-CN', tone: 'concise', sourceLang: 'en' });
  } finally {
    await close();
  }
});

// ==================== 修复回合 1（D-1040） ====================

/** The SW's chrome.storage, patched for one test: `kind` is 'sync-set' or 'token-read'. */
async function breakStorage(context, kind) {
  const worker = await getServiceWorker(context);
  await worker.evaluate((which) => {
    if (which === 'sync-set') {
      chrome.storage.sync.set = () => Promise.reject(new Error('sync write refused (test)'));
      return;
    }
    const get = chrome.storage.local.get.bind(chrome.storage.local);
    chrome.storage.local.get = (keys, ...rest) => (JSON.stringify(keys ?? null).includes('comicToken')
      ? Promise.reject(new Error('token read refused (test)'))
      : get(keys, ...rest));
  }, kind);
}

test('F1 语气在路上时点主体、关菜单再点 ▾：都不算数，只落下这一份改写，翻译一个字没发', async ({ page, context }) => {
  const { ai, compose, close } = await setUp(page, context);
  try {
    await typeInto(page, '#reply', ENGLISH);
    await waitForChip(page, 'zh-CN');
    compose.state.delayMs = 2000;
    await openMenu(page);
    await pickTone(page, 'friendly');
    await expect.poll(() => compose.state.bodies.length).toBe(1);
    // 结果还在路上：点主体（译成中文）不算数。
    await chipLabel(page).click();
    await expect(page.locator('#reply')).toHaveValue(`[friendly·en·1] ${ENGLISH}`, { timeout: 15000 });
    await page.waitForTimeout(1000);
    expect(ai.sentTexts).toEqual([]);
    expect(compose.state.bodies).toHaveLength(1);

    // 第二轮：发出去之后 Esc 关掉菜单，再点 ▾ 也打不开、不会再发一条。
    await openMenu(page);
    await pickTone(page, 'concise');
    await expect.poll(() => compose.state.bodies.length).toBe(2);
    await page.keyboard.press('Escape');
    await expect(menu(page)).toHaveCount(0);
    await page.locator(`${CHIP} .ai-translator-input-chip-caret`).click();
    await page.waitForTimeout(300);
    await expect(menu(page)).toHaveCount(0);
    await page.waitForTimeout(2500);
    expect(compose.state.bodies).toHaveLength(2);
    expect(ai.sentTexts).toEqual([]);
  } finally {
    await close();
  }
});

test('F2 「在此网站不显示」没存上：芯片和菜单都留着，菜单说没存上', async ({ page, context }) => {
  const { close } = await setUp(page, context);
  try {
    await typeInto(page, '#reply', ENGLISH);
    await waitForChip(page);
    await openMenu(page);
    await breakStorage(context, 'sync-set');
    await page.locator(`${MENU} [data-action="hide-site"]`).click();
    await expect(note(page)).toHaveText(en('customRuleSaveFailed'));
    await expect(menu(page)).toBeVisible();
    await expect(chip(page)).toBeVisible();
    const worker = await getServiceWorker(context);
    const synced = await worker.evaluate(async () => JSON.stringify(await chrome.storage.sync.get(null)));
    expect(synced).not.toContain('"inputChip":"off"');
  } finally {
    await close();
  }
});

test('F3 查登录状态失败不当成没登录：点语气说「语气调整失败」，不给登录、不发请求', async ({ page, context }) => {
  const { compose, close } = await setUp(page, context);
  try {
    await typeInto(page, '#reply', ENGLISH);
    await waitForChip(page);
    await breakStorage(context, 'token-read');
    await openMenu(page);
    await pickTone(page, 'formal');
    await expect(note(page)).toHaveText(en('toneFailed'));
    await expect(page.locator(`${MENU} [data-account-action]`)).toHaveCount(0);
    await page.waitForTimeout(500);
    expect(compose.state.bodies).toEqual([]);
    await expect(page.locator('#reply')).toHaveValue(ENGLISH);
  } finally {
    await close();
  }
});

test('F4 中文页上写中文、没翻译就调语气：按 zh-Hans 改写，四个字段原样', async ({ page, context }) => {
  const { ai, compose, close } = await setUp(page, context, { html: PAGE_ZH });
  try {
    await typeInto(page, '#reply', CHINESE);
    await waitForChip(page, 'en');
    await openMenu(page);
    await pickTone(page, 'polite');
    await expect(page.locator('#reply')).toHaveValue(`[polite·zh-Hans·1] ${CHINESE}`, { timeout: 15000 });
    expect(compose.state.bodies).toEqual([{ text: CHINESE, targetLang: 'zh-Hans', tone: 'polite', sourceLang: 'zh-Hans' }]);
    expect(Object.keys(compose.state.bodies[0]).sort()).toEqual(['sourceLang', 'targetLang', 'text', 'tone']);
    expect(ai.sentTexts).toEqual([]);
  } finally {
    await close();
  }
});

test('F5 菜单开着滚页面：菜单跟着芯片走', async ({ page, context }) => {
  const { close } = await setUp(page, context, { html: PAGE_TALL });
  try {
    await typeInto(page, '#reply', ENGLISH);
    await waitForChip(page);
    await openMenu(page);
    // 菜单有一段进场动画（getBoundingClientRect 算上 transform），等它播完再量。
    const gap = () => page.evaluate(async ([chipSel, menuSel]) => {
      const menuNode = document.querySelector(menuSel);
      await Promise.all(menuNode.getAnimations().map((animation) => animation.finished));
      const c = document.querySelector(chipSel).getBoundingClientRect();
      const m = menuNode.getBoundingClientRect();
      return m.top >= c.top ? m.top - c.bottom : c.top - m.bottom;
    }, [CHIP, MENU]);
    const before = await gap();
    expect(before).toBeGreaterThanOrEqual(0);
    expect(before).toBeLessThanOrEqual(8);
    await page.mouse.move(600, 600);
    await page.mouse.wheel(0, 120);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(100);
    await page.waitForTimeout(300);
    await expect(menu(page)).toBeVisible();
    const after = await gap();
    expect(after).toBeGreaterThanOrEqual(0);
    expect(after).toBeLessThanOrEqual(8);
  } finally {
    await close();
  }
});

test('F6 菜单关了才回来的改写：不写进框、记进缓存，再选同一项立刻落下不再计次', async ({ page, context }) => {
  const { compose, close } = await setUp(page, context);
  try {
    await typeInto(page, '#reply', ENGLISH);
    await waitForChip(page, 'zh-CN');
    compose.state.delayMs = 1500;
    await openMenu(page);
    await pickTone(page, 'formal');
    await expect.poll(() => compose.state.bodies.length).toBe(1);
    // 焦点离开：芯片和菜单都收起；回来的改写不写。
    await page.click('p');
    await expect(chip(page)).toHaveCount(0);
    await page.waitForTimeout(2500);
    await expect(page.locator('#reply')).toHaveValue(ENGLISH);

    compose.state.delayMs = 0;
    await page.click('#reply');
    await waitForChip(page);
    await openMenu(page);
    await pickTone(page, 'formal');
    await expect(page.locator('#reply')).toHaveValue(`[formal·en·1] ${ENGLISH}`, { timeout: 2000 });
    await page.waitForTimeout(500);
    expect(compose.state.bodies).toHaveLength(1);
  } finally {
    await close();
  }
});

test('F7 菜单关了才失败的改写：错误落在芯片上', async ({ page, context }) => {
  const { compose, close } = await setUp(page, context);
  try {
    await typeInto(page, '#reply', ENGLISH);
    await waitForChip(page);
    compose.state.delayMs = 1500;
    compose.state.answers.push({ status: 502, body: { error: 'upstream_failed' } });
    await openMenu(page);
    await pickTone(page, 'formal');
    await expect.poll(() => compose.state.bodies.length).toBe(1);
    await page.keyboard.press('Escape');
    await expect(menu(page)).toHaveCount(0);
    await expect(chip(page)).toHaveAttribute('data-state', 'error', { timeout: 5000 });
    await expect(chipLabel(page)).toHaveText(en('toneFailed'));
    await expect(page.locator('#reply')).toHaveValue(ENGLISH);
  } finally {
    await close();
  }
});
