// Blab Translation 漫画翻译 —— 本章汇总标
//
// 一页上翻了两张以上，视口右上角挂一个「翻译本章 5/12」：这一页翻到哪儿了、哪几张
// 没翻成、点一下能重试或全部取消、翻好的能直接去阅读台看。每张图自己的进度标照旧，
// 这里的数和它们是同一组状态数出来的。
(function() {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT;
  if (!ctx) return;
  // 这一族共用的架子，说明见 content/content-comic-translation.js 顶上。
  const comic = (ctx.comic = ctx.comic || {});

  const t = ctx.t;

  // Off the viewport corner, and below a native control by this much when one
  // is in the way.
  const EDGE = 12;
  const GAP = 8;
  // A stack of fixed headers is two or three deep; past this the pill stays
  // where the last step put it rather than walking down the page.
  const MAX_DODGES = 5;
  // What a reader might be about to press. The pill must not sit on one.
  const CONTROL = 'a[href], button, input, select, textarea, summary, [role="button"], [role="link"], [role="menuitem"], [role="tab"]';
  // Fewer than this and the page's own chip already says everything.
  const MIN_SHOWN = 2;

  /**
   * One task per page this document asked for, keyed by page id: the latest
   * run of that page, so a retry replaces its failure instead of adding a page.
   * `state` is running, done, failed or cancelled; a cancelled page is no
   * longer part of the count.
   */
  const tasks = new Map();
  let view = null;

  function taskOf(entry) {
    const task = tasks.get(entry.pageId);
    return task && task.entry === entry ? task : null;
  }

  /** A run starts on `entry` (translateImage, after the page index is read). */
  function summaryBegin(entry, { pageIndex, pageUrl, targetLang, mode }) {
    tasks.set(entry.pageId, {
      entry, state: 'running', reason: '', assetId: null, pageIndex, pageUrl, targetLang, mode
    });
    render();
  }

  /**
   * The page is on screen translated (finishSuccess). Wins over a cancel that
   * landed while the result was downloading: the chip shows it as done, and
   * Cancel all keeps finished pages.
   */
  function summaryDone(entry, job) {
    const task = taskOf(entry);
    if (!task) return;
    task.state = 'done';
    task.reason = '';
    task.assetId = job.assetId || null;
    if (Number.isInteger(job.pageIndex)) task.pageIndex = job.pageIndex;
    render();
  }

  /**
   * The run is over without a result (translateImage's finally, or a cancel).
   * The card's error is the reason; no error means the reader stopped it — a
   * cancel, a declined sign-in or charge — and the page leaves the count.
   */
  function summarySettle(entry) {
    const task = taskOf(entry);
    if (!task || task.state !== 'running') return;
    const reason = !entry.cancelled && entry.overlay ? entry.overlay.failure() : null;
    task.state = reason === null ? 'cancelled' : 'failed';
    task.reason = reason || '';
    render();
  }

  function counts() {
    const result = { running: 0, done: 0, failed: 0 };
    tasks.forEach((task) => {
      if (task.state in result) result[task.state] += 1;
    });
    result.total = result.running + result.done + result.failed;
    return result;
  }

  function byPage(a, b) {
    return a.pageIndex - b.pageIndex;
  }

  // Failed pages count toward showing it: a chapter of two whose second page
  // failed still needs the Retry it is the only place for.
  function render() {
    const count = counts();
    if (count.total < MIN_SHOWN) {
      if (view) view.destroy();
      view = null;
      return;
    }
    if (!view) view = createView();
    view.update(count);
  }

  function createView() {
    const root = document.createElement('div');
    root.className = 'ai-translator-comic-summary';
    root.innerHTML = `
      <button type="button" class="ai-translator-comic-summary-pill" aria-expanded="false">
        <span class="ai-translator-comic-summary-spinner"></span>
        <span class="ai-translator-comic-summary-label"></span>
      </button>
      <div class="ai-translator-comic-summary-card" hidden>
        <div class="ai-translator-comic-summary-heading" hidden></div>
        <div class="ai-translator-comic-summary-list"></div>
        <div class="ai-translator-comic-summary-actions"></div>
      </div>
    `;
    document.body.appendChild(root);

    const pill = root.querySelector('.ai-translator-comic-summary-pill');
    const label = root.querySelector('.ai-translator-comic-summary-label');
    const card = root.querySelector('.ai-translator-comic-summary-card');
    const heading = root.querySelector('.ai-translator-comic-summary-heading');
    const list = root.querySelector('.ai-translator-comic-summary-list');
    const actions = root.querySelector('.ai-translator-comic-summary-actions');

    pill.addEventListener('click', () => {
      card.hidden = !card.hidden;
      pill.setAttribute('aria-expanded', String(!card.hidden));
    });

    // Placed when it appears and when the window changes, never on scroll: the
    // controls it steps around are the fixed ones, which do not scroll either.
    const place = () => dodgeControls(root, pill);
    window.addEventListener('resize', place);
    place();

    return {
      update(count) {
        const text = t('comicSummaryLabel')
          .replace('{done}', String(count.done))
          .replace('{total}', String(count.total));
        label.textContent = text;
        pill.title = text;
        root.classList.toggle('is-busy', count.running > 0);
        root.classList.toggle('is-error', count.failed > 0 && count.running === 0);
        renderFailed(heading, list);
        renderActions(actions, count);
      },
      destroy() {
        window.removeEventListener('resize', place);
        root.remove();
      }
    };
  }

  function renderFailed(heading, list) {
    const failed = [...tasks.values()].filter(task => task.state === 'failed').sort(byPage);
    heading.hidden = !failed.length;
    heading.textContent = t('comicSummaryFailed');
    list.innerHTML = '';
    failed.forEach((task) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'ai-translator-comic-summary-item';
      const thumb = document.createElement('img');
      thumb.className = 'ai-translator-comic-summary-thumb';
      thumb.alt = '';
      thumb.src = task.entry.originalSrc;
      const text = document.createElement('span');
      text.className = 'ai-translator-comic-summary-text';
      const page = document.createElement('span');
      page.className = 'ai-translator-comic-summary-page';
      page.textContent = t('comicSummaryPage').replace('{n}', String(task.pageIndex + 1));
      const reason = document.createElement('span');
      reason.className = 'ai-translator-comic-summary-reason';
      reason.textContent = task.reason;
      text.append(page, reason);
      item.append(thumb, text);
      item.addEventListener('click', () => {
        // A page the reader turned away from has no element to scroll to;
        // the slot it was in now shows another page.
        if (task.entry.detached || !task.entry.img.isConnected) return;
        task.entry.img.scrollIntoView({ block: 'center' });
      });
      list.appendChild(item);
    });
  }

  function renderActions(actions, count) {
    actions.innerHTML = '';
    const add = (text, onClick, primary = false) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `ai-translator-comic-summary-btn${primary ? ' is-primary' : ''}`;
      button.textContent = text;
      button.addEventListener('click', onClick);
      actions.appendChild(button);
    };
    if (count.failed) add(t('comicSummaryRetry'), retryFailed, true);
    if (count.running) add(t('comicSummaryCancelAll'), cancelAll);
    if (firstReadable()) add(t('comicSummaryOpenReader'), openReader);
  }

  /**
   * Run the failed pages again, and only those. A page the reader turned away
   * from is left for its own chip: there is no element holding it to run on.
   */
  function retryFailed() {
    const failed = [...tasks.values()].filter(task => task.state === 'failed' && !task.entry.detached);
    failed.forEach(({ entry, pageUrl, targetLang, mode }) => {
      comic.translateImage(entry.img, { pageUrl, targetLang, mode })
        .catch(error => console.warn('Blab Translation: comic page retry failed', error));
    });
  }

  /** Stop every page still running; finished ones stay as they are. */
  function cancelAll() {
    [...tasks.values()]
      .filter(task => task.state === 'running')
      .forEach(task => comic.cancelJob(task.entry));
  }

  /** The finished page read first: where the reader opens the chapter. */
  function firstReadable() {
    return [...tasks.values()].filter(task => task.state === 'done' && task.assetId).sort(byPage)[0] || null;
  }

  async function openReader() {
    const task = firstReadable();
    if (!task) return;
    const result = await comic.sendMessage({ type: 'COMIC_OPEN_READER', assetId: task.assetId, pageIndex: task.pageIndex });
    if (result.ok) return;
    console.warn('Blab Translation: opening the chapter in the reader failed', result.error);
    comic.showDetachedError(t('comicSummaryOpenFailed'));
  }

  /**
   * Put the pill in the viewport's top-right corner, then step it down below
   * any page control under it — a reader's own toolbar button lives exactly
   * there. Only controls fixed to the viewport count; one that scrolls away
   * would make the pill jump as the page moves.
   */
  function dodgeControls(root, pill) {
    root.style.top = `${EDGE}px`;
    root.style.right = `${EDGE}px`;
    for (let i = 0; i < MAX_DODGES; i++) {
      const blocker = controlUnder(pill.getBoundingClientRect(), root);
      if (!blocker) return;
      root.style.top = `${Math.ceil(blocker.getBoundingClientRect().bottom) + GAP}px`;
    }
  }

  function controlUnder(rect, root) {
    const points = [
      [rect.left + 1, rect.top + 1], [rect.right - 1, rect.top + 1],
      [rect.left + 1, rect.bottom - 1], [rect.right - 1, rect.bottom - 1],
      [(rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2]
    ];
    for (const [x, y] of points) {
      for (const element of document.elementsFromPoint(x, y)) {
        if (root.contains(element)) continue;
        const control = element.closest(CONTROL);
        if (control && !control.closest(ctx.constants.OWN_UI_SELECTOR) && isFixed(control)) return control;
      }
    }
    return null;
  }

  function isFixed(element) {
    for (let node = element; node && node !== document.body; node = node.parentElement) {
      const position = getComputedStyle(node).position;
      if (position === 'fixed' || position === 'sticky') return true;
    }
    return false;
  }

  // 别的文件要用的，都从这张架子上取。
  Object.assign(comic, {
    summaryBegin, summaryDone, summarySettle,
  });
})();
