const { test, expect } = require('@playwright/test');
const path = require('path');

// Focused DOM unit test of the REAL insertTranslationBlock +
// applyTranslationOnlyMode functions, loaded straight from source into a plain
// headless page (no extension, network, or display needed). Guards the
// "show translation only" setting:
//   - sibling-inserted translations hide the source block via a class;
//   - internally-inserted translations (table cells) wrap the remaining
//     children in a span that is hidden, and the wrap is unwound without a
//     trace when the mode turns off;
//   - hover/selection translations are never treated as page translations;
//   - the float ball's "hide translations" toggle wins — originals come back
//     rather than leaving the page blank.
const ROOT = path.join(__dirname, '..', '..');
const SCRIPTS = [
  path.join(ROOT, 'i18n/messages.js'),
  path.join(ROOT, 'content/content-bootstrap.js'),
  path.join(ROOT, 'content/content-page-translation.js'),
];

const FIXTURE_HTML = `<!doctype html><html><head><meta charset="utf-8"></head><body>
  <p id="para">A perfectly ordinary paragraph that will be translated as a sibling block.</p>
  <table border="1">
    <tr><td id="cell">Table cell content translated inside the cell itself.</td></tr>
  </table>
  <p id="hover-host">Host paragraph for a hover translation that must be left alone.
    <span class="ai-translator-inline-block ai-translator-hover-translation">悬停译文</span>
  </p>
</body></html>`;

async function loadHarness(page) {
  await page.setContent(FIXTURE_HTML, { waitUntil: 'load' });
  for (const s of SCRIPTS) await page.addScriptTag({ path: s });
}

function snapshot(page) {
  return page.evaluate(() => ({
    paraHidden: document.getElementById('para').classList.contains('ai-translator-source-hidden'),
    paraTranslationHidden: document.getElementById('para').nextElementSibling
      .classList.contains('ai-translator-source-hidden'),
    cellWraps: document.querySelectorAll('#cell .ai-translator-source-wrap').length,
    cellWrapHidden: !!document.querySelector('#cell .ai-translator-source-wrap.ai-translator-source-hidden'),
    cellWrapText: (document.querySelector('#cell .ai-translator-source-wrap') || {}).textContent || null,
    cellTranslationInWrap: !!document.querySelector('#cell .ai-translator-source-wrap .ai-translator-inline-block'),
    hoverHostHidden: document.getElementById('hover-host').classList.contains('ai-translator-source-hidden'),
    hiddenCount: document.querySelectorAll('.ai-translator-source-hidden').length,
    wrapCount: document.querySelectorAll('.ai-translator-source-wrap').length,
    cellText: document.getElementById('cell').textContent.trim(),
  }));
}

test('translation-only mode hides sources, and unwinds without a trace', async ({ page }) => {
  await loadHarness(page);

  await page.evaluate(() => {
    const ctx = window.AI_TRANSLATOR_CONTENT;
    ctx.settings.showTranslationOnly = true;
    const blocks = ctx.collectTranslatableBlocks(document.body);
    blocks
      .filter((b) => ['para', 'cell'].includes(b.element.id))
      .forEach((b) => ctx.insertTranslationBlock(b, '[译] ' + b.text));
  });

  const on = await snapshot(page);
  // Sibling case: the source block itself is hidden, the translation is not.
  expect(on.paraHidden).toBe(true);
  expect(on.paraTranslationHidden).toBe(false);
  // Internal case: exactly one wrap around the original cell content, hidden,
  // and the translation stays outside it.
  expect(on.cellWraps).toBe(1);
  expect(on.cellWrapHidden).toBe(true);
  expect(on.cellWrapText).toContain('Table cell content');
  expect(on.cellTranslationInWrap).toBe(false);
  // Hover translation never marks its host as a page-translation source.
  expect(on.hoverHostHidden).toBe(false);

  // Idempotent: re-applying must not nest wraps or duplicate anything.
  await page.evaluate(() => window.AI_TRANSLATOR_CONTENT.applyTranslationOnlyMode());
  const reapplied = await snapshot(page);
  expect(reapplied.cellWraps).toBe(1);
  expect(reapplied.hiddenCount).toBe(on.hiddenCount);

  // Turn the setting off: every hidden class gone, every wrap unwound, the
  // cell's original text back in place as direct children.
  await page.evaluate(() => {
    const ctx = window.AI_TRANSLATOR_CONTENT;
    ctx.settings.showTranslationOnly = false;
    ctx.applyTranslationOnlyMode();
  });
  const off = await snapshot(page);
  expect(off.hiddenCount).toBe(0);
  expect(off.wrapCount).toBe(0);
  expect(off.cellText).toContain('Table cell content');
});

test('a page that removes the translation gets its original back on the next apply', async ({ page }) => {
  await loadHarness(page);

  const result = await page.evaluate(() => {
    const ctx = window.AI_TRANSLATOR_CONTENT;
    ctx.settings.showTranslationOnly = true;
    const blocks = ctx.collectTranslatableBlocks(document.body);
    blocks
      .filter((b) => ['para', 'cell'].includes(b.element.id))
      .forEach((b) => ctx.insertTranslationBlock(b, '[译] ' + b.text));

    // Simulate a page script deleting both inserted translations.
    document.querySelectorAll('.ai-translator-inline-block:not(.ai-translator-hover-translation)')
      .forEach((el) => el.remove());
    ctx.applyTranslationOnlyMode();

    return {
      paraHidden: document.getElementById('para').classList.contains('ai-translator-source-hidden'),
      hiddenCount: document.querySelectorAll('.ai-translator-source-hidden').length,
      wrapCount: document.querySelectorAll('.ai-translator-source-wrap').length,
      cellText: document.getElementById('cell').textContent.trim(),
    };
  });

  // The originals must not stay entombed behind a translation that no longer exists.
  expect(result.paraHidden).toBe(false);
  expect(result.hiddenCount).toBe(0);
  expect(result.wrapCount).toBe(0);
  expect(result.cellText).toContain('Table cell content');
});

test('float ball "hide translations" brings the originals back', async ({ page }) => {
  await loadHarness(page);

  const result = await page.evaluate(() => {
    const ctx = window.AI_TRANSLATOR_CONTENT;
    ctx.settings.showTranslationOnly = true;
    const blocks = ctx.collectTranslatableBlocks(document.body);
    const para = blocks.find((b) => b.element.id === 'para');
    ctx.insertTranslationBlock(para, '[译] ' + para.text);

    const whileVisible = document.getElementById('para').classList.contains('ai-translator-source-hidden');

    // The float ball toggle flips translationsVisible and re-applies the mode
    // (content-float-ball.js) — mirror those two steps here.
    ctx.state.translationsVisible = false;
    ctx.applyTranslationOnlyMode();
    const whileTranslationsHidden = document.getElementById('para').classList.contains('ai-translator-source-hidden');

    ctx.state.translationsVisible = true;
    ctx.applyTranslationOnlyMode();
    const afterReshow = document.getElementById('para').classList.contains('ai-translator-source-hidden');

    return { whileVisible, whileTranslationsHidden, afterReshow };
  });

  expect(result.whileVisible).toBe(true);
  // Both original and translation hidden at once would blank the page.
  expect(result.whileTranslationsHidden).toBe(false);
  expect(result.afterReshow).toBe(true);
});
