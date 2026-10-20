// Hover translation over a whole article inside one <pre>.
//
// page-translation-prose-pre.spec.js has the background: old-style blogs (antirez.com
// site-wide) keep the article body in one <pre> that CSS wraps, with a blank line
// between paragraphs. Page translation reads such a <pre> as prose; hover translation
// used to skip every <pre> as code, so holding the hotkey over the body did nothing.
//
// The unit is the paragraph under the pointer, not the whole <pre>. Text that sits
// directly in the <pre> gives the pointer no element to land on: every paragraph,
// and every blank line between them, is the same mouseover target. So sliding from
// a blank line onto a paragraph is walked here, and so is pressing the hotkey while
// the pointer rests on a paragraph.
//
// A <pre> that is code stays untouched: one that holds <code>, a plain one that does
// not wrap, and a read-only editor's line.
const { test, expect } = require('./fixtures');
const { setExtensionSettings } = require('./helpers');
const { startMockOpenAIServer } = require('./mock-openai-server');

const ORIGIN = 'https://prose-pre.test';

const LEAD_BEFORE = 'The harbour master published a short note on the ferry schedule';
const LEAD_AFTER = 'and most of the replies agree with his reading of the tide tables.';
const MIDDLE = 'Passengers who miss the morning crossing can wait for the afternoon boat or take the coastal road instead.';
const LAST = 'Nothing in the new schedule changes the winter timetable, which stays as it was last year.';
const WRAPPED_CODE = 'Restart the lighthouse daemon before the evening shift begins.';
const UNWRAPPED = 'Keep the original column layout of this weather report intact.';
const EDITOR_LINE = 'Remember to update the tide table before publishing the notice.';

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Is the ferry safe? - &lt;harbour&gt;</title>
<style>
  topcomment { display: block; }
  .comment pre { white-space: pre-wrap; word-wrap: break-word; font-family: Courier, monospace; }
</style></head>
<body><div id="container">
<div id="content">
<topcomment><article class="comment"><span class="info">keeper 12 days ago.</span><pre id="post">${LEAD_BEFORE} (<a href="/notes/ferry">the note</a>), ${LEAD_AFTER}

${MIDDLE}

${LAST}</pre></article></topcomment>
<article class="comment"><pre id="wrapped-code"><code>${WRAPPED_CODE}</code></pre></article>
<pre id="unwrapped">${UNWRAPPED}</pre>
<div class="CodeMirror"><div class="CodeMirror-code" role="presentation"><pre id="editor-line" class="CodeMirror-line" style="white-space: pre-wrap">${EDITOR_LINE}</pre></div></div>
</div></div></body></html>`;

async function openPage(page, context, endpoint) {
  await setExtensionSettings(page, {
    apiEndpoint: endpoint,
    apiKey: 'test-key',
    modelName: 'gpt-4.1-mini',
    targetLang: 'zh-CN',
    skipTargetLanguageText: false,
  });
  await context.route(`${ORIGIN}/**`, (route) => {
    route.fulfill({ status: 200, contentType: 'text/html', body: PAGE });
  });
  await page.goto(`${ORIGIN}/news/7`);
  await page.waitForSelector('#ai-translator-float-ball');
}

const sentCount = (sentTexts, text) => sentTexts.filter((sent) => sent.includes(text)).length;

/**
 * Where the first words of `text` are drawn inside `selector`: the pointer has to
 * land on the words themselves, the paragraph has no box of its own. `linesUp`
 * moves the point that many lines higher, onto the blank line above a paragraph.
 * @param {import('@playwright/test').Page} page
 */
function pointOnText(page, selector, text, linesUp = 0) {
  return page.evaluate(([sel, needle, up]) => {
    const walker = document.createTreeWalker(document.querySelector(sel), NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.data.indexOf(needle);
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + 12);
      const rect = range.getClientRects()[0];
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 - up * rect.height };
    }
    throw new Error(`"${needle}" is not in ${sel}`);
  }, [selector, text, linesUp]);
}

async function moveOnto(page, selector, text, linesUp = 0) {
  const { x, y } = await pointOnText(page, selector, text, linesUp);
  await page.mouse.move(x, y);
}

async function expectCodeLeftAlone(page, sentTexts) {
  const all = sentTexts.join('\n');
  expect(all).not.toContain(WRAPPED_CODE);
  expect(all).not.toContain(UNWRAPPED);
  expect(all).not.toContain(EDITOR_LINE);
  await expect(page.locator('.ai-translator-hover-translation')
    .filter({ hasText: /lighthouse|weather report|tide table before/ })).toHaveCount(0);
  await expect(page.locator('#editor-line .ai-translator-text-run')).toHaveCount(0);
  await expect(page.locator('#unwrapped .ai-translator-text-run')).toHaveCount(0);
}

test('prose <pre>: holding the hotkey and sweeping translates the paragraph under the pointer', async ({ page, context }) => {
  const { close, endpoint, sentTexts } = await startMockOpenAIServer();

  try {
    await openPage(page, context, endpoint);
    const translations = page.locator('#post > .ai-translator-hover-translation');

    await page.keyboard.down('Shift');
    // Code first: the sweep crosses all three before it reaches the article.
    await moveOnto(page, '#wrapped-code', WRAPPED_CODE);
    await moveOnto(page, '#unwrapped', UNWRAPPED);
    await moveOnto(page, '#editor-line', EDITOR_LINE);

    // Into the article on the blank line above a paragraph: no paragraph there, so
    // nothing is sent. Then down onto the words, which are text in the same <pre>:
    // no element boundary between them, so no mouseover either.
    await moveOnto(page, '#post', MIDDLE, 1);
    await page.waitForTimeout(300);
    await expect(page.locator('.ai-translator-hover-translation')).toHaveCount(0);
    await moveOnto(page, '#post', MIDDLE);
    await expect(translations).toHaveCount(1, { timeout: 30000 });
    await expect(translations.nth(0)).toContainText(MIDDLE);
    await expect(translations.nth(0)).not.toContainText(LAST);
    await expect(translations.nth(0)).not.toContainText(LEAD_AFTER);
    expect(sentCount(sentTexts, MIDDLE)).toBe(1);
    expect(sentCount(sentTexts, LAST)).toBe(0);
    expect(sentCount(sentTexts, LEAD_AFTER)).toBe(0);

    // On to the next paragraph.
    await moveOnto(page, '#post', LAST);
    await expect(translations).toHaveCount(2, { timeout: 30000 });
    await expect(translations.nth(1)).toContainText(LAST);
    await expect(translations.nth(1)).not.toContainText(MIDDLE);
    expect(sentCount(sentTexts, LAST)).toBe(1);
    expect(sentCount(sentTexts, MIDDLE)).toBe(1);
    expect(sentCount(sentTexts, LEAD_AFTER)).toBe(0);

    // A paragraph reads as a paragraph: its translation is a block below it, not a
    // run of text glued onto its last line.
    const displays = await translations.evaluateAll((els) => els.map((el) => getComputedStyle(el).display));
    expect(displays).toEqual(['block', 'block']);
    await page.keyboard.up('Shift');

    await expectCodeLeftAlone(page, sentTexts);
  } finally {
    await close();
  }
});

test('prose <pre>: pressing the hotkey while resting on a paragraph toggles that paragraph', async ({ page, context }) => {
  const { close, endpoint, sentTexts } = await startMockOpenAIServer();

  try {
    await openPage(page, context, endpoint);
    const translations = page.locator('#post > .ai-translator-hover-translation');

    await moveOnto(page, '#post', LEAD_BEFORE);
    await page.keyboard.press('Shift');
    await expect(translations).toHaveCount(1, { timeout: 30000 });
    await expect(translations.nth(0)).toContainText(LEAD_AFTER);
    await expect(translations.nth(0)).not.toContainText(MIDDLE);
    expect(sentCount(sentTexts, LEAD_AFTER)).toBe(1);
    expect(sentCount(sentTexts, MIDDLE)).toBe(0);

    // Pressed again over the same paragraph: its translation goes away.
    await moveOnto(page, '#post', LEAD_BEFORE);
    await page.keyboard.press('Shift');
    await expect(translations).toHaveCount(0);

    // Resting on code, the hotkey does nothing.
    await moveOnto(page, '#unwrapped', UNWRAPPED);
    await page.keyboard.press('Shift');
    await moveOnto(page, '#editor-line', EDITOR_LINE);
    await page.keyboard.press('Shift');
    await page.waitForTimeout(500);
    await expectCodeLeftAlone(page, sentTexts);
  } finally {
    await close();
  }
});
