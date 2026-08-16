// Image OCR: the pure half of the feature — the language catalog, the script
// heuristics, the vision prompt and its tolerant parser, and the encoding
// limits the service worker enforces before shipping an image anywhere.
//
// Kept out of background/background.js for the same reason caption-core.js
// exists: `npm run test:unit` exercises this with no browser, and the DOM-full
// half (fetching the image, the Tesseract worker, the popup) stays thin.
//
// The feature is two separable steps, and this module keeps them separable:
//
//   1. RECOGNISE — get the text out of the image. Local (Tesseract in the
//      offscreen document) or remote (a vision model). Always happens, and it
//      is all this module and the service worker do.
//   2. TRANSLATE — optional, and not here. The content script runs it through
//      ctx.requestTranslation() on the recognised text like any other string:
//      Chrome's built-in Translator first, the user's own API as fallback.
//      Recognise-only is a complete, valid result.
//
// Both engines stop at step 1, including `vision` — a vision model *could*
// translate in the same call, but then the two steps would be one shape for one
// engine and two for the other, and the free built-in translator could never
// serve the vision path. One contract, and the cheaper translator wins either
// way.
//
// Loaded as a side-effect import by the module service worker, so it publishes
// onto the global object rather than using `export`.
(function (root) {
  'use strict';

  // --- Engines ---------------------------------------------------------------

  // 'local'  — Tesseract WASM in the offscreen document. Free, offline, fast
  //            (sub-second on clean images), weaker on photos and stylised type.
  // 'vision' — the user's own vision model. Costs money and takes seconds, but
  //            reads images the local engine cannot.
  //
  // The default is the free one, for the same reason translationEngine defaults
  // to 'builtin'. Both the service worker and the options page read it from
  // here rather than each writing 'local' into their own defaults.
  const DEFAULT_OCR_ENGINE = 'local';

  // --- Image encoding limits -------------------------------------------------

  // Media types every supported vision API accepts as-is (Anthropic's list is
  // the narrowest: jpeg/png/webp/gif). Anything else — SVG, BMP, AVIF — has to
  // be re-encoded before upload.
  const OCR_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

  // Anthropic caps a single image at 5MB of decoded base64; staying under 4MB
  // of raw bytes keeps the ~4/3 base64 inflation inside that. OpenAI's cap is
  // higher, so the narrowest bound is the shared one.
  const OCR_MAX_BYTES = 4 * 1024 * 1024;

  // Vision models tile large images and read small text worse past ~2k pixels
  // on the long edge, so a bigger upload costs more and reads no better.
  const OCR_MAX_DIMENSION = 2048;

  /** Can these bytes be sent to the API untouched, or must they be re-encoded? */
  function canSendImageDirectly(mediaType, byteLength) {
    return OCR_MEDIA_TYPES.includes(mediaType) && byteLength <= OCR_MAX_BYTES;
  }

  // --- Region crop -----------------------------------------------------------
  //
  // The user can point at part of an image instead of the whole of it, and the
  // two sides of that describe the same rectangle with different numbers: the
  // content script knows where the drag landed on the rendered <img>, and only
  // the worker knows how many pixels the decoded image really has. Fractions of
  // the image are the one description both can agree on — they survive a srcset
  // handing the worker a different resolution than the page displayed, and they
  // survive the downscale below.

  // A drag under this on either edge is a stray click, not a selection.
  const MIN_CROP_FRACTION = 0.005;

  // A crop is by definition a small piece of an image, and both engines read
  // small type badly — Tesseract wants glyphs around 30px tall, and a vision
  // model tiles what it is given. A crop whose long edge lands under this is
  // scaled up on the way out rather than handed over as a postage stamp; a
  // bicubic canvas draw is better than what either engine does internally.
  const OCR_MIN_DIMENSION = 1000;

  // Past 3× there are no more edges to recover, only invented ones.
  const OCR_MAX_UPSCALE = 3;

  /**
   * A crop as sent over the wire → a crop that can be trusted, or null when
   * there is nothing worth cropping to.
   *
   * Null is not an error: it means "recognise the whole image", which is what
   * both a missing crop and a full-image selection mean.
   */
  function normalizeCropRect(crop) {
    if (!crop) return null;
    let { x, y, width, height } = crop;
    if (![x, y, width, height].every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
    // A drag that ran right-to-left or bottom-to-top arrives negative.
    if (width < 0) { x += width; width = -width; }
    if (height < 0) { y += height; height = -height; }
    // Clamp to the image by its edges, not by its size: a selection that ran
    // off the top keeps the part that was over the image.
    const left = Math.min(Math.max(x, 0), 1);
    const top = Math.min(Math.max(y, 0), 1);
    const right = Math.min(Math.max(x + width, 0), 1);
    const bottom = Math.min(Math.max(y + height, 0), 1);
    width = right - left;
    height = bottom - top;
    if (width < MIN_CROP_FRACTION || height < MIN_CROP_FRACTION) return null;
    // The whole image, asked for the long way. Cropping it would cost a decode
    // and a re-encode to arrive back where it started.
    if (width > 0.999 && height > 0.999) return null;
    return { x: left, y: top, width, height };
  }

  /**
   * The crop in source pixels, for drawImage. Null when there is no crop, or
   * when the image has no dimensions to crop against.
   */
  function cropSourceRect(crop, imageWidth, imageHeight) {
    const rect = normalizeCropRect(crop);
    if (!rect || !(imageWidth > 0) || !(imageHeight > 0)) return null;
    const sx = Math.min(Math.round(rect.x * imageWidth), imageWidth - 1);
    const sy = Math.min(Math.round(rect.y * imageHeight), imageHeight - 1);
    return {
      sx,
      sy,
      sw: Math.max(1, Math.min(Math.round(rect.width * imageWidth), imageWidth - sx)),
      sh: Math.max(1, Math.min(Math.round(rect.height * imageHeight), imageHeight - sy))
    };
  }

  /**
   * How big the canvas handed to an engine should be: never wider than
   * OCR_MAX_DIMENSION, and — when the caller asks for it — never smaller than
   * OCR_MIN_DIMENSION on the long edge.
   *
   * `allowUpscale` is the crop path. A full image is what the page chose to
   * publish and is left at its own size; a crop is the user pointing at a
   * detail, and is worth the pixels.
   */
  function computeOcrCanvasSize(width, height, { allowUpscale = false } = {}) {
    const longest = Math.max(width, height);
    let scale = 1;
    if (longest > OCR_MAX_DIMENSION) {
      scale = OCR_MAX_DIMENSION / longest;
    } else if (allowUpscale && longest > 0 && longest < OCR_MIN_DIMENSION) {
      // Capped both ways, so the result lands in [longest, OCR_MIN_DIMENSION]
      // and can never overshoot OCR_MAX_DIMENSION.
      scale = Math.min(OCR_MAX_UPSCALE, OCR_MIN_DIMENSION / longest);
    }
    return {
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale))
    };
  }

  /**
   * Where the image is actually painted inside the box the page gave it, in
   * that box's own coordinates. `object-fit` decides, and its values disagree
   * about everything: `contain` letterboxes (the painted box is smaller than
   * the element), `cover` and `none` overflow it (the painted box is bigger,
   * and the element shows a window onto it).
   *
   * This is what turns a point on screen into a point in the image: the crop
   * the user drew over a `cover` thumbnail is a much smaller part of the source
   * than the same rectangle over a plain one, and getting it wrong crops
   * somewhere else entirely.
   *
   * Only the centred case, because `object-position` defaults to `50% 50%` and
   * is vanishingly rare on content images. A page that moves the paint off
   * centre shifts the crop by that much.
   */
  function paintedImageBox({ boxWidth, boxHeight, naturalWidth, naturalHeight, objectFit }) {
    const whole = { left: 0, top: 0, width: boxWidth, height: boxHeight };
    // No intrinsic size (an SVG without one, an image still loading) means
    // there is nothing to fit and the box is all we know.
    if (!(naturalWidth > 0) || !(naturalHeight > 0) || !(boxWidth > 0) || !(boxHeight > 0)) return whole;

    const fit = String(objectFit || 'fill').trim();
    const contain = Math.min(boxWidth / naturalWidth, boxHeight / naturalHeight);
    let scale;
    if (fit === 'contain') scale = contain;
    else if (fit === 'cover') scale = Math.max(boxWidth / naturalWidth, boxHeight / naturalHeight);
    else if (fit === 'none') scale = 1;
    else if (fit === 'scale-down') scale = Math.min(contain, 1);
    // 'fill' (the initial value) stretches to the box, and so does anything we
    // do not recognise — the box is the safe reading.
    else return whole;

    const width = naturalWidth * scale;
    const height = naturalHeight * scale;
    return { left: (boxWidth - width) / 2, top: (boxHeight - height) / 2, width, height };
  }

  // --- Recognition languages -------------------------------------------------

  // Tesseract is not language-agnostic: it needs the language list up front,
  // and every extra language costs recognition time and a little accuracy. So
  // "detect the language in the image" is not something the OCR step can do —
  // it is answered afterwards, from the text that came out (see
  // detectScriptLanguage).
  //
  // Bundled from tessdata_fast, which is what `vendor/tesseract/lang` holds.
  // Adding a language here means adding its .traineddata to that directory.
  const OCR_LANGUAGES = [
    { code: 'eng', bcp47: 'en', labelKey: 'langEn' },
    { code: 'chi_sim', bcp47: 'zh-Hans', labelKey: 'langZhCN' },
    { code: 'chi_tra', bcp47: 'zh-Hant', labelKey: 'langZhTW' },
    { code: 'jpn', bcp47: 'ja', labelKey: 'langJa' },
    { code: 'kor', bcp47: 'ko', labelKey: 'langKo' }
  ];

  // Which language 'auto' recognises WITH, keyed by the UI/target language:
  // the user's own script is what they are realistically pointing the tool at.
  //
  // Deliberately NOT combined with English into one 'chi_sim+eng' pass. In a
  // combined pass Tesseract picks the higher-scoring hypothesis per line, and
  // whenever the CJK model is unsure of a line the eng model's reading wins —
  // which turns "wrong but at least Chinese" into confident Latin garbage
  // ("FUSS 6," for 千山鸟飞绝，— reproduced against the vendored engine). The
  // CJK traineddata already reads embedded ASCII/Latin on its own, so English
  // inside a CJK image costs nothing; a *purely* English image is instead
  // caught by the fallback pass below.
  const AUTO_PRIMARY_LANGUAGE = {
    'zh-CN': 'chi_sim',
    'zh-TW': 'chi_tra',
    ja: 'jpn',
    ko: 'kor'
  };

  /**
   * Resolve the stored `ocrSourceLanguage` setting into a recognition plan:
   * `primary` is the language the engine tries first, `fallback` (or null) is
   * tried only when the primary pass comes back below the acceptance bar (see
   * isAcceptableRecognition) — each as its own single-language pass, never
   * '+'-combined (see AUTO_PRIMARY_LANGUAGE for why).
   *
   * 'auto' means the user's own script with English as the fallback; an
   * explicit choice means exactly that language and nothing else, because a
   * user who picked one knows better than the heuristic.
   */
  function resolveOcrLanguagePlan(setting, uiLang) {
    const known = OCR_LANGUAGES.some((l) => l.code === setting);
    if (known) return { primary: setting, fallback: null };
    const primary = AUTO_PRIMARY_LANGUAGE[uiLang];
    return primary ? { primary, fallback: 'eng' } : { primary: 'eng', fallback: null };
  }

  // --- Adaptive retry ---------------------------------------------------------

  // Tesseract's LSTM reads glyphs best around 30–40px tall. Poem cards, memes
  // and headline screenshots ship glyphs of 100px and more, and at that size
  // recognition falls apart line by line (reproduced: the same poem image goes
  // from two-of-four lines destroyed at native size to near-perfect at a third
  // of it). The pipeline only caps images *above* OCR_MAX_DIMENSION, so the
  // fix is a second pass: measure how tall the lines actually were — layout
  // analysis gets the line boxes right even when the text inside them came out
  // as garbage — and re-recognise at a scale that lands them near the sweet
  // spot. The same mechanism walks back the crop path's upscale-to-1000px when
  // that overshoots a few large glyphs.

  // Clean print scores 80–95 and genuinely readable text lands in the 60s–70s
  // (the same bands OCR_LINE_CONFIDENCE_THRESHOLD is built on), so a pass
  // averaging 70+ is already a good read — retrying it would spend time to
  // reshuffle noise. Below that, a retry has something real to win.
  const OCR_ACCEPT_MEAN_CONFIDENCE = 70;

  // Where the retry aims the median line: the middle of the LSTM's comfort
  // band, with room on either side for the spread around the median.
  const OCR_TARGET_LINE_HEIGHT = 36;

  // Only lines clearly above the comfort band are worth a rescale pass; at or
  // under this, size was not the problem and a retry would just repeat it.
  const OCR_RETRY_MIN_LINE_HEIGHT = 60;

  // A factor below this means the measurement was nonsense (one merged box
  // spanning the image), not a real 180px-glyph banner.
  const OCR_MIN_RETRY_SCALE = 0.2;

  /**
   * How good was a recognition pass, and how tall was its text? `lines` is the
   * flat [{text, confidence, height}] the engine produced — confidence 0–100
   * or null, height in px of the line's bounding box or null.
   *
   * The mean is weighted by text length so a one-glyph stray cannot outvote a
   * full line, and it is computed over the lines the user would actually see
   * (the caller passes post-filter lines). Null means "no evidence", which
   * callers must treat as unacceptable rather than fine.
   */
  function assessRecognition(lines) {
    const all = Array.isArray(lines) ? lines : [];
    let weight = 0;
    let sum = 0;
    const heights = [];
    for (const line of all) {
      if (!line) continue;
      const textLength = String(line.text || '').trim().length;
      if (textLength && typeof line.confidence === 'number' && isFinite(line.confidence)) {
        weight += textLength;
        sum += line.confidence * textLength;
      }
      if (typeof line.height === 'number' && isFinite(line.height) && line.height > 0) {
        heights.push(line.height);
      }
    }
    heights.sort((a, b) => a - b);
    return {
      meanConfidence: weight ? sum / weight : null,
      medianLineHeight: heights.length ? heights[Math.floor((heights.length - 1) / 2)] : null
    };
  }

  /** Is this pass good enough to stop retrying? No evidence is not good enough. */
  function isAcceptableRecognition(assessment) {
    return !!assessment &&
      typeof assessment.meanConfidence === 'number' &&
      assessment.meanConfidence >= OCR_ACCEPT_MEAN_CONFIDENCE;
  }

  /**
   * The scale a retry pass should run at, or null when rescaling has nothing
   * to offer: the pass was already acceptable, the lines were not oversized,
   * or there were no line boxes to measure.
   */
  function rescaleFactorForRetry(assessment) {
    if (!assessment || isAcceptableRecognition(assessment)) return null;
    const height = assessment.medianLineHeight;
    if (!(typeof height === 'number' && height > OCR_RETRY_MIN_LINE_HEIGHT)) return null;
    return Math.max(OCR_MIN_RETRY_SCALE, OCR_TARGET_LINE_HEIGHT / height);
  }

  /**
   * The better of two passes, judged by mean confidence — whole passes, never
   * a line-by-line merge: two passes segment the page differently, and
   * stitching them would invent orderings no engine produced. Either side may
   * be null/absent; a pass with no evidence loses to any scored one.
   */
  function pickBetterRecognition(a, b) {
    if (!b) return a || null;
    if (!a) return b;
    const score = (pass) =>
      pass.assessment && typeof pass.assessment.meanConfidence === 'number'
        ? pass.assessment.meanConfidence
        : -1;
    return score(b) > score(a) ? b : a;
  }

  // --- Script detection ------------------------------------------------------

  // Codepoint ranges that settle which language the recognised text is in.
  // Kana and Hangul are decisive on sight; Han is not, because Japanese uses it
  // too — so kana is tested first and Han is only reached when no kana appeared.
  //
  // The scripts that go to a vote carry a per-codepoint weight, because raw
  // counts are the wrong yardstick across scripts: one Han character carries
  // about a word's worth of text while a Latin letter carries about a fifth of
  // one — and the noise OCR produces (misread strokes, watermarks, UI chrome)
  // is overwhelmingly Latin. Unweighted, twenty letters of Tesseract garbage
  // outvote a dozen real Han characters and a Chinese photo is labelled
  // English. Kana and Hangul never reach the vote (see the early return), so
  // their weights are moot.
  const SCRIPT_RANGES = [
    { lang: 'ja', re: /[぀-ゟ゠-ヿ]/g, weight: 1 },
    { lang: 'ko', re: /[가-힯ᄀ-ᇿ㄰-㆏]/g, weight: 1 },
    { lang: 'ru', re: /[Ѐ-ӿ]/g, weight: 1 },
    { lang: 'han', re: /[㐀-䶿一-鿿豈-﫿]/g, weight: 3 },
    { lang: 'en', re: /[A-Za-zÀ-ɏ]/g, weight: 1 }
  ];

  /**
   * Which language is this recognised text written in? A BCP 47 code, or ''
   * when there is nothing to go on.
   *
   * Deliberately a codepoint count rather than a model: Chrome's
   * LanguageDetector reports "unavailable" on plenty of profiles, so this has
   * to stand on its own. `hintLanguages` is the Tesseract language string the
   * text came out of — the only thing that can tell Simplified from
   * Traditional Han, which counting codepoints cannot.
   */
  function detectScriptLanguage(text, hintLanguages) {
    const source = String(text || '');
    if (!source.trim()) return '';

    let best = null;
    for (const { lang, re, weight } of SCRIPT_RANGES) {
      const count = (source.match(re) || []).length;
      // Kana and Hangul settle it outright: a single one of either cannot show
      // up in Chinese or Latin text, whereas Han is common to Chinese *and*
      // Japanese and Latin letters litter otherwise-CJK strings.
      if (count > 0 && (lang === 'ja' || lang === 'ko')) return lang;
      const score = count * weight;
      if (score > 0 && (!best || score > best.score)) best = { lang, score };
    }
    if (!best) return '';
    if (best.lang !== 'han') return best.lang;

    const hint = String(hintLanguages || '');
    // chi_tra alone means Traditional; anything else (including the chi_sim+eng
    // default) means Simplified.
    return hint.includes('chi_tra') && !hint.includes('chi_sim') ? 'zh-Hant' : 'zh-Hans';
  }

  // --- Recognised-text cleanup -----------------------------------------------

  // Characters that are never separated by a space in running CJK text.
  // Tesseract emits one between almost every glyph ("紧急 出 口"), because its
  // layout analysis measures the gaps a proportional CJK font leaves and reads
  // them as word breaks.
  const CJK_GLYPH = '\\u3000-\\u303F\\u3040-\\u30FF\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uAC00-\\uD7AF\\uF900-\\uFAFF\\uFF00-\\uFF65';
  const CJK_SPACE = new RegExp(`([${CJK_GLYPH}])[ \\t]+(?=[${CJK_GLYPH}])`, 'g');

  /**
   * Tidy what the OCR engine produced without changing what it said.
   *
   * Only spaces *between two CJK glyphs* are dropped — a space between Latin
   * words is a real word break, and so is the one in "第1 章" where the digit
   * is not a CJK glyph. Trailing whitespace and the blank lines Tesseract likes
   * to leave between blocks are collapsed.
   */
  function normalizeRecognizedText(text) {
    let out = String(text || '').replace(/\r\n?/g, '\n');
    // Twice: a run like "出 口 处" only loses its second space once the first
    // is gone and the lookahead can see the pair again.
    out = out.replace(CJK_SPACE, '$1').replace(CJK_SPACE, '$1');
    return out
      .split('\n')
      .map((line) => line.replace(/[ \t]+/g, ' ').trim())
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  // --- Low-confidence line filtering -----------------------------------------

  // Tesseract reads everything shaped like glyphs, including stylised display
  // type and decorative art it has no model for — and those come out as Latin
  // garbage lines ("SEE Fis 64, BEAR K. MASS 7 Ol eR") sitting next to
  // perfectly good small text. It does, however, know when it was guessing:
  // the hallucinated lines score far below the real ones, so its own
  // confidence is the signal that separates them.
  //
  // 55 rather than higher because the two failure modes are not symmetric: a
  // dropped real line is text the user can see in the image and we silently
  // withheld, while a kept garbage line is only noise around a correct result.
  // Clean print scores in the 80–95 band, small or slightly blurry but
  // genuinely readable text falls into the 60s–70s, and the hallucinations
  // from stylised glyphs sit in the 10s–40s — 55 lands in that gap, on the
  // keep-more side of it.
  const OCR_LINE_CONFIDENCE_THRESHOLD = 55;

  /**
   * Drop the lines Tesseract itself did not believe. `lines` is
   * [{text, confidence}] in reading order, confidence 0–100 straight from the
   * engine. The return is the surviving subset — order intact, the same
   * objects — so a caller can rebuild paragraph structure by membership.
   *
   * If every line fails the bar, the input comes back untouched: an image
   * that is *all* stylised type is exactly where the confidence stops meaning
   * anything, and a low-confidence result the user can judge for themselves
   * still beats an empty popup. A line with no numeric confidence is kept for
   * the same reason — "unknown" is not "bad".
   */
  function filterRecognizedLines(lines) {
    const all = Array.isArray(lines) ? lines : [];
    const kept = all.filter((line) => {
      if (!line || typeof line.confidence !== 'number' || !isFinite(line.confidence)) return true;
      return line.confidence >= OCR_LINE_CONFIDENCE_THRESHOLD;
    });
    return kept.length > 0 ? kept : all;
  }

  // --- Translation step ------------------------------------------------------

  /**
   * Is there anything for step 2 to do? "No" is a normal, successful outcome —
   * the recognised text is the result, and the popup shows it alone.
   *
   * Both language codes must already be normalised by the caller, with
   * `ctx.builtinTranslator.toApiLang` — the one language table in the
   * extension, in content/content-translation-engine.js. Comparing raw codes
   * here would mean a second table that has to agree with it forever, and it
   * would be wrong the first time someone's target is 'zh-CN' against a
   * detected 'zh-Hans'.
   */
  function shouldTranslate({ enabled, text, sourceLanguage, targetLanguage }) {
    if (!enabled) return false;
    if (!String(text || '').trim()) return false;
    if (!targetLanguage) return false;
    // An unknown source is worth a try — the engine gets the final say, and
    // guessing "already translated" from no evidence loses the user a result.
    // A known-equal one is not: it costs an API call to hand back the input.
    return !sourceLanguage || sourceLanguage !== targetLanguage;
  }

  // --- Prompt ----------------------------------------------------------------

  // The `vision` engine's prompt. Recognition and language detection only —
  // translation is step 2, and it does not happen here (see the file header).
  const OCR_SYSTEM_PROMPT = `You are an OCR engine. The user sends one image.
Do both of the following:
1. Extract ALL human-readable text from the image, preserving reading order and line breaks.
2. Detect the language the extracted text is written in.

Return ONLY a JSON object with exactly these keys:
{"text": "<extracted text, verbatim>", "language": "<BCP 47 code such as en, ja, zh-Hans>"}

Rules:
- If the image contains no readable text, return {"text": "", "language": ""}
- Skip watermarks and decorative repeated patterns; keep everything a human reader is meant to read.
- Never translate, summarise, correct or paraphrase. "text" is what the image says, character for character.
- Do not describe the image. Do not add commentary, notes, or markdown fences.`;

  // The user turn accompanying the image. Short on purpose: the instructions
  // all live in the system prompt above.
  const OCR_USER_INSTRUCTION = 'Extract the text from this image and detect its language.';

  // --- Detected-language labels ----------------------------------------------

  // i18n keys for everything detectScriptLanguage can return, plus the codes a
  // vision model tends to answer with for the same languages. Not a general
  // BCP 47 table: an unrecognised code is shown as-is, which is honest and
  // still readable ("Detected language: pt").
  const DETECTED_LANGUAGE_LABEL_KEYS = {
    en: 'langEn',
    ja: 'langJa',
    ko: 'langKo',
    ru: 'langRu',
    fr: 'langFr',
    de: 'langDe',
    es: 'langEs',
    pt: 'langPt',
    'zh-hans': 'langZhCN',
    'zh-cn': 'langZhCN',
    zh: 'langZhCN',
    'zh-hant': 'langZhTW',
    'zh-tw': 'langZhTW'
  };

  /** The i18n key naming `langCode` in the UI's language, or '' if unknown. */
  function detectedLanguageLabelKey(langCode) {
    return DETECTED_LANGUAGE_LABEL_KEYS[String(langCode || '').trim().toLowerCase()] || '';
  }

  // --- Response parsing ------------------------------------------------------

  // The prompt asks for line breaks preserved, and weaker models take that
  // literally inside the JSON string values — a raw newline where JSON demands
  // \n. Escape control characters, but only inside string literals: between
  // tokens they are legal pretty-printing.
  function escapeControlCharsInStrings(candidate) {
    let out = '';
    let inString = false;
    let escaped = false;
    for (const ch of candidate) {
      if (!inString) {
        if (ch === '"') inString = true;
        out += ch;
        continue;
      }
      if (escaped) {
        out += ch;
        escaped = false;
      } else if (ch === '\\') {
        out += ch;
        escaped = true;
      } else if (ch === '"') {
        out += ch;
        inString = false;
      } else if (ch === '\n') {
        out += '\\n';
      } else if (ch === '\r') {
        out += '\\r';
      } else if (ch === '\t') {
        out += '\\t';
      } else {
        out += ch;
      }
    }
    return out;
  }

  /**
   * Parse the model's reply into {text, language}, or null when the reply tried
   * to be JSON and broke — truncated by the token cap, mangled past repair.
   * Showing that blob as recognised text would be worse than an error, so the
   * caller turns null into one.
   *
   * Tolerant on purpose: models wrap JSON in ```json fences, prefix a
   * sentence, or leave literal newlines inside string values, despite the
   * prompt. A reply with no JSON object in it at all is taken as the recognised
   * text itself — the most useful reading of a model that answered in prose —
   * with the language left for detectScriptLanguage to work out.
   */
  function parseOcrResponse(content) {
    const raw = String(content || '').trim();
    const empty = { text: '', language: '' };
    if (!raw) return empty;

    let candidate = raw;
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced) candidate = fenced[1].trim();

    if (!candidate.startsWith('{')) {
      const start = candidate.indexOf('{');
      const end = candidate.lastIndexOf('}');
      if (start !== -1 && end > start) candidate = candidate.slice(start, end + 1);
    }

    if (candidate.startsWith('{')) {
      let parsed = null;
      try {
        parsed = JSON.parse(candidate);
      } catch {
        try {
          parsed = JSON.parse(escapeControlCharsInStrings(candidate));
        } catch {
          return null;
        }
      }
      const str = (v) => (typeof v === 'string' ? v.trim() : '');
      return { text: str(parsed.text), language: str(parsed.language) };
    }

    return { ...empty, text: raw };
  }

  root.OCRCore = {
    DEFAULT_OCR_ENGINE,
    OCR_MEDIA_TYPES,
    OCR_MAX_BYTES,
    OCR_MAX_DIMENSION,
    OCR_MIN_DIMENSION,
    OCR_LANGUAGES,
    canSendImageDirectly,
    normalizeCropRect,
    cropSourceRect,
    computeOcrCanvasSize,
    paintedImageBox,
    resolveOcrLanguagePlan,
    assessRecognition,
    isAcceptableRecognition,
    rescaleFactorForRetry,
    pickBetterRecognition,
    OCR_ACCEPT_MEAN_CONFIDENCE,
    detectScriptLanguage,
    OCR_LINE_CONFIDENCE_THRESHOLD,
    filterRecognizedLines,
    normalizeRecognizedText,
    detectedLanguageLabelKey,
    shouldTranslate,
    OCR_SYSTEM_PROMPT,
    OCR_USER_INSTRUCTION,
    parseOcrResponse
  };
})(globalThis);
