// Blab Translation — the dictionary entry: its shape, the prompt that asks for
// it, the check on what the model sends back, and the one way it is drawn.
//
// Looking up a word or short phrase (isLookup: the input dialog and the
// selection card ask the same question) asks the user's own AI engine for an
// entry, not just a translation. Nothing else is asked: no third-party
// dictionary sees the word (D-469). The built-in engine only translates, so its answers carry no entry
// and nothing below is drawn for them (D-470).
//
// One owner for every half of it:
//   isLookup      whether a text is looked up at all (D-473–D-475). Both
//                 surfaces call it and keep no check of their own.
//   FIELDS        the shape. OUTPUT_RULES (what the prompt asks for) and
//                 normalize() (what the service worker accepts) both read it,
//                 so the two cannot ask for and accept different keys.
//   fromModelText the service worker's reading of the model's answer (D-472).
//                 Three things throw an error marked `invalidEntry`: no JSON
//                 object to extract, a parse that is not an object, a missing
//                 or empty translation. There is no line-guessing fallback and
//                 no "translation only" rescue. Everything optional is lenient:
//                 a field of the wrong type, or one overlong item, is dropped
//                 and the rest of the entry kept.
//   entryFor      which answers carry an entry: a model engine's answer ('ai'
//                 or 'blab') to a word-mode request, and only that one.
//   render        the DOM. The input dialog and the selection card both call
//                 it; neither builds an entry block of its own.
//
// Message shape (TRANSLATE): an AI answer in word mode is
// `{ translation, entry }` — `entry.translation` equals `translation`, which
// stays at the top because every other caller reads it there. Every other
// answer is `{ translation }`. The content engine adds `engine`.
//
// Model strings reach the page through textContent only. The one innerHTML in
// this file writes the speaker glyph, a constant from content/content-speech.js.
//
// Dual-mode classic script: the service worker imports it, the content scripts
// load it from the manifest, both read globalThis.DictEntry. render() alone
// reads globalThis.LangTags (shared/lang-tags.js, before this file in the
// manifest), and only when it runs: the service worker never renders.
(function (root) {
  'use strict';

  // Longest string the entry accepts, in characters. A definition or example is
  // a line, not a paragraph; anything longer is the model writing an essay
  // instead of following the format, and that string is dropped rather than
  // drawn. A translation that long counts as missing, and the lookup fails.
  const MAX_TEXT = 500;

  // ---- what is looked up (D-473) ---------------------------------------------

  // Sentence punctuation: any of these in the text makes it a sentence.
  const SENTENCE_PUNCTUATION = /[.!?。！？；;，,：:]/;

  // Formula notation: a match for any of these makes the text a formula,
  // translated so the math placeholder rule applies; the lookup prompt has no
  // such rule. Hyphenated and slashed words (x-ray, Wi-Fi, km/h, and/or) stay
  // lookups: an ASCII - or / counts only between spaces or between bare
  // operands.
  const FORMULA_NOTATION = Object.freeze([
    // A LaTeX delimiter ($, \(, \[) or command (\alpha), a math symbol
    // (\p{Sm}: + = < > | ~ ± × ÷ −), or ^ _ { } (D-474); any * (D-475).
    /[$^_{}*\p{Sm}]|\\[([A-Za-z]/u,
    // - or / with whitespace on both sides: x - y, a / b (D-475).
    /\s[-/]\s/u,
    // - or / between two bare operands, a single letter or a digit string, with
    // no letter or digit just outside them: x-y, 3/4, 1990-2000, (x-y) (D-475).
    /(?<![\p{L}\p{N}])(?:\p{L}|\p{N}+)\s*[-/]\s*(?:\p{L}|\p{N}+)(?![\p{L}\p{N}])/u,
  ]);

  // Scripts that do not separate words with spaces: a lookup in them is counted
  // in characters, not words.
  const UNSPACED_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

  const MAX_LOOKUP_WORDS = 3;
  const MAX_LOOKUP_CHARS = 4;

  /**
   * Whether `text` is looked up as a dictionary entry (mode 'word') rather than
   * translated as a sentence. After trimming, it has no sentence punctuation,
   * no formula notation, and is 1–3 words in a space-separated script, or 1–4
   * characters in a script without spaces. Nothing else is weighed: "I run
   * daily" and "x-ray" are lookups, "$x + y$" and "x - y" are not.
   */
  function isLookup(text) {
    const trimmed = String(text == null ? '' : text).trim();
    if (!trimmed || SENTENCE_PUNCTUATION.test(trimmed)) return false;
    if (FORMULA_NOTATION.some((shape) => shape.test(trimmed))) return false;
    if (UNSPACED_SCRIPT.test(trimmed)) return Array.from(trimmed.replace(/\s+/g, '')).length <= MAX_LOOKUP_CHARS;
    return trimmed.split(/\s+/).length <= MAX_LOOKUP_WORDS;
  }

  // The phonetics are the translation's, in the target language (D-487). An
  // English translation has two labelled pronunciations, each read aloud in its
  // own accent; any other target language has one with an empty label, read
  // aloud in that target language (render's `targetLang`). The accent voices
  // are for an English target only: under any other target a UK/US label is a
  // wrong optional field, dropped (D-472), and the row is read in `targetLang`.
  const PHONETIC_LANGS = Object.freeze({ UK: 'en-GB', US: 'en-US' });

  // The shape. Each list has its item keys, a cap (longer lists are cut, not
  // rejected — five good examples are not a broken answer), and the sentence the
  // prompt uses to describe it. `required` item keys must be non-empty for the
  // item to be kept; an item missing one is dropped, not the whole entry.
  const FIELDS = Object.freeze({
    translation: Object.freeze({
      kind: 'text',
      describe: 'string, the most common translation in the target language. Required, never empty.',
    }),
    phonetics: Object.freeze({
      kind: 'list',
      max: 2,
      item: Object.freeze({ label: 'label', ipa: 'text' }),
      required: Object.freeze(['ipa']),
      describe: 'the pronunciation of the word in "translation", in the target language. When the target language is English give two items, "UK" and "US", each IPA wrapped in slashes such as "/kæt/". For any other target language give one item with an empty "label", in that language\'s usual notation (pinyin with tone marks for Chinese, kana or romaji for Japanese).',
    }),
    senses: Object.freeze({
      kind: 'list',
      max: 8,
      item: Object.freeze({ pos: 'text', defs: 'texts' }),
      maxDefs: 6,
      required: Object.freeze(['defs']),
      describe: 'meanings grouped by part of speech. "pos" is the abbreviation usual in the source language (n., v., adj.); "defs" are short definitions written in the target language.',
    }),
    examples: Object.freeze({
      kind: 'list',
      max: 3,
      item: Object.freeze({ source: 'text', target: 'text' }),
      required: Object.freeze(['source', 'target']),
      describe: 'short example sentences in the source language using the word, each with its translation in the target language.',
    }),
    forms: Object.freeze({
      kind: 'list',
      max: 8,
      item: Object.freeze({ label: 'text', value: 'text' }),
      required: Object.freeze(['label', 'value']),
      describe: 'inflected forms (plural, past tense, past participle, comparative). "label" is written in the target language, "value" is the form itself.',
    }),
  });

  const LIST_KEYS = Object.freeze(Object.keys(FIELDS).filter((key) => FIELDS[key].kind === 'list'));

  // The first line of the rules. The e2e mock server recognises a dictionary
  // request by it; it is a stable literal, so do not reword it casually.
  const PROMPT_MARK = 'OUTPUT FORMAT (dictionary entry):';

  // The last line of the rules (D-472). A custom prompt — a preset such as
  // "Reply with the translation only", or the default restored — comes before
  // the rules; without this line the model follows it and the lookup fails.
  const FORMAT_OVERRIDE = 'This output format overrides any earlier instruction about the format of the reply, including any instruction to reply with the translation only.';

  function itemSchema(field) {
    const parts = Object.entries(field.item).map(([key, type]) => {
      if (type === 'label') return `"${key}": "UK" | "US" | ""`;
      if (type === 'texts') return `"${key}": array of strings (at most ${field.maxDefs})`;
      return `"${key}": string`;
    });
    return `{${parts.join(', ')}}`;
  }

  // Built from FIELDS, so the keys the prompt names are exactly the keys
  // normalize() reads. No {placeholders}: it is appended to a custom prompt
  // after variable substitution.
  const OUTPUT_RULES = [
    PROMPT_MARK,
    'Return one JSON object only: no prose before or after it, no code fence. Keys:',
    ...Object.entries(FIELDS).map(([key, field]) => (field.kind === 'text'
      ? `- "${key}": ${field.describe}`
      : `- "${key}": array (at most ${field.max}) of ${itemSchema(field)}: ${field.describe}`)),
    'Give an empty string or an empty array for anything you are not sure of. Never invent a pronunciation, a sense, an example or a form.',
    'If the input is a whole sentence rather than a word or a short phrase, give only "translation" and leave every list empty.',
    FORMAT_OVERRIDE,
  ].join('\n');

  // ---- validation -----------------------------------------------------------

  function invalid(reason) {
    const error = new Error(`dictionary entry: ${reason}`);
    error.invalidEntry = true;
    return error;
  }

  const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

  // A string field: anything but a string, or a string over MAX_TEXT, is
  // dropped — read as '', the same as missing (D-472).
  function text(value) {
    if (typeof value !== 'string') return '';
    const trimmed = value.trim();
    return trimmed.length > MAX_TEXT ? '' : trimmed;
  }

  function label(value) {
    const raw = text(value).toUpperCase();
    // An unknown label ("GB", "British") still carries a real pronunciation:
    // keep it, drop the label it cannot be shown under. '' is the one
    // pronunciation of a translation in any language but English.
    return Object.prototype.hasOwnProperty.call(PHONETIC_LANGS, raw) ? raw : '';
  }

  // Not an array is no strings; a string that is dropped leaves the others.
  function texts(value, max) {
    if (!Array.isArray(value)) return [];
    return value.map(text).filter(Boolean).slice(0, max);
  }

  // null for anything that is not an object: the item is dropped.
  function normalizeItem(field, raw) {
    if (!isPlainObject(raw)) return null;
    const item = {};
    for (const [key, type] of Object.entries(field.item)) {
      if (type === 'label') item[key] = label(raw[key]);
      else if (type === 'texts') item[key] = texts(raw[key], field.maxDefs);
      else item[key] = text(raw[key]);
    }
    return item;
  }

  const filled = (value) => (Array.isArray(value) ? value.length > 0 : !!value);

  /**
   * The entry as the renderer may trust it, or a throw (`invalidEntry`) when
   * `raw` is not an object or its translation is missing or empty — the only
   * two hard failures here (D-472). Everything else is lenient: a list that is
   * not an array is empty, an item that is not an object or lacks a required
   * value is dropped, a string of the wrong type or over MAX_TEXT is dropped,
   * lists past their cap are cut; unknown keys are ignored and not carried.
   */
  function normalize(raw) {
    if (!isPlainObject(raw)) throw invalid('not a JSON object');
    const translation = text(raw.translation);
    if (!translation) throw invalid('translation is missing or empty');
    const entry = { translation };
    for (const key of LIST_KEYS) {
      const field = FIELDS[key];
      const value = Array.isArray(raw[key]) ? raw[key] : [];
      entry[key] = value
        .map((item) => normalizeItem(field, item))
        .filter((item) => item && field.required.every((name) => filled(item[name])))
        .slice(0, field.max);
    }
    return entry;
  }

  /**
   * The service worker's reading of the model's answer. One JSON object,
   * optionally after a reasoning model's <think>…</think> block, inside a
   * single code fence or with a stray sentence around it (the span from the
   * first `{` to the last `}`). No object to extract throws with `invalidEntry`
   * and the reason in the message; so does what normalize() rejects.
   */
  function fromModelText(content) {
    let body = String(content == null ? '' : content).replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    const fence = body.match(/^```[A-Za-z]*\s*\n([\s\S]*?)\n?```$/);
    if (fence) body = fence[1].trim();
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start === -1 || end < start) throw invalid('no JSON object in the answer');
    let parsed;
    try {
      parsed = JSON.parse(body.slice(start, end + 1));
    } catch (error) {
      throw invalid(`the answer is not valid JSON (${error.message})`);
    }
    return normalize(parsed);
  }

  /**
   * The entry a TRANSLATE response carries, or null when it carries none.
   * Only a model engine's answer to a word-mode request has one ('ai' or
   * 'blab', Engines.isModelEngine; the built-in engine only translates). A model
   * word answer without one is a broken service worker, so it throws rather
   * than quietly drawing nothing.
   */
  function entryFor(mode, response) {
    if (mode !== 'word' || !response || !globalThis.Engines.isModelEngine(response.engine)) return null;
    if (!response.entry) throw new Error('DictEntry.entryFor: a model word-mode answer carries no entry');
    return normalize(response.entry);
  }

  // ---- drawing ----------------------------------------------------------------

  /**
   * Draw `entry` into `container`, replacing what was there; null clears it.
   * The container is hidden whenever nothing is drawn, so a translation-only
   * entry leaves no empty heading behind. A speaker in the old entry that is
   * still talking is stopped first: its button is about to leave the page.
   *
   * The speaker on each phonetic row reads `entry.translation` (D-487): a UK
   * row in en-GB, a US row in en-US, an unlabelled row in `targetLang`. UK/US
   * hold only when `targetLang` is English; under any other target the label
   * is not drawn and the row is read in `targetLang`. The
   * looked-up text has its own speaker on each surface, outside the entry.
   *
   * @param {HTMLElement} container
   * @param {object|null} entry  from entryFor()
   * @param {{targetLang: string, t: (key: string) => string, speech: object}} options
   *   `targetLang` is the language this request translated into; `speech` is
   *   ctx.speech (content/content-speech.js). Drawing an entry without a
   *   targetLang throws: an unlabelled row would have no language to speak in.
   */
  // The visibility setters bindSpeakButton returned for each container's
  // speakers; setting one false stops that speaker if it is the one talking.
  const speakerSetters = new WeakMap();

  function render(container, entry, options) {
    for (const setVisible of speakerSetters.get(container) || []) setVisible(false);
    speakerSetters.delete(container);
    container.replaceChildren();
    if (entry === null) {
      container.hidden = true;
      return;
    }
    if (!isPlainObject(entry)) throw new TypeError('DictEntry.render: entry must be an object or null');
    const { targetLang, t, speech } = options;
    if (typeof targetLang !== 'string' || !targetLang) throw new TypeError('DictEntry.render: options.targetLang is required');
    const doc = container.ownerDocument;
    const el = (tag, className, value) => {
      const node = doc.createElement(tag);
      node.className = className;
      if (value !== undefined) node.textContent = value;
      return node;
    };
    const section = (name, heading) => {
      const block = el('div', `ai-translator-dict-section ai-translator-dict-${name}`);
      if (heading) block.appendChild(el('div', 'ai-translator-dict-heading', heading));
      container.appendChild(block);
      return block;
    };

    if (entry.phonetics.length) {
      const setters = [];
      speakerSetters.set(container, setters);
      const block = section('phonetics');
      const englishTarget = root.LangTags.getLangBase(targetLang) === 'en';
      for (const { label: given, ipa } of entry.phonetics) {
        const tag = englishTarget ? given : '';
        const row = el('span', 'ai-translator-dict-phonetic');
        if (tag) row.appendChild(el('span', 'ai-translator-dict-accent', t(tag === 'UK' ? 'dictUK' : 'dictUS')));
        row.appendChild(el('span', 'ai-translator-dict-ipa', ipa));
        const button = el('button', 'ai-translator-icon-btn ai-translator-dict-speak');
        button.type = 'button';
        button.dataset.accent = tag;
        button.setAttribute('aria-label', t('pronounceTranslation'));
        button.innerHTML = speech.SPEAKER_ICON;
        const lang = tag ? PHONETIC_LANGS[tag] : targetLang;
        setters.push(speech.bindSpeakButton(button, () => ({ text: entry.translation, lang })));
        row.appendChild(button);
        block.appendChild(row);
      }
    }

    if (entry.senses.length) {
      const block = section('senses');
      for (const { pos, defs } of entry.senses) {
        const row = el('div', 'ai-translator-dict-sense');
        if (pos) row.appendChild(el('span', 'ai-translator-dict-pos', pos));
        row.appendChild(el('span', 'ai-translator-dict-defs', defs.join('; ')));
        block.appendChild(row);
      }
    }

    if (entry.examples.length) {
      const block = section('examples', t('dictExamples'));
      for (const { source, target } of entry.examples) {
        const row = el('div', 'ai-translator-dict-example');
        row.appendChild(el('div', 'ai-translator-dict-example-source', source));
        row.appendChild(el('div', 'ai-translator-dict-example-target', target));
        block.appendChild(row);
      }
    }

    if (entry.forms.length) {
      const block = section('forms', t('dictForms'));
      for (const { label: name, value } of entry.forms) {
        const row = el('span', 'ai-translator-dict-form');
        row.appendChild(el('span', 'ai-translator-dict-form-label', name));
        row.appendChild(el('span', 'ai-translator-dict-form-value', value));
        block.appendChild(row);
      }
    }

    container.hidden = container.childElementCount === 0;
  }

  root.DictEntry = Object.freeze({
    FIELDS,
    MAX_TEXT,
    PHONETIC_LANGS,
    PROMPT_MARK,
    FORMAT_OVERRIDE,
    OUTPUT_RULES,
    isLookup,
    normalize,
    fromModelText,
    entryFor,
    render,
  });
})(globalThis);
