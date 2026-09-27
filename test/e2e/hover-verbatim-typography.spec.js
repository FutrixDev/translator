// Typography of a Shift+hover translation whose paragraph carries a verbatim placeholder.
//
// hover/render.js builds the content by "any placeholder" and picks the style by "any real
// formula" (ctx.hasRealMath): a paragraph whose only placeholder is a translate="no" element
// keeps the page typography, a real formula keeps only opacity 0.85. The unit suite holds a
// source-text guard for the two style branches (custom-rule-collect.test.mjs); this walks the
// rendered result. Hover does not carry the site-rule selectors, so translate="no" is the one
// way to get a verbatim placeholder here. The font is read with CDP
// CSS.getPlatformFontsForNode and same-text Range widths, never
// getComputedStyle().fontFamily, which reports Times either way.
const { test, expect } = require('./fixtures');
const { setExtensionSettings, waitForFloatBall } = require('./helpers');
const { startMockOpenAIServer } = require('./mock-openai-server');

const RULES = 'https://rules.test';
const HOVER = '.ai-translator-hover-translation';
const S = 'kettle comes with a two year warranty and a spare filter in the box.';
const F = 'is the energy each particle carries through the whole box.';
const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Hover typography</title></head>
<body>
  <p id="notr">The <span translate="no">Acme</span> ${S}</p>
  <p id="notr-twin">The <span>Acme</span> ${S}</p>
  <p id="formula"><span class="katex">E=mc2</span> ${F}</p>
</body></html>`;

const sendCount = (sentTexts, text) =>
  sentTexts.reduce((sum, chunk) => sum + chunk.split(text).length - 1, 0);

async function platformFont(client, rootId, selector) {
  const { nodeId } = await client.send('DOM.querySelector', { nodeId: rootId, selector });
  expect(nodeId, selector).toBeGreaterThan(0);
  const { fonts } = await client.send('CSS.getPlatformFontsForNode', { nodeId });
  return [...fonts].sort((a, b) => b.glyphCount - a.glyphCount)[0].familyName;
}

test('Shift+hover: a translate="no" paragraph keeps the page typography, a real formula keeps only opacity', async ({ page, context }) => {
  const { close, endpoint, sentTexts } = await startMockOpenAIServer();
  try {
    await context.route(`${RULES}/**`, (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: PAGE }));
    await setExtensionSettings(page, {
      apiEndpoint: endpoint, apiKey: 'test-key', modelName: 'gpt-4.1-mini', targetLang: 'zh-CN',
      skipTargetLanguageText: false,
    });
    await page.goto(`${RULES}/hover`);
    await waitForFloatBall(page);

    await page.keyboard.down('Shift');
    for (const id of ['notr', 'notr-twin', 'formula']) {
      await page.locator(`#${id}`).hover();
      await expect(page.locator(`#${id} + ${HOVER}`)).toContainText('[T]', { timeout: 30000 });
    }
    await page.keyboard.up('Shift');

    // Premise: the translate="no" element went out as a placeholder, the twin did not.
    expect(sendCount(sentTexts, 'Acme')).toBe(1);
    await expect(page.locator(`#notr + ${HOVER}`).locator('span[translate="no"]'))
      .toHaveText('Acme');

    const client = await context.newCDPSession(page);
    await client.send('DOM.enable');
    await client.send('CSS.enable');
    const { root } = await client.send('DOM.getDocument', { depth: -1 });
    const hitFont = await platformFont(client, root.nodeId, `#notr + ${HOVER}`);
    const twinFont = await platformFont(client, root.nodeId, `#notr-twin + ${HOVER}`);
    expect(hitFont, 'the translate="no" paragraph renders in its twin\'s font').toBe(twinFont);

    const widths = await page.evaluate((sel) => Object.fromEntries(['notr', 'notr-twin'].map((id) => {
      const node = document.querySelector(`#${id} + ${sel}`);
      const range = document.createRange();
      range.selectNodeContents(node);
      return [id, { text: node.textContent, width: range.getBoundingClientRect().width }];
    })), HOVER);
    expect(widths.notr.text).toBe(widths['notr-twin'].text);
    expect(Math.abs(widths.notr.width - widths['notr-twin'].width), 'same text, same width')
      .toBeLessThanOrEqual(1);

    const formulaStyle = await page.locator(`#formula + ${HOVER}`).evaluate((node) => ({
      fontFamily: node.style.fontFamily,
      opacity: node.style.opacity,
    }));
    expect(formulaStyle).toEqual({ fontFamily: '', opacity: '0.85' });
  } finally {
    await close();
  }
});
