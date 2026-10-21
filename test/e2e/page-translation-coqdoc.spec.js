// Software Foundations' Preface, as coqdoc writes it (test/fixtures/sf-preface): the
// prose is loose text nodes with inline <i> and <a><span class="inlineref">,
// cut into paragraphs by empty <div class="paragraph"> </div>, sitting next to
// the <h1>/<h2> headings and <ul class="doclist"> lists in the same div.doc.
//
// What the reader saw on the real page, and what each test pins:
//   - one paragraph arrived as three translations, cut at each <i> — the
//     collector's text run stopped at every element (content/page/collect.js
//     wrapDirectTextRuns); it now runs across inline markup and stops at
//     block-level boxes, <br> and our own nodes;
//   - "(B)" and "(C)" were never translated, and the fragments shared batches
//     with headings, so in translation-only mode paragraph text landed in
//     heading-styled clones;
//   - the bare "." after a link stayed as a fragment next to a translation that
//     already ended in "。", so the reader saw "。.";
//   - list-item translations started far left of the item text: the first-text
//     probe for the inset skipped <i>, and every coqdoc item opens with one;
//   - literal <span1>后记</span1> showed up: a marker the block never issued,
//     or one that landed in a block that issued none, went out as text.
const fs = require('fs');
const path = require('path');
const { test, expect } = require('./fixtures');
const { setExtensionSettings, triggerPageTranslation } = require('./helpers');
const { waitForPageRoundEnd } = require('./float-ball-helpers');
const { startMockOpenAIServer } = require('./mock-openai-server');

const ORIGIN = 'https://softwarefoundations.test';
const DIR = path.join(__dirname, '..', 'fixtures', 'sf-preface');
const HTML = fs.readFileSync(path.join(DIR, 'Preface.html'), 'utf8');
const CSS = fs.readFileSync(path.join(DIR, 'sf.css'), 'utf8');
const DELIMITER = '⟪⟫⟪⟫⟪⟫';
const MARKER = /<\/?[a-z]+\d+>/i;

// Every segment that left the browser, one batch request split back into its blocks.
const segmentsOf = (mock) => mock.sentTexts.flatMap((text) => text.split(DELIMITER)).filter(Boolean);

async function translatePreface(page, context, { only, translate } = {}) {
  const mock = await startMockOpenAIServer(translate ? { translate } : {});
  await setExtensionSettings(page, {
    apiEndpoint: mock.endpoint, apiKey: 'test-key', modelName: 'gpt-4.1-mini', targetLang: 'zh-CN',
    skipTargetLanguageText: false, showTranslationOnly: !!only,
  });
  await context.route(`${ORIGIN}/**`, (route) => {
    const css = route.request().url().endsWith('.css');
    route.fulfill({ status: 200, contentType: css ? 'text/css' : 'text/html', body: css ? CSS : HTML });
  });
  await page.setViewportSize({ width: 1100, height: 900 });
  await page.goto(`${ORIGIN}/lf-current/Preface.html`);
  await page.waitForSelector('#ai-translator-float-ball');
  await triggerPageTranslation(page);
  await waitForPageRoundEnd(page, 60000);
  return mock;
}

for (const only of [false, true]) {
  const mode = only ? 'translation-only' : 'bilingual';

  test(`coqdoc prose goes out one paragraph per block (${mode})`, async ({ page, context }) => {
    const mock = await translatePreface(page, context, { only });
    try {
      const sent = segmentsOf(mock);
      const inductive = sent.filter((s) => s.includes('inductive proof'));
      expect(inductive).toEqual([
        'In particular, the fundamental tools of <i1>inductive proof</i1> are ubiquitous in all of computer science. '
        + 'You have surely seen them before, perhaps in a course on discrete math or analysis of algorithms, '
        + 'but in this course we will examine them more deeply than you have probably done so far.',
      ]);
      expect(sent).toContain('(A) basic tools from <i1>logic</i1> for making and justifying precise claims about programs;');
      expect(sent).toContain('(B) the use of <i1>proof assistants</i1> (or <i2>provers</i2>) to construct rigorous logical arguments;');
      expect(sent.filter((s) => s.startsWith('(C) <i1>functional programming</i1>, both as a method'))).toHaveLength(1);
      // A link inside a sentence stays inside it, nested markup and all.
      expect(sent).toContain('Install Docker from <a1><span2>https://www.docker.com/get-started/</span2></a1>or make sure your existing installation is up to date.');
      expect(sent.filter((s) => s.includes('further reading in the <a1><span2>Postscript</span2></a1> chapter'))).toHaveLength(1);
      // No fragment of a sentence goes out on its own — not the "are ubiquitous…"
      // tail after an <i>, not the bare "." after a link: every segment starts
      // where a sentence, a heading or a link label starts.
      const fragments = sent.filter((s) => /^[\s.,;:)]|^[a-z]/.test(s.replace(/<\/?[a-z]+\d+>/gi, '')));
      expect(fragments).toEqual([]);

      const main = await page.evaluate(() => document.getElementById('main').innerText);
      expect(main).not.toMatch(MARKER);
    } finally {
      await mock.close();
    }
  });
}

test('a coqdoc text run gets its translation as a block below it, aligned with it', async ({ page, context }) => {
  const mock = await translatePreface(page, context);
  try {
    const geometry = await page.evaluate(() => {
      // Where the first visible character starts (the echo opens with "[T]").
      const firstGlyphLeft = (root) => {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const at = node.data.search(/\S/);
          if (at < 0) continue;
          const range = document.createRange();
          range.setStart(node, at);
          range.setEnd(node, at + 1);
          return range.getBoundingClientRect().left;
        }
        return null;
      };
      const run = [...document.querySelectorAll('span.ai-translator-text-run')]
        .find((el) => el.textContent.includes('In particular, the fundamental tools'));
      const runTranslation = run.nextElementSibling;
      const runRects = run.getClientRects();
      const item = [...document.querySelectorAll('ul.doclist > li')]
        .find((li) => li.textContent.includes('Automated theorem provers'));
      const itemTranslation = item.querySelector(':scope > .ai-translator-inline-block');
      return {
        runTranslationClass: runTranslation.className,
        runTranslationText: runTranslation.textContent,
        runTranslationDisplay: getComputedStyle(runTranslation).display,
        runBottom: runRects[runRects.length - 1].bottom,
        runTranslationTop: runTranslation.getBoundingClientRect().top,
        runLeft: firstGlyphLeft(run),
        runTranslationLeft: firstGlyphLeft(runTranslation),
        itemLeft: firstGlyphLeft(item),
        itemTranslationLeft: itemTranslation && firstGlyphLeft(itemTranslation),
      };
    });

    expect(geometry.runTranslationClass).toContain('ai-translator-inline-block');
    expect(geometry.runTranslationClass).not.toContain('ai-translator-inline-right');
    expect(geometry.runTranslationText.startsWith('[T] In particular')).toBe(true);
    expect(geometry.runTranslationDisplay).toBe('block');
    expect(geometry.runTranslationTop).toBeGreaterThanOrEqual(geometry.runBottom - 1);
    expect(Math.abs(geometry.runTranslationLeft - geometry.runLeft)).toBeLessThanOrEqual(2);
    // The list item opens with <i>Automated theorem provers</i>: its translation
    // starts under the item's first word, not out at the bullet's left gap.
    expect(geometry.itemTranslationLeft).not.toBeNull();
    expect(Math.abs(geometry.itemTranslationLeft - geometry.itemLeft)).toBeLessThanOrEqual(2);
  } finally {
    await mock.close();
  }
});

test('a marker the block never issued, or that lands in a block that issued none, never shows (translation-only)', async ({ page, context }) => {
  // The model answers three blocks badly, the way the real page came back:
  //   - Further Reading (issued a1 span2 a3 span4): the nested link collapsed
  //     into a renamed <span1>, and an <em1> it made up;
  //   - "Make sure Docker is running." (issued nothing): a translation that
  //     carries a marker anyway — a batch that came back out of step does this;
  //   - System Requirements' prose: a literal "<b2>" that the source never wrote.
  const translate = (segment) => {
    if (segment.startsWith('This text is intended to be self contained')) {
      return '本书自成一体，想深入的读者可在<span1>后记</span1>一章找到<em1>延伸阅读</em1>建议。文献信息见文件<span1>参考文献</span1>。';
    }
    if (segment === 'Make sure Docker is running.') return '确保<span1>Docker</span1>正在运行。';
    if (segment.startsWith('Rocq runs on Windows')) return 'Rocq 可在 Windows、Linux 和 macOS 上运行<b2>。';
    return `[T] ${segment}`;
  };
  const mock = await translatePreface(page, context, { only: true, translate });
  try {
    const texts = await page.evaluate(() => {
      const translations = [...document.querySelectorAll('#main .ai-translator-inline-block')].map((el) => el.textContent);
      return {
        further: translations.find((t) => t.startsWith('本书自成一体')),
        docker: translations.find((t) => t.startsWith('确保')),
        rocq: translations.find((t) => t.startsWith('Rocq 可在')),
        main: document.getElementById('main').innerText,
      };
    });
    expect(texts.further).toBe('本书自成一体，想深入的读者可在后记一章找到延伸阅读建议。文献信息见文件参考文献。');
    expect(texts.docker).toBe('确保Docker正在运行。');
    expect(texts.rocq).toBe('Rocq 可在 Windows、Linux 和 macOS 上运行。');
    expect(texts.main).not.toMatch(MARKER);
  } finally {
    await mock.close();
  }
});
