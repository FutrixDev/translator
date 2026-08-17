const { test, expect } = require('./fixtures');
const { setExtensionSettings, triggerPageTranslation } = require('./helpers');
const { startMockOpenAIServer } = require('./mock-openai-server');

// Regression test for LaTeXML code listings (arXiv HTML papers, ar5iv) in
// collectTranslatableBlocks (content/content-page-translation.js).
//
// The code-container skip rule never reached these, for two independent reasons:
//
//   1. LaTeXML writes the language as ltx_lst_language_Python — an UNDERSCORE — so
//      neither the old [class*="language-"] substring rule nor the token rule that
//      replaced it can see it.
//   2. There is no <pre> or <code> anywhere in the listing, so the skipTags guard
//      does not fire either. The structure is
//        <div class="ltx_listing"><div class="ltx_listingline"><span class="ltx_text …">
//      and every one of those spans is an inline translatable element, so the source
//      was shipped to the API one token at a time: "qa", "dspy", "Predict",
//      '"question->answer"', "# Out: Prediction(...)".
//
// looksLikeCode() cannot be the backstop here: once the line is split across spans the
// fragments carry no special characters at all ("qa", "dspy") and read as ordinary words.
// So the listing container classes have to be recognized explicitly.
//
// The markup below is copied from a real paper (arxiv.org/html/2310.03714v1, DSPy),
// only with the base64 <div class="ltx_listing_data"> download blob stripped.
const ARXIV_LISTING = `
<div id="S3.SS1.p4.1" class="ltx_listing ltx_lst_language_Python ltx_lst_numbers_left ltx_lstlisting ltx_listing">
  <div id="lstnumberx1" class="ltx_listingline">
    <span class="ltx_tag ltx_tag_listingline">1</span>
    <span class="ltx_text ltx_lst_identifier ltx_font_typewriter">qa</span><span class="ltx_text ltx_lst_space ltx_font_typewriter"> </span><span class="ltx_text ltx_font_typewriter">=</span><span class="ltx_text ltx_lst_space ltx_font_typewriter"> </span><span class="ltx_text ltx_lst_emph ltx_font_typewriter">dspy</span><span class="ltx_text ltx_font_typewriter">.</span><span class="ltx_text ltx_lst_identifier ltx_font_typewriter">Predict</span><span class="ltx_text ltx_font_typewriter">(</span><span class="ltx_text ltx_lst_string ltx_font_typewriter">"question<span class="ltx_text ltx_lst_space"> </span>-&gt;<span class="ltx_text ltx_lst_space"> </span>answer"</span><span class="ltx_text ltx_font_typewriter">)</span>
  </div>
  <div id="lstnumberx3" class="ltx_listingline">
    <span class="ltx_tag ltx_tag_listingline">3</span>
    <span class="ltx_text ltx_lst_comment ltx_font_typewriter"># Out: Prediction(answer='Guarani is spoken mainly in South America.')</span>
  </div>
</div>
`;

test('page translation: arXiv/LaTeXML code listings never reach the API, paper prose still does', async ({ page }) => {
  const { close, endpoint, fastBatchRequests, sentTexts } = await startMockOpenAIServer();

  try {
    await setExtensionSettings(page, {
      apiEndpoint: endpoint,
      apiKey: 'test-key',
      modelName: 'gpt-4.1-mini',
      targetLang: 'zh-CN',
      autoDetect: false
    });

    await page.goto('https://example.com');
    await page.waitForSelector('#ai-translator-float-ball');

    await page.evaluate((listing) => {
      const container = document.createElement('div');
      container.id = 'paper-listing-test';
      container.innerHTML = `
        <article class="ltx_document">
          <section class="ltx_section">
            <p id="paper-prose" class="ltx_p">We introduce a programming model that abstracts language model pipelines.</p>
            ${listing}
            <figcaption id="paper-caption" class="ltx_caption">Figure 1: A minimal question answering program.</figcaption>
          </section>
        </article>
      `;
      document.body.appendChild(container);
    }, ARXIV_LISTING);

    await triggerPageTranslation(page);

    // Fail fast if the prompt wording drifted and the mock could no longer recover the
    // delimiter; the symptom would otherwise be an unexplained timeout on the wait below.
    await expect
      .poll(() => fastBatchRequests.length, {
        timeout: 15000,
        message: 'mock never recognized a fast-batch request (delimiter not found in system prompt)'
      })
      .toBeGreaterThan(0);

    // The paper's own prose and its figure caption must still be translated — the listing
    // rule must not swallow the surrounding article.
    for (const id of ['paper-prose', 'paper-caption']) {
      await page.waitForFunction(
        (proseId) => {
          const el = document.getElementById(proseId);
          return el && el.classList.contains('ai-translator-translated');
        },
        id,
        { timeout: 30000 }
      );
    }

    // Let the run settle so the assertions below mean "never sent", not "not sent yet".
    await page.waitForSelector('#ai-translator-progress', { state: 'hidden', timeout: 30000 });

    // Assert on what actually left the browser. Checking the DOM instead would also pass
    // if the source had been shipped and the reply merely failed to render.
    const outbound = sentTexts.join('\n');
    expect(outbound).toContain('programming model that abstracts');
    for (const fragment of ['dspy', 'Predict', 'question->answer', "Prediction(answer='"]) {
      expect(outbound, `listing source "${fragment}" was sent to the translation API`).not.toContain(fragment);
    }

    // And nothing inside the listing may be rendered as a translation.
    await expect(page.locator('#S3\\.SS1\\.p4\\.1 .ai-translator-inline-block')).toHaveCount(0);
    await expect(page.locator('#S3\\.SS1\\.p4\\.1 .ai-translator-translated')).toHaveCount(0);
  } finally {
    await close();
  }
});
