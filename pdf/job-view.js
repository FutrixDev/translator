// Blab Translation — the job card on the document upload page, drawn.
//
// Pure drawing: every function here takes what to show and writes it into the
// card, and nothing else. It sends no message, keeps no state and decides no
// flow — pdf/upload.js owns the file, the job id, the polling and every button
// handler, and calls in here to paint. The split exists so the page's state
// machine and the question "which buttons does a succeeded EPUB get" can each
// be read on its own.
//
// The popup and the settings page do not use this file: they draw list rows,
// not a card.
(function () {
  'use strict';

  const DocJobs = globalThis.DocJobs;
  const PDF_UI = globalThis.AI_TRANSLATOR_PDF_UI;
  if (!DocJobs || !PDF_UI) throw new Error('job-view.js needs doc-jobs.js and pdf-ui.js loaded first');

  const IDS = {
    card: 'pdfJobCard',
    fileName: 'pdfFileName',
    statusText: 'pdfStatusText',
    progressTrack: 'pdfProgressTrack',
    progressBar: 'pdfProgressBar',
    error: 'pdfError',
    confirmPanel: 'docConfirmPanel',
    confirmText: 'docConfirmText',
    noFile: 'docNoFile',
    webLink: 'docWebLink',
    openDual: 'pdfOpenDual',
    openMono: 'pdfOpenMono',
    saveDual: 'docSaveDual',
    saveMono: 'docSaveMono',
    confirmContinue: 'docConfirmContinue',
    confirmCharge: 'pdfConfirmCharge',
    declineCharge: 'pdfDeclineCharge',
    retry: 'pdfRetry',
    signIn: 'pdfSignIn',
    abandon: 'pdfAbandon'
  };

  const BUTTONS = [
    'openDual', 'openMono', 'saveDual', 'saveMono', 'confirmContinue',
    'confirmCharge', 'declineCharge', 'retry', 'signIn', 'abandon'
  ];

  /** The card's elements, looked up once by the page. */
  function elementsOf(doc) {
    const out = {};
    Object.keys(IDS).forEach((name) => { out[name] = doc.getElementById(IDS[name]); });
    return out;
  }

  /** A blank card for `fileName`: no buttons, no message, no panel. */
  function reset(el, fileName) {
    el.card.hidden = false;
    el.fileName.textContent = fileName || '';
    el.statusText.textContent = '';
    el.error.hidden = true;
    el.error.textContent = '';
    el.error.classList.remove('is-note');
    el.progressTrack.hidden = true;
    el.confirmPanel.hidden = true;
    el.noFile.hidden = true;
    el.webLink.hidden = true;
    el.webLink.removeAttribute('href');
    BUTTONS.forEach((name) => { el[name].hidden = true; });
  }

  function setProgress(el, percent) {
    const clamped = Math.max(0, Math.min(100, Math.round(percent || 0)));
    el.progressTrack.hidden = false;
    el.progressBar.style.width = `${clamped}%`;
  }

  /**
   * A message under the status line. Red only when it is an error; a
   * cancellation is worded in the same place without being painted as one.
   */
  function showMessage(el, text, isError) {
    el.error.textContent = text;
    el.error.classList.toggle('is-note', !isError);
    el.error.hidden = !text;
  }

  /** Is this error the account asking to be signed in? */
  function wantsSignIn(error) {
    const e = error || {};
    return e.code === 'unauthorized' || e.loginRequired === true ||
      (e.details && e.details.loginRequired === true);
  }

  /** The bytes are on their way up; `percent` null before the PUT reports. */
  function renderUploading(el, { fileName, percent }, t) {
    reset(el, fileName);
    el.statusText.textContent = Number.isFinite(percent)
      ? t('docUploadProgress').split('{percent}').join(String(percent))
      : t('pdfStatusUploading');
    // Never an empty bar: the click has landed.
    setProgress(el, Math.max(2, percent || 0));
  }

  /** The credits question and the two buttons that answer it. */
  function renderCharge(el, { fileName, text }) {
    reset(el, fileName);
    el.statusText.textContent = text;
    el.confirmCharge.hidden = false;
    el.declineCharge.hidden = false;
  }

  /** Declining is a cancel, not a failure: no red line, and Retry asks again. */
  function renderDeclined(el, { fileName, hasFile }, t) {
    reset(el, fileName);
    el.statusText.textContent = t('pdfChargeDeclined');
    el.retry.hidden = !hasFile;
  }

  /**
   * A failure that is not a job's: a local refusal, a ticket, an upload or a
   * create that did not make it. "Try again" only when the page still holds
   * the file and trying again could come out differently.
   */
  function renderFailure(el, { fileName, error, hasFile }, t) {
    reset(el, fileName);
    el.statusText.textContent = t('pdfStatusFailed');
    showMessage(el, PDF_UI.pdfErrorMessage(error || {}, t), true);
    offerRecovery(el, error, hasFile);
  }

  function offerRecovery(el, error, hasFile) {
    if (wantsSignIn(error)) {
      el.signIn.hidden = false;
      return;
    }
    el.retry.hidden = !(hasFile && PDF_UI.isRetryablePdfFailure(error || {}));
  }

  /** `docConfirmBody` filled in, or the bare status when there is no block. */
  function confirmText(confirm, t, uiLang) {
    const c = confirm || {};
    const numbers = [c.measuredUnits, c.reservedUnits, c.extraUnits, c.expiresAt];
    if (!numbers.every(Number.isFinite)) return t('docStatusAwaitingConfirm');
    let expires;
    try {
      expires = new Intl.DateTimeFormat(uiLang || undefined, { dateStyle: 'medium', timeStyle: 'short' })
        .format(new Date(c.expiresAt));
    } catch {
      expires = new Date(c.expiresAt).toLocaleString();
    }
    return t('docConfirmBody')
      .split('{measured}').join(String(c.measuredUnits))
      .split('{reserved}').join(String(c.reservedUnits))
      .split('{extra}').join(String(c.extraUnits))
      .split('{expires}').join(expires);
  }

  /**
   * One job, as the server last described it.
   *
   * @param model {view, format, fileName, hasFile, webBase, uiLang}
   */
  function renderJob(el, model, t) {
    const { view, format, fileName, hasFile, webBase, uiLang } = model;
    reset(el, fileName);
    el.statusText.textContent = t(PDF_UI.pdfStatusKey(view));
    const status = view && view.status;

    if (DocJobs.isActiveStatus(status)) {
      // Never back to 0 while queued: the upload already happened.
      setProgress(el, Math.max(2, view.progress || 0));
      el.abandon.hidden = false;
      return;
    }

    if (DocJobs.isAwaitingStatus(status)) {
      el.confirmText.textContent = confirmText(view.confirm, t, uiLang);
      el.confirmPanel.hidden = false;
      el.confirmContinue.hidden = false;
      el.abandon.hidden = false;
      return;
    }

    if (status === 'succeeded') {
      setProgress(el, 100);
      renderResults(el, view, format);
      const href = PDF_UI.pdfLibraryUrl(webBase, view.jobId);
      if (href) {
        el.webLink.href = href;
        el.webLink.hidden = false;
      }
      return;
    }

    // failed / abandoned: the same line every surface draws.
    const line = PDF_UI.pdfStatusLine(view || {}, t);
    if (line.isError || line.text !== el.statusText.textContent) {
      showMessage(el, line.text, line.isError);
    }
    offerRecovery(el, view.error || { code: status }, hasFile);
  }

  /** PDF opens in Chrome; the other written-back formats save; MOBI has no file. */
  function renderResults(el, view, format) {
    const results = view.results || {};
    if (format === 'pdf') {
      el.openDual.hidden = !results.dualUrl;
      el.openMono.hidden = !results.monoUrl;
      return;
    }
    if (DocJobs.writesBackDocument(format)) {
      el.saveDual.hidden = !results.dualUrl;
      el.saveMono.hidden = !results.monoUrl;
      return;
    }
    el.noFile.hidden = false;
  }

  /**
   * Hand a blob to the browser as a download under `fileName`.
   *
   * An <a download> rather than the downloads API, which would need a
   * permission this extension does not ask for. The object URL outlives the
   * click by a minute, long enough for the browser to have read it.
   */
  function downloadBlob(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.hidden = true;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  globalThis.DocJobView = {
    elementsOf,
    showMessage,
    wantsSignIn,
    renderUploading,
    renderCharge,
    renderDeclined,
    renderFailure,
    renderJob,
    confirmText,
    downloadBlob
  };
})();
