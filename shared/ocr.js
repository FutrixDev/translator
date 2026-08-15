// Image OCR translation: the pure half of the feature — the prompt the vision
// model is given, the tolerant parser for what comes back, and the encoding
// limits the service worker enforces before shipping an image anywhere.
//
// Kept out of background/background.js for the same reason caption-core.js
// exists: `npm run test:unit` exercises this with no browser, and the DOM-full
// half (fetching the image, OffscreenCanvas re-encode, the popup) stays thin.
//
// Loaded as a side-effect import by the module service worker, so it publishes
// onto the global object rather than using `export`.
(function (root) {
  'use strict';

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

  // --- Prompt ----------------------------------------------------------------

  // One call does all three steps (extract, detect, translate): a second
  // round-trip through the text-translation path would double latency and cost
  // for no accuracy gain — the model has already read the text.
  function buildOcrSystemPrompt(targetLangName) {
    return `You are an OCR engine and translator. The user sends one image.
Do all of the following:
1. Extract ALL human-readable text from the image, preserving reading order and line breaks.
2. Detect the language the extracted text is written in.
3. Translate the extracted text to ${targetLangName}.

Return ONLY a JSON object with exactly these keys:
{"text": "<extracted text>", "language": "<BCP 47 code such as en, ja, zh-CN>", "languageName": "<detected language's name, written in ${targetLangName}>", "translation": "<translation in ${targetLangName}>"}

Rules:
- If the image contains no readable text, return {"text": "", "language": "", "languageName": "", "translation": ""}
- Skip watermarks and decorative repeated patterns; keep everything a human reader is meant to read.
- If the extracted text is already in ${targetLangName}, "translation" must repeat it exactly.
- Do not describe the image. Do not add commentary, notes, or markdown fences.`;
  }

  // The user turn accompanying the image. Short on purpose: the instructions
  // all live in the system prompt above.
  const OCR_USER_INSTRUCTION = 'Extract the text from this image, detect its language, and translate it as instructed.';

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
   * Parse the model's reply into {text, language, languageName, translation},
   * or null when the reply tried to be JSON and broke — truncated by the token
   * cap, mangled past repair. Showing that blob as a "translation" would be
   * worse than an error, so the caller turns null into one.
   *
   * Tolerant on purpose: models wrap JSON in ```json fences, prefix a
   * sentence, or leave literal newlines inside string values, despite the
   * prompt. A reply with no JSON object in it at all is treated as the
   * translation — the most useful reading of a model that answered in prose —
   * with no extracted text to show.
   */
  function parseOcrResponse(content) {
    const raw = String(content || '').trim();
    const empty = { text: '', language: '', languageName: '', translation: '' };
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
      return {
        text: str(parsed.text),
        language: str(parsed.language),
        // Both spellings: the prompt asks for languageName, but models that
        // have seen more snake_case JSON sometimes normalize to it.
        languageName: str(parsed.languageName) || str(parsed.language_name),
        translation: str(parsed.translation)
      };
    }

    return { ...empty, translation: raw };
  }

  root.OCRCore = {
    OCR_MEDIA_TYPES,
    OCR_MAX_BYTES,
    OCR_MAX_DIMENSION,
    canSendImageDirectly,
    buildOcrSystemPrompt,
    OCR_USER_INSTRUCTION,
    parseOcrResponse
  };
})(globalThis);
