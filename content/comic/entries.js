// Blab Translation 漫画翻译 —— 页面台账
//
// 这个文档对每一页漫画知道些什么，以及原图和译图之间怎么换。台账按「页」记而不是
// 按 <img> 元素记，原因写在 tracked 上面——漫画阅读器回收 <img>，按元素记会把上一页
// 的进度卡画到这一页上。
(function() {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT;
  if (!ctx) return;
  // 这一族共用的架子，说明见 content/content-comic-translation.js 顶上。
  const comic = (ctx.comic = ctx.comic || {});

  // -------------------------------------------------------------------------
  // Entries
  // -------------------------------------------------------------------------

  /**
   * Everything this document knows about a page, keyed by page id.
   *
   * Comic readers recycle a small pool of <img>s: turning the page reassigns
   * `src` on an element that is already in the DOM, and collapses the outgoing
   * one to zero size instead of removing it. Keyed by element, a job stayed
   * bound to the slot rather than to the page — so once the pool wrapped
   * around, the reader got the previous page's progress card drawn over the
   * page they were looking at, a badge offering the wrong page's result, and a
   * translate click that silently re-showed that result instead of starting a
   * job. Keying by the page makes a recycled slot simply unknown again, which
   * is what it is.
   *
   * An entry has two lifetimes in one object. The receipt — which job, which
   * mode, bought or not — is cheap and lasts as long as the document. The
   * BINDING — the element, its original src, the DOM swap, the card, the
   * badge — lasts only while the reader is looking at that page, and
   * detachEntry drops all of it. That is what keeps a long reading session
   * flat: only the handful of pages actually on screen hold anything big.
   *
   * A Map, not a WeakMap: the key is no longer something the collector can
   * reason about, so MAX_TRACKED bounds it instead. Insertion order is
   * recency — re-tracking an entry re-inserts it.
   */
  const tracked = new Map();
  const MAX_TRACKED = 60;

  /** Is `img` still showing the page `entry` is about? */
  function entryMatchesImage(entry, img = entry.img) {
    if (!img || !img.isConnected) return false;
    // While the result is in place the element's src names the redraw, not the
    // page — the swap itself is the proof of identity.
    if (entry.swap && entry.swap.isApplied(img)) return true;
    return comic.pageIdOf(img) === entry.pageId;
  }

  /**
   * The entry for what this <img> is showing right now, or null.
   *
   * Two ways in, because a swapped image no longer carries the src it is keyed
   * by: the element is stamped with its page id when the result goes in. Both
   * answers are then checked against the element, since a recycled slot can
   * still be wearing the stamp of the page it used to hold.
   */
  function entryFor(img) {
    const direct = tracked.get(comic.pageIdOf(img));
    if (direct && entryMatchesImage(direct, img)) return direct;
    const stamped = img.getAttribute(comic.PAGE_ID_ATTR);
    if (stamped) {
      const entry = tracked.get(stamped);
      if (entry && entryMatchesImage(entry, img)) return entry;
    }
    return null;
  }

  function trackEntry(entry) {
    if (!entry.pageId) return;
    // Started here rather than at load: on a page with nothing tracked the
    // watcher has no work to do, so it should not be listening yet.
    comic.watchPageSwaps();
    tracked.delete(entry.pageId);
    tracked.set(entry.pageId, entry);
    if (tracked.size <= MAX_TRACKED) return;
    for (const [victimId, victim] of tracked) {
      if (tracked.size <= MAX_TRACKED) break;
      // A running job is still spending the user's allowance; forgetting it
      // would strand the result it is about to hand back.
      if (victim === entry || victim.running) continue;
      detachEntry(victim);
      tracked.delete(victimId);
      // Evicting the entry must not evict what it bought. The record is still
      // in storage and the reader can still turn back to that page, so the
      // purchase moves onto the list reconcileImage consults for pages this
      // document does not otherwise know — otherwise a long chapter turns a
      // paid redraw back into a page the reader is invited to buy again.
      comic.rememberPurchase(victim);
    }
  }

  /**
   * Let go of the <img> this entry is bound to, without giving up the job.
   *
   * Called when the reader turns the page and the slot is handed to another
   * one. The redraw is paid for and the server will finish it either way, so
   * the job runs on — but nothing may keep drawing on an element that now
   * shows a different page. A card still counting for a running job is only
   * hidden, so that turning back brings the same card, with its clock intact,
   * rather than a second one.
   */
  function detachEntry(entry) {
    if (entry.detached) return;
    entry.destroyBadge?.();
    if (entry.overlay) {
      if (entry.running) entry.overlay.setHidden(true);
      else { entry.overlay.destroy(); entry.overlay = null; }
    }
    // Hand the element back the markup we took from it. Only the parts still
    // holding what we left there — see swapSource.
    entry.swap?.revert();
    entry.swap = null;
    // Nothing that costs memory may outlive the binding: on a reader that
    // inlines its pages this string is the page itself, in base64.
    entry.originalSrc = null;
    entry.img = null;
    entry.detached = true;
  }

  /** Bind the entry to the element now showing its page. */
  function bindEntry(entry, img) {
    entry.img = img;
    // Re-read rather than remembered: the same page can come back in a
    // different slot, whose markup is its own. Skipped while a swap is in
    // place, where `src` names the redraw instead of the page.
    if (!entry.swap) entry.originalSrc = img.currentSrc || img.src;
    entry.detached = false;
    if (entry.overlay) {
      entry.overlay.rebind(img);
      entry.overlay.setHidden(false);
    }
  }

  /** A fresh entry for the page `img` is showing right now. */
  function newEntry(img) {
    const originalSrc = img.currentSrc || img.src;
    return {
      img,
      pageId: comic.pageIdOfSrc(originalSrc),
      originalSrc,
      // A blob: URL dies with the document that minted it, so this page can
      // never be recognised again — see rememberJob.
      blobSourced: /^blob:/i.test(originalSrc),
      showingTranslation: false,
      detached: false,
      swap: null
    };
  }

  /** Show the redraw, reversibly. */
  function showResult(entry, url) {
    entry.swap?.revert();
    entry.swap = comic.swapSource(entry.img, url, entry.pageId);
    entry.showingTranslation = true;
  }

  /** Put the page back the way the site had it. */
  function showOriginal(entry) {
    entry.swap?.revert();
    entry.swap = null;
    entry.showingTranslation = false;
  }

  /**
   * What the server is asked to do to the page. Everything downstream — the
   * overlay wording, the badge labels, the cross-page record — keys off this,
   * so an unknown value is coerced here rather than checked in four places.
   */

  // 别的文件要用的，都从这张架子上取。
  Object.assign(comic, {
    bindEntry, detachEntry, entryFor, entryMatchesImage, newEntry, showOriginal, showResult,
    trackEntry, tracked,
  });
})();
