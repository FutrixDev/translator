const { test, expect } = require('./fixtures');
const { setExtensionSettings, openFloatBallMenu } = require('./helpers');
const http = require('http');

function startInputDictionaryMockServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
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

    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        server,
        endpoint: `http://127.0.0.1:${port}/v1/chat/completions`
      });
    });
  });
}

test('input translation shows phonetic and pronunciation for short phrase', async ({ page }) => {
  const { server, endpoint } = await startInputDictionaryMockServer();

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
    await page.fill('#ai-translator-input-text', 'on the fly');
    await page.click('#ai-translator-do-translate');

    await expect(page.locator('#ai-translator-result-section')).toBeVisible();
    await expect(page.locator('#ai-translator-result-text')).toContainText('[DICT] on the fly');
    await expect(page.locator('#ai-translator-input-phonetic')).toHaveText('/ɒn ðə flaɪ/');
    await expect(page.locator('#ai-translator-input-speak')).toBeVisible();

    await page.fill('#ai-translator-input-text', 'this is a full sentence for translation');
    await page.click('#ai-translator-do-translate');
    await expect(page.locator('#ai-translator-result-text')).toContainText('[TEXT] this is a full sentence for translation');
    await expect(page.locator('#ai-translator-input-phonetic')).toBeHidden();
    await expect(page.locator('#ai-translator-input-speak')).toBeHidden();
  } finally {
    server.close();
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
 */
const HOSTILE_PAGE_CSS = `
  div { opacity: 0.8; box-sizing: content-box; filter: saturate(0.4); }
  span { opacity: 0.8; }
  button { text-transform: uppercase; font-family: monospace; }
  textarea { box-sizing: content-box; font-family: monospace; transform: translateX(30px); }
  label { text-transform: uppercase; letter-spacing: 4px; }
`;

/**
 * The inherited half, injected once the dialog is up rather than served with
 * the page.
 *
 * These reach our panels through `<body>`, so they would also reach the float
 * ball and its menu — which are separate roots, outside this reset, and are how
 * every test here opens the dialog in the first place. A 3× line-height on the
 * menu is enough to push the item being clicked off a fixed-position element
 * that Playwright cannot scroll. Injecting after the dialog is open tests the
 * same cascade against the same elements without breaking the way in.
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
function startTargetLangFixture() {
  const LANGUAGE_NAMES = {
    'zh-CN': '简体中文',
    'ja': '日本語',
    'fr': 'Français',
  };

  return new Promise((resolve) => {
    const api = http.createServer((req, res) => {
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

    const site = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><head><style>${HOSTILE_PAGE_CSS}</style></head>`
        + '<body><h1>Hostile stylesheet page</h1><p>Body text.</p>'
        // A div of the page's own, so a test can check the page rules are
        // actually live before asserting they did not reach us.
        + '<div id="host-canary">Host div</div></body></html>');
    });

    api.listen(0, '127.0.0.1', () => {
      site.listen(0, '127.0.0.1', () => {
        resolve({
          api,
          site,
          endpoint: `http://127.0.0.1:${api.address().port}/v1/chat/completions`,
          url: `http://127.0.0.1:${site.address().port}/`,
          close() { api.close(); site.close(); },
        });
      });
    });
  });
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
    fixture.close();
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
    fixture.close();
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

    const label = await computed(page, '#ai-translator-input-dialog .ai-translator-input-label', [
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
    fixture.close();
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
    fixture.close();
  }
});
