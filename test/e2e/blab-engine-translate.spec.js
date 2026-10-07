// Blab Translation end to end (design §6 journeys J1–J3, §7): the extension
// against a stub of the account service's §2 contract
// (test/e2e/mock-blab-service.js), with a working AI profile configured beside
// it on a second mock. That second mock is the witness for "never falls back":
// any request that reaches it while Blab is the engine is a bug.
//
// Everything on the extension's side is real: the token in
// chrome.storage.local, the worker's account cache and /api/blab/complete
// client, the prompts and the parsing of the answer, the page cache, the card
// and the settings page.
//
// BLAB_WALK_DIR, when set, is where each journey leaves its screenshot (the
// walk evidence); unset, nothing is written.
const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('./fixtures');
const {
  connectExtension,
  setExtensionSettings,
  getSyncSettings,
  stubBuiltinTranslator,
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
  await page.screenshot({ path: path.join(walkDir, `${name}.png`) });
}

/**
 * Both mocks up, the extension pointed at the Blab one, the user's own AI
 * profile pointed at the other, and the page served. The caller closes both.
 */
async function setUp(context, page, { mode = 'available', signedIn = true, engine = 'blab', used = 0 } = {}) {
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

const count = (n) => n.toLocaleString('en');

test.describe('J1 Blab Translation with a plan', () => {
  test('chosen in settings, it translates the page, a selection and a word, caches, and the count moves', async ({ context, page, extensionId }) => {
    test.setTimeout(120000);
    const { blab, ai, close } = await setUp(context, page);
    try {
      // J1 1–2: the option can be chosen and the note says where the text goes
      // and how much of today's allowance is left, both numbers from billing/me.
      let options = await openOptions(context, extensionId);
      await expect(options.locator('#translationEngine option[value="blab"]')).toBeEnabled();
      await expect(options.locator('#translationEngine')).toHaveValue('blab');
      const note = options.locator('#translationEngineBlabNote');
      await expect(note).toHaveText(en('blabNoteAvailable')
        .replace('{limit}', count(1000000)).replace('{used}', count(0)));
      await expect(note).not.toHaveClass(/blab-note-warning/);
      await walkShot(options, 'J1-1-2-settings-available');
      await options.close();

      // J1 3–4: the page goes to /api/blab/complete with the account's bearer,
      // inline markup survives, and nothing reaches the user's own AI.
      await openPage(page);
      await translatePage(page);
      expect(blab.state.completeRequests.length).toBeGreaterThan(0);
      for (const request of blab.state.completeRequests) {
        expect(request.authorization).toBe('Bearer test-token');
        // §2.1's body and nothing else; temperature only as the caller gave it (D-482).
        const { system, user, maxTokens, temperature, ...rest } = request.body;
        expect(rest).toEqual({});
        expect([typeof system, typeof user, typeof maxTokens]).toEqual(['string', 'string', 'number']);
        if (temperature !== undefined) expect(typeof temperature).toBe('number');
      }
      expect(ai.sentTexts).toHaveLength(0);
      const rich = page.locator('#rich + .ai-translator-inline-block');
      await expect(rich.locator('a[href="/docs"]')).toHaveText('the documentation');
      await expect(rich.locator('strong')).toHaveText('start working');
      const richText = await rich.textContent();
      expect(richText).not.toMatch(/\{\d+\}|<\/?[a-z]+\d+>/i);
      await walkShot(page, 'J1-3-4-page-translated');

      // J1 5: a word in the card is a dictionary entry, answered by Blab.
      const card = await openCardOn(page, '#word');
      await expect(card.locator('.ai-translator-dict-entry')).toBeVisible({ timeout: 20000 });
      await expect(card.locator('.ai-translator-dict-ipa')).toHaveText('/rʌn/');
      await expect(card.locator('.ai-translator-dict-defs')).toHaveText('跑; 奔跑');
      await expect(card.locator('.ai-translator-engine-tag')).toHaveText(en('cardEngineBlab'));
      expect(ai.sentTexts).toHaveLength(0);
      await walkShot(page, 'J1-5-card-dictionary-entry');
      await page.keyboard.press('Escape');

      // J1 6: a reload translates the same page from the cache, with not one
      // new request. The flush is batched, so give it time to land first.
      await page.waitForTimeout(1500);
      const sentBefore = blab.state.completeRequests.length;
      await page.reload();
      await waitForFloatBall(page);
      await translatePage(page);
      expect(blab.state.completeRequests.length).toBe(sentBefore);
      expect(ai.sentTexts).toHaveLength(0);
      await walkShot(page, 'J1-6-page-from-cache');

      // J1 7: the settings page reads the account fresh and shows what was spent.
      expect(blab.state.used).toBeGreaterThan(0);
      options = await openOptions(context, extensionId);
      await expect(options.locator('#translationEngineBlabNote')).toHaveText(en('blabNoteAvailable')
        .replace('{limit}', count(1000000)).replace('{used}', count(blab.state.used)));
      await walkShot(options, 'J1-7-settings-used-moved');
      await options.close();
    } finally {
      await close();
    }
  });
});

test.describe('J2 Blab Translation without a plan', () => {
  test('signed out: the option is disabled and the note offers sign-in', async ({ context, page, extensionId }) => {
    const { close } = await setUp(context, page, { signedIn: false, engine: 'ai' });
    try {
      const options = await openOptions(context, extensionId);
      for (const id of ['translationEngine', 'autoTranslateEngine']) {
        await expect(options.locator(`#${id} option[value="blab"]`)).toBeDisabled();
        const note = options.locator(`#${id}BlabNote`);
        await expect(note.locator('.blab-note-text')).toHaveText(en('blabNoteSignedOut'));
        await expect(note.locator('button')).toHaveText(en('comicSignIn'));
      }
      await walkShot(options, 'J2-1-settings-signed-out');
      await options.close();
    } finally {
      await close();
    }
  });

  test('no plan: the option is disabled, the note links to pricing, and the service refuses', async ({ context, page, extensionId }) => {
    const { blab, close } = await setUp(context, page, { mode: 'plan_required', engine: 'ai' });
    try {
      const options = await openOptions(context, extensionId);
      await expect(options.locator('#translationEngine option[value="blab"]')).toBeDisabled();
      const note = options.locator('#translationEngineBlabNote');
      await expect(note.locator('.blab-note-text')).toHaveText(en('blabNotePlanRequired'));
      const link = note.locator('a');
      await expect(link).toHaveText(en('blabSubscribe'));
      expect(await link.getAttribute('href')).toMatch(/\/app\/pricing$/);
      await walkShot(options, 'J2-2-settings-no-plan');
      await options.close();

      // The service's side of the same answer, as the contract has it.
      const response = await fetch(`${blab.base}/api/blab/complete`, {
        method: 'POST',
        headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
        body: JSON.stringify({ system: '', user: 'x', maxTokens: 16 }),
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'plan_required' });
    } finally {
      await close();
    }
  });

  test('plan lapsed after choosing Blab: the choice is kept and flagged, and the page stops with the reason', async ({ context, page, extensionId }) => {
    const { blab, ai, close } = await setUp(context, page);
    try {
      blab.state.mode = 'plan_required';

      const options = await openOptions(context, extensionId);
      await expect(options.locator('#translationEngine')).toHaveValue('blab');
      const note = options.locator('#translationEngineBlabNote');
      await expect(note).toHaveClass(/blab-note-warning/);
      await expect(note.locator('.blab-note-text').first()).toHaveText(en('blabNoteSelectedUnavailable'));
      await walkShot(options, 'J2-3-settings-lapsed-kept');
      await options.close();
      expect(await getSyncSettings(context, ['translationEngine'])).toEqual({ translationEngine: 'blab' });

      await openPage(page);
      await triggerPageTranslation(page);
      await expectPassStopped(page, en('blabPlanRequired'));
      expect(blab.state.completeRequests).toHaveLength(1);
      expect(ai.sentTexts).toHaveLength(0);
      await walkShot(page, 'J2-3-page-plan-required');
    } finally {
      await close();
    }
  });
});

test.describe('J3 Blab Translation over the daily allowance', () => {
  test('one request, the reset time in the message, and nothing translated', async ({ context, page }) => {
    const { blab, ai, close } = await setUp(context, page, { mode: 'daily_limit' });
    try {
      await openPage(page);
      await triggerPageTranslation(page);
      const [before, after] = en('blabDailyLimit').split('{time}');
      await expectPassStopped(page, before);
      const message = await page.locator('#ai-translator-progress .ai-translator-progress-error-text').textContent();
      const time = message.slice(message.indexOf(before) + before.length, message.lastIndexOf(after));
      expect(time.trim()).toMatch(/\d/);
      expect(blab.state.completeRequests).toHaveLength(1);
      expect(ai.sentTexts).toHaveLength(0);
      await walkShot(page, 'J3-page-daily-limit');
    } finally {
      await close();
    }
  });
});

test.describe('§7 the other engines never reach Blab', () => {
  test('built-in engine: the page is translated with no request to the service', async ({ context, page }) => {
    const { blab, ai, close } = await setUp(context, page, { engine: 'builtin' });
    try {
      await openPage(page);
      await stubBuiltinTranslator(page);
      await triggerPageTranslation(page);
      await expect(page.locator('#rich + .ai-translator-inline-block')).toContainText('[B]', { timeout: 30000 });
      await page.waitForSelector('#ai-translator-progress', { state: 'hidden', timeout: 30000 });
      expect(blab.state.completeRequests).toHaveLength(0);
      expect(ai.sentTexts).toHaveLength(0);
    } finally {
      await close();
    }
  });

  test('own AI: the page goes to the user\'s endpoint with no request to the service', async ({ context, page }) => {
    const { blab, ai, close } = await setUp(context, page, { engine: 'ai' });
    try {
      await openPage(page);
      await translatePage(page);
      expect(ai.sentTexts.length).toBeGreaterThan(0);
      expect(blab.state.completeRequests).toHaveLength(0);
    } finally {
      await close();
    }
  });
});
