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
 *
 * The API key below is a placeholder string; no credential is involved.
 * Every journey ends in a geometry check (layout-checks.js), in the dark
 * palette for J-F6 and J-F8.
 */
const fs = require('fs');
const { test, expect } = require('./fixtures');
const { getMessage } = require('../../i18n/messages');
const { setExtensionSettings, getSyncSettings, writeSyncSettings, getServiceWorker } = require('./helpers');
const { startMockServer } = require('./mock-server');
const { expectLaidOut } = require('./layout-checks');

const en = (key) => getMessage(key, 'en');
const PLACEHOLDER_KEY = 'e2e-placeholder-not-a-key';

function report(label, text) {
  console.log(`${label}: ${text}`);
  test.info().annotations.push({ type: label, description: text });
}

async function openOptions(page, extensionId) {
  await page.goto(`chrome-extension://${extensionId}/options/options.html`);
  await page.waitForSelector('#provider');
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

/** Everything in sync storage, and how many bytes it takes. */
async function syncSnapshot(context) {
  const worker = await getServiceWorker(context);
  return worker.evaluate(async () => ({
    items: await chrome.storage.sync.get(null),
    bytes: await chrome.storage.sync.getBytesInUse(null),
  }));
}

test('J-F5 an export leaves the API key out unless the box is ticked', async ({ page, extensionId }) => {
  await setExtensionSettings(page, {
    apiKey: PLACEHOLDER_KEY,
    targetLang: 'de',
    siteRules: { 'example.com': 'always' },
    siteAskCount: { 'example.org': 2 },
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
  // Per-device counters and window geometry never travel.
  expect(plain.body.settings).not.toHaveProperty('siteAskCount');
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
