// P0-D journeys J-D1 .. J-D10 (docs/plans/2026-09-24-p0-d-selection-card.md §10.2):
// the selection icon, the card anchored to the selection, and the card's four
// actions (retranslate, switch engine, copy, speak).
//
// Every page is served through context.route on an https origin: the built-in
// engine is a SecureContext API, so the switch-engine journey only exists on
// https. Chromium in the e2e run has no on-device model, so the built-in engine
// is a STUB (stubBuiltinTranslator) that answers '[B] <text>'.
const { test, expect } = require('./fixtures');
const {
  setExtensionSettings,
  getSyncSettings,
  sendMessageToActiveTab,
  triggerSelectionHotkey,
  stubBuiltinTranslator,
  waitForFloatBall,
} = require('./helpers');
const { startMockOpenAIServer } = require('./mock-openai-server');
const { startMockServer } = require('./mock-server');
const { getMessage, UI_LANGUAGES } = require('../../i18n/messages');

const ORIGIN = 'https://selection.test';
const VIEWPORT = { width: 1280, height: 720 };
const MARGIN = 8;
const en = (key) => getMessage(key, 'en');

const STYLE = `
  body { margin: 0; padding: 40px 60px; font: 18px/28px Georgia, serif; color: #222; background: #fff; }
  p { width: 640px; margin: 0 0 28px; }
  input, textarea { display: block; width: 400px; font: 16px/24px sans-serif; margin: 0 0 16px; }
  #editable { width: 400px; border: 1px solid #999; margin: 0 0 16px; }
  #spacer { height: 1500px; }
`;

const LEAD = 'The harbour master posts the tide table every Friday morning, and the ferry '
  + 'crews read it before the first crossing. When the spring tides run high the timetable '
  + 'shifts by half an hour, and the notice on the pier says so in plain words for everyone.';

const MAIN_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Harbour notes</title><style>${STYLE}</style></head>
<body>
  <p id="lead">${LEAD}</p>
  <p id="second">Fishing boats leave before dawn and come back when the fog lifts over the bay.</p>
  <input id="field" value="Harbour tides and ferry crossings">
  <textarea id="area" rows="2">Harbour tides and ferry crossings</textarea>
  <div id="editable" contenteditable="true">Harbour tides and ferry crossings</div>
  <div id="spacer"></div>
  <p id="low">The lighthouse keeper logs every passing ship.</p>
  <div style="height: 400px"></div>
</body></html>`;

const LONG_TEXT = Array.from({ length: 30 }, (_, i) => `Sentence ${i + 1} of the harbour log records `
  + 'the wind, the swell and the names of the boats that went out.').join(' ');

const LONG_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Harbour log</title><style>${STYLE}</style></head>
<body><p id="long">${LONG_TEXT}</p></body></html>`;

async function servePages(context) {
  await context.route(`${ORIGIN}/**`, (route) => {
    const url = new URL(route.request().url());
    const body = url.pathname === '/long' ? LONG_PAGE : MAIN_PAGE;
    route.fulfill({ status: 200, contentType: 'text/html', body });
  });
}

function aiSettings(endpoint, extra = {}) {
  return {
    provider: 'custom',
    apiEndpoint: endpoint,
    apiKey: 'test-key',
    modelName: 'gpt-4.1-mini',
    targetLang: 'zh-CN',
    enableSelection: true,
    selectionTranslationMode: 'popup',
    ...extra,
  };
}

async function openPage(page, path = '/') {
  await page.goto(`${ORIGIN}${path}`);
  await waitForFloatBall(page);
}

// A real mouse drag, from one viewport point to another.
async function drag(page, from, to) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await page.mouse.up();
}

// Drag from the start of an element's first line to the middle of its second
// line (or across its only line).
async function dragSelect(page, selector) {
  const box = await page.locator(selector).boundingBox();
  const lineMid = 14;
  const twoLines = box.height > 40;
  await drag(page,
    { x: box.x + 2, y: box.y + lineMid },
    twoLines
      ? { x: box.x + box.width * 0.5, y: box.y + lineMid + 28 }
      : { x: box.x + box.width - 2, y: box.y + lineMid });
}

async function selectionGeometry(page) {
  return page.evaluate(() => {
    const sel = window.getSelection();
    if (!sel.rangeCount || sel.isCollapsed) return null;
    const plain = (r) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
    const range = sel.getRangeAt(0);
    const rects = Array.from(range.getClientRects()).filter((r) => r.width && r.height).map(plain);
    return { rects, box: plain(range.getBoundingClientRect()), text: sel.toString() };
  });
}

async function rectOf(locator) {
  const b = await locator.boundingBox();
  return { left: b.x, top: b.y, right: b.x + b.width, bottom: b.y + b.height };
}

function intersects(a, b) {
  const eps = 0.5;
  return a.left < b.right - eps && b.left < a.right - eps && a.top < b.bottom - eps && b.top < a.bottom - eps;
}

function expectInViewport(rect, margin = MARGIN) {
  expect(rect.left).toBeGreaterThanOrEqual(margin - 0.5);
  expect(rect.top).toBeGreaterThanOrEqual(margin - 0.5);
  expect(rect.right).toBeLessThanOrEqual(VIEWPORT.width - margin + 0.5);
  expect(rect.bottom).toBeLessThanOrEqual(VIEWPORT.height - margin + 0.5);
}

// Wait until nothing under selector is still animating or transitioning.
async function settle(page, selector) {
  await page.waitForFunction((sel) => {
    const root = document.querySelector(sel);
    return !!root && root.getAnimations({ subtree: true }).every((a) => a.playState === 'finished');
  }, selector);
}

// The icon pops in (a 0.2 s scale + translateY); measure it where it lands.
async function settledIconRect(page) {
  await settle(page, '#ai-translator-selection-btn');
  return rectOf(icon(page));
}

// The card's action row, and each visible button in it relative to the row.
// The card itself is re-placed as its content changes, so positions on the
// page are not what stays put — positions inside the row are.
async function actionRow(page) {
  await settle(page, '.ai-translator-popup');
  return page.evaluate(() => {
    const row = document.querySelector('.ai-translator-popup .ai-translator-actions');
    const box = row.getBoundingClientRect();
    return {
      origin: { x: box.left, y: box.top },
      width: box.width,
      height: box.height,
      buttons: Array.from(row.querySelectorAll('button'))
        .filter((b) => !b.hidden && b.offsetParent)
        .map((b) => {
          const r = b.getBoundingClientRect();
          return {
            cls: b.className,
            text: b.textContent.trim(),
            left: r.left - box.left,
            top: r.top - box.top,
            width: r.width,
            height: r.height,
          };
        }),
    };
  });
}

// Same buttons, same places, same row size: nothing moved under the pointer.
function expectRowUnchanged(after, before, where) {
  const near = (a, b) => Math.abs(a - b) <= 0.5;
  const same = after.buttons.length === before.buttons.length
    && after.buttons.every((b, i) => b.cls === before.buttons[i].cls
      && ['left', 'top', 'width', 'height'].every((k) => near(b[k], before.buttons[i][k])))
    && near(after.width, before.width)
    && near(after.height, before.height);
  expect(same, `${where}\nbefore ${JSON.stringify(before)}\nafter  ${JSON.stringify(after)}`).toBe(true);
}

// A new drag that starts on selected text would drag that text instead of
// selecting — start every reselect from nothing.
async function reselect(page, selector) {
  await page.evaluate(() => window.getSelection().removeAllRanges());
  await dragSelect(page, selector);
}

const icon = (page) => page.locator('#ai-translator-selection-btn .ai-translator-selection-icon');
const card = (page) => page.locator('.ai-translator-popup');
const cardText = (page) => page.locator('.ai-translator-popup .ai-translator-translation-text');
const cardError = (page) => page.locator('.ai-translator-popup .ai-translator-error');
const engineTag = (page) => page.locator('.ai-translator-popup .ai-translator-engine-tag');
const retranslateBtn = (page) => page.locator('.ai-translator-popup .ai-translator-retranslate');
const switchBtn = (page) => page.locator('.ai-translator-popup .ai-translator-switch-engine');
const copyBtn = (page) => page.locator('.ai-translator-popup .ai-translator-copy');

// The icon's mouseup settle is 100 ms; anything that would have shown it has
// by this point.
const SETTLE_MS = 400;

test.describe('selection icon and card actions', () => {
  test('J-D1: icon beside the last line, card beside the selection, all four actions', async ({ page, context }) => {
    const mock = await startMockOpenAIServer();
    try {
      await servePages(context);
      await setExtensionSettings(page, aiSettings(mock.endpoint));
      await openPage(page);
      await stubBuiltinTranslator(page);

      await dragSelect(page, '#lead');
      await expect(icon(page)).toBeVisible();

      const sel = await selectionGeometry(page);
      expect(sel.rects.length).toBeGreaterThan(1);
      const lastBottom = Math.max(...sel.rects.map((r) => r.bottom));
      const lastLine = sel.rects.filter((r) => Math.abs(r.bottom - lastBottom) < 1);
      const line = {
        left: Math.min(...lastLine.map((r) => r.left)),
        right: Math.max(...lastLine.map((r) => r.right)),
        top: Math.min(...lastLine.map((r) => r.top)),
        bottom: lastBottom,
      };
      const iconRect = await settledIconRect(page);
      const below = iconRect.top - line.bottom;
      const above = line.top - iconRect.bottom;
      expect((below >= 0 && below <= 12) || (above >= 0 && above <= 12),
        JSON.stringify({ iconRect, line, rects: sel.rects })).toBe(true);
      expectInViewport(iconRect);
      for (const r of sel.rects) expect(intersects(iconRect, r)).toBe(false);

      await icon(page).click();
      await expect(cardText(page)).toContainText('[T]');
      await expect(icon(page)).toHaveCount(0);
      const cardRect = await rectOf(card(page));
      expectInViewport(cardRect);
      for (const r of sel.rects) expect(intersects(cardRect, r)).toBe(false);
      await expect(engineTag(page)).toHaveText(en('cardEngineAi'));

      // Retranslate goes back to the engine: one more request reaches the API.
      await expect(retranslateBtn(page)).toBeEnabled();
      const beforeRetranslate = mock.sentTexts.length;
      await retranslateBtn(page).click();
      await expect.poll(() => mock.sentTexts.length).toBe(beforeRetranslate + 1);
      await expect(cardText(page)).toContainText('[T]');
      await expect(retranslateBtn(page)).toBeEnabled();

      // Switch to the built-in engine (stub): no API request, '[B] ' answer.
      await expect(switchBtn(page)).toHaveText(en('cardUseBuiltin'));
      const beforeBuiltin = mock.sentTexts.length;
      await switchBtn(page).click();
      await expect(cardText(page)).toHaveText(/^\[B\] /);
      await expect(engineTag(page)).toHaveText(en('cardEngineBuiltin'));
      expect(mock.sentTexts.length).toBe(beforeBuiltin);

      // And back to the AI engine: one more request.
      await expect(switchBtn(page)).toHaveText(en('cardUseAi'));
      await switchBtn(page).click();
      await expect.poll(() => mock.sentTexts.length).toBe(beforeBuiltin + 1);
      await expect(cardText(page)).toContainText('[T]');
      await expect(engineTag(page)).toHaveText(en('cardEngineAi'));

      await copyBtn(page).click();
      await expect(copyBtn(page)).toHaveText(en('copied'));
      // A second click while "Copied" shows must not leave it there: copy
      // feedback used to save the button's HTML at click time, so the second
      // click saved "Copied" as the thing to go back to. Read once after both
      // timers are due — polling would pass on the moment the first click's
      // timer briefly puts "Copy" back.
      await copyBtn(page).click();
      await page.waitForTimeout(2000);
      expect((await copyBtn(page).textContent()).trim()).toBe(en('copy'));
      await expect(page.locator('.ai-translator-popup .ai-translator-speak-translation')).toBeVisible();

      // Switch engine follows the card's target language: the built-in engine
      // cannot translate into fa, so an AI answer in fa offers no switch; fr it
      // can, so the offer comes back. The stub answers any language — the gate
      // is the engine's language list, not the model.
      const pickTarget = async (lang) => {
        await page.locator('.ai-translator-popup .ai-translator-lang-trigger').click();
        await page.locator(`.ai-translator-popup .ai-translator-lang-item[data-lang="${lang}"]`).click();
        await expect(cardText(page)).toHaveAttribute('lang', lang);
        await expect(cardText(page)).toContainText('[T]');
        await expect(engineTag(page)).toHaveText(en('cardEngineAi'));
      };
      await pickTarget('fa');
      await page.waitForTimeout(SETTLE_MS);
      await expect(switchBtn(page)).toBeHidden();
      await pickTarget('fr');
      await expect(switchBtn(page)).toBeVisible();
      await expect(switchBtn(page)).toHaveText(en('cardUseBuiltin'));
    } finally {
      await mock.close();
    }
  });

  test('J-D2: a failed request shows on the card, and retranslate recovers', async ({ page, context }) => {
    const mock = await startMockOpenAIServer({ failRequests: 1 });
    try {
      await servePages(context);
      await setExtensionSettings(page, aiSettings(mock.endpoint));
      await openPage(page);

      await dragSelect(page, '#lead');
      await icon(page).click();
      await expect(cardError(page)).toBeVisible();
      await expect(cardError(page)).not.toHaveText('');
      await expect(cardText(page)).toHaveCount(1);
      await expect(cardText(page)).not.toContainText('[T]');

      await expect(retranslateBtn(page)).toBeEnabled();
      await retranslateBtn(page).click();
      await expect(cardText(page)).toContainText('[T]');
      await expect(cardText(page)).toBeVisible();
      await expect(cardError(page)).toBeHidden();
    } finally {
      await mock.close();
    }
  });

  test('J-D3: context-menu errors wait first, then paint as errors in both modes', async ({ page, context }) => {
    // Requests are held until release(), then answered 500 — the card must be
    // seen in its waiting state before the error arrives.
    const held = [];
    let holding = true;
    let received = 0;
    const { origin, close } = await startMockServer((req, res) => {
      if (req.method !== 'POST') { res.writeHead(404); res.end(); return; }
      req.resume();
      req.on('end', () => {
        received += 1;
        const answer = () => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'mock: upstream down' } }));
        };
        if (holding) held.push(answer); else answer();
      });
    });
    const release = () => { holding = false; held.splice(0).forEach((answer) => answer()); };
    const endpoint = `${origin}/v1/chat/completions`;
    try {
      await servePages(context);

      // Card mode.
      await setExtensionSettings(page, aiSettings(endpoint, { selectionTrigger: 'modifier' }));
      await openPage(page);
      await dragSelect(page, '#lead');
      const { text } = await selectionGeometry(page);
      await sendMessageToActiveTab(page, { type: 'TRANSLATE_SELECTION_TEXT', text });
      await expect(card(page)).toBeVisible();
      await expect(page.locator('.ai-translator-popup .ai-translator-loading')).toBeVisible();
      await expect(cardError(page)).toBeHidden();
      await expect.poll(() => received).toBeGreaterThan(0);
      release();
      await expect(cardError(page)).toBeVisible();
      await expect(cardError(page)).not.toHaveText('');
      await expect(page.locator('.ai-translator-popup .ai-translator-loading')).toBeHidden();
      await expect(cardText(page)).toHaveText('');

      // Inline mode.
      holding = true;
      received = 0;
      await setExtensionSettings(page, aiSettings(endpoint, {
        selectionTrigger: 'modifier', selectionTranslationMode: 'inline',
      }));
      await openPage(page);
      await dragSelect(page, '#lead');
      const inline = await selectionGeometry(page);
      await sendMessageToActiveTab(page, { type: 'TRANSLATE_SELECTION_TEXT', text: inline.text });
      await expect.poll(() => received).toBeGreaterThan(0);
      await expect(page.locator('.ai-translator-selection-translation.ai-translator-error')).toHaveCount(0);
      release();
      const inlineError = page.locator('.ai-translator-selection-translation.ai-translator-error');
      await expect(inlineError).toBeVisible();
      await expect(inlineError).not.toHaveText('');
      await expect(card(page)).toHaveCount(0);
    } finally {
      await close();
    }
  });

  test('J-D4: trigger "modifier" shows no icon, the modifier still translates', async ({ page, context }) => {
    const mock = await startMockOpenAIServer();
    try {
      await servePages(context);
      await setExtensionSettings(page, aiSettings(mock.endpoint, { selectionTrigger: 'modifier' }));
      await openPage(page);

      await dragSelect(page, '#lead');
      await page.waitForTimeout(SETTLE_MS);
      await expect(page.locator('#ai-translator-selection-btn')).toHaveCount(0);

      await triggerSelectionHotkey(page);
      await expect(cardText(page)).toContainText('[T]');
      expect(mock.sentTexts.length).toBe(1);
    } finally {
      await mock.close();
    }
  });

  test('J-D5: trigger "icon" ignores the modifier, the icon still translates', async ({ page, context }) => {
    const mock = await startMockOpenAIServer();
    try {
      await servePages(context);
      await setExtensionSettings(page, aiSettings(mock.endpoint, { selectionTrigger: 'icon' }));
      await openPage(page);

      await dragSelect(page, '#lead');
      await expect(icon(page)).toBeVisible();
      await triggerSelectionHotkey(page);
      await page.waitForTimeout(SETTLE_MS);
      expect(mock.sentTexts.length).toBe(0);
      await expect(card(page)).toHaveCount(0);
      await expect(page.locator('.ai-translator-selection-translation')).toHaveCount(0);

      await icon(page).click();
      await expect(cardText(page)).toContainText('[T]');
      expect(mock.sentTexts.length).toBe(1);
    } finally {
      await mock.close();
    }
  });

  test('J-D6: options page greys the selection controls and reverts hotkey conflicts', async ({ page, context, extensionId }) => {
    await setExtensionSettings(page, {
      enableSelection: true,
      selectionTrigger: 'both',
      selectionTranslationMode: 'popup',
      selectionTranslationHotkey: 'Alt',
      enableHoverTranslation: true,
      hoverTranslationHotkey: 'Shift',
    });
    await page.goto(`chrome-extension://${extensionId}/options/options.html`);

    const trigger = page.locator('#selectionTrigger');
    const mode = page.locator('#selectionTranslationMode');
    const hotkey = page.locator('#selectionTranslationHotkey');
    const hoverHotkey = page.locator('#hoverTranslationHotkey');
    const selectionToggle = page.locator('label:has(#enableSelection)');
    const status = page.locator('#statusMessage');

    // Selection on, trigger "both": all three live.
    await expect(trigger).toBeEnabled();
    await expect(mode).toBeEnabled();
    await expect(hotkey).toBeEnabled();

    // Trigger "icon": only the hotkey greys (the mode still serves the float
    // ball and the context menu).
    await trigger.selectOption('icon');
    await expect(hotkey).toBeDisabled();
    await expect(trigger).toBeEnabled();
    await expect(mode).toBeEnabled();
    await expect.poll(async () => (await getSyncSettings(context, ['selectionTrigger'])).selectionTrigger).toBe('icon');

    // Selection off: all three grey.
    await selectionToggle.click();
    await expect(trigger).toBeDisabled();
    await expect(mode).toBeDisabled();
    await expect(hotkey).toBeDisabled();
    await expect.poll(async () => (await getSyncSettings(context, ['enableSelection'])).enableSelection).toBe(false);

    // Back on, still "icon": trigger and mode live, hotkey grey.
    await selectionToggle.click();
    await expect(trigger).toBeEnabled();
    await expect(mode).toBeEnabled();
    await expect(hotkey).toBeDisabled();

    // Under "icon" the selection hotkey is not in use, so equal hotkeys are allowed.
    await hoverHotkey.selectOption('Alt');
    await expect.poll(async () => (await getSyncSettings(context, ['hoverTranslationHotkey'])).hoverTranslationHotkey).toBe('Alt');
    await expect(status).not.toContainText(en('hotkeyConflict'));

    // Conflict by changing the trigger: "icon" -> "both" with equal hotkeys snaps back.
    await trigger.selectOption('both');
    await expect(status).toContainText(en('hotkeyConflict'));
    await expect(trigger).toHaveValue('icon');
    await expect(hotkey).toBeDisabled();
    expect((await getSyncSettings(context, ['selectionTrigger'])).selectionTrigger).toBe('icon');

    // Conflict by changing a hotkey: with trigger "modifier", picking the hover
    // hotkey for selection snaps back.
    await hoverHotkey.selectOption('Shift');
    await expect.poll(async () => (await getSyncSettings(context, ['hoverTranslationHotkey'])).hoverTranslationHotkey).toBe('Shift');
    await trigger.selectOption('modifier');
    await expect.poll(async () => (await getSyncSettings(context, ['selectionTrigger'])).selectionTrigger).toBe('modifier');
    await expect(hotkey).toBeEnabled();
    await hotkey.selectOption('Shift');
    await expect(hotkey).toHaveValue('Alt');
    await expect(status).toContainText(en('hotkeyConflict'));
    expect((await getSyncSettings(context, ['selectionTranslationHotkey'])).selectionTranslationHotkey).toBe('Alt');
  });

  test('J-D7: the icon goes away on scroll, Esc, a press outside and a cleared selection', async ({ page, context }) => {
    const mock = await startMockOpenAIServer();
    try {
      await servePages(context);
      await setExtensionSettings(page, aiSettings(mock.endpoint));
      await openPage(page);
      const btn = page.locator('#ai-translator-selection-btn');

      await dragSelect(page, '#lead');
      await expect(icon(page)).toBeVisible();
      await page.mouse.move(900, 300);
      await page.mouse.wheel(0, 200);
      await expect(btn).toHaveCount(0);

      await page.evaluate(() => window.scrollTo(0, 0));
      await reselect(page, '#lead');
      await expect(icon(page)).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(btn).toHaveCount(0);

      await reselect(page, '#lead');
      await expect(icon(page)).toBeVisible();
      await page.mouse.move(1100, 600);
      await page.mouse.down();
      await expect(btn).toHaveCount(0);
      await page.mouse.up();

      await reselect(page, '#lead');
      await expect(icon(page)).toBeVisible();
      await page.evaluate(() => window.getSelection().removeAllRanges());
      await expect(btn).toHaveCount(0);

      expect(mock.sentTexts.length).toBe(0);
    } finally {
      await mock.close();
    }
  });

  test('J-D8: selecting inside input, textarea and contenteditable shows no icon', async ({ page, context }) => {
    const mock = await startMockOpenAIServer();
    try {
      await servePages(context);
      await setExtensionSettings(page, aiSettings(mock.endpoint));
      await openPage(page);
      const btn = page.locator('#ai-translator-selection-btn');

      for (const selector of ['#field', '#area']) {
        const box = await page.locator(selector).boundingBox();
        await drag(page, { x: box.x + 4, y: box.y + 12 }, { x: box.x + box.width - 4, y: box.y + 12 });
        const selected = await page.locator(selector).evaluate((el) => el.selectionEnd - el.selectionStart);
        expect(selected).toBeGreaterThan(1);
        await page.waitForTimeout(SETTLE_MS);
        await expect(btn).toHaveCount(0);
      }

      const box = await page.locator('#editable').boundingBox();
      await drag(page, { x: box.x + 4, y: box.y + box.height / 2 }, { x: box.x + box.width - 4, y: box.y + box.height / 2 });
      const selected = await page.evaluate(() => window.getSelection().toString().trim().length);
      expect(selected).toBeGreaterThan(1);
      await page.waitForTimeout(SETTLE_MS);
      await expect(btn).toHaveCount(0);
    } finally {
      await mock.close();
    }
  });

  test('J-D9: the action row fits the card and stays put when a label changes, in all ten interface languages', async ({ page, context }) => {
    test.setTimeout(300_000);
    const mock = await startMockOpenAIServer();
    try {
      await servePages(context);
      for (const lang of UI_LANGUAGES) {
        await setExtensionSettings(page, aiSettings(mock.endpoint, { uiLanguage: lang }));
        await openPage(page);
        await stubBuiltinTranslator(page);
        await dragSelect(page, '#lead');
        await icon(page).click();
        await expect(cardText(page)).toContainText('[T]');
        await expect(retranslateBtn(page)).toBeVisible();
        await expect(switchBtn(page)).toHaveText(getMessage('cardUseBuiltin', lang));

        const layout = await page.evaluate(() => {
          const plain = (r) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
          const popup = document.querySelector('.ai-translator-popup');
          const row = popup.querySelector('.ai-translator-actions');
          const buttons = Array.from(row.querySelectorAll('button'))
            .filter((b) => !b.hidden && b.offsetParent)
            .map((b) => ({ cls: b.className, rect: plain(b.getBoundingClientRect()) }));
          return {
            card: plain(popup.getBoundingClientRect()),
            row: plain(row.getBoundingClientRect()),
            rowScroll: row.scrollWidth - row.clientWidth,
            buttons,
          };
        });
        expect(layout.buttons.length, lang).toBeGreaterThanOrEqual(3);
        expect(layout.rowScroll, lang).toBeLessThanOrEqual(0);
        for (const { cls, rect } of layout.buttons) {
          const where = `${lang} ${cls}`;
          expect(rect.left, where).toBeGreaterThanOrEqual(layout.row.left - 0.5);
          expect(rect.right, where).toBeLessThanOrEqual(layout.row.right + 0.5);
          expect(rect.left, where).toBeGreaterThanOrEqual(layout.card.left - 0.5);
          expect(rect.right, where).toBeLessThanOrEqual(layout.card.right + 0.5);
          expect(rect.top, where).toBeGreaterThanOrEqual(layout.card.top - 0.5);
          expect(rect.bottom, where).toBeLessThanOrEqual(layout.card.bottom + 0.5);
        }

        // A label that changes must not move anything under the pointer. The
        // row wraps, so a button whose width followed its label ("Use Chrome
        // built-in" / "Use my AI model", "Copy" / "Copied") reflowed the row
        // and put a different button under the mouse that had just clicked.
        const before = await actionRow(page);
        await page.evaluate(() => {
          window.__rowHides = [];
          const row = document.querySelector('.ai-translator-popup .ai-translator-actions');
          new MutationObserver((records) => {
            for (const r of records) if (r.oldValue === null) window.__rowHides.push(r.target.className);
          }).observe(row, { subtree: true, attributes: true, attributeFilter: ['hidden'], attributeOldValue: true });
        });
        await switchBtn(page).click();
        await expect(engineTag(page)).toHaveText(getMessage('cardEngineBuiltin', lang));
        await expect(switchBtn(page)).toHaveText(getMessage('cardUseAi', lang));
        await expect(switchBtn(page)).toBeEnabled();
        const switched = await actionRow(page);
        expectRowUnchanged(switched, before, `${lang} after switching engine`);
        // Nor may a button blink out while the answer comes back.
        expect(await page.evaluate(() => window.__rowHides), lang).toEqual([]);
        // Where the switch was clicked is still the switch.
        const sw = before.buttons.find((b) => b.cls.includes('ai-translator-switch-engine'));
        const under = await page.evaluate(
          ({ x, y }) => document.elementFromPoint(x, y)?.closest('button')?.className ?? null,
          { x: switched.origin.x + sw.left + sw.width / 2, y: switched.origin.y + sw.top + sw.height / 2 });
        expect(under, lang).toContain('ai-translator-switch-engine');

        await copyBtn(page).click();
        await expect(copyBtn(page)).toHaveText(getMessage('copied', lang));
        const copied = await actionRow(page);
        // Measured while "Copied" still shows (it goes back after 1.5 s).
        expect(copied.buttons.find((b) => b.cls.includes('ai-translator-copy')).text, lang)
          .toBe(getMessage('copied', lang));
        expectRowUnchanged(copied, before, `${lang} after copy`);
        await page.keyboard.press('Escape');
      }
    } finally {
      await mock.close();
    }
  });

  test('J-D10: near the bottom the card goes above; a long selection shrinks it and scrolls inside', async ({ page, context }) => {
    const mock = await startMockOpenAIServer();
    try {
      await servePages(context);
      await setExtensionSettings(page, aiSettings(mock.endpoint));
      await openPage(page);

      await page.evaluate(() => {
        const r = document.getElementById('low').getBoundingClientRect();
        window.scrollBy(0, r.bottom - 705);
      });
      await dragSelect(page, '#low');
      await expect(icon(page)).toBeVisible();
      const low = await selectionGeometry(page);
      expect(low.box.bottom).toBeGreaterThan(690);
      await icon(page).click();
      await expect(cardText(page)).toContainText('[T]');
      const lowCard = await rectOf(card(page));
      expect(lowCard.bottom).toBeLessThanOrEqual(low.box.top + 0.5);
      expectInViewport(lowCard);
      await page.keyboard.press('Escape');

      await openPage(page, '/long');
      const box = await page.locator('#long').boundingBox();
      await drag(page, { x: box.x + 2, y: 250 }, { x: box.x + 300, y: 500 });
      await expect(icon(page)).toBeVisible();
      const long = await selectionGeometry(page);
      await icon(page).click();
      await expect(cardText(page)).toContainText('[T]');
      const shrunk = await page.evaluate(() => {
        const popup = document.querySelector('.ai-translator-popup');
        const content = popup.querySelector('.ai-translator-content');
        return {
          maxHeight: popup.style.maxHeight,
          scrolls: content.scrollHeight > content.clientHeight,
        };
      });
      expect(shrunk.maxHeight).not.toBe('');
      expect(shrunk.scrolls).toBe(true);
      const longCard = await rectOf(card(page));
      expectInViewport(longCard);
      expect(intersects(longCard, long.box)).toBe(false);
    } finally {
      await mock.close();
    }
  });
});
