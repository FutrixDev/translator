// Blab Translation 漫画翻译 —— 整章自动翻
//
// 长条阅读页（一章的页一张接一张竖着排，comic.hasComicStack()）上，同一页面上
// 还没翻的页自己排队翻：先翻离视口最近的，同时最多 AUTO_CONCURRENCY 张在跑；
// 懒加载、往下滚才出现的页，载入后也排进来。
//
// 开始（arm）只有两条路：
// - 读者亲手翻了一页（右键、悬停条、悬浮球、Alt+M），其余的页跟上；
// - 一进来就开始（watchAutoEntry）：和网页一样，这个站点开着自动翻（popup 的
//   「自动翻译此站点」，autoTranslate.recallOn()），读者没暂停、没切到看原文，
//   漫画功能开着**而且已登录**（comicEnabled() 是 READY）。没登录的不自己开始：
//   一次没人点过的跳转去登录，比一条提示更打扰。
//
// 花的是账户的页数，所以每一步都有边：
// - 只在长条阅读页上；单图文章、网格、翻页式阅读器都不会自己扩散。
// - 每页每次 arm 只自动派一次；失败的留给本章汇总标的「重试失败」。
// - 只看视口上下各 AUTO_LOOKAHEAD_SCREENS 屏以内的页，读者不往下读就不往下翻。
// - 任何一页没翻成（失败、取消、拒绝扣费、额度用完）就停下（disarm），不让同一个
//   拒绝在每一页上再问一遍；「全部取消」、悬浮球的「显示原图」也停下。
// - **一个文档只 arm 一次**（entryUsed）：停下之后，一进来就开始的那条路在这个
//   文档里不再开 —— 否则一次拒绝之后每滚一下就又买一页。不按网址算：不少长条
//   阅读器边滚边把页码写进网址（#page=5、replaceState 改路径），网址一变就会重开。
//   读者亲手再发起一次照常开始；整页跳到下一章是新文档，重新开始。暂停、看原文、
//   关掉站点造成的停下不算：读者点「继续」，这一章接着翻，和网页文字一样。
// - 只在读者看得见的标签页里开始：后台打开的、预渲染的标签页不花页数，切到前台
//   （visibilitychange）再开始。
// - 之前买过、这次文档里认得的页（memory.js 的 known pages）走免费的找回，不再下单。
// - 服务端在动用付费页数之前先要一次确认（409，comic.promptCharge）：免费额度
//   之外的每一笔仍然是读者点出来的。
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
  // Whether this document has armed, by either path. See the header.
  let entryUsed = false;
  // Whether the on-entry path is installed (top frame, after auto-translate).
  let watching = false;
  // Whether memory.js has read back this device's earlier purchases.
  let recordsLoaded = false;

  /**
   * The reader started a page by hand. On a long-strip reader, the rest of
   * the chapter follows. Called from every user entry, never from a restore.
   */
  function autoArm({ pageUrl, targetLang, mode, consent = false }, pages, { onEntry = false } = {}) {
    if (armed) return;
    if (!comic.hasComicStack()) return;
    armed = { pageUrl, targetLang, mode: comic.normalizeMode(mode), consent, onEntry };
    entryUsed = true;
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
    if (scanTimer || !(armed || entryPending())) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      if (!armed) armOnEntry();
      pump();
    }, SCAN_DELAY_MS);
  }

  /**
   * Start translating on entry, the way pages are: on a site whose auto rule is
   * on. Top frame only, after ctx.setupAutoTranslate(). The strip is not on the
   * page at document_end (its images have no size yet), so this listens to the
   * same scroll and image-load bursts the chapter does and asks again on each.
   */
  function watchAutoEntry(knownPagesLoaded) {
    if (watching) return;
    watching = true;
    listen();
    // Not before the purchases this document can put back are known: ordering
    // one of them would buy it again (pump's claimKnownPage).
    // Signed out or switched off at load, memory.js read nothing (false): the
    // purchases stay unknown, so this document never starts on entry.
    knownPagesLoaded.then((loaded) => {
      if (!loaded) return;
      recordsLoaded = true;
      // A tab opened in the background, or prerendered, starts when it is shown.
      document.addEventListener('visibilitychange', scheduleScan);
      ctx.autoTranslate.onStateChange(() => {
        // Paused, switched to the originals, or the site turned off: a chapter
        // this path started stops with it, and starts again when the reader
        // lets the page translate again (Continue), as the page's text does.
        // One the reader started stays theirs.
        if (armed && armed.onEntry && !autoEntryAllowed()) {
          autoDisarm();
          entryUsed = false;
        }
        scheduleScan();
      });
    }).catch((error) => {
      console.error('Blab Translation: the comic strip will not start on entry', error);
    });
  }

  /**
   * Everything the on-entry path needs but the strip and the address: the
   * site's auto rule, not paused or showing originals, the feature on and
   * signed in. The comic hint asks it too: where this will start by itself,
   * telling the reader the shortcut is noise.
   */
  function autoEntryAllowed() {
    if (!watching || !ctx.autoTranslate.recallOn()) return false;
    if (ctx.state.translationsVisible === false) return false;
    return comic.comicEnabled();
  }

  /** Whether the on-entry path may still start in this document, now. */
  function entryPending() {
    return recordsLoaded && !entryUsed && document.visibilityState === 'visible' && autoEntryAllowed();
  }

  function armOnEntry() {
    if (!entryPending()) return;
    autoArm({ pageUrl: location.href, targetLang: comic.comicTargetLang(), mode: 'translate' }, [], { onEntry: true });
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
    AUTO_CONCURRENCY, autoArm, autoCandidates, autoDisarm, autoEntryAllowed, autoSettle, watchAutoEntry,
  });
})();
