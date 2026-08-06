// AI Translator Content Script — Comic page translation
//
// Pick a comic page → the server redraws it with the text translated → the
// result replaces the image in place, with a badge to flip back to the
// original. Unlike every other feature in this extension, this one runs on our
// servers against the user's account, so it can fail for reasons text
// translation never has: not signed in, out of free pages for the month, or an
// image we are not allowed to fetch.
//
// There are three ways in, because the obvious one is not always available:
// the right-click menu, a button that appears when the pointer is over a page,
// and the float ball. Comic hosts routinely block the context menu outright and
// hide the artwork under a decoy image to poison what right-click reports, so a
// path that never touches the menu is a requirement, not a convenience.
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

  /** Images with a running job or a completed swap, keyed by element. */
  const tracked = new WeakMap();
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
    return t(mode === 'colorize' ? 'comicColorizing' : 'comicTranslating');
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
    return img.dataset.aiTranslatorOriginalSrc === srcUrl;
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
      if (!img.isConnected) {
        destroy();
        return;
      }
      const rect = img.getBoundingClientRect();
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

    const showResultLabel = entry.mode === 'colorize' ? 'comicShowColorized' : 'comicShowTranslation';
    const render = () => {
      badge.textContent = entry.showingTranslation ? t('comicShowOriginal') : t(showResultLabel);
    };
    render();

    badge.addEventListener('click', () => {
      entry.showingTranslation = !entry.showingTranslation;
      applySource(entry.img, entry.showingTranslation ? entry.resultUrl : entry.originalSrc, entry);
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
   * Point an <img> at a different URL.
   *
   * `srcset` and a parent `<picture>` both outrank `src`, so setting src alone
   * leaves responsive markup showing the untranslated page — on exactly the
   * image-heavy sites this feature targets.
   */
  function applySource(img, url, entry) {
    if (entry.originalSrcset === undefined) {
      entry.originalSrcset = img.getAttribute('srcset');
      entry.originalSizes = img.getAttribute('sizes');
      entry.pictureSources = img.parentElement && img.parentElement.tagName === 'PICTURE'
        ? Array.from(img.parentElement.querySelectorAll('source')).map(source => ({
            element: source,
            srcset: source.getAttribute('srcset')
          }))
        : [];
    }

    const restoring = url === entry.originalSrc;
    if (restoring) {
      if (entry.originalSrcset === null) img.removeAttribute('srcset');
      else img.setAttribute('srcset', entry.originalSrcset);
      // `sizes` is stripped alongside srcset on the way in, so it has to come
      // back too — without it a restored responsive image picks the wrong
      // candidate width and renders soft.
      if (entry.originalSizes === null) img.removeAttribute('sizes');
      else img.setAttribute('sizes', entry.originalSizes);
      entry.pictureSources.forEach(({ element, srcset }) => {
        if (srcset === null) element.removeAttribute('srcset');
        else element.setAttribute('srcset', srcset);
      });
    } else {
      img.removeAttribute('srcset');
      img.removeAttribute('sizes');
      entry.pictureSources.forEach(({ element }) => element.removeAttribute('srcset'));
      // Right-clicking a swapped image reports the presigned URL, which matches
      // nothing on the page; this is how the element is found again.
      img.dataset.aiTranslatorOriginalSrc = entry.originalSrc;
    }
    img.src = url;
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
   * Keyed by image URL, not page URL: readers rewrite their own URL between
   * visits to the same chapter (query strings, hashes, SPA routes) while the
   * artwork's src stays put. The cost is that a blob:/data: source can never be
   * resumed, since those URLs die with the document that minted them — but there
   * would be nothing to match them against either way.
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
  // How long after load to keep watching for a recorded image to appear. Comic
  // readers lazy-load artwork, sometimes several seconds in.
  const RESUME_WATCH_MS = 30_000;

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

  /** Every live record, expired ones already dropped. */
  async function loadRecords() {
    const stored = await storageGet(JOB_STORE_KEY);
    const records = stored[JOB_STORE_KEY];
    if (!records || typeof records !== 'object') return {};
    const cutoff = Date.now() - RECORD_TTL_MS;
    const live = {};
    Object.keys(records).forEach((key) => {
      const record = records[key];
      if (record && typeof record.jobId === 'string' && record.createdAt > cutoff) {
        live[key] = record;
      }
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
   * One record per (mode, image). The two products on a page are two separate
   * purchases, and keying by image alone made the second one overwrite the
   * record of the first — after a reload, switching back to the overwritten
   * mode had no job id to recover and bought the page again. Records written
   * before modes existed sit under the bare src and still load; they were all
   * translations, which is what an absent mode resolves to everywhere.
   */
  function recordKey(mode, imageSrc) {
    return `${normalizeMode(mode)}|${imageSrc}`;
  }

  function saveRecord(record) {
    return updateRecords((records) => {
      records[recordKey(record.mode, record.imageSrc)] = record;
      // A pre-mode record under the bare src IS a translation record — so it is
      // superseded only when the record being saved is itself the translation.
      // Deleting it on a colorize save would erase a purchase this write knows
      // nothing about.
      if (normalizeMode(record.mode) === 'translate' && record.imageSrc in records) {
        delete records[record.imageSrc];
      }
      const keys = Object.keys(records);
      if (keys.length > MAX_RECORDS) {
        keys
          .sort((a, b) => records[a].createdAt - records[b].createdAt)
          .slice(0, keys.length - MAX_RECORDS)
          .forEach((key) => { delete records[key]; });
      }
    });
  }

  function dropRecord(imageSrc, mode) {
    if (!imageSrc) return Promise.resolve();
    return updateRecords((records) => {
      const key = recordKey(mode, imageSrc);
      // The bare src is the pre-mode spelling of the same translate record.
      const legacy = normalizeMode(mode) === 'translate' && imageSrc in records;
      if (!(key in records) && !legacy) return false;
      delete records[key];
      if (legacy) delete records[imageSrc];
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
    if (!jobId || !entry.originalSrc) return;
    if (/^(blob|data):/i.test(entry.originalSrc)) return;
    saveRecord({
      jobId,
      mode: entry.mode,
      imageSrc: entry.originalSrc,
      pageUrl: location.href,
      createdAt: entry.jobStartedAt || Date.now(),
      // Selection on the next page load goes by what the reader last SAW, not
      // by when each job was bought — see resumeComicJobs.
      displayedAt: Date.now(),
      status
    });
  }

  /**
   * The page a record names — by the same rule the context-menu path uses.
   *
   * Taking the first DOM match is wrong on exactly the sites this feature is
   * for: a chapter page that reuses the artwork's src in a thumbnail strip has
   * several matches, and the thumbnail usually comes first. Swapping a paid
   * redraw into a 60px thumbnail loses it, and the real page never gets it.
   *
   * No resolveRealPage here, unlike findImage: a record is only ever written
   * with a src that already went through it, so the src *is* the real page and
   * re-resolving could only walk away from it.
   */
  function findImageBySrc(src) {
    const candidates = Array.from(document.images).filter(
      img => img.isConnected && matchesSrc(img, src)
    );
    if (!candidates.length) return null;
    return candidates.reduce(
      (winner, img) => (renderedArea(img) > renderedArea(winner) ? img : winner)
    );
  }

  /**
   * Re-attach to jobs that were started before this document existed.
   *
   * Sweeps once, then watches: the image a record names is frequently not in the
   * DOM yet when the content script runs, because the reader lazy-loads it.
   */
  async function resumeComicJobs() {
    if (!comicEnabled()) return;
    const records = await loadRecords();
    const pending = Object.keys(records).map(key => records[key]);
    if (!pending.length) return;

    // Several records can name one image now — one per mode. Only one state can
    // be on screen, and the newest is the one the reader last saw; the rest of
    // the group rides along to seed the per-mode stash, so switching modes
    // after a reload stays a free re-poll.
    const byImage = new Map();
    pending.forEach((record) => {
      const group = byImage.get(record.imageSrc) || [];
      group.push(record);
      byImage.set(record.imageSrc, group);
    });

    const claimed = new Set();
    const sweep = () => {
      byImage.forEach((group, imageSrc) => {
        if (claimed.has(imageSrc)) return;
        const img = findImageBySrc(imageSrc);
        if (!img) return;
        claimed.add(imageSrc);
        // "Newest" is what the reader last had on screen, not what was bought
        // last: switching back to an older purchase refreshes its displayedAt,
        // so a reload restores the view they left, not the later receipt.
        // Records from before the field fall back to their creation time.
        const shownAt = (r) => r.displayedAt || r.createdAt;
        const newest = group.reduce((a, b) => (shownAt(b) > shownAt(a) ? b : a));
        resumeRecord(img, newest, group);
      });
      return claimed.size === byImage.size;
    };

    if (sweep()) return;
    const observer = new MutationObserver(() => {
      if (sweep()) observer.disconnect();
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'srcset']
    });
    setTimeout(() => observer.disconnect(), RESUME_WATCH_MS);
  }

  async function resumeRecord(img, record, group = [record]) {
    const existing = tracked.get(img);
    // Something on this document already owns the image — a job the user just
    // started, or a swap that already happened.
    if (existing && (existing.running || existing.badge)) return;

    const entry = {
      img,
      originalSrc: record.imageSrc,
      showingTranslation: false,
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
    tracked.set(img, entry);

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
          await finishSuccess({ entry, overlay, img, job: polled.data });
          return;
        }
        // Nothing to show, and the reader did not ask for anything on this page
        // load — take the card away rather than opening with an error. A network
        // blip keeps the record; a real answer means it will never resolve.
        overlay.destroy();
        if (polled.ok || polled.error.code !== 'network_error') {
          dropRecord(record.imageSrc, record.mode);
          // The id seeded into the stash from this record is equally dead.
          delete entry.completedByMode[normalizeMode(record.mode)];
        }
        return;
      }
      await pollJob({ entry, overlay, img, jobId: record.jobId, startedAt: record.createdAt });
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
    const existing = tracked.get(img);
    if (existing && existing.running) return;
    if (existing && existing.badge && existing.mode === mode) {
      // Already done in this mode. Re-running would charge for the same page again.
      existing.showingTranslation = true;
      applySource(img, existing.resultUrl, existing);
      return;
    }
    const entry = existing || { img, originalSrc: img.currentSrc || img.src, showingTranslation: false };
    // Claimed BEFORE anything below can await: the decode wait yields to the
    // event loop, and a second trigger landing in that window has to bounce off
    // `running` rather than pass the guard and start a sibling job under its
    // own idempotency key — two reservations for one user intent.
    entry.running = true;
    entry.cancelled = false;
    tracked.set(img, entry);

    // A retry after an error leaves the previous overlay sitting on the image;
    // two stacked cards over one page is not a state worth having.
    if (entry.overlay) entry.overlay.destroy();
    const overlay = createOverlay(img);
    entry.overlay = overlay;

    try {
      if (entry.badge) {
        // Same page, different product — a translated page being colorized, or
        // the reverse. That is a NEW job, but the finished one it replaces
        // stays bought: its job id lives on in `completedByMode`, so coming
        // back to this mode later is a free re-poll, and a failure in the new
        // mode costs nothing that was already paid for.
        entry.destroyBadge?.();
        // The new job must start from the ORIGINAL pixels: the canvas fallback
        // reads whatever the <img> currently shows, and feeding it the
        // previous result would compound two redraws on one page.
        applySource(img, entry.originalSrc, entry);
        entry.showingTranslation = false;
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
      if (entry.completedJobId) {
        await recoverResult({ entry, overlay, img });
        return;
      }
      // One operationId per user action, reused across every retry inside this
      // run: the server treats it as an idempotency key, so a sign-in round-trip
      // or a re-upload settles against the same reservation instead of charging
      // twice. A *new* click gets a new id on purpose — reusing one would hand
      // back the previous (failed) job instead of trying again.
      entry.operationId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      await runJob({ entry, overlay, img, pageUrl, targetLang });
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
   */
  async function recoverResult({ entry, overlay, img }) {
    overlay.setStatus(statusText(entry.mode), { progress: 1 });
    const polled = await sendMessage({ type: 'COMIC_JOB_POLL', jobId: entry.completedJobId });

    if (polled.ok && polled.data.status === 'succeeded' && polled.data.resultUrl) {
      await finishSuccess({ entry, overlay, img, job: polled.data });
      return;
    }

    // Keep the id only while the result is still plausibly there to come back
    // for. A blip between polls is transient; anything else means this job will
    // never hand back a URL again, so the next click is free to order a new one
    // instead of retrying a dead id forever. The stash and the stored record
    // have to go with it — either one would hand the same dead id straight
    // back on the next click or the next page load.
    const transient = !polled.ok && polled.error.code === 'network_error';
    if (!transient) {
      entry.completedJobId = null;
      if (entry.completedByMode) delete entry.completedByMode[entry.mode];
      dropRecord(entry.originalSrc, entry.mode);
    }

    if (!polled.ok) {
      showJobError(overlay, polled.error);
      return;
    }
    overlay.setError(t('comicResultUnavailable'));
    offerDismiss(overlay);
  }

  async function runJob({ entry, overlay, img, pageUrl, targetLang }) {
    // One label for the whole run. The stages underneath — preparing, uploading
    // pixels, queued, downloading the result — are ours, not the reader's, and
    // narrating them made a 90-second wait look like four separate things going
    // wrong. The clock carries the "still working" signal instead.
    const startedAt = Date.now();
    overlay.setStatus(statusText(entry.mode), { progress: 0 });
    overlay.startTimer(startedAt);

    let created = await createJob({ entry, img, pageUrl, targetLang, imageBase64: null });

    if (!created.ok && created.error.code === 'unauthorized') {
      // Sign-in is the one interruption that is genuinely the user's turn, so
      // the clock stops rather than counting their typing as redraw time.
      overlay.stopTimer();
      const signedIn = await promptSignIn(overlay);
      if (!signedIn) return;
      overlay.setStatus(statusText(entry.mode), { progress: 0 });
      overlay.startTimer(Date.now());
      created = await createJob({ entry, img, pageUrl, targetLang, imageBase64: null });
    }

    if (!created.ok && created.error.needsPageBytes) {
      // The worker could not read the file — a blob:/data: src, or an origin
      // that refuses a request without a Referer. The page has already decoded
      // it either way, so send the pixels we can see.
      overlay.setStatus(statusText(entry.mode), { progress: 0.05 });
      const imageBase64 = capturePageBytes(img);
      if (!imageBase64) {
        overlay.setError(t('comicImageUnavailable'));
        offerDismiss(overlay);
        return;
      }
      created = await createJob({ entry, img, pageUrl, targetLang, imageBase64 });
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

    await pollJob({ entry, overlay, img, jobId: entry.jobId, startedAt: jobStartedAt });
  }

  /**
   * Watch a job to a terminal state.
   *
   * Shared by a fresh run and by one picked back up on a later page load, which
   * is why `startedAt` is a parameter rather than `Date.now()`: the timeout is
   * measured from when the *job* was created, so a resumed job cannot be granted
   * a second full budget the server has no intention of honouring.
   */
  async function pollJob({ entry, overlay, img, jobId, startedAt }) {
    overlay.setActions([{
      label: t('comicCancel'),
      onClick: () => {
        entry.cancelled = true;
        sendMessage({ type: 'COMIC_JOB_ABANDON', jobId });
        dropRecord(entry.originalSrc, entry.mode);
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
        dropRecord(entry.originalSrc, entry.mode);
        showJobError(overlay, polled.error);
        return;
      }

      const job = polled.data;
      if (job.status === 'succeeded' && job.resultUrl) {
        await finishSuccess({ entry, overlay, img, job });
        return;
      }
      if (job.status === 'failed' || job.status === 'abandoned') {
        // Terminal and refunded. Leaving the record would re-open this card on
        // every future visit to the page.
        dropRecord(entry.originalSrc, entry.mode);
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
      await finishSuccess({ entry, overlay, img, job: abandoned.data });
      return;
    }

    // Only claim the refund when the server confirmed it. Otherwise say the
    // truthful thing — the reservation may still be held, and the reconciliation
    // sweep will return it — instead of a guess about the user's money.
    const confirmed = !!abandoned && abandoned.ok && abandoned.data.status === 'abandoned';
    // Only forget the job once the server agrees it is dead. An unconfirmed
    // abandon may well still be running, and leaving the record is what lets a
    // later page load pick it up and show the page the user paid for.
    if (confirmed) dropRecord(entry.originalSrc, entry.mode);
    overlay.setError(confirmed ? t('comicTimeout') : t('comicTimeoutUnconfirmed'));
    offerDismiss(overlay);
  }

  function createJob({ entry, img, pageUrl, targetLang, imageBase64 }) {
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

  async function finishSuccess({ entry, overlay, img, job }) {
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
    const loaded = await new Promise((resolve) => {
      const preload = new Image();
      preload.onload = () => resolve(true);
      preload.onerror = () => resolve(false);
      preload.src = job.resultUrl;
    });

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
    entry.showingTranslation = true;
    applySource(img, job.resultUrl, entry);
    overlay.destroy();
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

  // -------------------------------------------------------------------------
  // Hover entry point
  // -------------------------------------------------------------------------

  // Buttons that follow the pointer onto comic pages — one per product,
  // translate and colorize. They exist because the context menu is not reliably
  // reachable: plenty of comic hosts cancel it outright, and a feature nobody
  // can find is a feature nobody uses.
  let hoverHost = null;
  let hoverImage = null;
  let hoverFrame = 0;
  let lastHoverCheck = 0;
  // Cheap enough at pointer speed, and re-running the hit test on every single
  // mousemove is not.
  const HOVER_CHECK_MS = 80;

  function comicEnabled() {
    return !!(ctx.settings && ctx.settings.enableComicTranslation);
  }

  function setupHoverButton() {
    // Driven by mousemove rather than mouseover/mouseout, and hit-tested by
    // coordinate rather than by event.target. Both are because of what these
    // viewers do to the DOM: the decoy overlay swallows the enter events, and
    // recycling page containers under a stationary cursor produces a stream of
    // spurious "the pointer left" events that flicker the button away. A
    // position is the one thing that stays true.
    document.addEventListener('mousemove', (event) => {
      // Only a real pointer. Viewers dispatch synthetic mouse events at (0, 0)
      // to drive their own chrome.
      if (!event.isTrusted) return;
      const now = Date.now();
      if (now - lastHoverCheck < HOVER_CHECK_MS) return;
      lastHoverCheck = now;
      updateHoverButton(event.clientX, event.clientY);
    }, true);
  }

  function updateHoverButton(x, y) {
    if (!comicEnabled()) {
      hideHoverButton();
      return;
    }
    // Over our own buttons: the pointer is on its way to clicking one.
    if (hoverHost && hoverHost.style.display !== 'none' && containsPoint(hoverHost, x, y)) return;

    const under = imageAtPoint(x, y);
    if (!under) {
      hideHoverButton();
      return;
    }
    const page = resolveRealPage(under);
    if (!isComicPage(page)) {
      hideHoverButton();
      return;
    }
    // Only a RUNNING job hides the buttons. A finished swap keeps them: the
    // other product is still worth offering — on hosts that cancel the context
    // menu this hover is its only entry point — and clicking the mode that
    // already finished is caught by translateImage's same-mode guard, which
    // flips the view instead of buying the page again.
    const entry = tracked.get(page);
    if (entry && entry.running) {
      hideHoverButton();
      return;
    }
    showHoverButton(page);
  }

  function containsPoint(element, x, y) {
    const rect = element.getBoundingClientRect();
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  }

  function makeHoverButton(labelKey, extraClass, mode) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `ai-translator-comic-hover-btn ${extraClass}`;
    button.textContent = t(labelKey);
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const target = hoverImage;
      hideHoverButton();
      if (target) translateImage(target, { pageUrl: location.href, targetLang: comicTargetLang(), mode });
    });
    return button;
  }

  function showHoverButton(img) {
    if (!hoverHost) {
      hoverHost = document.createElement('div');
      hoverHost.className = 'ai-translator-comic-hover';
      hoverHost.appendChild(makeHoverButton('comicTranslateAction', 'is-translate', 'translate'));
      hoverHost.appendChild(makeHoverButton('comicColorizeAction', 'is-colorize', 'colorize'));
      // Sites that block copying tend to cancel these too; ours is our own.
      ['mousedown', 'contextmenu'].forEach(type => {
        hoverHost.addEventListener(type, event => event.stopPropagation());
      });
      document.body.appendChild(hoverHost);
    }

    // Explicit, not '': the stylesheet hides it by default so it never flashes
    // before the first position lands.
    hoverHost.style.display = 'flex';
    hoverImage = img;
    if (hoverFrame) return;

    const track = () => {
      if (!hoverImage || !hoverImage.isConnected) {
        hideHoverButton();
        return;
      }
      const rect = hoverImage.getBoundingClientRect();
      const size = hoverHost.getBoundingClientRect();
      hoverHost.style.top = `${rect.top + 10}px`;
      hoverHost.style.left = `${rect.right - size.width - 10}px`;
      hoverFrame = requestAnimationFrame(track);
    };
    hoverFrame = requestAnimationFrame(track);
  }

  // Leaves `hoverImage` alone: a click arrives after the pointer has already
  // moved onto a button, and losing the target between press and release
  // would turn the click into nothing at all.
  function hideHoverButton() {
    cancelAnimationFrame(hoverFrame);
    hoverFrame = 0;
    if (hoverHost) hoverHost.style.display = 'none';
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

  setupHoverButton();
})();
