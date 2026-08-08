const { test, expect } = require('./fixtures');
const { setExtensionSettings, triggerPageTranslation } = require('./helpers');
const { startMockOpenAIServer } = require('./mock-openai-server');

// Regression test for the "code highlight container" skip rule in
// collectTranslatableBlocks (content/content-page-translation.js).
//
// The rule used to match ancestors with `[class*="highlight"]`. Marketing sites
// commonly name ordinary content sections with "highlights"/"highlighted" — e.g.
// retellai.com wraps every blog article in <section class="c-home-highlights-accordion-2">
// — so the substring match classified the whole article as a syntax-highlighted code
// block and page translation silently skipped all of it (only nav/footer links were
// translated). The rule must instead match complete class tokens (highlight,
// highlighter-rouge, highlight-source-js, ...), which this spec pins down from both
// directions: prose inside a "highlights" section is translated, prose inside real
// highlighter containers is still skipped.
//
// The skipped-container probes deliberately contain plain prose, NOT code-looking
// text: code-looking text would also be dropped by the looksLikeCode() heuristics,
// and the test would then pass even if the class rule were deleted outright.
test('page translation: "highlights" sections translate, real highlighter containers stay skipped', async ({ page }) => {
  const { server, endpoint, fastBatchRequests } = await startMockOpenAIServer();

  try {
    await setExtensionSettings(page, {
      // This spec asserts the mock received a fast-batch request, so it has to
      // pin the AI backend — see setExtensionSettings in ./helpers.
      translationEngine: 'ai',
      apiEndpoint: endpoint,
      apiKey: 'test-key',
      modelName: 'gpt-4.1-mini',
      targetLang: 'zh-CN',
      autoDetect: false
    });

    await page.goto('https://example.com');
    await page.waitForSelector('#ai-translator-float-ball');

    await page.evaluate(() => {
      const container = document.createElement('div');
      container.id = 'highlight-class-test';
      container.innerHTML = `
        <section id="highlights-section" class="c-section c-home-highlights-accordion-2">
          <div class="blog_content_wrap">
            <p id="highlights-para">Benchmarking voice models on real customer conversations takes careful work.</p>
          </div>
        </section>
        <div id="pygments-container" class="highlight">
          <p id="pygments-para">Plain sentence standing in for pygments highlighted source.</p>
        </div>
        <div id="rouge-container" class="highlighter-rouge">
          <p id="rouge-para">Another plain sentence inside a rouge highlighter wrapper.</p>
        </div>
        <div id="github-container" class="highlight-source-js">
          <p id="github-para">Plain sentence standing in for github highlighted source.</p>
        </div>
      `;
      document.body.appendChild(container);
    });

    await triggerPageTranslation(page);

    // Fail fast if the prompt wording drifted and the mock could no longer recover the
    // delimiter; the symptom would otherwise be an unexplained timeout on the wait below.
    await expect
      .poll(() => fastBatchRequests.length, {
        timeout: 15000,
        message: 'mock never recognized a fast-batch request (delimiter not found in system prompt)'
      })
      .toBeGreaterThan(0);

    // The article paragraph inside the "highlights" section must be translated.
    await page.waitForFunction(() => {
      const el = document.getElementById('highlights-para');
      return el && el.classList.contains('ai-translator-translated');
    });
    await expect(page.locator('#highlights-section .ai-translator-inline-block')).toHaveCount(1);
    await expect(page.locator('#highlights-section .ai-translator-inline-block')).toContainText('[T]');

    // Wait until the whole run settles (progress bar auto-removes on completion) so the
    // negative assertions below mean "never translated", not "not translated yet".
    await page.waitForSelector('#ai-translator-progress', { state: 'hidden', timeout: 30000 });

    for (const id of ['pygments-para', 'rouge-para', 'github-para']) {
      await expect(page.locator(`#${id}`)).not.toHaveClass(/ai-translator-translated/);
    }
    await expect(page.locator('#pygments-container .ai-translator-inline-block')).toHaveCount(0);
    await expect(page.locator('#rouge-container .ai-translator-inline-block')).toHaveCount(0);
    await expect(page.locator('#github-container .ai-translator-inline-block')).toHaveCount(0);
  } finally {
    server.close();
  }
});
