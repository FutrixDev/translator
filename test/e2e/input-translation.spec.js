const { test, expect } = require('./fixtures');
const { setExtensionSettings, openFloatBallMenu } = require('./helpers');
const { startMockServer } = require('./mock-server');

async function startInputDictionaryMockServer() {
  const { origin, close } = await startMockServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(404);
      res.end();
      return;
    }

    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });

    req.on('end', () => {
      let systemPrompt = '';
      let text = '';

      try {
        const data = JSON.parse(body);
        systemPrompt = data?.messages?.[0]?.content || '';
        text = data?.messages?.[1]?.content || '';
      } catch (error) {
        systemPrompt = '';
        text = '';
      }

      const isDictionaryMode = /"translation"\s+and\s+"phonetic"/i.test(systemPrompt);
      const content = isDictionaryMode
        ? JSON.stringify({ translation: `[DICT] ${text}`, phonetic: '/ɒn ðə flaɪ/' })
        : `[TEXT] ${text}`;

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { content } }]
      }));
    });
  });

  return { endpoint: `${origin}/v1/chat/completions`, close };
}

test('input translation shows phonetic for words and read-aloud for anything typed', async ({ page }) => {
  const { close, endpoint } = await startInputDictionaryMockServer();

  try {
    await setExtensionSettings(page, {
      // Dictionary mode only exists on the AI path — the built-in engine gives
      // back no phonetic and reports isWord: false — and the assertions below
      // are on this mock's replies, so the backend has to be pinned. See
      // setExtensionSettings in ./helpers.
      apiEndpoint: endpoint,
      apiKey: 'test-key',
      modelName: 'gpt-4.1-mini',
      targetLang: 'zh-CN',
      targetLangSetByUser: true,
    });

    await page.goto('https://example.com');
    await page.waitForSelector('#ai-translator-float-ball');

    await openFloatBallMenu(page);
    await page.click('.ai-translator-menu-item[data-action="translate-input"]');

    await page.waitForSelector('#ai-translator-input-dialog', { state: 'visible' });

    // The source is readable before anything has been translated — hearing how
    // the word you just typed is pronounced is the whole point of the button.
    await expect(page.locator('#ai-translator-input-speak')).toBeHidden();
    await page.fill('#ai-translator-input-text', 'on the fly');
    await expect(page.locator('#ai-translator-input-speak')).toBeVisible();
    await expect(page.locator('#ai-translator-input-speak-result')).toBeHidden();

    await page.click('#ai-translator-do-translate');

    await expect(page.locator('#ai-translator-result-section')).toBeVisible();
    await expect(page.locator('#ai-translator-result-text')).toContainText('[DICT] on the fly');
    await expect(page.locator('#ai-translator-input-phonetic')).toHaveText('/ɒn ðə flaɪ/');
    await expect(page.locator('#ai-translator-input-speak-result')).toBeVisible();

    await page.fill('#ai-translator-input-text', 'this is a full sentence for translation');
    await page.click('#ai-translator-do-translate');
    await expect(page.locator('#ai-translator-result-text')).toContainText('[TEXT] this is a full sentence for translation');
    // Only the phonetic is dictionary-only; both speakers stay available because
    // a sentence can be read aloud just as well as a word.
    await expect(page.locator('#ai-translator-input-phonetic')).toBeHidden();
    await expect(page.locator('#ai-translator-input-speak')).toBeVisible();
    await expect(page.locator('#ai-translator-input-speak-result')).toBeVisible();

    // Nothing typed, nothing to read.
    await page.fill('#ai-translator-input-text', '');
    await expect(page.locator('#ai-translator-input-speak')).toBeHidden();
  } finally {
    await close();
  }
});

/**
 * The stylesheet a hostile host page serves.
 *
 * Every rule here targets a bare tag, because that is the whole mechanism: our
 * panels are `div`s and `button`s and `label`s inside the page's own document,
 * so a page rule with no class in it matches them. `div { opacity: .8 }` is
 * real — example.com ships it — and the rest are the same shape, drawn from
 * what page CSS routinely does to bare tags.
 *
 * Three separate defects came out of this one mechanism before it was fixed at
 * the boundary: the box model overflowing the textarea past the modal, the
 * stacking context the opacity built around the dialog header (which sealed
 * the language menu behind the textarea, so the picker looked decorative), and
 * the compounded opacity that let page text show through the panel.
 *
 * The `.host-kit button` rule is the fourth, and it is the shape that matters
 * most in practice. A theme does not style `button` from a bare tag; it styles
 * it from a class on `<body>`, which weighs (0,1,1) — one type selector more
 * than the single-class rules our own controls were written with. This is
 * Elementor's kit rule copied off azulle.com, where it turned the float menu,
 * the popup, the input dialog and the progress toast into stacks of lime pills
 * all at once.
 *
 * Its `:hover`/`:focus` twin is the fifth, and it is heavier still — a state is
 * a pseudo-class, so (0,2,1). It takes whatever the control's own hover rule
 * does not restate, which on the first fix was the border and the colour: the
 * float menu drew a near-black box around the item under the pointer and turned
 * its label white, on a white menu. Both rules are the real values off that
 * site, so the fixture fails the way the site did.
 */
const HOSTILE_PAGE_CSS = `
  div { opacity: 0.8; box-sizing: content-box; filter: saturate(0.4); }
  span { opacity: 0.8; }
  button { text-transform: uppercase; font-family: monospace; }
  textarea { box-sizing: content-box; font-family: monospace; transform: translateX(30px); }
  label { text-transform: uppercase; letter-spacing: 4px; }
  .host-kit button {
    background-color: rgb(195, 250, 125);
    border: 1px solid rgb(195, 250, 125);
    border-radius: 100px;
    padding: 14px 30px;
    font: 600 15.75px monospace;
  }
  .host-kit button:hover,
  .host-kit button:focus {
    background-color: rgb(0, 2, 22);
    color: rgb(255, 255, 255);
    border: 1px solid rgb(0, 2, 22);
  }
`;

/**
 * The inherited half, injected once the dialog is up rather than served with
 * the page.
 *
 * These reach our panels through `<body>`, and the float ball and its menu are
 * how every test here opens the dialog in the first place. A 3× line-height on
 * the menu is enough to push the item being clicked off a fixed-position
 * element that Playwright cannot scroll — so even now that the menu is a
 * covered root, injecting after the dialog is open keeps the way in from
 * depending on the very reset under test.
 */
const HOSTILE_INHERITED_CSS = `
  body {
    line-height: 3;
    letter-spacing: 6px;
    text-transform: uppercase;
    font-family: monospace;
    visibility: hidden;
  }
`;

/**
 * A backend that reports which target language the request asked for, plus a
 * page to run it on. The page serves HOSTILE_PAGE_CSS — see above for why that
 * is the point of the fixture rather than incidental to it.
 */
async function startTargetLangFixture() {
  const LANGUAGE_NAMES = {
    'zh-CN': '简体中文',
    'ja': '日本語',
    'fr': 'Français',
  };

  const api = await startMockServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let systemPrompt = '';
      let text = '';
      try {
        const data = JSON.parse(body);
        systemPrompt = data?.messages?.[0]?.content || '';
        text = data?.messages?.[1]?.content || '';
      } catch (error) {
        systemPrompt = '';
      }
      // The prompt names the target in that language's own words — see
      // languageNames in background/background.js.
      const asked = Object.entries(LANGUAGE_NAMES)
        .find(([, name]) => systemPrompt.includes(name));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { content: `[${asked ? asked[0] : 'unknown'}] ${text}` } }]
      }));
    });
  });

  const site = await startMockServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><head><style>${HOSTILE_PAGE_CSS}</style></head>`
      + '<body class="host-kit"><h1>Hostile stylesheet page</h1><p>Body text.</p>'
      // A div of the page's own, so a test can check the page rules are
      // actually live before asserting they did not reach us.
      + '<div id="host-canary">Host div</div>'
      + '<button id="host-button" type="button">Host button</button></body></html>');
  });

  return {
    endpoint: `${api.origin}/v1/chat/completions`,
    url: `${site.origin}/`,
    close: () => Promise.all([api.close(), site.close()]),
  };
}

async function openInputDialog(page) {
  await openFloatBallMenu(page);
  await page.click('.ai-translator-menu-item[data-action="translate-input"]');
  await page.waitForSelector('#ai-translator-input-dialog', { state: 'visible' });
}

async function pickInputTargetLang(page, lang) {
  await page.click('#ai-translator-input-dialog .ai-translator-lang-trigger');
  await page.click(`#ai-translator-input-dialog .ai-translator-lang-item[data-lang="${lang}"]`);
}

test('the input dialog translates into the language picked in it, not the one in settings', async ({ page }) => {
  const fixture = await startTargetLangFixture();

  try {
    await setExtensionSettings(page, {
      apiEndpoint: fixture.endpoint,
      apiKey: 'test-key',
      modelName: 'gpt-4.1-mini',
      targetLang: 'zh-CN',
      targetLangSetByUser: true,
    });

    await page.goto(fixture.url);
    await page.waitForSelector('#ai-translator-float-ball');
    await openInputDialog(page);

    // Clicking through to a language is the assertion here: on a page like this
    // one the menu used to be unreachable behind the textarea.
    await pickInputTargetLang(page, 'ja');
    await expect(page.locator('#ai-translator-input-dialog .ai-translator-lang-label')).toHaveText('日本語');

    await page.fill('#ai-translator-input-text', 'a full sentence for translation');
    await page.click('#ai-translator-do-translate');
    await expect(page.locator('#ai-translator-result-text')).toContainText('[ja]');

    // Reopening keeps the dialog's own target: the whole point is not having to
    // re-pick, or go to the settings page, for the next paste.
    await page.click('#ai-translator-input-dialog .ai-translator-close');
    await openInputDialog(page);
    await expect(page.locator('#ai-translator-input-dialog .ai-translator-lang-label')).toHaveText('日本語');

    await page.fill('#ai-translator-input-text', 'another sentence');
    await page.click('#ai-translator-do-translate');
    await expect(page.locator('#ai-translator-result-text')).toContainText('[ja]');
  } finally {
    await fixture.close();
  }
});

test('setting a target language in settings overrides what the input dialog remembers', async ({ page }) => {
  const fixture = await startTargetLangFixture();

  try {
    await setExtensionSettings(page, {
      apiEndpoint: fixture.endpoint,
      apiKey: 'test-key',
      modelName: 'gpt-4.1-mini',
      targetLang: 'zh-CN',
      targetLangSetByUser: true,
    });

    await page.goto(fixture.url);
    await page.waitForSelector('#ai-translator-float-ball');
    await openInputDialog(page);
    await pickInputTargetLang(page, 'ja');
    await page.click('#ai-translator-input-dialog .ai-translator-close');

    // An explicit choice on the settings page is the stronger signal — a dialog
    // that quietly kept translating into Japanese would be the same complaint
    // the dialog's own picker exists to answer.
    await setExtensionSettings(page, { targetLang: 'fr', targetLangSetByUser: true });

    await openInputDialog(page);
    await expect(page.locator('#ai-translator-input-dialog .ai-translator-lang-label')).toHaveText('Français');

    await page.fill('#ai-translator-input-text', 'a full sentence for translation');
    await page.click('#ai-translator-do-translate');
    await expect(page.locator('#ai-translator-result-text')).toContainText('[fr]');
  } finally {
    await fixture.close();
  }
});

/**
 * Wait out the dialog's entry animation.
 *
 * `ai-translator-modal-in` animates opacity and transform, and an animation
 * outranks the containment reset by design — sampling computed styles while it
 * runs reads 0.07 and a half-applied scale, which is the animation working, not
 * the reset failing.
 */
function settleDialogAnimations(page) {
  return page.evaluate(() => Promise.all(
    document.getElementById('ai-translator-input-dialog')
      .getAnimations({ subtree: true })
      .map((animation) => animation.finished.catch(() => {})),
  ));
}

/**
 * Computed styles for one selector inside the dialog.
 */
function computed(page, selector, properties) {
  return page.evaluate(({ sel, props }) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const style = getComputedStyle(el);
    return Object.fromEntries(props.map((name) => [name, style.getPropertyValue(name)]));
  }, { sel: selector, props: properties });
}

/**
 * Wait out a hover/focus transition on one element.
 *
 * The menu item carries `transition: background 0.15s`, so a computed style read
 * taken the instant after `page.hover()` samples the first frame — rgba(0, 0, 0, 0)
 * on its way to our purple, which reads exactly like the rule never matched.
 */
function settleTransitions(page, selector) {
  return page.evaluate((sel) => Promise.all(
    document.querySelector(sel).getAnimations().map((animation) => animation.finished.catch(() => {})),
  ), selector);
}

test('a theme\'s button style cannot reach our controls', async ({ page }) => {
  // The reported symptom, on azulle.com: every panel rendered as a stack of
  // lime pills. `.host-kit button` weighs (0,1,1) and every control rule of
  // ours weighed (0,1,0), so the page won outright on background, padding,
  // border-radius and font — in the float menu, the popup, the input dialog
  // and the progress toast at the same time, since they all share the shape.
  const fixture = await startTargetLangFixture();

  try {
    await setExtensionSettings(page, {
      apiEndpoint: fixture.endpoint,
      apiKey: 'test-key',
      modelName: 'gpt-4.1-mini',
      targetLang: 'zh-CN',
      targetLangSetByUser: true,
    });

    await page.goto(fixture.url);
    await page.waitForSelector('#ai-translator-float-ball');

    // The page's own button is styled, so the rule is live. Without this the
    // assertions below would pass against a stylesheet that never loaded.
    expect(await computed(page, '#host-button', ['background-color', 'border-radius', 'padding'])).toEqual({
      'background-color': 'rgb(195, 250, 125)',
      'border-radius': '100px',
      padding: '14px 30px',
    });

    await openFloatBallMenu(page);
    const item = await computed(page, '.ai-translator-menu-item', [
      'background-color', 'border-radius', 'padding', 'font-size', 'font-weight', 'font-family',
    ]);
    expect(item['background-color']).toBe('rgba(0, 0, 0, 0)');
    expect(item['border-radius']).toBe('0px');
    expect(item.padding).toBe('12px 14px');
    expect(item['font-size']).toBe('13px');
    expect(item['font-weight']).toBe('400');
    expect(item['font-family']).not.toContain('monospace');

    // Hovering is where the page gets a second, heavier go at it. Our own hover
    // rule only sets a background, so the border and the colour have to come
    // from the base rule outranking `.host-kit button:hover`, not from us
    // restating them per control.
    await page.hover('.ai-translator-menu-item[data-action="translate-page"]');
    await settleTransitions(page, '.ai-translator-menu-item[data-action="translate-page"]');
    const hovered = await computed(page, '.ai-translator-menu-item[data-action="translate-page"]', [
      'background-color', 'color', 'border-top-width', 'border-top-style',
    ]);
    expect(hovered['background-color']).toBe('rgba(124, 92, 255, 0.08)');
    expect(hovered.color).toBe('rgb(29, 29, 31)');
    expect(hovered['border-top-width']).toBe('0px');
    expect(hovered['border-top-style']).toBe('none');

    await page.click('.ai-translator-menu-item[data-action="translate-input"]');
    await page.waitForSelector('#ai-translator-input-dialog', { state: 'visible' });
    await settleDialogAnimations(page);

    // The dialog's own two button shapes: the pill and the icon square.
    const primary = await computed(page, '#ai-translator-do-translate', [
      'background-color', 'border-radius', 'padding', 'font-size',
    ]);
    expect(primary['background-color']).toBe('rgb(111, 99, 255)');
    expect(primary['border-radius']).toBe('999px');
    expect(primary.padding).toBe('9px 14px');
    expect(primary['font-size']).toBe('14px');

    // `:focus` is the state that outlives the pointer — a clicked button keeps
    // it, so a leak here is not a flicker, it is how the button then looks.
    await page.focus('#ai-translator-do-translate');
    await settleTransitions(page, '#ai-translator-do-translate');
    const focused = await computed(page, '#ai-translator-do-translate', ['background-color', 'color']);
    expect(focused['background-color']).toBe('rgb(111, 99, 255)');
    expect(focused.color).toBe('rgb(255, 255, 255)');

    const trigger = await computed(page, '#ai-translator-input-dialog .ai-translator-lang-trigger', [
      'border-radius', 'padding', 'font-weight',
    ]);
    expect(trigger['border-radius']).toBe('999px');
    expect(trigger.padding).toBe('7px 12px 7px 14px');
    expect(trigger['font-weight']).toBe('500');
  } finally {
    await fixture.close();
  }
});

test('a hostile host stylesheet cannot reach into the dialog', async ({ page }) => {
  // The guard for the containment reset in content/content.css. Three defects
  // came out of one mechanism — a page rule on a bare tag matching our own
  // elements — and each was patched where it surfaced. This asserts the
  // boundary instead: on a page that styles every tag our dialog is built from,
  // the dialog computes as if the page had no stylesheet at all.
  const fixture = await startTargetLangFixture();

  try {
    await setExtensionSettings(page, {
      apiEndpoint: fixture.endpoint,
      apiKey: 'test-key',
      modelName: 'gpt-4.1-mini',
      targetLang: 'zh-CN',
      targetLangSetByUser: true,
    });

    await page.goto(fixture.url);
    await page.waitForSelector('#ai-translator-float-ball');

    // The page's rules are live. Without this the assertions below would pass
    // just as well against a stylesheet that failed to load.
    expect(await computed(page, '#host-canary', ['opacity', 'box-sizing', 'filter'])).toEqual({
      opacity: '0.8',
      'box-sizing': 'content-box',
      filter: 'saturate(0.4)',
    });

    await openInputDialog(page);
    await settleDialogAnimations(page);
    await page.addStyleTag({ content: HOSTILE_INHERITED_CSS });

    // The whole subtree, not just the root: `div { opacity: .8 }` matched the
    // root, the modal and the header separately and the three multiplied to
    // 0.51, which is what put page text through the header.
    for (const selector of [
      '#ai-translator-input-dialog',
      '#ai-translator-input-dialog .ai-translator-input-modal',
      '#ai-translator-input-dialog .ai-translator-header',
      '#ai-translator-input-dialog .ai-translator-input-body',
    ]) {
      expect(await computed(page, selector, ['opacity', 'filter', 'transform', 'visibility', 'box-sizing']), selector)
        .toEqual({
          opacity: '1',
          filter: 'none',
          transform: 'none',
          visibility: 'visible',
          'box-sizing': 'border-box',
        });
    }

    // Inherited properties reach us through <body>, and a direct hit on
    // `textarea` / `label` / `button` reaches the leaves the same way.
    const textarea = await computed(page, '#ai-translator-input-text', [
      'box-sizing', 'transform', 'font-family', 'letter-spacing', 'text-transform',
    ]);
    expect(textarea['box-sizing']).toBe('border-box');
    expect(textarea.transform).toBe('none');
    expect(textarea['font-family']).not.toContain('monospace');
    expect(textarea['letter-spacing']).toBe('normal');
    expect(textarea['text-transform']).toBe('none');

    const label = await computed(page, '#ai-translator-input-dialog .ai-translator-label', [
      'text-transform', 'letter-spacing', 'font-family',
    ]);
    expect(label['text-transform']).toBe('none');
    // Our own 0.3px tracking on the label, not the page's 6px or the 4px its
    // `label` rule asks for: the reset has to lose to our deliberate values.
    expect(label['letter-spacing']).toBe('0.3px');
    expect(label['font-family']).not.toContain('monospace');

    const button = await computed(page, '#ai-translator-do-translate', ['text-transform', 'font-family']);
    expect(button['text-transform']).toBe('none');
    expect(button['font-family']).not.toContain('monospace');

    // `body { line-height: 3 }` on a 15px modal is a 45px line box, and the
    // panel is laid out for ~24px. The panel's own line-heights still reach the
    // text they wrap, so this is `inherit` doing its job, not a flat override.
    const result = await computed(page, '#ai-translator-input-dialog .ai-translator-input-result', ['line-height']);
    expect(result['line-height']).toBe('24px'); // 15px × 1.6
    const modal = await computed(page, '#ai-translator-input-dialog .ai-translator-input-modal', ['line-height']);
    expect(modal['line-height']).toBe('normal');

    // Patch #1's actual symptom: under the page's content-box the textarea was
    // laid out at 100% *plus* its padding and border and ran past the modal.
    const overflow = await page.evaluate(() => {
      const modalRect = document.querySelector('.ai-translator-input-modal').getBoundingClientRect();
      const areaRect = document.getElementById('ai-translator-input-text').getBoundingClientRect();
      return { modalRight: modalRect.right, textareaRight: areaRect.right };
    });
    expect(overflow.textareaRight).toBeLessThanOrEqual(overflow.modalRight);

    // Patch #2's: the language menu has to be the element under the pointer.
    // `div { opacity: .8 }` used to seal it inside the header's stacking
    // context, where it painted under the textarea and every click on a
    // language landed there instead.
    await page.click('#ai-translator-input-dialog .ai-translator-lang-trigger');
    await page.waitForSelector('#ai-translator-input-dialog .ai-translator-lang-item[data-lang="ja"]', { state: 'visible' });
    const menuIsOnTop = await page.evaluate(() => {
      const item = document.querySelector('#ai-translator-input-dialog .ai-translator-lang-item[data-lang="ja"]');
      item.scrollIntoView({ block: 'nearest' });
      const rect = item.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return hit === item || item.contains(hit);
    });
    expect(menuIsOnTop).toBe(true);
  } finally {
    await fixture.close();
  }
});

test('the containment reset does not outrank our own fade-in', async ({ page }) => {
  // The reset pins `opacity: 1` on the whole subtree. Written with `!important`
  // that would outrank animations — important author declarations sort above
  // them — and `ai-translator-modal-in` would never fade: the dialog would just
  // appear. A normal declaration loses to a running animation and takes over
  // when it ends, which is the order we want.
  //
  // Asserted by seeking rather than by sampling a 200ms animation mid-flight: a
  // fresh element with the modal's class starts the animation from scratch, and
  // pausing it at t=0 makes the `from` keyframe the value under test.
  const fixture = await startTargetLangFixture();

  try {
    await setExtensionSettings(page, {
      apiEndpoint: fixture.endpoint,
      apiKey: 'test-key',
      modelName: 'gpt-4.1-mini',
      targetLang: 'zh-CN',
    });

    await page.goto(fixture.url);
    await page.waitForSelector('#ai-translator-float-ball');
    await openInputDialog(page);

    const atStart = await page.evaluate(() => {
      const probe = document.createElement('div');
      probe.className = 'ai-translator-input-modal';
      document.getElementById('ai-translator-input-dialog').appendChild(probe);
      const animations = probe.getAnimations();
      if (!animations.length) return { error: 'ai-translator-modal-in is not running' };
      animations.forEach((animation) => { animation.pause(); animation.currentTime = 0; });
      const style = getComputedStyle(probe);
      const value = { opacity: style.opacity, transform: style.transform };
      probe.remove();
      return value;
    });

    expect(atStart.error).toBeUndefined();
    expect(Number(atStart.opacity)).toBe(0);
    expect(atStart.transform).not.toBe('none');

    // And once it has finished, the reset is what holds the panel at full
    // opacity — the animation does not fill forwards.
    await expect
      .poll(async () => (await computed(page, '.ai-translator-input-modal', ['opacity'])).opacity)
      .toBe('1');
  } finally {
    await fixture.close();
  }
});

