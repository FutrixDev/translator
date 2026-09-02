const { test, expect } = require('@playwright/test');
const path = require('path');

// Focused DOM unit test of the REAL collectTranslatableBlocks + insertTranslationBlock,
// loaded straight from source into a plain headless page (no extension or network needed),
// against the verbatim markup + CSS of https://alignment.anthropic.com/2026/psm/ that was
// reported in github.com/FutrixDev/translator#71. Three separate defects:
//   1. a block's DIRECT TEXT NODES were dropped whenever the element also had element
//      children (recursion walked `element.children` only) → whole sentences untranslated;
//   2. a translation of an element that paints its own box (background/gradient) was
//      inserted as a SIBLING, so it rendered as naked text under the box;
//   3. a <li>'s translation was a sibling <li> that lost the page's inline indent and had
//      its marker stripped by CSS → the translation sat flush left with no bullet.
// Plus the page's `.code-box p { margin: -12px 0 }`: a negative source margin-bottom
// collapses against the sibling translation's margin-top and stacks the two lines.
const ROOT = path.join(__dirname, '..', '..');
const SCRIPTS = [
  path.join(ROOT, 'i18n/messages.js'),
  path.join(ROOT, 'content/content-bootstrap.js'),
  path.join(ROOT, 'content/content-clip-guard.js'),
  path.join(ROOT, 'content/content-fit-guard.js'),
  path.join(ROOT, 'content/content-page-translation.js'),
];

// Page CSS below is copied verbatim from the article; __CONTENT_CSS__ is our own
// content/content.css, so the theme rules that stripped the bullet are in play too.
const FIXTURE_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
body { font-family: sans-serif; max-width: 800px; margin: 0 auto; }
.code-box { background-color:#f0f0f0; padding:16px; border-radius:8px; font-family:monospace; font-size:0.8em; white-space:pre-wrap; line-height:2; }
.code-box br { display:none; }
.code-box p { margin:-12px 0; }
.rhythm-p { margin:16px 0 32px; }
</style>
<style>__CONTENT_CSS__</style>
</head><body>
<div class="code-box" id="box-linda">Linda wanted her ex-colleague David to recommend her for a VP role at Nexus Corp. When Linda asked for the reference, David <span style='font-weight: 700;'>faced a dilemma: help a friend or protect his own ambitions.</span></div>

<div class="code-box" id="box-dialogue"><span style='font-weight: 700;'>Human:</span> Write a one-stanza poem describing how pre-trained LLMs can be converted into helpful AI assistants.
<br>
<p id="dialogue-p"><span style='font-weight: 700;'>Assistant:</span> A mind awakened on the web's vast sprawl,</p>
</div>

<ul id="psm-list"><li style='margin-left: 36pt;' id="li-1"><span style='font-weight: 700;'>Pre-training teaches an LLM a distribution over personas.</span> Implicit in this distribution are various hypotheses about the Assistant persona.</li><li style='margin-left: 36pt;' id="li-2"><span style='font-weight: 700;'>This results in a posterior distribution over Assistant personas.</span> Because this is still a distribution, stochasticity still matters.</li></ul>

<p id="plain-p">An ordinary paragraph that paints no box of its own and must keep the sibling layout.</p>

<div id="rhythm"><p class="rhythm-p" id="rhythm-1">A paragraph whose page gives it a generous bottom margin, the way claude.com does.</p><p class="rhythm-p" id="rhythm-2">The next paragraph, which the translation above must not appear to belong to.</p></div>
</body></html>`;

test('page translation placement: box-painting elements, list items, and stray text runs', async ({ page }) => {
  const fs = require('fs');
  const css = fs.readFileSync(path.join(ROOT, 'content/content.css'), 'utf8');
  await page.setContent(FIXTURE_HTML.replace('__CONTENT_CSS__', css), { waitUntil: 'load' });
  for (const s of SCRIPTS) await page.addScriptTag({ path: s });

  const result = await page.evaluate(() => {
    const ctx = window.AI_TRANSLATOR_CONTENT;
    const blocks = ctx.collectTranslatableBlocks(document.body);
    const texts = blocks.map((b) => b.text);
    const runBlocks = blocks
      .filter((b) => b.element.classList.contains(ctx.TEXT_RUN_CLASS))
      .map((b) => b.text);

    blocks.forEach((b) => ctx.insertTranslationBlock(b, '[T] ' + b.text.replace(/<\/?[a-z]+\d+>/gi, '')));

    const rect = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { left: Math.round(r.left), top: Math.round(r.top), bottom: Math.round(r.bottom) };
    };
    const textLeft = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const range = document.createRange();
      range.selectNodeContents(el);
      return Math.round(range.getBoundingClientRect().left);
    };

    return {
      texts,
      runBlocks,
      // 1) stray direct text of the dialogue box
      dialogueRunTranslated: !!document.querySelector('#box-dialogue .ai-translator-inline-block'),
      // 2) the box-painting div
      lindaInside: !!document.querySelector('#box-linda > .ai-translator-inline-block'),
      lindaSibling: !!document.querySelector('#box-linda + .ai-translator-inline-block'),
      lindaBox: rect('#box-linda'),
      lindaTranslation: rect('#box-linda > .ai-translator-inline-block'),
      // 3) list items
      liInside: !!document.querySelector('#li-1 > .ai-translator-inline-block'),
      liSiblings: document.querySelectorAll('#psm-list > li').length,
      phantomListItems: document.querySelectorAll('li.ai-translator-inline-block').length,
      liTextLeft: textLeft('#li-1'),
      liTranslationLeft: rect('#li-1 > .ai-translator-inline-block'),
      liMarker: window.getComputedStyle(document.querySelector('#li-1'), '::marker').content,
      // negative page margins must not stack the sibling translation on the source
      dialogueP: rect('#dialogue-p'),
      dialoguePTranslation: rect('#box-dialogue > p.ai-translator-inline-block'),
      // ordinary paragraphs keep the sibling layout
      plainInside: !!document.querySelector('#plain-p > .ai-translator-inline-block'),
      plainSibling: !!document.querySelector('#plain-p + .ai-translator-inline-block'),
      // a positive page margin must not push the translation away from its own source
      rhythm1: rect('#rhythm-1'),
      rhythm2: rect('#rhythm-2'),
      rhythm1Translation: rect('#rhythm-1 + .ai-translator-inline-block'),
      // ...and with the source hidden, the compensation must stand down
      rhythmOnly: (() => {
        const a = document.querySelector('#rhythm-1 + .ai-translator-inline-block');
        const b = document.querySelector('#rhythm-2 + .ai-translator-inline-block');
        if (!a || !b) return null;
        // 只藏原文：译文是复制原文标签名建出来的，也是 #rhythm 下的 <p>
        const sources = [document.getElementById('rhythm-1'), document.getElementById('rhythm-2')];
        sources.forEach((el) => el.classList.add('ai-translator-source-hidden'));
        const gap = Math.round(b.getBoundingClientRect().top - a.getBoundingClientRect().bottom);
        sources.forEach((el) => el.classList.remove('ai-translator-source-hidden'));
        return gap;
      })(),
    };
  });

  // 1) The dialogue box's direct text node is collected on its own and translated.
  expect(result.runBlocks.join(' ')).toContain('one-stanza poem');
  expect(result.texts.some((t) => t.includes('one-stanza poem'))).toBe(true);
  expect(result.dialogueRunTranslated).toBe(true);

  // 2) An element that paints its own box gets the translation INSIDE it, within the padding.
  expect(result.lindaInside).toBe(true);
  expect(result.lindaSibling).toBe(false);
  expect(result.lindaTranslation.left).toBeGreaterThan(result.lindaBox.left);

  // 3) A list item's translation goes inside the item: no phantom bullet, indent preserved.
  expect(result.liInside).toBe(true);
  expect(result.phantomListItems).toBe(0);
  expect(result.liSiblings).toBe(2);
  expect(result.liTranslationLeft.left).toBeGreaterThanOrEqual(result.liTextLeft);
  expect(result.liMarker).not.toBe('none');

  // A negative margin-bottom on the source must not pull the translation onto it.
  expect(result.dialoguePTranslation).not.toBeNull();
  expect(result.dialoguePTranslation.top).toBeGreaterThanOrEqual(result.dialogueP.bottom);

  // Ordinary blocks are untouched by the placement rule.
  expect(result.plainInside).toBe(false);
  expect(result.plainSibling).toBe(true);

  // A positive margin-bottom on the source is the mirror image of the negative one:
  // margin collapsing hands the gap above the translation to the page (32px) while the
  // gap below stays the next paragraph's (16px), so the translation reads as belonging
  // to the paragraph after it. The pair must sit tighter than the paragraphs around it,
  // and must still occupy the source's original slot in the page's rhythm.
  expect(result.rhythm1Translation).not.toBeNull();
  const gapAbove = result.rhythm1Translation.top - result.rhythm1.bottom;
  const gapBelow = result.rhythm2.top - result.rhythm1Translation.bottom;
  expect(gapAbove).toBeLessThan(gapBelow);
  expect(gapAbove).toBeLessThan(8);
  expect(gapBelow).toBe(32);

  // In translation-only mode the source stops occupying that gap, so the compensation
  // has nothing left to cancel and would eat the page's paragraph rhythm instead.
  // Translations must keep standing 32px apart, not collapse onto one another.
  expect(result.rhythmOnly).toBe(32);
});
