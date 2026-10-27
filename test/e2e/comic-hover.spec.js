/**
 * The "Translate this comic" chip on the image hover bar.
 *
 * 悬浮条（content/content-image-ocr.js）在大图上给两个快捷键：识别文字、翻译这张
 * 漫画。这一份钉住漫画那一个：门控与右键菜单同一判定（comic.comicEnabled，即
 * featureState === READY），不就绪就不出；出了，点下去下的单与右键菜单那一单一模
 * 一样；离开图片整条消失。服务是 comic-fixtures.js 里那台模拟的。
 */
const { test, expect } = require('./fixtures');
const { connectExtension, setExtensionSettings } = require('./helpers');
const { startMockService, openComicPage, triggerComicTranslation } = require('./comic-fixtures');

const BAR = '#ai-translator-image-hover-bar';
const COMIC_CHIP = '#ai-translator-comic-hover-btn';
const OCR_CHIP = '#ai-translator-ocr-hover-btn';

/**
 * Everything in a create request that is not per click: the idempotency key,
 * and the storage key the service minted under it for this click's upload.
 */
function withoutOperationId({ operationId, sourceKey, ...rest }) {
  return rest;
}

test.describe('Comic chip on the image hover bar', () => {
  test('signed out: the bar offers recognition only, never the paid chip', async ({ context, page }) => {
    const service = await startMockService('succeed');
    try {
      await connectExtension(context, service.base, { signedIn: false });
      await openComicPage(page, service);

      await page.locator('#comic').hover();
      // The OCR chip proves the bar rendered for this image, so the missing
      // comic chip is the gate speaking and not a hover that never landed.
      await expect(page.locator(OCR_CHIP)).toBeVisible();
      await expect(page.locator(COMIC_CHIP)).toHaveCount(0);
      expect(service.state.createBodies).toHaveLength(0);
    } finally {
      await service.close();
    }
  });

  test('comic translation switched off: no comic chip either', async ({ context, page }) => {
    const service = await startMockService('succeed');
    try {
      await connectExtension(context, service.base, { comic: false });
      await openComicPage(page, service);

      await page.locator('#comic').hover();
      await expect(page.locator(OCR_CHIP)).toBeVisible();
      await expect(page.locator(COMIC_CHIP)).toHaveCount(0);
    } finally {
      await service.close();
    }
  });

  test('ready: the chip sits next to Recognize Text and translates the page in place', async ({ context, page }) => {
    const service = await startMockService('succeed');
    try {
      await connectExtension(context, service.base);
      await setExtensionSettings(page, { comicTargetLang: 'zh-CN' });
      await openComicPage(page, service);

      await page.locator('#comic').hover();
      const chip = page.locator(COMIC_CHIP);
      await expect(chip).toBeVisible();
      await expect(chip).toHaveText('Translate This Comic');
      await expect(page.locator(OCR_CHIP)).toBeVisible();
      // One bar, both chips inside it — one hover state, one position.
      await expect(page.locator(`${BAR} > ${COMIC_CHIP} + ${OCR_CHIP}`)).toHaveCount(1);

      await chip.click();
      await expect(page.locator(BAR)).toHaveCount(0);
      await expect(page.locator('#comic')).toHaveAttribute('src', /\/result\.png\?sig=/, { timeout: 20000 });
      await expect(page.locator('.ai-translator-comic-badge')).toBeVisible();
      expect(service.state.createBodies).toHaveLength(1);
      expect(service.state.createBodies[0]).toMatchObject({
        pageUrl: `${service.base}/page`,
        pageTitle: 'Comic',
        targetLang: 'zh-CN',
        mode: 'translate',
      });
    } finally {
      await service.close();
    }
  });

  test('ready: the click orders exactly the job the context menu orders', async ({ context, page }) => {
    // A refused job leaves no badge behind, so the same page can be ordered a
    // second time and the two requests compared field by field.
    const service = await startMockService('insufficient');
    try {
      const worker = await connectExtension(context, service.base);
      // The menu sends comicTargetLang when set (background/context-menus.js),
      // and the helper standing in for it sends zh-CN.
      await setExtensionSettings(page, { comicTargetLang: 'zh-CN' });
      await openComicPage(page, service);

      await triggerComicTranslation(worker, page, `${service.base}/page`, `${service.base}/source.png`);
      const overlay = page.locator('.ai-translator-comic-progress');
      await expect(overlay).toHaveClass(/is-error/);
      // Put the plans offer away, not open it.
      await overlay.locator('.ai-translator-comic-btn:not(.is-primary)').click();
      await expect(overlay).toHaveCount(0);
      expect(service.state.createBodies).toHaveLength(1);

      await page.locator('#comic').hover();
      await page.locator(COMIC_CHIP).click();
      await expect(overlay).toHaveClass(/is-error/);
      expect(service.state.createBodies).toHaveLength(2);

      const [fromMenu, fromChip] = service.state.createBodies;
      expect(fromChip.operationId).toBeTruthy();
      expect(fromChip.operationId).not.toBe(fromMenu.operationId);
      expect(fromChip.sourceKey).toBeTruthy();
      expect(withoutOperationId(fromChip)).toEqual(withoutOperationId(fromMenu));
    } finally {
      await service.close();
    }
  });

  test('ready: hovering a decoy translates the artwork under it', async ({ context, page }) => {
    // Hit-testing lands on the decoy, so that is the <img> the bar is shown for;
    // the job must still be the page underneath, as it is from the menu.
    const service = await startMockService('succeed');
    try {
      await connectExtension(context, service.base);
      await openComicPage(page, service, '/decoy-page');

      await page.locator('#decoy').hover();
      await page.locator(COMIC_CHIP).click();
      await expect(page.locator('#comic')).toHaveAttribute('src', /\/result\.png\?sig=/, { timeout: 20000 });
      expect(await page.locator('#decoy').evaluate(img => img.src)).toBe(`${service.base}/decoy.png`);
      expect(service.state.createBodies).toHaveLength(1);
    } finally {
      await service.close();
    }
  });

  test('leaving the image hides the whole bar, both chips with it', async ({ context, page }) => {
    const service = await startMockService('succeed');
    try {
      await connectExtension(context, service.base);
      await openComicPage(page, service);

      await page.locator('#comic').hover();
      await expect(page.locator(COMIC_CHIP)).toBeVisible();
      await expect(page.locator(OCR_CHIP)).toBeVisible();

      // The image is 400 px wide at the left edge; this is bare page.
      await page.mouse.move(900, 300);
      await expect(page.locator(BAR)).toHaveCount(0);
      await expect(page.locator(COMIC_CHIP)).toHaveCount(0);
      await expect(page.locator(OCR_CHIP)).toHaveCount(0);

      await page.locator('#comic').hover();
      await expect(page.locator(COMIC_CHIP)).toBeVisible();
      expect(service.state.createBodies).toHaveLength(0);
    } finally {
      await service.close();
    }
  });

  test('an image wider than its box keeps the bar inside the part of the box it can be seen in', async ({ context, page }) => {
    const service = await startMockService('succeed');
    try {
      await connectExtension(context, service.base);
      await openComicPage(page, service, '/scroller');
      // 900 px wide in a 500 px box at scrollLeft 0: the image's right edge,
      // where the bar used to go, is out of the box.
      await page.evaluate(() => {
        const img = document.querySelector('#comic');
        img.removeAttribute('width');
        img.style.width = '900px';
      });
      const box = await page.locator('#box').evaluate(el => {
        const rect = el.getBoundingClientRect();
        return { left: rect.left + el.clientLeft, top: rect.top + el.clientTop,
          right: rect.left + el.clientLeft + el.clientWidth, bottom: rect.top + el.clientTop + el.clientHeight,
          scrollLeft: el.scrollLeft };
      });
      expect(box.scrollLeft).toBe(0);
      expect(await page.locator('#comic').evaluate(img => img.getBoundingClientRect().right)).toBeGreaterThan(box.right);

      await page.mouse.move(100, 250);
      await expect(page.locator(COMIC_CHIP)).toBeVisible();
      const bar = await page.locator(BAR).evaluate(el => el.getBoundingClientRect().toJSON());
      expect(bar.left).toBeGreaterThanOrEqual(box.left);
      expect(bar.right).toBeLessThanOrEqual(box.right);
      expect(bar.top).toBeGreaterThanOrEqual(box.top);
      expect(bar.bottom).toBeLessThanOrEqual(box.bottom);
    } finally {
      await service.close();
    }
  });

  test('a thin strip of the image left at the box bottom gets no bar; with room it shows inside the box', async ({ context, page }) => {
    const service = await startMockService('succeed');
    try {
      await connectExtension(context, service.base);
      await openComicPage(page, service, '/scroller');
      // Leaves the last `seen` px of the image in the 400 px box (top at 100),
      // then points at that strip from outside it, so the bar is asked afresh.
      const pointAtStrip = async (seen) => {
        await page.mouse.move(700, 50);
        await page.locator('#comic').evaluate((img, px) => {
          document.querySelector('#box').scrollTop = img.offsetHeight - px;
          return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        }, seen);
        await page.mouse.move(100, 100 + seen / 2);
      };

      // Measured on the whole image first: the bar's own height.
      await page.mouse.move(100, 250);
      await expect(page.locator(COMIC_CHIP)).toBeVisible();
      const height = await page.locator(BAR).evaluate(el => el.getBoundingClientRect().height);
      expect(height + 16).toBeGreaterThan(20);

      for (const seen of [12, 20]) {
        await pointAtStrip(seen);
        // Give a wrongly placed bar time to render.
        await page.waitForTimeout(300);
        await expect(page.locator(BAR)).toHaveCount(0);
      }

      // Room for the bar and an inset each side.
      await pointAtStrip(Math.ceil(height) + 16 + 10);
      await expect(page.locator(COMIC_CHIP)).toBeVisible();
      const box = await page.locator('#box').evaluate(el => {
        const rect = el.getBoundingClientRect();
        return { top: rect.top + el.clientTop, bottom: rect.top + el.clientTop + el.clientHeight };
      });
      const bar = await page.locator(BAR).evaluate(el => el.getBoundingClientRect().toJSON());
      expect(bar.top).toBeGreaterThanOrEqual(box.top);
      expect(bar.bottom).toBeLessThanOrEqual(box.bottom);
      const image = await page.locator('#comic').evaluate(img => img.getBoundingClientRect().bottom);
      expect(bar.bottom).toBeLessThanOrEqual(image);
    } finally {
      await service.close();
    }
  });

  test('the switches: OCR off leaves the comic chip alone, the bar switch hides both', async ({ context, page }) => {
    const service = await startMockService('succeed');
    try {
      await connectExtension(context, service.base);
      await setExtensionSettings(page, { enableImageOcrTranslation: false });
      await openComicPage(page, service);

      await page.locator('#comic').hover();
      await expect(page.locator(COMIC_CHIP)).toBeVisible();
      await expect(page.locator(OCR_CHIP)).toHaveCount(0);

      await setExtensionSettings(page, { enableImageOcrTranslation: true, enableImageOcrHoverButton: false });
      await openComicPage(page, service);
      await page.locator('#comic').hover();
      // Give a wrongly-live listener time to render one.
      await page.waitForTimeout(500);
      await expect(page.locator(BAR)).toHaveCount(0);
    } finally {
      await service.close();
    }
  });
});
