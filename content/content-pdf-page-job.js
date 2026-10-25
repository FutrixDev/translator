// Blab Translation — 这份 PDF 自己的任务，说在它自己那一页的条子上（shelf
// ctx.pdfPageJob）。
//
// 点下去之后，PDF 这一页的条子不走，改说这份文档的任务：在译（几成）→ 译好了，
// 「查看译文」一键打开阅读台；要确认就领他去任务页；没成就说为什么，还能重来的
// 给一个重试，重来也没用的（文件太大、扫描件、额度用完……）只给「查看」。只靠
// 系统通知不够：它一分钟才轮询一次，系统通知被关掉时干脆看不见，而用户就停在
// 这一页上等。
//
// 这一页的任务按网址认（服务工作者的 PDF_PAGE_JOB），所以重新载入、右键菜单、
// 问价之后才同意的那一份都认得出来：任务记录一变（chrome.storage.local 的
// pdfJobs），这里就再读一遍。打开 PDF 时只读本机存储，没有任务就一个请求都不发
// （content-media-hints.js 的铁律照旧）；只有在译、而且这一页看得见时才每几秒
// 让服务工作者去问一次。
//
// 条子本身由 content-media-hints.js 画（它把这里的 offer 排在提示前面）；这里
// 只知道任务该说什么、按钮办什么事。
(function () {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT;
  if (!ctx) return;

  const t = ctx.t;
  const JOB_POLL_MS = 4000;

  // PDF_PAGE_JOB 的回答：{ jobId, operationId, phase, text, retryable }，没有
  // 就是 null。jobId 在上传途中是 null：还没有可以打开的任务。
  let job = null;
  // 用户关掉的是哪一档（这一次提交 + phase）：同一档不再出，译好了照样出来说一声。
  // 按 operationId 认，不按 jobId：上传途中还没有 jobId，那一档关掉之后，拿到
  // jobId 的同一档不该又冒出来。
  let closedJob = '';
  // attach 给的两件事：repaint（条子重画）、retry（再交一次）。
  let hooks = null;
  let pollTimer = null;
  // 每一问一个号：回来晚了的那一问（存储变化和轮询撞在一起）不覆盖新的。
  let syncSeq = 0;

  // 发给服务工作者的消息都走 ctx.comic.sendMessage（content-comic-translation.js
  // 那一份，装在这个文件之后，所以调用时再取）：送不到、没人回、上下文失效时
  // 同步抛，它都折成 { ok: false, error } 回来。

  /**
   * 问服务工作者这份 PDF 的任务。refresh：先让它轮询一遍（在译时的那几秒一问）；
   * 否则只读本机存储。
   */
  async function syncJob(refresh) {
    const seq = ++syncSeq;
    clearTimeout(pollTimer);
    pollTimer = null;
    const reply = await ctx.comic.sendMessage({ type: 'PDF_PAGE_JOB', refresh });
    if (seq !== syncSeq) return;
    if (!reply.ok) {
      console.warn('Blab Translation: reading this PDF\'s translation job failed', reply.error);
      // 扩展重载过：这一页再也问不到了，别每几秒再撞一次。
      if (reply.error && reply.error.code === 'extension_context') return;
    } else {
      job = reply.data.job;
      hooks.repaint();
    }
    schedulePoll();
  }

  // 只在译的时候、这一页看得见的时候问。看不见时由服务工作者每分钟的轮询接着
  // 盯，它一写记录，onStorageChanged 就会叫醒这里。
  function schedulePoll() {
    clearTimeout(pollTimer);
    pollTimer = null;
    if (!job || job.phase !== 'running' || document.visibilityState !== 'visible') return;
    pollTimer = setTimeout(() => syncJob(true), JOB_POLL_MS);
  }

  // 要确认的任务不会自己动：他去网站上确认完回来，这一问就是让服务工作者去看看。
  function onVisibility() {
    if (document.visibilityState !== 'visible') {
      clearTimeout(pollTimer);
      pollTimer = null;
      return;
    }
    if (job && (job.phase === 'running' || job.phase === 'awaiting')) syncJob(true);
  }

  // 任务记录只在真变了的时候才触发（Chrome 的 onChanged 不报同值写入），而
  // PDF_PAGE_JOB 只读时只有清掉过期记录才会写，所以这里不会自己转圈。
  function onStorageChanged(changes, area) {
    if (area === 'local' && changes.pdfJobs) syncJob(false);
  }

  function jobKey(entry) {
    return `${entry.operationId}:${entry.phase}`;
  }

  // 译好了开阅读台，别的开任务页（openPdfJob 自己会再问一次状态）。
  async function openJob() {
    const reply = await ctx.comic.sendMessage({ type: 'PDF_OPEN_JOB', jobId: job.jobId, via: 'pdf_page' });
    // 条子在点下时把按钮钉住了，只有重画才放开：不画，「查看」就只能点一次。
    hooks.repaint();
    if (reply.ok) return;
    console.warn('Blab Translation: opening this PDF\'s translation failed', reply.error);
    const lost = reply.error && reply.error.code === 'extension_context';
    ctx.showAutoStatusNotice(t(lost ? 'pdfErrNetwork' : 'pdfErrUnavailable'));
  }

  function closeJob() {
    closedJob = jobKey(job);
    hooks.repaint();
  }

  // 主按钮：还能重来就重试；否则有任务可开就开它；上传途中什么都没有。
  function action() {
    if (job.phase === 'failed' && job.retryable) return { text: t('pdfRetry'), run: hooks.retry };
    if (!job.jobId) return null;
    return { text: t(job.phase === 'succeeded' ? 'pdfViewTranslation' : 'docView'), run: openJob };
  }

  ctx.pdfPageJob = {
    /** 认出这一页是 PDF 之后叫一次：开始跟这份文档的任务。 */
    attach(given) {
      if (hooks) throw new Error('pdfPageJob.attach: already attached');
      hooks = given;
      chrome.storage.onChanged.addListener(onStorageChanged);
      document.addEventListener('visibilitychange', onVisibility);
      syncJob(false);
    },

    /**
     * 再读一遍本机存储，读完才回。翻译交出去之后用：服务工作者回话时记录已经
     * 写好，条子当场换成任务，不等存储变化那一下。
     */
    resync() {
      return syncJob(false);
    },

    /** 这一页任务记录此刻是哪一档（operationId:phase），没有记录是 ''。 */
    key() {
      return job ? jobKey(job) : '';
    },

    /** 条子此刻该说的任务，或 null（没有任务，或这一档他关掉了）。 */
    offer({ busy }) {
      if (!job || closedJob === jobKey(job)) return null;
      return { text: job.text, accept: action(), decline: null, dismiss: closeJob, busy };
    },

    /**
     * 任务关掉之后，「按 ⌥M 翻译」还要不要回来：在译、待确认、译好了、重来也
     * 没用的失败都不要（那句话已经没有可补充的了）；取消了的、还能重来的失败
     * 照样可以从提示重来。
     */
    ownsBar() {
      return !!job && !(job.phase === 'abandoned' || (job.phase === 'failed' && job.retryable));
    },
  };
})();
