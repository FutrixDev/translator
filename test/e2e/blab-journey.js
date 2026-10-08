// The Blab Translation journeys' shared ground: the page under test, the two
// mocks (the account service and the user's own AI endpoint, the witness for
// "never falls back"), and the steps and checks more than one Blab spec takes.
//
// BLAB_WALK_DIR, when set, is where each journey leaves its screenshot (the
// walk evidence); unset, nothing is written.
const fs = require('node:fs');
const path = require('node:path');
const { expect } = require('./fixtures');
const {
  connectExtension,
  setExtensionSettings,
  getServiceWorker,
  triggerPageTranslation,
  waitForFloatBall,
} = require('./helpers');
const { startMockBlabService } = require('./mock-blab-service');
const { startMockOpenAIServer } = require('./mock-openai-server');
const { getMessage } = require('../../i18n/messages');

const en = (key) => getMessage(key, 'en');
const ORIGIN = 'https://blab-engine.test';

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Field notes</title>
<style>body { margin: 0; padding: 40px 60px; font: 18px/28px Georgia, serif; color: #222; background: #fff; }
p { width: 640px; }</style></head>
<body>
  <p id="rich">Please read <a id="doc-link" href="/docs">the documentation</a> carefully before you <strong>start working</strong> on the project.</p>
  <p id="lead">Every day I <span id="word">run</span> along the river before the town wakes up.</p>
</body></html>`;

const RUN_ENTRY = {
  translation: '跑',
  phonetics: [{ label: 'US', ipa: '/rʌn/' }],
  senses: [{ pos: 'v.', defs: ['跑', '奔跑'] }],
};

function dictEntry(text) {
  return text === 'run' ? RUN_ENTRY : { translation: `[T] ${text}` };
}

const walkDir = process.env.BLAB_WALK_DIR;
async function walkShot(page, name) {
  if (!walkDir) return;
  fs.mkdirSync(walkDir, { recursive: true });
  // Transitions run to their end state: the error toast slides in and the
  // settings cards fade, and a mid-flight frame is not what the user sees.
  await page.screenshot({ path: path.join(walkDir, `${name}.png`), animations: 'disabled' });
}

/**
 * Both mocks up, the extension pointed at the Blab one, the user's own AI
 * profile pointed at the other, and the page served. The caller closes both.
 */
async function setUp(context, page, { mode = 'available', signedIn = true, engine = 'blab', used = 0, settings = {} } = {}) {
  const blab = await startMockBlabService({ mode, used, dictEntry });
  const ai = await startMockOpenAIServer();
  await connectExtension(context, blab.base, { signedIn });
  await setExtensionSettings(page, {
    provider: 'custom',
    apiEndpoint: ai.endpoint,
    apiKey: 'test-key',
    modelName: 'gpt-4.1-mini',
    translationEngine: engine,
    targetLang: 'zh-CN',
    skipTargetLanguageText: false,
    enableSelection: true,
    selectionTranslationMode: 'popup',
    ...settings,
  });
  await context.route(`${ORIGIN}/**`, (route) => {
    route.fulfill({ status: 200, contentType: 'text/html', body: PAGE });
  });
  return { blab, ai, close: async () => { await blab.close(); await ai.close(); } };
}

async function openPage(page) {
  await page.goto(`${ORIGIN}/notes`);
  await waitForFloatBall(page);
}

async function translatePage(page) {
  await triggerPageTranslation(page);
  await expect(page.locator('#rich + .ai-translator-inline-block')).toContainText('[T]', { timeout: 30000 });
  await page.waitForSelector('#ai-translator-progress', { state: 'hidden', timeout: 30000 });
}

// The page's whole pass stopped on an account error: the progress bar's error
// state carries the message, and no block was translated by anyone.
async function expectPassStopped(page, message) {
  const progress = page.locator('#ai-translator-progress');
  await expect(progress).toHaveClass(/ai-translator-progress-error-state/, { timeout: 30000 });
  await expect(progress.locator('.ai-translator-progress-error-text')).toContainText(message);
  await expect(page.locator('.ai-translator-inline-block')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('[T]');
  await expect(page.locator('body')).not.toContainText('[B]');
}

// The error bar is the only place a page pass says why it stopped, and an
// account error's way out is the button inside it: all of it on screen.
async function expectBarOnScreen(page) {
  const box = await page.locator('#ai-translator-progress').boundingBox();
  const { width, height } = page.viewportSize();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  // Not flush against the edge either: the bar keeps its 10 px margin (a little
  // less on the box while the entry animation's scale is still settling).
  expect(box.x + box.width).toBeLessThanOrEqual(width - 8);
  expect(box.y + box.height).toBeLessThanOrEqual(height - 8);
}

const barEntry = (page) => page.locator('#ai-translator-progress [data-account-action]');

function storedToken(context) {
  return getServiceWorker(context).then((worker) => worker.evaluate(
    () => chrome.storage.local.get('comicToken').then((r) => r.comicToken || '')));
}

async function openPopupOver(context, extensionId, page) {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  // goto() fronted the popup's tab; give the window back to the page and let
  // the popup ask again, so "the active tab" is the page under test.
  await page.bringToFront();
  await popup.reload();
  return popup;
}

// Select the text of `selector` with the mouse and open the card from the icon.
async function openCardOn(page, selector) {
  const box = await page.locator(selector).boundingBox();
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + 1, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 1, y, { steps: 5 });
  await page.mouse.up();
  const icon = page.locator('#ai-translator-selection-btn .ai-translator-selection-icon');
  await expect(icon).toBeVisible();
  await icon.click();
  return page.locator('.ai-translator-popup');
}

async function openOptions(context, extensionId) {
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options/options.html`);
  return options;
}

module.exports = {
  en,
  ORIGIN,
  walkShot,
  setUp,
  openPage,
  translatePage,
  expectPassStopped,
  expectBarOnScreen,
  barEntry,
  storedToken,
  openPopupOver,
  openCardOn,
  openOptions,
};
