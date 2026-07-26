// AI Translator Content Script — Comic page translation
//
// Right-click a comic page → the server redraws it with the text translated →
// the result replaces the image in place, with a badge to flip back to the
// original. Unlike every other feature in this extension, this one runs on our
// servers against the user's account balance, so it can fail for reasons text
// translation never has: not signed in, out of credits, or an image we are not
// allowed to fetch.
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
  const JOB_TIMEOUT_MS = 180_000;
  // How long to wait for the server to confirm an abandon. Generous — the whole
  // point of awaiting it is to learn what happened to the reservation — but
  // finite, because the alternative is an overlay that never says anything
  // again.
  const ABANDON_TIMEOUT_MS = 15_000;
  // Same ceiling the server enforces before it charges anything. Re-encoding a
  // page above this is wasted work.
  const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

  /** Images with a running job or a completed swap, keyed by element. */
  const tracked = new WeakMap();
  let lastContextImage = null;

  // The right-click target is the only unambiguous way to know WHICH image the
  // user meant: a page can show the same src a dozen times (thumbnail grids,
  // lazy-load placeholders) and info.srcUrl cannot tell them apart.
  document.addEventListener('contextmenu', (event) => {
    const target = event.target;
    lastContextImage = target && target.tagName === 'IMG' ? target : null;
  }, true);

  function findImage(srcUrl) {
    if (lastContextImage && lastContextImage.isConnected && matchesSrc(lastContextImage, srcUrl)) {
      return lastContextImage;
    }
    const candidates = Array.from(document.images).filter(img => matchesSrc(img, srcUrl));
    if (!candidates.length) return null;
    // Fall back to the largest match — on a page that reuses a src, the comic
    // page itself is the big one and the rest are navigation thumbnails.
    return candidates.reduce((best, img) => {
      const area = img.getBoundingClientRect().width * img.getBoundingClientRect().height;
      const bestArea = best.getBoundingClientRect().width * best.getBoundingClientRect().height;
      return area > bestArea ? img : best;
    });
  }

  function matchesSrc(img, srcUrl) {
    if (!srcUrl) return false;
    if (img.currentSrc === srcUrl || img.src === srcUrl) return true;
    // A swapped image no longer carries its original src, but it is still the
    // element the user right-clicked.
    return img.dataset.aiTranslatorOriginalSrc === srcUrl;
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
        <div class="ai-translator-comic-bar"><span></span></div>
        <div class="ai-translator-comic-actions"></div>
      </div>
    `;
    document.body.appendChild(overlay);

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
      }
    };
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

    const render = () => {
      badge.textContent = entry.showingTranslation ? t('comicShowOriginal') : t('comicShowTranslation');
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

  async function startComicTranslation({ srcUrl, pageUrl, targetLang }) {
    const img = findImage(srcUrl);
    if (!img) {
      showDetachedError(t('comicImageNotFound'));
      return;
    }

    const existing = tracked.get(img);
    if (existing && existing.running) return;
    if (existing && existing.badge) {
      // Already translated. Re-running would charge for the same page again.
      existing.showingTranslation = true;
      applySource(img, existing.resultUrl, existing);
      return;
    }

    const entry = existing || { img, originalSrc: img.currentSrc || img.src, showingTranslation: false };
    entry.running = true;
    entry.cancelled = false;
    tracked.set(img, entry);

    // A retry after an error leaves the previous overlay sitting on the image;
    // two stacked cards over one page is not a state worth having.
    if (entry.overlay) entry.overlay.destroy();
    const overlay = createOverlay(img);
    entry.overlay = overlay;

    try {
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
    overlay.setStatus(t('comicLoadingResult'), { progress: 1 });
    const polled = await sendMessage({ type: 'COMIC_JOB_POLL', jobId: entry.completedJobId });

    if (polled.ok && polled.data.status === 'succeeded' && polled.data.resultUrl) {
      await finishSuccess({ entry, overlay, img, job: polled.data });
      return;
    }

    // Keep the id only while the result is still plausibly there to come back
    // for. A blip between polls is transient; anything else means this job will
    // never hand back a URL again, so the next click is free to order a new one
    // instead of retrying a dead id forever.
    const transient = !polled.ok && polled.error.code === 'network_error';
    if (!transient) entry.completedJobId = null;

    if (!polled.ok) {
      showJobError(overlay, polled.error);
      return;
    }
    overlay.setError(t('comicResultUnavailable'));
    offerDismiss(overlay);
  }

  async function runJob({ entry, overlay, img, pageUrl, targetLang }) {
    overlay.setStatus(t('comicPreparing'), { progress: 0 });

    let created = await createJob({ entry, img, pageUrl, targetLang, imageBase64: null });

    if (!created.ok && created.error.code === 'unauthorized') {
      const signedIn = await promptSignIn(overlay);
      if (!signedIn) return;
      overlay.setStatus(t('comicPreparing'), { progress: 0 });
      created = await createJob({ entry, img, pageUrl, targetLang, imageBase64: null });
    }

    if (!created.ok && created.error.needsPageBytes) {
      // The worker could not read the file — a blob:/data: src, or an origin
      // that refuses a request without a Referer. The page has already decoded
      // it either way, so send the pixels we can see.
      overlay.setStatus(t('comicUploading'), { progress: 0.05 });
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

    const jobId = created.data.jobId;
    entry.jobId = jobId;
    const startedAt = Date.now();

    overlay.setActions([{
      label: t('comicCancel'),
      onClick: () => {
        entry.cancelled = true;
        sendMessage({ type: 'COMIC_JOB_ABANDON', jobId });
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
        showJobError(overlay, polled.error);
        return;
      }

      const job = polled.data;
      if (job.status === 'succeeded' && job.resultUrl) {
        await finishSuccess({ entry, overlay, img, job });
        return;
      }
      if (job.status === 'failed' || job.status === 'abandoned') {
        showJobError(overlay, job.error || { code: 'failed', message: '' });
        return;
      }

      // Server progress is coarse (queued/running/done). Creeping it with
      // elapsed time keeps the bar honest about the stage while still moving.
      const estimate = Math.min(0.9, 0.1 + elapsed / JOB_TIMEOUT_MS * 1.6);
      overlay.setStatus(
        job.status === 'queued' ? t('comicQueued') : t('comicTranslating'),
        { progress: Math.max(job.progress || 0, estimate) }
      );
    }

    // Give the credits back rather than leaving a reservation stranded. Awaited,
    // because what to tell the user depends on what the server says: the old
    // fire-and-forget claimed "your credits were not charged" without ever
    // learning whether the refund landed.
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
        targetLang
      }
    });
  }

  async function finishSuccess({ entry, overlay, img, job }) {
    // Before the download, not after: from here on the redraw exists and has
    // been charged for, so every later failure has to be recoverable by going
    // back to this job rather than by buying another one.
    entry.completedJobId = job.jobId || entry.jobId || null;
    overlay.setStatus(t('comicLoadingResult'), { progress: 1 });

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
    // The balance just moved; drop the cached copy so the popup shows the truth.
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
    overlay.setError(errorText(error));

    if (error.code === 'insufficient_points') {
      overlay.setActions([
        {
          label: t('comicTopUp'),
          variant: 'primary',
          onClick: () => sendMessage({ type: 'COMIC_OPEN_RECHARGE' })
        },
        { label: t('comicDismiss'), onClick: () => overlay.destroy() }
      ]);
      return;
    }
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
})();
