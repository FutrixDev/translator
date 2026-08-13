// AI Translator — local PDF upload page.
//
// This page exists because no content script can reach a local file: the user
// picks (or drops) a PDF here, the bytes go to the service worker as base64 —
// an ArrayBuffer does not survive runtime messaging — and the worker runs the
// upload-and-create sequence in pdf-client.js. From then on this page is just
// a viewport onto the job: it polls, draws progress, and offers the results.

(function () {
  'use strict';

  const PDF_UI = globalThis.AI_TRANSLATOR_PDF_UI;
  // Kept in sync with MAX_PDF_BYTES in background/pdf-client.js.
  const MAX_PDF_BYTES = 30 * 1024 * 1024;
  const POLL_MS = 2500;

  const elements = {
    drop: document.getElementById('pdfDrop'),
    fileInput: document.getElementById('pdfFileInput'),
    jobCard: document.getElementById('pdfJobCard'),
    fileName: document.getElementById('pdfFileName'),
    statusText: document.getElementById('pdfStatusText'),
    progressTrack: document.getElementById('pdfProgressTrack'),
    progressBar: document.getElementById('pdfProgressBar'),
    error: document.getElementById('pdfError'),
    openDual: document.getElementById('pdfOpenDual'),
    openMono: document.getElementById('pdfOpenMono'),
    retry: document.getElementById('pdfRetry'),
    signIn: document.getElementById('pdfSignIn'),
    abandon: document.getElementById('pdfAbandon')
  };

  let currentUILang = 'en';
  const t = (key) => getMessage(key, currentUILang);

  // The file currently being shepherded. `operationId` is minted when the
  // file is chosen and reused on a retry after transport trouble, so such a
  // retry adopts the existing job instead of paying for a second one. It is
  // re-minted the moment it is known to be burned — a terminal job, or a 409
  // for an operation the server already settled — because the server adopts
  // by id regardless of status and would replay the dead outcome forever.
  let currentFile = null;
  let currentJobId = null;
  let pollTimer = null;

  function applyI18n(targetLang) {
    currentUILang = getUILanguage(targetLang);
    document.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.getAttribute('data-i18n');
      const text = t(key);
      if (text && text !== key) el.textContent = text;
    });
    document.title = t('pdfUploadTitle');
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

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  function hideActions() {
    [elements.openDual, elements.openMono, elements.retry,
     elements.signIn, elements.abandon]
      .forEach(btn => { btn.hidden = true; });
  }

  function showError(text) {
    elements.error.textContent = text;
    elements.error.hidden = false;
  }

  function setProgress(percent) {
    const clamped = Math.max(0, Math.min(100, Math.round(percent || 0)));
    elements.progressBar.style.width = `${clamped}%`;
  }

  function renderStarting() {
    elements.jobCard.hidden = false;
    elements.fileName.textContent = currentFile.name;
    elements.statusText.textContent = t('pdfUploading');
    elements.error.hidden = true;
    elements.progressTrack.hidden = false;
    setProgress(2);
    hideActions();
  }

  function renderView(view) {
    elements.jobCard.hidden = false;
    elements.fileName.textContent = currentFile ? currentFile.name : '';
    elements.statusText.textContent = t(PDF_UI.pdfStatusKey(view));
    hideActions();

    if (PDF_UI.isPdfJobActive(view)) {
      elements.error.hidden = true;
      elements.progressTrack.hidden = false;
      // Never regress to 0 while queued — the upload already happened.
      setProgress(Math.max(2, view.progress || 0));
      elements.abandon.hidden = false;
      return;
    }

    if (view.status === 'succeeded') {
      elements.error.hidden = true;
      elements.progressTrack.hidden = false;
      setProgress(100);
      const results = view.results || {};
      elements.openDual.hidden = !results.dualUrl;
      elements.openMono.hidden = !results.monoUrl;
      return;
    }

    // failed / abandoned. This job is over, and the server adopts by
    // (user, operationId) regardless of status — a retry replaying this id
    // would only re-adopt this same dead job. The next attempt is new paid
    // work, so it gets a new id. (Lost-response failures never reach here —
    // they fail in startJob, where the id is deliberately kept.)
    if (currentFile) currentFile.operationId = crypto.randomUUID();
    elements.progressTrack.hidden = true;
    renderFailure(view.error || { code: view.status });
  }

  /** Terminal failures and create-time rejections share one presentation. */
  function renderFailure(error) {
    const code = error && error.code;
    showError(PDF_UI.pdfErrorMessage(error, t));

    if (code === 'unauthorized' || (error && error.loginRequired)) {
      elements.signIn.hidden = false;
      return;
    }
    // A used-up monthly allowance offers no action — retrying it now would fail
    // the same way, and there is nothing to buy. A switched-off feature is the
    // same shape: this page outlived the switch, and every retry is refused
    // until the setting goes back on.
    if (code === 'insufficient_points' || code === 'feature_disabled') return;
    // Anything else gets a retry. Which operationId it replays is decided
    // where the failure was observed: a terminal job or a settled-operation
    // 409 minted a fresh id (the old one is a dead end on the server), while
    // a network/upload failure kept it (replaying it is what stops a lost
    // response from becoming a double charge).
    if (currentFile) elements.retry.hidden = false;
  }

  // -------------------------------------------------------------------------
  // Job lifecycle
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

  async function poll() {
    if (!currentJobId) return;
    const response = await sendMessage({ type: 'PDF_JOB_GET', jobId: currentJobId });
    if (!response.ok) {
      // A transient poll failure is not a job failure; keep watching unless
      // the account itself is the problem.
      if (response.error && response.error.code === 'unauthorized') {
        stopPolling();
        hideActions();
        renderFailure(response.error);
        return;
      }
      schedulePoll();
      return;
    }
    renderView(response.data);
    if (PDF_UI.isPdfJobActive(response.data)) {
      schedulePoll();
    } else {
      stopPolling();
    }
  }

  async function startJob() {
    if (!currentFile) return;
    stopPolling();
    currentJobId = null;
    renderStarting();

    const response = await sendMessage({
      type: 'PDF_CREATE_JOB',
      source: { kind: 'bytes', bytesBase64: currentFile.bytesBase64 },
      fileName: currentFile.name,
      operationId: currentFile.operationId
    });

    if (!response.ok) {
      const code = response.error && response.error.code;
      // The 409s that can never succeed on replay: the id names an operation
      // the server already settled, or a job with different settings. Mint a
      // fresh id so Retry starts a genuinely new attempt. Every other failure
      // keeps the id — after a lost response it is exactly what makes Retry
      // adopt the job instead of paying for a second one.
      if (code === 'operation_already_finished' || code === 'output_conflict' || code === 'job_conflict') {
        currentFile.operationId = crypto.randomUUID();
      }
      elements.statusText.textContent = t('pdfStatusFailed');
      elements.progressTrack.hidden = true;
      renderFailure(response.error || {});
      return;
    }

    currentJobId = response.data.jobId;
    renderView(response.data);
    if (PDF_UI.isPdfJobActive(response.data)) schedulePoll();
  }

  async function abandonJob() {
    if (!currentJobId) return;
    stopPolling();
    const response = await sendMessage({ type: 'PDF_JOB_ABANDON', jobId: currentJobId });
    if (response.ok) {
      renderView(response.data);
    } else {
      // Abandon raced completion or the network: show whatever the job truly is.
      poll();
    }
  }

  async function signIn() {
    elements.signIn.disabled = true;
    const response = await sendMessage({ type: 'COMIC_SIGN_IN' });
    elements.signIn.disabled = false;
    if (response.ok) startJob();
  }

  function openResult(which) {
    if (!currentJobId) return;
    sendMessage({ type: 'PDF_OPEN_RESULT', jobId: currentJobId, which });
  }

  // -------------------------------------------------------------------------
  // File intake
  // -------------------------------------------------------------------------

  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    const CHUNK = 0x8000;
    let binary = '';
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  }

  function isPdfBytes(buffer) {
    const b = new Uint8Array(buffer);
    return b.length >= 5 &&
      b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2d;
  }

  async function acceptFile(file) {
    if (!file) return;
    stopPolling();
    currentJobId = null;
    currentFile = null;

    elements.jobCard.hidden = false;
    elements.fileName.textContent = file.name;
    elements.statusText.textContent = '';
    elements.progressTrack.hidden = true;
    elements.error.hidden = true;
    hideActions();

    // Both checks before any upload: the server would refuse these anyway,
    // after the user waited through 30 MiB of transfer.
    if (file.size > MAX_PDF_BYTES) {
      showError(t('pdfErrTooLarge'));
      return;
    }
    const buffer = await file.arrayBuffer();
    if (!isPdfBytes(buffer)) {
      showError(t('pdfErrInvalid'));
      return;
    }

    currentFile = {
      name: file.name || 'document.pdf',
      bytesBase64: arrayBufferToBase64(buffer),
      operationId: crypto.randomUUID()
    };
    startJob();
  }

  function setupDropZone() {
    elements.drop.addEventListener('click', () => elements.fileInput.click());
    elements.drop.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        elements.fileInput.click();
      }
    });
    elements.fileInput.addEventListener('change', () => {
      acceptFile(elements.fileInput.files[0]);
      // So choosing the same file again still fires a change event.
      elements.fileInput.value = '';
    });

    ['dragenter', 'dragover'].forEach(name => {
      elements.drop.addEventListener(name, (event) => {
        event.preventDefault();
        elements.drop.classList.add('is-dragover');
      });
    });
    ['dragleave', 'drop'].forEach(name => {
      elements.drop.addEventListener(name, (event) => {
        event.preventDefault();
        elements.drop.classList.remove('is-dragover');
      });
    });
    elements.drop.addEventListener('drop', (event) => {
      const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
      acceptFile(file);
    });
  }

  document.addEventListener('DOMContentLoaded', async () => {
    const settings = await chrome.storage.sync.get({ targetLang: 'zh-CN', theme: 'light' });
    document.documentElement.setAttribute('data-theme', settings.theme || 'light');
    applyI18n(settings.targetLang);

    setupDropZone();
    elements.retry.addEventListener('click', startJob);
    elements.signIn.addEventListener('click', signIn);
    elements.abandon.addEventListener('click', abandonJob);
    elements.openDual.addEventListener('click', () => openResult('dual'));
    elements.openMono.addEventListener('click', () => openResult('mono'));

    window.addEventListener('unload', stopPolling);
  });
})();
