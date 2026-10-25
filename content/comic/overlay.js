// Blab Translation 漫画翻译 —— 进度标与徽标
//
// 这一份只管画：右上角的进度标和它下面的卡片、译完以后挂在左上角的翻回原图的徽标，
// 以及把 <img> 的 src 换掉又换回来的那几行。什么时候画、画什么字，是别处决定的。
(function() {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT;
  if (!ctx) return;
  // 这一族共用的架子，说明见 content/content-comic-translation.js 顶上。
  const comic = (ctx.comic = ctx.comic || {});

  const t = ctx.t;

  // -------------------------------------------------------------------------
  // Pinned to a corner of the image
  // -------------------------------------------------------------------------

  // Inside the image, not on its edge: the corner of the artwork is where a page
  // number or a signature sits, and 8 px clears the rounded corners readers draw.
  const CORNER_INSET = 8;

  /**
   * Keep `element` (fixed-position) in one corner of whatever `host()` returns.
   *
   * Fixed rather than a wrapper element around the <img>: reparenting an image
   * inside someone else's layout breaks galleries, lightboxes and lazy-loaders
   * in ways that are impossible to test for. So the rect is re-read every
   * frame — the image can move for reasons no event reports (CSS animation, a
   * sibling loading in).
   *
   * `shown()` is the caller's own reason to hide it; the image being out of
   * sight, or collapsed to nothing by a reader recycling its slot, is this
   * function's. `onFrame(rect)` runs on every visible frame, before the element
   * is placed, so a caller can size it first. Ends by itself,
   * calling `onGone()`, once the host leaves the document.
   */
  function pinToCorner(element, { host, corner, shown = () => true, onFrame = null, onGone }) {
    /** Put the element in its corner; false once the host has left the document. */
    const place = () => {
      const img = host();
      if (!img.isConnected) return false;
      const rect = img.getBoundingClientRect();
      const visible = shown() && rect.width > 0 && rect.bottom > 0 && rect.top < window.innerHeight;
      element.style.display = visible ? '' : 'none';
      if (!visible) return true;
      if (onFrame) onFrame(rect);
      element.style.top = `${rect.top + CORNER_INSET}px`;
      // Anchored by the edge that touches the corner, so a label that changes
      // the width between two frames grows away from the corner instead of
      // sliding the box off it. `right` on a fixed box counts from the
      // viewport's inner edge, which is clientWidth, not innerWidth.
      if (corner === 'top-right') {
        element.style.right = `${document.documentElement.clientWidth - rect.right + CORNER_INSET}px`;
      } else {
        element.style.left = `${rect.left + CORNER_INSET}px`;
      }
      return true;
    };
    let frame = 0;
    const track = () => {
      if (!place()) {
        frame = 0;
        onGone();
        return;
      }
      frame = requestAnimationFrame(track);
    };
    // Placed once now, so an element already in the document is never left for
    // a frame at its static position; ending is left to the frames, which run
    // after the caller holds the stop function.
    place();
    frame = requestAnimationFrame(track);
    return () => cancelAnimationFrame(frame);
  }

  // -------------------------------------------------------------------------
  // Progress pill
  // -------------------------------------------------------------------------

  // The pill may cover at most this much of the page it is reporting on, and
  // never more than PILL_MAX_WIDTH across: a page being read is not a canvas
  // for our status line.
  const PILL_MAX_WIDTH = 220;
  const PILL_MAX_AREA = 0.06;
  // Server progress is coarse (queued, running, done), so the number creeps
  // between its reports: a point every 1.2 s, so the reader sees it move at
  // least once in any two seconds — that is what says the job is alive. It
  // stops short of 100; only a finished job gets that.
  const CREEP_PER_MS = 1 / 120_000;
  const CREEP_CAP = 0.95;

  /**
   * The progress pill in the image's top-right corner, and the card that
   * opens under it.
   *
   * The pill says what is happening and how far along; it never covers more
   * than a corner, so the page stays readable while it is redrawn. Everything
   * that needs words or a decision — the clock, Cancel, sign-in, a price, an
   * error — lives in the card, which opens by itself when the reader has to
   * act and otherwise on a click of the pill.
   */
  function createOverlay(img) {
    // Mutable, not the captured parameter: a reader that recycles its <img>
    // pool can take this element away and give it back while one job runs, and
    // the pill that comes back has to be the same pill — same clock, same
    // progress — pinned to whichever element now holds the page.
    let host = img;
    let hidden = false;

    const root = document.createElement('div');
    root.className = 'ai-translator-comic-progress';
    root.innerHTML = `
      <button type="button" class="ai-translator-comic-pill" aria-expanded="false">
        <span class="ai-translator-comic-spinner"></span>
        <span class="ai-translator-comic-label"></span>
        <span class="ai-translator-comic-pct" hidden></span>
      </button>
      <div class="ai-translator-comic-card" hidden>
        <div class="ai-translator-comic-message" hidden></div>
        <div class="ai-translator-comic-timer" hidden></div>
        <div class="ai-translator-comic-actions"></div>
      </div>
    `;
    document.body.appendChild(root);

    const pill = root.querySelector('.ai-translator-comic-pill');
    const label = root.querySelector('.ai-translator-comic-label');
    const pct = root.querySelector('.ai-translator-comic-pct');
    const card = root.querySelector('.ai-translator-comic-card');
    const message = root.querySelector('.ai-translator-comic-message');
    const timerElement = root.querySelector('.ai-translator-comic-timer');
    const actionsElement = root.querySelector('.ai-translator-comic-actions');

    const setOpen = (open) => {
      card.hidden = !open;
      pill.setAttribute('aria-expanded', String(open));
    };
    pill.addEventListener('click', () => setOpen(card.hidden));

    // Absolute start, not an accumulating counter: the tab can be backgrounded
    // for minutes — which stops rAF — and the elapsed time still has to be right
    // the instant it comes back.
    let timerFrom = 0;
    let timerShown = '';
    // The creep restarts from every new floor, so a server report that leads
    // the estimate does not freeze the number until the estimate catches up.
    let progressBase = null;
    let progressBaseAt = 0;
    let pctShown = '';

    const tick = (rect) => {
      // Width first, so the box placed this frame is the final one.
      const byArea = (rect.width * rect.height * PILL_MAX_AREA) / Math.max(1, pill.offsetHeight);
      pill.style.maxWidth = `${Math.floor(Math.min(PILL_MAX_WIDTH, byArea))}px`;
      if (timerFrom) {
        const next = formatElapsed(Date.now() - timerFrom);
        // Only touch the DOM on the second boundary; this runs at 60fps.
        if (next !== timerShown) {
          timerShown = next;
          timerElement.textContent = next;
        }
      }
      if (progressBase !== null) {
        const value = progressBase >= 1
          ? 1
          : Math.min(CREEP_CAP, progressBase + (Date.now() - progressBaseAt) * CREEP_PER_MS);
        const next = `${Math.floor(value * 100)}%`;
        if (next !== pctShown) {
          pctShown = next;
          pct.textContent = next;
        }
      }
    };

    const stop = pinToCorner(root, {
      host: () => host,
      corner: 'top-right',
      shown: () => !hidden,
      onFrame: tick,
      onGone: () => destroy()
    });

    function destroy() {
      stop();
      root.remove();
    }

    function setProgress(progress) {
      if (progress === null) {
        progressBase = null;
        pctShown = '';
        pct.hidden = true;
        return;
      }
      const now = Date.now();
      const current = progressBase === null
        ? 0
        : Math.min(CREEP_CAP, progressBase + (now - progressBaseAt) * CREEP_PER_MS);
      // Never backwards: a resumed job's first report, or a coarse server
      // figure behind the estimate, must not make the number drop.
      progressBase = Math.max(current, progress);
      progressBaseAt = now;
      pct.hidden = false;
    }

    return {
      element: root,
      destroy,
      /** Follow the job onto the element that now holds its page. */
      rebind(next) {
        host = next;
      },
      /**
       * Take the pill off the screen without ending the job behind it.
       *
       * The reader turned away from a page that is still being redrawn: the
       * pill belongs to that page, not to the one now in the slot.
       */
      setHidden(next) {
        hidden = next;
        if (next) root.style.display = 'none';
      },
      /**
       * Show a running clock in the card, counting from `from`.
       *
       * A redraw takes 60–120s, so the clock is the most honest signal the
       * reader has that anything is still happening. `from` is the job's
       * creation time rather than "now" — a job picked back up after the reader
       * went to the next page and returned has to show its real age, not
       * restart at zero.
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
      /**
       * What the pill says: the job, and how far along it is (0–1, or null for
       * no number). Not busy means the job is waiting on the reader.
       */
      setStatus(text, { progress = null, busy = true } = {}) {
        root.classList.remove('is-error');
        root.classList.toggle('is-busy', busy);
        label.textContent = text;
        pill.title = text;
        setProgress(busy ? progress : null);
      },
      /** The sentence in the card, or '' for none. */
      setMessage(text) {
        message.textContent = text;
        message.hidden = !text;
      },
      /**
       * The job waits on the reader: the pill keeps saying what it is for but
       * stops spinning and counting, and the card holds the question.
       */
      ask(text) {
        root.classList.remove('is-error', 'is-busy');
        setProgress(null);
        message.textContent = text;
        message.hidden = !text;
      },
      /**
       * The card's buttons. A question the reader has to answer opens the card
       * by itself; the Cancel that sits under a running job does not, so it
       * passes `open: false`. No buttons means the question is over, and the
       * card folds.
       */
      setActions(actions, { open = true } = {}) {
        actionsElement.innerHTML = '';
        actions.forEach(({ label: text, variant, onClick }) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = `ai-translator-comic-btn${variant === 'primary' ? ' is-primary' : ''}`;
          button.textContent = text;
          button.addEventListener('click', onClick);
          actionsElement.appendChild(button);
        });
        if (!actions.length) setOpen(false);
        else if (open) setOpen(true);
      },
      /** The job is over and did not succeed: the pill says so, the card why. */
      setError(text) {
        root.classList.add('is-error');
        root.classList.remove('is-busy');
        label.textContent = t('comicFailed');
        pill.title = t('comicFailed');
        setProgress(null);
        message.textContent = text;
        message.hidden = !text;
        timerFrom = 0;
        timerElement.hidden = true;
        setOpen(true);
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

    const showResultLabel = comic.resultLabel(entry.mode);
    const render = () => {
      badge.textContent = entry.showingTranslation ? t('comicShowOriginal') : t(showResultLabel);
    };
    render();

    badge.addEventListener('click', () => {
      if (entry.showingTranslation) comic.showOriginal(entry);
      else comic.showResult(entry, entry.resultUrl);
      render();
    });

    const stop = pinToCorner(badge, {
      host: () => entry.img,
      corner: 'top-left',
      onGone: () => badge.remove()
    });

    entry.badge = badge;
    // For the run-again-in-a-different-mode path, which replaces the swap and
    // its badge; the pin above only ends on its own when the image leaves the
    // DOM.
    entry.destroyBadge = () => {
      stop();
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
    write(img, comic.PAGE_ID_ATTR, pageId);
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

  // 别的文件要用的，都从这张架子上取。
  Object.assign(comic, {
    attachToggleBadge, createOverlay, swapSource,
  });
})();
