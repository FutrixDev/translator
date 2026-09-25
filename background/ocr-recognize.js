// Blab Translation background — 图片 OCR 的第一步：认字。
//
// 第二步（把认出来的字译过去）不在这里，在内容脚本里，走的是普通翻译那条路。

import '../shared/ocr.js';
import '../shared/api-compat.js';
import '../i18n/messages.js';
import { defaultSettings, uiLanguageOf } from './settings.js';
import { callClaudeAPI, callOpenAIAPI, isClaudeAPI } from './api-client.js';
import { apiErrorMessage, missingApiKeyMessage } from './api-errors.js';

// ---------------------------------------------------------------------------
// Image OCR, step 1: recognition. Two engines — Tesseract in the offscreen
// document (free, offline, the default) and the user's own vision model — and
// this half owns the parts neither a content script nor an offscreen document
// can do: fetching the image and reaching a cross-origin API.
//
// Step 2, the optional translation, is not here. It runs in the content script
// on the recognised text through the ordinary translation path.
//
// The pure parts — the language catalog, the script heuristic, the prompt,
// response parsing, encoding limits — live in shared/ocr.js.
// ---------------------------------------------------------------------------

/** ArrayBuffer → base64, chunked so a multi-megabyte image cannot blow the
 *  argument-count limit of String.fromCharCode.apply. */
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Fetch the image and get it into a shape both engines accept.
 *
 * Fetched from the worker, not the page: host_permissions cover <all_urls>, the
 * request carries the user's cookies (hotlink-guarded CDNs), and a page CSP
 * cannot block it. Bytes already in an accepted format under the size cap pass
 * through untouched; anything else (SVG, BMP, oversized) is decoded and
 * re-encoded via OffscreenCanvas, downscaled to OCR_MAX_DIMENSION.
 *
 * The limits are the vision APIs', and the local engine inherits them rather
 * than getting its own pass: Tesseract has no size cap of its own, but it is
 * also slow enough on a 6000px scan that the downscale is a favour.
 */
async function fetchImageForOcr(srcUrl, uiLang, crop) {
  const { canSendImageDirectly, cropSourceRect, computeOcrCanvasSize, OCR_MAX_BYTES } = globalThis.OCRCore;

  let response;
  try {
    response = await fetch(srcUrl);
  } catch {
    throw new Error(getMessage('ocrImageLoadFailed', uiLang));
  }
  if (!response.ok) {
    throw new Error(getMessage('ocrImageLoadFailed', uiLang));
  }
  const blob = await response.blob();

  // The fast path is only fast because nothing is decoded, so it cannot apply
  // to a crop: cropping is a source rectangle on a decoded bitmap.
  if (!crop && canSendImageDirectly(blob.type, blob.size)) {
    return { base64: arrayBufferToBase64(await blob.arrayBuffer()), mediaType: blob.type };
  }

  let bitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    // SVG being the common case: workers cannot rasterize it.
    throw new Error(getMessage('ocrImageUnsupported', uiLang));
  }
  // The crop arrives as fractions of the image — the only thing the page and
  // the worker can agree on, since the two may not even be holding the same
  // resolution (srcset). A crop the page drew but this side cannot use comes
  // back null, and the whole image is recognised: a wrong crop would be worse.
  const source = cropSourceRect(crop, bitmap.width, bitmap.height)
    || { sx: 0, sy: 0, sw: bitmap.width, sh: bitmap.height };
  const { width, height } = computeOcrCanvasSize(source.sw, source.sh, { allowUpscale: !!crop });
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext('2d').drawImage(bitmap, source.sx, source.sy, source.sw, source.sh, 0, 0, width, height);
  bitmap.close();

  // PNG keeps text edges crisp; fall back to JPEG only when the PNG is still
  // over the cap (photographs, mostly — where JPEG is the right encoding).
  let out = await canvas.convertToBlob({ type: 'image/png' });
  if (out.size > OCR_MAX_BYTES) {
    out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
  }
  return { base64: arrayBufferToBase64(await out.arrayBuffer()), mediaType: out.type };
}

// --- The offscreen document ------------------------------------------------

// Tesseract spawns a Web Worker and instantiates WebAssembly; a service worker
// may do neither. The offscreen document is the only context in an extension
// that can, so the local engine lives there and this half just drives it.
const OFFSCREEN_PATH = 'offscreen/offscreen.html';
let offscreenCreating = null;

async function hasOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)]
  });
  return contexts.length > 0;
}

/**
 * There may be exactly one offscreen document per extension, and creating a
 * second throws. Two right-clicks in quick succession both land here before
 * either has finished creating, so the in-flight promise is shared.
 */
async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) return;
  if (offscreenCreating) {
    await offscreenCreating;
    return;
  }
  offscreenCreating = chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ['WORKERS'],
    justification: 'Run the local OCR engine, which needs a Web Worker and WebAssembly.'
  });
  try {
    await offscreenCreating;
  } catch (error) {
    // Lost the race against another caller that created it first — which is
    // the outcome we wanted anyway.
    if (!(await hasOffscreenDocument())) throw error;
  } finally {
    offscreenCreating = null;
  }
}

// Which tab asked for each in-flight recognition, so the offscreen document's
// progress can reach the popup that is waiting for it. The offscreen document
// has no idea a tab exists; it only knows the request id it was given.
const ocrProgressTabs = new Map();

function relayOcrProgress(message) {
  const tabId = ocrProgressTabs.get(message.requestId);
  if (tabId === undefined) return;
  chrome.tabs.sendMessage(tabId, {
    type: 'OCR_PROGRESS',
    requestId: message.requestId,
    stage: message.stage,
    progress: message.progress
  }).catch(() => {});
}

// --- Recognition -----------------------------------------------------------

/** Recognise with the local engine. Free, offline, no API key. */
async function recognizeLocally({ srcUrl, crop, requestId, tabId }, settings, uiLang) {
  await ensureOffscreenDocument();
  const { base64, mediaType } = await fetchImageForOcr(srcUrl, uiLang, crop);
  const plan = globalThis.OCRCore.resolveOcrLanguagePlan(uiLang);

  if (tabId !== undefined) ocrProgressTabs.set(requestId, tabId);
  let result;
  try {
    result = await chrome.runtime.sendMessage({
      target: 'ocr-offscreen',
      type: 'OCR_OFFSCREEN_RECOGNIZE',
      requestId,
      languages: plan.primary,
      fallbackLanguages: plan.fallback,
      dataUrl: `data:${mediaType};base64,${base64}`
    });
  } finally {
    ocrProgressTabs.delete(requestId);
  }

  if (!result || result.error) {
    console.error('OCR: local engine failed:', result && result.error);
    throw new Error(getMessage('ocrEngineFailed', uiLang));
  }
  // Tesseract cannot report a language — it was told which ones to look for.
  // The answer comes from the codepoints that came out, with the languages of
  // the winning pass (the offscreen document may have used the fallback) as
  // the only thing that can tell Simplified from Traditional Han.
  return {
    text: result.text,
    language: globalThis.OCRCore.detectScriptLanguage(result.text, result.languages || plan.primary)
  };
}

/** Recognise with the user's own vision model. */
async function recognizeWithVision({ srcUrl, crop }, settings, uiLang) {
  const missingKey = missingApiKeyMessage(settings);
  if (missingKey) {
    throw new Error(missingKey);
  }
  const { base64, mediaType } = await fetchImageForOcr(srcUrl, uiLang, crop);
  const systemPrompt = globalThis.OCRCore.OCR_SYSTEM_PROMPT;
  const instruction = globalThis.OCRCore.OCR_USER_INSTRUCTION;

  let content;
  if (isClaudeAPI(settings.apiEndpoint)) {
    content = await callClaudeAPI(
      settings.apiEndpoint,
      settings.apiKey,
      settings.modelName,
      systemPrompt,
      globalThis.APICompat.buildClaudeVisionUserContent(instruction, mediaType, base64),
      4000
    );
  } else {
    content = await callOpenAIAPI(
      settings.apiEndpoint,
      settings.apiKey,
      settings.modelName,
      systemPrompt,
      globalThis.APICompat.buildOpenAIVisionUserContent(instruction, mediaType, base64),
      4000,
      globalThis.APICompat.DEFAULT_TEMPERATURE
    );
  }

  const parsed = globalThis.OCRCore.parseOcrResponse(content);
  // null means the reply was JSON that broke (token cap, mangled quoting);
  // an error beats presenting the raw blob as recognised text.
  if (!parsed) throw new Error(getMessage('translationFailed', uiLang));
  return {
    text: globalThis.OCRCore.normalizeRecognizedText(parsed.text),
    // The model's own answer when it gave one — it read the image, which beats
    // counting codepoints. Falling back keeps a model that skipped the key from
    // costing the popup its language line.
    language: parsed.language || globalThis.OCRCore.detectScriptLanguage(parsed.text, '')
  };
}

/**
 * Step 1 only: get the text out of the image. Returns {text, language} or
 * {error} — the same envelope shape the TRANSLATE handlers use.
 *
 * Translation is step 2 and does not happen here. The content script runs it
 * on the returned text through ctx.requestTranslation(), which already picks
 * between Chrome's built-in Translator and the user's API and already knows
 * how to explain itself when neither can serve the pair.
 */
async function handleOcrImage(message, sender) {
  const settings = await chrome.storage.sync.get(defaultSettings);
  const uiLang = uiLanguageOf(settings);
  const request = {
    srcUrl: message.srcUrl,
    // Fractions of the image, or absent for the whole of it. Both engines take
    // the same crop because it is applied once, on the way in.
    crop: message.crop,
    requestId: message.requestId || `ocr-${Date.now()}`,
    tabId: sender && sender.tab ? sender.tab.id : undefined
  };

  try {
    return settings.ocrEngine === 'vision'
      ? await recognizeWithVision(request, settings, uiLang)
      : await recognizeLocally(request, settings, uiLang);
  } catch (error) {
    console.error('OCR error:', error);
    return { error: apiErrorMessage(error, settings) };
  }
}

export { handleOcrImage, relayOcrProgress };
