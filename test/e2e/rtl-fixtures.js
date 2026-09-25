/**
 * Shared fixture for the right-to-left journeys (design
 * 2026-09-24-p0-b-target-languages-rtl.md §10.2): rtl-layout.spec.js.
 *
 * Two pages on a `.test` origin, served through context.route:
 *
 *   /ltr  an English page: short single-line paragraphs (so a right-aligned
 *         translation leaves a wide gap on its left), one of them aligned
 *         `text-align: left` outright, one led by a 24px <svg> icon, and a
 *         horizontal flex nav.
 *   /rtl  the same shapes in Hebrew, under <html lang="he" dir="rtl">.
 *
 * Pages are translated for real through the float ball against the mock
 * OpenAI server, whose `[T] ` echo is enough: what these journeys assert is
 * where the text lands, not what it says.
 */
const { expect } = require('@playwright/test');
const { setExtensionSettings, triggerPageTranslation } = require('./helpers');

const ORIGIN = 'https://rtl.test';

const PAGES = Object.freeze({
  ltr: Object.freeze({
    lang: 'en',
    dir: 'ltr',
    paragraphs: [
      'The harbour master keeps a separate ledger.',
      'Every entry is written in the same brown ink.',
    ],
    iconParagraph: 'On calm evenings he reads a page aloud.',
    nav: ['Tide tables for this week', 'Harbour office opening hours'],
  }),
  rtl: Object.freeze({
    lang: 'he',
    dir: 'rtl',
    paragraphs: [
      'מנהל הנמל שומר פנקס נפרד לסירות שלא חזרו.',
      'כל רשומה נכתבת באותה דיו חומה בדיוק.',
    ],
    iconParagraph: 'בערבים שקטים הוא קורא עמוד בקול רם.',
    nav: ['לוחות הגאות של השבוע הזה', 'שעות הפתיחה של משרד הנמל'],
  }),
});

// The icon sits on the source's start side, separated from the text by 8px.
function iconSvg(dir) {
  const gap = dir === 'rtl' ? 'margin-left:8px' : 'margin-right:8px';
  return `<svg width="24" height="24" viewBox="0 0 24 24" style="vertical-align:middle;${gap}">`
    + '<circle cx="12" cy="12" r="10" fill="currentColor"/></svg>';
}

function pageHtml(name) {
  const { lang, dir, paragraphs, iconParagraph, nav } = PAGES[name];
  const links = nav.map((text, i) => `<a id="nav-${i + 1}" href="/nav-${i + 1}">${text}</a>`).join('');
  // The second paragraph states its alignment in physical terms, the way many
  // sites do on body text: copied as-is into a translation that runs the other
  // way, it would push that translation to its end edge.
  const physical = dir === 'rtl' ? 'right' : 'left';
  const body = paragraphs
    .map((text, i) => `<p id="p${i + 1}"${i === 1 ? ` style="text-align:${physical}"` : ''}>${text}</p>`)
    .join('\n');
  return `<!doctype html>
<html lang="${lang}" dir="${dir}"><head><meta charset="utf-8"><title>Harbour ledger</title></head>
<body style="margin:0;background:#fff;color:#222;font:16px/1.5 sans-serif">
<nav id="nav" style="display:flex;gap:32px;padding:8px 16px">${links}</nav>
<main id="main" style="width:640px;margin:0 auto;padding:16px">
${body}
<p id="icon-p">${iconSvg(dir)}${iconParagraph}</p>
</main>
</body></html>`;
}

/**
 * Point the extension at the mock server and serve one of the two pages,
 * untranslated.
 *
 * @param {import('@playwright/test').Page} page
 * @param {import('@playwright/test').BrowserContext} context
 * @param {string} endpoint the mock server's chat-completions URL
 * @param {{path: 'ltr'|'rtl', targetLang: string, settings?: object}} options
 */
async function openPage(page, context, endpoint, { path, targetLang, settings = {} }) {
  await setExtensionSettings(page, {
    apiEndpoint: endpoint,
    apiKey: 'test-key',
    modelName: 'gpt-4.1-mini',
    targetLang,
    skipTargetLanguageText: false,
    // No ask bar over the page: these journeys translate by hand.
    autoTranslate: false,
    ...settings,
  });
  await context.route(`${ORIGIN}/**`, (route) => {
    const name = new URL(route.request().url()).pathname.startsWith('/rtl') ? 'rtl' : 'ltr';
    route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: pageHtml(name) });
  });
  await page.goto(`${ORIGIN}/${path}`);
  await page.waitForSelector('#ai-translator-float-ball');
}

/**
 * openPage, then translate the page for real through the float ball. Resolves
 * once every paragraph and nav link carries its translation and the progress
 * bar has gone.
 */
async function openTranslatedPage(page, context, endpoint, options) {
  await openPage(page, context, endpoint, options);
  await triggerPageTranslation(page);
  const { paragraphs, nav } = PAGES[options.path];
  await expect(page.locator('#main > p.ai-translator-inline-block')).toHaveCount(paragraphs.length + 1, { timeout: 30000 });
  await expect(page.locator('#nav .ai-translator-inline-right')).toHaveCount(nav.length, { timeout: 30000 });
  await page.waitForSelector('#ai-translator-progress', { state: 'hidden', timeout: 30000 });
}

/**
 * The geometry every journey reads, measured in the page. For one element:
 *   line     the first line of its text: the union of the text's client rects
 *            on that line (a mixed-direction line is several rects)
 *   content  its content box
 *   padding  its computed padding-left / padding-right, in px
 * `textOf` picks the text: the element's own contents by default, or the
 * first non-blank text node (a source paragraph behind its icon, a nav link
 * that also holds our translation span).
 *
 * @param {import('@playwright/test').Locator} locator
 * @param {{firstTextNode?: boolean}} [options]
 */
function measure(locator, { firstTextNode = false } = {}) {
  return locator.evaluate((el, useTextNode) => {
    const range = document.createRange();
    if (useTextNode) {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) => (node.textContent.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP),
      });
      range.selectNodeContents(walker.nextNode());
    } else {
      range.selectNodeContents(el);
    }
    const rects = [...range.getClientRects()].filter((r) => r.width > 0);
    const top = rects[0].top;
    const onLine = rects.filter((r) => Math.abs(r.top - top) < 2);
    const box = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const px = (value) => parseFloat(value) || 0;
    return {
      line: {
        left: Math.min(...onLine.map((r) => r.left)),
        right: Math.max(...onLine.map((r) => r.right)),
      },
      box: { left: box.left, right: box.right },
      content: {
        left: box.left + px(cs.borderLeftWidth) + px(cs.paddingLeft),
        right: box.right - px(cs.borderRightWidth) - px(cs.paddingRight),
      },
      padding: { left: px(cs.paddingLeft), right: px(cs.paddingRight) },
      margin: { left: cs.marginLeft, right: cs.marginRight },
      lang: el.lang,
      dir: el.dir,
    };
  }, firstTextNode);
}

/**
 * The J-B3 geometry: the first line hugs the content box's right edge and
 * leaves a clear gap on its left — the text is right-aligned, not merely
 * marked rtl.
 */
async function expectRightAligned(locator) {
  const m = await measure(locator);
  expect(Math.abs(m.line.right - m.content.right), JSON.stringify(m)).toBeLessThanOrEqual(1);
  expect(m.line.left - m.content.left, JSON.stringify(m)).toBeGreaterThan(10);
}

/** The J-B5 mirror image: hugs the left edge, gap on the right. */
async function expectLeftAligned(locator) {
  const m = await measure(locator);
  expect(Math.abs(m.line.left - m.content.left), JSON.stringify(m)).toBeLessThanOrEqual(1);
  expect(m.content.right - m.line.right, JSON.stringify(m)).toBeGreaterThan(10);
}

/**
 * How far the source paragraph's text is pushed in from its start edge by the
 * icon, measured here rather than asked of the extension: left edge to text
 * for an LTR source, text to right edge for an RTL one.
 */
async function sourceInset(page, dir) {
  const m = await measure(page.locator('#icon-p'), { firstTextNode: true });
  return dir === 'rtl' ? m.box.right - m.line.right : m.line.left - m.box.left;
}

module.exports = {
  ORIGIN,
  PAGES,
  openPage,
  openTranslatedPage,
  measure,
  expectRightAligned,
  expectLeftAligned,
  sourceInset,
};
