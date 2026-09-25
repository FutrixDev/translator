// Blab Translation — the document upload page, and the job page.
//
// No content script can reach a local file, so this page is where one comes
// in: the user picks or drops a PDF, Word, EPUB, MOBI, TXT or Markdown file,
// the page refuses what the server would refuse anyway (before a single byte
// moves), measures a flow document so the server can bill it up front, asks
// the service worker for a presigned upload URL, PUTs the File itself, and
// only then asks the worker to create the job. The bytes never go through the
// worker (IRON RULE: the presigned URL is the only way in), and never through
// runtime messaging either — a 50 MiB file does not fit.
//
// From then on it is a viewport onto one job: it polls, draws the card
// (pdf/job-view.js does the drawing), asks for the over-page confirmation and
// hands out the results. Opened as `upload.html#job=<id>` — from a
// notification, the popup or the settings page — it takes over that job with
// no file in hand.

(function () {
  'use strict';

  const DocJobs = globalThis.DocJobs;
  const DocMeasure = globalThis.DocMeasure;
  const JV = globalThis.DocJobView;
  const PDF_UI = globalThis.AI_TRANSLATOR_PDF_UI;
  // D9's charge handshake, the same module the comic overlay and the service
  // worker use. Nothing in it is comic-specific — see shared/comic-charge.js.
  const ChargeConfirm = globalThis.ChargeConfirm;
  // This page's wording of the shared price sentence.
  const CHARGE_KEYS = { required: 'pdfChargeRequired', fallback: 'pdfChargeConfirm' };
  const POLL_MS = 2500;
  // The 409s that can never succeed on replay: the id names an operation the
  // server already settled, or a job with different settings.
  const BURNED_ID_CODES = new Set(['operation_already_finished', 'output_conflict', 'job_conflict']);
  // What a vanished job reads as: the generic failure, not a guess.
  const GENERIC_FAILURE = { code: 'failed' };

  const el = JV.elementsOf(document);
  const drop = document.getElementById('pdfDrop');
  const fileInput = document.getElementById('pdfFileInput');

  let currentUILang = 'en';
  const t = (key) => getMessage(key, currentUILang);
  const fill = (text, values) => Object.keys(values)
    .reduce((out, name) => out.split(`{${name}}`).join(String(values[name])), text);

  // The file being shepherded: {file, name, format, operationId,
  // declaredUnits, uploaded}. `operationId` is minted when the file is chosen
  // and replayed by every retry until it is known to be burned (a terminal
  // job, a settled-operation 409) — replaying it is what turns a lost response
  // into an adopted job rather than a second charge. `uploaded` names the
  // operation the stored source belongs to, so a retry under the same id skips
  // the upload. Null on a job page that was opened by its id.
  let currentFile = null;
  // The job on screen: {id, fileName, format}. Null until a create succeeds.
  let job = null;
  let pollTimer = null;
  let webBase = '';
  // Bumped per chosen file: an inspection that finishes after the user picked
  // another file must not start anything.
  let intake = 0;

  function applyI18n(uiLanguage) {
    currentUILang = getUILanguage(uiLanguage);
    document.querySelectorAll('[data-i18n]').forEach(node => {
      const key = node.getAttribute('data-i18n');
      const text = t(key);
      if (text && text !== key) node.textContent = text;
    });
    document.title = t('pdfUploadTitle');
    const limit = document.querySelector('[data-i18n="pdfUploadLimit"]');
    if (limit) {
      limit.textContent = fill(t('pdfUploadLimit'), {
        pdf: DocJobs.megabyteLabel(DocJobs.maxBytesFor('pdf')),
        book: DocJobs.megabyteLabel(DocJobs.maxBytesFor('epub')),
        text: DocJobs.megabyteLabel(DocJobs.maxBytesFor('txt'))
      });
    }
  }

  function sendMessage(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: { code: 'no_response', message: chrome.runtime.lastError.message } });
            return;
          }
          resolve(response || { ok: false, error: { code: 'no_response' } });
        });
      } catch (error) {
        resolve({ ok: false, error: { code: 'extension_context', message: String(error) } });
      }
    });
  }

  /** The id is burned: the next attempt is new work, under a new id and key. */
  function remint(file) {
    file.operationId = crypto.randomUUID();
    file.uploaded = null;
  }

  // -------------------------------------------------------------------------
  // Polling and the job card
  // -------------------------------------------------------------------------

  function stopPolling() {
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  }

  function schedulePoll() {
    stopPolling();
    pollTimer = setTimeout(poll, POLL_MS);
  }

  function renderFailure(error, hasFile) {
    JV.renderFailure(el, { fileName: job ? job.fileName : (currentFile && currentFile.name), error, hasFile }, t);
  }

  /** Draw the job as the server described it; keep polling only while it moves. */
  function handleView(view) {
    stopPolling();
    if (!job) return;
    job.fileName = view.fileName || job.fileName;
    job.format = view.sourceFormat || job.format;
    // This job is over, and the server adopts by (user, operationId)
    // regardless of status — a retry replaying this id would only re-adopt
    // the same dead job. A job waiting for confirmation is NOT over: its id
    // is still the one "Continue" is about (defect 2).
    if ((view.status === 'failed' || view.status === 'abandoned') && currentFile) remint(currentFile);
    JV.renderJob(el, {
      view,
      format: job.format,
      fileName: job.fileName,
      hasFile: !!currentFile,
      webBase,
      uiLang: currentUILang
    }, t);
    // A job waiting for confirmation does not change by itself, so it is not
    // polled; "Continue" resumes.
    if (DocJobs.isActiveStatus(view.status)) schedulePoll();
  }

  async function poll() {
    const jobId = job && job.id;
    if (!jobId) return;
    const response = await sendMessage({ type: 'PDF_JOB_GET', jobId });
    if (!job || job.id !== jobId) return;
    if (response.ok) {
      handleView(response.data);
      return;
    }
    const error = response.error || {};
    if (JV.wantsSignIn(error)) {
      stopPolling();
      renderFailure(error, false);
      return;
    }
    if (error.status === 404) {
      stopPolling();
      renderFailure(GENERIC_FAILURE, false);
      return;
    }
    // A transient poll failure is not a job failure; keep watching.
    schedulePoll();
  }

  function adoptJob(view) {
    job = { id: view.jobId, fileName: view.fileName || '', format: view.sourceFormat || null };
    // A reload lands back on this job instead of an empty drop zone.
    history.replaceState(null, '', '#job=' + encodeURIComponent(view.jobId));
    handleView(view);
  }

  // -------------------------------------------------------------------------
  // Upload and create
  // -------------------------------------------------------------------------

  function holdPage(event) {
    event.preventDefault();
    event.returnValue = '';
  }

  /**
   * PUT the File to the presigned URL. XHR, not fetch: only XHR reports upload
   * progress. The extension's host permission covers the storage origin, so
   * this is not subject to the bucket's CORS rules.
   */
  function putFile(url, file, contentType, onProgress) {
    return new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', url);
      xhr.setRequestHeader('Content-Type', contentType);
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable && event.total > 0) {
          onProgress(Math.min(100, Math.floor((event.loaded * 100) / event.total)));
        }
      };
      xhr.onload = () => resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status });
      xhr.onerror = () => resolve({ ok: false, status: 0 });
      xhr.onabort = () => resolve({ ok: false, status: 0 });
      xhr.ontimeout = () => resolve({ ok: false, status: 0 });
      xhr.send(file);
    });
  }

  /**
   * Idempotent: a retry under the operation id the stored source belongs to
   * skips the ticket and the PUT.
   */
  async function ensureUploaded(file) {
    if (file.uploaded && file.uploaded.operationId === file.operationId) return { ok: true };
    const operationId = file.operationId;
    const ticket = await sendMessage({
      type: 'PDF_UPLOAD_TICKET',
      operationId,
      byteSize: file.file.size,
      sourceFormat: file.format,
      fileName: file.name
    });
    if (!ticket.ok) return ticket;

    const { uploadUrl, sourceKey, pendingJobId } = ticket.data;
    window.addEventListener('beforeunload', holdPage);
    let put;
    try {
      put = await putFile(uploadUrl, file.file, DocJobs.contentTypeFor(file.format), (percent) => {
        if (currentFile === file) JV.renderUploading(el, { fileName: file.name, percent }, t);
      });
    } finally {
      window.removeEventListener('beforeunload', holdPage);
    }
    if (!put.ok) {
      // Status and operation id only: the URL is a credential.
      console.warn(`[pdf] upload PUT failed: HTTP ${put.status} op=${operationId}`);
      // The receipt the ticket wrote describes an upload that did not happen.
      await sendMessage({ type: 'PDF_JOB_DISMISS', jobId: pendingJobId });
      return { ok: false, error: { code: 'upload_failed', status: put.status } };
    }
    file.uploaded = { operationId, sourceKey };
    return { ok: true };
  }

  /** Resolves true to spend the credits, false to leave them alone. */
  function promptCharge(quote) {
    return new Promise((resolve) => {
      JV.renderCharge(el, {
        fileName: currentFile ? currentFile.name : '',
        text: ChargeConfirm.chargeText(quote, t, CHARGE_KEYS)
      });
      const answer = (approved) => {
        el.confirmCharge.removeEventListener('click', onApprove);
        el.declineCharge.removeEventListener('click', onDecline);
        // The question is over, so its buttons go with it: a late click on a
        // stale Cancel would land while a paid create was already in flight.
        el.confirmCharge.hidden = true;
        el.declineCharge.hidden = true;
        resolve(approved);
      };
      const onApprove = () => {
        answer(true);
        JV.renderUploading(el, { fileName: currentFile ? currentFile.name : '', percent: null }, t);
      };
      const onDecline = () => answer(false);
      el.confirmCharge.addEventListener('click', onApprove);
      el.declineCharge.addEventListener('click', onDecline);
    });
  }

  /**
   * Upload (once) and create, asking the user first if the server says it
   * costs credits. The server refuses an unconfirmed create that would spend
   * credits with a 409 carrying its quote, having reserved nothing; the retry
   * that says yes carries the SAME operationId, so it is the same operation,
   * not a second charge for one file.
   */
  function submitJob(file) {
    return ChargeConfirm.submitWithConfirmation({
      submit: async (confirmCharge) => {
        const upload = await ensureUploaded(file);
        if (!upload.ok) return upload;
        const message = {
          type: 'PDF_CREATE_JOB',
          operationId: file.operationId,
          fileName: file.name,
          // Only ever true after the user has said so; the worker sends
          // nothing at all otherwise, which is already the server's "no".
          confirmCharge: confirmCharge === true,
          source: { kind: 'uploaded', sourceKey: file.uploaded.sourceKey, sourceFormat: file.format }
        };
        // Declared only when measured: the server counts the rest itself.
        if (file.declaredUnits != null) message.declaredUnits = file.declaredUnits;
        return sendMessage(message);
      },
      confirm: promptCharge
    });
  }

  async function startJob() {
    const file = currentFile;
    if (!file) return;
    stopPolling();
    job = null;
    JV.renderUploading(el, { fileName: file.name, percent: null }, t);

    const response = await submitJob(file);
    if (currentFile !== file) return;

    if (!response.ok && response.declined) {
      JV.renderDeclined(el, { fileName: file.name, hasFile: true }, t);
      return;
    }
    if (!response.ok) {
      const error = response.error || {};
      // Every other failure keeps the id — after a lost response it is
      // exactly what makes Retry adopt the job instead of paying twice.
      if (BURNED_ID_CODES.has(error.code)) remint(file);
      // The stored source is gone (or never landed): upload again, same id.
      else if (error.code === 'missing_source') file.uploaded = null;
      renderFailure(error, true);
      return;
    }
    adoptJob(response.data);
  }

  // -------------------------------------------------------------------------
  // The job's own buttons
  // -------------------------------------------------------------------------

  async function continueJob() {
    const jobId = job && job.id;
    if (!jobId) return;
    el.confirmContinue.disabled = true;
    const response = await sendMessage({ type: 'PDF_JOB_CONFIRM', jobId });
    el.confirmContinue.disabled = false;
    if (!job || job.id !== jobId) return;
    if (response.ok) {
      handleView(response.data);
      return;
    }
    const error = response.error || {};
    if (error.status === 409 || error.code === 'not_awaiting_confirm') {
      // Someone else answered, or the window closed: show what it is now.
      await poll();
      JV.showMessage(el, t('docErrNotAwaiting'), false);
      return;
    }
    if (JV.wantsSignIn(error)) {
      renderFailure(error, false);
      return;
    }
    if (error.status === 404) {
      renderFailure(GENERIC_FAILURE, false);
      return;
    }
    // 402 and anything transient: say so, and leave Continue and Cancel Task
    // where they are — the question is still open.
    JV.showMessage(el, PDF_UI.pdfErrorMessage(error, t), true);
  }

  async function abandonJob() {
    const jobId = job && job.id;
    if (!jobId) return;
    stopPolling();
    const response = await sendMessage({ type: 'PDF_JOB_ABANDON', jobId });
    if (!job || job.id !== jobId) return;
    // Abandon raced completion or the network: show whatever the job truly is.
    if (response.ok) handleView(response.data);
    else poll();
  }

  async function signIn() {
    el.signIn.disabled = true;
    const response = await sendMessage({ type: 'COMIC_SIGN_IN' });
    el.signIn.disabled = false;
    if (!response.ok) return;
    // A job that exists only needs to be looked at again; a create that was
    // refused for want of an account is tried again.
    if (job) poll();
    else startJob();
  }

  /** A fresh view: presigned result URLs expire, the one on screen may have. */
  async function freshView() {
    const jobId = job && job.id;
    if (!jobId) return null;
    const response = await sendMessage({ type: 'PDF_JOB_GET', jobId });
    if (!job || job.id !== jobId) return null;
    if (!response.ok) {
      JV.showMessage(el, PDF_UI.pdfErrorMessage(response.error || {}, t), true);
      return null;
    }
    return response.data;
  }

  /** PDF: Chrome shows it, so the result opens in a tab. */
  async function openResult(which) {
    const view = await freshView();
    if (!view) return;
    const target = DocJobs.openTargetFor({ status: view.status, format: 'pdf', results: view.results }, which);
    if (target.kind === 'result') chrome.tabs.create({ url: target.url });
    else handleView(view);
  }

  /**
   * Word, EPUB, TXT, Markdown: saved under the user's own file name. Opening
   * the URL would name the file after its storage key, and show a TXT or
   * Markdown result in the tab instead of saving it.
   */
  async function saveResult(which) {
    const view = await freshView();
    if (!view) return;
    const results = view.results || {};
    const url = which === 'mono' ? results.monoUrl : results.dualUrl;
    if (!url) {
      handleView(view);
      return;
    }
    let blob;
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      blob = await response.blob();
    } catch (error) {
      console.warn(`[pdf] fetching the ${which} result of ${job.id} failed:`, error && error.message);
      JV.showMessage(el, PDF_UI.pdfErrorMessage({ code: 'network_error' }, t), true);
      return;
    }
    const suffix = t(which === 'mono' ? 'docResultTranslatedSuffix' : 'docResultBilingualSuffix');
    JV.downloadBlob(blob, DocJobs.resultFileName(job.fileName, job.format, suffix));
  }

  // -------------------------------------------------------------------------
  // File intake
  // -------------------------------------------------------------------------

  /**
   * Everything the server would refuse, refused here — in this order, with no
   * network request — plus the measured length of a flow document.
   */
  async function inspectFile(file) {
    const format = DocJobs.formatFromFileName(file.name);
    if (!format) return { error: { code: 'unsupported_format' } };
    if (file.size === 0) return { error: { code: 'empty_document', format } };
    const maxBytes = DocJobs.maxBytesFor(format);
    if (file.size > maxBytes) {
      const code = format === 'pdf' ? 'pdf_too_large' : 'file_too_large';
      return { error: { code, maxBytes, bytes: file.size, format } };
    }
    const head = new Uint8Array(await file.slice(0, DocJobs.SNIFF_BYTES).arrayBuffer());
    if (!DocJobs.matchesDeclaredFormat(head, format)) return { error: { code: 'unsupported_format', format } };
    if (!DocJobs.isMeasurable(format)) return { format, declaredUnits: null };

    // Null is not a refusal: the server may read what this could not.
    const measured = await DocMeasure.measureFlowUnits(new Uint8Array(await file.arrayBuffer()), format);
    const maxPages = DocJobs.FLOW_MAX_STANDARD_PAGES;
    if (measured && measured.units > maxPages) {
      return { error: { code: 'too_many_pages', maxPages, pageCount: measured.units, format } };
    }
    return { format, declaredUnits: measured ? measured.units : null };
  }

  async function acceptFile(file) {
    if (!file) return;
    const turn = ++intake;
    stopPolling();
    job = null;
    currentFile = null;
    // A new file is a new flow: the job this page was showing stays in the
    // popup and the settings page.
    history.replaceState(null, '', location.pathname + location.search);

    const verdict = await inspectFile(file);
    if (turn !== intake) return;
    if (verdict.error) {
      JV.renderFailure(el, { fileName: file.name, error: verdict.error, hasFile: false }, t);
      return;
    }
    currentFile = {
      file,
      name: file.name,
      format: verdict.format,
      operationId: crypto.randomUUID(),
      declaredUnits: verdict.declaredUnits,
      uploaded: null
    };
    startJob();
  }

  function setupDropZone() {
    fileInput.setAttribute('accept', DocJobs.acceptList());
    drop.addEventListener('click', () => fileInput.click());
    drop.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        fileInput.click();
      }
    });
    fileInput.addEventListener('change', () => {
      acceptFile(fileInput.files[0]);
      // So choosing the same file again still fires a change event.
      fileInput.value = '';
    });

    ['dragenter', 'dragover'].forEach(name => {
      drop.addEventListener(name, (event) => {
        event.preventDefault();
        drop.classList.add('is-dragover');
      });
    });
    ['dragleave', 'drop'].forEach(name => {
      drop.addEventListener(name, (event) => {
        event.preventDefault();
        drop.classList.remove('is-dragover');
      });
    });
    drop.addEventListener('drop', (event) => {
      const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
      acceptFile(file);
    });
  }

  /** `#job=<id>`: a job opened from elsewhere. No file, so never a Retry. */
  function takeOverFromHash() {
    const match = /^#job=(.+)$/.exec(location.hash);
    if (!match) return;
    let jobId;
    try {
      jobId = decodeURIComponent(match[1]);
    } catch {
      return;
    }
    // A receipt has no server job behind it to show.
    if (!jobId || jobId.startsWith('local:')) return;
    job = { id: jobId, fileName: '', format: null };
    poll();
  }

  document.addEventListener('DOMContentLoaded', async () => {
    const settings = await chrome.storage.sync.get({ uiLanguage: '', theme: 'light' });
    document.documentElement.setAttribute('data-theme', settings.theme || 'light');
    applyI18n(settings.uiLanguage);

    setupDropZone();
    el.retry.addEventListener('click', startJob);
    el.signIn.addEventListener('click', signIn);
    el.abandon.addEventListener('click', abandonJob);
    el.confirmContinue.addEventListener('click', continueJob);
    el.openDual.addEventListener('click', () => openResult('dual'));
    el.openMono.addEventListener('click', () => openResult('mono'));
    el.saveDual.addEventListener('click', () => saveResult('dual'));
    el.saveMono.addEventListener('click', () => saveResult('mono'));
    window.addEventListener('unload', stopPolling);

    // Where the account lives on the web, for the finished job's link. Asked
    // before the takeover so a finished job's first paint already has it.
    const base = await sendMessage({ type: 'ACCOUNT_SITE_BASE' });
    if (base.ok && base.data) webBase = base.data.base || '';
    takeOverFromHash();
  });
})();
