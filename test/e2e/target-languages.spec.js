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
 *         and never part of the label
 *
 * Expected names are always computed here, in the browser, with Intl — never
 * written out and never asked of the code under test. zh-CN / zh-TW are the
 * two stored codes Intl would name by region ("Chinese (China)"), so the
 * expectation names them through zh-Hans / zh-Hant, as the design says.
 */
const { test, expect } = require('./fixtures');
const { getMessage } = require('../../i18n/messages');
const { setExtensionSettings, getSyncSettings, openFloatBallMenu } = require('./helpers');
const { startMockServer } = require('./mock-server');

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
  const chips = await page.evaluate(({ scriptTags }) => {
    const intl = new Intl.DisplayNames(['en'], { type: 'language' });
    return [...document.querySelectorAll('#autoTranslateLangs input[data-lang]')]
      .map((input) => ({ text: input.nextElementSibling.textContent, want: intl.of(scriptTags[input.dataset.lang] || input.dataset.lang) }));
  }, { scriptTags: SCRIPT_TAGS });
  expect(chips).toHaveLength(9);
  for (const { text, want } of chips) expect(text).toBe(want);

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
    res.end('<!doctype html><html lang="en"><body><p>A page with a language menu.</p></body></html>');
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
    await openFloatBallMenu(page);
    await page.click('.ai-translator-menu-item[data-action="translate-input"]');
    await page.waitForSelector('#ai-translator-input-dialog', { state: 'visible' });

    const dialog = page.locator('#ai-translator-input-dialog');
    await dialog.locator('.ai-translator-lang-trigger').click();
    await expect(dialog.locator('.ai-translator-lang-menu')).toBeVisible();

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
