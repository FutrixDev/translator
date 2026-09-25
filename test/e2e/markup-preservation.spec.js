const { test, expect } = require('@playwright/test');
const { contentHarnessScripts, PAGE_TRANSLATION_MODULES } = require('./helpers');

// Focused DOM unit test of the REAL getTextWithMathPlaceholders +
// collectTranslatableBlocks + insertTranslationBlock/buildTranslationContent
// pipeline, loaded straight from source into a plain headless page (no
// extension, network, or display needed). Guards the inline-markup
// preservation feature:
//   - inline formatting elements (<a>, <strong>, …) are encoded as paired
//     numbered markers (<a1>…</a1>) in the extracted text, under BOTH engines;
//   - the rebuilt translation contains real cloned elements that keep
//     href/class but drop id and on* attributes;
//   - the parser is case- and whitespace-tolerant, because Chrome's on-device
//     NMT really does hand back `<A1>…</a1>`;
//   - a model that mangles or drops markers degrades to plain text, never to
//     broken DOM, and never leaks marker debris to the reader.
//
// On the builtin engine: markers used to be suppressed on the assumption that
// on-device NMT would shred them. Measured (en→zh-Hans/zh-Hant/ja, three runs
// per sentence, identical each time) that assumption is wrong — markers survive
// in the large majority of sentences. The one reproducible defect is an
// uppercased opening marker, which the tolerant regex below handles. Since the
// builtin engine is the DEFAULT, the old gate meant most users lost every link
// in every translation, which is the bug this suite now pins down.
const SCRIPTS = contentHarnessScripts(...PAGE_TRANSLATION_MODULES);

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
    ctx.insertTranslationBlock(rich, rich.text.replace('Please read', '[译]请阅读'), { textLang: 'zh-CN' });
    ctx.insertTranslationBlock(plain, '[译]' + plain.text, { textLang: 'zh-CN' });

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

test('builtin engine: markers are generated too, and NMT-style casing rebuilds', async ({ page }) => {
  await loadHarness(page);

  const result = await page.evaluate(() => {
    const ctx = window.AI_TRANSLATOR_CONTENT;
    ctx.builtinTranslator = { isActive: () => true };
    const blocks = ctx.collectTranslatableBlocks(document.body);
    const rich = blocks.find((b) => b.element.id === 'rich');

    // Exactly what Chrome's on-device translator returned for this shape:
    // the opening marker uppercased, the closing one left alone.
    ctx.insertTranslationBlock(rich, '请仔细阅读<A1>文档</a1>，然后再<STRONG2>开始工作</strong2>。', { textLang: 'zh-CN' });

    const translationEl = document.getElementById('rich').nextElementSibling;
    const a = translationEl.querySelector('a');
    const strong = translationEl.querySelector('strong');
    return {
      richText: rich.text,
      markupCount: rich.markupElements.length,
      aHref: a && a.getAttribute('href'),
      aText: a && a.textContent,
      strongText: strong && strong.textContent,
      translationText: translationEl.textContent,
    };
  });

  // The gate is gone: the builtin engine gets the same markers the AI engine does.
  expect(result.richText).toContain('<a1>');
  expect(result.richText).toContain('<strong2>');
  expect(result.markupCount).toBe(2);

  // …and an uppercased opener still rebuilds the real link, rather than
  // showing the reader four characters of "<A1>".
  expect(result.aHref).toBe('/docs');
  expect(result.aText).toBe('文档');
  expect(result.strongText).toBe('开始工作');
  expect(result.translationText).toBe('请仔细阅读文档，然后再开始工作。');
  expect(result.translationText).not.toMatch(/<\/?[a-z]+\d+>/i);
});

test('whitespace injected into a marker does not break the rebuild', async ({ page }) => {
  await loadHarness(page);

  const result = await page.evaluate(() => {
    const ctx = window.AI_TRANSLATOR_CONTENT;
    const blocks = ctx.collectTranslatableBlocks(document.body);
    const rich = blocks.find((b) => b.element.id === 'rich');

    const out = document.createElement('div');
    ctx.buildTranslationContent(out, '请阅读< a1 >文档</ a1 >。', rich);
    const a = out.querySelector('a');
    return { links: out.querySelectorAll('a').length, text: out.textContent, href: a && a.getAttribute('href') };
  });

  expect(result.links).toBe(1);
  expect(result.href).toBe('/docs');
  expect(result.text).toBe('请阅读文档。');
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

    // Case 2: the model invented a marker that was never handed out (<b9> — no
    // <b> and no 9 was ever issued for this block), and recombined two real
    // ones into a pair that was not (<a2>: 'a' and 2 were both issued, just
    // never together).
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

  // Never a fabricated element — a pair we did not hand out does not become a link.
  expect(result.mangledLinks).toBe(0);
  // <a2> is debris out of our own vocabulary ('a' and 2 were both issued for
  // this block), so it is scrubbed rather than shown to the reader. <b9> is
  // not: no <b> marker was ever issued here, so those characters belong to the
  // page — an HTML tutorial whose prose really does say "<b9>" keeps it.
  expect(result.mangledText).toBe('请阅读<b9>文档</b9>和说明。');

  // Missing close: element still built, content contained.
  expect(result.unclosedLinks).toBe(1);
  expect(result.unclosedLinkText).toBe('文档');
});

test('a marker whose number the model fused is scrubbed, the page\'s own <b2> is not', async ({ page }) => {
  // Reddit's feed-card header carried eleven class-bearing spans, so its markers
  // ran span1…span11, and the builtin engine wrote <span11> back as <span1111>.
  // An exact-match scrub cannot see that: no marker 1111 was ever handed out.
  // Every digit of it splits into issued numbers (11 + 11), so it is debris of
  // ours; <b2> is not — no <b> marker was issued — and stays as page prose.
  const words = Array.from({ length: 11 }, (_, i) => `<span class="w">word${i + 1}</span>`).join(' ');
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"></head><body>
    <p id="many">${words} and then the sentence finally ends.</p>
  </body></html>`, { waitUntil: 'load' });
  for (const s of SCRIPTS) await page.addScriptTag({ path: s });

  const result = await page.evaluate(() => {
    const ctx = window.AI_TRANSLATOR_CONTENT;
    const block = ctx.collectTranslatableBlocks(document.body).find((b) => b.element.id === 'many');
    const out = document.createElement('div');
    ctx.buildTranslationContent(out, '帖子<span1111>报告</span1111>，HTML 里 <b2> 是粗体。', block);
    return {
      issued: block.markupElements.map((mk) => `${mk.tag}${mk.index}`),
      text: out.textContent,
    };
  });

  expect(result.issued).toContain('span11');
  expect(result.issued).not.toContain('span1111');
  expect(result.text).toBe('帖子报告，HTML 里 <b2> 是粗体。');
});

test('a site-excluded element is a placeholder only when page collection asks for it', async ({ page }) => {
  // Page collection passes the site rule's exclude selector, so a timestamp
  // inside a collected block goes out as {{n}} and is cloned back untouched.
  // Hover and selection call the same reader without it: that is text the user
  // picked, and a site rule does not choose which words of it stay English.
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"></head><body>
    <p id="edited">Edited <time datetime="2026-09-25">4 hr. ago</time> to fix a typo.</p>
  </body></html>`, { waitUntil: 'load' });
  for (const s of SCRIPTS) await page.addScriptTag({ path: s });

  const result = await page.evaluate(() => {
    const ctx = window.AI_TRANSLATOR_CONTENT;
    // This page has a rule excluding <time>; the reader must still not look it up.
    ctx.resolveSiteAdapter = () => ({ atomic: '', exclude: 'time' });
    const el = document.getElementById('edited');
    const collected = ctx.getTextWithMathPlaceholders(el, { exclude: 'time' });
    const picked = ctx.getTextWithMathPlaceholders(el);
    return {
      collectedText: collected.text,
      collectedTags: collected.mathElements.map((m) => m.element && m.element.localName),
      pickedText: picked.text,
      pickedCount: picked.mathElements.length,
    };
  });

  expect(result.collectedText).toMatch(/^Edited \{\{\d+\}\} to fix a typo\.$/);
  expect(result.collectedTags).toEqual(['time']);
  expect(result.pickedText).toBe('Edited 4 hr. ago to fix a typo.');
  expect(result.pickedCount).toBe(0);
});
