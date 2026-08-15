const { test, expect } = require('@playwright/test');
const path = require('path');

// Focused DOM unit test of the REAL getTextWithMathPlaceholders +
// collectTranslatableBlocks + insertTranslationBlock/buildTranslationContent
// pipeline, loaded straight from source into a plain headless page (no
// extension, network, or display needed). Guards the inline-markup
// preservation feature:
//   - with the AI engine, inline formatting elements (<a>, <strong>, …) are
//     encoded as paired numbered markers (<a1>…</a1>) in the extracted text;
//   - the rebuilt translation contains real cloned elements that keep
//     href/class but drop id and on* attributes;
//   - the builtin engine never sees markers (on-device NMT cannot be trusted
//     to round-trip them);
//   - a model that mangles or drops markers degrades to plain text, never to
//     broken DOM.
const ROOT = path.join(__dirname, '..', '..');
const SCRIPTS = [
  path.join(ROOT, 'i18n/messages.js'),
  path.join(ROOT, 'content/content-bootstrap.js'),
  path.join(ROOT, 'content/content-page-translation.js'),
];

const FIXTURE_HTML = `<!doctype html><html><head><meta charset="utf-8"></head><body>
  <p id="rich">Please read <a id="doc-link" class="doc-link" href="/docs" onclick="evil()">the documentation</a> carefully before you <strong>start working</strong> on the project.</p>
  <p id="plain">A perfectly ordinary paragraph with no inline formatting at all in it.</p>
</body></html>`;

async function loadHarness(page) {
  await page.setContent(FIXTURE_HTML, { waitUntil: 'load' });
  for (const s of SCRIPTS) await page.addScriptTag({ path: s });
}

test('AI engine: inline markup becomes paired markers and survives round-trip', async ({ page }) => {
  await loadHarness(page);

  const result = await page.evaluate(() => {
    const ctx = window.AI_TRANSLATOR_CONTENT;
    // No builtin translator module in this harness → usingBuiltinEngine() is
    // false → markers are generated, same as a real 'ai'-engine session.
    const blocks = ctx.collectTranslatableBlocks(document.body);
    const rich = blocks.find((b) => b.element.id === 'rich');
    const plain = blocks.find((b) => b.element.id === 'plain');

    // Simulate a well-behaved model: markers preserved, text "translated".
    ctx.insertTranslationBlock(rich, rich.text.replace('Please read', '[译]请阅读'));
    ctx.insertTranslationBlock(plain, '[译]' + plain.text);

    const translationEl = document.getElementById('rich').nextElementSibling;
    const a = translationEl.querySelector('a');
    const strong = translationEl.querySelector('strong');
    const plainTranslation = document.getElementById('plain').nextElementSibling;
    return {
      richText: rich.text,
      markupCount: rich.markupElements.length,
      plainMarkup: plain.markupElements.length,
      isInlineBlock: translationEl.classList.contains('ai-translator-inline-block'),
      aExists: !!a,
      aHref: a && a.getAttribute('href'),
      aClass: a && a.getAttribute('class'),
      aId: a && a.getAttribute('id'),
      aOnclick: a && a.getAttribute('onclick'),
      aText: a && a.textContent,
      strongExists: !!strong,
      strongText: strong && strong.textContent,
      translationText: translationEl.textContent,
      plainText: plainTranslation.textContent,
    };
  });

  // Extraction: paired numbered markers, in order of appearance.
  expect(result.richText).toContain('<a1>');
  expect(result.richText).toContain('</a1>');
  expect(result.richText).toContain('<strong2>');
  expect(result.richText).toContain('</strong2>');
  expect(result.markupCount).toBe(2);
  expect(result.plainMarkup).toBe(0);

  // Rebuild: real elements, page attributes preserved, unsafe ones dropped.
  expect(result.isInlineBlock).toBe(true);
  expect(result.aExists).toBe(true);
  expect(result.aHref).toBe('/docs');
  expect(result.aClass).toBe('doc-link');
  expect(result.aId).toBeNull();
  expect(result.aOnclick).toBeNull();
  expect(result.aText).toBe('the documentation');
  expect(result.strongExists).toBe(true);
  expect(result.strongText).toBe('start working');

  // No marker text leaks into what the reader sees.
  expect(result.translationText).not.toMatch(/<\/?[a-z]+\d+>/);
  expect(result.plainText).toBe('[译]A perfectly ordinary paragraph with no inline formatting at all in it.');
});

test('builtin engine: no markers are generated at all', async ({ page }) => {
  await loadHarness(page);

  const richText = await page.evaluate(() => {
    const ctx = window.AI_TRANSLATOR_CONTENT;
    ctx.builtinTranslator = { isActive: () => true };
    const blocks = ctx.collectTranslatableBlocks(document.body);
    return blocks.find((b) => b.element.id === 'rich').text;
  });

  expect(richText).not.toMatch(/<\/?[a-z]+\d+>/);
  expect(richText).toContain('the documentation');
});

test('a model that mangles or drops markers degrades to plain text', async ({ page }) => {
  await loadHarness(page);

  const result = await page.evaluate(() => {
    const ctx = window.AI_TRANSLATOR_CONTENT;
    const blocks = ctx.collectTranslatableBlocks(document.body);
    const rich = blocks.find((b) => b.element.id === 'rich');

    // Case 1: the model dropped every marker.
    const dropped = document.createElement('div');
    ctx.buildTranslationContent(dropped, '请在开始项目之前仔细阅读文档。', rich);

    // Case 2: the model invented a marker that was never handed out, and
    // renumbered a real one to a wrong tag name.
    const mangled = document.createElement('div');
    ctx.buildTranslationContent(mangled, '请阅读<b9>文档</b9>和<a2>说明</a2>。', rich);

    // Case 3: the model forgot a closing marker — auto-closed at the end,
    // never an exception or a node outside the container.
    const unclosed = document.createElement('div');
    ctx.buildTranslationContent(unclosed, '请阅读<a1>文档', rich);

    return {
      droppedHTML: dropped.innerHTML,
      droppedText: dropped.textContent,
      mangledText: mangled.textContent,
      mangledLinks: mangled.querySelectorAll('a').length,
      unclosedLinks: unclosed.querySelectorAll('a').length,
      unclosedLinkText: unclosed.querySelector('a') && unclosed.querySelector('a').textContent,
    };
  });

  expect(result.droppedHTML).toBe('请在开始项目之前仔细阅读文档。');
  expect(result.droppedText).toBe('请在开始项目之前仔细阅读文档。');

  // Unknown/mismatched markers stay as literal text — ugly but honest, and
  // never a fabricated element.
  expect(result.mangledLinks).toBe(0);
  expect(result.mangledText).toBe('请阅读<b9>文档</b9>和<a2>说明</a2>。');

  // Missing close: element still built, content contained.
  expect(result.unclosedLinks).toBe(1);
  expect(result.unclosedLinkText).toBe('文档');
});
