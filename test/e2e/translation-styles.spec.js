/**
 * Translation styles (design 2026-09-24-p0-c-display-styles.md §2, §7.2).
 *
 *   J-C1  every style on both shapes a page translation takes (block and nav
 *         inline-right): computed style per §2.4, geometry per §2.2, and no
 *         new translation request.
 *   J-C6  blur: blurred by default, hover clears, a touch tap reveals, and
 *         translation-only turns it off.
 *   J-C7  contrast on a white and a near-black host.
 *   J-C9  hover and selection translations look the same under every style.
 */
const { test, expect } = require('./fixtures');
const { startMockOpenAIServer } = require('./mock-openai-server');
const { triggerSelectionHotkey, writeSyncSettings } = require('./helpers');
const {
  HOSTS,
  openPage,
  openTranslatedPage,
  setStyleViaStorage,
  expectTranslationOnly,
  touchTap,
} = require('./display-fixtures');

const STYLES = ['default', 'underline', 'dashed', 'highlight', 'quote', 'blur'];
const ZERO_GEOMETRY = ['underline', 'dashed', 'highlight', 'blur'];
const ACCENT = 'rgb(79, 110, 247)';
const TOLERANCE = 0.5;

// Parked away from every translation: a pointer resting on one would hover it.
async function parkPointer(page) {
  await page.mouse.move(2, 715);
}

// Everything J-C1 asserts, read in one pass.
function measurePage(page) {
  return page.evaluate(() => {
    const box = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    };
    const textRects = (node) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      return Array.from(range.getClientRects(), (r) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom }));
    };
    const pick = (el) => {
      const cs = getComputedStyle(el);
      return {
        textDecorationLine: cs.textDecorationLine,
        textDecorationColor: cs.textDecorationColor,
        textDecorationThickness: cs.textDecorationThickness,
        textUnderlineOffset: cs.textUnderlineOffset,
        outlineStyle: cs.outlineStyle,
        outlineWidth: cs.outlineWidth,
        outlineColor: cs.outlineColor,
        outlineOffset: cs.outlineOffset,
        borderRadius: cs.borderTopLeftRadius,
        backgroundColor: cs.backgroundColor,
        boxShadow: cs.boxShadow,
        borderLeftStyle: cs.borderLeftStyle,
        borderLeftWidth: cs.borderLeftWidth,
        borderLeftColor: cs.borderLeftColor,
        paddingLeft: cs.paddingLeft,
        marginLeft: cs.marginLeft,
        marginRight: cs.marginRight,
        filter: cs.filter,
        fontSize: parseFloat(cs.fontSize),
      };
    };
    const blocks = ['p1', 'p2', 'p3', 'tail'].map((id) => {
      const source = document.getElementById(id);
      const translation = source.nextElementSibling;
      return {
        id,
        source: box(source),
        text: textRects(translation),
        next: box(translation.nextElementSibling),
        style: pick(translation),
      };
    });
    const navs = ['nav-1', 'nav-2'].map((id) => {
      const link = document.getElementById(id);
      const translation = link.querySelector('.ai-translator-inline-right');
      return {
        id,
        source: textRects(link.firstChild),
        text: textRects(translation),
        next: box(link.nextElementSibling),
        style: pick(translation),
      };
    });
    return { blocks, navs };
  });
}

function expectRectsClose(actual, expected, label) {
  expect(actual.length, `${label}: rect count`).toBe(expected.length);
  actual.forEach((rect, i) => {
    for (const side of ['left', 'top', 'right', 'bottom']) {
      expect(Math.abs(rect[side] - expected[i][side]), `${label}[${i}].${side}`).toBeLessThanOrEqual(TOLERANCE);
    }
  });
}

function shifted(rects, dx) {
  return rects.map((r) => ({ ...r, left: r.left + dx, right: r.right + dx }));
}

function expectRectClose(actual, expected, label) {
  if (expected === null) {
    expect(actual, label).toBeNull();
    return;
  }
  expectRectsClose([actual], [expected], label);
}

function expectStyleDeclarations(style, computed, label) {
  switch (style) {
    case 'default':
      expect(computed.textDecorationLine, label).toBe('none');
      expect(computed.outlineStyle, label).toBe('none');
      expect(computed.backgroundColor, label).toBe('rgba(0, 0, 0, 0)');
      expect(computed.boxShadow, label).toBe('none');
      expect(computed.borderLeftWidth, label).toBe('0px');
      expect(computed.filter, label).toBe('none');
      break;
    case 'underline':
      expect(computed.textDecorationLine, label).toBe('underline');
      expect(computed.textDecorationColor, label).toBe(ACCENT);
      expect(computed.textDecorationThickness, label).toBe('2px');
      expect(computed.textUnderlineOffset, label).toBe('3px');
      break;
    case 'dashed':
      expect(computed.outlineStyle, label).toBe('dashed');
      expect(computed.outlineWidth, label).toBe('1px');
      expect(computed.outlineColor, label).toBe(ACCENT);
      expect(computed.outlineOffset, label).toBe('1px');
      expect(computed.borderRadius, label).toBe('3px');
      break;
    case 'highlight':
      expect(computed.backgroundColor, label).toBe('rgba(79, 110, 247, 0.16)');
      expect(computed.boxShadow, label).toBe('rgba(79, 110, 247, 0.16) -4px 0px 0px 0px, rgba(79, 110, 247, 0.16) 4px 0px 0px 0px');
      expect(computed.borderRadius, label).toBe('2px');
      break;
    case 'quote':
      expect(computed.borderLeftStyle, label).toBe('solid');
      expect(computed.borderLeftWidth, label).toBe('3px');
      expect(computed.borderLeftColor, label).toBe(ACCENT);
      expect(Math.abs(parseFloat(computed.paddingLeft) - 0.6 * computed.fontSize), label).toBeLessThanOrEqual(TOLERANCE);
      break;
    case 'blur':
      expect(computed.filter, label).toBe('blur(5px)');
      break;
    default:
      throw new Error(`unknown style ${style}`);
  }
}

test('J-C1: six styles on block and nav translations, no reflow, no new request', async ({ page, context }) => {
  const { endpoint, close, sentTexts, fastBatchRequests } = await startMockOpenAIServer();
  try {
    await openTranslatedPage(page, context, endpoint);
    await parkPointer(page);
    expect(fastBatchRequests.length).toBeGreaterThan(0);
    const requestsAfterTranslation = sentTexts.length;

    const measured = {};
    for (const style of STYLES) {
      await setStyleViaStorage(page, context, style);
      // blur has a .15s transition; the computed filter is the animated value.
      if (style === 'blur') {
        await expect.poll(() => page.evaluate(() => getComputedStyle(document.querySelector('#p1 + p')).filter))
          .toBe('blur(5px)');
      }
      measured[style] = await measurePage(page);
    }
    const base = measured.default;

    for (const style of STYLES) {
      const m = measured[style];
      for (const [i, block] of m.blocks.entries()) {
        const label = `${style} ${block.id}`;
        expectStyleDeclarations(style, block.style, label);
        // No style touches margin: pages centre blocks with margin-inline:auto.
        expect(block.style.marginLeft, label).toBe(base.blocks[i].style.marginLeft);
        expect(block.style.marginRight, label).toBe(base.blocks[i].style.marginRight);
        // The source never moves.
        expectRectClose(block.source, base.blocks[i].source, `${label} source`);
      }
      // quote's inset widens an inline-right translation, and in a flex row
      // that pushes every later item along by exactly the insets before it —
      // the declared deviation (design doc §10). Every other style: zero.
      let navShift = 0;
      for (const [i, nav] of m.navs.entries()) {
        const label = `${style} ${nav.id}`;
        expectStyleDeclarations(style, nav.style, label);
        expectRectsClose(nav.source, shifted(base.navs[i].source, navShift), `${label} source text`);
        if (style === 'quote') {
          const inset = 3 + 0.6 * nav.style.fontSize;
          expect(Math.abs(nav.text[0].left - (base.navs[i].text[0].left + navShift + inset)), `quote ${nav.id} inset`)
            .toBeLessThanOrEqual(TOLERANCE);
          navShift += inset;
        }
      }

      if (ZERO_GEOMETRY.includes(style)) {
        for (const [i, block] of m.blocks.entries()) {
          expectRectsClose(block.text, base.blocks[i].text, `${style} ${block.id} translation text`);
          expectRectClose(block.next, base.blocks[i].next, `${style} ${block.id} next sibling`);
        }
        for (const [i, nav] of m.navs.entries()) {
          expectRectsClose(nav.text, base.navs[i].text, `${style} ${nav.id} translation text`);
          expectRectClose(nav.next, base.navs[i].next, `${style} ${nav.id} next item`);
        }
      }

      if (style === 'quote') {
        // A block translation's text moves in by border + padding inside its
        // own box (§2.2); the nav inset is asserted in the loop above.
        for (const [i, block] of m.blocks.entries()) {
          const inset = 3 + 0.6 * block.style.fontSize;
          expect(Math.abs(block.text[0].left - (base.blocks[i].text[0].left + inset)), `quote ${block.id} inset`)
            .toBeLessThanOrEqual(TOLERANCE);
        }
      }
    }

    // Switching styles never translates anything again.
    expect(sentTexts.length).toBe(requestsAfterTranslation);
  } finally {
    await close();
  }
});

test('J-C6: blur is blurred, hover clears it, a touch tap reveals it, translation-only turns it off', async ({ page, context }) => {
  const { endpoint, close } = await startMockOpenAIServer();
  try {
    await openTranslatedPage(page, context, endpoint);
    await parkPointer(page);
    await setStyleViaStorage(page, context, 'blur');

    const filterOf = (selector) => page.evaluate((sel) => getComputedStyle(document.querySelector(sel)).filter, selector);
    const first = page.locator('#p1 + p');

    await expect.poll(() => filterOf('#p1 + p')).toBe('blur(5px)');
    await expect.poll(() => filterOf('#nav-1 .ai-translator-inline-right')).toBe('blur(5px)');

    await first.hover();
    await expect.poll(() => filterOf('#p1 + p')).toBe('none');
    await parkPointer(page);
    await expect.poll(() => filterOf('#p1 + p')).toBe('blur(5px)');

    // A finger has no hover: the tap toggles .ai-translator-revealed. A tap
    // also leaves the tapped element :hover (touch sticky hover) until the
    // next tap lands elsewhere, so each tap on the translation is followed by
    // one on the untranslated tail paragraph: what is left is the class alone.
    const elsewhere = page.locator('#tail');
    await touchTap(page, first);
    await expect(first).toHaveClass(/ai-translator-revealed/);
    await touchTap(page, elsewhere);
    await expect.poll(() => first.evaluate((el) => el.matches(':hover'))).toBe(false);
    await expect.poll(() => filterOf('#p1 + p')).toBe('none');
    // The others stay blurred.
    await expect.poll(() => filterOf('#p2 + p')).toBe('blur(5px)');

    await touchTap(page, first);
    await expect(first).not.toHaveClass(/ai-translator-revealed/);
    await touchTap(page, elsewhere);
    await expect.poll(() => first.evaluate((el) => el.matches(':hover'))).toBe(false);
    await expect.poll(() => filterOf('#p1 + p')).toBe('blur(5px)');

    // Translation-only: the source is hidden, so nothing may be blurred.
    await writeSyncSettings(context, { showTranslationOnly: true });
    await expectTranslationOnly(page, true);
    await expect.poll(() => filterOf('#p2 + p')).toBe('none');
    await expect.poll(() => filterOf('#nav-1 .ai-translator-inline-right')).toBe('none');
  } finally {
    await close();
  }
});

// ---------------------------------------------------------------- contrast

function parseColor(value) {
  const m = /rgba?\(([^)]+)\)/.exec(value);
  if (!m) throw new Error(`not a colour: ${value}`);
  const [r, g, b, a = 1] = m[1].split(',').map((part) => parseFloat(part));
  return { r, g, b, a };
}

function hexColor(hex) {
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
}

// `color` at `alpha` over an opaque `under`.
function over(color, alpha, under) {
  return {
    r: color.r * alpha + under.r * (1 - alpha),
    g: color.g * alpha + under.g * (1 - alpha),
    b: color.b * alpha + under.b * (1 - alpha),
    a: 1,
  };
}

function luminance({ r, g, b }) {
  const channel = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test('J-C7: accent and highlight contrast on a white and a near-black host', async ({ page, context }) => {
  const { endpoint, close } = await startMockOpenAIServer();
  const report = [];
  try {
    for (const host of ['light', 'dark']) {
      await openTranslatedPage(page, context, endpoint, { host });
      await parkPointer(page);
      const bg = hexColor(HOSTS[host].bg);
      const read = () => page.evaluate(() => {
        const cs = getComputedStyle(document.querySelector('#p1 + p'));
        return {
          opacity: parseFloat(cs.opacity),
          color: cs.color,
          textDecorationColor: cs.textDecorationColor,
          outlineColor: cs.outlineColor,
          borderLeftColor: cs.borderLeftColor,
          backgroundColor: cs.backgroundColor,
        };
      });

      // Decorations: the computed colour composited at the element's opacity
      // onto the host background, against that background, >= 3:1.
      for (const [style, prop] of [['underline', 'textDecorationColor'], ['dashed', 'outlineColor'], ['quote', 'borderLeftColor']]) {
        await setStyleViaStorage(page, context, style);
        const cs = await read();
        const color = parseColor(cs[prop]);
        const effective = over(color, color.a * cs.opacity, bg);
        const ratio = contrast(effective, bg);
        report.push(`${host} ${style}: ${ratio.toFixed(2)}:1`);
        expect(ratio, `${host} ${style}`).toBeGreaterThanOrEqual(3);
      }

      // Highlight: text over the tint, the whole group composited at opacity.
      await setStyleViaStorage(page, context, 'highlight');
      const cs = await read();
      const tint = parseColor(cs.backgroundColor);
      const text = parseColor(cs.color);
      const effectiveBg = over(tint, tint.a * cs.opacity, bg);
      const effectiveText = over(text, text.a * cs.opacity, bg);
      const ratio = contrast(effectiveText, effectiveBg);
      report.push(`${host} highlight text: ${ratio.toFixed(2)}:1`);
      expect(ratio, `${host} highlight text`).toBeGreaterThanOrEqual(4.5);
    }
  } finally {
    // The measured values are part of the delivery report.
    console.log(`J-C7 contrast: ${report.join('; ')}`);
    test.info().annotations.push({ type: 'J-C7 contrast', description: report.join('; ') });
    await close();
  }
});

// ------------------------------------------------- hover / selection untouched

test('J-C9: hover and selection translations look the same under every style', async ({ page, context }) => {
  const { endpoint, close } = await startMockOpenAIServer();
  try {
    await openPage(page, context, endpoint);

    // A real hover translation: hold the hotkey, point at a paragraph.
    await page.keyboard.down('Shift');
    await page.locator('#p1').hover();
    await page.waitForSelector('#p1 + .ai-translator-hover-translation', { state: 'attached' });
    await page.keyboard.up('Shift');
    await parkPointer(page);

    // A real selection translation.
    await page.locator('#p2').selectText();
    await triggerSelectionHotkey(page);
    await page.waitForSelector('.ai-translator-selection-translation', { state: 'attached' });
    await page.evaluate(() => window.getSelection().removeAllRanges());
    await expect(page.locator('.ai-translator-inline-loading')).toHaveCount(0, { timeout: 10000 });

    const read = () => page.evaluate(() => {
      const props = ['textDecorationLine', 'textDecorationColor', 'outlineStyle', 'outlineColor', 'backgroundColor',
        'boxShadow', 'borderLeftStyle', 'borderLeftWidth', 'paddingLeft', 'filter', 'borderTopLeftRadius'];
      const pick = (el) => Object.fromEntries(props.map((p) => [p, getComputedStyle(el)[p]]));
      return {
        hover: pick(document.querySelector('.ai-translator-hover-translation')),
        selection: pick(document.querySelector('.ai-translator-selection-translation')),
      };
    });

    const base = await read();
    for (const style of STYLES.filter((s) => s !== 'default')) {
      await setStyleViaStorage(page, context, style);
      expect(await read(), style).toEqual(base);
    }
  } finally {
    await close();
  }
});
