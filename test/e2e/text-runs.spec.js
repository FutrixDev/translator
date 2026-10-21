const { test, expect } = require('@playwright/test');
const { contentHarnessScripts, PAGE_TRANSLATION_MODULES } = require('./helpers');

// The collector's text-run anchors (content/page/text-runs.js, cut by
// ctx.breaksInlineRun), loaded straight from source into a plain page.
// A run is moved into one span, so only elements that lose nothing when they
// are reparented may sit inside it:
//   - a list, or any container, set to display:inline is still a container:
//     moving it into a span inside its parent re-collected the parent's text on
//     every pass, nesting spans until the stack overflowed;
//   - an <iframe>, <video>, <audio>, <object>, <embed> or form control reloads,
//     restarts or loses its value when it is moved, so it breaks the run;
//   - an anchor we already made is never wrapped again, even when page script
//     puts a block inside it.
// Newlines in a translation survive only where the source keeps them
// (white-space: pre-wrap and friends, which is what a prose <pre> is).
const SCRIPTS = contentHarnessScripts(...PAGE_TRANSLATION_MODULES);
const RUN = 'ai-translator-text-run';

async function load(page, body) {
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`);
  for (const s of SCRIPTS) await page.addScriptTag({ path: s });
}

const runTexts = (page) => page.evaluate((cls) => [...document.querySelectorAll(`.${cls}`)]
  .map((el) => el.textContent.replace(/\s+/g, ' ').trim()), RUN);

test('an inline-styled list breaks the run and stays where it was', async ({ page }) => {
  await load(page, `<div id="host">Posted in <ul id="tags" style="display:inline"><li style="display:inline"><a href="/news">News and stuff</a></li></ul> by the editor today<p>A block sibling that is a paragraph of its own.</p></div>`);
  const result = await page.evaluate((cls) => {
    const ctx = window.AI_TRANSLATOR_CONTENT;
    ctx.collectTranslatableBlocks(document.body);
    ctx.collectTranslatableBlocks(document.body);
    return {
      listParent: document.getElementById('tags').parentElement.id,
      nested: document.querySelectorAll(`.${cls} .${cls}`).length,
    };
  }, RUN);
  expect(result.listParent).toBe('host');
  expect(result.nested).toBe(0);
  expect(await runTexts(page)).toEqual(expect.arrayContaining(['Posted in', 'by the editor today']));
});

test('an iframe breaks the run and is never moved', async ({ page }) => {
  await load(page, `<div id="host">Tap <iframe id="frame" style="width:40px;height:20px"></iframe> here to watch the movie trailer<p>A block sibling that is a paragraph of its own.</p></div>`);
  const result = await page.evaluate(() => {
    window.AI_TRANSLATOR_CONTENT.collectTranslatableBlocks(document.body);
    return document.getElementById('frame').parentElement.id;
  });
  expect(result).toBe('host');
  expect(await runTexts(page)).toContain('here to watch the movie trailer');
});

test('inline phrasing markup and images stay inside one run', async ({ page }) => {
  await load(page, `<div id="host">Read <em>this</em> with <img alt="" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="8" height="8"> care today<p>A block sibling that is a paragraph of its own.</p></div>`);
  await page.evaluate(() => window.AI_TRANSLATOR_CONTENT.collectTranslatableBlocks(document.body));
  expect(await runTexts(page)).toContain('Read this with care today');
});

test('an svg the page made a block breaks the run, even inside a span', async ({ page }) => {
  await load(page, `<div id="host">Look closely at <span><svg style="display:block" width="8" height="8"></svg></span> the chart below<p>A block sibling that is a paragraph of its own.</p></div>`);
  await page.evaluate(() => window.AI_TRANSLATOR_CONTENT.collectTranslatableBlocks(document.body));
  expect(await runTexts(page)).toEqual(expect.arrayContaining(['Look closely at', 'the chart below']));
});

test('an anchor is never wrapped again, even with a block put inside it', async ({ page }) => {
  await load(page, `<div id="host">Loose text that the collector anchors in a run<p>A block sibling that is a paragraph of its own.</p></div>`);
  const nested = await page.evaluate((cls) => {
    const ctx = window.AI_TRANSLATOR_CONTENT;
    ctx.collectTranslatableBlocks(document.body);
    const run = document.querySelector(`.${cls}`);
    const inner = document.createElement('div');
    inner.innerHTML = '<p>Another paragraph that page script dropped in here.</p>';
    run.appendChild(inner);
    ctx.collectTranslatableBlocks(document.body);
    return document.querySelectorAll(`.${cls} .${cls}`).length;
  }, RUN);
  expect(nested).toBe(0);
});

test('a translation keeps its newlines only where the source keeps them', async ({ page }) => {
  await load(page, `<div id="wrap" style="white-space:pre-wrap">First line of the poem here
second line of the poem here</div><p id="plain">An ordinary paragraph that wraps on its own.</p>`);
  const result = await page.evaluate(() => {
    const ctx = window.AI_TRANSLATOR_CONTENT;
    const blocks = ctx.collectTranslatableBlocks(document.body);
    const wrap = blocks.find((b) => b.element.id === 'wrap');
    const plain = blocks.find((b) => b.element.id === 'plain');
    ctx.insertTranslationBlock(wrap, '诗的第一行\n诗的第二行', { textLang: 'zh-CN' });
    ctx.insertTranslationBlock(plain, '普通的\n一段', { textLang: 'zh-CN' });
    return {
      wrap: document.getElementById('wrap').nextElementSibling.innerText,
      plain: document.getElementById('plain').nextElementSibling.innerText,
    };
  });
  expect(result.wrap).toBe('诗的第一行\n诗的第二行');
  expect(result.plain).toBe('普通的 一段');
});

test('a prose <pre> paragraph keeps the translation\'s newlines', async ({ page }) => {
  await load(page, `<pre id="post" style="white-space:pre-wrap">The first paragraph of a post that is written in a pre element
and wraps onto a second line of its own.

The second paragraph of the same post, after one blank line.</pre>`);
  const text = await page.evaluate(() => {
    const ctx = window.AI_TRANSLATOR_CONTENT;
    const blocks = ctx.collectTranslatableBlocks(document.body);
    const first = blocks.find((b) => b.element.textContent.startsWith('The first paragraph'));
    ctx.insertTranslationBlock(first, '帖子的第一段\n折到第二行', { textLang: 'zh-CN' });
    return [...document.querySelectorAll('#post .ai-translator-inline-block')].map((el) => el.innerText);
  });
  expect(text).toEqual(['帖子的第一段\n折到第二行']);
});
