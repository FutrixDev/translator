// Blab Translation — the dictionary entry: its shape, the prompt that asks for
// it, the check on what the model sends back, and the one way it is drawn.
//
// Looking up a word (the input dialog with a short text, the selection card
// with a single word) asks the user's own AI engine for an entry, not just a
// translation. Nothing else is asked: no third-party dictionary sees the word
// (D-469). The built-in engine only translates, so its answers carry no entry
// and nothing below is drawn for them (D-470).
//
// One owner for every half of it:
//   FIELDS        the shape. OUTPUT_RULES (what the prompt asks for) and
//                 normalize() (what the service worker accepts) both read it,
//                 so the two cannot ask for and accept different keys.
//   fromModelText the service worker's reading of the model's answer. Anything
//                 that is not one JSON object of this shape throws an error
//                 marked `invalidEntry` — there is no line-guessing fallback
//                 and no "translation only" rescue.
//   entryFor      which answers carry an entry: an AI answer to a word-mode
//                 request, and only that one.
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
// load it from the manifest, both read globalThis.DictEntry. No dependencies.
(function (root) {
  'use strict';

  // Longest string the entry accepts, in characters. A definition or example is
  // a line, not a paragraph; anything longer is the model writing an essay
  // instead of following the format, and the lookup fails rather than drawing it.
  const MAX_TEXT = 500;

  // Phonetic labels and the speech tag each one is read aloud in. '' is the one
  // pronunciation of a non-English word: no label, language left to detection.
  const PHONETIC_LANGS = Object.freeze({ UK: 'en-GB', US: 'en-US', '': '' });

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
      describe: 'the pronunciation of the source word. For an English word give two items, "UK" and "US", each IPA wrapped in slashes such as "/rʌn/". For any other language give one item with an empty "label" in that language\'s usual notation (IPA, pinyin, romaji).',
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
  ].join('\n');

  // ---- validation -----------------------------------------------------------

  function invalid(reason) {
    const error = new Error(`dictionary entry: ${reason}`);
    error.invalidEntry = true;
    return error;
  }

  const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

  // A string field: missing is '', anything but a string throws, overlong throws.
  function text(value, where) {
    if (value === undefined || value === null) return '';
    if (typeof value !== 'string') throw invalid(`${where} is ${typeof value}, not a string`);
    const trimmed = value.trim();
    if (trimmed.length > MAX_TEXT) throw invalid(`${where} is ${trimmed.length} characters, over ${MAX_TEXT}`);
    return trimmed;
  }

  function label(value, where) {
    const raw = text(value, where).toUpperCase();
    // An unknown label ("GB", "British") still carries a real pronunciation:
    // keep the IPA, drop the label it cannot be shown under.
    return Object.prototype.hasOwnProperty.call(PHONETIC_LANGS, raw) ? raw : '';
  }

  function texts(value, where, max) {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) throw invalid(`${where} is not an array`);
    return value.map((item, i) => text(item, `${where}[${i}]`)).filter(Boolean).slice(0, max);
  }

  function normalizeItem(field, raw, where) {
    if (!isPlainObject(raw)) throw invalid(`${where} is not an object`);
    const item = {};
    for (const [key, type] of Object.entries(field.item)) {
      const at = `${where}.${key}`;
      if (type === 'label') item[key] = label(raw[key], at);
      else if (type === 'texts') item[key] = texts(raw[key], at, field.maxDefs);
      else item[key] = text(raw[key], at);
    }
    return item;
  }

  const filled = (value) => (Array.isArray(value) ? value.length > 0 : !!value);

  /**
   * The entry as the renderer may trust it, or a throw (`invalidEntry`).
   * Missing lists are empty; unknown keys are ignored and not carried; items
   * missing a required value are dropped; lists past their cap are cut.
   */
  function normalize(raw) {
    if (!isPlainObject(raw)) throw invalid('not a JSON object');
    const translation = text(raw.translation, 'translation');
    if (!translation) throw invalid('translation is empty');
    const entry = { translation };
    for (const key of LIST_KEYS) {
      const field = FIELDS[key];
      const value = raw[key];
      if (value === undefined || value === null) {
        entry[key] = [];
        continue;
      }
      if (!Array.isArray(value)) throw invalid(`${key} is not an array`);
      entry[key] = value
        .map((item, i) => normalizeItem(field, item, `${key}[${i}]`))
        .filter((item) => field.required.every((name) => filled(item[name])))
        .slice(0, field.max);
    }
    return entry;
  }

  /**
   * The service worker's reading of the model's answer. One JSON object,
   * optionally inside a single code fence or with a stray sentence around it
   * (the span from the first `{` to the last `}`). Anything else throws with
   * `invalidEntry` and the reason in the message.
   */
  function fromModelText(content) {
    let body = String(content == null ? '' : content).trim();
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
   * Only an AI answer to a word-mode request has one (the built-in engine only
   * translates). An AI word answer without one is a broken service worker, so
   * it throws rather than quietly drawing nothing.
   */
  function entryFor(mode, response) {
    if (mode !== 'word' || !response || response.engine !== 'ai') return null;
    if (!response.entry) throw new Error('DictEntry.entryFor: an AI word-mode answer carries no entry');
    return normalize(response.entry);
  }

  // ---- drawing ----------------------------------------------------------------

  /**
   * Draw `entry` into `container`, replacing what was there; null clears it.
   * The container is hidden whenever nothing is drawn, so a translation-only
   * entry leaves no empty heading behind.
   *
   * @param {HTMLElement} container
   * @param {object|null} entry  from entryFor()
   * @param {{word: string, t: (key: string) => string, speech: object}} options
   *   `word` is the looked-up text the speaker buttons read out; `speech` is
   *   ctx.speech (content/content-speech.js).
   */
  function render(container, entry, options) {
    container.replaceChildren();
    if (entry === null) {
      container.hidden = true;
      return;
    }
    if (!isPlainObject(entry)) throw new TypeError('DictEntry.render: entry must be an object or null');
    const { word, t, speech } = options;
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
      const block = section('phonetics');
      for (const { label: tag, ipa } of entry.phonetics) {
        const row = el('span', 'ai-translator-dict-phonetic');
        if (tag) row.appendChild(el('span', 'ai-translator-dict-accent', t(tag === 'UK' ? 'dictUK' : 'dictUS')));
        row.appendChild(el('span', 'ai-translator-dict-ipa', ipa));
        const button = el('button', 'ai-translator-icon-btn ai-translator-dict-speak');
        button.type = 'button';
        button.dataset.accent = tag;
        button.setAttribute('aria-label', t('pronounceOriginal'));
        button.innerHTML = speech.SPEAKER_ICON;
        speech.bindSpeakButton(button, () => ({ text: word, lang: PHONETIC_LANGS[tag] }));
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
    OUTPUT_RULES,
    normalize,
    fromModelText,
    entryFor,
    render,
  });
})(globalThis);
