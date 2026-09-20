/**
 * Hover translation E2E tests
 */
const { test, expect } = require('./fixtures');
const { setExtensionSettings, sendMessageToActiveTab, triggerSelectionHotkey } = require('./helpers');

async function addTestParagraphs(page) {
  await page.evaluate(() => {
    const existing = document.getElementById('ai-translator-test-blocks');
    if (existing) return;
    const container = document.createElement('div');
    container.id = 'ai-translator-test-blocks';
    container.innerHTML = `
      <p id="hover-para-one">First test paragraph for hover translation.</p>
      <p id="hover-para-two">Second test paragraph for hover translation.</p>
    `;
    document.body.appendChild(container);
  });
}

test.describe('Hover Translation', () => {
  test('keeps hover translations for multiple paragraphs', async ({ page }) => {
    await page.goto('https://example.com');
    await page.waitForSelector('#ai-translator-float-ball');

    await addTestParagraphs(page);

    const paragraphOne = page.locator('#hover-para-one');
    const paragraphTwo = page.locator('#hover-para-two');

    await page.keyboard.down('Shift');
    await paragraphOne.hover();
    await page.waitForSelector('#hover-para-one + .ai-translator-hover-translation', { state: 'attached' });

    await paragraphTwo.hover();
    await page.waitForFunction(() => {
      return document.querySelectorAll('.ai-translator-hover-translation').length === 2;
    });

    await page.keyboard.up('Shift');
  });

  test('toggles translation on hotkey press and persists after keyup', async ({ page }) => {
    await page.goto('https://example.com');
    await page.waitForSelector('#ai-translator-float-ball');

    const paragraph = page.locator('p').first();
    await paragraph.scrollIntoViewIfNeeded();

    await page.keyboard.down('Shift');
    await paragraph.hover();

    await page.waitForSelector('.ai-translator-hover-translation', { state: 'attached' });

    await page.keyboard.up('Shift');
    await page.waitForTimeout(200);
    await page.waitForSelector('.ai-translator-hover-translation', { state: 'attached' });

    await page.keyboard.down('Shift');
    await page.waitForSelector('.ai-translator-hover-translation', { state: 'detached' });
    await page.keyboard.up('Shift');
  });

  test('supports configurable hover hotkey', async ({ page }) => {
    await page.goto('https://example.com');
    await page.waitForSelector('#ai-translator-float-ball');

    await setExtensionSettings(page, { hoverTranslationHotkey: 'Alt' });

    const paragraph = page.locator('p').first();
    await paragraph.scrollIntoViewIfNeeded();

    await page.keyboard.down('Shift');
    await paragraph.hover();
    await page.waitForTimeout(300);
    await page.keyboard.up('Shift');
    await page.waitForSelector('.ai-translator-hover-translation', { state: 'detached' });

    // 先把光标挪开：上一步它已经停在这一段上了，直接 hover 不会再发一次
    // mouseover，这一下就只剩「按住档」那条路——而 Alt 正是 Alt+A 占着的那个
    // 修饰键，它没有按住档（见 content/content-utils.js 的 commandModifiers）。
    // 悬停翻译本来的手势是「按住键、划过哪段译哪段」，走的就是 mouseover。
    await page.mouse.move(5, 5);
    await page.keyboard.down('Alt');
    await paragraph.hover();
    await page.waitForSelector('.ai-translator-hover-translation', { state: 'attached' });
    await page.keyboard.up('Alt');
  });

  test('hover translation shows inline loading indicator', async ({ page }) => {
    await page.goto('https://example.com');
    await page.waitForSelector('#ai-translator-float-ball');

    const paragraph = page.locator('p').first();
    await paragraph.scrollIntoViewIfNeeded();

    await page.keyboard.down('Shift');
    const loadingPromise = page.waitForSelector('.ai-translator-inline-loading', { state: 'attached', timeout: 3000 });
    await paragraph.hover();

    await loadingPromise;

    const hoverLoaderStyles = await page.evaluate(() => {
      const loader = document.querySelector('.ai-translator-inline-loading');
      if (!loader) return null;
      const loaderStyle = window.getComputedStyle(loader);
      const parentStyle = loader.parentElement ? window.getComputedStyle(loader.parentElement) : loaderStyle;
      return {
        color: loaderStyle.color,
        fontSize: parseFloat(loaderStyle.fontSize),
        parentFontSize: parseFloat(parentStyle.fontSize),
        fontWeight: parseInt(loaderStyle.fontWeight, 10),
      };
    });

    expect(hoverLoaderStyles).not.toBeNull();
    expect(hoverLoaderStyles.color).toBe('rgb(124, 92, 255)');
    expect(hoverLoaderStyles.fontSize).toBeGreaterThan(hoverLoaderStyles.parentFontSize);
    expect(hoverLoaderStyles.fontWeight).toBeGreaterThanOrEqual(600);
    await page.waitForSelector('.ai-translator-hover-translation', { state: 'attached' });
    await page.waitForSelector('.ai-translator-inline-loading', { state: 'detached', timeout: 3000 });

    await page.keyboard.up('Shift');
  });

  test('selection translation persists after selection clears', async ({ page }) => {
    await page.goto('https://example.com');
    await page.waitForSelector('#ai-translator-float-ball');

    const paragraph = page.locator('p').first();
    await paragraph.scrollIntoViewIfNeeded();
    await paragraph.selectText();
    await triggerSelectionHotkey(page);

    await page.waitForSelector('.ai-translator-selection-translation', { state: 'attached' });

    await page.evaluate(() => window.getSelection().removeAllRanges());
    await page.waitForTimeout(200);
    await page.waitForSelector('.ai-translator-selection-translation', { state: 'attached' });
  });

  test('selection hotkey toggles translation on and off', async ({ page }) => {
    await page.goto('https://example.com');
    await page.waitForSelector('#ai-translator-float-ball');

    const paragraph = page.locator('p').first();
    await paragraph.scrollIntoViewIfNeeded();
    await paragraph.selectText();

    await triggerSelectionHotkey(page);
    await page.waitForSelector('.ai-translator-selection-translation', { state: 'attached' });

    await triggerSelectionHotkey(page);
    await page.waitForSelector('.ai-translator-selection-translation', { state: 'detached' });
  });

  test('selection translation shows inline loading indicator', async ({ page }) => {
    await page.goto('https://example.com');
    await page.waitForSelector('#ai-translator-float-ball');

    await setExtensionSettings(page, {
      selectionTranslationMode: 'inline',
    });

    const paragraph = page.locator('p').first();
    await paragraph.scrollIntoViewIfNeeded();
    await paragraph.selectText();
    const loadingPromise = page.waitForSelector('.ai-translator-inline-loading', { state: 'attached', timeout: 3000 });
    await triggerSelectionHotkey(page);

    await loadingPromise;

    const selectionLoaderStyles = await page.evaluate(() => {
      const loader = document.querySelector('.ai-translator-inline-loading');
      if (!loader) return null;
      const loaderStyle = window.getComputedStyle(loader);
      const parentStyle = loader.parentElement ? window.getComputedStyle(loader.parentElement) : loaderStyle;
      return {
        color: loaderStyle.color,
        fontSize: parseFloat(loaderStyle.fontSize),
        parentFontSize: parseFloat(parentStyle.fontSize),
        fontWeight: parseInt(loaderStyle.fontWeight, 10),
      };
    });

    expect(selectionLoaderStyles).not.toBeNull();
    expect(selectionLoaderStyles.color).toBe('rgb(124, 92, 255)');
    expect(selectionLoaderStyles.fontSize).toBeGreaterThan(selectionLoaderStyles.parentFontSize);
    expect(selectionLoaderStyles.fontWeight).toBeGreaterThanOrEqual(600);
    await page.waitForSelector('.ai-translator-selection-translation', { state: 'attached' });
    await page.waitForSelector('.ai-translator-inline-loading', { state: 'detached', timeout: 3000 });
  });

  test('escape clears all inline translations', async ({ page }) => {
    await page.goto('https://example.com');
    await page.waitForSelector('#ai-translator-float-ball');

    await addTestParagraphs(page);

    const paragraphOne = page.locator('#hover-para-one');
    const paragraphTwo = page.locator('#hover-para-two');

    await page.keyboard.down('Shift');
    await paragraphOne.hover();
    await page.waitForSelector('#hover-para-one + .ai-translator-hover-translation', { state: 'attached' });
    await paragraphTwo.hover();
    await page.waitForFunction(() => {
      return document.querySelectorAll('.ai-translator-hover-translation').length === 2;
    });
    await page.keyboard.up('Shift');

    await page.keyboard.press('Escape');
    await page.waitForFunction(() => {
      return document.querySelectorAll('.ai-translator-hover-translation').length === 0;
    });
  });

  test('right-click on paragraph does not clear inline translation', async ({ page }) => {
    await page.goto('https://example.com');
    await page.waitForSelector('#ai-translator-float-ball');

    await addTestParagraphs(page);
    const paragraphOne = page.locator('#hover-para-one');

    await page.keyboard.down('Shift');
    await paragraphOne.hover();
    await page.waitForSelector('#hover-para-one + .ai-translator-hover-translation', { state: 'attached' });
    await page.keyboard.up('Shift');

    await page.dispatchEvent('#hover-para-one', 'contextmenu', { button: 2 });
    await page.waitForTimeout(200);
    await page.waitForSelector('#hover-para-one + .ai-translator-hover-translation', { state: 'attached' });
  });

  test('context menu action clears inline translation', async ({ page }) => {
    await page.goto('https://example.com');
    await page.waitForSelector('#ai-translator-float-ball');

    await addTestParagraphs(page);
    const paragraphOne = page.locator('#hover-para-one');

    await page.keyboard.down('Shift');
    await paragraphOne.hover();
    await page.waitForSelector('#hover-para-one + .ai-translator-hover-translation', { state: 'attached' });
    await page.keyboard.up('Shift');

    await page.dispatchEvent('.ai-translator-hover-translation', 'contextmenu', { button: 2 });
    await sendMessageToActiveTab(page, { type: 'CLEAR_INLINE_TRANSLATION_CONTEXT' });
    await page.waitForSelector('#hover-para-one + .ai-translator-hover-translation', { state: 'detached' });
  });

  test('hover hotkey clears selection translation on the same block', async ({ page }) => {
    await page.goto('https://example.com');
    await page.waitForSelector('#ai-translator-float-ball');

    await setExtensionSettings(page, {
      selectionTranslationMode: 'inline',
      enableHoverTranslation: true,
      hoverTranslationHotkey: 'Shift',
    });

    const paragraph = page.locator('p').first();
    await paragraph.scrollIntoViewIfNeeded();

    await page.evaluate(() => {
      const paragraphEl = document.querySelector('p');
      if (!paragraphEl || !paragraphEl.firstChild) return;
      const text = paragraphEl.firstChild.textContent || '';
      const wordEnd = Math.min(4, text.length);
      const range = document.createRange();
      range.setStart(paragraphEl.firstChild, 0);
      range.setEnd(paragraphEl.firstChild, wordEnd);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    });

    const box = await paragraph.boundingBox();
    if (box) {
      await page.dispatchEvent('p', 'mouseup', {
        clientX: box.x + box.width / 2,
        clientY: box.y + box.height / 2,
      });
    }

    await triggerSelectionHotkey(page);
    await page.waitForSelector('.ai-translator-selection-translation', { state: 'attached' });

    await paragraph.hover();
    await page.keyboard.press('Shift');
    await page.waitForSelector('.ai-translator-selection-translation', { state: 'detached' });
  });

  test('selection translation inserts after partial selection', async ({ page }) => {
    await page.goto('https://example.com');
    await page.waitForSelector('#ai-translator-float-ball');

    await setExtensionSettings(page, {
      selectionTranslationMode: 'inline',
    });

    const paragraph = page.locator('p').first();
    await paragraph.scrollIntoViewIfNeeded();

    await page.evaluate(() => {
      const paragraphEl = document.querySelector('p');
      if (!paragraphEl || !paragraphEl.firstChild) return;
      const text = paragraphEl.firstChild.textContent || '';
      const wordEnd = Math.min(4, text.length);
      const range = document.createRange();
      range.setStart(paragraphEl.firstChild, 0);
      range.setEnd(paragraphEl.firstChild, wordEnd);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    });

    const box = await paragraph.boundingBox();
    if (box) {
      await page.dispatchEvent('p', 'mouseup', {
        clientX: box.x + box.width / 2,
        clientY: box.y + box.height / 2,
      });
    }

    await triggerSelectionHotkey(page);
    await page.waitForSelector('.ai-translator-selection-translation', { state: 'attached' });

    await expect(paragraph.locator('.ai-translator-selection-translation')).toHaveCount(1);
    await expect(paragraph.locator('.ai-translator-selection-translation')).toBeVisible();
    await expect(page.locator('p + .ai-translator-selection-translation')).toHaveCount(0);
    await page.waitForFunction(() => {
      const el = document.querySelector('.ai-translator-selection-translation');
      if (!el) return false;
      return window.getComputedStyle(el).display === 'inline';
    });
  });

  test('selection translation avoids inserting into math containers', async ({ page }) => {
    await page.goto('https://example.com');
    await page.waitForSelector('#ai-translator-float-ball');

    await setExtensionSettings(page, {
      selectionTranslationMode: 'inline',
    });

    await page.evaluate(() => {
      const existing = document.getElementById('ai-translator-math-selection');
      if (existing) return;
      const container = document.createElement('div');
      container.innerHTML = `
        <p id="ai-translator-math-selection">
          Energy
          <span id="ai-translator-math-inline" class="katex">E=mc^2</span>
          equation.
        </p>
      `;
      document.body.appendChild(container);
    });

    await page.evaluate(() => {
      const paragraph = document.getElementById('ai-translator-math-selection');
      const mathEl = document.getElementById('ai-translator-math-inline');
      if (!paragraph || !mathEl || !mathEl.firstChild) return;

      const startNode = paragraph.firstChild;
      const range = document.createRange();
      range.setStart(startNode, Math.min(2, startNode.textContent.length));
      range.setEnd(mathEl.firstChild, Math.min(2, mathEl.firstChild.textContent.length));

      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    });

    const paragraphBox = await page.locator('#ai-translator-math-selection').boundingBox();
    if (paragraphBox) {
      await page.dispatchEvent('#ai-translator-math-selection', 'mouseup', {
        clientX: paragraphBox.x + Math.min(10, paragraphBox.width / 2),
        clientY: paragraphBox.y + Math.min(10, paragraphBox.height / 2),
      });
    }

    await page.waitForTimeout(150);
    const selectedText = await page.evaluate(() => window.getSelection().toString().trim());

    await sendMessageToActiveTab(page, {
      type: 'SHOW_TRANSLATION',
      text: selectedText || 'Energy',
      translation: 'Translated',
      phonetic: '',
      isWord: false,
    });

    const translation = page.locator('.ai-translator-selection-translation');
    await expect(translation).toHaveCount(1);
    await expect(page.locator('#ai-translator-math-inline .ai-translator-selection-translation')).toHaveCount(0);
  });

  test('selection translation preserves MathML elements', async ({ page }) => {
    await page.goto('https://example.com');
    await page.waitForSelector('#ai-translator-float-ball');

    await setExtensionSettings(page, {
      selectionTranslationMode: 'inline',
    });

    await page.evaluate(() => {
      const existing = document.getElementById('ai-translator-mathml-selection');
      if (existing) return;
      const paragraph = document.createElement('p');
      paragraph.id = 'ai-translator-mathml-selection';
      paragraph.innerHTML = `
        where
        <math id="ai-translator-mathml-inline" class="ltx_Math" display="inline">
          <mi>c</mi><mo>=</mo><mi>d</mi>
        </math>
        is defined
      `;
      document.body.appendChild(paragraph);
    });

    await page.evaluate(() => {
      const paragraph = document.getElementById('ai-translator-mathml-selection');
      const mathEl = document.getElementById('ai-translator-mathml-inline');
      if (!paragraph || !mathEl) return;
      const startNode = paragraph.firstChild;
      const range = document.createRange();
      range.setStart(startNode, Math.min(2, startNode.textContent.length));
      range.setEndAfter(mathEl);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    });

    const paragraphBox = await page.locator('#ai-translator-mathml-selection').boundingBox();
    if (paragraphBox) {
      await page.dispatchEvent('#ai-translator-mathml-selection', 'mouseup', {
        clientX: paragraphBox.x + Math.min(10, paragraphBox.width / 2),
        clientY: paragraphBox.y + Math.min(10, paragraphBox.height / 2),
      });
    }

    await page.waitForTimeout(150);

    await sendMessageToActiveTab(page, {
      type: 'SHOW_TRANSLATION',
      text: 'where {{1}} is defined',
      translation: 'Translated {{1}}',
      phonetic: '',
      isWord: false,
    });

    const translation = page.locator('.ai-translator-selection-translation');
    await expect(translation).toHaveCount(1);
    await expect(translation.locator('math')).toHaveCount(1);
    await expect(translation).not.toContainText('{{1}}');
  });

  test('selection translation does not split inline LaTeX', async ({ page }) => {
    await page.goto('https://example.com');
    await page.waitForSelector('#ai-translator-float-ball');

    await setExtensionSettings(page, {
      selectionTranslationMode: 'inline',
    });

    await page.evaluate(() => {
      const existing = document.getElementById('ai-translator-inline-latex');
      if (existing) return;
      const paragraph = document.createElement('p');
      paragraph.id = 'ai-translator-inline-latex';
      paragraph.textContent = 'Energy $E=mc^2$ equation.';
      document.body.appendChild(paragraph);
    });

    await page.evaluate(() => {
      const paragraph = document.getElementById('ai-translator-inline-latex');
      const textNode = paragraph?.firstChild;
      if (!textNode || textNode.nodeType !== Node.TEXT_NODE) return;
      const text = textNode.textContent || '';
      const latexStart = text.indexOf('$');
      if (latexStart === -1) return;
      const endOffset = Math.min(latexStart + 6, text.length);
      const range = document.createRange();
      range.setStart(textNode, 0);
      range.setEnd(textNode, endOffset);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    });

    const box = await page.locator('#ai-translator-inline-latex').boundingBox();
    if (box) {
      await page.dispatchEvent('#ai-translator-inline-latex', 'mouseup', {
        clientX: box.x + Math.min(10, box.width / 2),
        clientY: box.y + Math.min(10, box.height / 2),
      });
    }

    await page.waitForTimeout(150);
    const selectedText = await page.evaluate(() => window.getSelection().toString().trim());

    await sendMessageToActiveTab(page, {
      type: 'SHOW_TRANSLATION',
      text: selectedText || 'Energy',
      translation: 'Translated',
      phonetic: '',
      isWord: false,
    });

    const latexPreserved = await page.evaluate(() => {
      const paragraph = document.getElementById('ai-translator-inline-latex');
      return paragraph?.textContent?.includes('$E=mc^2$');
    });

    expect(latexPreserved).toBe(true);
  });

  test('selection translation works when hover translation is disabled', async ({ page }) => {
    await page.goto('https://example.com');
    await page.waitForSelector('#ai-translator-float-ball');

    await setExtensionSettings(page, {
      enableHoverTranslation: false,
      selectionTranslationMode: 'inline',
    });

    const paragraph = page.locator('p').first();
    await paragraph.scrollIntoViewIfNeeded();
    await paragraph.selectText();
    await triggerSelectionHotkey(page);

    await page.waitForSelector('.ai-translator-selection-translation', { state: 'attached' });
  });
});
