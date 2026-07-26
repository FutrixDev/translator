# Hover Translation Hotkey Toggle Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make hover translation toggled by a configurable hotkey (default Shift) with inline insertion that persists until toggled off, and decouple selection translation display (inline vs popup).

**Architecture:** Content script tracks the currently hovered block and hotkey presses to toggle inline translations per paragraph without clearing on mouseout. Selection translation uses a separate `selectionTranslationMode` setting and is applied consistently across selection button, float menu, and context menu. Settings changes flow through `chrome.storage.onChanged` and `SETTINGS_UPDATED`, while options/i18n expose the new controls.

**Tech Stack:** Chrome extension content scripts, options UI (vanilla JS/HTML), Playwright E2E tests.

---

### Task 1: Hotkey toggle hover translation

**Files:**
- Modify: `test/e2e/hover-translation.spec.js`
- Modify: `test/e2e/helpers.js`
- Modify: `content/content-hover-translation.js`
- Modify: `content/content-bootstrap.js`

**Step 1: Write the failing tests**

```js
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

  await page.keyboard.down('Alt');
  await paragraph.hover();
  await page.waitForSelector('.ai-translator-hover-translation', { state: 'attached' });
  await page.keyboard.up('Alt');
});
```

```js
async function setExtensionSettings(page, settings) {
  const context = page.context();
  let worker = context.serviceWorkers()[0];
  if (!worker) {
    worker = await context.waitForEvent('serviceworker');
  }
  await worker.evaluate((newSettings) => {
    return new Promise((resolve) => {
      chrome.storage.sync.set(newSettings, resolve);
    });
  }, settings);
}
```

**Step 2: Run tests to verify they fail**

Run: `npx playwright test test/e2e/hover-translation.spec.js`  
Expected: FAIL with timeout waiting for `.ai-translator-hover-translation`.

**Step 3: Write minimal implementation**

```js
const HOTKEYS = new Set(['Shift', 'Alt', 'Control', 'Meta']);
let hotkeyPressed = false;
let hoverBlock = null;
let hoverRequestId = 0;
let hoverTranslationMap = new WeakMap();
let hoverPendingMap = new WeakMap();

function isHotkeyEvent(event) {
  const hotkey = settings.hoverTranslationHotkey || 'Shift';
  return HOTKEYS.has(event.key) && event.key === hotkey;
}

function isEditableTarget(target) {
  if (!target || target.nodeType !== Node.ELEMENT_NODE) return false;
  const el = target;
  return el.isContentEditable || el.closest('input, textarea, select');
}

function handleKeyDown(event) {
  if (!settings.enableHoverTranslation) return;
  if (!isHotkeyEvent(event) || event.repeat) return;
  if (isEditableTarget(event.target)) return;
  hotkeyPressed = true;
  if (hoverBlock) toggleHoverTranslation(hoverBlock);
}

function handleKeyUp(event) {
  if (!isHotkeyEvent(event)) return;
  hotkeyPressed = false;
}

function handleMouseOver(event) {
  if (!settings.enableHoverTranslation) return;
  const block = resolveBlockFromTarget(event.target);
  if (!block || block === hoverBlock) return;
  hoverBlock = block;
  if (hotkeyPressed) {
    ensureHoverTranslation(block);
  }
}

function handleMouseOut(event) {
  if (!hoverBlock) return;
  const related = event.relatedTarget;
  if (related && hoverBlock.contains(related)) return;
  hoverBlock = null;
}

function getHoverTranslationEl(block) {
  const existing = hoverTranslationMap.get(block);
  if (existing && document.contains(existing)) return existing;
  if (existing) hoverTranslationMap.delete(block);
  return null;
}

function removeHoverTranslation(block) {
  const existing = getHoverTranslationEl(block);
  if (existing) existing.remove();
  hoverTranslationMap.delete(block);
  hoverPendingMap.delete(block);
}

function toggleHoverTranslation(block) {
  if (!block || !isValidBlock(block)) return;
  const existing = getHoverTranslationEl(block);
  if (existing) {
    removeHoverTranslation(block);
    return;
  }
  ensureHoverTranslation(block);
}

function ensureHoverTranslation(block) {
  if (!block || hoverPendingMap.has(block)) return;
  if (getHoverTranslationEl(block)) return;
  translateHoverBlock(block);
}

function clearHoverTranslation() {
  hoverRequestId += 1;
  hoverBlock = null;
  document.querySelectorAll('.ai-translator-hover-translation').forEach(el => el.remove());
  hoverTranslationMap = new WeakMap();
  hoverPendingMap = new WeakMap();
}

async function translateHoverBlock(block) {
  const { text, mathElements } = getBlockText(block);
  if (!text || text.length < 2 || text.length > 2000) return;

  const targetLang = ctx.getEffectiveTargetLang ? ctx.getEffectiveTargetLang() : settings.targetLang;
  const cacheKey = buildCacheKey(text, targetLang);
  const cached = getCachedTranslation(block, cacheKey);
  if (cached) {
    const el = renderInlineTranslation(block, cached, mathElements, { kind: 'hover' });
    hoverTranslationMap.set(block, el);
    return;
  }

  const requestId = ++hoverRequestId;
  hoverPendingMap.set(block, requestId);
  if (!ctx.isExtensionContextAvailable || !ctx.isExtensionContextAvailable()) {
    const el = renderInlineTranslation(block, t('extensionContextInvalidated'), [], { kind: 'hover', isError: true });
    hoverTranslationMap.set(block, el);
    hoverPendingMap.delete(block);
    return;
  }

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'TRANSLATE',
      text,
      targetLang,
      mode: 'text'
    });

    if (hoverPendingMap.get(block) !== requestId) return;
    hoverPendingMap.delete(block);

    if (response?.error) {
      const el = renderInlineTranslation(block, response.error, [], { kind: 'hover', isError: true });
      hoverTranslationMap.set(block, el);
      return;
    }

    const translation = response?.translation || '';
    setCachedTranslation(block, cacheKey, translation);
    const el = renderInlineTranslation(block, translation, mathElements, { kind: 'hover' });
    hoverTranslationMap.set(block, el);
  } catch (error) {
    if (hoverPendingMap.get(block) !== requestId) return;
    hoverPendingMap.delete(block);
    const message = ctx.isExtensionContextInvalidated && ctx.isExtensionContextInvalidated(error)
      ? t('extensionContextInvalidated')
      : t('translationFailed');
    const el = renderInlineTranslation(block, message, [], { kind: 'hover', isError: true });
    hoverTranslationMap.set(block, el);
  }
}
```

```js
chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace !== 'sync') return;
  Object.keys(changes).forEach((key) => {
    ctx.settings[key] = changes[key].newValue;
  });
  if (changes.showFloatBall && ctx.updateFloatBallVisibility) ctx.updateFloatBallVisibility();
  if (changes.theme) ctx.applyTheme(ctx.settings.theme);
});
```

**Step 4: Run tests to verify they pass**

Run: `npx playwright test test/e2e/hover-translation.spec.js`  
Expected: PASS for the two hotkey tests.

**Step 5: Commit**

```bash
git add test/e2e/hover-translation.spec.js test/e2e/helpers.js content/content-hover-translation.js content/content-bootstrap.js
git commit -m "feat: toggle hover translation with configurable hotkey"
```

### Task 2: Decouple selection translation mode from hover setting

**Files:**
- Modify: `test/e2e/hover-translation.spec.js`
- Modify: `content/content-hover-translation.js`
- Modify: `content/content-selection.js`
- Modify: `content/content-float-ball.js`
- Modify: `content/content-messaging.js`

**Step 1: Write the failing test**

```js
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
  const box = await paragraph.boundingBox();
  if (box) {
    await page.dispatchEvent('p', 'mouseup', {
      clientX: box.x + Math.min(10, box.width / 2),
      clientY: box.y + Math.min(10, box.height / 2),
    });
  }

  await page.waitForSelector('#ai-translator-selection-btn', { state: 'visible' });
  await page.click('#ai-translator-selection-btn');
  await page.waitForSelector('.ai-translator-selection-translation', { state: 'attached' });
});
```

**Step 2: Run test to verify it fails**

Run: `npx playwright test test/e2e/hover-translation.spec.js`  
Expected: FAIL waiting for `.ai-translator-selection-translation`.

**Step 3: Write minimal implementation**

```js
async function translateSelectionInline(text, anchorEl) {
  if (!text) return;
  // ...existing logic...
}

function showInlineSelectionTranslation(text, translation, anchorEl) {
  if (!text) return;
  // ...existing logic...
}
```

```js
if (settings.selectionTranslationMode === 'inline' && ctx.translateSelectionInline) {
  ctx.translateSelectionInline(state.lastSelectedText, state.lastSelectionElement);
} else if (ctx.showTranslationPopup) {
  ctx.showTranslationPopup(state.lastSelectedText, state.lastSelectionPos.x, state.lastSelectionPos.y);
}
```

```js
if (settings.selectionTranslationMode === 'inline' && ctx.translateSelectionInline) {
  ctx.translateSelectionInline(selectedText, state.lastSelectionElement);
} else {
  const pos = state.lastSelectionPos.x ? state.lastSelectionPos : { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  if (ctx.showTranslationPopup) ctx.showTranslationPopup(selectedText, pos.x, pos.y);
}
```

```js
if (settings.selectionTranslationMode === 'inline' && ctx.showInlineSelectionTranslation) {
  ctx.showInlineSelectionTranslation(message.text, message.translation);
} else if (ctx.showTranslationResult) {
  ctx.showTranslationResult(message.text, message.translation, message.phonetic, message.isWord);
}

if ('enableHoverTranslation' in message.settings && !message.settings.enableHoverTranslation) {
  if (ctx.clearHoverTranslation) ctx.clearHoverTranslation();
}
if ('enableSelection' in message.settings && !message.settings.enableSelection) {
  if (ctx.clearSelectionTranslation) ctx.clearSelectionTranslation();
}
```

**Step 4: Run tests to verify they pass**

Run: `npx playwright test test/e2e/hover-translation.spec.js`  
Expected: PASS for selection translation with hover disabled.

**Step 5: Commit**

```bash
git add content/content-hover-translation.js content/content-selection.js content/content-float-ball.js content/content-messaging.js test/e2e/hover-translation.spec.js
git commit -m "feat: separate selection translation mode from hover"
```

### Task 3: Expose new settings in options and i18n

**Files:**
- Create: `test/e2e/options-settings.spec.js`
- Modify: `options/options.html`
- Modify: `options/options.js`
- Modify: `i18n/messages.js`

**Step 1: Write the failing test**

```js
const { test, expect } = require('./fixtures');

test('options page persists hover hotkey and selection display mode', async ({ page, extensionId }) => {
  const optionsUrl = `chrome-extension://${extensionId}/options/options.html`;
  await page.goto(optionsUrl);
  await page.waitForSelector('#selectionTranslationMode');

  await page.fill('#apiKey', 'test-key');
  await page.fill('#modelName', 'gpt-4.1-mini');
  await page.selectOption('#selectionTranslationMode', 'popup');
  await page.selectOption('#hoverTranslationHotkey', 'Alt');
  await page.click('#saveSettings');

  await page.waitForSelector('.status-message.success', { state: 'visible' });

  const context = page.context();
  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent('serviceworker');
  const stored = await worker.evaluate(() => {
    return new Promise((resolve) => {
      chrome.storage.sync.get(['selectionTranslationMode', 'hoverTranslationHotkey'], resolve);
    });
  });

  expect(stored.selectionTranslationMode).toBe('popup');
  expect(stored.hoverTranslationHotkey).toBe('Alt');
});
```

**Step 2: Run test to verify it fails**

Run: `npx playwright test test/e2e/options-settings.spec.js`  
Expected: FAIL because elements or storage values are missing.

**Step 3: Write minimal implementation**

```html
<div class="form-group">
  <label for="selectionTranslationMode" data-i18n="selectionTranslationMode">Selection Translation Display</label>
  <select id="selectionTranslationMode">
    <option value="inline" data-i18n="selectionTranslationInline">Inline (below paragraph)</option>
    <option value="popup" data-i18n="selectionTranslationPopup">Popup window</option>
  </select>
  <span class="hint" data-i18n-hint="selectionTranslationMode">Choose how selection translations are shown</span>
</div>

<div class="form-group">
  <label for="hoverTranslationHotkey" data-i18n="hoverTranslationHotkey">Hover Hotkey</label>
  <select id="hoverTranslationHotkey">
    <option value="Shift" data-i18n="hoverHotkeyShift">Shift</option>
    <option value="Alt" data-i18n="hoverHotkeyAlt">Alt</option>
    <option value="Control" data-i18n="hoverHotkeyCtrl">Ctrl</option>
    <option value="Meta" data-i18n="hoverHotkeyMeta">Meta</option>
  </select>
  <span class="hint" data-i18n-hint="hoverTranslationHotkey">Hold hotkey while hovering paragraphs to translate</span>
</div>
```

```js
const defaultSettings = {
  // ...
  enableSelection: true,
  enableHoverTranslation: true,
  selectionTranslationMode: 'inline',
  hoverTranslationHotkey: 'Shift',
  // ...
};

elements.selectionTranslationMode.value = result.selectionTranslationMode || 'inline';
elements.hoverTranslationHotkey.value = result.hoverTranslationHotkey || 'Shift';

const settings = {
  // ...
  enableSelection: elements.enableSelection.checked,
  enableHoverTranslation: elements.enableHoverTranslation.checked,
  selectionTranslationMode: elements.selectionTranslationMode.value,
  hoverTranslationHotkey: elements.hoverTranslationHotkey.value,
  // ...
};
```

```js
// Russian additions
selectionTranslationMode: 'Способ отображения перевода выделения',
selectionTranslationInline: 'Под абзацем',
selectionTranslationPopup: 'Всплывающее окно',
hoverTranslationHotkey: 'Горячая клавиша наведения',
hoverHotkeyShift: 'Shift',
hoverHotkeyAlt: 'Alt',
hoverHotkeyCtrl: 'Ctrl',
hoverHotkeyMeta: 'Meta',
```

**Step 4: Run test to verify it passes**

Run: `npx playwright test test/e2e/options-settings.spec.js`  
Expected: PASS.

**Step 5: Commit**

```bash
git add test/e2e/options-settings.spec.js options/options.html options/options.js i18n/messages.js
git commit -m "feat: add selection display and hover hotkey settings"
```
