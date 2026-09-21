// Blab Translation 漫画翻译 —— 认页
//
// 只回答三件事：这张 <img> 是不是一页漫画、它是哪一页、用户点的是哪一张。不碰
// DOM，不认识任务，也不引用这一族里的任何别人——所以它可以先读。
//
// 共用的常量也放在这里。轮询节奏和超时是任务流在用的，但它们说的是「一页要多久」，
// 和尺寸阈值是一类东西。
(function() {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT;
  if (!ctx) return;
  // 这一族共用的架子，说明见 content/content-comic-translation.js 顶上。
  const comic = (ctx.comic = ctx.comic || {});

  const t = ctx.t;

  // The result URL is presigned and short-lived, so the swap is a view state,
  // not a permanent edit: a reload brings back the original.
  const POLL_FAST_MS = 2000;
  const POLL_SLOW_MS = 5000;
  const FAST_WINDOW_MS = 30_000;
  // How long to keep polling before giving up and refunding. Has to sit ABOVE
  // the server's own redraw budget (~280s of gateway ladder) or the client
  // abandons a page that is about to be delivered — which refunds the points but
  // also throws away a redraw that was already paid for upstream.
  const JOB_TIMEOUT_MS = 300_000;
  // How long to wait for the server to confirm an abandon. Generous — the whole
  // point of awaiting it is to learn what happened to the reservation — but
  // finite, because the alternative is an overlay that never says anything
  // again.
  const ABANDON_TIMEOUT_MS = 15_000;
  // Same ceiling the server enforces before it charges anything. Re-encoding a
  // page above this is wasted work.
  const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

  // Below this an <img> is furniture — an icon, a nav thumbnail, or the decoy
  // overlay anti-copy sites stretch across the artwork.
  const MIN_PAGE_NATURAL_EDGE = 300;
  const MIN_PAGE_RENDERED_EDGE = 120;
  // Two images at the same spot are one image and one decoy, never two pages.
  const SAME_SPOT_RATIO = 0.7;
  // A spread shows two pages that are close in size but rarely identical; a
  // page and the banner beside it are not close at all.
  const SPREAD_AREA_RATIO = 0.5;

  // -------------------------------------------------------------------------
  // Page identity
  // -------------------------------------------------------------------------

  /**
   * A short, stable name for the PAGE an <img> is showing.
   *
   * The src string is the only thing that identifies a page, and it is a bad
   * thing to keep: readers that decrypt their own artwork hand the <img> a
   * multi-megabyte `data:` URL, and this feature needs that identity in three
   * places at once — an in-memory map for a reading session, a stored record
   * for the next one, and a stamp on the element itself. Keeping the string
   * three times over is what made `data:` and `blob:` sources unresumable:
   * rather than pay it, the record simply refused to be written.
   *
   * So the identity is a fingerprint instead — a 53-bit hash of the length and
   * up to three 8KB windows of the payload. Bounded work per call, which is
   * what makes it safe to compute on demand rather than cached against the
   * element, and nothing anywhere retains the source string it came from.
   *
   * A fingerprint, deliberately not a digest: two pages of one chapter differ
   * in length and diverge within the first compressed block, so the windows
   * settle it. What it is not built to survive is an adversary choosing the
   * bytes — nothing here is a security boundary, and the cost of a collision
   * is one wrong picture on screen.
   */
  const ID_SAMPLE_CHARS = 8192;

  function hash53(str) {
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  }

  function pageIdOfSrc(src) {
    if (!src) return '';
    let sample = src;
    if (src.length > ID_SAMPLE_CHARS * 3) {
      const middle = src.length >> 1;
      sample = src.slice(0, ID_SAMPLE_CHARS)
        + src.slice(middle - (ID_SAMPLE_CHARS >> 1), middle + (ID_SAMPLE_CHARS >> 1))
        + src.slice(-ID_SAMPLE_CHARS);
    }
    // The length is part of the name, not just of the hash input: two pages
    // have to differ in both to collide.
    return `${src.length.toString(36)}-${hash53(sample)}`;
  }

  function pageIdOf(img) {
    return img ? pageIdOfSrc(img.currentSrc || img.src || '') : '';
  }

  /** The element this <img> is wearing the stamp of, if it is swapped. */
  const PAGE_ID_ATTR = 'data-ai-translator-page-id';

  const COMIC_MODES = ['translate', 'colorize', 'translate_colorize'];

  function normalizeMode(mode) {
    return COMIC_MODES.includes(mode) ? mode : 'translate';
  }

  /** The in-progress label: a colorize that says "translating" reads as a bug. */
  function statusText(mode) {
    if (mode === 'colorize') return t('comicColorizing');
    if (mode === 'translate_colorize') return t('comicTranslatingColorizing');
    return t('comicTranslating');
  }

  /** The badge's "show me the result again" label, per product. */
  function resultLabel(mode) {
    if (mode === 'colorize') return 'comicShowColorized';
    if (mode === 'translate_colorize') return 'comicShowColorizedTranslation';
    return 'comicShowTranslation';
  }

  /**
   * The mode a click actually means for THIS image.
   *
   * Asking to colorize a page that is currently showing its translation means
   * "colorize what I am looking at". The job still runs from the original
   * pixels — a second redraw stacked on the first compounds two generations of
   * artefacts — so the two products are asked for together instead, which is
   * exactly what the server's combined mode is for.
   *
   * Only what is ON SCREEN counts. Flipping the badge back to the original and
   * then asking for a colorize is a request about the original, and a purchase
   * made an hour ago that is not currently displayed is not context either.
   * That keeps the rule learnable: you get the thing you are looking at, plus
   * the thing you asked for.
   */
  function modeForShownResult(entry, requested) {
    if (!entry || !entry.badge || !entry.showingTranslation) return requested;
    const shown = normalizeMode(entry.mode);
    return shown === requested ? requested : 'translate_colorize';
  }

  function comicEnabled() {
    return !!(ctx.settings && ctx.settings.enableComicTranslation);
  }

  // The right-click target — the only unambiguous way to know WHICH image the
  // user meant — is tracked once for the whole content script, in
  // content-utils.js, because image OCR needs the same answer.

  function naturalArea(img) {
    return (img.naturalWidth || 0) * (img.naturalHeight || 0);
  }

  const renderedArea = ctx.renderedArea;

  /** Artwork, or page furniture? */
  function isComicPage(img) {
    if (!img || img.tagName !== 'IMG' || !img.isConnected) return false;
    if (Math.min(img.naturalWidth || 0, img.naturalHeight || 0) < MIN_PAGE_NATURAL_EDGE) return false;
    const rect = img.getBoundingClientRect();
    return Math.min(rect.width, rect.height) >= MIN_PAGE_RENDERED_EDGE;
  }

  /** How much of the smaller of two images the intersection covers, 0–1. */
  function overlapRatio(a, b) {
    const rectA = a.getBoundingClientRect();
    const rectB = b.getBoundingClientRect();
    const width = Math.min(rectA.right, rectB.right) - Math.max(rectA.left, rectB.left);
    const height = Math.min(rectA.bottom, rectB.bottom) - Math.max(rectA.top, rectB.top);
    if (width <= 0 || height <= 0) return 0;
    const smaller = Math.min(rectA.width * rectA.height, rectB.width * rectB.height);
    return smaller > 0 ? (width * height) / smaller : 0;
  }

  /**
   * Trade a decoy for the artwork behind it.
   *
   * `info.srcUrl` reports whatever the browser hit-tested under the cursor, so
   * on those sites it names the placeholder. The real page is the
   * higher-resolution <img> sharing its box.
   */
  function resolveRealPage(img) {
    if (isComicPage(img)) return img;
    const covered = Array.from(document.images).filter(candidate =>
      candidate !== img && isComicPage(candidate) && overlapRatio(img, candidate) > SAME_SPOT_RATIO
    );
    if (!covered.length) return img;
    return covered.reduce((best, candidate) => (naturalArea(candidate) > naturalArea(best) ? candidate : best));
  }

  function findImage(srcUrl) {
    const lastContextImage = ctx.getLastContextImage();
    // The click point outranks srcUrl. The two disagree exactly when the site is
    // hiding the artwork behind something else, and the point is still right.
    if (lastContextImage &&
        (isComicPage(lastContextImage) || matchesSrc(lastContextImage, srcUrl))) {
      return resolveRealPage(lastContextImage);
    }
    const candidates = Array.from(document.images).filter(img => matchesSrc(img, srcUrl));
    if (!candidates.length) {
      return lastContextImage;
    }
    // Fall back to the largest match — on a page that reuses a src, the comic
    // page itself is the big one and the rest are navigation thumbnails.
    const best = candidates.reduce((winner, img) => (renderedArea(img) > renderedArea(winner) ? img : winner));
    return resolveRealPage(best);
  }

  function matchesSrc(img, srcUrl) {
    if (!srcUrl) return false;
    if (ctx.imageMatchesSrc(img, srcUrl)) return true;
    // A swapped image no longer carries its original src, but it is still the
    // element the user right-clicked.
    const stamped = img.getAttribute(PAGE_ID_ATTR);
    return !!stamped && stamped === pageIdOfSrc(srcUrl);
  }

  /**
   * The comic page(s) on screen, for the entry points that have no click to go
   * on.
   *
   * Returns more than one only for a spread: two pages shown side by side are
   * one thing to read, and translating half of it is not a useful outcome.
   */
  function pickComicImages() {
    const onScreen = Array.from(document.images).filter(img => {
      if (!isComicPage(img)) return false;
      const rect = img.getBoundingClientRect();
      // In the viewport, not merely in the document: a chapter page can hold
      // dozens of images and only the ones being read are meant.
      if (rect.bottom <= 0 || rect.top >= window.innerHeight) return false;
      if (rect.right <= 0 || rect.left >= window.innerWidth) return false;
      const style = getComputedStyle(img);
      return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) !== 0;
    });
    if (!onScreen.length) return [];

    // Highest resolution first, then drop anything sharing a box with something
    // already kept — otherwise a decoy overlay becomes a second paid job.
    const distinct = [];
    onScreen
      .slice()
      .sort((a, b) => naturalArea(b) - naturalArea(a))
      .forEach(img => {
        if (!distinct.some(kept => overlapRatio(kept, img) > SAME_SPOT_RATIO)) distinct.push(img);
      });

    const largest = Math.max(...distinct.map(renderedArea));
    return distinct.filter(img => renderedArea(img) >= largest * SPREAD_AREA_RATIO);
  }

  // 别的文件要用的，都从这张架子上取。
  Object.assign(comic, {
    ABANDON_TIMEOUT_MS, FAST_WINDOW_MS, JOB_TIMEOUT_MS, MAX_UPLOAD_BYTES, PAGE_ID_ATTR,
    POLL_FAST_MS, POLL_SLOW_MS, comicEnabled, findImage, modeForShownResult, normalizeMode,
    pageIdOf, pageIdOfSrc, pickComicImages, renderedArea, resultLabel, statusText,
  });
})();
