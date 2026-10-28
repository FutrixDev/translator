/**
 * The progress pill a running comic job shows, and the card under it.
 *
 * 跑着的漫画任务只占图片右上角一枚小标：页面中央不能有我们的任何元素，标不超过
 * 220×40、不超过图面积 6%，数字两秒内至少动一次；悬浮条在任务期间不出；点标打开
 * 卡片（计时、取消），要读者回答的（登录、扣费）卡片自己打开；卡片在标下方、右对齐、
 * 不超过 280 宽、没有遮罩。服务是 comic-fixtures.js
 * 里那台模拟的。
 */
const { test, expect } = require('./fixtures');
const { connectExtension } = require('./helpers');
const {
  startMockService, openComicPage, triggerComicTranslation, triggerComicPageTranslation,
} = require('./comic-fixtures');

const ROOT = '.ai-translator-comic-progress';
const PILL = `${ROOT} .ai-translator-comic-pill`;
const CARD = `${ROOT} .ai-translator-comic-card`;
const OURS = '[class*="ai-translator"], [id^="ai-translator"]';

/** Every element of ours under the image's centre, top to bottom. */
function oursAtCentre(page, selector = '#comic') {
  return page.locator(selector).evaluate((img, ours) => {
    const rect = img.getBoundingClientRect();
    return document.elementsFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
      .filter(element => element.matches(ours))
      .map(element => element.className || element.id);
  }, OURS);
}

/**
 * Every state the pill shows — busy or not, and its words — from before the
 * job is asked for.
 */
function recordPill(page) {
  return page.evaluate((root) => {
    window.__pillStates = [];
    new MutationObserver(() => {
      const element = document.querySelector(root);
      if (!element) return;
      const label = element.querySelector('.ai-translator-comic-label');
      const state = { busy: element.classList.contains('is-busy'), label: label ? label.textContent : '' };
      const seen = window.__pillStates;
      const last = seen[seen.length - 1];
      if (!last || last.busy !== state.busy || last.label !== state.label) seen.push(state);
    }).observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
  }, ROOT);
}

/**
 * From the click the pill reads as translating, ring spinning; when the card
 * asks, it stops and says what it waits for.
 */
async function expectTranslatingThenWaiting(page, waitLabel) {
  const states = await page.evaluate(() => window.__pillStates);
  const asked = states.findIndex(state => state.label === waitLabel);
  expect(asked).toBeGreaterThan(0);
  expect(states[0]).toEqual({ busy: true, label: 'Translating the comic…' });
  expect(states[asked].busy).toBe(false);
}

/** The open card hangs under the pill, right-aligned, no wider than 280, with no backdrop. */
async function expectCardUnderPill(page) {
  const card = page.locator(CARD);
  await expect(card).toBeVisible();
  const pillBox = await page.locator(PILL).boundingBox();
  const cardBox = await card.boundingBox();
  expect(cardBox.width).toBeLessThanOrEqual(280);
  expect(cardBox.y).toBeGreaterThanOrEqual(pillBox.y + pillBox.height);
  expect(Math.abs(cardBox.x + cardBox.width - (pillBox.x + pillBox.width))).toBeLessThanOrEqual(1);
  expect(await oursAtCentre(page)).toEqual([]);
  const widest = await page.locator(ROOT).evaluate(root => root.getBoundingClientRect().width);
  expect(widest).toBeLessThanOrEqual(280);
}

test.describe('Comic progress pill', () => {
  test('a running job holds the top-right corner and leaves the page readable', async ({ context, page }) => {
    const service = await startMockService('succeed', { succeedAfterMs: 12_000 });
    try {
      const worker = await connectExtension(context, service.base);
      await openComicPage(page, service);
      await triggerComicTranslation(worker, page, `${service.base}/page`, `${service.base}/source.png`);

      const pill = page.locator(PILL);
      await expect(pill).toBeVisible();
      await expect(page.locator(`${ROOT} .ai-translator-comic-spinner`)).toBeVisible();
      expect(await oursAtCentre(page)).toEqual([]);

      const img = await page.locator('#comic').boundingBox();
      const box = await pill.boundingBox();
      expect(box.width).toBeLessThanOrEqual(220);
      expect(box.height).toBeLessThanOrEqual(40);
      expect(box.width * box.height).toBeLessThanOrEqual(img.width * img.height * 0.06);
      expect(Math.abs(img.x + img.width - 8 - (box.x + box.width))).toBeLessThanOrEqual(1);
      expect(Math.abs(img.y + 8 - box.y)).toBeLessThanOrEqual(1);

      // The ring is what says the job is alive: once the job reports a
      // figure it fills, and the fill moves within any 2 s.
      const ring = page.locator(`${ROOT} .ai-translator-comic-spinner`);
      await expect(ring).toHaveClass(/is-filling/);
      const fill = () => ring.evaluate(el => el.style.getPropertyValue('--ai-translator-comic-fill'));
      const samples = [await fill()];
      for (let i = 0; i < 2; i++) {
        await page.waitForTimeout(2000);
        samples.push(await fill());
      }
      expect(samples[1]).not.toBe(samples[0]);
      expect(samples[2]).not.toBe(samples[1]);
      samples.forEach(sample => expect(Number(sample)).toBeLessThan(1));

      // The hover bar would cover the page the pill is keeping clear.
      await page.locator('#comic').hover();
      await page.waitForTimeout(500);
      await expect(page.locator('#ai-translator-image-hover-bar')).toHaveCount(0);
      expect(await oursAtCentre(page)).toEqual([]);

      // Done: the pill goes, the badge takes the other corner, the page is replaced.
      await expect(page.locator('#comic')).toHaveAttribute('src', /\/result\.png\?sig=/, { timeout: 30_000 });
      await expect(page.locator(ROOT)).toHaveCount(0);
      await expect(page.locator('.ai-translator-comic-badge')).toBeVisible();
    } finally {
      await service.close();
    }
  });

  test('the upload already reads as translating, and the result download names its stage', async ({ context, page }) => {
    const service = await startMockService('succeed', { uploadDelayMs: 4_500, resultDelayMs: 4_500 });
    try {
      const worker = await connectExtension(context, service.base);
      await openComicPage(page, service);
      // What the pill says every 250 ms: its stage word, and whether the ring spins.
      await page.evaluate((root) => {
        window.__signal = [];
        const t0 = performance.now();
        setInterval(() => {
          const element = document.querySelector(root);
          const img = document.getElementById('comic');
          window.__signal.push({
            t: Math.round(performance.now() - t0),
            label: element ? element.querySelector('.ai-translator-comic-label').textContent : null,
            busy: element ? element.classList.contains('is-busy') : null,
            result: /\/result\.png/.test(img.currentSrc || img.src),
          });
        }, 250);
      }, ROOT);
      await triggerComicTranslation(worker, page, `${service.base}/page`, `${service.base}/source.png`);

      const label = page.locator(`${ROOT} .ai-translator-comic-label`);
      const ring = page.locator(`${ROOT} .ai-translator-comic-spinner`);
      // The bytes are on their way and no job exists yet: already translating,
      // the ring spinning with nothing to fill.
      await expect(label).toHaveText('Translating the comic…');
      await expect(ring).toBeVisible();
      await expect(ring).not.toHaveClass(/is-filling/);
      expect(service.state.createBodies).toHaveLength(0);
      // The job is done and the page is still the original: the result is loading.
      await expect(label).toHaveText('Loading result…', { timeout: 15_000 });
      await expect(page.locator('#comic')).not.toHaveAttribute('src', /\/result\.png/);
      await expect(page.locator('#comic')).toHaveAttribute('src', /\/result\.png\?sig=/, { timeout: 15_000 });

      const signal = await page.evaluate(() => window.__signal);
      const shown = signal.filter(sample => sample.label !== null && !sample.result);
      expect(shown.some(sample => sample.label === 'Uploading image…')).toBe(false);
      expect(shown[0].label).toBe('Translating the comic…');
      expect(shown.some(sample => sample.label === 'Loading result…')).toBe(true);
      // Busy from the click to the swap: the ring never stops.
      shown.forEach(sample => expect(sample.busy, JSON.stringify(sample)).toBe(true));
    } finally {
      await service.close();
    }
  });

  test('a click on the pill opens the card under it, and Cancel ends the job', async ({ context, page }) => {
    const service = await startMockService('succeed', { succeedAfterMs: 60_000 });
    try {
      const worker = await connectExtension(context, service.base);
      await openComicPage(page, service);
      await triggerComicTranslation(worker, page, `${service.base}/page`, `${service.base}/source.png`);

      const card = page.locator(CARD);
      const cancel = card.locator('.ai-translator-comic-btn');
      // Cancel is there before the first poll, folded away until asked for.
      await expect(cancel).toHaveCount(1);
      await expect(card).toBeHidden();

      await page.locator(PILL).click();
      await expect(card).toBeVisible();
      await expect(card.locator('.ai-translator-comic-timer')).toHaveText(/^\d+:\d{2}$/);
      await expect(cancel).toHaveText('Cancel');

      await expectCardUnderPill(page);

      // A second click folds it again.
      await page.locator(PILL).click();
      await expect(card).toBeHidden();

      await page.locator(PILL).click();
      await cancel.click();
      await expect(page.locator(ROOT)).toHaveCount(0);
      await expect.poll(() => service.state.abandoned.length).toBe(1);
      await expect(page.locator('#comic')).toHaveAttribute('src', '/source.png');
    } finally {
      await service.close();
    }
  });

  test('a charge is asked in the card under the pill, and saying yes starts the job', async ({ context, page }) => {
    const service = await startMockService('confirm');
    try {
      const worker = await connectExtension(context, service.base);
      await openComicPage(page, service);
      await recordPill(page);
      await triggerComicTranslation(worker, page, `${service.base}/page`, `${service.base}/source.png`);

      // The question opens the card by itself: the reader has to answer it.
      const card = page.locator(CARD);
      const approve = card.locator('.ai-translator-comic-btn.is-primary');
      await expect(approve).toHaveText('Use Credits');
      await expectCardUnderPill(page);
      // The pill says what it is waiting for, not that a redraw is under way.
      await expect(page.locator(`${ROOT} .ai-translator-comic-label`)).toHaveText('Awaiting confirmation');
      await expectTranslatingThenWaiting(page, 'Awaiting confirmation');
      expect(service.state.createBodies).toHaveLength(1);

      await approve.click();
      await expect(page.locator('#comic')).toHaveAttribute('src', /\/result\.png\?sig=/, { timeout: 20_000 });
      // A yes goes straight back to translating.
      const states = await page.evaluate(() => window.__pillStates);
      const answered = states.findIndex(state => state.label === 'Awaiting confirmation');
      expect(states[answered + 1]).toEqual({ busy: true, label: 'Translating the comic…' });
      // Yes is the same operation again, with the same upload, not a second one.
      const [asked, confirmed] = service.state.createBodies;
      expect(asked.confirmCharge).toBeFalsy();
      expect(confirmed.confirmCharge).toBe(true);
      expect(confirmed.operationId).toBe(asked.operationId);
      expect(confirmed.sourceKey).toBe(asked.sourceKey);
      expect(service.state.puts).toHaveLength(1);
    } finally {
      await service.close();
    }
  });

  test('signed out, the card under the pill signs in and the job goes on', async ({ context, page }) => {
    const service = await startMockService('succeed');
    try {
      const worker = await connectExtension(context, service.base, { signedIn: false });
      await openComicPage(page, service);
      await recordPill(page);
      await triggerComicTranslation(worker, page, `${service.base}/page`, `${service.base}/source.png`);

      const signIn = page.locator(`${CARD} .ai-translator-comic-btn.is-primary`);
      await expect(signIn).toHaveText('Sign In');
      await expectCardUnderPill(page);
      await expect(page.locator(`${ROOT} .ai-translator-comic-label`)).toHaveText('Sign-in needed');
      await expectTranslatingThenWaiting(page, 'Sign-in needed');

      await signIn.click();
      await expect(page.locator('#comic')).toHaveAttribute('src', /\/result\.png\?sig=/, { timeout: 20_000 });
      expect(service.state.connects).toBe(1);
      expect(service.state.createBodies).toHaveLength(1);
    } finally {
      await service.close();
    }
  });

  test('signed out on a charged page, signing in goes back to translating until the price is asked', async ({ context, page }) => {
    const service = await startMockService('confirm');
    try {
      const worker = await connectExtension(context, service.base, { signedIn: false });
      await openComicPage(page, service);
      await recordPill(page);
      await triggerComicTranslation(worker, page, `${service.base}/page`, `${service.base}/source.png`);

      const signIn = page.locator(`${CARD} .ai-translator-comic-btn.is-primary`);
      await expect(signIn).toHaveText('Sign In');
      await signIn.click();
      await expect(page.locator(`${ROOT} .ai-translator-comic-label`)).toHaveText('Awaiting confirmation', { timeout: 20_000 });
      // "Signing in…" is the sign-in itself; after it the pill translates again.
      const states = await page.evaluate(() => window.__pillStates);
      const signedIn = states.map(state => state.label).lastIndexOf('Signing in…');
      const asked = states.findIndex(state => state.label === 'Awaiting confirmation');
      expect(signedIn).toBeGreaterThan(-1);
      expect(asked).toBeGreaterThan(signedIn);
      // The sign-in was asked for by the upload; the pill goes back to translating.
      expect(states[signedIn + 1]).toEqual({ busy: true, label: 'Translating the comic…' });
      expect(service.state.createBodies).toHaveLength(1);
    } finally {
      await service.close();
    }
  });

  test('held at 95%, the ring stays nearly full inside its corner', async ({ context, page }) => {
    const service = await startMockService('succeed', { succeedAfterMs: 60_000, runningProgress: 0.95 });
    try {
      const worker = await connectExtension(context, service.base);
      await openComicPage(page, service);
      await triggerComicTranslation(worker, page, `${service.base}/page`, `${service.base}/source.png`);

      const ring = page.locator(`${ROOT} .ai-translator-comic-spinner`);
      await expect(ring).toHaveClass(/is-filling/, { timeout: 15_000 });
      await expect.poll(() => ring.evaluate(el => Number(el.style.getPropertyValue('--ai-translator-comic-fill'))),
        { timeout: 15_000 }).toBe(0.95);
      const box = await page.locator(PILL).boundingBox();
      expect(box.width).toBeLessThanOrEqual(220);
    } finally {
      await service.close();
    }
  });

  test('whole-page translation of a spread gives each page its own pill', async ({ context, page }) => {
    const service = await startMockService('succeed', { succeedAfterMs: 8_000 });
    try {
      const worker = await connectExtension(context, service.base);
      await openComicPage(page, service, '/spread');
      await triggerComicPageTranslation(worker, page, `${service.base}/spread`);

      await expect(page.locator(PILL)).toHaveCount(2);
      for (const id of ['#left', '#right']) {
        const img = await page.locator(id).boundingBox();
        const boxes = await page.locator(PILL).evaluateAll(pills => pills.map(p => p.getBoundingClientRect().toJSON()));
        // One pill in this image's own top-right corner.
        const inCorner = boxes.filter(box => Math.abs(img.x + img.width - 8 - box.right) <= 1
          && Math.abs(img.y + 8 - box.top) <= 1);
        expect(inCorner).toHaveLength(1);
        expect(await oursAtCentre(page, id)).toEqual([]);
      }

      await expect(page.locator('#left')).toHaveAttribute('src', /\/result\.png\?sig=/, { timeout: 30_000 });
      await expect(page.locator('#right')).toHaveAttribute('src', /\/result\.png\?sig=/, { timeout: 30_000 });
      await expect(page.locator(ROOT)).toHaveCount(0);
      await expect(page.locator('.ai-translator-comic-badge')).toHaveCount(2);
    } finally {
      await service.close();
    }
  });
});
