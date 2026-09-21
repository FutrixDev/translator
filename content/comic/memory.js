// Blab Translation 漫画翻译 —— 跨页任务记忆
//
// 一次重绘要一两分钟，比任何人愿意盯着一页看的时间都长，所以任务得活过翻页。这一份
// 是它活下来的地方：chrome.storage.local 里的记录、本次会话已知已买的页，以及回到
// 一页时把它认回来的那几步。
(function() {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT;
  if (!ctx) return;
  // 这一族共用的架子，说明见 content/content-comic-translation.js 顶上。
  const comic = (ctx.comic = ctx.comic || {});

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
      const pageId = record.pageId || (record.imageSrc ? comic.pageIdOfSrc(record.imageSrc) : '');
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
    return `${comic.normalizeMode(mode)}|${pageId}`;
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
      img => img.isConnected && (img.getAttribute(comic.PAGE_ID_ATTR) === pageId || comic.pageIdOf(img) === pageId)
    );
    if (!candidates.length) return null;
    return candidates.reduce(
      (winner, img) => (comic.renderedArea(img) > comic.renderedArea(winner) ? img : winner)
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
    if (!comic.comicEnabled()) return;
    const records = await loadRecords();
    Object.keys(records).forEach((key) => {
      const record = records[key];
      const group = knownPages.get(record.pageId) || [];
      group.push(record);
      knownPages.set(record.pageId, group);
    });
    if (!knownPages.size) return;
    comic.watchPageSwaps();

    // Largest match per page, for the thumbnail-strip reason above.
    const onScreen = new Map();
    Array.from(document.images).forEach((img) => {
      if (!img.isConnected) return;
      const pageId = comic.pageIdOf(img);
      if (!knownPages.has(pageId)) return;
      const best = onScreen.get(pageId);
      if (!best || comic.renderedArea(img) > comic.renderedArea(best)) onScreen.set(pageId, img);
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
    comic.resumeRecord(img, newest, group);
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

  // 别的文件要用的，都从这张架子上取。
  Object.assign(comic, {
    claimKnownPage, dropRecord, rememberJob, rememberPurchase, resumeComicJobs,
  });
})();
