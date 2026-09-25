/**
 * Geometry and contrast checks for an extension page's own controls
 * (onboarding.spec.js, settings-transfer.spec.js).
 *
 * One measurement in the page, four promises about it:
 *   - every named element is rendered (non-zero box, not visibility:hidden),
 *   - inside the 1280x720 viewport the fixture opens (the caller scrolls first),
 *   - no two of them overlap,
 *   - its text against what is actually painted under it is at least 4.5:1.
 *
 * The background is found the way the eye finds it: walk up from the element,
 * compositing every non-transparent background-color until an opaque one is
 * reached, over the page's white canvas if none is. A gradient counts with
 * every one of its stops and the lowest ratio wins (the settings page's
 * primary button is one). Opacity on the way is folded in too — a 0.6-opacity
 * disabled button is measured as it looks.
 */
const { expect } = require('./fixtures');

const MIN_CONTRAST = 4.5;

/**
 * @param {import('@playwright/test').Page} page
 * @param {string[]} selectors each must match exactly one element
 */
function measure(page, selectors) {
  return page.evaluate((selectorList) => {
    const parse = (value) => {
      const m = value.match(/rgba?\(([^)]+)\)/);
      if (!m) return { r: 0, g: 0, b: 0, a: 0 };
      const [r, g, b, a = '1'] = m[1].split(/[\s,/]+/).filter(Boolean);
      return { r: +r, g: +g, b: +b, a: +a };
    };
    const over = (top, under) => ({
      r: top.r * top.a + under.r * (1 - top.a),
      g: top.g * top.a + under.g * (1 - top.a),
      b: top.b * top.a + under.b * (1 - top.a),
      a: 1,
    });
    const luminance = ({ r, g, b }) => {
      const ch = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
      return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
    };
    const ratio = (x, y) => {
      const [hi, lo] = [luminance(x), luminance(y)].sort((p, q) => q - p);
      return (hi + 0.05) / (lo + 0.05);
    };
    // Every colour the text could be sitting on. A gradient paints all of its
    // stops somewhere under the label, so each stop is a candidate and the
    // worst one is the answer.
    const backgroundsUnder = (el) => {
      const layers = [];
      for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
        const style = getComputedStyle(node);
        const stops = (style.backgroundImage.match(/rgba?\([^)]+\)/g) || []).map(parse);
        const color = parse(style.backgroundColor);
        const layer = [...(color.a > 0 ? [color] : []), ...stops];
        if (layer.length) layers.push(layer);
        if (layer.length && layer.every((c) => c.a >= 1)) break;
      }
      return layers.reverse().reduce(
        (unders, layer) => unders.flatMap((under) => layer.map((top) => over(top, under))),
        [{ r: 255, g: 255, b: 255, a: 1 }],
      );
    };
    const opacityOf = (el) => {
      let value = 1;
      for (let node = el; node && node.nodeType === 1; node = node.parentElement) value *= parseFloat(getComputedStyle(node).opacity);
      return value;
    };
    return selectorList.map((selector) => {
      const all = document.querySelectorAll(selector);
      if (all.length !== 1) return { selector, count: all.length };
      const el = all[0];
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      const text = parse(style.color);
      const contrast = Math.min(...backgroundsUnder(el)
        .map((bg) => ratio(over({ ...text, a: text.a * opacityOf(el) }, bg), bg)));
      return {
        selector,
        count: 1,
        box: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
        visible: style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0,
        contrast,
        viewport: { width: innerWidth, height: innerHeight },
      };
    });
  }, selectors);
}

const overlaps = (a, b) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;

/**
 * @param {import('@playwright/test').Page} page
 * @param {string[]} selectors elements that sit side by side (none contains another)
 * @param {string} label names the journey in failure messages
 * @returns {Promise<string>} "selector 7.12:1; …" — the measured contrasts, for the report
 */
async function expectLaidOut(page, selectors, label) {
  // The page applies the stored theme after its first paint, and the cards
  // transition their colours into it: measured mid-way, dark text sits on a
  // background still on its way from dark to light. Wait for every finite
  // animation and transition to finish — the settled page is what is read.
  await page.waitForFunction(() => document.getAnimations()
    .every((a) => a.playState !== 'running' || a.effect.getComputedTiming().iterations === Infinity));
  const found = await measure(page, selectors);
  for (const item of found) expect(item.count, `${label}: ${item.selector} matches one element`).toBe(1);
  for (const { selector, visible, box, viewport } of found) {
    expect(visible, `${label}: ${selector} is rendered`).toBe(true);
    expect(box.left, `${label}: ${selector} left edge`).toBeGreaterThanOrEqual(0);
    expect(box.top, `${label}: ${selector} top edge`).toBeGreaterThanOrEqual(0);
    expect(box.right, `${label}: ${selector} right edge`).toBeLessThanOrEqual(viewport.width);
    expect(box.bottom, `${label}: ${selector} bottom edge`).toBeLessThanOrEqual(viewport.height);
  }
  for (let i = 0; i < found.length; i += 1) {
    for (let j = i + 1; j < found.length; j += 1) {
      expect(overlaps(found[i].box, found[j].box), `${label}: ${found[i].selector} overlaps ${found[j].selector}`).toBe(false);
    }
  }
  for (const { selector, contrast } of found) {
    expect(contrast, `${label}: ${selector} text contrast`).toBeGreaterThanOrEqual(MIN_CONTRAST);
  }
  return found.map(({ selector, contrast }) => `${selector} ${contrast.toFixed(2)}:1`).join('; ');
}

module.exports = { expectLaidOut, MIN_CONTRAST };
