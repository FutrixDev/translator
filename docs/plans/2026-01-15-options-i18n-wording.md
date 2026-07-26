# Options Wording I18n Migration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Move all options page UI wording (hints, placeholders, tooltips, and select placeholders) into `i18n/messages.js` and have JS only apply i18n keys.

**Architecture:** Options HTML marks UI copy with `data-i18n-*` attributes, and `options/options.js` applies translations via `getMessage` without per-language maps. i18n keys live exclusively in `i18n/messages.js`.

**Tech Stack:** Chrome extension options page (HTML/JS), Playwright E2E tests.

---

### Task 1: Add failing test for options i18n hints/placeholders

**Files:**
- Create: `test/e2e/options-i18n.spec.js`

**Step 1: Write the failing test**

```js
const { test, expect } = require('./fixtures');
const { getMessage } = require('../../i18n/messages');

test('options hints use i18n keys', async ({ page, extensionId }) => {
  const optionsUrl = `chrome-extension://${extensionId}/options/options.html`;
  await page.goto(optionsUrl);
  await page.waitForSelector('#apiEndpoint');

  const hint = page.locator('[data-i18n-hint="hintApiEndpoint"]');
  await expect(hint).toHaveCount(1);
  await expect(hint).toHaveText(getMessage('hintApiEndpoint', 'en'));
});
```

**Step 2: Run test to verify it fails**

Run: `npx playwright test test/e2e/options-i18n.spec.js`  
Expected: FAIL because `data-i18n-hint="hintApiEndpoint"` does not exist and i18n key is missing.

**Step 3: Write minimal implementation**

```html
<span class="hint" data-i18n-hint="hintApiEndpoint"></span>
```

```js
document.querySelectorAll('[data-i18n-hint]').forEach(el => {
  const key = el.getAttribute('data-i18n-hint');
  const text = t(key);
  if (text && text !== key) {
    el.innerHTML = text;
  }
});
```

```js
hintApiEndpoint: 'Supports OpenAI compatible API',
```

**Step 4: Run test to verify it passes**

Run: `npx playwright test test/e2e/options-i18n.spec.js`  
Expected: PASS.

**Step 5: Commit**

```bash
git add test/e2e/options-i18n.spec.js options/options.html options/options.js i18n/messages.js
git commit -m "test: add options i18n hint coverage"
```

### Task 2: Migrate all options wording into i18n

**Files:**
- Modify: `options/options.html`
- Modify: `options/options.js`
- Modify: `i18n/messages.js`

**Step 1: Write failing assertions for placeholders/tooltips**

```js
await expect(page.locator('#apiKey')).toHaveAttribute('placeholder', getMessage('placeholderApiKey', 'en'));
await expect(page.locator('#toggleApiKey')).toHaveAttribute('title', getMessage('toggleApiKey', 'en'));
```

**Step 2: Run test to verify it fails**

Run: `npx playwright test test/e2e/options-i18n.spec.js`  
Expected: FAIL because placeholder and title are not driven by i18n.

**Step 3: Write minimal implementation**

```html
<input id="apiKey" data-i18n-placeholder="placeholderApiKey" placeholder="">
<button id="toggleApiKey" data-i18n-title="toggleApiKey"></button>
```

```js
document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
  const key = el.getAttribute('data-i18n-placeholder');
  const text = t(key);
  if (text && text !== key) {
    el.setAttribute('placeholder', text);
  }
});
```

```js
placeholderApiKey: 'sk-xxxxxxxxxxxxxxxx',
toggleApiKey: 'Show/Hide',
```

**Step 4: Run tests to verify they pass**

Run: `npx playwright test test/e2e/options-i18n.spec.js`  
Expected: PASS.

**Step 5: Commit**

```bash
git add options/options.html options/options.js i18n/messages.js test/e2e/options-i18n.spec.js
git commit -m "refactor: move options wording to i18n"
```
