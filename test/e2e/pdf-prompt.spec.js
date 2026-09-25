/**
 * PDF 文档上那条提示条 —— 铁律的验收：**入口可以自己出现，任务永远不自己开始。**
 *
 * PRD（docs/plans/2026-09-19-auto-translation-prd.md，FR-4.3）把这一条写成了可以
 * 断言的话：「arXiv `/pdf/` 页面：无任何自动网络请求发往 PDF 任务接口」。单元测试
 * 能证明源码里只有一处 sendMessage 且它在 accept() 里（test/unit/pdf-offer.test.mjs），
 * 但证不了「跑起来真的没发」—— 那要一台真的服务器坐在那里数请求，而这就是这份
 * spec 的全部内容：mock 记下每一个落到 /api/pdf/* 的请求，条子出来之后清点，必须
 * 是零；点一下「翻译」，才允许有第一个。
 *
 * 两条路各跑一遍，因为它们不是同一件事：
 *
 *   - arxiv.org/pdf/* 在内置表里是 never（shared/site-rules-builtin.js），走的是
 *     「整页翻译这条路根本不该在这一页上开工」；
 *   - 任意一个 .pdf 网址没有规则，靠的是模式阶梯把 offer 压在 ask 上面。
 *
 * 服务工作者的 fetch 不经过 Playwright 的路由，所以「点了之后真的派出去」那一半
 * 放在 mock 自己的 /paper.pdf 上跑 —— 那个地址工作者拿得到。arXiv 那一半只断言
 * 「什么都没发生」，正是它要证明的。
 */
const { test, expect } = require('./fixtures');
const { getServiceWorker } = require('./helpers');
const { startDocService, TINY_PDF } = require('./doc-service-mock');

/**
 * A service that counts: the shared document mock (doc-service-mock.js) keeps
 * `apiHits`, every method and path that reaches /api/pdf/*, and the assertions
 * count off it. Its /paper.pdf is the PDF the URL half opens.
 */
function startCountingService() {
  return startDocService();
}

/** 把扩展指向 mock，并给它一张登录凭证 —— PDF 功能的账号闸要的就是这张。 */
async function connectExtension(context, base) {
  const worker = await getServiceWorker(context);
  await worker.evaluate(async ({ base }) => {
    await chrome.storage.sync.set({ enablePdfTranslation: true });
    await chrome.storage.local.remove([
      'comicToken', 'comicTokenExpiresAt', 'comicAccountCache', 'pdfJobs', 'pdfUrlOps',
    ]);
    await chrome.storage.local.set({
      comicApiBase: base,
      comicToken: 'test-token',
      comicTokenExpiresAt: Date.now() + 3600_000,
    });
  }, { base });
  return worker;
}

/** 这台扩展记下来的任务收据。点击之前必须是空的。 */
function jobRecords(worker) {
  return worker.evaluate(() => chrome.storage.local.get('pdfJobs').then(r => r.pdfJobs || []));
}

const BAR = '#ai-translator-auto-bar';

test.describe('PDF offer bar', () => {
  test('arXiv /pdf/ offers a button and sends nothing until it is pressed', async ({ context, page }) => {
    const service = await startCountingService();
    try {
      await connectExtension(context, service.base);
      // 真的一份 PDF，只是字节来自本地路由：Chrome 照样认魔数、挂查看器，内容
      // 脚本落在 contentType 是 application/pdf 的文档上，和线上那一页一样。
      await context.route('https://arxiv.org/pdf/**', route => route.fulfill({
        status: 200, contentType: 'application/pdf', body: TINY_PDF,
      }));

      await page.goto('https://arxiv.org/pdf/2401.00001');

      // 条子自己出来了，而且是 offer 那一模式 —— 不是整页翻译的追问。那一问在
      // 这一页上办不到（正文在外进程的 <embed> 里），内置表的 never 把它按住了。
      await expect(page.locator(`${BAR}[data-mode="offer"]`)).toBeVisible({ timeout: 15000 });
      await expect(page.locator(`${BAR} [data-act="translate"]`)).toBeVisible();

      // PRD 的那一句：到此为止，往任务接口的请求一个都没有。
      expect(service.state.apiHits).toEqual([]);
      const worker = await getServiceWorker(context);
      expect(await jobRecords(worker)).toEqual([]);

      // 而「记住这个站点」不在场：这一条问的是一份文档，不是一个站点的长期规则。
      await expect(page.locator(`${BAR} .ai-translator-auto-remember`)).toBeHidden();
    } finally {
      await service.close();
    }
  });

  test('pressing translate is what starts the job, and one press starts one', async ({ context, page }) => {
    const service = await startCountingService();
    try {
      const worker = await connectExtension(context, service.base);
      // 工作者要自己去取这份 PDF 的字节，而它的 fetch 不经过 Playwright 的路由，
      // 所以这一半跑在 mock 自己的地址上 —— 那个地址它拿得到。
      await page.goto(`${service.base}/paper.pdf`);

      await expect(page.locator(`${BAR}[data-mode="offer"]`)).toBeVisible({ timeout: 15000 });
      expect(service.state.apiHits).toEqual([]);

      await page.locator(`${BAR} [data-act="translate"]`).click();

      // 点下去之后才有第一个请求，而且只有一趟：一次上传票据、一次创建。
      await expect.poll(() => service.state.apiHits.filter(h => h === 'POST /api/pdf/jobs').length,
        { timeout: 20000 }).toBe(1);
      expect(service.state.apiHits.filter(h => h === 'POST /api/pdf/uploads')).toHaveLength(1);

      // 条子当场收走 —— 接力的是通知，和右键菜单那一路一样。
      await expect(page.locator(`${BAR}[data-mode="offer"]`)).toBeHidden();

      const records = await jobRecords(worker);
      expect(records.length).toBeGreaterThan(0);
      expect(records[0].fileName).toBe('paper.pdf');
    } finally {
      await service.close();
    }
  });

  test('dismissing it takes it away and does not send anything either', async ({ context, page }) => {
    const service = await startCountingService();
    try {
      await connectExtension(context, service.base);
      await page.goto(`${service.base}/paper.pdf`);

      await expect(page.locator(`${BAR}[data-mode="offer"]`)).toBeVisible({ timeout: 15000 });
      await page.locator(`${BAR} [data-act="dismiss"]`).click();

      await expect(page.locator(`${BAR}[data-mode="offer"]`)).toBeHidden();
      // 「不用」是一个回答，不是一次推迟：它不该顺手把任务派出去，也不该再冒出来。
      await page.waitForTimeout(1000);
      expect(service.state.apiHits).toEqual([]);
      await expect(page.locator(`${BAR}[data-mode="offer"]`)).toBeHidden();
    } finally {
      await service.close();
    }
  });
});
