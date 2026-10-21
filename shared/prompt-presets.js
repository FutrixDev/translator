// Blab Translation — the three prompt presets the settings page offers, and which
// one is the default.
//
// Dual-mode classic script: the service worker imports it (background/prompts.js)
// and the settings page loads it (options/options.html), so the box the user
// reads and the template the worker sends are one string.
//
// The default (DEFAULT) is what an empty `customPrompt` means on the three text
// paths (single, numbered batch, fast batch): the worker sends this template with
// the same per-path rules it appends to a prompt the user typed, so the box
// showing it is exactly what goes out. The settings page shows it in the box and
// stores '' while the box still holds it, so a user who never touched the prompt
// keeps the mode's dictionary prompt on the word path (background/prompts.js
// WORD_MODES).
//
// Sent to the model, never shown as UI text: English in every UI language, and
// not in i18n — a translated "reply with the translation only" is not a better
// instruction. None carries the register rule; every path appends it once.
(function (root) {
  const TEMPLATES = Object.freeze({
    standard: `You are a professional translator. Translate the given text to {targetLang}.
Rules:
1. Reply with the translation only, no explanations or notes
2. Maintain the original formatting (line breaks, punctuation)
3. Keep technical terms, brand names, and proper nouns in their original form when appropriate
4. If the text is already in the target language, return it unchanged (no paraphrasing or reordering)
5. Translate naturally, not literally`,
    literal: `You are a precise translator. Translate the given text to {targetLang}.
Rules:
1. Reply with the translation only, no explanations
2. Translate as literally as possible while maintaining grammatical correctness
3. Preserve the original sentence structure when possible
4. Keep all technical terms, names, and proper nouns unchanged
5. If the text is already in the target language, return it unchanged (no paraphrasing or reordering)`,
    creative: `You are a creative translator and language artist. Translate the given text to {targetLang}.
Rules:
1. Reply with the translation only, no explanations
2. Prioritize natural, fluent expression in the target language
3. Adapt idioms and cultural references to equivalent expressions in the target culture
4. Maintain the tone and emotion of the original text
5. If the text is already in the target language, return it unchanged (no paraphrasing or reordering)`,
  });

  const DEFAULT = 'creative';

  // The user's own prompt in this stored or typed value, trimmed; '' when it
  // means "the default": empty, whitespace, or the default template itself (the
  // settings page stores '' for that).
  function ownPrompt(prompt) {
    const trimmed = (prompt || '').trim();
    return trimmed === TEMPLATES[DEFAULT] ? '' : trimmed;
  }

  // What the worker sends for this stored value: the user's own prompt, or the
  // default template when there is none.
  function textTemplate(customPrompt) {
    return ownPrompt(customPrompt) || TEMPLATES[DEFAULT];
  }

  root.PromptPresets = Object.freeze({ TEMPLATES, DEFAULT, ownPrompt, textTemplate });
})(globalThis);
