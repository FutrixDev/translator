# Hover Translation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add Shift+hover paragraph translation and inline selection translation with a settings toggle.

**Architecture:** New content module for hover/selection inline translation; reuse math placeholder helpers from page translation; options toggle controls both hover and selection display mode.

**Tech Stack:** MV3 Chrome extension, content scripts, Playwright E2E

---

### Task 1: Add hover/selection E2E tests

**Files:**
- Create: `test/e2e/hover-translation.spec.js`

**Step 1: Write the failing test**

```js
const { test, expect } = require('./fixtures');

async function seedApiKey(context, extensionId) {
  const optionsPage = await context.newPage();
  await optionsPage.goto(`chrome-extension://${extensionId}/options/options.html`);
  await optionsPage.evaluate(() => new Promise((resolve) => {
    chrome.storage.sync.set({
      apiKey: 'test-key',
      apiEndpoint: 'https://api.openai.com/v1/chat/completions',
      modelName: 'gpt-4.1-mini',
      enableHoverTranslation: true,
      enableSelection: true,
    }, resolve);
  }));
  await optionsPage.close();
}

function stubTranslation(context) {
  return context.route('**/v1/chat/completions', async (route) => {
    const body = route.request().postDataJSON();
    const userMsg = body?.messages?.find((m) => m.role === 'user');
    const content = userMsg?.content || '';
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        choices: [{ message: { content: `Translated: ${content}` } }]
      })
    });
  });
}

test.describe('Hover Translation', () => {
  test.beforeEach(async ({ context, extensionId }) => {
    await stubTranslation(context);
    await seedApiKey(context, extensionId);
  });

  test('shows and hides inline translation on Shift hover', async ({ page }) => {
    await page.goto('https://example.com');
    await page.waitForSelector('#ai-translator-float-ball');

    const paragraph = page.locator('p').first();
    await paragraph.scrollIntoViewIfNeeded();

    await page.keyboard.down('Shift');
    await paragraph.hover();

    await page.waitForSelector('.ai-translator-hover-translation', { state: 'attached' });

    await page.keyboard.up('Shift');
    await page.waitForSelector('.ai-translator-hover-translation', { state: 'detached' });
  });

  test('selection translation renders inline and clears on deselect', async ({ page }) => {
    await page.goto('https://example.com');
    await page.waitForSelector('#ai-translator-float-ball');

    const paragraph = page.locator('p').first();
    await paragraph.scrollIntoViewIfNeeded();
    await paragraph.selectText();

    await page.waitForSelector('#ai-translator-selection-btn', { state: 'visible' });
    await page.click('#ai-translator-selection-btn');

    await page.waitForSelector('.ai-translator-selection-translation', { state: 'attached' });

    await page.evaluate(() => window.getSelection().removeAllRanges());
    await page.waitForSelector('.ai-translator-selection-translation', { state: 'detached' });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx playwright test test/e2e/hover-translation.spec.js`
Expected: FAIL waiting for `.ai-translator-hover-translation` or `.ai-translator-selection-translation`.

---

### Task 2: Add hover translation content module and wire-up

**Files:**
- Create: `content/content-hover-translation.js`
- Modify: `manifest.json`
- Modify: `content/content-bootstrap.js`
- Modify: `content/content-page-translation.js`
- Modify: `content/content-selection.js`
- Modify: `content/content-float-ball.js`
- Modify: `content/content-messaging.js`
- Modify: `content/content.css`

**Step 1: Write minimal implementation skeleton**

```js
// content/content-hover-translation.js
(function() {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT;
  if (!ctx) return;

  const { settings, constants } = ctx;
  const blockTags = new Set(['P','LI','H1','H2','H3','H4','H5','H6','BLOCKQUOTE','FIGCAPTION','DT','DD']);
  const skipSelector = '.ai-translator-popup, .ai-translator-inline-block, .ai-translator-hover-translation, .ai-translator-selection-translation, #ai-translator-float-ball, #ai-translator-float-menu, #ai-translator-progress, #ai-translator-selection-btn';

  let shiftDown = false;
  let hoverBlock = null;
  let hoverTranslationEl = null;
  let hoverRequestId = 0;
  const hoverCache = new WeakMap();

  function setupHoverTranslation() { /* wire listeners */ }
  function clearHoverTranslation() { /* remove hoverTranslationEl */ }
  function translateHoverBlock(block) { /* send TRANSLATE and render */ }
  function translateSelectionInline(text, anchorEl) { /* selection translation */ }

  ctx.setupHoverTranslation = setupHoverTranslation;
  ctx.clearHoverTranslation = clearHoverTranslation;
  ctx.translateSelectionInline = translateSelectionInline;
})();
```

**Step 2: Run test to verify it still fails**

Run: `npx playwright test test/e2e/hover-translation.spec.js`
Expected: still failing (no translation rendered).

**Step 3: Implement hover translation logic and inline rendering**

- Resolve hover target to nearest block tag while skipping code/math/extension UI.
- Extract text with `ctx.getTextWithMathPlaceholders`.
- Send `chrome.runtime.sendMessage({ type: 'TRANSLATE', text, targetLang, mode: 'text' })`.
- Render inline translation under the block with class `ai-translator-hover-translation`.
- Clear translation on `mouseout` (when leaving block) or `Shift` up.

**Step 4: Implement selection inline translation**

- Extend `content/content-selection.js` to store `state.lastSelectionElement` from selection range.
- On selection button click, call `ctx.translateSelectionInline(state.lastSelectedText, state.lastSelectionElement)` when hover translation is enabled; else use popup.
- Listen to `selectionchange` to clear inline selection translation when selection is empty.
- For context menu `SHOW_TRANSLATION` message, render inline if hover translation is enabled and a selection block is resolvable.

**Step 5: Export math helpers from page translation**

At end of `content/content-page-translation.js`:

```js
ctx.getTextWithMathPlaceholders = getTextWithMathPlaceholders;
ctx.buildTranslationContentWithMath = buildTranslationContentWithMath;
ctx.isMathElement = isMathElement;
ctx.isIconElement = isIconElement;
ctx.isHorizontalFlexParent = isHorizontalFlexParent;
```

**Step 6: Wire module in bootstrap and manifest**

- Add `enableHoverTranslation` to defaults in `content/content-bootstrap.js`.
- Call `ctx.setupHoverTranslation()` in `ctx.init()`.
- Add `content/content-hover-translation.js` to `manifest.json` content scripts list.

**Step 7: Run test to verify it passes**

Run: `npx playwright test test/e2e/hover-translation.spec.js`
Expected: PASS.

---

### Task 3: Add settings UI + i18n

**Files:**
- Modify: `options/options.html`
- Modify: `options/options.js`
- Modify: `i18n/messages.js`

**Step 1: Add toggle in options page**

```html
<div class="toggle-group">
  <label class="toggle-label">
    <span data-i18n="enableHoverTranslation">Enable Hover Translation</span>
    <input type="checkbox" id="enableHoverTranslation" checked>
    <span class="toggle-slider"></span>
  </label>
  <span class="hint" data-i18n-hint="enableHoverTranslation">Hold Shift while hovering paragraphs to translate</span>
</div>
```

**Step 2: Wire settings in options JS**

- Add element reference: `enableHoverTranslation`.
- Add default setting: `enableHoverTranslation: true`.
- Load: `elements.enableHoverTranslation.checked = result.enableHoverTranslation;`.
- Save: `enableHoverTranslation: elements.enableHoverTranslation.checked`.
- Add hint translations for all supported languages.

**Step 3: Add i18n labels**

Add `enableHoverTranslation` key to `i18n/messages.js` for all languages.

**Step 4: Run test to verify it still passes**

Run: `npx playwright test test/e2e/hover-translation.spec.js`
Expected: PASS.

---

### Task 4: Final verification

**Step 1: Run targeted tests**

Run: `npx playwright test test/e2e/hover-translation.spec.js`
Expected: PASS.

**Step 2: (Optional) Run full test suite**

Run: `npm test`
Expected: PASS.

---

## Notes
- Per user request, do not commit any docs under `docs/plans/`.
- Use `ai-translator-hover-translation` and `ai-translator-selection-translation` classes to distinguish temporary inline translations from full-page translations.
