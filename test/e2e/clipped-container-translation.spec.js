// A translation can be inserted, correct, and still invisible: it lands below the
// visible box of an `overflow:hidden` ancestor and gets clipped away.
//
// Reported on Higgsfield, whose project blurb sits in a collapsible
// `overflow:hidden; max-height:60px` wrapper. The source text fills the wrapper
// exactly, so the translation starts one pixel past the cut. Nothing in the DOM
// looks wrong — only the geometry does, which is why these assertions compare
// rectangles instead of checking that a node exists.
//
// The fixture below reproduces that shape locally: a wrapper clipped to the
// height of its own paragraph.
const { test, expect } = require('./fixtures');
const { setExtensionSettings, triggerPageTranslation } = require('./helpers');
const { startMockOpenAIServer } = require('./mock-openai-server');

const FIXTURE = `
  const wrap = document.createElement('div');
  wrap.id = 'clip-wrap';
  wrap.innerHTML = '<p id="clipped-para">A collapsed blurb that fills its wrapper exactly.</p>';
  document.body.appendChild(wrap);
  // 先量原文的自然高度，再把容器卡死在这个高度：译文只要出现就一定落在外面
  const natural = document.getElementById('clipped-para').getBoundingClientRect().height;
  wrap.style.overflow = 'hidden';
  wrap.style.maxHeight = natural + 'px';
`;

/** Is `selector` fully inside the visible box of #clip-wrap? */
const VISIBILITY = `(() => {
  const wrap = document.getElementById('clip-wrap');
  const el = document.querySelector(SELECTOR);
  if (!wrap || !el) return null;
  const box = wrap.getBoundingClientRect();
  const visibleBottom = box.top + wrap.clientTop + wrap.clientHeight;
  return {
    inside: el.getBoundingClientRect().bottom <= visibleBottom + 1,
    inlineMaxHeight: wrap.style.maxHeight
  };
})()`;

const check = (page, selector) =>
  page.evaluate(`(() => { const SELECTOR = ${JSON.stringify(selector)}; return ${VISIBILITY}; })()`);

test.describe('translations clipped by a collapsed ancestor', () => {
  test('hover translation is revealed, and the clip is restored afterwards', async ({ page }) => {
    const { close, endpoint } = await startMockOpenAIServer();

    try {
      await setExtensionSettings(page, {
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
      await page.evaluate(FIXTURE);

      const before = await page.evaluate(`(() => {
        const wrap = document.getElementById('clip-wrap');
        return { maxHeight: wrap.style.maxHeight, clientHeight: wrap.clientHeight };
      })()`);

      await page.keyboard.down('Shift');
      await page.locator('#clipped-para').hover();
      await page.waitForSelector('#clipped-para + .ai-translator-hover-translation', { state: 'attached' });
      await page.keyboard.up('Shift');

      await expect
        .poll(() => check(page, '#clipped-para + .ai-translator-hover-translation'), {
          timeout: 10000,
          message: 'the translation stayed clipped outside the wrapper'
        })
        .toMatchObject({ inside: true, inlineMaxHeight: 'none' });

      // 撤掉译文后必须原样还原，不能把页面留在展开状态。用真实手势：鼠标还停在原文上，
      // 再按一次热键就是切换掉这一块的译文（handleKeyDown 走 hasInlineTranslation 分支）。
      await page.keyboard.down('Shift');
      await page.keyboard.up('Shift');
      await page.waitForSelector('#clipped-para + .ai-translator-hover-translation', { state: 'detached' });
      await expect
        .poll(async () => page.evaluate(`(() => {
          const wrap = document.getElementById('clip-wrap');
          return { maxHeight: wrap.style.maxHeight, clientHeight: wrap.clientHeight };
        })()`), { timeout: 5000 })
        .toEqual(before);
    } finally {
      await close();
    }
  });

  test('whole-page translation is revealed too', async ({ page }) => {
    const { close, endpoint } = await startMockOpenAIServer();

    try {
      await setExtensionSettings(page, {
        apiEndpoint: endpoint,
        apiKey: 'test-key',
        modelName: 'gpt-4.1-mini',
        targetLang: 'zh-CN',
        autoDetect: false
      });

      await page.goto('https://example.com');
      await page.waitForSelector('#ai-translator-float-ball');
      await page.evaluate(FIXTURE);

      await triggerPageTranslation(page);

      await page.waitForFunction(() => {
        const el = document.getElementById('clipped-para');
        return el && el.classList.contains('ai-translator-translated');
      }, null, { timeout: 20000 });

      await expect
        .poll(() => check(page, '#clipped-para + .ai-translator-inline-block'), {
          timeout: 10000,
          message: 'the page translation stayed clipped outside the wrapper'
        })
        .toMatchObject({ inside: true });
    } finally {
      await close();
    }
  });
});
