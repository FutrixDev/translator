// A whole article inside one <pre>.
//
// Old-style blogs and mailing-list archives put the article body in a single
// <pre> and let CSS wrap it (white-space: pre-wrap), with a blank line between
// paragraphs. antirez.com is built this way site-wide, and its markup is the
// skeleton below: the post is `topcomment > article.comment > pre`, after a
// `span.info` byline, on a page whose <html> has no lang.
//
// <pre> used to be skipped outright as code. On such a page the requests carried
// only the title, the byline and the footer, and the body was never sent. Both
// ways in collect through the same function, so both are walked: opening a site
// set to "always", and the float ball's "Translate page".
//
// The other half matters just as much: a <pre> that is code stays untouched.
// One is a wrapping <pre> that holds <code>; the other is a plain-text <pre>
// that does not wrap (its translation would be one line running off the page).
// A third is a read-only editor's line: CodeMirror 5 with line wrapping draws
// every line as a wrapping <pre>, and that text belongs to the editor.
const { test, expect } = require('./fixtures');
const { setExtensionSettings, triggerPageTranslation, writeSyncSettings } = require('./helpers');
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
// A paragraph that is only a link: the collector's own URL rule still applies.
const LINK_ONLY = 'https://harbour.test/notes/ferry-schedule-2026';

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Is the ferry safe? - &lt;harbour&gt;</title>
<style>
  topcomment { display: block; }
  .comment pre { white-space: pre-wrap; word-wrap: break-word; font-family: Courier, monospace; }
</style></head>
<body><div id="container">
<header><h1><a href="/">&lt;harbour&gt;</a></h1></header>
<div id="content">
<section id="newslist"><article data-news-id="7"><h2><a href="/news/7">Is the ferry safe?</a></h2></article></section>
<topcomment><article class="comment" id="post-box"><span class="info"><span class="username"><a href="/user/keeper">keeper</a></span> 12 days ago. 4031 views.  </span><pre id="post">${LEAD_BEFORE} (<a href="/notes/ferry">the note</a>), ${LEAD_AFTER}

${MIDDLE}

${LINK_ONLY}

${LAST}</pre></article></topcomment>
<article class="comment"><pre id="wrapped-code"><code>${WRAPPED_CODE}</code></pre></article>
<pre id="unwrapped">${UNWRAPPED}</pre>
<div class="CodeMirror"><div class="CodeMirror-code" role="presentation"><pre id="editor-line" class="CodeMirror-line" style="white-space: pre-wrap">${EDITOR_LINE}</pre></div></div>
</div></div></body></html>`;

async function serve(context) {
  await context.route(`${ORIGIN}/**`, (route) => {
    route.fulfill({ status: 200, contentType: 'text/html', body: PAGE });
  });
}

function settings(endpoint, extra) {
  return {
    apiEndpoint: endpoint,
    apiKey: 'test-key',
    modelName: 'gpt-4.1-mini',
    targetLang: 'zh-CN',
    skipTargetLanguageText: false,
    ...extra,
  };
}

const sentCount = (sentTexts, text) => sentTexts.filter((sent) => sent.includes(text)).length;

/**
 * Each paragraph got its own translation, right below it and still inside the
 * <pre>, and the link in the first one survived the round trip.
 * @param {import('@playwright/test').Page} page
 */
async function expectParagraphTranslations(page) {
  const translations = page.locator('#post > .ai-translator-inline-block');
  // Three anchors, not four: the link-only paragraph is left as it was.
  await expect(page.locator('#post > .ai-translator-text-run')).toHaveCount(3);
  await expect(translations).toHaveCount(3);
  await expect(translations.nth(0)).toContainText(LEAD_AFTER);
  await expect(translations.nth(0).locator('a[href="/notes/ferry"]')).toHaveCount(1);
  await expect(translations.nth(1)).toContainText(MIDDLE);
  await expect(translations.nth(1)).not.toContainText(LAST);
  await expect(translations.nth(2)).toContainText(LAST);
  // The source paragraphs keep their text.
  await expect(page.locator('#post')).toContainText(MIDDLE);
}

async function expectCodeLeftAlone(page, sentTexts) {
  const all = sentTexts.join('\n');
  expect(all).not.toContain(WRAPPED_CODE);
  expect(all).not.toContain(UNWRAPPED);
  expect(all).not.toContain(LINK_ONLY);
  expect(all).not.toContain(EDITOR_LINE);
  await expect(page.locator('#editor-line .ai-translator-text-run')).toHaveCount(0);
  await expect(page.locator('#wrapped-code .ai-translator-inline-block')).toHaveCount(0);
  await expect(page.locator('#unwrapped .ai-translator-inline-block')).toHaveCount(0);
  await expect(page.locator('#unwrapped + .ai-translator-inline-block')).toHaveCount(0);
}

test('prose <pre>: a site set to "always" translates the article body, paragraph by paragraph', async ({ page, context }) => {
  const { close, endpoint, sentTexts } = await startMockOpenAIServer();

  try {
    await setExtensionSettings(page, settings(endpoint, {
      siteRules: { 'prose-pre.test': 'always' },
    }));
    await serve(context);

    await page.goto(`${ORIGIN}/news/7`);
    await page.waitForSelector('#ai-translator-float-ball');

    await expect.poll(() => sentCount(sentTexts, LAST), { timeout: 30000 }).toBe(1);
    expect(sentCount(sentTexts, LEAD_AFTER)).toBe(1);
    expect(sentCount(sentTexts, MIDDLE)).toBe(1);
    await expectParagraphTranslations(page);

    // The page moves (a late comment). Collecting again walks the same <pre>,
    // which now holds our paragraph anchors and translations. It must send
    // nothing twice and insert nothing twice.
    await page.evaluate(() => {
      const note = document.createElement('p');
      note.id = 'late-note';
      note.textContent = 'The harbour office posts a notice whenever the schedule changes.';
      document.getElementById('content').appendChild(note);
    });
    await page.waitForSelector('#late-note + .ai-translator-inline-block', { timeout: 30000 });
    expect(sentCount(sentTexts, LEAD_AFTER)).toBe(1);
    expect(sentCount(sentTexts, MIDDLE)).toBe(1);
    expect(sentCount(sentTexts, LAST)).toBe(1);
    await expectParagraphTranslations(page);

    // The target language changes. A translated paragraph is still one block:
    // it is released and sent again, and its new translation replaces the old.
    await writeSyncSettings(context, { targetLang: 'ja' });
    await expect.poll(() => sentCount(sentTexts, LAST), { timeout: 30000 }).toBe(2);
    await expect.poll(() => sentCount(sentTexts, LEAD_AFTER), { timeout: 30000 }).toBe(2);
    await expect.poll(() => sentCount(sentTexts, MIDDLE), { timeout: 30000 }).toBe(2);
    await expectParagraphTranslations(page);

    await expectCodeLeftAlone(page, sentTexts);
  } finally {
    await close();
  }
});

test('prose <pre>: the float ball\'s "Translate page" translates the article body too', async ({ page, context }) => {
  const { close, endpoint, sentTexts } = await startMockOpenAIServer();

  try {
    await setExtensionSettings(page, settings(endpoint));
    await serve(context);

    await page.goto(`${ORIGIN}/news/7`);
    await page.waitForSelector('#ai-translator-float-ball');
    await triggerPageTranslation(page);
    await waitForPageRoundEnd(page, 30000);

    expect(sentCount(sentTexts, LEAD_AFTER)).toBe(1);
    expect(sentCount(sentTexts, MIDDLE)).toBe(1);
    expect(sentCount(sentTexts, LAST)).toBe(1);
    await expectParagraphTranslations(page);
    await expectCodeLeftAlone(page, sentTexts);
  } finally {
    await close();
  }
});

test('prose <pre> in translation-only mode: each paragraph is hidden, its translation shows', async ({ page, context }) => {
  const { close, endpoint } = await startMockOpenAIServer();

  try {
    await setExtensionSettings(page, settings(endpoint, { showTranslationOnly: true }));
    await serve(context);

    await page.goto(`${ORIGIN}/news/7`);
    await page.waitForSelector('#ai-translator-float-ball');
    await triggerPageTranslation(page);
    await waitForPageRoundEnd(page, 30000);

    await expectParagraphTranslations(page);
    // The anchor is an inline span, and the rule that keeps anchors inline must
    // not win over the one that hides a source. Computed display, not the class.
    const shown = await page.evaluate(() => ({
      anchors: Array.from(document.querySelectorAll('#post > .ai-translator-text-run'), (el) => getComputedStyle(el).display),
      translations: Array.from(document.querySelectorAll('#post > .ai-translator-inline-block'), (el) => getComputedStyle(el).display),
    }));
    expect(shown.anchors).toEqual(['none', 'none', 'none']);
    expect(shown.translations).toEqual(['block', 'block', 'block']);
  } finally {
    await close();
  }
});
