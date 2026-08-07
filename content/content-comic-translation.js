// AI Translator Content Script — Comic page translation
//
// Pick a comic page → the server redraws it with the text translated → the
// result replaces the image in place, with a badge to flip back to the
// original. Unlike every other feature in this extension, this one runs on our
// servers against the user's account, so it can fail for reasons text
// translation never has: not signed in, out of free pages for the month, or an
// image we are not allowed to fetch.
//
// There are two ways in: the right-click menu on an image, and the float ball.
// Both are asked for — nothing offers itself. An earlier build floated the two
// buttons onto any image the pointer crossed, which on a normal page is every
// article photo, so the offer is now made only where the user asked for it.
//
// Comic hosts routinely hide the artwork under a decoy image to poison what
// right-click reports, which is why the click POINT, not `info.srcUrl`, decides
// which image was meant.
//
// The network lives in the service worker (background/comic-client.js); this
// file owns the DOM and the poll loop. Polling from here is deliberate — a
// service worker is torn down after ~30s idle and a redraw takes longer than
// that, while each poll message we send also keeps the worker awake.
(function() {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT;
  if (!ctx) return;

  const t = ctx.t;
  const escapeHtml = ctx.escapeHtml;

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
    return pageIdOf(img) === entry.pageId;
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
    const direct = tracked.get(pageIdOf(img));
    if (direct && entryMatchesImage(direct, img)) return direct;
    const stamped = img.getAttribute(PAGE_ID_ATTR);
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
    watchPageSwaps();
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
      rememberPurchase(victim);
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
      pageId: pageIdOfSrc(originalSrc),
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
    entry.swap = swapSource(entry.img, url, entry.pageId);
    entry.showingTranslation = true;
  }

  /** Put the page back the way the site had it. */
  function showOriginal(entry) {
    entry.swap?.revert();
    entry.swap = null;
    entry.showingTranslation = false;
  }

  let lastContextImage = null;

  /**
   * What the server is asked to do to the page. Everything downstream — the
   * overlay wording, the badge labels, the cross-page record — keys off this,
   * so an unknown value is coerced here rather than checked in four places.
   */
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

  // The right-click target is the only unambiguous way to know WHICH image the
  // user meant: a page can show the same src a dozen times (thumbnail grids,
  // lazy-load placeholders) and info.srcUrl cannot tell them apart.
  document.addEventListener('contextmenu', (event) => {
    // A synthetic contextmenu carries no cursor position, and letting one
    // through would throw away the target of the real right-click that follows.
    if (!event.isTrusted) return;
    lastContextImage = imageAtPoint(event.clientX, event.clientY);
  }, true);

  function naturalArea(img) {
    return (img.naturalWidth || 0) * (img.naturalHeight || 0);
  }

  function renderedArea(img) {
    const rect = img.getBoundingClientRect();
    return rect.width * rect.height;
  }

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
   * The image the user is pointing at — not necessarily the topmost one.
   *
   * Anti-copy sites stack a tiny transparent image over the artwork and stretch
   * it to the same box, so hit-testing lands on the decoy by design. Resolution
   * is what tells the page apart from the thing covering it.
   */
  function imageAtPoint(x, y) {
    if (typeof document.elementsFromPoint !== 'function') return null;
    const images = document.elementsFromPoint(x, y).filter(el => el.tagName === 'IMG');
    if (!images.length) return null;
    return images.reduce((best, img) => (naturalArea(img) > naturalArea(best) ? img : best));
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
    // The click point outranks srcUrl. The two disagree exactly when the site is
    // hiding the artwork behind something else, and the point is still right.
    if (lastContextImage && lastContextImage.isConnected &&
        (isComicPage(lastContextImage) || matchesSrc(lastContextImage, srcUrl))) {
      return resolveRealPage(lastContextImage);
    }
    const candidates = Array.from(document.images).filter(img => matchesSrc(img, srcUrl));
    if (!candidates.length) {
      return lastContextImage && lastContextImage.isConnected ? lastContextImage : null;
    }
    // Fall back to the largest match — on a page that reuses a src, the comic
    // page itself is the big one and the rest are navigation thumbnails.
    const best = candidates.reduce((winner, img) => (renderedArea(img) > renderedArea(winner) ? img : winner));
    return resolveRealPage(best);
  }

  function matchesSrc(img, srcUrl) {
    if (!srcUrl) return false;
    if (img.currentSrc === srcUrl || img.src === srcUrl) return true;
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

  // -------------------------------------------------------------------------
  // Overlay
  // -------------------------------------------------------------------------

  /**
   * A fixed-position panel pinned to the image's rect.
   *
   * Fixed rather than a wrapper element around the <img>: reparenting an image
   * inside someone else's layout breaks galleries, lightboxes and lazy-loaders
   * in ways that are impossible to test for.
   */
  function createOverlay(img) {
    // Mutable, not the captured parameter: a reader that recycles its <img>
    // pool can take this element away and give it back while one job runs, and
    // the card that comes back has to be the same card — same clock, same
    // progress — pinned to whichever element now holds the page.
    let host = img;
    let hidden = false;

    const overlay = document.createElement('div');
    overlay.className = 'ai-translator-comic-overlay';
    overlay.innerHTML = `
      <div class="ai-translator-comic-card">
        <div class="ai-translator-comic-spinner"></div>
        <div class="ai-translator-comic-status"></div>
        <div class="ai-translator-comic-timer" hidden></div>
        <div class="ai-translator-comic-bar"><span></span></div>
        <div class="ai-translator-comic-actions"></div>
      </div>
    `;
    document.body.appendChild(overlay);

    const timerElement = overlay.querySelector('.ai-translator-comic-timer');
    // Absolute start, not an accumulating counter: the tab can be backgrounded
    // for minutes — which stops rAF — and the elapsed time still has to be right
    // the instant it comes back.
    let timerFrom = 0;
    let timerShown = '';

    let frame = 0;
    const track = () => {
      if (!overlay.isConnected) return;
      if (!host.isConnected) {
        destroy();
        return;
      }
      if (hidden) {
        frame = requestAnimationFrame(track);
        return;
      }
      const rect = host.getBoundingClientRect();
      overlay.style.top = `${rect.top}px`;
      overlay.style.left = `${rect.left}px`;
      overlay.style.width = `${rect.width}px`;
      overlay.style.height = `${rect.height}px`;
      if (timerFrom) {
        const next = formatElapsed(Date.now() - timerFrom);
        // Only touch the DOM on the second boundary; this runs at 60fps.
        if (next !== timerShown) {
          timerShown = next;
          timerElement.textContent = next;
        }
      }
      // The image can move for reasons no event reports (CSS animation, a
      // sibling loading in), so the rect is re-read every frame.
      frame = requestAnimationFrame(track);
    };
    frame = requestAnimationFrame(track);

    function destroy() {
      cancelAnimationFrame(frame);
      overlay.remove();
    }

    return {
      element: overlay,
      destroy,
      /** Follow the job onto the element that now holds its page. */
      rebind(next) {
        host = next;
      },
      /**
       * Take the card off the screen without ending the job behind it.
       *
       * The reader turned away from a page that is still being redrawn: the
       * card belongs to that page, not to the one now in the slot.
       */
      setHidden(next) {
        hidden = next;
        overlay.style.display = next ? 'none' : '';
      },
      /**
       * Show a running clock, counting from `from`.
       *
       * A redraw takes 60–120s and the progress bar is an estimate, so the clock
       * is the only honest signal the user has that anything is still happening.
       * `from` is the job's creation time rather than "now" — a job picked back
       * up after the reader went to the next page and returned has to show its
       * real age, not restart at zero.
       */
      startTimer(from) {
        timerFrom = from || Date.now();
        timerShown = '';
        timerElement.hidden = false;
      },
      stopTimer() {
        timerFrom = 0;
        timerElement.hidden = true;
      },
      setStatus(text, { progress = null, busy = true } = {}) {
        overlay.querySelector('.ai-translator-comic-status').textContent = text;
        overlay.classList.toggle('is-busy', busy);
        const bar = overlay.querySelector('.ai-translator-comic-bar');
        bar.hidden = progress === null;
        if (progress !== null) {
          bar.firstElementChild.style.width = `${Math.round(progress * 100)}%`;
        }
      },
      setActions(actions) {
        const host = overlay.querySelector('.ai-translator-comic-actions');
        host.innerHTML = '';
        actions.forEach(({ label, variant, onClick }) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = `ai-translator-comic-btn${variant === 'primary' ? ' is-primary' : ''}`;
          button.textContent = label;
          button.addEventListener('click', onClick);
          host.appendChild(button);
        });
      },
      setError(message) {
        overlay.classList.add('is-error');
        overlay.classList.remove('is-busy');
        overlay.querySelector('.ai-translator-comic-status').textContent = message;
        overlay.querySelector('.ai-translator-comic-bar').hidden = true;
        timerFrom = 0;
        timerElement.hidden = true;
      }
    };
  }

  /** Elapsed time as m:ss — the scale a redraw actually runs at. */
  function formatElapsed(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const minutes = Math.floor(total / 60);
    return `${minutes}:${String(total % 60).padStart(2, '0')}`;
  }

  /**
   * The persistent badge on a translated image.
   *
   * Both versions stay one click apart because a redraw is a judgement call —
   * the user may want to check a panel against the original art.
   */
  function attachToggleBadge(entry) {
    const badge = document.createElement('button');
    badge.type = 'button';
    badge.className = 'ai-translator-comic-badge';
    document.body.appendChild(badge);

    const showResultLabel = resultLabel(entry.mode);
    const render = () => {
      badge.textContent = entry.showingTranslation ? t('comicShowOriginal') : t(showResultLabel);
    };
    render();

    badge.addEventListener('click', () => {
      if (entry.showingTranslation) showOriginal(entry);
      else showResult(entry, entry.resultUrl);
      render();
    });

    let frame = 0;
    const track = () => {
      if (!entry.img.isConnected) {
        cancelAnimationFrame(frame);
        badge.remove();
        return;
      }
      const rect = entry.img.getBoundingClientRect();
      const visible = rect.width > 0 && rect.bottom > 0 && rect.top < window.innerHeight;
      badge.style.display = visible ? '' : 'none';
      badge.style.top = `${rect.top + 8}px`;
      badge.style.left = `${rect.left + 8}px`;
      frame = requestAnimationFrame(track);
    };
    frame = requestAnimationFrame(track);

    entry.badge = badge;
    // For the run-again-in-a-different-mode path, which replaces the swap and
    // its badge; the rAF loop above only ends on its own when the image leaves
    // the DOM.
    entry.destroyBadge = () => {
      cancelAnimationFrame(frame);
      badge.remove();
      entry.badge = null;
      entry.destroyBadge = null;
    };
  }

  /**
   * Point an <img> at a different URL, reversibly.
   *
   * `srcset` and a parent `<picture>` both outrank `src`, so setting src alone
   * leaves responsive markup showing the untranslated page — on exactly the
   * image-heavy sites this feature targets. Everything the swap touches is
   * recorded together with the value it was given.
   *
   * `revert()` then puts back only the attributes still holding that value,
   * which is what makes it safe to call at any point. Undoing the swap on a
   * badge click finds all of them untouched and restores the lot. Undoing it
   * because the reader turned the page finds `src` and `srcset` already
   * rewritten by the site's own code — those must be left alone, or the
   * previous page reappears over the one being read — while `sizes` and the
   * `<picture>` sources are still stripped, because the site never touches
   * them and only this can put them back.
   */
  function swapSource(img, url, pageId) {
    const touched = [];
    const write = (element, name, value) => {
      const was = element.getAttribute(name);
      if (value === null) element.removeAttribute(name);
      else element.setAttribute(name, value);
      touched.push({ element, name, was, left: value });
    };

    if (img.parentElement && img.parentElement.tagName === 'PICTURE') {
      img.parentElement.querySelectorAll('source').forEach(source => write(source, 'srcset', null));
    }
    write(img, 'srcset', null);
    // `sizes` is stripped alongside srcset — left on its own it makes the image
    // pick a candidate width for markup that is no longer there.
    write(img, 'sizes', null);
    // Right-clicking a swapped image reports the presigned URL, which matches
    // nothing on the page; this is how the element is found again. The page id
    // rather than the src, because on a reader that inlines its pages the src
    // is megabytes of DOM attribute.
    write(img, PAGE_ID_ATTR, pageId);
    write(img, 'src', url);

    return {
      isApplied: (element = img) => element === img && img.getAttribute('src') === url,
      revert() {
        // In reverse, so `src` is settled before the markup that outranks it.
        for (let i = touched.length - 1; i >= 0; i--) {
          const { element, name, was, left } = touched[i];
          if (element.getAttribute(name) !== left) continue;
          if (was === null) element.removeAttribute(name);
          else element.setAttribute(name, was);
        }
        touched.length = 0;
      }
    };
  }

  // -------------------------------------------------------------------------
  // Job flow
  // -------------------------------------------------------------------------

  function sendMessage(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: { code: 'extension_context', message: chrome.runtime.lastError.message } });
            return;
          }
          resolve(response || { ok: false, error: { code: 'no_response', message: '' } });
        });
      } catch (error) {
        resolve({ ok: false, error: { code: 'extension_context', message: error?.message || String(error) } });
      }
    });
  }

  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  /**
   * Resolve with null if `promise` has not settled within `ms`.
   *
   * For calls whose answer decides what the user is told: an unanswered one has
   * to become a known-unknown rather than a wait with no end.
   */
  function withTimeout(promise, ms) {
    return Promise.race([promise, sleep(ms).then(() => null)]);
  }

  // -------------------------------------------------------------------------
  // Cross-page job memory
  // -------------------------------------------------------------------------

  /**
   * A redraw runs 60–120s, which is longer than anyone will sit and watch one
   * page. So the job has to outlive the navigation: click Translate, read ahead,
   * come back, and find the page waiting in its translated form.
   *
   * The server never needed us present for this — the container runs the ladder
   * and calls back whether or not anyone is polling. What was missing is the
   * client's half: `tracked` is a WeakMap keyed by DOM elements, and a
   * navigation discards every one of them along with the jobId that could have
   * asked for the result again. So the minimum needed to re-attach — which
   * image, which job, when it started — is mirrored into chrome.storage.local.
   *
   * Keyed by the artwork, not the page URL: readers rewrite their own URL
   * between visits to the same chapter (query strings, hashes, SPA routes)
   * while the artwork stays put. By page id rather than by src, so a reader
   * that inlines a multi-megabyte `data:` URL costs the same twenty bytes as
   * one that links to a CDN — those pages used to be refused a record
   * entirely, on the grounds that storing them was not worth it.
   *
   * Records survive success on purpose. Coming back to an already-translated
   * page is the common case, and re-polling a finished job is free: it mints a
   * fresh presigned URL for a result that is already bought and paid for.
   */
  const JOB_STORE_KEY = 'comicJobs';
  // Comfortably longer than a reading session, comfortably shorter than the
  // 7-day life of the stored result.
  const RECORD_TTL_MS = 24 * 60 * 60 * 1000;
  // A ceiling on how much of the user's storage quota this feature may hold.
  const MAX_RECORDS = 60;

  function storageGet(key) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(key, (result) => {
          resolve(chrome.runtime.lastError ? {} : (result || {}));
        });
      } catch {
        resolve({});
      }
    });
  }

  function storageSet(items) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.set(items, () => {
          void chrome.runtime.lastError;
          resolve();
        });
      } catch {
        resolve();
      }
    });
  }

  /**
   * Every live record, expired ones already dropped and older shapes folded in.
   *
   * Two spellings came before this one: a bare src key from before modes
   * existed, and `${mode}|${src}` after. Both carry the src verbatim, which is
   * the thing the page id replaced, so both are re-keyed on the way in — and
   * the payload goes with them, since the first write after this drops the map
   * back to storage in the new shape. Records the reader never comes back to
   * age out on their own inside RECORD_TTL_MS.
   */
  async function loadRecords() {
    const stored = await storageGet(JOB_STORE_KEY);
    const records = stored[JOB_STORE_KEY];
    if (!records || typeof records !== 'object') return {};
    const cutoff = Date.now() - RECORD_TTL_MS;
    const live = {};
    Object.keys(records).forEach((key) => {
      const record = records[key];
      if (!record || typeof record.jobId !== 'string' || !(record.createdAt > cutoff)) return;
      const pageId = record.pageId || (record.imageSrc ? pageIdOfSrc(record.imageSrc) : '');
      if (!pageId) return;
      const { imageSrc, ...rest } = record;
      live[recordKey(record.mode, pageId)] = { ...rest, pageId };
    });
    return live;
  }

  /**
   * Serialize every read-modify-write of the record map.
   *
   * chrome.storage has no compare-and-set, and the whole map is one value — so
   * two updates that interleave both load the same snapshot and the second
   * writes the first one away. That is not hypothetical here: a two-page spread
   * runs both jobs through `Promise.all`, so both call saveRecord at almost the
   * same moment, and the loser's page would be unreachable on the next page
   * load — an already-paid-for redraw the reader would be invited to buy again.
   *
   * One chain is enough for one document. Two tabs translating the same image
   * concurrently could still interleave; that needs a real CAS, and it costs a
   * duplicate record rather than a lost one, so it is not worth the machinery.
   */
  let recordQueue = Promise.resolve();

  function updateRecords(mutate) {
    recordQueue = recordQueue.then(async () => {
      const records = await loadRecords();
      if (mutate(records) === false) return;
      await storageSet({ [JOB_STORE_KEY]: records });
    }).catch(() => {});
    return recordQueue;
  }

  /**
   * One record per (mode, page). The two products on a page are two separate
   * purchases, and keying by page alone made the second one overwrite the
   * record of the first — after a reload, switching back to the overwritten
   * mode had no job id to recover and bought the page again.
   */
  function recordKey(mode, pageId) {
    return `${normalizeMode(mode)}|${pageId}`;
  }

  function saveRecord(record) {
    return updateRecords((records) => {
      records[recordKey(record.mode, record.pageId)] = record;
      const keys = Object.keys(records);
      if (keys.length > MAX_RECORDS) {
        keys
          .sort((a, b) => records[a].createdAt - records[b].createdAt)
          .slice(0, keys.length - MAX_RECORDS)
          .forEach((key) => { delete records[key]; });
      }
    });
  }

  function dropRecord(pageId, mode) {
    if (!pageId) return Promise.resolve();
    return updateRecords((records) => {
      const key = recordKey(mode, pageId);
      if (!(key in records)) return false;
      delete records[key];
    });
  }

  /**
   * Mirror this job to storage. Deliberately not awaited by its callers — the
   * write is a convenience for a later page load, and making the poll loop wait
   * on it would put a storage round-trip in front of the user's progress.
   */
  function rememberJob(entry, status) {
    // completedJobId first: it is the id the current mode actually finished
    // under. entry.jobId can still name a previous run's job — a failed mode B
    // whose id survived into a recovery of mode A — and persisting that id as
    // A's success would make A unresumable after a reload.
    const jobId = entry.completedJobId || entry.jobId;
    if (!jobId || !entry.pageId) return;
    // A `blob:` URL is minted by the document that made it and dies with it, so
    // a record naming one could never match anything again. A `data:` URL is
    // the opposite case and used to be refused alongside it: the same page
    // decodes to the same bytes on every visit, and now that a record holds an
    // id of those bytes rather than the bytes themselves, remembering it costs
    // what any other page costs.
    if (entry.blobSourced) return;
    saveRecord({
      jobId,
      mode: entry.mode,
      pageId: entry.pageId,
      pageUrl: location.href,
      createdAt: entry.jobStartedAt || Date.now(),
      // Selection on the next page load goes by what the reader last SAW, not
      // by when each job was bought — see resumeComicJobs.
      displayedAt: Date.now(),
      status
    });
  }

  /**
   * The element showing a given page — by the same rule the context-menu path
   * uses.
   *
   * Taking the first DOM match is wrong on exactly the sites this feature is
   * for: a chapter page that reuses the artwork in a thumbnail strip has
   * several matches, and the thumbnail usually comes first. Swapping a paid
   * redraw into a 60px thumbnail loses it, and the real page never gets it.
   *
   * No resolveRealPage here, unlike findImage: a page id is only ever recorded
   * for a page that already went through it, so this *is* the real page and
   * re-resolving could only walk away from it.
   */
  function findImageByPageId(pageId) {
    if (!pageId) return null;
    const candidates = Array.from(document.images).filter(
      img => img.isConnected && (img.getAttribute(PAGE_ID_ATTR) === pageId || pageIdOf(img) === pageId)
    );
    if (!candidates.length) return null;
    return candidates.reduce(
      (winner, img) => (renderedArea(img) > renderedArea(winner) ? img : winner)
    );
  }

  /**
   * Purchases this document has not put back on screen yet, by page id.
   *
   * Seeded from storage at load and topped up by trackEntry when an entry is
   * evicted, this is the list reconcileImage checks whenever a page it does not
   * recognise appears. A purchase leaves the list the moment it is claimed.
   */
  const knownPages = new Map();

  /**
   * Re-attach to jobs that were started before this document existed.
   *
   * The sweep here only covers what is already in the DOM. Everything after it
   * — artwork lazy-loaded ten minutes into a chapter, a page turned back to on
   * a reader that never reloads — arrives through the same `src` write that
   * watchPageSwaps is listening for, so that is what finds it. The previous
   * shape, a second MutationObserver that gave up after 30 seconds, could only
   * ever catch the start of a session.
   */
  async function resumeComicJobs() {
    if (!comicEnabled()) return;
    const records = await loadRecords();
    Object.keys(records).forEach((key) => {
      const record = records[key];
      const group = knownPages.get(record.pageId) || [];
      group.push(record);
      knownPages.set(record.pageId, group);
    });
    if (!knownPages.size) return;
    watchPageSwaps();

    // Largest match per page, for the thumbnail-strip reason above.
    const onScreen = new Map();
    Array.from(document.images).forEach((img) => {
      if (!img.isConnected) return;
      const pageId = pageIdOf(img);
      if (!knownPages.has(pageId)) return;
      const best = onScreen.get(pageId);
      if (!best || renderedArea(img) > renderedArea(best)) onScreen.set(pageId, img);
    });
    onScreen.forEach((img, pageId) => claimKnownPage(pageId, img));
  }

  /** Put a purchase this document did not make back on the page showing it. */
  function claimKnownPage(pageId, img = findImageByPageId(pageId)) {
    const group = knownPages.get(pageId);
    if (!group || !img) return false;
    knownPages.delete(pageId);
    // "Newest" is what the reader last had on screen, not what was bought last:
    // switching back to an older purchase refreshes its displayedAt, so a
    // reload restores the view they left, not the later receipt. Records from
    // before the field fall back to their creation time.
    const shownAt = (r) => r.displayedAt || r.createdAt;
    const newest = group.reduce((a, b) => (shownAt(b) > shownAt(a) ? b : a));
    resumeRecord(img, newest, group);
    return true;
  }

  /** Hand an entry's purchases back to the known-pages list before dropping it. */
  function rememberPurchase(entry) {
    const byMode = entry.completedByMode || {};
    const group = Object.keys(byMode)
      .filter(mode => byMode[mode])
      .map(mode => ({
        jobId: byMode[mode],
        mode,
        pageId: entry.pageId,
        createdAt: entry.jobStartedAt || Date.now(),
        displayedAt: Date.now(),
        status: 'succeeded'
      }));
    if (group.length) knownPages.set(entry.pageId, group);
  }

  // -------------------------------------------------------------------------
  // Following the reader
  // -------------------------------------------------------------------------

  /**
   * Keep the swaps attached to their pages as the reader turns them.
   *
   * A comic reader is not an ordinary page. It recycles a small pool of <img>
   * elements — turning the page reassigns `src` on an element already in the
   * DOM and collapses the outgoing one to zero size — and it never reloads the
   * document, rewriting its own URL through a patched pushState instead. So
   * resumeComicJobs, which runs once at load and then stops, is the wrong shape
   * for it twice over: nothing tells it a page has turned, and there is no
   * second load to be the trigger.
   *
   * Watching `src` covers both directions. A slot handed to another page has to
   * let go of the job it was showing, or that job's card is drawn over a page
   * it has nothing to do with. And a page turned back to has to get its
   * translation back, which is free — the result is already bought.
   */
  let pageSwapObserver = null;
  // Long enough that a hidden tab is not doing per-mutation work, short enough
  // that the queue never becomes the reason memory grows.
  const HIDDEN_FLUSH_MS = 500;

  function watchPageSwaps() {
    if (pageSwapObserver) return;
    const pending = new Set();
    let scheduled = false;

    const flush = () => {
      scheduled = false;
      const images = Array.from(pending);
      pending.clear();
      images.forEach(reconcileImage);
    };

    pageSwapObserver = new MutationObserver((records) => {
      records.forEach((record) => {
        if (record.target.tagName === 'IMG') pending.add(record.target);
      });
      if (!pending.size || scheduled) return;
      // Coalesced: a page turn rewrites several slots in one go, and our own
      // swap is a `src` write that lands right back here.
      scheduled = true;
      // rAF does not fire in a background tab, and a reader left open in one
      // still turns pages — an image carousel, a preloader — so the queue would
      // grow for as long as the tab stayed hidden and then flush all at once on
      // return. A timer keeps it draining; the frame is only worth waiting for
      // when there is a frame to draw.
      if (document.hidden) setTimeout(flush, HIDDEN_FLUSH_MS);
      else requestAnimationFrame(flush);
    });
    pageSwapObserver.observe(document.documentElement, {
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'srcset']
    });
  }

  function reconcileImage(img) {
    if (!img.isConnected) return;
    // Whatever was bound to this element, if the element is not showing it any
    // more then the slot has been handed to another page.
    tracked.forEach((entry) => {
      if (entry.img === img && !entry.detached && !entryMatchesImage(entry, img)) {
        detachEntry(entry);
      }
    });

    const entry = entryFor(img);
    if (!entry) {
      // Nothing this document translated — but a page can be bought and still
      // be unknown here: by a previous session, or by an entry this one evicted
      // to stay bounded. Either way the redraw exists and putting it back is
      // free, where letting the page look untranslated invites paying twice.
      claimKnownPage(pageIdOf(img), img);
      return;
    }
    if (entry.running) {
      // Still being redrawn: give the reader back the card they left, clock and
      // all, and let the poll loop carry on where it is.
      if (entry.detached) bindEntry(entry, img);
      return;
    }
    if (!entry.resultUrl && !entry.completedJobId) return;
    // Two ways to arrive here, and one repair. Either the page has come back
    // into a slot, or it never left one and the reader's own code has rewritten
    // `src` anyway — a page turn assigns every slot, including the slot that is
    // being re-shown, so a result already bought and displayed is quietly
    // painted over with the original.
    const paintedOver = entry.showingTranslation && !(entry.swap && entry.swap.isApplied(img));
    if (entry.detached || paintedOver) restoreEntry(entry, img);
  }

  /**
   * Put a finished result back on the page that has come back into view.
   *
   * Never a new job: the redraw is bought, so the worst case here is one poll
   * to mint a presigned URL when the one we hold has aged out — the same free
   * recovery a later page load would do.
   */
  const RESTORE_POLL_COOLDOWN_MS = 15_000;

  async function restoreEntry(entry, img) {
    if (entry.restoring) return;
    entry.restoring = true;
    try {
      bindEntry(entry, img);
      // The reader had flipped this one back to the original before turning
      // away. Give them the badge to flip it again, and leave the page alone.
      if (!entry.showingTranslation) {
        if (!entry.badge) attachToggleBadge(entry);
        return;
      }
      let url = entry.resultUrl;
      if (!url || !(await preloadImage(url))) {
        // A presigned URL that has aged out is re-minted by polling the job,
        // which is free — but only worth asking once in a while. A page the
        // reader is flicking past, or one whose job the server has genuinely
        // lost, would otherwise put a request on the network for every turn.
        if (!entry.completedJobId) return;
        if (Date.now() - (entry.lastRestorePollAt || 0) < RESTORE_POLL_COOLDOWN_MS) return;
        entry.lastRestorePollAt = Date.now();
        const polled = await sendMessage({ type: 'COMIC_JOB_POLL', jobId: entry.completedJobId });
        if (!polled.ok || polled.data.status !== 'succeeded' || !polled.data.resultUrl) return;
        url = polled.data.resultUrl;
        if (!(await preloadImage(url))) return;
      }
      // The reader can turn away again while a poll is in flight; putting the
      // page back then would land it on whatever is in the slot now.
      if (entry.detached || entry.img !== img || !entryMatchesImage(entry, img)) return;
      entry.resultUrl = url;
      showResult(entry, url);
      if (!entry.badge) attachToggleBadge(entry);
      // The reader is looking at this one again, so it is the state a reload
      // should come back to — see the displayedAt note in resumeComicJobs.
      rememberJob(entry, 'succeeded');
    } finally {
      entry.restoring = false;
    }
  }

  async function resumeRecord(img, record, group = [record]) {
    const existing = entryFor(img);
    // Something on this document already owns the image — a job the user just
    // started, or a swap that already happened.
    if (existing && (existing.running || existing.badge)) return;

    const entry = {
      ...newEntry(img),
      jobId: record.jobId,
      jobStartedAt: record.createdAt,
      // Records written before modes existed are all translations.
      mode: normalizeMode(record.mode),
      // Every finished purchase on this image, whichever mode: asking for one
      // of them later recovers its job instead of reserving again.
      completedByMode: {}
    };
    group.forEach((r) => {
      if (r.status === 'succeeded' && r.jobId) {
        entry.completedByMode[normalizeMode(r.mode)] = r.jobId;
      }
    });
    entry.running = true;
    entry.cancelled = false;
    entry.detached = false;
    trackEntry(entry);

    const overlay = createOverlay(img);
    entry.overlay = overlay;
    overlay.setStatus(statusText(entry.mode), { progress: 0.5 });
    // Only for a job still in flight. A finished one is a single poll to mint a
    // URL, and clocking it from its original creation would open the card at
    // "47:12" for work that ended an hour ago.
    if (record.status !== 'succeeded') overlay.startTimer(record.createdAt);

    try {
      if (record.status === 'succeeded') {
        // Already bought. Poll only to mint a presigned URL, since the one from
        // last time expired long before the reader came back.
        const polled = await sendMessage({ type: 'COMIC_JOB_POLL', jobId: record.jobId });
        if (polled.ok && polled.data.status === 'succeeded' && polled.data.resultUrl) {
          entry.completedJobId = record.jobId;
          await finishSuccess({ entry, overlay, job: polled.data });
          return;
        }
        // Nothing to show, and the reader did not ask for anything on this page
        // load — take the card away rather than opening with an error. A network
        // blip keeps the record; a real answer means it will never resolve.
        overlay.destroy();
        if (polled.ok || polled.error.code !== 'network_error') {
          dropRecord(record.pageId, record.mode);
          // The id seeded into the stash from this record is equally dead.
          delete entry.completedByMode[normalizeMode(record.mode)];
        }
        return;
      }
      await pollJob({ entry, overlay, jobId: record.jobId, startedAt: record.createdAt });
    } finally {
      entry.running = false;
    }
  }

  /** Context-menu entry: the browser tells us which image was clicked. */
  async function startComicTranslation({ srcUrl, pageUrl, targetLang, mode }) {
    const img = findImage(srcUrl);
    if (!img) {
      showDetachedError(t('comicImageNotFound'));
      return;
    }
    await translateImage(img, { pageUrl, targetLang, mode });
  }

  /**
   * Float-ball and popup entry: nothing was clicked, so the page is found by
   * looking at what is on screen.
   */
  async function startComicPageTranslation({ pageUrl, targetLang, mode } = {}) {
    const images = pickComicImages();
    if (!images.length) {
      showDetachedError(t('comicNoPageFound'));
      return;
    }
    const lang = targetLang || comicTargetLang();
    // In parallel: a spread is two independent jobs and running them one after
    // the other would double the wait for no reason.
    await Promise.all(images.map(img => translateImage(img, { pageUrl, targetLang: lang, mode })));
  }

  function comicTargetLang() {
    const settings = ctx.settings || {};
    if (settings.comicTargetLang) return settings.comicTargetLang;
    return ctx.getEffectiveTargetLang ? ctx.getEffectiveTargetLang() : settings.targetLang;
  }

  async function translateImage(img, { pageUrl, targetLang, mode }) {
    mode = normalizeMode(mode);
    // Keyed by the page, so a recycled slot answers null here rather than
    // handing back whatever the reader had in it two pages ago.
    const existing = entryFor(img);
    if (existing && existing.running) {
      // The page came back while its job was still going: put the card back
      // where the reader can see it, and let the poll loop carry on.
      if (existing.detached) bindEntry(existing, img);
      return;
    }
    // Before every check below: a click on a page that already shows a result
    // is about that result, so the two products are asked for as one job.
    mode = modeForShownResult(existing, mode);
    if (existing && existing.badge && existing.mode === mode) {
      // Already done in this mode. Re-running would charge for the same page again.
      if (existing.img !== img) bindEntry(existing, img);
      showResult(existing, existing.resultUrl);
      return;
    }
    const entry = existing || newEntry(img);
    // The same page can be back in a different slot than the one it was
    // translated in; the entry follows the page, so it has to be re-pointed.
    if (entry.img !== img || entry.detached) bindEntry(entry, img);
    // Claimed BEFORE anything below can await: the decode wait yields to the
    // event loop, and a second trigger landing in that window has to bounce off
    // `running` rather than pass the guard and start a sibling job under its
    // own idempotency key — two reservations for one user intent.
    entry.running = true;
    entry.cancelled = false;
    trackEntry(entry);

    // A retry after an error leaves the previous overlay sitting on the image;
    // two stacked cards over one page is not a state worth having.
    if (entry.overlay) entry.overlay.destroy();
    const overlay = createOverlay(img);
    entry.overlay = overlay;

    try {
      if (entry.badge) {
        // Same page, a different product — by now `mode` already carries what
        // is on screen as well as what was asked for. That is a NEW job, but
        // the finished one it replaces stays bought: its job id lives on in
        // `completedByMode`, so coming back to that mode later is a free
        // re-poll, and a failure in the new mode costs nothing already paid
        // for.
        entry.destroyBadge?.();
        // The new job must start from the ORIGINAL pixels — both here and in
        // the imageUrl createJob sends. Redrawing the previous result would
        // stack two generations of artefacts on one page, which is why the
        // combined mode above exists: the server does both passes from the
        // original in a single job.
        showOriginal(entry);
        entry.jobId = null;
        // Cleared, not carried over: it names the OTHER mode's finished job,
        // and recoverResult would hand its result back as if it were this
        // mode's. The per-mode stash below is what keeps it reachable.
        entry.completedJobId = null;
        entry.resultUrl = null;
        // The src assignment above is asynchronous. A fast needs-page-bytes
        // turnaround would otherwise capture the canvas while the <img> still
        // shows the previous result — or nothing at all — so the restore has
        // to finish decoding before the job is allowed to proceed.
        try {
          await img.decode();
        } catch {
          // A source that will not decode is capturePageBytes' problem to report.
        }
      }

      entry.completedByMode = entry.completedByMode || {};
      entry.mode = mode;
      // A fresh user action: whatever job id a previous run left behind names
      // OLD work — a failed sibling mode, an abandoned attempt — and letting it
      // survive would let rememberJob persist it as this mode's record.
      entry.jobId = null;
      // A mode that already finished on this image resumes from its stashed job
      // id — recoverResult re-polls it for a fresh URL instead of paying again.
      entry.completedJobId = entry.completedByMode[mode] || entry.completedJobId || null;

      // A job that reached `succeeded` but never made it onto the page is done
      // and paid for — only the download failed. Go back for the result rather
      // than ordering a second redraw of the same page.
      if (entry.completedJobId && await recoverResult({ entry, overlay })) return;
      // Falling through means the receipt named a job the server no longer has.
      // The click still stands, so order the page rather than making the reader
      // ask a second time for something that can no longer be delivered.
      // One operationId per user action, reused across every retry inside this
      // run: the server treats it as an idempotency key, so a sign-in round-trip
      // or a re-upload settles against the same reservation instead of charging
      // twice. A *new* click gets a new id on purpose — reusing one would hand
      // back the previous (failed) job instead of trying again.
      entry.operationId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      await runJob({ entry, overlay, pageUrl, targetLang });
    } finally {
      entry.running = false;
    }
  }

  /**
   * Re-fetch the result of a job that already succeeded.
   *
   * finishSuccess can fail after the money is spent: a presigned URL that
   * expired while the user was away, a dropped download, bytes that will not
   * decode. The redraw is in the bucket either way, and polling the job mints a
   * fresh URL for it — so a retry costs nothing, where falling through to
   * createJob would charge for the same page twice.
   *
   * Returns false, and only false, when the receipt turned out to name a job
   * the server will never hand back — the one case where ordering the page is
   * the right thing to do next.
   */
  // Codes that say nothing about whether the job still exists. Treating any of
  // them as a dead receipt would throw away a purchase over a dropped
  // connection or a signed-out moment.
  const INCONCLUSIVE_POLL = ['network_error', 'no_response', 'extension_context', 'unauthorized'];

  async function recoverResult({ entry, overlay }) {
    overlay.setStatus(statusText(entry.mode), { progress: 1 });
    const polled = await sendMessage({ type: 'COMIC_JOB_POLL', jobId: entry.completedJobId });

    if (polled.ok && polled.data.status === 'succeeded' && polled.data.resultUrl) {
      await finishSuccess({ entry, overlay, job: polled.data });
      return true;
    }

    // Keep the id unless the answer settles it. Only a job the server names as
    // over, or one it no longer has at all, is a receipt worth throwing away —
    // and it has to be thrown away in three places at once, since the entry,
    // the per-mode stash and the stored record would each hand it straight back
    // on the next click or the next page load.
    const dead = polled.ok
      ? ['failed', 'abandoned', 'expired'].includes(polled.data.status)
      : !INCONCLUSIVE_POLL.includes(polled.error.code);
    if (!dead) {
      if (polled.ok) {
        overlay.setError(t('comicResultUnavailable'));
        offerDismiss(overlay);
      } else {
        showJobError(overlay, polled.error);
      }
      return true;
    }
    entry.completedJobId = null;
    if (entry.completedByMode) delete entry.completedByMode[entry.mode];
    dropRecord(entry.pageId, entry.mode);
    return false;
  }

  async function runJob({ entry, overlay, pageUrl, targetLang }) {
    // One label for the whole run. The stages underneath — preparing, uploading
    // pixels, queued, downloading the result — are ours, not the reader's, and
    // narrating them made a 90-second wait look like four separate things going
    // wrong. The clock carries the "still working" signal instead.
    const startedAt = Date.now();
    overlay.setStatus(statusText(entry.mode), { progress: 0 });
    overlay.startTimer(startedAt);

    let created = await createJob({ entry, pageUrl, targetLang, imageBase64: null });

    if (!created.ok && created.error.code === 'unauthorized') {
      // Sign-in is the one interruption that is genuinely the user's turn, so
      // the clock stops rather than counting their typing as redraw time.
      overlay.stopTimer();
      const signedIn = await promptSignIn(overlay);
      if (!signedIn) return;
      overlay.setStatus(statusText(entry.mode), { progress: 0 });
      overlay.startTimer(Date.now());
      created = await createJob({ entry, pageUrl, targetLang, imageBase64: null });
    }

    if (!created.ok && created.error.needsPageBytes) {
      // The worker could not read the file — a blob:/data: src, or an origin
      // that refuses a request without a Referer. The page has already decoded
      // it either way, so send the pixels we can see.
      overlay.setStatus(statusText(entry.mode), { progress: 0.05 });
      // Only from the element still holding this page. Sign-in or a slow fetch
      // can have taken long enough for the reader to turn away, and a recycled
      // slot would hand over another page's pixels under this job's name.
      const imageBase64 = entryMatchesImage(entry, entry.img) ? capturePageBytes(entry.img) : null;
      if (!imageBase64) {
        overlay.setError(t('comicImageUnavailable'));
        offerDismiss(overlay);
        return;
      }
      created = await createJob({ entry, pageUrl, targetLang, imageBase64 });
    }

    if (!created.ok) {
      showJobError(overlay, created.error);
      return;
    }

    // The visible clock and the timeout budget deliberately have different
    // origins. The clock starts when the reader clicked, because that is the
    // wait they are actually having. The budget starts HERE, because it exists
    // to match the server's own redraw budget — counting a sign-in, an image
    // fetch and an upload against it would abandon a redraw the server was
    // still perfectly willing to finish, and a slow sign-in could burn the
    // whole allowance before the job even existed.
    const jobStartedAt = Date.now();
    entry.jobId = created.data.jobId;
    entry.jobStartedAt = jobStartedAt;
    // From here the job exists server-side and will finish with or without this
    // document, so it becomes findable from the next page load.
    rememberJob(entry, 'running');

    await pollJob({ entry, overlay, jobId: entry.jobId, startedAt: jobStartedAt });
  }

  /**
   * Watch a job to a terminal state.
   *
   * Shared by a fresh run and by one picked back up on a later page load, which
   * is why `startedAt` is a parameter rather than `Date.now()`: the timeout is
   * measured from when the *job* was created, so a resumed job cannot be granted
   * a second full budget the server has no intention of honouring.
   */
  async function pollJob({ entry, overlay, jobId, startedAt }) {
    overlay.setActions([{
      label: t('comicCancel'),
      onClick: () => {
        entry.cancelled = true;
        sendMessage({ type: 'COMIC_JOB_ABANDON', jobId });
        dropRecord(entry.pageId, entry.mode);
        overlay.destroy();
      }
    }]);

    while (Date.now() - startedAt < JOB_TIMEOUT_MS) {
      if (entry.cancelled) return;
      const elapsed = Date.now() - startedAt;
      await sleep(elapsed < FAST_WINDOW_MS ? POLL_FAST_MS : POLL_SLOW_MS);
      if (entry.cancelled) return;

      const polled = await sendMessage({ type: 'COMIC_JOB_POLL', jobId });
      if (!polled.ok) {
        // A blip between polls is not a failed job — the reservation is still
        // held server-side, so keep waiting rather than abandoning it.
        if (polled.error.code === 'network_error') continue;
        dropRecord(entry.pageId, entry.mode);
        showJobError(overlay, polled.error);
        return;
      }

      const job = polled.data;
      if (job.status === 'succeeded' && job.resultUrl) {
        await finishSuccess({ entry, overlay, job });
        return;
      }
      if (job.status === 'failed' || job.status === 'abandoned') {
        // Terminal and refunded. Leaving the record would re-open this card on
        // every future visit to the page.
        dropRecord(entry.pageId, entry.mode);
        showJobError(overlay, job.error || { code: 'failed', message: '' });
        return;
      }

      // Server progress is coarse (queued/running/done). Creeping it with
      // elapsed time keeps the bar honest about the stage while still moving.
      const estimate = Math.min(0.9, 0.1 + elapsed / JOB_TIMEOUT_MS * 1.6);
      overlay.setStatus(statusText(entry.mode), {
        progress: Math.max(job.progress || 0, estimate)
      });
    }

    // Give the page back rather than leaving a reservation stranded. Awaited,
    // because what to tell the user depends on what the server says: the old
    // fire-and-forget claimed "this page was not counted" without ever
    // learning whether the release landed.
    //
    // Bounded, because sendMessage settles only when the background answers and
    // this one goes over the network. A service worker evicted mid-call, or a
    // request that hangs, would leave the overlay frozen on "translating" — the
    // job has already timed out at this point, so that is the exact moment the
    // user most needs to be told something. Timing out here is itself an
    // unconfirmed refund, which is what the null falls through to below.
    const abandoned = await withTimeout(
      sendMessage({ type: 'COMIC_JOB_ABANDON', jobId }),
      ABANDON_TIMEOUT_MS
    );

    // The client gave up, but the redraw may have finished a moment earlier —
    // abandon leaves a succeeded job alone and hands back the result. Charged,
    // and worth showing rather than throwing away.
    if (abandoned && abandoned.ok && abandoned.data.status === 'succeeded' && abandoned.data.resultUrl) {
      await finishSuccess({ entry, overlay, job: abandoned.data });
      return;
    }

    // Only claim the refund when the server confirmed it. Otherwise say the
    // truthful thing — the reservation may still be held, and the reconciliation
    // sweep will return it — instead of a guess about the user's money.
    const confirmed = !!abandoned && abandoned.ok && abandoned.data.status === 'abandoned';
    // Only forget the job once the server agrees it is dead. An unconfirmed
    // abandon may well still be running, and leaving the record is what lets a
    // later page load pick it up and show the page the user paid for.
    if (confirmed) dropRecord(entry.pageId, entry.mode);
    overlay.setError(confirmed ? t('comicTimeout') : t('comicTimeoutUnconfirmed'));
    offerDismiss(overlay);
  }

  function createJob({ entry, pageUrl, targetLang, imageBase64 }) {
    return sendMessage({
      type: 'COMIC_JOB_CREATE',
      job: {
        operationId: entry.operationId,
        // For the *worker* to fetch, not the service — the service only ever
        // receives bytes. Skipped once we already hold them.
        imageUrl: imageBase64 ? null : entry.originalSrc,
        imageBase64,
        pageUrl: pageUrl || location.href,
        sourceLang: 'auto',
        targetLang,
        mode: entry.mode
      }
    });
  }

  /** Resolve true once `url` has decoded, false if it never will. */
  function preloadImage(url) {
    return new Promise((resolve) => {
      const preload = new Image();
      preload.onload = () => resolve(true);
      preload.onerror = () => resolve(false);
      preload.src = url;
    });
  }

  async function finishSuccess({ entry, overlay, job }) {
    // Before the download, not after: from here on the redraw exists and has
    // been charged for, so every later failure has to be recoverable by going
    // back to this job rather than by buying another one.
    entry.completedJobId = job.jobId || entry.jobId || null;
    // Stashed per mode, and never cleared: switching the page to the other
    // product must not orphan a result that is already bought — coming back to
    // this mode re-polls this id instead of reserving again.
    entry.completedByMode = entry.completedByMode || {};
    if (entry.completedJobId) entry.completedByMode[entry.mode] = entry.completedJobId;
    overlay.setStatus(statusText(entry.mode), { progress: 1 });

    // Decode before swapping: replacing src directly would blank the image for
    // as long as the download takes, on top of the wait the user already had.
    const loaded = await preloadImage(job.resultUrl);

    // A presigned URL that expired, a network drop, bytes that will not decode —
    // swapping anyway would replace a readable page with a broken-image icon and
    // report it as success. The redraw is done and paid for, so the result is
    // still there on a retry; say so instead of destroying what the user has.
    if (!loaded) {
      overlay.setError(t('comicResultUnavailable'));
      offerDismiss(overlay);
      return;
    }

    entry.resultUrl = job.resultUrl;
    // Set before the check below, not after the swap: it is what the reader
    // asked for, so it is the state to come back to whether or not the page is
    // in front of them right now.
    entry.showingTranslation = true;

    // The reader turned the page while this was finishing, so the <img> this
    // job started on is showing someone else's page now. The result is bought
    // and recorded either way — restoreEntry puts it on screen when they turn
    // back, and swapping it in here would put it on the wrong page.
    if (entry.detached || !entryMatchesImage(entry, entry.img)) {
      overlay.destroy();
      entry.overlay = null;
      rememberJob(entry, 'succeeded');
      sendMessage({ type: 'COMIC_ACCOUNT', force: true });
      return;
    }

    showResult(entry, job.resultUrl);
    overlay.destroy();
    entry.overlay = null;
    if (!entry.badge) attachToggleBadge(entry);
    // The presigned URL in the DOM dies in 30 minutes and the swap is view
    // state a reload throws away — but the redraw itself is in the bucket for
    // days. Keeping the record is what lets the next visit to this page mint a
    // new URL and put the translation back, instead of making the user spend a
    // second free page on one they already translated.
    rememberJob(entry, 'succeeded');
    // The allowance just moved; drop the cached copy so Settings shows the truth.
    sendMessage({ type: 'COMIC_ACCOUNT', force: true });
  }

  /**
   * Read the pixels the page already has.
   *
   * Only works when the image is not cross-origin-tainted — canvas will throw
   * on read otherwise, which is the browser's whole point. That case ends as
   * "cannot translate this image", not as a silent failure.
   */
  function capturePageBytes(img) {
    if (!img.naturalWidth || !img.naturalHeight) return null;
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext('2d').drawImage(img, 0, 0);

    let dataUrl;
    try {
      dataUrl = canvas.toDataURL('image/png');
    } catch {
      return null; // tainted canvas
    }
    if (base64Bytes(dataUrl) > MAX_UPLOAD_BYTES) {
      // PNG of a scanned page is often several times its JPEG original.
      dataUrl = canvas.toDataURL('image/jpeg', 0.92);
      if (base64Bytes(dataUrl) > MAX_UPLOAD_BYTES) return null;
    }
    return dataUrl;
  }

  function base64Bytes(dataUrl) {
    const payload = dataUrl.slice(dataUrl.indexOf(',') + 1);
    return Math.floor(payload.length * 0.75);
  }

  // -------------------------------------------------------------------------
  // Error and account surfaces
  // -------------------------------------------------------------------------

  function promptSignIn(overlay) {
    return new Promise((resolve) => {
      overlay.setStatus(t('comicSignInRequired'), { busy: false });
      overlay.setActions([
        {
          label: t('comicSignIn'),
          variant: 'primary',
          onClick: async () => {
            overlay.setStatus(t('comicSigningIn'), { busy: true });
            const result = await sendMessage({ type: 'COMIC_SIGN_IN' });
            if (result.ok) {
              resolve(true);
              return;
            }
            if (result.error.code === 'sign_in_cancelled') {
              overlay.destroy();
              resolve(false);
              return;
            }
            overlay.setError(result.error.message || t('comicSignInFailed'));
            offerDismiss(overlay);
            resolve(false);
          }
        },
        {
          label: t('comicCancel'),
          onClick: () => {
            overlay.destroy();
            resolve(false);
          }
        }
      ]);
    });
  }

  function showJobError(overlay, error) {
    // Dismiss is the only action, including for a used-up monthly allowance:
    // there is nothing to buy, so an "act now" button would lead nowhere. The
    // message names the reset date instead.
    overlay.setError(errorText(error));
    offerDismiss(overlay);
  }

  function offerDismiss(overlay) {
    overlay.setActions([{ label: t('comicDismiss'), onClick: () => overlay.destroy() }]);
  }

  /**
   * Server error codes → something a reader can act on.
   *
   * Codes, never message text: the server's messages are English and written
   * for a developer reading a log.
   */
  function errorText(error) {
    const code = error && error.code;
    switch (code) {
      case 'insufficient_points': return t('comicInsufficientPoints');
      case 'image_too_large':
        return error.reason === 'webtoon_strip' ? t('comicWebtoonUnsupported') : t('comicImageTooLarge');
      case 'image_too_small': return t('comicImageTooSmall');
      case 'unsupported_aspect_ratio': return t('comicAspectUnsupported');
      case 'unsupported_format':
      case 'unreadable_image':
      case 'invalid_image_data':
      case 'invalid_image_url': return t('comicUnsupportedFormat');
      case 'gateway_unavailable': return t('comicServiceUnavailable');
      case 'network_error':
      case 'no_response': return t('comicNetworkError');
      case 'extension_context': return t('extensionContextInvalidated');
      // An overlay that was already open when the switch went off; the worker
      // is the one that decides, so this is how that decision reads.
      case 'feature_disabled': return t('featureDisabled');
      default: return t('comicFailed');
    }
  }

  /** Last resort when there is no image to anchor to. */
  function showDetachedError(message) {
    const toast = document.createElement('div');
    toast.className = 'ai-translator-comic-toast';
    toast.innerHTML = `<span>${escapeHtml(message)}</span>`;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
  }

  ctx.startComicTranslation = startComicTranslation;
  ctx.startComicPageTranslation = startComicPageTranslation;
  ctx.hasComicPageOnScreen = () => pickComicImages().length > 0;
  ctx.resumeComicJobs = resumeComicJobs;
})();
