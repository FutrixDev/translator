/**
 * A page that forces display on every descendant, the way reddit's feed card does:
 *
 *   shreddit-post .feed-card-text-preview :not(ol,ul,li,h1) {
 *     all: revert; display: inline !important; margin: 0; padding: 0;
 *   }
 *
 * At (0,2,2) that rule used to beat every display rule of ours — the base rule
 * (0,1,0) and the hide rule (0,2,0) — so each translation ran on inline after its
 * paragraph, "hide translations" left them on screen, and translation-only left the
 * originals on screen. The display rules now sit in a cascade layer
 * (content/css/translation.css, guarded by test/unit/translation-display-layer.test.mjs);
 * these journeys assert what that buys on a real page, through computed styles — the
 * other hide specs only check the class, and the class was there all along.
 *
 * The flair before the first paragraph makes that paragraph start mid-line, the shape
 * whose text inset used to be measured from the bounding box of all its line boxes and
 * came out as a 150px gap in front of the translation.
 */
const { test, expect } = require('./fixtures');
const { startMockOpenAIServer } = require('./mock-openai-server');
const {
  setExtensionSettings,
  triggerPageTranslation,
  openFloatBallMenu,
  writeSyncSettings,
} = require('./helpers');

const ORIGIN = 'https://feed.test';

const PARAGRAPHS = Object.freeze([
  'Finding the right editor has become ten times harder than making the content itself, and it is burning me out.',
  'Every time I open my messages hoping for a serious editor, it is people with no portfolio or people who vanish after two replies.',
  'If you have dealt with this before, I would really appreciate any advice that helped you get past it.',
]);

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Feed</title>
<style>
  body { margin: 0; font: 16px/1.5 sans-serif; }
  shreddit-post { display: block; width: 420px; margin: 16px; }
  shreddit-post .feed-card-text-preview :not(ol,ul,li,h1) {
    all: revert; display: inline !important; margin: 0; padding: 0;
  }
</style></head>
<body>
<shreddit-post>
  <div id="preview" class="feed-card-text-preview"><span class="flair">Discussion</span> ${
  PARAGRAPHS.map((text, i) => `<p id="p${i + 1}">${text}</p>`).join('')}</div>
</shreddit-post>
</body></html>`;

async function openFeed(page, context, endpoint, settings = {}) {
  await setExtensionSettings(page, {
    apiEndpoint: endpoint,
    apiKey: 'test-key',
    modelName: 'gpt-4.1-mini',
    targetLang: 'zh-CN',
    skipTargetLanguageText: false,
    autoTranslate: false,
    pageTranslateScope: 'page',
    ...settings,
  });
  await context.route(`${ORIGIN}/**`, (route) => {
    route.fulfill({ status: 200, contentType: 'text/html', body: PAGE });
  });
  await page.goto(`${ORIGIN}/r/VideoEditors/`);
  await page.waitForSelector('#ai-translator-float-ball');
  await triggerPageTranslation(page);
  for (let i = 1; i <= PARAGRAPHS.length; i += 1) {
    await expect(page.locator(`#p${i} + .ai-translator-inline-block`)).toHaveCount(1, { timeout: 30000 });
  }
  await page.waitForSelector('#ai-translator-progress', { state: 'hidden', timeout: 30000 });
}

/** display and the start-side padding of each paragraph and the translation after it. */
function layout(page) {
  return page.evaluate((count) => {
    const rows = [];
    for (let i = 1; i <= count; i += 1) {
      const source = document.getElementById(`p${i}`);
      const translation = source.nextElementSibling;
      const box = translation.getBoundingClientRect();
      rows.push({
        sourceDisplay: getComputedStyle(source).display,
        display: getComputedStyle(translation).display,
        paddingLeft: parseFloat(getComputedStyle(translation).paddingLeft),
        startsLine: box.left - document.getElementById('preview').getBoundingClientRect().left,
        belowSource: box.top >= source.getClientRects()[source.getClientRects().length - 1].bottom - 1,
      });
    }
    return rows;
  }, PARAGRAPHS.length);
}

test('a page rule forcing display:inline !important does not pull translations inline', async ({ page, context }) => {
  const { endpoint, close } = await startMockOpenAIServer();
  try {
    await openFeed(page, context, endpoint);
    const rows = await layout(page);
    for (const row of rows) {
      // The page still owns its own paragraphs; only our node is taken back.
      expect(row.sourceDisplay).toBe('inline');
      expect(row.display).toBe('block');
      // A line of its own, under the paragraph, starting at the column's edge…
      expect(row.belowSource).toBe(true);
      expect(Math.abs(row.startsLine)).toBeLessThan(1);
      // …with no inset measured off the paragraph's first line box starting mid-line.
      expect(row.paddingLeft).toBeLessThan(1);
    }
  } finally {
    await close();
  }
});

test('"hide translations" hides them through the page rule, and brings them back', async ({ page, context }) => {
  const { endpoint, close } = await startMockOpenAIServer();
  try {
    await openFeed(page, context, endpoint);
    // Every translation in the card, the flair's inline one included.
    const translations = page.locator('#preview .ai-translator-inline-block');
    const displays = () => translations.evaluateAll((els) => els.map((el) => getComputedStyle(el).display));
    const count = await translations.count();
    expect(count).toBeGreaterThanOrEqual(PARAGRAPHS.length);

    await openFloatBallMenu(page);
    await page.click('.ai-translator-menu-item[data-action="toggle-translations"]');
    await expect(translations.first()).toHaveClass(/ai-translator-hidden/);
    await expect.poll(displays).toEqual(Array(count).fill('none'));

    await openFloatBallMenu(page);
    await page.click('.ai-translator-menu-item[data-action="toggle-translations"]');
    await expect.poll(displays).not.toContain('none');
    const rows = await layout(page);
    for (const row of rows) expect(row.display).toBe('block');
  } finally {
    await close();
  }
});

test('translation-only hides the originals through the page rule', async ({ page, context }) => {
  const { endpoint, close } = await startMockOpenAIServer();
  try {
    await openFeed(page, context, endpoint);
    const sourceDisplays = () => page.evaluate((count) => Array.from({ length: count },
      (_, i) => getComputedStyle(document.getElementById(`p${i + 1}`)).display), PARAGRAPHS.length);

    await writeSyncSettings(context, { showTranslationOnly: true });
    await expect.poll(sourceDisplays).toEqual(PARAGRAPHS.map(() => 'none'));
    const translationDisplays = await page.evaluate((n) => Array.from({ length: n },
      (_, i) => getComputedStyle(document.getElementById(`p${i + 1}`).nextElementSibling).display), PARAGRAPHS.length);
    expect(translationDisplays).toEqual(PARAGRAPHS.map(() => 'block'));

    await writeSyncSettings(context, { showTranslationOnly: false });
    await expect.poll(sourceDisplays).toEqual(PARAGRAPHS.map(() => 'inline'));
  } finally {
    await close();
  }
});
