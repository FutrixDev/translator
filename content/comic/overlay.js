// Blab Translation 漫画翻译 —— 覆盖层与徽标
//
// 这一份只管画：盖在页面上的那张进度卡、译完以后挂在角上的翻回原图的徽标，以及把
// <img> 的 src 换掉又换回来的那几行。什么时候画、画什么字，是别处决定的。
(function() {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT;
  if (!ctx) return;
  // 这一族共用的架子，说明见 content/content-comic-translation.js 顶上。
  const comic = (ctx.comic = ctx.comic || {});

  const t = ctx.t;

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
