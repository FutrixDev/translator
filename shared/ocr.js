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

  // Which second language 'auto' pairs with English, keyed by the UI/target
  // language. English is always in the set because it turns up in screenshots,
  // UI chrome and signage everywhere; the second slot is the user's own script,
  // which is the other thing they are realistically pointing the tool at. Two
  // is the cap on purpose — a third costs more time than it wins back.
  const AUTO_SECOND_LANGUAGE = {
    'zh-CN': 'chi_sim',
    'zh-TW': 'chi_tra',
    ja: 'jpn',
    ko: 'kor'
  };

  /**
   * Resolve the stored `ocrSourceLanguage` setting into the '+'-joined string
   * Tesseract wants. 'auto' means English plus the user's own script; an
   * explicit choice means exactly that language and nothing else, because a
   * user who picked one knows better than the heuristic.
   */
  function resolveOcrLanguages(setting, uiLang) {
    const known = OCR_LANGUAGES.some((l) => l.code === setting);
    if (known) return setting;
    const second = AUTO_SECOND_LANGUAGE[uiLang];
    return second ? `eng+${second}` : 'eng';
  }

  // --- Script detection ------------------------------------------------------

  // Codepoint ranges that settle which language the recognised text is in.
  // Kana and Hangul are decisive on sight; Han is not, because Japanese uses it
  // too — so kana is tested first and Han is only reached when no kana appeared.
  const SCRIPT_RANGES = [
    { lang: 'ja', re: /[぀-ゟ゠-ヿ]/g },
    { lang: 'ko', re: /[가-힯ᄀ-ᇿ㄰-㆏]/g },
    { lang: 'ru', re: /[Ѐ-ӿ]/g },
    { lang: 'han', re: /[㐀-䶿一-鿿豈-﫿]/g },
    { lang: 'en', re: /[A-Za-zÀ-ɏ]/g }
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
    for (const { lang, re } of SCRIPT_RANGES) {
      const count = (source.match(re) || []).length;
      // Kana and Hangul settle it outright: a single one of either cannot show
      // up in Chinese or Latin text, whereas Han is common to Chinese *and*
      // Japanese and Latin letters litter otherwise-CJK strings.
      if (count > 0 && (lang === 'ja' || lang === 'ko')) return lang;
      if (count > 0 && (!best || count > best.count)) best = { lang, count };
    }
    if (!best) return '';
    if (best.lang !== 'han') return best.lang;

    const hint = String(hintLanguages || '');
    // chi_tra alone means Traditional; anything else (including the eng+chi_sim
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
    OCR_LANGUAGES,
    canSendImageDirectly,
    resolveOcrLanguages,
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
