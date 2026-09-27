/**
 * 用户站点规则（P1-B）旅程的共用夹具。用它的 spec：
 *   custom-rules-picker.spec.js    拾取器（J-1、J-3、行内 exclude、几何、popup 入口）
 *   custom-rules-settings.spec.js  设置页卡片（J-2、J-4、J-5、J-6、J-7）
 *   custom-rules-live.spec.js      规则在已打开的页面上生效（J-3 迟到、J-8、J-9、J-10）
 *   settings-transfer.spec.js      J-11
 *
 * 写规则走真实入口（设置页卡片、拾取器）。这里另有 writeRule / removeRules 两个
 * 服务工作者直写的助手，只给标题带 `[fixture]` 的用例用：J-4 第 3/3b 步的绕过写入、
 * J-8 的「另一台设备同步下来的删除」、拾取器遇到本站规则 CSS 不安全。J-7 的 49 条
 * 预置（writeSyncSettings）是前提，不是旅程步骤；J-11 在预览之后用同一份预置把额度
 * 占满，造的是「另一头同时在写」，导入本身走真实入口，不在此列。
 *
 * 页面全部由 context.route 供给，翻译走 mock-openai-server（回 `[T] 原文`）：
 *   - 「翻了」= 原位出现以 `[T] ` 开头的译文节点；
 *   - 「没翻」= 区域盒子里 oursIn 为 0，**并且**原文不在 sentTexts 里；
 *   - 「1 s 内」= 从点下保存（或 SW 写入）那一刻起 1000 ms 内断言成立，中间不刷新
 *     页面。每一处都打一行 `[1s] <步骤>: <毫秒>` 作证据。
 */
const { expect } = require('./fixtures');
const { getMessage } = require('../../i18n/messages');
const { writeSyncSettings, getServiceWorker, openFloatBallMenu } = require('./helpers');

const SECOND = 1000;
const TRANSLATED = '.ai-translator-inline-block';
const PICKER = '#ai-translator-rule-picker';

const en = (key) => getMessage(key, 'en');
/** 把 `{name}` 占位换成值（文案模板和页面上的实际句子对得上）。 */
const fill = (template, values) => Object.entries(values).reduce(
  (text, [name, value]) => text.split(`{${name}}`).join(String(value)), template);

function settings(endpoint, extra) {
  return {
    apiEndpoint: endpoint,
    apiKey: 'test-key',
    modelName: 'gpt-4.1-mini',
    targetLang: 'zh-CN',
    skipTargetLanguageText: false,
    ...extra,
  };
}

const html = (body) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Rules fixture</title></head>
<body>${body}</body></html>`;

async function serve(context, pages) {
  const origins = new Set(Object.keys(pages).map((url) => new URL(url).origin));
  for (const origin of origins) {
    await context.route(`${origin}/**`, (route) => {
      const body = pages[route.request().url().split(/[?#]/)[0]];
      if (!body) return route.fulfill({ status: 404, body: 'not found' });
      return route.fulfill({ status: 200, contentType: 'text/html', body });
    });
  }
}

function rule(match, fields) {
  return { v: 1, match, ...fields, updatedAt: Date.now() };
}

/** 服务工作者直写一条规则（只给设计点名的 SW 步骤用，见文件头）。 */
async function writeRule(context, id, value) {
  await writeSyncSettings(context, { [`customRule:${id}`]: value });
}

/** 服务工作者删规则。 */
async function removeRules(context, ids) {
  const worker = await getServiceWorker(context);
  await worker.evaluate((keys) => new Promise((resolve) => {
    chrome.storage.sync.remove(keys, resolve);
  }), ids.map((id) => `customRule:${id}`));
}

/** sync 区里全部 `customRule:` 键和值。 */
async function storedRules(context) {
  const worker = await getServiceWorker(context);
  return worker.evaluate(async () => Object.fromEntries(
    Object.entries(await chrome.storage.sync.get(null)).filter(([key]) => key.startsWith('customRule:'))));
}

/** 两半缓存一起清：SW 删 L2 的 tc: 键并写 epoch，每个标签页跟着丢自己的 L1。 */
async function clearTranslationCache(context) {
  const worker = await getServiceWorker(context);
  await worker.evaluate(() => globalThis.TranslationCache.clear());
}

/** 自动翻译的 AI 用量账：SW 里 chrome.storage.local 的 autoStats.autoAiChars。 */
async function autoAiChars(context) {
  const worker = await getServiceWorker(context);
  return worker.evaluate(async () => {
    const { autoStats } = await chrome.storage.local.get({ autoStats: null });
    return (autoStats && autoStats.autoAiChars) || 0;
  });
}

const sent = (sentTexts, text) => sentTexts.some((chunk) => chunk.includes(text));
const sendCount = (sentTexts, text) =>
  sentTexts.reduce((sum, chunk) => sum + chunk.split(text).length - 1, 0);

/**
 * 从 t0 起 1000 ms 内 check() 为真；不刷新页面。打印实际用时作证据。
 * @param {number} t0 点保存 / 写入之前取的 Date.now()
 * @param {() => Promise<boolean>} check
 * @param {string} label
 */
async function withinOneSecond(t0, check, label) {
  for (;;) {
    if (await check()) break;
    if (Date.now() - t0 >= SECOND) throw new Error(`${label}: not true within ${SECOND} ms`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const elapsed = Date.now() - t0;
  console.log(`[1s] ${label}: ${elapsed} ms`);
  expect(elapsed).toBeLessThan(SECOND);
}

// 段落的译文是紧随其后的兄弟；列表项的译文在条目里面。
const translationOf = (id) => `#${id} + ${TRANSLATED}, #${id} > ${TRANSLATED}`;

/** frame（或页面）里 id 这一块现在有没有 `[T] ` 开头的译文。 */
function isTranslated(target, id) {
  return target.evaluate((selector) => {
    const node = document.querySelector(selector);
    return Boolean(node && node.textContent.startsWith('[T] '));
  }, translationOf(id));
}

/** inner 的框完整落在 outer 的框里（默认容差 0.5 px，亚像素取整；slack 可收紧到 0）。 */
function expectInsideBox(inner, outer, label, slack = 0.5) {
  expect(inner.width, `${label}: has a width`).toBeGreaterThan(0);
  expect(inner.height, `${label}: has a height`).toBeGreaterThan(0);
  expect(inner.x, `${label}: left edge`).toBeGreaterThanOrEqual(outer.x - slack);
  expect(inner.y, `${label}: top edge`).toBeGreaterThanOrEqual(outer.y - slack);
  expect(inner.x + inner.width, `${label}: right edge`).toBeLessThanOrEqual(outer.x + outer.width + slack);
  expect(inner.y + inner.height, `${label}: bottom edge`)
    .toBeLessThanOrEqual(outer.y + outer.height + slack);
}

/** 页面的视口当成一个框。 */
function viewportBox(page) {
  const { width, height } = page.viewportSize();
  return { x: 0, y: 0, width, height };
}

/** 悬浮菜单里 action 那一项：看得见，框在菜单框里，菜单框在视口里。 */
async function expectMenuItemLaidOut(page, action, text) {
  const item = page.locator(`.ai-translator-menu-item[data-action="${action}"]`);
  await expect(item).toBeVisible();
  await expect(item).toContainText(text);
  const menuBox = await page.locator('#ai-translator-float-menu').boundingBox();
  expectInsideBox(await item.boundingBox(), menuBox, `menu item ${action}`);
  // 菜单在视口里不给容差（B1 的 J-3 就是这么断言的）。
  expectInsideBox(menuBox, viewportBox(page), 'float menu', 0);
  return item;
}

// ------------------------------------------------------------------ 拾取器

/** 从悬浮菜单打开拾取器：菜单项几何在菜单盒内，点它，根节点出现。 */
async function openPickerFromMenu(page) {
  await openFloatBallMenu(page);
  const item = await expectMenuItemLaidOut(page, 'edit-site-rule', en('pickSiteRegion'));
  await item.click();
  await expect(page.locator(PICKER)).toHaveCount(1);
  await expect(page.locator(`${PICKER} .ai-translator-picker-bar`)).toBeVisible();
}

/** 描框贴着 target 的 rect，四边各差 ≤ 1 px。 */
async function expectOutlineOn(page, target, label) {
  const [outline, rect] = await Promise.all([
    page.locator(`${PICKER} .ai-translator-picker-outline`).evaluate((node) => {
      const r = node.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, hidden: node.hidden };
    }),
    target.evaluate((node) => {
      const r = node.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    }),
  ]);
  expect(outline.hidden, `${label}: outline shown`).toBe(false);
  for (const side of ['left', 'top', 'right', 'bottom']) {
    expect(Math.abs(outline[side] - rect[side]), `${label}: outline ${side}`).toBeLessThanOrEqual(1);
  }
}

/** 工具条完整落在视口里。 */
async function expectBarInViewport(page, label) {
  const box = await page.locator(`${PICKER} .ai-translator-picker-bar`).boundingBox();
  expectInsideBox(box, viewportBox(page), `${label}: picker toolbar`);
}

/**
 * 用真指针点选：移到 target 里的一点（默认正中，offset 从左上角算），描框贴上
 * target，再点下去锁定。拾取器在 window 的 capture 阶段截事件，所以走
 * page.mouse，不走会先做可点性检查的 locator.click()。
 */
async function pickWithPointer(page, target, label, offset) {
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  const x = box.x + (offset ? offset.x : box.width / 2);
  const y = box.y + (offset ? offset.y : box.height / 2);
  await page.mouse.move(x, y);
  await expectOutlineOn(page, target, `${label} (hover)`);
  await page.mouse.click(x, y);
  await expect(page.locator(`${PICKER} .ai-translator-picker-input`)).toBeVisible();
  await expectOutlineOn(page, target, `${label} (locked)`);
}

function pickerButton(page, act) {
  return page.locator(`${PICKER} [data-act="${act}"]`);
}

/** 工具条上的「匹配 {n} 处」。 */
async function expectPickerMatches(page, n) {
  await expect(page.locator(`${PICKER} .ai-translator-picker-count`))
    .toHaveText(en('pickerMatches').replace('{n}', String(n)));
}

/** 右下角窄条上的保存提示。 */
async function expectPickerSavedNotice(page) {
  await expect(page.locator('#ai-translator-auto-bar[data-mode="notice"] .ai-translator-auto-text'))
    .toHaveText(en('pickerSaved'));
}

// ------------------------------------------------------------------ 设置页

async function openOptions(page, extensionId) {
  await page.goto(`chrome-extension://${extensionId}/options/options.html`);
  await page.waitForSelector('#provider');
  // 卡片读回来以后才画用量表。
  await expect(page.locator('#customRulesUsage')).not.toBeEmpty();
}

/**
 * 在卡片里点「新建规则」（或某一行的「编辑」）并填表；不点保存 —— 「1 s 内」
 * 从点保存那一刻算，由调用方取 t0 再调 saveRuleEditor。
 * fields 的选择器字段是数组，一项一行；engine 由调用方单独选（要过确认框）。
 * @param {import('@playwright/test').Page} options
 * @param {{match?: string[], include?: string[], exclude?: string[], keepOriginal?: string[], css?: string}} fields
 * @param {string} [ruleId] 给了就编辑这一条，否则新建
 */
async function fillRuleEditor(options, fields, ruleId) {
  if (ruleId) await options.click(`.custom-rule[data-rule-id="${ruleId}"] .custom-rule-edit`);
  else await options.click('#customRulesAdd');
  await expect(options.locator('.custom-rule-editor')).toHaveCount(1);
  for (const [field, value] of Object.entries(fields)) {
    await options.fill(`#customRule-${field}`, Array.isArray(value) ? value.join('\n') : value);
  }
}

/** 点保存，等编辑器收起、列表重画、状态行报「已保存」。 */
async function saveRuleEditor(options) {
  await options.click('.custom-rule-save');
  await expect(options.locator('.custom-rule-editor')).toHaveCount(0);
  await expect(options.locator('#statusMessage')).toContainText(en('settingsSaved'));
}

/**
 * 在编辑器里把引擎选成 AI，接住确认框：断言文案是 customRuleEngineAiConfirm，
 * accept 决定点确定还是取消。
 */
async function chooseAiEngine(options, accept) {
  const dialog = new Promise((resolve) => options.once('dialog', resolve));
  const selecting = options.selectOption('#customRule-engine', 'ai');
  const shown = await dialog;
  expect(shown.type()).toBe('confirm');
  expect(shown.message()).toBe(en('customRuleEngineAiConfirm'));
  if (accept) await shown.accept();
  else await shown.dismiss();
  await selecting;
}

/** 在一个新标签页里打开设置页。 */
async function newOptionsTab(context, extensionId) {
  const options = await context.newPage();
  await openOptions(options, extensionId);
  return options;
}

/**
 * 卡片里新建一条规则：填表、（要钉 AI 就过确认框）、点保存。t0 在点保存之前取。
 * 返回 {id, t0}，id 是 sync 里唯一的那一条新键。
 */
async function createRule(options, context, fields, { engineAi = false } = {}) {
  const before = Object.keys(await storedRules(context));
  await fillRuleEditor(options, fields);
  if (engineAi) await chooseAiEngine(options, true);
  const t0 = Date.now();
  await saveRuleEditor(options);
  const added = Object.keys(await storedRules(context)).filter((key) => !before.includes(key));
  expect(added, 'the card stored exactly one new rule').toHaveLength(1);
  return { id: added[0].slice('customRule:'.length), t0 };
}

/**
 * 卡片里删一行：第一下变成「再点一次确认」，第二下才删；等这一行从列表里消失。
 * 回第二下点下去的那一刻（「1 s 内」从这里起算）。
 */
async function deleteRule(options, id) {
  const row = options.locator(`.custom-rule[data-rule-id="${id}"]`);
  const button = row.locator('.custom-rule-delete');
  await button.click();
  await expect(button).toHaveAttribute('data-armed', 'true');
  await expect(button).toHaveText(en('customRuleDeleteConfirm'));
  const t0 = Date.now();
  await button.click();
  await expect(row).toHaveCount(0);
  return t0;
}

/** 49 条预置规则（设计点名的 SW 写入）：每条（键名 + 存进去的 JSON）恰好 PER_RULE 字节。 */
const PRESET_COUNT = 49;
const PER_RULE = 490;

function presetRules() {
  const updatedAt = 1790000000000;
  const rules = {};
  for (let i = 0; i < PRESET_COUNT; i += 1) {
    const id = `preset${String(i).padStart(2, '0')}`;
    const value = { v: 1, match: [`preset-${String(i).padStart(2, '0')}.test`], exclude: ['.x'], updatedAt };
    const bytes = (v) => Buffer.byteLength(`customRule:${id}`) + Buffer.byteLength(JSON.stringify(v));
    value.exclude = [`.x${'y'.repeat(PER_RULE - bytes(value))}`];
    expect(bytes(value)).toBe(PER_RULE);
    rules[`customRule:${id}`] = value;
  }
  return rules;
}

module.exports = {
  SECOND,
  TRANSLATED,
  PICKER,
  PRESET_COUNT,
  PER_RULE,
  en,
  fill,
  settings,
  html,
  serve,
  rule,
  writeRule,
  removeRules,
  storedRules,
  clearTranslationCache,
  autoAiChars,
  sent,
  sendCount,
  withinOneSecond,
  translationOf,
  isTranslated,
  expectInsideBox,
  viewportBox,
  expectMenuItemLaidOut,
  openPickerFromMenu,
  expectOutlineOn,
  expectBarInViewport,
  pickWithPointer,
  pickerButton,
  expectPickerMatches,
  expectPickerSavedNotice,
  openOptions,
  fillRuleEditor,
  saveRuleEditor,
  chooseAiEngine,
  newOptionsTab,
  createRule,
  deleteRule,
  presetRules,
};
