/**
 * Shared fixture for the display-layer specs (translation styles, the
 * bilingual / translation-only switch, the source-peek card):
 * translation-styles.spec.js, display-switch.spec.js, source-peek.spec.js.
 *
 * One page with both shapes a page translation takes: block paragraphs (the
 * translation is a sibling <p>) and a horizontal flex nav (the translation is
 * an `.ai-translator-inline-right` span inside the link). Served from a `.test`
 * origin through context.route, translated for real through the float ball
 * against the mock OpenAI server, so every assertion is about the DOM the
 * extension actually built.
 */
const { expect } = require('@playwright/test');
const { setExtensionSettings, triggerPageTranslation, writeSyncSettings } = require('./helpers');

const ORIGIN = 'https://styles.test';

// Two hosts for the contrast journey (J-C7): a white page and a near-black one.
const HOSTS = Object.freeze({
  light: Object.freeze({ bg: '#ffffff', fg: '#222222' }),
  dark: Object.freeze({ bg: '#111111', fg: '#e8e8e8' }),
});

// Each translation ("[T] " + the text) must stay on its own line count under
// quote's inset (J-C1: no source moves). The translation carries lang=zh-CN,
// and Chrome's zh-Hans sans-serif sets Latin about 6% wider than the page's
// own, so a line wider than the 640px column less that inset (about 627px) wraps.
const PARAGRAPHS = Object.freeze([
  'The harbour master keeps a ledger for the boats that never came back.',
  'Every entry is written in the same brown ink, and none of them has ever been crossed out.',
  'On calm evenings he reads a page aloud to whoever is still waiting on the quay.',
]);

const NAV_ITEMS = Object.freeze([
  'Tide tables for this week',
  'Harbour office opening hours',
]);

function pageHtml({ bg, fg }) {
  const nav = NAV_ITEMS
    .map((text, i) => `<a id="nav-${i + 1}" href="/nav-${i + 1}" style="color:${fg}">${text}</a>`)
    .join('');
  const paragraphs = PARAGRAPHS
    .map((text, i) => `<p id="p${i + 1}">${text}</p>`)
    .join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Harbour ledger</title></head>
<body style="margin:0;background:${bg};color:${fg};font:16px/1.5 sans-serif">
<nav id="nav" style="display:flex;gap:24px;padding:8px 16px">${nav}</nav>
<main id="main" style="max-width:640px;margin:0 auto;padding:16px">
${paragraphs}
<p id="tail">Tail paragraph after every translated block.</p>
</main>
</body></html>`;
}

/**
 * Point the extension at the mock server and serve the page, untranslated.
 *
 * @param {import('@playwright/test').Page} page
 * @param {import('@playwright/test').BrowserContext} context
 * @param {string} endpoint the mock server's chat-completions URL
 * @param {{host?: 'light'|'dark', settings?: object}} [options]
 */
async function openPage(page, context, endpoint, { host = 'light', settings = {} } = {}) {
  await setExtensionSettings(page, {
    apiEndpoint: endpoint,
    apiKey: 'test-key',
    modelName: 'gpt-4.1-mini',
    targetLang: 'zh-CN',
    skipTargetLanguageText: false,
    // No ask bar over the page: these specs translate by hand.
    autoTranslate: false,
    ...settings,
  });
  await context.route(`${ORIGIN}/**`, (route) => {
    const dark = new URL(route.request().url()).pathname.startsWith('/dark');
    route.fulfill({ status: 200, contentType: 'text/html', body: pageHtml(dark ? HOSTS.dark : HOSTS.light) });
  });
  await page.goto(`${ORIGIN}/${host}`);
  await page.waitForSelector('#ai-translator-float-ball');
}

/**
 * openPage, then translate the page for real through the float ball. Resolves
 * once the round has finished (the progress bar has gone), so request counts
 * read afterwards are final.
 */
async function openTranslatedPage(page, context, endpoint, options = {}) {
  await openPage(page, context, endpoint, options);
  await triggerPageTranslation(page);
  await expect(page.locator('#main > p.ai-translator-inline-block')).toHaveCount(PARAGRAPHS.length + 1, { timeout: 30000 });
  await expect(page.locator('#nav .ai-translator-inline-right')).toHaveCount(NAV_ITEMS.length, { timeout: 30000 });
  await page.waitForSelector('#ai-translator-progress', { state: 'hidden', timeout: 30000 });
}

function htmlAttribute(page, name) {
  return page.evaluate((attr) => document.documentElement.getAttribute(attr), name);
}

/**
 * Write translationStyle the way every surface does (chrome.storage.sync) and
 * wait until the page's content script has applied it.
 */
async function setStyleViaStorage(page, context, style) {
  await writeSyncSettings(context, { translationStyle: style });
  await expect.poll(() => htmlAttribute(page, 'data-ai-translator-style'))
    .toBe(style === 'default' ? null : style);
}

/** Resolves once the page reflects the given translation-only state. */
async function expectTranslationOnly(page, on) {
  await expect.poll(() => htmlAttribute(page, 'data-ai-translator-only')).toBe(on ? '' : null);
  if (on) await expect(page.locator('#p1')).toBeHidden();
  else await expect(page.locator('#p1')).toBeVisible();
}

/**
 * A real touch tap at the centre of `locator`: CDP touch emulation, then one
 * touchStart/touchEnd pair, which Chrome turns into a click whose
 * pointerType is 'touch' — the path display.js takes for a finger. The main
 * world records that click's pointerType, and the helper waits for it, so a
 * tap that produced no click (or a mouse click) fails here, not three
 * assertions later.
 *
 * @param {import('@playwright/test').Page} page
 * @param {import('@playwright/test').Locator} locator
 */
async function touchTap(page, locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error('touchTap: target has no box');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.evaluate(() => {
    window.__displayTapPointerType = null;
    document.addEventListener('click', (event) => {
      window.__displayTapPointerType = event.pointerType || 'none';
    }, { capture: true, once: true });
  });
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect.poll(() => page.evaluate(() => window.__displayTapPointerType)).toBe('touch');
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  } finally {
    await cdp.detach();
  }
}

module.exports = {
  ORIGIN,
  HOSTS,
  PARAGRAPHS,
  NAV_ITEMS,
  openPage,
  openTranslatedPage,
  setStyleViaStorage,
  touchTap,
  expectTranslationOnly,
};
