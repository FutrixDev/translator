// Blab Translation 漫画翻译 —— 整章自动翻
//
// 长条阅读页（一章的页一张接一张竖着排，comic.hasComicStack()）上，读者亲手翻了
// 一页之后，同一页面上其余还没翻的页自己排队翻：先翻离视口最近的，同时最多
// AUTO_CONCURRENCY 张在跑；懒加载、往下滚才出现的页，载入后也排进来。
//
// 花的是账户的页数，所以每一步都有边：
// - 只在读者自己发起过一次之后才开始（arm），而且只在长条阅读页上；单图文章、
//   网格、翻页式阅读器都不会因为一次点击而扩散。
// - 每页每次 arm 只自动派一次；失败的留给本章汇总标的「重试失败」。
// - 只看视口上下各 AUTO_LOOKAHEAD_SCREENS 屏以内的页，读者不往下读就不往下翻。
// - 任何一页没翻成（失败、取消、拒绝登录或扣费）就停下（disarm），不让同一个
//   拒绝在每一页上再问一遍；「全部取消」也停下。读者再发起一次就重新开始。
// - 之前买过、这次文档里认得的页（memory.js 的 known pages）走免费的找回，不再下单。
(function() {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT;
  if (!ctx) return;
  // 这一族共用的架子，说明见 content/content-comic-translation.js 顶上。
  const comic = (ctx.comic = ctx.comic || {});

  // Pages redrawn at once. Each is a server job against the allowance, and the
  // reader reads one page at a time; two keeps the next page ready without
  // buying the chapter ahead of them.
  const AUTO_CONCURRENCY = 2;
  // How far past the viewport a page may be and still be ordered, in screens.
  const AUTO_LOOKAHEAD_SCREENS = 1;
  // Scroll and load events arrive in bursts; one scan per burst is enough.
  const SCAN_DELAY_MS = 200;

  // null while off; otherwise what the reader asked for when they started.
  let armed = null;
  // Pages this arm has ordered or looked at and left alone, by page id.
  const attempted = new Set();
  let inFlight = 0;
  let scanTimer = null;
  let listening = false;

  /**
   * The reader started a page by hand. On a long-strip reader, the rest of
   * the chapter follows. Called from every user entry, never from a restore.
   */
  function autoArm({ pageUrl, targetLang, mode, consent = false }, pages) {
    if (armed) return;
    if (!comic.hasComicStack()) return;
    armed = { pageUrl, targetLang, mode: comic.normalizeMode(mode), consent };
    attempted.clear();
    // The reader's own pages are theirs, even before their entries exist.
    pages.forEach(img => attempted.add(comic.pageIdOf(img)));
    listen();
    scheduleScan();
  }

  function autoDisarm() {
    armed = null;
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = null;
  }

  function listen() {
    if (listening) return;
    listening = true;
    window.addEventListener('scroll', scheduleScan, { passive: true, capture: true });
    window.addEventListener('resize', scheduleScan, { passive: true });
    // A lazy page has no size until it loads, so it cannot be judged a page
    // before this fires. `load` does not bubble; capture sees it.
    document.addEventListener('load', (event) => {
      if (event.target && event.target.tagName === 'IMG') scheduleScan();
    }, true);
  }

  /** Something on the page may have changed: look again, once per burst. */
  function scheduleScan() {
    if (!armed || scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      pump();
    }, SCAN_DELAY_MS);
  }

  /**
   * The pages to order next, nearest the viewport first: every distinct
   * comic page within the lookahead that nothing on this document owns yet.
   */
  function autoCandidates() {
    const height = window.innerHeight;
    const reach = height * AUTO_LOOKAHEAD_SCREENS;
    return comic.distinctPages(Array.from(document.images).filter(comic.isComicPage))
      .filter(({ img, rect }) => {
        if (rect.bottom < -reach || rect.top > height + reach) return false;
        if (rect.right <= 0 || rect.left >= window.innerWidth) return false;
        const style = getComputedStyle(img);
        return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) !== 0;
      })
      .map(page => ({ ...page, distance: distanceToViewport(page.rect, height) }))
      .sort((a, b) => a.distance - b.distance)
      .map(page => page.img);
  }

  function distanceToViewport(rect, height) {
    if (rect.bottom < 0) return -rect.bottom;
    if (rect.top > height) return rect.top - height;
    return 0;
  }

  function pump() {
    if (!armed || !comic.comicEnabled()) return;
    const queue = autoCandidates();
    while (armed && inFlight < AUTO_CONCURRENCY && queue.length) {
      const img = queue.shift();
      const pageId = comic.pageIdOf(img);
      if (attempted.has(pageId)) continue;
      attempted.add(pageId);
      // Already this document's: running, finished, failed or cancelled. Each
      // has its own way back (the chip, the pill's Retry), none of them here.
      if (comic.entryFor(img)) continue;
      // Bought before and known: put it back for free instead of buying again.
      if (comic.claimKnownPage(pageId, img)) continue;
      run(img);
    }
  }

  /**
   * A page's run ended, by hand or by us. One that did not end translated
   * stops the chapter: whatever stopped it — a refused charge, no sign-in, a
   * cancel, a service failure — would most likely stop the next one too, and
   * ask the reader again for it.
   */
  function autoSettle(img) {
    const entry = comic.entryFor(img);
    if (!(entry && entry.badge && !entry.cancelled)) autoDisarm();
  }

  async function run(img) {
    inFlight += 1;
    const order = armed;
    try {
      await comic.translateImage(img, order);
      if (armed === order) autoSettle(img);
    } catch (error) {
      console.warn('Blab Translation: comic auto translation failed', error);
      if (armed === order) autoDisarm();
    } finally {
      inFlight -= 1;
      scheduleScan();
    }
  }

  // 别的文件要用的，都从这张架子上取。
  Object.assign(comic, {
    AUTO_CONCURRENCY, autoArm, autoCandidates, autoDisarm, autoSettle,
  });
})();
