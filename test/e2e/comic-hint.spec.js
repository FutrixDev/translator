/**
 * The comic hint (content/content-media-hints.js, D-353): a reader page — at
 * least three comic pages stacked top to bottom — gets one bar naming the
 * media shortcut, once per site. A second visit, an article with one big
 * picture, a feed of pictures a post apart, or a column of thumbnails gets
 * nothing.
 *
 * Signed out on purpose: the hint is for the user who has not found the feature
 * yet, and nothing here is sent to the comic service (no job, no upload) — the
 * only message is the worker-side claim of the host.
 */
const { test, expect } = require('./fixtures');
const { getServiceWorker, waitForFloatBall } = require('./helpers');
const { SOURCE_PNG } = require('./comic-fixtures');

const READER = 'https://comics-reader.test';
const ARTICLE = 'https://picture-article.test';
const FEED = 'https://picture-feed.test';
const CARDS = 'https://thumbnail-column.test';
const BAR = '#ai-translator-auto-bar';

const page = (images) => `<!doctype html><html><body style="margin:0">
<main style="width:600px;margin:0 auto">${images}</main></body></html>`;
const pageImg = (n) => `<img src="/p${n}.png" width="600" height="900" style="display:block">`;
// A post in a feed: the picture X draws (506x285) under a post's worth of text.
const post = (n) => `<div style="height:800px">Post ${n}: a few lines of text, a name, a row of buttons.</div>
<img src="/p${n}.png" width="506" height="285" style="display:block">`;
// A sidebar of cards (sspai.com): 222x139 thumbnails, flush and centred.
const card = (n) => `<img src="/p${n}.png" width="222" height="139" style="display:block;margin:0 auto">`;

async function route(context) {
  await context.route(`${READER}/read/1`, (r) => r.fulfill({
    contentType: 'text/html', body: page([1, 2, 3].map(pageImg).join('')),
  }));
  await context.route(`${ARTICLE}/story`, (r) => r.fulfill({
    contentType: 'text/html', body: page(`<p>A story with one picture.</p>${pageImg(1)}`),
  }));
  await context.route(`${FEED}/home`, (r) => r.fulfill({
    contentType: 'text/html', body: page([1, 2, 3].map(post).join('')),
  }));
  await context.route(`${CARDS}/home`, (r) => r.fulfill({
    contentType: 'text/html', body: page([1, 2, 3, 4].map(card).join('')),
  }));
  for (const origin of [READER, ARTICLE, FEED, CARDS]) {
    await context.route(`${origin}/p*.png`, (r) => r.fulfill({ contentType: 'image/png', body: SOURCE_PNG }));
  }
}

function hintHosts(context) {
  return getServiceWorker(context).then((worker) =>
    worker.evaluate(() => chrome.storage.sync.get('comicHintHosts').then((r) => r.comicHintHosts || [])));
}

test.describe('Comic hint', () => {
  test('a reader page gets the hint once; the same site after a reload does not', async ({ context, page: tab }) => {
    await route(context);
    await tab.goto(`${READER}/read/1`);

    const bar = tab.locator(`${BAR}[data-mode="offer"]`);
    await expect(bar).toBeVisible({ timeout: 15000 });
    await expect(bar.locator('.ai-translator-auto-text')).toHaveText(/(Alt\+|⌥)M/);
    expect(await hintHosts(context)).toEqual(['comics-reader.test']);

    await tab.reload();
    await waitForFloatBall(tab);
    // The page is up and the hint had its chance: the detection runs at load,
    // on the next frame and on the window load event.
    await tab.waitForLoadState('load');
    await tab.waitForTimeout(1500);
    await expect(tab.locator(`${BAR}[data-mode="offer"]`)).toBeHidden();
    expect(await hintHosts(context)).toEqual(['comics-reader.test']);
  });

  test('a page with one big picture is not a comic reader', async ({ context, page: tab }) => {
    await route(context);
    await tab.goto(`${ARTICLE}/story`);
    await waitForFloatBall(tab);
    await tab.waitForLoadState('load');
    await tab.mouse.wheel(0, 400);
    await tab.waitForTimeout(1500);
    await expect(tab.locator(`${BAR}[data-mode="offer"]`)).toBeHidden();
    // Not even claimed: the claim is what marks a site as told.
    expect(await hintHosts(context)).toEqual([]);
  });

  test('a feed is a column of pictures, but too far apart to be a reader', async ({ context, page: tab }) => {
    await route(context);
    await tab.goto(`${FEED}/home`);
    await waitForFloatBall(tab);
    await tab.waitForLoadState('load');
    // Three pictures, all decoded, one centred above the next: everything a
    // reader has except the pages touching.
    expect(await tab.evaluate(() => Array.from(document.images)
      .filter((img) => img.complete && img.naturalWidth > 0).length)).toBe(3);
    await tab.mouse.wheel(0, 400);
    await tab.waitForTimeout(1500);
    await expect(tab.locator(`${BAR}[data-mode="offer"]`)).toBeHidden();
    expect(await hintHosts(context)).toEqual([]);
  });

  test('a flush column of thumbnails is not a reader either', async ({ context, page: tab }) => {
    await route(context);
    await tab.goto(`${CARDS}/home`);
    await waitForFloatBall(tab);
    await tab.waitForLoadState('load');
    // Four pictures, decoded, touching, one centred on the next: a reader in
    // every way but size.
    expect(await tab.evaluate(() => Array.from(document.images)
      .filter((img) => img.complete && img.naturalWidth > 0).length)).toBe(4);
    await tab.mouse.wheel(0, 400);
    await tab.waitForTimeout(1500);
    await expect(tab.locator(`${BAR}[data-mode="offer"]`)).toBeHidden();
    expect(await hintHosts(context)).toEqual([]);
  });
});
