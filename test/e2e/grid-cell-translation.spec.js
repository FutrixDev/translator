const { test, expect } = require('@playwright/test');
const { contentHarnessScripts, contentStylesheet, PAGE_TRANSLATION_MODULES } = require('./helpers');

// Issue #152: a numbered-steps list where each <li> is a two-column grid — the ::before
// counter fills the 28px first column and the <p> fills the second. Inserting the translation
// as a sibling of the <p> made it one more grid item, auto-placed into the next free cell:
// row 2, column 1, i.e. the 28px counter column, so the Chinese came out one or two
// characters per line. The translation has to stay inside the <p>'s own cell. The same list
// with direct text in the <li> (no <p>) puts the translation inside the grid itself, so it
// has to span the row instead of taking the next free cell.
const SCRIPTS = contentHarnessScripts(...PAGE_TRANSLATION_MODULES);

const FIXTURE_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { width: 720px; }
  .steps { list-style: none; counter-reset: step; padding: 0; }
  .steps li { counter-increment: step; display: grid; grid-template-columns: 28px 1fr;
    gap: 0 12px; margin-bottom: 16px; }
  .steps li::before { content: counter(step, decimal-leading-zero); }
  .steps li p { margin: 0; }
</style>
<style>__CONTENT_CSS__</style>
</head><body>
  <ol class="steps">
    <li><p id="step"><strong>Truth first.</strong> <span>Every claim in the skill is
      checked against the source before it is written down, and nothing is assumed.</span></p></li>
    <li id="bare">Direct text in a grid list item also has to come out as wide as the step.</li>
  </ol>
  <p id="plain">A plain paragraph in normal block flow keeps its translation as a sibling.</p>
</body></html>`;

test('grid item: translation stays in the source cell, not the counter column', async ({ page }) => {
  await page.setContent(FIXTURE_HTML.replace('__CONTENT_CSS__', contentStylesheet()), { waitUntil: 'load' });
  for (const s of SCRIPTS) await page.addScriptTag({ path: s });

  const result = await page.evaluate(() => {
    const ctx = window.AI_TRANSLATOR_CONTENT;
    const blocks = ctx.collectTranslatableBlocks(document.body);
    blocks.forEach((b) => ctx.insertTranslationBlock(b, '[T] ' + b.text, { textLang: 'zh-CN' }));

    const step = document.getElementById('step');
    const plain = document.getElementById('plain');
    const li = step.parentElement;
    const translation = li.querySelector('.ai-translator-inline-block');
    const bare = document.querySelector('#bare > .ai-translator-inline-block');
    const rect = (el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, width: r.width };
    };
    return {
      collectedIds: blocks.map((b) => b.element.id).filter(Boolean).sort(),
      liChildren: li.children.length,
      translationParentId: translation && translation.parentElement.id,
      translationRect: translation && rect(translation),
      stepRect: rect(step),
      bareTranslationParentId: bare && bare.parentElement.id,
      bareTranslationRect: bare && rect(bare),
      plainNextIsTranslation: !!(plain.nextElementSibling
        && plain.nextElementSibling.classList.contains('ai-translator-inline-block'))
    };
  });

  expect(result.collectedIds).toEqual(['bare', 'plain', 'step']);
  // Inside the <p>, so the <li> grid still has exactly one item besides ::before.
  expect(result.translationParentId).toBe('step');
  expect(result.liChildren).toBe(1);
  // Lined up with the source text and as wide as it — not the 28px counter column.
  expect(Math.abs(result.translationRect.left - result.stepRect.left)).toBeLessThan(1);
  expect(Math.abs(result.translationRect.width - result.stepRect.width)).toBeLessThan(1);
  expect(result.translationRect.width).toBeGreaterThan(200);
  // A grid <li> with direct text: the translation is a grid item, spanning the whole row.
  expect(result.bareTranslationParentId).toBe('bare');
  expect(result.bareTranslationRect.width).toBeGreaterThan(200);
  // Normal block flow is untouched: still a sibling.
  expect(result.plainNextIsTranslation).toBe(true);
});

// The same failure through layouts where parentElement is not the box that lays the block
// out: a display:contents wrapper inside the grid, and a shadow root whose host is the grid.
// And a CSS table cell (display:table-cell div), where a sibling becomes an anonymous
// extra cell, as a sibling <td> would.
const SAME_CLASS_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { width: 720px; }
  .grid { display: grid; grid-template-columns: 28px 1fr; gap: 0 12px; margin-bottom: 16px; }
  .grid p { margin: 0; }
</style>
<style>__CONTENT_CSS__</style>
</head><body>
  <div class="grid"><span>01</span><div style="display:contents"><p id="contents">A paragraph
    behind a display:contents wrapper is still an item of the outer grid.</p></div></div>
  <div class="grid" id="host"></div>
  <div style="display:table;width:100%"><div id="cssRow" style="display:table-row">
    <div id="cell" style="display:table-cell">The first cell of a table drawn with CSS.</div>
    <div style="display:table-cell">The second cell of the same CSS table row.</div>
  </div></div>
</body></html>`;

test('grid item behind display:contents or a shadow host, and CSS table cells, translate inside', async ({ page }) => {
  await page.setContent(SAME_CLASS_HTML.replace('__CONTENT_CSS__', contentStylesheet()), { waitUntil: 'load' });
  await page.evaluate(() => {
    const root = document.getElementById('host').attachShadow({ mode: 'open' });
    root.innerHTML = '<span>02</span><p id="shadowed" style="margin:0">A paragraph at the top of'
      + ' a shadow root is an item of the grid that hosts it.</p>';
  });
  for (const s of SCRIPTS) await page.addScriptTag({ path: s });

  const result = await page.evaluate(() => {
    const ctx = window.AI_TRANSLATOR_CONTENT;
    const shadow = document.getElementById('host').shadowRoot;
    const blocks = [...ctx.collectTranslatableBlocks(document.body), ...ctx.collectTranslatableBlocks(shadow)];
    blocks.forEach((b) => ctx.insertTranslationBlock(b, '[T] ' + b.text, { textLang: 'zh-CN' }));
    const check = (source) => {
      const translation = source.querySelector(':scope > .ai-translator-inline-block');
      if (!translation) return null;
      const s = source.getBoundingClientRect();
      const t = translation.getBoundingClientRect();
      return { left: Math.round(t.left - s.left), widthRatio: t.width / s.width };
    };
    return {
      contents: check(document.getElementById('contents')),
      shadowed: check(shadow.getElementById('shadowed')),
      cell: check(document.getElementById('cell')),
      rowCells: document.getElementById('cssRow').children.length
    };
  });

  for (const key of ['contents', 'shadowed', 'cell']) {
    expect(result[key], `${key}: translation is not inside the source`).not.toBeNull();
    expect(result[key].left, `${key}: translation is not aligned with the source`).toBe(0);
    expect(result[key].widthRatio, `${key}: translation is squeezed`).toBeGreaterThan(0.9);
  }
  expect(result.rowCells).toBe(2);
});

// A block that is itself a horizontal flex row: an <li> with an icon before its text, a
// display:flex card in a grid. Whatever is appended to such a block is one more flex item,
// laid out beside the source instead of under it: the translation was squeezed into the
// right-hand part of the row. It has to go inside the flex item that holds the text; when
// that text is the row's own direct text (an anonymous flex item) it is wrapped first.
const FLEX_ROW_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { width: 720px; }
  .icons { list-style: none; padding: 0; }
  .icons li { display: flex; gap: 8px; align-items: flex-start; margin-bottom: 16px; }
  .cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
  .card { display: flex; align-items: center; gap: 8px; }
</style>
<style>__CONTENT_CSS__</style>
</head><body>
  <ul class="icons">
    <li id="iconText"><svg width="16" height="16"></svg>Direct text after an icon in a flex list
      item has to get its translation under the text, not squeezed to the right of it.</li>
    <li id="iconSpan"><svg width="16" height="16"></svg><span id="iconSpanText">Text in a span
      after an icon gets its translation inside that span, under the text itself.</span></li>
  </ul>
  <div class="cards">
    <div class="card" id="card1"><svg width="16" height="16"></svg>The first card of a grid is a
      flex row with its own icon and text.</div>
    <div class="card" id="card2">The second card has only its text and is laid out as a flex row.</div>
    <div class="card" id="card3">The third card is a flex row as well, and fills the last column.</div>
  </div>
</body></html>`;

async function translateFlexRows(page, { translationOnly = false } = {}) {
  await page.setContent(FLEX_ROW_HTML.replace('__CONTENT_CSS__', contentStylesheet()), { waitUntil: 'load' });
  for (const s of SCRIPTS) await page.addScriptTag({ path: s });
  await page.evaluate((only) => {
    const ctx = window.AI_TRANSLATOR_CONTENT;
    ctx.settings.showTranslationOnly = only;
    ctx.collectTranslatableBlocks(document.body)
      .forEach((b) => ctx.insertTranslationBlock(b, '[T] ' + b.text, { lang: 'zh-CN', textLang: 'zh-CN' }));
  }, translationOnly);
}

test('flex row: the translation goes under the text, inside the item that holds it', async ({ page }) => {
  await translateFlexRows(page);
  const result = await page.evaluate(() => {
    const rect = (el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, bottom: r.bottom, width: r.width };
    };
    const row = (id) => {
      const block = document.getElementById(id);
      const translation = block.querySelector('.ai-translator-inline-block');
      if (!translation) return null;
      const column = translation.parentElement;
      // The source text inside the column: everything before the translation.
      const range = document.createRange();
      range.setStart(column, 0);
      range.setEndBefore(translation);
      return {
        column: column.id || column.className,
        columnIsChildOfBlock: column.parentElement === block,
        flexItems: [...block.children].map((c) => c.tagName.toLowerCase()),
        translation: rect(translation),
        text: rect(range),
        columnRect: rect(column)
      };
    };
    return {
      iconText: row('iconText'),
      iconSpan: row('iconSpan'),
      cards: ['card1', 'card2', 'card3'].map(row),
      gridItems: document.querySelector('.cards').children.length
    };
  });

  for (const [name, r] of [['iconText', result.iconText], ['iconSpan', result.iconSpan], ...result.cards.map((c, i) => [`card${i + 1}`, c])]) {
    expect(r, `${name}: translation is not inside the block`).not.toBeNull();
    expect(r.columnIsChildOfBlock, `${name}: translation is not in a flex item of the row`).toBe(true);
    // Under the source text, starting where it starts, as wide as its column.
    expect(r.translation.top, `${name}: translation is beside the text, not under it`).toBeGreaterThanOrEqual(r.text.bottom - 1);
    expect(Math.abs(r.translation.left - r.text.left), `${name}: translation is not aligned with the text`).toBeLessThan(1);
    expect(Math.abs(r.translation.width - r.columnRect.width), `${name}: translation is squeezed`).toBeLessThan(1);
  }
  // Direct text is wrapped into one item; the row keeps exactly its icon and its text.
  expect(result.iconText.column).toBe('ai-translator-text-run');
  expect(result.iconText.flexItems).toEqual(['svg', 'span']);
  expect(result.iconSpan.column).toBe('iconSpanText');
  expect(result.iconSpan.flexItems).toEqual(['svg', 'span']);
  expect(result.cards[0].flexItems).toEqual(['svg', 'span']);
  expect(result.cards[1].flexItems).toEqual(['span']);
  // No card's translation became a grid cell of its own.
  expect(result.gridItems).toBe(3);
});

// Placing the translation wrapped the card's direct text in a text-run span, and releasing
// that translation leaves the span behind. When the target language changes, the next pass
// has to collect the card again, not the span. Collecting the span put the translation
// inline beside the text, because the span is an item of the card's flex row.
test('flex row: re-translating after a target-language change keeps the translation under the text', async ({ page }) => {
  await translateFlexRows(page);
  const result = await page.evaluate(() => {
    const ctx = window.AI_TRANSLATOR_CONTENT;
    ctx.currentTargetLang = () => 'ja';
    const again = ctx.collectTranslatableBlocks(document.body);
    again.forEach((b) => ctx.insertTranslationBlock(b, '[J] ' + b.text, { lang: 'ja', textLang: 'ja' }));
    return ['card1', 'card2', 'iconText'].map((id) => {
      const block = document.getElementById(id);
      const translations = block.querySelectorAll('.ai-translator-inline-block');
      const translation = translations[0];
      let under = false;
      if (translation) {
        const range = document.createRange();
        range.setStart(translation.parentElement, 0);
        range.setEndBefore(translation);
        under = translation.getBoundingClientRect().top >= range.getBoundingClientRect().bottom - 1;
      }
      return {
        id,
        collectedAsBlock: again.some((b) => b.element === block),
        translations: translations.length,
        inlineRight: !!translation && translation.classList.contains('ai-translator-inline-right'),
        text: translation && translation.textContent.slice(0, 4),
        under
      };
    });
  });
  for (const r of result) {
    expect(r, `${r.id}`).toEqual({ id: r.id, collectedAsBlock: true, translations: 1, inlineRight: false, text: '[J] ', under: true });
  }
});

test('flex row in translation-only mode: the text is hidden, the translation stays', async ({ page }) => {
  await translateFlexRows(page, { translationOnly: true });
  const result = await page.evaluate(() => ['iconText', 'card2'].map((id) => {
    const block = document.getElementById(id);
    const translation = block.querySelector('.ai-translator-inline-block');
    const wrap = block.querySelector('.ai-translator-source-wrap');
    return {
      sourceHidden: !!wrap && wrap.classList.contains('ai-translator-source-hidden') && wrap.getClientRects().length === 0,
      sourceText: wrap && wrap.textContent.trim().slice(0, 12),
      translationShown: translation.getClientRects().length > 0 && !translation.closest('.ai-translator-source-hidden')
    };
  }));
  expect(result).toEqual([
    { sourceHidden: true, sourceText: 'Direct text ', translationShown: true },
    { sourceHidden: true, sourceText: 'The second c', translationShown: true }
  ]);
});
