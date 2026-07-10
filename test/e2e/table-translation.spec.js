const { test, expect } = require('@playwright/test');
const path = require('path');

// Focused DOM unit test of the REAL collectTranslatableBlocks + insertTranslationBlock
// functions, loaded straight from source into a plain headless page (no extension, network,
// or display needed). Guards the Hacker-News table-layout regression:
//   - sites that use tables for layout must produce translatable blocks (previously TABLE/TR
//     were in skipTags → 0 blocks → page falsely reported "already translated");
//   - a cell's translation is inserted INSIDE the cell as a <div>, never as a sibling <td>
//     (a sibling cell would add a phantom column and break the grid);
//   - pure-numeric/symbol data cells (0.83, 94.2%, ±0.02) are skipped.
const ROOT = path.join(__dirname, '..', '..');
const SCRIPTS = [
  path.join(ROOT, 'i18n/messages.js'),
  path.join(ROOT, 'content/content-bootstrap.js'),
  path.join(ROOT, 'content/content-page-translation.js'),
];

const FIXTURE_HTML = `<!doctype html><html><head><meta charset="utf-8"></head><body>
  <table id="layout-table" border="0">
    <tr><td id="layout-cell">Hacker News style comment text lives inside a table cell.</td></tr>
  </table>
  <table id="data-table" border="1">
    <tr>
      <th id="hdr-text">Method description column</th>
      <td id="num-a">0.83</td>
      <td id="num-b">94.2%</td>
    </tr>
    <tr>
      <td id="cell-text">Descriptive result label here</td>
      <td id="num-c">±0.02</td>
      <td id="num-d">1,234</td>
    </tr>
  </table>
</body></html>`;

test('table layout: cells translate inside the cell, grid intact, numeric cells skipped', async ({ page }) => {
  await page.setContent(FIXTURE_HTML, { waitUntil: 'load' });
  for (const s of SCRIPTS) await page.addScriptTag({ path: s });

  const result = await page.evaluate(() => {
    const ctx = window.AI_TRANSLATOR_CONTENT;
    const blocks = ctx.collectTranslatableBlocks(document.body);
    const collectedIds = blocks.map((b) => b.element.id).filter(Boolean).sort();

    // Run the real insertion for every collected block.
    blocks.forEach((b) => ctx.insertTranslationBlock(b, '[T] ' + b.text));

    const info = (id) => {
      const el = document.getElementById(id);
      const inner = el.querySelector('.ai-translator-inline-block');
      return {
        translated: el.classList.contains('ai-translator-translated'),
        innerTag: inner ? inner.tagName : null
      };
    };

    return {
      collectedIds,
      cellText: info('cell-text'),
      hdrText: info('hdr-text'),
      layoutCell: info('layout-cell'),
      numA: info('num-a'),
      row1Cells: document.querySelectorAll('#data-table tr:nth-child(1) > th, #data-table tr:nth-child(1) > td').length,
      row2Cells: document.querySelectorAll('#data-table tr:nth-child(2) > td').length
    };
  });

  // 1) Original bug: table content is collected & translated (not "0 blocks / already translated").
  expect(result.collectedIds).toContain('layout-cell');
  expect(result.collectedIds).toContain('hdr-text');
  expect(result.collectedIds).toContain('cell-text');
  expect(result.layoutCell.translated).toBe(true);

  // 2) Pure numeric/symbol data cells are skipped (no noise).
  for (const id of ['num-a', 'num-b', 'num-c', 'num-d']) {
    expect(result.collectedIds).not.toContain(id);
  }
  expect(result.numA.translated).toBe(false);
  expect(result.numA.innerTag).toBeNull();

  // 3) Translation is inserted INSIDE the cell as a <div>, and the grid is intact
  //    (no sibling <td> added — the sibling-cell bug would inflate these counts).
  expect(result.cellText.innerTag).toBe('DIV');
  expect(result.hdrText.innerTag).toBe('DIV');
  expect(result.row1Cells).toBe(3);
  expect(result.row2Cells).toBe(3);
});
