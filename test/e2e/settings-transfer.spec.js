/**
 * Settings import / export on the settings page (design
 * docs/plans/2026-09-25-p0-f-onboarding-transfer.md §3, §13).
 *
 *   J-F5  an export leaves the API key out unless the box is ticked
 *   J-F6  an import is previewed first, merged on confirm, and the open tabs
 *         hear about it (SETTINGS_UPDATED); the "AI may now spend on its own"
 *         notice shows exactly when the import opens that path
 *   J-F7  site rules survive an export → import round trip, merged
 *   J-F8  a bad file changes nothing in storage, not one byte
 *   J-11  the site translation rules ride along (P1-B design
 *         docs/plans/2026-09-24-p1-b-site-rules.md §12.4, §6 J-11): the
 *         customRules section equals the card's own export, an import puts
 *         deleted rules back, an over-budget section is refused before
 *         anything is written, and a write that fails half way says which
 *         sections already went in. Rules are made and deleted in the card;
 *         the one service worker write is the J-7 preset that fills the
 *         budget between the preview and the confirm, as the design says.
 *
 * The API key below is a placeholder string; no credential is involved.
 * Every journey ends in a geometry check (layout-checks.js), in the dark
 * palette for J-F6 and J-F8.
 */
const fs = require('fs');
const { test, expect } = require('./fixtures');
const { getMessage } = require('../../i18n/messages');
const {
  setExtensionSettings, getSyncSettings, writeSyncSettings, syncSnapshot,
} = require('./helpers');
const { startMockServer } = require('./mock-server');
const { expectLaidOut } = require('./layout-checks');
const {
  fill,
  storedRules,
  presetRules,
  createRule,
  deleteRule,
  fillRuleEditor,
  saveRuleEditor,
  openOptions: openRulesCard,
} = require('./custom-rules-fixtures');

const en = (key) => getMessage(key, 'en');
const PLACEHOLDER_KEY = 'e2e-placeholder-not-a-key';

function report(label, text) {
  console.log(`${label}: ${text}`);
  test.info().annotations.push({ type: label, description: text });
}

// #provider is static markup, parsed long before options.js wires the transfer
// card: its listeners are attached after `await loadSettings()` in the
// DOMContentLoaded handler, so a setInputFiles right after #provider can fire
// `change` with no listener and the preview never appears. openRulesCard also
// waits for the rules card's usage line, which is drawn only after its first
// read lands -- by then the synchronous setup chain (setupCustomRules,
// setupGlossary, setupTransfer) has run.
async function openOptions(page, extensionId) {
  await openRulesCard(page, extensionId);
}

function blabFile(sections) {
  return { format: 'blab-settings', version: 1, exportedAt: new Date().toISOString(), ...sections };
}

async function chooseFile(page, content, name = 'blab-settings-20260925.json') {
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  await page.setInputFiles('#transferFile', { name, mimeType: 'application/json', buffer: Buffer.from(text) });
}

async function exportFile(page) {
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#transferExport')]);
  const body = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
  return { name: download.suggestedFilename(), body };
}

async function centre(page, selector) {
  await page.locator(selector).evaluate((el) => el.scrollIntoView({ block: 'center' }));
}

test('J-F5 an export leaves the API key out unless the box is ticked', async ({ page, extensionId }) => {
  await setExtensionSettings(page, {
    apiKey: PLACEHOLDER_KEY,
    targetLang: 'de',
    siteRules: { 'example.com': 'always' },
    youtubeCaptionPosXPct: 12,
  });
  await openOptions(page, extensionId);
  await centre(page, '#transferCard');
  report('J-F5 layout', await expectLaidOut(page,
    ['#transferCard .section-title', '#transferExport', '#transferImport', 'label[for="transferIncludeApiKey"]'], 'J-F5'));
  await expect(page.locator('#transferIncludeApiKey')).not.toBeChecked();

  const plain = await exportFile(page);
  expect(plain.name).toMatch(/^blab-settings-\d{8}\.json$/);
  const d = new Date(plain.body.exportedAt);
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  expect(plain.name).toBe(`blab-settings-${ymd}.json`);
  expect(plain.body.format).toBe('blab-settings');
  expect(plain.body.version).toBe(1);
  expect(plain.body.settings.targetLang).toBe('de');
  expect(plain.body.settings).not.toHaveProperty('apiKey');
  // Window geometry never travels.
  expect(plain.body.settings).not.toHaveProperty('youtubeCaptionPosXPct');
  expect(plain.body.settings).not.toHaveProperty('siteRules');
  expect(plain.body.siteRules).toEqual({ 'example.com': 'always' });
  expect(JSON.stringify(plain.body)).not.toContain(PLACEHOLDER_KEY);
  await expect(page.locator('#statusMessage')).toHaveText(en('transferExported'));

  await page.locator('#transferIncludeApiKey').check();
  const withKey = await exportFile(page);
  expect(withKey.body.settings.apiKey).toBe(PLACEHOLDER_KEY);
});

test('J-F6 an import is previewed, merged on confirm, and announced to open tabs', async ({ page, context, extensionId }) => {
  const site = await startMockServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><html lang="en"><body><p>A page that is listening.</p></body></html>');
  });
  try {
    await setExtensionSettings(page, {
      translationEngine: 'builtin',
      autoTranslateEngine: 'builtin',
      engineFallback: 'local-only',
      autoTranslate: false,
      showFloatBall: true,
      targetLang: 'fr',
      theme: 'dark',
    });
    const heard = [];
    page.on('console', (message) => heard.push(message.text()));
    await page.goto(`${site.origin}/`);
    await page.waitForSelector('#ai-translator-float-ball', { state: 'visible' });

    const options = await context.newPage();
    await openOptions(options, extensionId);

    // 1. Nothing here opens a path to unattended AI spend: no notice.
    await chooseFile(options, blabFile({
      settings: { showFloatBall: false, targetLang: 'ja', notASetting: 1 },
      siteRules: {},
      glossaryFromTheFuture: 'a,b',
    }));
    const preview = options.locator('#transferPreview');
    await expect(preview).toBeVisible();
    const items = options.locator('#transferPreviewList li');
    await expect(items.nth(0)).toHaveText(en('transferPreviewSettings').replace('{changed}', 2).replace('{dropped}', 1));
    await expect(options.locator('#transferPreviewList')).toContainText('showFloatBall');
    await expect(options.locator('#transferPreviewList')).toContainText('targetLang');
    await expect(options.locator('#transferPreviewList')).toContainText('notASetting');
    await expect(options.locator('#transferPreviewList')).toContainText(
      en('transferPreviewUnknownSections').replace('{sections}', 'glossaryFromTheFuture'));
    await expect(options.locator('#transferWarnings .transfer-warning')).toHaveCount(0);

    // Previewing wrote nothing.
    expect(await getSyncSettings(context, ['showFloatBall', 'targetLang'])).toEqual({ showFloatBall: true, targetLang: 'fr' });

    await centre(options, '#transferPreview');
    report('J-F6 dark preview', await expectLaidOut(options,
      ['.transfer-preview-title', '#transferPreviewList', '#transferConfirm', '#transferCancel'], 'J-F6 dark preview'));

    await options.click('#transferConfirm');
    await expect(preview).toBeHidden();
    await expect.poll(() => getSyncSettings(context, ['showFloatBall', 'targetLang', 'translationEngine', 'theme'])).toEqual({
      // Merged: the two it named changed, the ones it did not name stayed.
      showFloatBall: false, targetLang: 'ja', translationEngine: 'builtin', theme: 'dark',
    });
    await expect(options.locator('#statusMessage')).toHaveText(en('transferImported'));
    // The page's form shows what is now stored.
    await expect(options.locator('#targetLang')).toHaveValue('ja');

    // The open tab heard SETTINGS_UPDATED (this line is logged by that handler
    // alone, not by the storage listener) and acted on it.
    await expect.poll(() => heard.some((line) => /Settings updated, showFloatBall changed from \w+ to false/.test(line))).toBe(true);
    await expect(page.locator('#ai-translator-float-ball')).toBeHidden();

    // 2. builtin → AI with nothing else open: the notice appears. Cancel writes nothing.
    const aiFile = blabFile({ settings: { translationEngine: 'ai' } });
    await chooseFile(options, aiFile);
    await expect(preview).toBeVisible();
    await expect(options.locator('#transferWarnings .transfer-warning')).toHaveText([en('transferUnattendedAiWarning')]);
    await centre(options, '#transferPreview');
    report('J-F6 dark notice', await expectLaidOut(options,
      ['#transferPreviewList', '#transferWarnings .transfer-warning', '#transferConfirm', '#transferCancel'], 'J-F6 dark notice'));
    await options.click('#transferCancel');
    await expect(preview).toBeHidden();
    expect((await getSyncSettings(context, ['translationEngine'])).translationEngine).toBe('builtin');

    // 3. The same file when the fallback already lets AI run: the path is
    //    already open, so the import opens nothing and says nothing.
    await writeSyncSettings(context, { engineFallback: 'allow-ai' });
    await openOptions(options, extensionId);
    await chooseFile(options, aiFile);
    await expect(preview).toBeVisible();
    await expect(options.locator('#transferWarnings .transfer-warning')).toHaveCount(0);
    await options.close();
  } finally {
    await site.close();
  }
});

test('J-F7 site rules survive an export and import, merged into the list that is there', async ({ page, context, extensionId }) => {
  const rules = { 'example.com': 'always', 'news.example.org': 'never' };
  await setExtensionSettings(page, { siteRules: rules });
  await openOptions(page, extensionId);
  const { body } = await exportFile(page);
  expect(body.siteRules).toEqual(rules);

  // Another device, with a list of its own.
  await writeSyncSettings(context, { siteRules: { 'keep.example.net': 'always', 'example.com': 'never' } });
  await openOptions(page, extensionId);
  await chooseFile(page, body);
  await expect(page.locator('#transferPreviewList')).toContainText(
    en('transferPreviewSiteRules').replace('{count}', 2).replace('{dropped}', 0));
  await centre(page, '#transferPreview');
  report('J-F7 layout', await expectLaidOut(page, ['#transferPreviewList', '#transferConfirm', '#transferCancel'], 'J-F7'));
  await page.click('#transferConfirm');

  await expect.poll(async () => (await getSyncSettings(context, ['siteRules'])).siteRules).toEqual({
    'keep.example.net': 'always',
    'example.com': 'always',
    'news.example.org': 'never',
  });
  await expect(page.locator('#transferError')).toBeHidden();
  // The settings page's own list draws what is now stored, without a reload.
  await expect.poll(async () => (await page.locator('#siteRules .site-rule-host').allInnerTexts()).map((h) => h.trim()).sort())
    .toEqual(['example.com', 'keep.example.net', 'news.example.org']);
});

test('J-F8 a bad file changes nothing in storage', async ({ page, context, extensionId }) => {
  await setExtensionSettings(page, {
    theme: 'dark',
    targetLang: 'fr',
    enableSelection: true,
    enableHoverTranslation: true,
    selectionTranslationHotkey: 'Alt',
    hoverTranslationHotkey: 'Shift',
    siteRules: { 'example.com': 'always' },
  });
  await openOptions(page, extensionId);
  const before = await syncSnapshot(context);
  const error = page.locator('#transferError');

  const cases = [
    ['not JSON', '{"format": "blab-settings", ', en('transferErrorNotJson')],
    ['another program', { format: 'something-else', version: 1, settings: {} }, en('transferErrorWrongFormat')],
    ['a newer version', { format: 'blab-settings', version: 2, settings: { targetLang: 'ja' } }, en('transferErrorWrongVersion')],
    // A valid settings part does not get written when another part is broken:
    // everything is checked before anything is written.
    ['one damaged part', blabFile({ settings: { targetLang: 'ja' }, siteRules: ['example.com'] }),
      en('transferErrorNotObject').replace('{section}', en('transferSectionSiteRules'))],
    ['nothing usable', blabFile({ settings: { notASetting: 1, targetLang: 42 } }), en('transferErrorNothingValid')],
    ['a hotkey conflict', blabFile({ settings: { targetLang: 'ja', selectionTranslationHotkey: 'Shift' } }),
      en('transferErrorHotkeyConflict')],
  ];
  for (const [label, content, message] of cases) {
    await chooseFile(page, content);
    await expect(error, label).toBeVisible();
    await expect(error, label).toHaveText(message);
    await expect(page.locator('#transferPreview'), label).toBeHidden();
    expect(await syncSnapshot(context), label).toEqual(before);
  }

  await centre(page, '#transferError');
  report('J-F8 dark error', await expectLaidOut(page, ['#transferError', '#transferExport', '#transferImport'], 'J-F8 dark error'));
  // The form still shows what is stored.
  await expect(page.locator('#targetLang')).toHaveValue('fr');
});

// ------------------------------------------------------------------ J-11

const DISABLED = /(^|\s)disabled(\s|$)/;
const withoutStamp = ({ exportedAt, ...rest }) => rest;

/** 45 条、每条两段 280 字的选择器：条数放得下（≤ 50），字节放不下（> 24 KiB）。 */
function oversizedRules() {
  return Array.from({ length: 45 }, (_, i) => {
    const n = String(i).padStart(2, '0');
    return {
      id: `big${n}`,
      v: 1,
      match: [`big-${n}.test`],
      exclude: [`.a${'y'.repeat(280)}`, `.b${'y'.repeat(280)}`],
      updatedAt: 1790000000000,
    };
  });
}

/** 报错是给人看的一句话：不带 i18n 键名（camelCase），也没有没填上的 `{占位}`。 */
function expectNoKeyNames(text, label) {
  expect(text, `${label}: no i18n key name`).not.toMatch(/\b[a-z]+[A-Z][A-Za-z]*\b/);
  expect(text, `${label}: no unfilled placeholder`).not.toMatch(/[{}]/);
}

test('J-11 a whole-settings export carries the site translation rules, and an import puts them back', async ({ page, context, extensionId }) => {
  await setExtensionSettings(page, {
    translationEngine: 'builtin',
    autoTranslateEngine: 'builtin',
    engineFallback: 'local-only',
    autoTranslate: false,
    targetLang: 'zh-CN',
  });
  await openRulesCard(page, extensionId);

  // 导入导出卡片的说明里列着「站点翻译规则」。
  await expect(page.locator('span.hint[data-i18n-hint="transferDesc"]')).toHaveText(en('transferDesc'));
  expect(en('transferDesc').toLowerCase()).toContain(en('transferSectionCustomRules').toLowerCase());

  // 规则 A（引擎跟随全局）和 B（钉 AI），都在卡片里建。B 一存，额度那一格亮起来。
  const budget = page.locator('#autoAiBudgetGroup');
  await expect(budget).toHaveClass(DISABLED);
  const { id: idA } = await createRule(page, context, { match: ['rules.test'], exclude: ['.comments'] });
  // B 另带一个字段：引擎改回跟随全局以后它还得是一条有效规则。
  const { id: idB } = await createRule(page, context, { match: ['rules-ai.test'], exclude: ['.ads'] }, { engineAi: true });
  await expect(budget).not.toHaveClass(DISABLED);
  const stored = await storedRules(context);
  expect(Object.keys(stored).sort()).toEqual([`customRule:${idA}`, `customRule:${idB}`].sort());

  // 整份导出里的 customRules 小节，和卡片自己导出的文件逐字段相同（导出时刻除外）。
  const { body } = await exportFile(page);
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#customRulesExport')]);
  const card = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
  expect(body.customRules.format).toBe('blab-site-rules');
  expect(body.customRules.version).toBe(1);
  expect(withoutStamp(body.customRules)).toEqual(withoutStamp(card));
  expect(body.customRules.rules.map((r) => r.id).sort()).toEqual([idA, idB].sort());

  // 在卡片里删掉 A，把 B 的引擎改回跟随全局：一条钉 AI 的规则都不剩，额度那一格变灰。
  // B 留着，导入时它就是一条「替换的」AI 规则。
  await deleteRule(page, idA);
  await fillRuleEditor(page, {}, idB);
  await page.selectOption('#customRule-engine', '');
  await saveRuleEditor(page);
  const kept = await storedRules(context);
  expect(Object.keys(kept)).toEqual([`customRule:${idB}`]);
  expect(kept[`customRule:${idB}`].engine).toBeUndefined();
  await expect(budget).toHaveClass(DISABLED);

  // 整份导入：预览里有规则那一行，警告里有 AI 那一句。K 数的是文件里全部
  // engine:'ai' 的条数（§6.1）：B 是替换的，新增的 AI 规则是 0 条，K 仍是 1。
  const preview = page.locator('#transferPreview');
  const rulesLine = fill(en('transferPreviewCustomRules'), { added: 1, replaced: 1 });
  const aiNote = fill(en('customRulesImportAiNoteOne'), { count: 1 });
  await chooseFile(page, body);
  await expect(preview).toBeVisible();
  await expect(page.locator('#transferPreviewList li', { hasText: en('transferSectionCustomRules') }))
    .toHaveText(rulesLine);
  await expect(page.locator('#transferWarnings .transfer-warning', { hasText: aiNote })).toHaveCount(1);
  report('J-11 warnings', (await page.locator('#transferWarnings .transfer-warning').allInnerTexts()).join(' | '));
  expect(await storedRules(context), 'previewing wrote nothing').toEqual(kept);
  await centre(page, '#transferPreview');
  report('J-11 preview', await expectLaidOut(page,
    ['#transferPreviewList', '#transferWarnings .transfer-warning', '#transferConfirm', '#transferCancel'], 'J-11 preview'));

  // 确认：列表回到两条，存进去的就是导出时那两条，额度那一格亮起来。导入的规则
  // updatedAt 一律记为导入那一刻（设计 §1 第 16 条），所以除它之外逐字段相同。
  const importedFrom = Date.now();
  await page.click('#transferConfirm');
  await expect(preview).toBeHidden();
  await expect(page.locator('#statusMessage')).toHaveText(en('transferImported'));
  await expect(page.locator('.custom-rule')).toHaveCount(2);
  await expect(page.locator(`.custom-rule[data-rule-id="${idA}"]`)).toHaveCount(1);
  await expect(page.locator(`.custom-rule[data-rule-id="${idB}"]`)).toHaveCount(1);
  const restored = await storedRules(context);
  const unstamped = (rules) => Object.fromEntries(
    Object.entries(rules).map(([key, { updatedAt, ...rule }]) => [key, rule]));
  expect(unstamped(restored)).toEqual(unstamped(stored));
  const stamps = Object.values(restored).map((rule) => rule.updatedAt);
  expect(new Set(stamps).size, 'one import, one timestamp').toBe(1);
  expect(stamps[0]).toBeGreaterThanOrEqual(importedFrom);
  expect(stamps[0]).toBeLessThanOrEqual(Date.now());
  await expect(budget).not.toHaveClass(DISABLED);

  // 规则小节超额的文件：不出预览，报超额那一句，存储逐字节不变。
  const error = page.locator('#transferError');
  const before = await syncSnapshot(context);
  await chooseFile(page, { ...body, customRules: { ...body.customRules, rules: oversizedRules() } });
  const budgetText = fill(en('transferErrorSectionBudgetFull'), { section: en('transferSectionCustomRules') });
  await expect(error).toBeVisible();
  await expect(error).toHaveText(budgetText);
  await expect(preview).toBeHidden();
  expect(await syncSnapshot(context)).toEqual(before);
  expectNoKeyNames(await error.innerText(), 'budget error');

  // 写入中途失败：删掉 A、B，整份导入原文件；预览出来以后另一头把额度占满（J-7 的
  // 预置，SW 写入），再点确认。设置那一节已经写进去了，规则那一节被拒。
  await deleteRule(page, idA);
  await deleteRule(page, idB);
  await expect.poll(() => storedRules(context)).toEqual({});
  await chooseFile(page, body);
  await expect(preview).toBeVisible();
  await expect(page.locator('#transferPreviewList li', { hasText: en('transferSectionCustomRules') }))
    .toHaveText(fill(en('transferPreviewCustomRules'), { added: 2, replaced: 0 }));
  const presets = presetRules();
  await writeSyncSettings(context, presets);
  await page.click('#transferConfirm');
  const applyText = fill(en('transferErrorApplyFailed'), {
    failed: en('transferSectionCustomRules'),
    message: en('transferReasonBudgetFull'),
    written: en('transferSectionSettings'),
  });
  await expect(error).toBeVisible();
  await expect(error).toHaveText(applyText);
  expect(Object.keys(await storedRules(context)).sort(), 'only the presets, not one rule more')
    .toEqual(Object.keys(presets).sort());
  expectNoKeyNames(await error.innerText(), 'apply error');

  await centre(page, '#transferError');
  report('J-11 error', await expectLaidOut(page, ['#transferError', '#transferExport', '#transferImport'], 'J-11 error'));
});
