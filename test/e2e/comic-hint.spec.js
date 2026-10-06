/**
 * The comic hint (content/content-media-hints.js, D-353): a reader page — at
 * least three comic pages stacked top to bottom — gets one bar naming the
 * media shortcut, once per site. A second visit, an article with one big
 * picture, a feed of pictures a post apart, or a column of thumbnails gets
 * nothing.
 *
 * A reader whose pages are all below the fold gets it once they are scrolled
 * to: the button acts on the page on screen, so before then it would act on
 * nothing.
 *
 * The first block is signed out on purpose: the hint is for the user who has
 * not found the feature yet, and nothing there is sent to the comic service (no
 * job, no upload) — the only message is the worker-side claim of the host. The
 * second block is signed in against the mock service, to count the jobs: none
 * before the click, one after it.
 */
const { test, expect } = require('./fixtures');
const {
  connectExtension, getServiceWorker, openFloatBallMenu, setExtensionAccount, waitForFloatBall,
} = require('./helpers');
const { SOURCE_PNG, startMockService } = require('./comic-fixtures');

const READER = 'https://comics-reader.test';
const ARTICLE = 'https://picture-article.test';
const FEED = 'https://picture-feed.test';
const CARDS = 'https://thumbnail-column.test';
const BELOW = 'https://reader-below-fold.test';
const BAR = '#ai-translator-auto-bar';
const OFFER = `${BAR}[data-mode="offer"]`;

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
  // A chapter page with its synopsis and comments above the strip.
  await context.route(`${BELOW}/read/1`, (r) => r.fulfill({
    contentType: 'text/html',
    body: page(`<div style="height:2000px">Chapter notes and comments.</div>${[1, 2, 3].map(pageImg).join('')}`),
  }));
  for (const origin of [READER, ARTICLE, FEED, CARDS, BELOW]) {
    await context.route(`${origin}/p*.png`, (r) => r.fulfill({ contentType: 'image/png', body: SOURCE_PNG }));
  }
}

function decodedImages(tab) {
  return tab.evaluate(() => Array.from(document.images).filter((img) => img.complete && img.naturalWidth > 0).length);
}

function hintHosts(context) {
  return getServiceWorker(context).then((worker) =>
    worker.evaluate(() => chrome.storage.sync.get('comicHintHosts').then((r) => r.comicHintHosts || [])));
}

test.describe('Comic hint', () => {
  test('a reader page gets the hint once; the same site after a reload does not', async ({ context, page: tab }) => {
    await route(context);
    await tab.goto(`${READER}/read/1`);

    const bar = tab.locator(OFFER);
    await expect(bar).toBeVisible({ timeout: 15000 });
    await expect(bar.locator('.ai-translator-auto-text')).toHaveText(/(Alt\+|⌥)M/);
    expect(await hintHosts(context)).toEqual(['comics-reader.test']);

    await tab.reload();
    await waitForFloatBall(tab);
    // The page is up and the hint had its chance: the detection runs at load,
    // on the next frame and on the window load event.
    await tab.waitForLoadState('load');
    await tab.waitForTimeout(1500);
    await expect(tab.locator(OFFER)).toBeHidden();
    expect(await hintHosts(context)).toEqual(['comics-reader.test']);
  });

  test('the hint steps aside while a video fills the screen, and comes back', async ({ context, page: tab }) => {
    // The same bar carries the PDF hint, the explain line and the notice; it
    // asks ctx.videoStage the float ball's question. Web fullscreen here (the
    // player restyles itself over the viewport): no event fires, so this is
    // the stage's poll at work, not a fullscreenchange listener.
    await route(context);
    await tab.goto(`${READER}/read/1`);
    const bar = tab.locator(`${BAR}[data-mode="offer"]`);
    await expect(bar).toBeVisible({ timeout: 15000 });
    const text = await bar.locator('.ai-translator-auto-text').textContent();

    const b = await bar.boundingBox();
    const centre = [b.x + b.width / 2, b.y + b.height / 2];
    const paintedAt = () => tab.evaluate(([x, y]) => {
      const hit = document.elementFromPoint(x, y);
      return hit && hit.closest('#ai-translator-auto-bar') ? 'bar' : hit && hit.tagName;
    }, centre);
    expect(await paintedAt()).toBe('bar');

    const FILLED = 'position:fixed;inset:0;width:100vw;height:100vh;z-index:100000;background:#000';
    await tab.evaluate((css) => {
      const player = document.createElement('div');
      player.id = 'player';
      player.style.cssText = css;
      player.innerHTML = '<video style="width:100%;height:100%;background:#000"></video>';
      document.body.appendChild(player);
    }, FILLED);
    await expect(tab.locator(BAR)).toBeHidden();
    // Where the hint was, the reader now sees the video.
    expect(await paintedAt()).toBe('VIDEO');

    await tab.evaluate(() => { document.getElementById('player').style.cssText = 'width:480px;height:270px'; });
    await expect(bar).toBeVisible();
    await expect(bar.locator('.ai-translator-auto-text')).toHaveText(text);
    expect(await paintedAt()).toBe('bar');
  });

  test('a page with one big picture is not a comic reader', async ({ context, page: tab }) => {
    await route(context);
    await tab.goto(`${ARTICLE}/story`);
    await waitForFloatBall(tab);
    await tab.waitForLoadState('load');
    await tab.mouse.wheel(0, 400);
    await tab.waitForTimeout(1500);
    await expect(tab.locator(OFFER)).toBeHidden();
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
    await expect(tab.locator(OFFER)).toBeHidden();
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
    await expect(tab.locator(OFFER)).toBeHidden();
    expect(await hintHosts(context)).toEqual([]);
  });

  test('a reader below the fold gets the hint only once its pages are scrolled to', async ({ context, page: tab }) => {
    await route(context);
    await tab.goto(`${BELOW}/read/1`);
    await waitForFloatBall(tab);
    await tab.waitForLoadState('load');
    // A reader in every way, three decoded pages stacked flush, but 2000 px down.
    await expect.poll(() => decodedImages(tab)).toBe(3);
    await tab.waitForTimeout(1500);
    await expect(tab.locator(OFFER)).toBeHidden();
    // Not claimed either: a claim spent here would be the site's only hint,
    // offered when its button had nothing to act on.
    expect(await hintHosts(context)).toEqual([]);

    await tab.evaluate(() => document.images[0].scrollIntoView());
    await expect(tab.locator(OFFER)).toBeVisible({ timeout: 15000 });
    expect(await hintHosts(context)).toEqual(['reader-below-fold.test']);
  });

  test('signing in on an open reader page brings the comic entry without a reload', async ({ context, page: tab }) => {
    await route(context);
    const worker = await getServiceWorker(context);
    await worker.evaluate(() => chrome.storage.sync.set({ enableComicTranslation: true }));
    await setExtensionAccount(tab, false);
    await tab.goto(`${READER}/read/1`);
    await waitForFloatBall(tab);
    await expect.poll(() => decodedImages(tab)).toBe(3);
    const comicRow = tab.locator('#ai-translator-float-menu [data-action="translate-comic"]');

    await openFloatBallMenu(tab);
    await expect(comicRow).toHaveCount(0);
    await tab.keyboard.press('Escape');
    await expect(tab.locator('#ai-translator-float-menu')).toHaveCount(0);

    // The sign-in lands in another tab (the popup, the hint's own sign-in); this
    // page hears it only through storage. The menu is drawn when it opens, so
    // each look opens it afresh.
    await setExtensionAccount(tab, true);
    await expect.poll(async () => {
      await openFloatBallMenu(tab);
      const rows = await comicRow.count();
      await tab.keyboard.press('Escape');
      await expect(tab.locator('#ai-translator-float-menu')).toHaveCount(0);
      return rows;
    }, { timeout: 5000 }).toBe(1);
  });
});

test.describe('Comic hint, signed in', () => {
  let service;
  test.beforeEach(async () => { service = await startMockService('succeed'); });
  test.afterEach(async () => { await service.close(); });

  // The strip comes from the mock service itself: the worker fetches the page
  // image for the job, and a worker fetch never sees context.route.
  async function routeStack(context) {
    const strip = [1, 2, 3]
      .map((n) => `<img src="/source.png?page=${n}" width="600" height="900" style="display:block">`)
      .join('');
    await context.route(`${service.base}/stack`, (r) => r.fulfill({ contentType: 'text/html', body: page(strip) }));
    return `${service.base}/stack`;
  }

  test('nothing is ordered until the button is pressed, and then one page', async ({ context, page: tab }) => {
    await connectExtension(context, service.base);
    const url = await routeStack(context);
    await tab.goto(url);

    const bar = tab.locator(OFFER);
    await expect(bar).toBeVisible({ timeout: 15000 });
    // Signed in and switched on, the hint is still only an offer.
    await tab.waitForTimeout(1500);
    expect(service.state.createBodies).toHaveLength(0);

    await bar.locator('[data-act="translate"]').click();
    await expect.poll(() => service.state.createBodies.length, { timeout: 15000 }).toBe(1);
    await expect(bar).toBeHidden();
    // One page on screen, one job: not one per page in the strip.
    await tab.waitForTimeout(1500);
    expect(service.state.createBodies).toHaveLength(1);
  });

  test('switched off, the shortcut is consent for this page: the job runs, the switch stays off', async ({ context, page: tab }) => {
    const worker = await connectExtension(context, service.base);
    await worker.evaluate(() => chrome.storage.sync.set({ enableComicTranslation: false }));
    const url = await routeStack(context);
    await tab.goto(url);
    await waitForFloatBall(tab);
    await expect.poll(() => decodedImages(tab)).toBe(3);
    await expect(tab.locator(OFFER)).toBeHidden();

    // Alt+M, as background/commands.js delivers it: a native key Playwright
    // cannot press on the extension's behalf.
    const reply = await worker.evaluate(async (pageUrl) => {
      const [target] = await chrome.tabs.query({ url: pageUrl });
      return chrome.tabs.sendMessage(target.id, { type: 'MEDIA_SHORTCUT' });
    }, url);
    expect(reply).toEqual({ kind: 'comic' });
    await expect.poll(() => service.state.createBodies.length, { timeout: 15000 }).toBe(1);
    expect(await worker.evaluate(() => chrome.storage.sync.get('enableComicTranslation')))
      .toEqual({ enableComicTranslation: false });
  });
});
