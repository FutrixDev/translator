const { test, expect } = require('./fixtures');
const { setExtensionSettings, triggerPageTranslation } = require('./helpers');
const { startMockOpenAIServer } = require('./mock-openai-server');

test('page translation skips blocks with inline translation', async ({ page }) => {
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
      autoDetect: false,
      enableHoverTranslation: true,
      hoverTranslationHotkey: 'Shift'
    });

    await page.goto('https://example.com');
    await page.waitForSelector('#ai-translator-float-ball');

    await page.evaluate(() => {
      const container = document.createElement('div');
      container.id = 'inline-translation-test';
      container.innerHTML = `
        <p id="inline-para-one">Inline translation paragraph one.</p>
        <p id="inline-para-two">Inline translation paragraph two.</p>
      `;
      document.body.appendChild(container);
    });

    const paragraphOne = page.locator('#inline-para-one');
    const paragraphTwo = page.locator('#inline-para-two');

    await page.keyboard.down('Shift');
    await paragraphOne.hover();
    await page.waitForSelector('#inline-para-one + .ai-translator-hover-translation', { state: 'attached' });
    await page.keyboard.up('Shift');

    await triggerPageTranslation(page);

    // Fail fast if the prompt wording drifted and the delimiter could no longer be
    // recovered; the symptom would otherwise be an unexplained timeout on the wait below.
    await expect
      .poll(() => fastBatchRequests.length, {
        timeout: 15000,
        message: 'mock never recognized a fast-batch request (delimiter not found in system prompt)'
      })
      .toBeGreaterThan(0);

    await page.waitForFunction(() => {
      const el = document.getElementById('inline-para-two');
      return el && el.classList.contains('ai-translator-translated');
    });

    await expect(paragraphOne).not.toHaveClass(/ai-translator-translated/);
    await expect(page.locator('#inline-translation-test .ai-translator-inline-block')).toHaveCount(2);
  } finally {
    server.close();
  }
});
