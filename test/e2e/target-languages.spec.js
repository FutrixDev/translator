/**
 * 76 target languages (design 2026-09-24-p0-b-target-languages-rtl.md §2–§5,
 * §10.2).
 *
 *   J-B1  the settings page's pickers: 76 names computed by Intl in the UI
 *         language, sorted by its collation; a stored value outside the old
 *         ten survives a reload; switching the UI language renames without
 *         losing any selection
 *   J-B2  the settings page names a target the built-in engine cannot
 *         translate into, in the sentence the fallback setting calls for
 *   J-B8  the in-page language menu: 76 items, "AI only" tags drawn by CSS
 *         and never part of the label; opening it scrolls the selected
 *         language into the menu's view without scrolling the page
 *   J-B9  the selection card in an RTL target: the translation carries the
 *         target's lang and dir and its line starts at the right edge; the
 *         card's menu reveals the selected language; picking an LTR target
 *         turns the next translation back to the left edge
 *   J-B10 recently picked languages sit in a group above the full list (the
 *         journey design ext-opt-input-translation §B.3 calls "J-B9"; that
 *         name was taken by the RTL card above)
 *   J-L1  the recent group across the dialog and the selection card, its cap
 *         of five, a new default target, and the "AI only" tag (design
 *         ext-opt-input-translation §C.1, D-542)
 *
 * Expected names are always computed here, in the browser, with Intl — never
 * written out and never asked of the code under test. zh-CN / zh-TW are the
 * two stored codes Intl would name by region ("Chinese (China)"), so the
 * expectation names them through zh-Hans / zh-Hant, as the design says.
 */
const { test, expect } = require('./fixtures');
const { getMessage } = require('../../i18n/messages');
const { setExtensionSettings, getSyncSettings, openFloatBallMenu, waitForFloatBall } = require('./helpers');
const { startMockServer } = require('./mock-server');
const { startMockOpenAIServer } = require('./mock-openai-server');

const SCRIPT_TAGS = { 'zh-CN': 'zh-Hans', 'zh-TW': 'zh-Hant' };

/**
 * [value, text] for every option (the empty "follow" row left out) next to the
 * name Intl gives that value in `uiLang`, with a lower-case first letter
 * raised — the menu form the design asks for (§2.5).
 */
function namesOf(page, selector, uiLang) {
  return page.evaluate(({ selector, uiLang, scriptTags }) => {
    const intl = new Intl.DisplayNames([uiLang], { type: 'language' });
    const menuForm = (name) => name.charAt(0).toLocaleUpperCase(uiLang) + name.slice(1);
    return [...document.querySelectorAll(selector)]
      .map((el) => ({ value: el.tagName === 'OPTION' ? el.value : el.dataset.lang, text: el.textContent }))
      .filter(({ value }) => value !== '')
      .map(({ value, text }) => ({ value, text, want: menuForm(intl.of(scriptTags[value] || value)) }));
  }, { selector, uiLang, scriptTags: SCRIPT_TAGS });
}

function isCollated(page, texts, uiLang) {
  return page.evaluate(({ texts, uiLang }) => {
    const collator = new Intl.Collator(uiLang);
    return texts.every((text, i) => i === 0 || collator.compare(texts[i - 1], text) <= 0);
  }, { texts, uiLang });
}

async function expectIntlNames(page, selector, uiLang, count) {
  const names = await namesOf(page, selector, uiLang);
  expect(names).toHaveLength(count);
  expect(new Set(names.map((n) => n.value)).size).toBe(count);
  for (const { value, text, want } of names) expect(text, value).toBe(want);
  expect(await isCollated(page, names.map((n) => n.text), uiLang)).toBe(true);
  return names;
}

/**
 * The open menu shows its selected item inside its own visible box (±1 px),
 * got there by scrolling itself, and left the page where it was.
 */
async function expectSelectedRevealed(page, menu, scrollYBefore) {
  const view = await menu.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const top = box.top + el.clientTop;
    const item = el.querySelector('.is-selected').getBoundingClientRect();
    return {
      top, bottom: top + el.clientHeight, itemTop: item.top, itemBottom: item.bottom,
      scrollTop: el.scrollTop, lang: el.querySelector('.is-selected').dataset.lang,
    };
  });
  expect(view.itemTop, JSON.stringify(view)).toBeGreaterThanOrEqual(view.top - 1);
  expect(view.itemBottom, JSON.stringify(view)).toBeLessThanOrEqual(view.bottom + 1);
  expect(view.scrollTop, JSON.stringify(view)).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.scrollY)).toBe(scrollYBefore);
}

// A page taller than the viewport, scrolled a little: a menu that scrolled the
// page to reveal its item would show up as a changed scrollY.
const TALL = '<div style="height: 3000px"></div>';
const SCROLLED_Y = 120;

async function openOptions(page, extensionId) {
  await page.goto(`chrome-extension://${extensionId}/options/options.html`);
  await page.waitForSelector('#provider');
}

test('J-B1 the settings page lists 76 target languages by their Intl names and keeps every choice across a reload and a UI language switch', async ({ page, context, extensionId }) => {
  await setExtensionSettings(page, { targetLang: 'fa', comicTargetLang: 'ja', pdfTargetLang: 'de' });
  await openOptions(page, extensionId);

  // A value the html never had an <option> for is still selected after load.
  await expect(page.locator('#targetLang')).toHaveValue('fa');
  await page.reload();
  await page.waitForSelector('#provider');
  await expect(page.locator('#targetLang')).toHaveValue('fa');

  const names = await expectIntlNames(page, '#targetLang option', 'en', 76);
  for (const code of ['ar', 'fa', 'he', 'ur', 'zh-CN', 'zh-TW', 'zu']) {
    expect(names.map((n) => n.value)).toContain(code);
  }
  await expectIntlNames(page, '#comicTargetLang option', 'en', 10);
  await expectIntlNames(page, '#pdfTargetLang option', 'en', 10);
  // 1 + 10: the "follow" row is still there.
  await expect(page.locator('#comicTargetLang option')).toHaveCount(11);
  await expect(page.locator('#pdfTargetLang option')).toHaveCount(11);
  // The UI language picker names each language in itself.
  const autonyms = await page.evaluate(({ scriptTags }) => [...document.querySelectorAll('#uiLanguage option')]
    .filter((o) => o.value !== '')
    .map((o) => {
      const tag = scriptTags[o.value] || o.value;
      const name = new Intl.DisplayNames([tag], { type: 'language' }).of(tag);
      return { text: o.textContent, want: name.charAt(0).toLocaleUpperCase(tag) + name.slice(1) };
    }), { scriptTags: SCRIPT_TAGS });
  expect(autonyms).toHaveLength(10);
  for (const { text, want } of autonyms) expect(text).toBe(want);

  // Switching the UI language renames everything and loses no selection.
  await page.selectOption('#uiLanguage', 'zh-CN');
  await expect(page.locator('label[for="targetLang"]')).toHaveText(getMessage('targetLanguage', 'zh-CN'));
  await expectIntlNames(page, '#targetLang option', 'zh-CN', 76);
  await expect(page.locator('#targetLang')).toHaveValue('fa');
  await expect(page.locator('#comicTargetLang')).toHaveValue('ja');
  await expect(page.locator('#pdfTargetLang')).toHaveValue('de');
  await expect(page.locator('#uiLanguage')).toHaveValue('zh-CN');
  const stored = await getSyncSettings(context, ['targetLang', 'comicTargetLang', 'pdfTargetLang']);
  expect(stored).toEqual({ targetLang: 'fa', comicTargetLang: 'ja', pdfTargetLang: 'de' });
});

test('J-B2 the settings page names a target the built-in engine cannot translate into', async ({ page, extensionId }) => {
  // e2e Chromium has no Translator API, so stub it in the settings page's own
  // world. 'downloadable' rather than 'available': it is the answer that shows
  // the download button, so "hidden for fa" is a real assertion.
  await page.addInitScript(() => {
    self.Translator = {
      availability: async () => 'downloadable',
      create: async () => ({ translate: async (text) => text, destroy() {} }),
    };
  });
  await setExtensionSettings(page, { translationEngine: 'builtin', engineFallback: 'local-only', targetLang: 'fr' });
  await openOptions(page, extensionId);

  const status = page.locator('#builtinStatus');
  const download = page.locator('#downloadLanguagePack');
  const faInSentence = await page.evaluate(() => new Intl.DisplayNames(['en'], { type: 'language' }).of('fa'));

  await expect(status).toHaveText(getMessage('builtinDownloadable', 'en'));
  await expect(download).toBeVisible();

  await page.selectOption('#targetLang', 'fa');
  await expect(status).toHaveText(getMessage('builtinTargetUnsupportedLocalOnly', 'en').replace('{lang}', faInSentence));
  await expect(download).toBeHidden();

  await page.selectOption('#targetLang', 'fr');
  await expect(status).toHaveText(getMessage('builtinDownloadable', 'en'));
  await expect(status).not.toContainText(faInSentence);

  await page.selectOption('#targetLang', 'fa');
  await page.selectOption('#engineFallback', 'allow-ai');
  await expect(status).toHaveText(getMessage('builtinTargetUnsupportedAllowAi', 'en').replace('{lang}', faInSentence));
  await expect(download).toBeHidden();
});

test('J-B8 the in-page language menu lists 76 languages and tags the AI-only ones outside their label', async ({ page }) => {
  const site = await startMockServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html><html lang="en"><body><p>A page with a language menu.</p>${TALL}</body></html>`);
  });
  try {
    await setExtensionSettings(page, {
      translationEngine: 'builtin',
      autoTranslateEngine: 'builtin',
      targetLang: 'fr',
      autoTranslate: false,
    });
    await page.goto(`${site.origin}/`);
    await page.waitForSelector('#ai-translator-float-ball');
    await page.evaluate((y) => window.scrollTo(0, y), SCROLLED_Y);
    await openFloatBallMenu(page);
    await page.click('.ai-translator-menu-item[data-action="translate-input"]');
    await page.waitForSelector('#ai-translator-input-dialog', { state: 'visible' });

    const dialog = page.locator('#ai-translator-input-dialog');
    const scrollYBefore = await page.evaluate(() => window.scrollY);
    expect(scrollYBefore).toBe(SCROLLED_Y);
    await dialog.locator('.ai-translator-lang-trigger').click();
    await expect(dialog.locator('.ai-translator-lang-menu')).toBeVisible();
    await expectSelectedRevealed(page, dialog.locator('.ai-translator-lang-menu'), scrollYBefore);
    await expect(dialog.locator('.ai-translator-lang-item.is-selected')).toHaveAttribute('data-lang', 'fr');

    const items = await expectIntlNames(page, '#ai-translator-input-dialog .ai-translator-lang-item', 'en', 76);
    expect(items.map((i) => i.value)).toContain('fa');

    const tag = getMessage('langAiOnly', 'en');
    const fa = dialog.locator('.ai-translator-lang-item[data-lang="fa"]');
    const fr = dialog.locator('.ai-translator-lang-item[data-lang="fr"]');
    await expect(fa).toHaveAttribute('data-tag', tag);
    expect(await fa.evaluate((el) => getComputedStyle(el, '::after').content)).toBe(JSON.stringify(tag));
    expect(await fr.getAttribute('data-tag')).toBeNull();
    expect(await fr.evaluate((el) => getComputedStyle(el, '::after').content)).toBe('none');

    const overflowing = await dialog.locator('.ai-translator-lang-item').evaluateAll(
      (els) => els.filter((el) => el.scrollWidth > el.clientWidth).map((el) => el.dataset.lang),
    );
    expect(overflowing).toEqual([]);

    const faName = items.find((i) => i.value === 'fa').want;
    await fa.click();
    await expect(dialog.locator('.ai-translator-lang-label')).toHaveText(faName);
  } finally {
    await site.close();
  }
});

/**
 * The translation element's content box and its first line (every client rect
 * of its text that shares the first rect's top — bidi may split one line into
 * runs), once the card's pop-in and the text's flow animation have finished.
 */
async function firstLineGeometry(locator) {
  await locator.evaluate((el) => Promise.all(
    el.closest('.ai-translator-popup').getAnimations({ subtree: true }).map((a) => a.finished),
  ));
  return locator.evaluate((el) => {
    const cs = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    const px = (v) => parseFloat(v) || 0;
    const contentLeft = box.left + px(cs.borderLeftWidth) + px(cs.paddingLeft);
    const contentRight = box.right - px(cs.borderRightWidth) - px(cs.paddingRight);
    const range = document.createRange();
    range.selectNodeContents(el);
    const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
    const line = rects.filter((r) => Math.abs(r.top - rects[0].top) < 1);
    const tops = new Set(rects.map((r) => Math.round(r.top)));
    return {
      contentLeft,
      contentRight,
      left: Math.min(...line.map((r) => r.left)),
      right: Math.max(...line.map((r) => r.right)),
      lines: tops.size,
    };
  });
}

test('J-B9 the selection card lays an RTL translation out from the right and an LTR one from the left', async ({ page }) => {
  const mock = await startMockOpenAIServer();
  const site = await startMockServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html><html lang="en" dir="ltr"><head><style>
      body { margin: 0; padding: 300px 60px 40px; font: 18px/28px Georgia, serif; text-align: left; }
    </style></head><body><p><span id="phrase">Tide table</span> for the harbour.</p>${TALL}</body></html>`);
  });
  try {
    await setExtensionSettings(page, {
      provider: 'custom',
      apiEndpoint: mock.endpoint,
      apiKey: 'test-key',
      modelName: 'gpt-4.1-mini',
      translationEngine: 'ai',
      targetLang: 'he',
      enableSelection: true,
      selectionTrigger: 'icon',
      selectionTranslationMode: 'popup',
      autoTranslate: false,
    });
    await page.goto(`${site.origin}/`);
    await waitForFloatBall(page);
    await page.evaluate((y) => window.scrollTo(0, y), SCROLLED_Y);

    // A real drag across the two words, then the selection icon.
    const phrase = await page.locator('#phrase').boundingBox();
    const y = phrase.y + phrase.height / 2;
    await page.mouse.move(phrase.x + 1, y);
    await page.mouse.down();
    await page.mouse.move(phrase.x + phrase.width - 1, y, { steps: 10 });
    await page.mouse.up();
    expect(await page.evaluate(() => window.getSelection().toString())).toBe('Tide table');
    await page.locator('#ai-translator-selection-btn .ai-translator-selection-icon').click();

    const card = page.locator('.ai-translator-popup');
    const text = card.locator('.ai-translator-translation-text');
    await expect(text).toHaveText('[T] Tide table');
    await expect(text).toHaveAttribute('lang', 'he');
    await expect(text).toHaveAttribute('dir', 'rtl');

    const rtl = await firstLineGeometry(text);
    expect(rtl.lines, JSON.stringify(rtl)).toBe(1);
    expect(Math.abs(rtl.right - rtl.contentRight), JSON.stringify(rtl)).toBeLessThanOrEqual(1);
    expect(rtl.left - rtl.contentLeft, JSON.stringify(rtl)).toBeGreaterThan(10);

    const cardBox = await card.boundingBox();
    const viewport = page.viewportSize();
    expect(cardBox.x).toBeGreaterThanOrEqual(0);
    expect(cardBox.y).toBeGreaterThanOrEqual(0);
    expect(cardBox.x + cardBox.width).toBeLessThanOrEqual(viewport.width);
    expect(cardBox.y + cardBox.height).toBeLessThanOrEqual(viewport.height);

    // The card's own menu: the selected language (he) in view, the page still.
    const scrollYBefore = await page.evaluate(() => window.scrollY);
    expect(scrollYBefore).toBe(SCROLLED_Y);
    await card.locator('.ai-translator-lang-trigger').click();
    const menu = card.locator('.ai-translator-lang-menu');
    await expect(menu).toBeVisible();
    await expect(menu.locator('.is-selected')).toHaveAttribute('data-lang', 'he');
    await expectSelectedRevealed(page, menu, scrollYBefore);

    // An LTR target: the next translation carries en / ltr and starts at the left.
    const names = await namesOf(page, '.ai-translator-popup .ai-translator-lang-item', 'en');
    await menu.locator('.ai-translator-lang-item[data-lang="en"]').click();
    await expect(card.locator('.ai-translator-lang-label')).toHaveText(names.find((n) => n.value === 'en').want);
    await expect.poll(() => mock.sentTexts.length).toBe(2);
    await expect(text).toHaveAttribute('lang', 'en');
    await expect(text).toHaveAttribute('dir', 'ltr');
    await expect(text).toHaveText('[T] Tide table');

    const ltr = await firstLineGeometry(text);
    expect(ltr.lines, JSON.stringify(ltr)).toBe(1);
    expect(Math.abs(ltr.left - ltr.contentLeft), JSON.stringify(ltr)).toBeLessThanOrEqual(1);
  } finally {
    await site.close();
    await mock.close();
  }
});

// ---------------------------------------------------------------------------
// Recently picked target languages (design ext-opt-input-translation §B, D-542).
// Every Playwright test starts with an empty chrome.storage.local, so the list
// starts empty here too, which is also why J-B8 above still sees a flat 76.

const RECENT_PAGE = `<!doctype html><html lang="en"><head><style>
  body { margin: 0; padding: 300px 60px 40px; font: 18px/28px Georgia, serif; }
</style></head><body><p><span id="phrase">Tide table</span> for the harbour.</p>${TALL}</body></html>`;

/** What the open menu shows: its group headers, its recent items, and the rest. */
function menuParts(menu) {
  return menu.evaluate((el) => ({
    groups: [...el.querySelectorAll('.ai-translator-lang-group')].map((g) => g.textContent),
    firstIsGroup: !!el.firstElementChild?.matches('.ai-translator-lang-group'),
    recent: [...el.querySelectorAll('.ai-translator-lang-item[data-recent]')].map((i) => i.dataset.lang),
    full: el.querySelectorAll('.ai-translator-lang-item:not([data-recent])').length,
    selected: [...el.querySelectorAll('.is-selected')].map((i) => [i.dataset.lang, i.hasAttribute('data-recent')]),
  }));
}

/** The first selected item is inside the open menu's visible box, and the page did not move. */
async function expectFirstSelectedInView(page, menu, scrollYBefore) {
  const view = await menu.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const top = box.top + el.clientTop;
    const item = el.querySelector('.is-selected').getBoundingClientRect();
    return { top, bottom: top + el.clientHeight, itemTop: item.top, itemBottom: item.bottom };
  });
  expect(view.itemTop, JSON.stringify(view)).toBeGreaterThanOrEqual(view.top - 1);
  expect(view.itemBottom, JSON.stringify(view)).toBeLessThanOrEqual(view.bottom + 1);
  expect(await page.evaluate(() => window.scrollY)).toBe(scrollYBefore);
}

async function openDialogMenu(page) {
  const dialog = page.locator('#ai-translator-input-dialog');
  if (!(await dialog.count())) {
    await openFloatBallMenu(page);
    await page.click('.ai-translator-menu-item[data-action="translate-input"]');
    await page.waitForSelector('#ai-translator-input-dialog', { state: 'visible' });
  }
  await dialog.locator('.ai-translator-lang-trigger').click();
  const menu = dialog.locator('.ai-translator-lang-menu');
  await expect(menu).toBeVisible();
  return menu;
}

/** Pick `lang` from the dialog's menu, from the full list (a recent copy may be there too). */
async function pickInDialog(page, lang) {
  const menu = await openDialogMenu(page);
  await menu.locator(`.ai-translator-lang-item[data-lang="${lang}"]:not([data-recent])`).click();
  await expect(menu).toBeHidden();
}

async function closeDialog(page) {
  await page.click('#ai-translator-input-dialog .ai-translator-close');
  await expect(page.locator('#ai-translator-input-dialog')).toHaveCount(0);
}

test('J-B10 the languages picked last sit in a group above the full list, which keeps all 76', async ({ page }) => {
  const site = await startMockServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(RECENT_PAGE);
  });
  try {
    await setExtensionSettings(page, { targetLang: 'zh-CN', autoTranslate: false });
    await page.goto(`${site.origin}/`);
    await waitForFloatBall(page);

    await pickInDialog(page, 'fr');
    await pickInDialog(page, 'de');
    const menu = await openDialogMenu(page);
    const parts = await menuParts(menu);
    expect(parts.recent).toEqual(['de', 'fr']);
    expect(parts.groups).toEqual([getMessage('langRecent', 'en'), getMessage('langAll', 'en')]);
    expect(parts.firstIsGroup).toBe(true);
    await expect(menu.locator('.ai-translator-lang-item[data-recent]')).toHaveCount(2);
    // The full list is untouched: 76, Intl names, collated, the recent ones still in it.
    await expectIntlNames(page, '#ai-translator-input-dialog .ai-translator-lang-item:not([data-recent])', 'en', 76);
    // Both copies of the selected language are selected, the recent one first.
    expect(parts.selected).toEqual([['de', true], ['de', false]]);
    await expect(menu.locator('.ai-translator-lang-item[data-lang="de"]')).toHaveCount(2);
  } finally {
    await site.close();
  }
});

test('J-L1 the recent group: shared by the dialog and the card, five at most, kept across a new default, tagged like the full list', async ({ page }) => {
  const mock = await startMockOpenAIServer();
  const site = await startMockServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(RECENT_PAGE);
  });
  try {
    await setExtensionSettings(page, {
      provider: 'custom',
      apiEndpoint: mock.endpoint,
      apiKey: 'test-key',
      modelName: 'gpt-4.1-mini',
      translationEngine: 'ai',
      targetLang: 'zh-CN',
      enableSelection: true,
      selectionTrigger: 'icon',
      selectionTranslationMode: 'popup',
      autoTranslate: false,
    });
    await page.goto(`${site.origin}/`);
    await waitForFloatBall(page);
    await page.evaluate((y) => window.scrollTo(0, y), SCROLLED_Y);

    // 1. Nothing picked yet: the flat list, as J-B8 sees it.
    let menu = await openDialogMenu(page);
    expect(await menuParts(menu)).toMatchObject({ groups: [], recent: [], full: 76 });
    await page.keyboard.press('Escape'); // Escape closes the whole dialog
    await expect(page.locator('#ai-translator-input-dialog')).toHaveCount(0);

    // 2. Pick fr with something typed: the translation follows.
    await openFloatBallMenu(page);
    await page.click('.ai-translator-menu-item[data-action="translate-input"]');
    await page.fill('#ai-translator-input-text', 'a full sentence for translation');
    await pickInDialog(page, 'fr');
    const result = page.locator('#ai-translator-result-text');
    await expect(result).toHaveText('[T] a full sentence for translation');
    await expect(result).toHaveAttribute('lang', 'fr');

    // 3. Closed and opened again: fr heads the menu, selected and in view, then all 76.
    await closeDialog(page);
    const scrollYBefore = await page.evaluate(() => window.scrollY);
    menu = await openDialogMenu(page);
    let parts = await menuParts(menu);
    expect(parts).toMatchObject({
      groups: [getMessage('langRecent', 'en'), getMessage('langAll', 'en')], firstIsGroup: true, recent: ['fr'], full: 76,
    });
    expect(parts.selected[0]).toEqual(['fr', true]);
    await expectFirstSelectedInView(page, menu, scrollYBefore);
    await closeDialog(page);

    // 4. The selection card's menu draws the same group.
    const phrase = await page.locator('#phrase').boundingBox();
    const y = phrase.y + phrase.height / 2;
    await page.mouse.move(phrase.x + 1, y);
    await page.mouse.down();
    await page.mouse.move(phrase.x + phrase.width - 1, y, { steps: 10 });
    await page.mouse.up();
    await page.locator('#ai-translator-selection-btn .ai-translator-selection-icon').click();
    const card = page.locator('.ai-translator-popup');
    await expect(card.locator('.ai-translator-translation-text')).toContainText('[T]');
    await card.locator('.ai-translator-lang-trigger').click();
    const cardMenu = card.locator('.ai-translator-lang-menu');
    await expect(cardMenu).toBeVisible();
    expect(await menuParts(cardMenu)).toMatchObject({ recent: ['fr'], firstIsGroup: true, full: 76 });
    await page.keyboard.press('Escape');
    await page.mouse.click(5, 5);
    await expect(card).toHaveCount(0);

    // 5. Six more picks: five kept, newest first, de pushed out.
    for (const lang of ['de', 'ja', 'ko', 'ru', 'es', 'fr']) await pickInDialog(page, lang);
    menu = await openDialogMenu(page);
    expect((await menuParts(menu)).recent).toEqual(['fr', 'es', 'ru', 'ko', 'ja']);
    await closeDialog(page);

    // 6. A new default target on the settings side leaves the habit alone.
    await setExtensionSettings(page, { targetLang: 'en' });
    menu = await openDialogMenu(page);
    await expect(page.locator('#ai-translator-input-dialog .ai-translator-lang-label')).toHaveText(
      await page.evaluate(() => new Intl.DisplayNames(['en'], { type: 'language' }).of('en')));
    expect((await menuParts(menu)).recent).toEqual(['fr', 'es', 'ru', 'ko', 'ja']);
    await closeDialog(page);

    // 7. With the built-in engine chosen, a recent language it cannot translate into carries the tag.
    await setExtensionSettings(page, { translationEngine: 'builtin' });
    await pickInDialog(page, 'fa');
    menu = await openDialogMenu(page);
    const tag = getMessage('langAiOnly', 'en');
    expect((await menuParts(menu)).recent).toEqual(['fa', 'fr', 'es', 'ru', 'ko']);
    await expect(menu.locator('.ai-translator-lang-item[data-recent][data-lang="fa"]')).toHaveAttribute('data-tag', tag);
    expect(await menu.locator('.ai-translator-lang-item[data-recent][data-lang="fr"]').getAttribute('data-tag')).toBeNull();
  } finally {
    await site.close();
    await mock.close();
  }
});
