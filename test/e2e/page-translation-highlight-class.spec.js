const { test, expect } = require('./fixtures');
const { setExtensionSettings, triggerPageTranslation } = require('./helpers');
const { startMockOpenAIServer } = require('./mock-openai-server');

// Regression test for the "code container" skip rule in collectTranslatableBlocks
// (content/content-page-translation.js).
//
// The rule used to match ancestors by class SUBSTRING, which misfired twice:
//
//   [class*="highlight"] — marketing sites commonly name ordinary content sections
//   "highlights"/"highlighted"; retellai.com wraps every blog article in
//   <section class="c-home-highlights-accordion-2">, so the whole article was
//   classified as syntax-highlighted code and silently skipped (only nav/footer
//   links got translated).
//
//   [class*="language-"] — Wikipedia's Vector 2022 skin puts
//   vector-feature-language-in-header-enabled on <html>, so the substring matched
//   the ROOT element. processElement(document.body) then returned on its first
//   line, the page yielded zero blocks, and full-page translation reported
//   "page already translated" on every Wikipedia article.
//
// Both must match complete class tokens instead, and language-* additionally
// requires the ancestor to actually hold code (a <pre>/<code>) so that
// language-switcher / language-list navigation is never mistaken for a code block.
// This spec pins all of that down from both directions.
//
// The skipped-container probes deliberately contain plain prose, NOT code-looking
// text: code-looking text would also be dropped by the looksLikeCode() heuristics,
// and the test would then pass even if the class rule were deleted outright.
test('page translation: "highlights"/"language-" lookalikes translate, real code containers stay skipped', async ({ page }) => {
  const { server, endpoint, fastBatchRequests } = await startMockOpenAIServer();

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

    await page.evaluate(() => {
      // Wikipedia's real <html> class. Nothing below it is a code block, so the whole
      // fixture is unreachable if the language- rule matches by substring on the root.
      document.documentElement.classList.add('vector-feature-language-in-header-enabled');

      const container = document.createElement('div');
      container.id = 'highlight-class-test';
      container.innerHTML = `
        <section id="highlights-section" class="c-section c-home-highlights-accordion-2">
          <div class="blog_content_wrap">
            <p id="highlights-para">Benchmarking voice models on real customer conversations takes careful work.</p>
          </div>
        </section>
        <div id="lang-switcher" class="language-switcher">
          <p id="lang-switcher-para">Read this encyclopedia article in another language.</p>
        </div>
        <div id="pygments-container" class="highlight">
          <p id="pygments-para">Plain sentence standing in for pygments highlighted source.</p>
        </div>
        <div id="rouge-container" class="highlighter-rouge">
          <p id="rouge-para">Another plain sentence inside a rouge highlighter wrapper.</p>
        </div>
        <div id="github-container" class="highlight-source-js">
          <p id="github-para">Plain sentence standing in for github highlighted source.</p>
        </div>
        <div id="prism-container" class="language-js">
          <p id="prism-para">Plain sentence standing beside the prism highlighted source.</p>
          <pre><code>x</code></pre>
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

    // Prose inside the "highlights" section and inside the language switcher must be
    // translated — neither is a code block, whatever their class names look like.
    for (const id of ['highlights-para', 'lang-switcher-para']) {
      await page.waitForFunction(
        (paraId) => {
          const el = document.getElementById(paraId);
          return el && el.classList.contains('ai-translator-translated');
        },
        id,
        { timeout: 30000 }
      );
    }
    await expect(page.locator('#highlights-section .ai-translator-inline-block')).toHaveCount(1);
    await expect(page.locator('#highlights-section .ai-translator-inline-block')).toContainText('[T]');
    await expect(page.locator('#lang-switcher .ai-translator-inline-block')).toHaveCount(1);

    // Wait until the whole run settles (progress bar auto-removes on completion) so the
    // negative assertions below mean "never translated", not "not translated yet".
    await page.waitForSelector('#ai-translator-progress', { state: 'hidden', timeout: 30000 });

    for (const id of ['pygments-para', 'rouge-para', 'github-para', 'prism-para']) {
      await expect(page.locator(`#${id}`)).not.toHaveClass(/ai-translator-translated/);
    }
    await expect(page.locator('#pygments-container .ai-translator-inline-block')).toHaveCount(0);
    await expect(page.locator('#rouge-container .ai-translator-inline-block')).toHaveCount(0);
    await expect(page.locator('#github-container .ai-translator-inline-block')).toHaveCount(0);
    await expect(page.locator('#prism-container .ai-translator-inline-block')).toHaveCount(0);
  } finally {
    server.close();
  }
});
