// The OCR worker room's script. It answers exactly one question for the service
// worker — "what text is in this image?" — and owns the lifetime of the
// expensive engine behind it.
//
// It does NOT translate. Translation is a separate, optional step that runs in
// the content script through ctx.requestTranslation(), which already picks
// between Chrome's built-in Translator and the user's own API, already handles
// language-pack downloads, and already knows how to say why it could not. A
// second copy of that here would be a second thing to keep correct.
//
// Everything else is deliberately thin: which languages to recognise and how to
// clean up the result are decisions in shared/ocr.js. This file only knows how
// to drive Tesseract.
(function () {
  'use strict';

  // Only messages addressed here are ours. The same runtime message bus carries
  // traffic for the popup and every content script.
  const TARGET = 'ocr-offscreen';

  // Tesseract is expensive to start (a ~2.9MB core plus a traineddata file per
  // language) and cheap to keep, so one worker is cached and reused across
  // requests for the same language set. Idle teardown below stops that from
  // becoming a permanent memory cost.
  const IDLE_TEARDOWN_MS = 2 * 60 * 1000;
  let tesseract = null;          // { languages, worker }
  let tesseractStarting = null;  // in-flight createWorker, so two requests share one
  let idleTimer = null;

  // The split loader + .wasm pair rather than the single `.wasm.js` file that
  // inlines the module as base64: 1MB smaller in the package, and the loader
  // resolves its sibling .wasm against the vendored worker's own URL, which is
  // this same directory.
  const CORE_PATH = chrome.runtime.getURL('vendor/tesseract/tesseract-core-simd-lstm.js');
  const WORKER_PATH = chrome.runtime.getURL('vendor/tesseract/worker.min.js');
  const LANG_PATH = chrome.runtime.getURL('vendor/tesseract/lang');

  function scheduleIdleTeardown() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(async () => {
      const current = tesseract;
      tesseract = null;
      if (current) {
        try {
          await current.worker.terminate();
        } catch {
          // Terminating an already-dead worker is not a failure worth reporting.
        }
      }
      // Nothing left to keep this document open for, and an open offscreen
      // document keeps the service worker alive with it. The worker recreates
      // us on the next request; a ~2s cold start is the cheaper side of that
      // trade.
      chrome.runtime.sendMessage({ type: 'OCR_OFFSCREEN_IDLE' }).catch(() => {});
    }, IDLE_TEARDOWN_MS);
  }

  /** A Tesseract worker loaded with exactly `languages` ('eng', 'chi_sim+eng', …). */
  async function getTesseractWorker(languages, onProgress) {
    if (tesseract && tesseract.languages === languages) return tesseract.worker;
    if (tesseractStarting) {
      const pending = await tesseractStarting;
      if (pending.languages === languages) return pending.worker;
    }

    // A different language set than the cached one: the old worker is useless.
    if (tesseract) {
      const stale = tesseract;
      tesseract = null;
      stale.worker.terminate().catch(() => {});
    }

    tesseractStarting = (async () => {
      // OEM 1 is LSTM_ONLY, which is all the bundled `-lstm` core supports.
      const worker = await Tesseract.createWorker(languages, 1, {
        corePath: CORE_PATH,
        workerPath: WORKER_PATH,
        langPath: LANG_PATH,
        // Both default to fetching from a CDN, which MV3 forbids outright and
        // which would break the feature offline. Everything is vendored.
        workerBlobURL: false,
        gzip: false,
        logger: (m) => {
          if (onProgress && typeof m.progress === 'number') {
            onProgress(m.status === 'recognizing text' ? 'recognizing' : 'loading', m.progress);
          }
        }
      });
      return { languages, worker };
    })();

    try {
      tesseract = await tesseractStarting;
      return tesseract.worker;
    } finally {
      tesseractStarting = null;
    }
  }

  async function recognize({ dataUrl, languages }, onProgress) {
    const worker = await getTesseractWorker(languages, onProgress);
    const { data } = await worker.recognize(dataUrl);
    // Just the text: the same {text, language} contract the vision engine
    // answers with, minus the language, which the service worker derives.
    return { text: globalThis.OCRCore.normalizeRecognizedText(data.text) };
  }

  const HANDLERS = {
    OCR_OFFSCREEN_RECOGNIZE: recognize
  };

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.target !== TARGET) return undefined;
    const handler = HANDLERS[message.type];
    if (!handler) return undefined;

    // Held off for as long as this request runs; rearmed when it settles.
    clearTimeout(idleTimer);
    const onProgress = (stage, progress) => {
      chrome.runtime
        .sendMessage({ type: 'OCR_PROGRESS', requestId: message.requestId, stage, progress })
        .catch(() => {});
    };

    handler(message, onProgress)
      .then(sendResponse)
      .catch((error) => sendResponse({ error: String((error && error.message) || error) }))
      .finally(scheduleIdleTeardown);

    // Keeps the message channel open for the async reply above.
    return true;
  });
})();
