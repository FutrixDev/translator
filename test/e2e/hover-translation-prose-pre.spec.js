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
// not wrap, a read-only editor's line, and one inside a syntax-highlighting container.
// So does a <pre> the user is typing into.
//
// Hover wraps the paragraph it translates in an anchor span, and page translation
// takes such an anchor as it is. So hover must not wrap a paragraph page translation
// would refuse (one that is only a link), and nothing but a hover may wrap at all:
// a right-click leaves the page as it was. Wrapping moves the paragraph's text into
// the anchor, so it must not happen under a selection the user is making either.
const { test, expect } = require('./fixtures');
const { setExtensionSettings, triggerPageTranslation } = require('./helpers');
const { waitForPageRoundEnd } = require('./float-ball-helpers');
const { startMockOpenAIServer } = require('./mock-openai-server');

const ORIGIN = 'https://prose-pre.test';

const LEAD_BEFORE = 'The harbour master published a short note on the ferry schedule';
const LEAD_AFTER = 'and most of the replies agree with his reading of the tide tables.';
const MIDDLE = 'Passengers who miss the morning crossing can wait for the afternoon boat or take the coastal road instead.';
const LAST = 'Nothing in the new schedule changes the winter timetable, which stays as it was last year.';
const WRAPPED_CODE = 'Restart the lighthouse daemon before the evening shift begins.';
const UNWRAPPED = 'Keep the original column layout of this weather report intact.';
const EDITOR_LINE = 'Remember to update the tide table before publishing the notice.';
const LINK_ONLY = 'https://harbour.test/notes/ferry-schedule-2026';
const HIGHLIGHTED = 'Check the anchor chain twice before every winter storm.';
const EDITABLE = 'Draft a reply to the harbour master about the new timetable.';

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

${LINK_ONLY}

${LAST}</pre></article></topcomment>
<article class="comment"><pre id="wrapped-code"><code>${WRAPPED_CODE}</code></pre></article>
<pre id="unwrapped">${UNWRAPPED}</pre>
<div class="CodeMirror"><div class="CodeMirror-code" role="presentation"><pre id="editor-line" class="CodeMirror-line" style="white-space: pre-wrap">${EDITOR_LINE}</pre></div></div>
<div class="highlight"><pre id="highlighted" style="white-space: pre-wrap">${HIGHLIGHTED}</pre></div>
<pre id="editable" contenteditable="true" style="white-space: pre-wrap">${EDITABLE}</pre>
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
 * moves the point that many lines higher, onto the blank line above a paragraph;
 * `firstGlyph` puts it on the left edge of the first letter instead of mid-word.
 * @param {import('@playwright/test').Page} page
 */
function pointOnText(page, selector, text, { linesUp = 0, firstGlyph = false } = {}) {
  return page.evaluate(([sel, needle, up, edge]) => {
    const walker = document.createTreeWalker(document.querySelector(sel), NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.data.indexOf(needle);
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + 12);
      const rect = range.getClientRects()[0];
      return { x: edge ? rect.left + 1 : rect.left + rect.width / 2, y: rect.top + rect.height / 2 - up * rect.height };
    }
    throw new Error(`"${needle}" is not in ${sel}`);
  }, [selector, text, linesUp, firstGlyph]);
}

async function moveOnto(page, selector, text, options) {
  const { x, y } = await pointOnText(page, selector, text, options);
  await page.mouse.move(x, y);
}

async function expectCodeLeftAlone(page, sentTexts) {
  const all = sentTexts.join('\n');
  expect(all).not.toContain(WRAPPED_CODE);
  expect(all).not.toContain(UNWRAPPED);
  expect(all).not.toContain(EDITOR_LINE);
  expect(all).not.toContain(HIGHLIGHTED);
  expect(all).not.toContain(EDITABLE);
  await expect(page.locator('.ai-translator-hover-translation')
    .filter({ hasText: /lighthouse|weather report|tide table before|anchor chain|Draft a reply/ })).toHaveCount(0);
  for (const id of ['#editor-line', '#unwrapped', '#highlighted', '#editable']) {
    await expect(page.locator(`${id} .ai-translator-text-run`)).toHaveCount(0);
  }
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
    await moveOnto(page, '#highlighted', HIGHLIGHTED);
    await moveOnto(page, '#editable', EDITABLE);

    // Into the article on the blank line above a paragraph: no paragraph there, so
    // nothing is sent. Then down onto the words, which are text in the same <pre>:
    // no element boundary between them, so no mouseover either.
    await moveOnto(page, '#post', MIDDLE, { linesUp: 1 });
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

    // Resting on the very first letter of a paragraph counts as resting on it, also
    // while the <pre> is still one run of text, before any paragraph was looked at.
    await moveOnto(page, '#post', LAST, { firstGlyph: true });
    await page.keyboard.press('Shift');
    await expect(translations).toHaveCount(1, { timeout: 30000 });
    await expect(translations.nth(0)).toContainText(LAST);
    expect(sentCount(sentTexts, LAST)).toBe(1);
    await page.keyboard.press('Shift');
    await expect(translations).toHaveCount(0);

    await moveOnto(page, '#post', LEAD_BEFORE);
    await page.keyboard.press('Shift');
    await expect(translations).toHaveCount(1, { timeout: 30000 });
    await expect(translations.nth(0)).toContainText(LEAD_AFTER);
    await expect(translations.nth(0)).not.toContainText(MIDDLE);
    expect(sentCount(sentTexts, LEAD_AFTER)).toBe(1);
    expect(sentCount(sentTexts, MIDDLE)).toBe(0);

    // Pressed again over the same paragraph: its translation goes away. A hand on the
    // mouse drifts a pixel or two while the key is down. A translated paragraph is
    // already wrapped in its anchor, so that drift lands on the anchor, not on the
    // <pre>'s own text: the pointermove relay must stay quiet there, or it would
    // count as sweeping and cancel the press.
    const rest = await pointOnText(page, '#post', LEAD_BEFORE);
    await page.mouse.move(rest.x, rest.y);
    await page.keyboard.down('Shift');
    await page.mouse.move(rest.x + 2, rest.y + 1);
    await page.mouse.move(rest.x + 3, rest.y);
    await page.keyboard.up('Shift');
    await expect(translations).toHaveCount(0);

    // Resting on code, the hotkey does nothing.
    await moveOnto(page, '#unwrapped', UNWRAPPED);
    await page.keyboard.press('Shift');
    await moveOnto(page, '#editor-line', EDITOR_LINE);
    await page.keyboard.press('Shift');
    await moveOnto(page, '#highlighted', HIGHLIGHTED);
    await page.keyboard.press('Shift');
    await moveOnto(page, '#editable', EDITABLE);
    await page.keyboard.press('Shift');
    await page.waitForTimeout(500);
    await expectCodeLeftAlone(page, sentTexts);
  } finally {
    await close();
  }
});

test('prose <pre>: hover wraps only paragraphs page translation would take, right-click wraps none', async ({ page, context }) => {
  const { close, endpoint, sentTexts } = await startMockOpenAIServer();

  try {
    await openPage(page, context, endpoint);
    const anchors = page.locator('#post > .ai-translator-text-run');

    // Right-click on a paragraph nobody translated yet: nothing to act on, nothing wrapped.
    const onLast = await pointOnText(page, '#post', LAST);
    await page.mouse.click(onLast.x, onLast.y, { button: 'right' });
    await page.keyboard.press('Escape');
    await expect(anchors).toHaveCount(0);

    // Hover over the paragraph that is only a link: not translated, not wrapped.
    await page.keyboard.down('Shift');
    await moveOnto(page, '#post', LINK_ONLY);
    await page.waitForTimeout(500);
    await page.keyboard.up('Shift');
    await expect(page.locator('.ai-translator-hover-translation')).toHaveCount(0);
    await expect(anchors).toHaveCount(0);

    // Page translation afterwards still leaves the link alone.
    await triggerPageTranslation(page);
    await waitForPageRoundEnd(page, 30000);
    await expect(anchors).toHaveCount(3);
    expect(sentCount(sentTexts, MIDDLE)).toBe(1);
    expect(sentCount(sentTexts, LINK_ONLY)).toBe(0);
  } finally {
    await close();
  }
});

test('prose <pre>: hovering over text the user is selecting leaves the selection as it is', async ({ page, context }) => {
  const { close, endpoint, sentTexts } = await startMockOpenAIServer();

  try {
    await openPage(page, context, endpoint);
    const anchors = page.locator('#post > .ai-translator-text-run');
    const selected = () => page.evaluate(() => document.getSelection().toString());

    // A selection made by dragging over two paragraphs, the hotkey pressed halfway.
    const from = await pointOnText(page, '#post', MIDDLE, { firstGlyph: true });
    const to = await pointOnText(page, '#post', LAST);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.keyboard.down('Shift');
    await page.mouse.move(to.x, to.y, { steps: 8 });
    await page.mouse.up();
    const dragged = await selected();
    expect(dragged).toContain('Passengers who miss');
    expect(dragged).toContain('Nothin');

    // Still holding the hotkey, the pointer wanders over the selection.
    await moveOnto(page, '#post', MIDDLE);
    await moveOnto(page, '#post', LAST);
    await page.waitForTimeout(500);
    await page.keyboard.up('Shift');

    expect(await selected()).toBe(dragged);
    await expect(anchors).toHaveCount(0);
    expect(sentCount(sentTexts, MIDDLE)).toBe(0);
    expect(sentCount(sentTexts, LAST)).toBe(0);
  } finally {
    await close();
  }
});
