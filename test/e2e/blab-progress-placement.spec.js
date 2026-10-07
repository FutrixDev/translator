// Where the page's bar lands next to the float ball (D-497 R1-B1/F2, M8,
// R1-N1). The bar is the only place a page pass says why it stopped, and a Blab
// account error's way out (the subscribe button) is inside it: wherever the ball
// sits, all of the bar is on screen and none of it lies over the ball.
//
// The ball is put where a user puts it, by dragging it with the mouse, and the
// pass is started by clicking it.
const { test, expect } = require('./fixtures');
const { writeSyncSettings } = require('./helpers');
const { en, ORIGIN, setUp, openPage, barEntry } = require('./blab-journey');

const VIEWPORTS = [{ width: 1280, height: 720 }, { width: 1280, height: 800 }];
const SPOTS = ['default', 'top-left', 'top-right', 'bottom-left', 'bottom-right'];

const ball = (page) => page.locator('#ai-translator-float-ball');
const bar = (page) => page.locator('#ai-translator-progress');

// The ball's drop glides 0.2 s and docks 50 ms later; the bar's entry
// animation scales it for 0.2 s. Measuring mid-flight measures neither where
// the ball is nor where the bar is.
async function settled(page) {
  await page.waitForFunction(() => {
    const els = ['ai-translator-float-ball', 'ai-translator-float-ball-container', 'ai-translator-progress']
      .map((id) => document.getElementById(id))
      .filter(Boolean);
    return els.every((el) => el.getAnimations().length === 0);
  });
}

async function dragBallTo(page, spot) {
  if (spot === 'default') return;
  const { width, height } = page.viewportSize();
  const target = {
    'top-left': [2, 2],
    'top-right': [width - 2, 2],
    'bottom-left': [2, height - 2],
    'bottom-right': [width - 2, height - 2],
  }[spot];
  const box = await ball(page).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(target[0], target[1], { steps: 12 });
  await page.mouse.up();
  // The dock lands in a timeout after the drop, then the glide runs.
  await expect(ball(page)).toHaveClass(/docked/);
  await settled(page);
}

async function clickBall(page) {
  const box = await ball(page).boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

// The bar, the ball and (docked) the ball's capsule, as the user sees them.
async function geometry(page) {
  return page.evaluate(() => {
    const rect = (id) => {
      const el = document.getElementById(id);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    };
    return {
      bar: rect('ai-translator-progress'),
      ball: rect('ai-translator-float-ball'),
      capsule: rect('ai-translator-float-ball-container'),
      width: window.innerWidth,
      height: window.innerHeight,
    };
  });
}

const intersects = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

function expectClearOfBall(geo, label) {
  const { bar: b } = geo;
  expect(b, label).not.toBeNull();
  expect(b.left, `${label}: left edge`).toBeGreaterThanOrEqual(0);
  expect(b.top, `${label}: top edge`).toBeGreaterThanOrEqual(0);
  expect(b.right, `${label}: right edge`).toBeLessThanOrEqual(geo.width);
  expect(b.bottom, `${label}: bottom edge`).toBeLessThanOrEqual(geo.height);
  expect(intersects(b, geo.ball), `${label}: over the ball ${JSON.stringify(geo)}`).toBe(false);
  if (geo.capsule) expect(intersects(b, geo.capsule), `${label}: over the capsule ${JSON.stringify(geo)}`).toBe(false);
}

test.describe('the error bar next to the float ball', () => {
  for (const viewport of VIEWPORTS) {
    test(`${viewport.width}x${viewport.height}: wherever the ball is, the bar is on screen and clear of it`, async ({ context, page }) => {
      test.setTimeout(120000);
      const { close } = await setUp(context, page, { mode: 'plan_required' });
      try {
        await page.setViewportSize(viewport);
        for (const spot of SPOTS) {
          await openPage(page);
          await page.evaluate(() => localStorage.removeItem('ai-translator-float-position'));
          await page.reload();
          await expect(ball(page)).toBeVisible();
          await dragBallTo(page, spot);
          await clickBall(page);
          await expect(bar(page)).toHaveClass(/ai-translator-progress-error-state/, { timeout: 30000 });
          await expect(barEntry(page)).toHaveAttribute('data-account-action', 'subscribe');
          await settled(page);
          expectClearOfBall(await geometry(page), `${viewport.width}x${viewport.height} ${spot}`);
        }
      } finally {
        await close();
      }
    });
  }

  test('the notice bar too (1280x720, ball where it starts)', async ({ context, page }) => {
    const { close } = await setUp(context, page);
    try {
      // Nothing to translate on the page: the pass ends on the notice bar.
      await context.route(`${ORIGIN}/empty`, (route) => route.fulfill({
        status: 200, contentType: 'text/html',
        body: '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Empty</title></head><body></body></html>',
      }));
      await page.goto(`${ORIGIN}/empty`);
      await expect(ball(page)).toBeVisible();
      await clickBall(page);
      await expect(bar(page)).toHaveClass(/ai-translator-progress-info-state/);
      await expect(bar(page)).toContainText(en('pageAlreadyTranslated'));
      await settled(page);
      expectClearOfBall(await geometry(page), 'notice bar');
    } finally {
      await close();
    }
  });

  test('M8: a bar with a way out stays until it is dealt with', async ({ context, page }) => {
    test.setTimeout(60000);
    const { close } = await setUp(context, page, { mode: 'plan_required' });
    try {
      await openPage(page);
      await clickBall(page);
      await expect(barEntry(page)).toHaveAttribute('data-account-action', 'subscribe', { timeout: 30000 });
      // Past the 8 s an error bar without a way out lives, and its 0.3 s fade.
      await page.waitForTimeout(9000);
      await expect(bar(page)).toBeVisible();
      await expect(bar(page)).toHaveClass(/ai-translator-progress-error-state/);
      await expect(barEntry(page)).toBeVisible();
    } finally {
      await close();
    }
  });

  test('R1-N1: the next pass gets a bar of its own, not the last one\'s error bar', async ({ context, page }) => {
    // The first pass on Blab, the next on the user's own model.
    const { ai, close } = await setUp(context, page, { mode: 'plan_required', settings: { translationEngine: 'blab' } });
    try {
      await openPage(page);
      await clickBall(page);
      await expect(barEntry(page)).toHaveAttribute('data-account-action', 'subscribe', { timeout: 30000 });

      // Every state the bar goes through from here on.
      await page.evaluate(() => {
        window.__barStates = [];
        const note = () => {
          const el = document.getElementById('ai-translator-progress');
          if (!el) return;
          window.__barStates.push({
            className: el.className,
            track: !!el.querySelector('.ai-translator-progress-track'),
          });
        };
        new MutationObserver(note).observe(document.body, {
          subtree: true, childList: true, attributes: true, attributeFilter: ['class'],
        });
      });
      await writeSyncSettings(context, { translationEngine: 'ai' });
      await clickBall(page);
      await expect(page.locator('#rich + .ai-translator-inline-block')).toContainText('[T]', { timeout: 30000 });
      await expect(bar(page)).toHaveClass(/ai-translator-progress-success-state/);
      await expect(bar(page)).not.toHaveClass(/ai-translator-progress-error-state/);
      await expect(barEntry(page)).toHaveCount(0);
      expect(ai.sentTexts.length).toBeGreaterThan(0);
      const states = await page.evaluate(() => window.__barStates);
      // The pass showed its progress: a fresh bar with a track, no error on it.
      expect(states.some((s) => s.track && !/error-state/.test(s.className)), JSON.stringify(states)).toBe(true);
    } finally {
      await close();
    }
  });
});
