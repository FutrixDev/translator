/**
 * The dictionary specs' shared harness (dictionary-entry.spec.js,
 * dictionary-local.spec.js, input-dictionary-note.spec.js): the page origin,
 * the settings, the page route, opening the card from a mouse selection, the
 * zh-CN / en message lookups, and the entry checks below.
 *
 * What a drawn dictionary entry must compute to, whatever the host page's
 * stylesheet says, and how readable its small text must be: the one copy of
 * these checks, for C7/C8 (dictionary-entry.spec.js, an entry from a model) and
 * J-B2.7 (dictionary-local.spec.js, an entry from the offline pack, which also
 * draws the credits line).
 *
 * Each row is [selector, display, padding, font-size, colour token,
 * text-decoration?]. A flex item's display is blockified, so the spans in a flex
 * row compute to block (or flex for an inline-flex one). The colour is compared
 * with its token resolved on a probe inside the same entry (an inline style,
 * which no page rule outweighs). Every row's element must be in the entry: a
 * row list names what the caller's entry draws, and a missing element fails.
 */
const { expect } = require('./fixtures');
const { contrastOf, waitForSettled, MIN_CONTRAST } = require('./layout-checks');
const { getMessage } = require('../../i18n/messages');

// Pages are served on an https origin: the built-in engine is a SecureContext API.
const ORIGIN = 'https://dictionary.test';
const zh = (key) => getMessage(key, 'zh-CN');
const en = (key) => getMessage(key, 'en');

// A model endpoint, the selection icon opening the card, and `extra` on top.
function settings(endpoint, extra = {}) {
  return {
    provider: 'custom',
    apiEndpoint: endpoint,
    apiKey: 'test-key',
    modelName: 'gpt-4.1-mini',
    targetLang: 'zh-CN',
    enableSelection: true,
    selectionTranslationMode: 'popup',
    ...extra,
  };
}

// Serve `pages` (pathname -> html) on ORIGIN; any other path gets pages['/'].
// `css` is appended to every page's head, as a page stylesheet.
async function servePages(context, pages, css = '') {
  const withCss = (html) => (css ? html.replace('</head>', `<style>${css}</style></head>`) : html);
  await context.route(`${ORIGIN}/**`, (route) => {
    const at = new URL(route.request().url()).pathname;
    const body = pages[at] || pages['/'];
    route.fulfill({ status: 200, contentType: 'text/html', body: withCss(body) });
  });
}

// Select the text of `selector` with the mouse, as a reader would, and open the
// card from the selection icon.
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

const PRIMARY = 'var(--text-primary)';
const SECONDARY = 'var(--text-secondary)';
const POS = 'var(--dict-pos)';

// The credits line, drawn only for an offline dictionary answer (D-561, D-573).
const CREDITS_STYLES = [
  ['.ai-translator-dict-credits', 'block', '0px', '12px', SECONDARY, 'none'],
  ['.ai-translator-dict-credits-prefix', 'inline', '0px 4px 0px 0px', '12px', SECONDARY, 'none'],
  ['.ai-translator-dict-credit-link', 'inline', '0px', '12px', POS, 'underline'],
];

const ENTRY_STYLES = [
  ['.ai-translator-dict-section', 'flex', '0px', '13px', PRIMARY],
  ['.ai-translator-dict-heading', 'block', '0px', '11px', SECONDARY],
  ['.ai-translator-dict-phonetic', 'flex', '0px', '13px', PRIMARY],
  ['.ai-translator-dict-ipa', 'block', '0px', '14px', SECONDARY],
  ['.ai-translator-dict-sense', 'flex', '0px', '13px', PRIMARY],
  ['.ai-translator-dict-pos', 'block', '0px', '13px', POS],
  ['.ai-translator-dict-defs', 'block', '0px', '13px', PRIMARY],
  ['.ai-translator-dict-example', 'block', '0px 0px 0px 8px', '13px', PRIMARY],
  ['.ai-translator-dict-example-source', 'block', '0px', '13px', PRIMARY],
  ['.ai-translator-dict-example-target', 'block', '0px', '13px', SECONDARY],
  ['.ai-translator-dict-form', 'flex', '0px', '13px', PRIMARY],
  ['.ai-translator-dict-form-label', 'block', '0px', '13px', SECONDARY],
  ['.ai-translator-dict-form-value', 'block', '0px', '13px', PRIMARY],
  ...CREDITS_STYLES,
];

// A model's entry has no credits line.
const isCredits = (selector) => selector.startsWith('.ai-translator-dict-credit');
const MODEL_ENTRY_STYLES = ENTRY_STYLES.filter(([selector]) => !isCredits(selector));

// The UK/US label is only drawn for an English translation.
const ACCENT_STYLES = [
  ['.ai-translator-dict-accent', 'block', '0px', '12px', SECONDARY],
];

// The entry's small secondary text, which must read at MIN_CONTRAST against
// what is painted under it (layout-checks.js measures it).
const CONTRAST_SELECTORS = [
  '.ai-translator-dict-heading',
  '.ai-translator-dict-form-label',
  '.ai-translator-dict-pos',
  '.ai-translator-dict-ipa',
  '.ai-translator-dict-example-target',
  '.ai-translator-dict-credits-prefix',
  '.ai-translator-dict-credit-link',
];
const MODEL_CONTRAST_SELECTORS = CONTRAST_SELECTORS.filter((selector) => !isCredits(selector));

function entryStyles(page, entrySelector, rows) {
  return page.evaluate(({ entrySelector, rows }) => {
    const entry = document.querySelector(entrySelector);
    const probe = document.createElement('i');
    entry.appendChild(probe);
    const out = rows.map(([selector, , , , token]) => {
      const el = entry.querySelector(selector);
      if (!el) return [selector, null];
      const style = getComputedStyle(el);
      probe.style.color = token;
      return [selector, {
        display: style.display,
        padding: style.padding,
        fontSize: style.fontSize,
        color: style.color,
        decoration: style.textDecorationLine,
        tokenColor: getComputedStyle(probe).color,
      }];
    });
    probe.remove();
    return out;
  }, { entrySelector, rows });
}

async function expectEntryStyles(page, entrySelector, rows) {
  const measured = await entryStyles(page, entrySelector, rows);
  for (const [i, [selector, display, padding, fontSize, , decoration]] of rows.entries()) {
    const got = measured[i][1];
    expect(got, `${selector} is drawn in ${entrySelector}`).not.toBeNull();
    const want = { selector, display, padding, fontSize, color: got.tokenColor };
    const seen = { selector, display: got.display, padding: got.padding, fontSize: got.fontSize, color: got.color };
    if (decoration !== undefined) {
      want.decoration = decoration;
      seen.decoration = got.decoration;
    }
    expect(seen).toEqual(want);
    expect(got.color, selector).not.toBe('rgb(255, 0, 0)');
  }
}

async function expectReadableContrast(page, entrySelector, label, selectors) {
  await waitForSettled(page);
  const entry = page.locator(entrySelector).first();
  for (const selector of selectors) {
    const ratio = await contrastOf(entry.locator(selector).first());
    expect(ratio, `${label} ${selector}`).toBeGreaterThanOrEqual(MIN_CONTRAST);
  }
}

module.exports = {
  ORIGIN,
  zh,
  en,
  settings,
  servePages,
  openCardOn,
  ENTRY_STYLES,
  MODEL_ENTRY_STYLES,
  ACCENT_STYLES,
  CONTRAST_SELECTORS,
  MODEL_CONTRAST_SELECTORS,
  expectEntryStyles,
  expectReadableContrast,
};
