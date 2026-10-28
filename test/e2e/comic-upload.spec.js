/**
 * How a comic page reaches the service, and how a chapter is put together.
 *
 * 一页漫画先由 worker 领上传票、PUT 到预签名地址，再以 sourceKey 下单；同一地址
 * 下翻的页归进一个章节，页序取页面里的 DOM 顺序（pageIndex），不是点击顺序；同一
 * 张图再翻一次是同一个 pageId；PUT 卡住 30 秒就是一次明确的网络错误，不偷偷换路。
 * 服务是 comic-fixtures.js 里那台模拟的。
 */
const { test, expect } = require('./fixtures');
const { connectExtension } = require('./helpers');
const { SOURCE_PNG, startMockService, openComicPage, triggerComicTranslation } = require('./comic-fixtures');

const page_ = n => `img.page:nth-of-type(${n})`;

const openChapter = (page, service) => openComicPage(page, service, '/chapter');

async function translatePage(worker, page, service, n, mode) {
  await triggerComicTranslation(worker, page, `${service.base}/chapter`, `${service.base}/source.png?page=${n}`, mode);
}

test.describe('Comic page upload', () => {
  test('pages clicked 3, 1, 2 land in one chapter in page order', async ({ context, page }) => {
    const service = await startMockService('succeed');
    try {
      const worker = await connectExtension(context, service.base);
      await openChapter(page, service);

      for (const n of [3, 1, 2]) {
        await translatePage(worker, page, service, n);
        await expect(page.locator(page_(n))).toHaveAttribute('src', /\/result\.png\?sig=/, { timeout: 20_000 });
      }

      const chapterUrl = `${service.base}/chapter`;
      expect(Object.keys(service.state.chapters)).toEqual([chapterUrl]);
      expect(service.state.createBodies.map(body => body.pageIndex)).toEqual([2, 0, 1]);
      const ids = service.state.createBodies.map(body => body.pageId);
      expect(new Set(ids).size).toBe(3);
      ids.forEach(id => expect(id).toBeTruthy());
      expect(service.state.chapters[chapterUrl]).toEqual({ [ids[0]]: 2, [ids[1]]: 0, [ids[2]]: 1 });

      // One ticket and one PUT per page, each create naming its own upload.
      expect(service.state.tickets).toHaveLength(3);
      expect(service.state.puts).toHaveLength(3);
      service.state.createBodies.forEach((body, i) => {
        expect(body.sourceKey).toBe(service.state.puts[i].sourceKey);
        expect(body.imageBase64).toBeUndefined();
      });
    } finally {
      await service.close();
    }
  });

  test('the same page translated again is the same page, not a new one', async ({ context, page }) => {
    const service = await startMockService('succeed');
    try {
      const worker = await connectExtension(context, service.base);
      await openChapter(page, service);

      await translatePage(worker, page, service, 2);
      await expect(page.locator(page_(2))).toHaveAttribute('src', /\/result\.png\?sig=/, { timeout: 20_000 });
      // Again, on the page now showing the result: still the original page.
      await translatePage(worker, page, service, 2, 'colorize');
      await expect.poll(() => service.state.createBodies.length, { timeout: 20_000 }).toBe(2);

      const [first, again] = service.state.createBodies;
      expect(again.pageId).toBe(first.pageId);
      expect(again.pageIndex).toBe(1);
      expect(again.operationId).not.toBe(first.operationId);
      expect(Object.keys(service.state.chapters[`${service.base}/chapter`])).toEqual([first.pageId]);
      // Uploaded from the original bytes both times, not from the result.
      service.state.puts.forEach(put => expect(put.bytes.equals(SOURCE_PNG)).toBe(true));
    } finally {
      await service.close();
    }
  });

  test('an upload that stalls says it timed out, and no job is created', async ({ context, page }) => {
    // The worker gives the PUT 30 s; the mock never answers it.
    test.setTimeout(90_000);
    const service = await startMockService('succeed', { uploadDelayMs: Infinity });
    try {
      const worker = await connectExtension(context, service.base);
      await openComicPage(page, service);

      await triggerComicTranslation(worker, page, `${service.base}/page`, `${service.base}/source.png`);
      const overlay = page.locator('.ai-translator-comic-progress');
      await expect(overlay).toBeVisible();
      await expect.poll(() => service.state.puts.length, { timeout: 20_000 }).toBe(1);

      await expect(overlay).toHaveClass(/is-error/, { timeout: 45_000 });
      await expect(overlay).toContainText('Uploading the page timed out. Check your connection and try again.');
      // Exactly one try at the storage, and nothing behind it.
      expect(service.state.tickets).toHaveLength(1);
      expect(service.state.puts).toHaveLength(1);
      expect(service.state.createBodies).toHaveLength(0);
      await expect(page.locator('#comic')).toHaveAttribute('src', '/source.png');
    } finally {
      await service.close();
    }
  });

  test('an upload the storage refuses says so, and no job is created', async ({ context, page }) => {
    const service = await startMockService('succeed', { putStatus: 500 });
    try {
      const worker = await connectExtension(context, service.base);
      await openComicPage(page, service);

      await triggerComicTranslation(worker, page, `${service.base}/page`, `${service.base}/source.png`);
      const overlay = page.locator('.ai-translator-comic-progress');
      await expect(overlay).toHaveClass(/is-error/, { timeout: 20_000 });
      // The storage's refusal, not a network that never answered.
      await expect(overlay).toContainText('The page could not be uploaded. Please try again.');
      expect(service.state.puts).toHaveLength(1);
      expect(service.state.createBodies).toHaveLength(0);
    } finally {
      await service.close();
    }
  });
});
