// Blab Translation Content Script — Comic page translation
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
//
// 这个功能横跨六个文件：认页（content/comic/pages.js）、页面台账（entries.js）、
// 覆盖层（overlay.js）、跨页任务记忆（memory.js）、说给人听的话（prompts.js），
// 以及这里的任务流——发起、轮询、拿到结果、跟着读者翻页。六份各自把要给别人用的
// 名字挂到同一张架子 `ctx.comic` 上（谁先装上谁把它建出来），取值都发生在调用时，
// 所以 manifest 里它们的先后无关紧要。文件里带 `comic.` 前缀的，就是住在别处的。
(function() {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT;
  if (!ctx) return;
  // 这一族共用的架子，说明见 content/content-comic-translation.js 顶上。
  const comic = (ctx.comic = ctx.comic || {});

  const t = ctx.t;

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
    comic.tracked.forEach((entry) => {
      if (entry.img === img && !entry.detached && !comic.entryMatchesImage(entry, img)) {
        comic.detachEntry(entry);
      }
    });

    const entry = comic.entryFor(img);
    if (!entry) {
      // Nothing this document translated — but a page can be bought and still
      // be unknown here: by a previous session, or by an entry this one evicted
      // to stay bounded. Either way the redraw exists and putting it back is
      // free, where letting the page look untranslated invites paying twice.
      comic.claimKnownPage(comic.pageIdOf(img), img);
      return;
    }
    if (entry.running) {
      // Still being redrawn: give the reader back the card they left, clock and
      // all, and let the poll loop carry on where it is.
      if (entry.detached) comic.bindEntry(entry, img);
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
      comic.bindEntry(entry, img);
      // The reader had flipped this one back to the original before turning
      // away. Give them the badge to flip it again, and leave the page alone.
      if (!entry.showingTranslation) {
        if (!entry.badge) comic.attachToggleBadge(entry);
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
      if (entry.detached || entry.img !== img || !comic.entryMatchesImage(entry, img)) return;
      entry.resultUrl = url;
      comic.showResult(entry, url);
      if (!entry.badge) comic.attachToggleBadge(entry);
      // The reader is looking at this one again, so it is the state a reload
      // should come back to — see the displayedAt note in resumeComicJobs.
      comic.rememberJob(entry, 'succeeded');
    } finally {
      entry.restoring = false;
    }
  }

  async function resumeRecord(img, record, group = [record]) {
    const existing = comic.entryFor(img);
    // Something on this document already owns the image — a job the user just
    // started, or a swap that already happened.
    if (existing && (existing.running || existing.badge)) return;

    const entry = {
      ...newEntry(img),
      jobId: record.jobId,
      jobStartedAt: record.createdAt,
      // Records written before modes existed are all translations.
      mode: comic.normalizeMode(record.mode),
      // Every finished purchase on this image, whichever mode: asking for one
      // of them later recovers its job instead of reserving again.
      completedByMode: {}
    };
    group.forEach((r) => {
      if (r.status === 'succeeded' && r.jobId) {
        entry.completedByMode[comic.normalizeMode(r.mode)] = r.jobId;
      }
    });
    entry.running = true;
    entry.cancelled = false;
    entry.detached = false;
    comic.trackEntry(entry);

    const overlay = comic.createOverlay(img);
    entry.overlay = overlay;
    overlay.setStatus(comic.statusText(entry.mode), { progress: 0.5 });
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
          comic.dropRecord(record.pageId, record.mode);
          // The id seeded into the stash from this record is equally dead.
          delete entry.completedByMode[comic.normalizeMode(record.mode)];
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
    const img = comic.findImage(srcUrl);
    if (!img) {
      comic.showDetachedError(t('comicImageNotFound'));
      return;
    }
    await translateImage(img, { pageUrl, targetLang, mode });
  }

  /**
   * Float-ball and popup entry: nothing was clicked, so the page is found by
   * looking at what is on screen.
   */
  async function startComicPageTranslation({ pageUrl, targetLang, mode } = {}) {
    const images = comic.pickComicImages();
    if (!images.length) {
      comic.showDetachedError(t('comicNoPageFound'));
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
    mode = comic.normalizeMode(mode);
    // Keyed by the page, so a recycled slot answers null here rather than
    // handing back whatever the reader had in it two pages ago.
    const existing = comic.entryFor(img);
    if (existing && existing.running) {
      // The page came back while its job was still going: put the card back
      // where the reader can see it, and let the poll loop carry on.
      if (existing.detached) comic.bindEntry(existing, img);
      return;
    }
    // Before every check below: a click on a page that already shows a result
    // is about that result, so the two products are asked for as one job.
    mode = comic.modeForShownResult(existing, mode);
    if (existing && existing.badge && existing.mode === mode) {
      // Already done in this mode. Re-running would charge for the same page again.
      if (existing.img !== img) comic.bindEntry(existing, img);
      comic.showResult(existing, existing.resultUrl);
      return;
    }
    const entry = existing || comic.newEntry(img);
    // The same page can be back in a different slot than the one it was
    // translated in; the entry follows the page, so it has to be re-pointed.
    if (entry.img !== img || entry.detached) comic.bindEntry(entry, img);
    // Claimed BEFORE anything below can await: the decode wait yields to the
    // event loop, and a second trigger landing in that window has to bounce off
    // `running` rather than pass the guard and start a sibling job under its
    // own idempotency key — two reservations for one user intent.
    entry.running = true;
    entry.cancelled = false;
    comic.trackEntry(entry);

    // A retry after an error leaves the previous overlay sitting on the image;
    // two stacked cards over one page is not a state worth having.
    if (entry.overlay) entry.overlay.destroy();
    const overlay = comic.createOverlay(img);
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
        comic.showOriginal(entry);
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
    overlay.setStatus(comic.statusText(entry.mode), { progress: 1 });
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
        comic.offerDismiss(overlay);
      } else {
        comic.showJobError(overlay, polled.error);
      }
      return true;
    }
    entry.completedJobId = null;
    if (entry.completedByMode) delete entry.completedByMode[entry.mode];
    comic.dropRecord(entry.pageId, entry.mode);
    return false;
  }

  async function runJob({ entry, overlay, pageUrl, targetLang }) {
    // One label for the whole run. The stages underneath — preparing, uploading
    // pixels, queued, downloading the result — are ours, not the reader's, and
    // narrating them made a 90-second wait look like four separate things going
    // wrong. The clock carries the "still working" signal instead.
    const startedAt = Date.now();
    overlay.setStatus(comic.statusText(entry.mode), { progress: 0 });
    overlay.startTimer(startedAt);

    let created = await submitJob({ entry, overlay, pageUrl, targetLang, imageBase64: null });

    if (!created.ok && created.declined) return;

    if (!created.ok && created.error.code === 'unauthorized') {
      // Sign-in is the one interruption that is genuinely the user's turn, so
      // the clock stops rather than counting their typing as redraw time.
      overlay.stopTimer();
      const signedIn = await comic.promptSignIn(overlay);
      if (!signedIn) return;
      overlay.setStatus(comic.statusText(entry.mode), { progress: 0 });
      overlay.startTimer(Date.now());
      created = await submitJob({ entry, overlay, pageUrl, targetLang, imageBase64: null });
      if (!created.ok && created.declined) return;
    }

    if (!created.ok && created.error.needsPageBytes) {
      // The worker could not read the file — a blob:/data: src, or an origin
      // that refuses a request without a Referer. The page has already decoded
      // it either way, so send the pixels we can see.
      overlay.setStatus(comic.statusText(entry.mode), { progress: 0.05 });
      // Only from the element still holding this page. Sign-in or a slow fetch
      // can have taken long enough for the reader to turn away, and a recycled
      // slot would hand over another page's pixels under this job's name.
      const imageBase64 = comic.entryMatchesImage(entry, entry.img) ? capturePageBytes(entry.img) : null;
      if (!imageBase64) {
        overlay.setError(t('comicImageUnavailable'));
        comic.offerDismiss(overlay);
        return;
      }
      created = await submitJob({ entry, overlay, pageUrl, targetLang, imageBase64 });
      if (!created.ok && created.declined) return;
    }

    if (!created.ok) {
      comic.showJobError(overlay, created.error);
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
    comic.rememberJob(entry, 'running');

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
        comic.dropRecord(entry.pageId, entry.mode);
        overlay.destroy();
      }
    }]);

    while (Date.now() - startedAt < comic.JOB_TIMEOUT_MS) {
      if (entry.cancelled) return;
      const elapsed = Date.now() - startedAt;
      await sleep(elapsed < comic.FAST_WINDOW_MS ? comic.POLL_FAST_MS : comic.POLL_SLOW_MS);
      if (entry.cancelled) return;

      const polled = await sendMessage({ type: 'COMIC_JOB_POLL', jobId });
      if (!polled.ok) {
        // A blip between polls is not a failed job — the reservation is still
        // held server-side, so keep waiting rather than abandoning it.
        if (polled.error.code === 'network_error') continue;
        comic.dropRecord(entry.pageId, entry.mode);
        comic.showJobError(overlay, polled.error);
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
        comic.dropRecord(entry.pageId, entry.mode);
        comic.showJobError(overlay, job.error || { code: 'failed', message: '' });
        return;
      }

      // Server progress is coarse (queued/running/done). Creeping it with
      // elapsed time keeps the bar honest about the stage while still moving.
      const estimate = Math.min(0.9, 0.1 + elapsed / comic.JOB_TIMEOUT_MS * 1.6);
      overlay.setStatus(comic.statusText(entry.mode), {
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
      comic.ABANDON_TIMEOUT_MS
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
    if (confirmed) comic.dropRecord(entry.pageId, entry.mode);
    overlay.setError(confirmed ? t('comicTimeout') : t('comicTimeoutUnconfirmed'));
    comic.offerDismiss(overlay);
  }

  /**
   * Order the page, stopping for the reader's consent if the server asks.
   *
   * Every create in runJob goes through here rather than through createJob,
   * because the 409 can land on any of them: the first attempt, the retry after
   * a sign-in (a signed-out user has no balance to quote against, so their
   * *first* quote arrives here), and the re-upload after needsPageBytes.
   *
   * The prompt is drawn on the overlay — the card already pinned to the page
   * being ordered. It is the only surface in this feature that can say WHICH
   * page the price is for, which matters on a spread where two jobs are in
   * flight at once, and it is where the user is already looking. The other
   * candidates were both worse: the service worker has no UI at all and would
   * have to invent one (a notification, a popup) that appears away from the
   * page, and window.confirm() blocks the whole tab and is styled by the site's
   * chrome, not ours. promptSignIn is the existing precedent for exactly this
   * shape of interruption, and this follows it.
   *
   * Resolves to the usual envelope, plus `declined: true` when the reader said
   * no. Declining is a cancel, not an error: the 409 reserved nothing and no
   * job id exists yet, so there is nothing to abandon, nothing to remember and
   * nothing to refund — the caller just returns.
   */
  function submitJob({ entry, overlay, pageUrl, targetLang, imageBase64 }) {
    return ComicCharge.submitWithConfirmation({
      // A closure, not a parameter, and that is the point: the retry after a
      // confirmation can only reach entry.operationId, so it structurally
      // cannot become a second operation the server would charge twice for.
      submit: (confirmCharge) => createJob({ entry, pageUrl, targetLang, imageBase64, confirmCharge }),
      confirm: async (quote) => {
        // The reader's turn, so the clock stops — exactly as it does for
        // sign-in. Counting the time someone spends reading a price as redraw
        // time would also spend their timeout budget on it.
        overlay.stopTimer();
        const approved = await comic.promptCharge(overlay, quote);
        if (!approved) return false;
        overlay.setStatus(comic.statusText(entry.mode), { progress: 0 });
        overlay.startTimer(Date.now());
        return true;
      }
    });
  }

  function createJob({ entry, pageUrl, targetLang, imageBase64, confirmCharge }) {
    return sendMessage({
      type: 'COMIC_JOB_CREATE',
      job: {
        operationId: entry.operationId,
        // Only ever true, and only after the reader said so — see submitJob.
        confirmCharge: confirmCharge === true,
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
    overlay.setStatus(comic.statusText(entry.mode), { progress: 1 });

    // Decode before swapping: replacing src directly would blank the image for
    // as long as the download takes, on top of the wait the user already had.
    const loaded = await preloadImage(job.resultUrl);

    // A presigned URL that expired, a network drop, bytes that will not decode —
    // swapping anyway would replace a readable page with a broken-image icon and
    // report it as success. The redraw is done and paid for, so the result is
    // still there on a retry; say so instead of destroying what the user has.
    if (!loaded) {
      overlay.setError(t('comicResultUnavailable'));
      comic.offerDismiss(overlay);
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
    if (entry.detached || !comic.entryMatchesImage(entry, entry.img)) {
      overlay.destroy();
      entry.overlay = null;
      comic.rememberJob(entry, 'succeeded');
      sendMessage({ type: 'COMIC_ACCOUNT', force: true });
      return;
    }

    comic.showResult(entry, job.resultUrl);
    overlay.destroy();
    entry.overlay = null;
    if (!entry.badge) comic.attachToggleBadge(entry);
    // The presigned URL in the DOM dies in 30 minutes and the swap is view
    // state a reload throws away — but the redraw itself is in the bucket for
    // days. Keeping the record is what lets the next visit to this page mint a
    // new URL and put the translation back, instead of making the user spend a
    // second free page on one they already translated.
    comic.rememberJob(entry, 'succeeded');
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
    if (base64Bytes(dataUrl) > comic.MAX_UPLOAD_BYTES) {
      // PNG of a scanned page is often several times its JPEG original.
      dataUrl = canvas.toDataURL('image/jpeg', 0.92);
      if (base64Bytes(dataUrl) > comic.MAX_UPLOAD_BYTES) return null;
    }
    return dataUrl;
  }

  function base64Bytes(dataUrl) {
    const payload = dataUrl.slice(dataUrl.indexOf(',') + 1);
    return Math.floor(payload.length * 0.75);
  }

  // 别的文件要用的，都从这张架子上取。
  Object.assign(comic, {
    resumeRecord, sendMessage, watchPageSwaps,
  });

  ctx.startComicTranslation = startComicTranslation;
  ctx.startComicPageTranslation = startComicPageTranslation;
  ctx.hasComicPageOnScreen = () => comic.pickComicImages().length > 0;
  // 包一层而不是直接赋值：架子上的这一格由 content/comic/memory.js 挂上，
  // 这么写就不必假定它比这个文件先装。
  ctx.resumeComicJobs = () => comic.resumeComicJobs();
})();
