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
  // language) and cheap to keep, so workers are cached and reused across
  // requests. Two slots, not one, because a request with a fallback language
  // (see recognize below) alternates between two single-language workers — a
  // one-slot cache would tear each down just before it was needed again. Idle
  // teardown below stops the cache from becoming a permanent memory cost.
  const MAX_CACHED_WORKERS = 2;
  const IDLE_TEARDOWN_MS = 2 * 60 * 1000;
  const workerCache = new Map(); // languages -> Promise<{ worker }>
  let idleTimer = null;

  // Rebound to the live request's reporter for the duration of its passes:
  // the logger closure is fixed at createWorker time, so a cached worker would
  // otherwise keep reporting to the request that created it.
  let reportProgress = null;

  // The split loader + .wasm pair rather than the single `.wasm.js` file that
  // inlines the module as base64: 1MB smaller in the package, and the loader
  // resolves its sibling .wasm against the vendored worker's own URL, which is
  // this same directory.
  const CORE_PATH = chrome.runtime.getURL('vendor/tesseract/tesseract-core-simd-lstm.js');
  const WORKER_PATH = chrome.runtime.getURL('vendor/tesseract/worker.min.js');
  const LANG_PATH = chrome.runtime.getURL('vendor/tesseract/lang');

  function terminateQuietly(entryPromise) {
    entryPromise
      .then(({ worker }) => worker.terminate())
      // A worker that failed to start, or already died, has nothing to stop.
      .catch(() => {});
  }

  function scheduleIdleTeardown() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      for (const entry of workerCache.values()) terminateQuietly(entry);
      workerCache.clear();
      // Nothing left to keep this document open for, and an open offscreen
      // document keeps the service worker alive with it. The worker recreates
      // us on the next request; a ~2s cold start is the cheaper side of that
      // trade.
      chrome.runtime.sendMessage({ type: 'OCR_OFFSCREEN_IDLE' }).catch(() => {});
    }, IDLE_TEARDOWN_MS);
  }

  /** A Tesseract worker loaded with exactly `languages` ('eng', 'chi_sim', …). */
  async function getTesseractWorker(languages) {
    let entry = workerCache.get(languages);
    if (entry) {
      // Re-insert so eviction order tracks use, not creation.
      workerCache.delete(languages);
      workerCache.set(languages, entry);
      return (await entry).worker;
    }

    entry = (async () => {
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
          if (reportProgress && typeof m.progress === 'number') {
            reportProgress(m.status === 'recognizing text' ? 'recognizing' : 'loading', m.progress);
          }
        }
      });
      return { worker };
    })();

    workerCache.set(languages, entry);
    while (workerCache.size > MAX_CACHED_WORKERS) {
      const [oldest] = workerCache.keys();
      terminateQuietly(workerCache.get(oldest));
      workerCache.delete(oldest);
    }
    // A failed start must not poison the slot — the next request recreates it.
    entry.catch(() => {
      if (workerCache.get(languages) === entry) workerCache.delete(languages);
    });
    return (await entry).worker;
  }

  // The structured `blocks` output as paragraphs of {text, confidence, height}
  // lines — the shape OCRCore.filterRecognizedLines judges and
  // OCRCore.assessRecognition measures. Line granularity on purpose:
  // Tesseract's hallucinations (stylised art read as Latin garbage) arrive as
  // whole low-scoring lines, whereas dropping individual words would silently
  // rewrite sentences. `height` is the line box from layout analysis, which is
  // right even when the text inside it came out wrong — it is what the rescale
  // retry measures glyph size with.
  function flattenBlocks(blocks) {
    const paragraphs = [];
    for (const block of blocks || []) {
      for (const paragraph of (block && block.paragraphs) || []) {
        const lines = [];
        for (const line of (paragraph && paragraph.lines) || []) {
          if (!line) continue;
          const box = line.bbox;
          const height = box && isFinite(box.y1 - box.y0) && box.y1 - box.y0 > 0 ? box.y1 - box.y0 : null;
          lines.push({
            text: String(line.text || '').replace(/\n+$/, ''),
            confidence: typeof line.confidence === 'number' ? line.confidence : null,
            height
          });
        }
        if (lines.length) paragraphs.push(lines);
      }
    }
    return paragraphs;
  }

  /** One recognition pass: {languages, text, assessment}. */
  async function runPass(languages, dataUrl) {
    const worker = await getTesseractWorker(languages);
    // `blocks` carries the per-line confidences the filter below needs; `text`
    // is kept as the fallback when a build answers without them — an
    // unfiltered result still beats an empty one.
    const { data } = await worker.recognize(dataUrl, {}, { text: true, blocks: true });

    let raw = data && typeof data.text === 'string' ? data.text : '';
    const paragraphs = data && Array.isArray(data.blocks) ? flattenBlocks(data.blocks) : [];
    let kept = paragraphs.flat();
    if (paragraphs.length) {
      // The filter works on the flat list (its all-dropped fallback has to see
      // the whole result); membership rebuilds the paragraph gaps, which the
      // popup renders and the reader needs.
      const keptSet = new Set(globalThis.OCRCore.filterRecognizedLines(kept, languages));
      kept = kept.filter((line) => keptSet.has(line));
      raw = paragraphs
        .map((lines) => lines.filter((line) => keptSet.has(line)).map((line) => line.text).join('\n'))
        .filter((text) => text.trim())
        .join('\n\n');
    }

    return {
      languages,
      text: globalThis.OCRCore.normalizeRecognizedText(raw),
      // Judged on the kept lines — the result the user would actually see.
      assessment: globalThis.OCRCore.assessRecognition(kept)
    };
  }

  /** The image redrawn at `factor` of its size, as a data URL, or null. */
  async function rescaleDataUrl(dataUrl, factor) {
    try {
      const blob = await (await fetch(dataUrl)).blob();
      const bitmap = await createImageBitmap(blob);
      const canvas = new OffscreenCanvas(
        Math.max(1, Math.round(bitmap.width * factor)),
        Math.max(1, Math.round(bitmap.height * factor))
      );
      const g = canvas.getContext('2d');
      g.imageSmoothingEnabled = true;
      g.imageSmoothingQuality = 'high';
      g.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();
      const out = await canvas.convertToBlob({ type: 'image/png' });
      return await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(out);
      });
    } catch {
      // A rescale that failed just means no retry pass — the first pass still
      // stands as a result.
      return null;
    }
  }

  /**
   * Recognition as a short ladder of single-language passes, climbed only
   * while the result is below the acceptance bar (most images stop after one):
   *
   *   1. `languages` at the size the service worker sent;
   *   2. the same language again at each retry rung — the image scaled toward
   *      a size the LSTM reads well, when pass 1's own line boxes say the
   *      glyphs were oversized (poem cards, memes, headline screenshots).
   *      There are up to two rungs because no single scale wins on every
   *      rendering, and every rung runs: a pass can clear the acceptance bar
   *      by silently losing a line, so no rung's score may cut the next one;
   *   3. `fallbackLanguages` — 'auto' sends eng — for images that were not in
   *      the primary language at all.
   *
   * Whole passes compete on mean confidence and the best one answers. The
   * languages that produced the winning text go back too: they are the hint
   * that lets the service worker tell Simplified from Traditional Han.
   */
  async function recognize({ dataUrl, languages, fallbackLanguages }, onProgress) {
    reportProgress = onProgress;
    try {
      const { isAcceptableRecognition, rescaleFactorsForRetry, pickBetterRecognition } = globalThis.OCRCore;

      let best = await runPass(languages, dataUrl);
      // Rung factors come from the first pass's assessment: the native-size
      // line boxes are the only measurement of the actual glyphs.
      let bestUrl = dataUrl;
      for (const factor of rescaleFactorsForRetry(best.assessment)) {
        const scaledUrl = await rescaleDataUrl(dataUrl, factor);
        if (!scaledUrl) continue;
        const pass = await runPass(languages, scaledUrl);
        const winner = pickBetterRecognition(best, pass);
        if (winner === pass) bestUrl = scaledUrl;
        best = winner;
      }
      if (!isAcceptableRecognition(best.assessment) && fallbackLanguages) {
        // At the size that read best so far — oversized glyphs are oversized
        // in every language.
        best = pickBetterRecognition(best, await runPass(fallbackLanguages, bestUrl));
      }

      // The same {text, language} contract the vision engine answers with,
      // minus the language itself, which the service worker derives.
      return { text: best.text, languages: best.languages };
    } finally {
      reportProgress = null;
    }
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
