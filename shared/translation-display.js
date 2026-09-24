// Blab Translation — how page translations look: the one list of styles.
//
// A style is a single attribute on <html> (`data-ai-translator-style`) and a
// rule in content/css/translation.css; switching it never touches a translation
// node and never translates anything again. The content script, the popup and
// the options page all build their choices from STYLES, so a style exists in
// exactly one list — test/unit/translation-display.test.mjs checks that every
// style here has a rule in the CSS and every rule in the CSS names a style here.
//
// Loaded as a classic script everywhere (content scripts, popup, options), so it
// publishes onto the global object rather than using `export`.
(function (root) {
  'use strict';

  const STYLES = Object.freeze(['default', 'underline', 'dashed', 'highlight', 'quote', 'blur']);
  const DEFAULT_STYLE = 'default';
  const STYLE_ATTR = 'data-ai-translator-style';

  // Anything not in STYLES — a value from a newer or older build, a typo in
  // synced storage — reads as the default, which is what the page looked like
  // before styles existed.
  function normalizeStyle(value) {
    return STYLES.includes(value) ? value : DEFAULT_STYLE;
  }

  // 'underline' → 'translationStyleUnderline': the i18n key of a style's name.
  function styleLabelKey(style) {
    const name = normalizeStyle(style);
    return `translationStyle${name.charAt(0).toUpperCase()}${name.slice(1)}`;
  }

  // Put `style` on a document's <html>: the page (content/page/display.js) and
  // the options preview (options/options-display.js) both go through this, so
  // "default means no attribute" is written once.
  function applyStyleAttribute(doc, style) {
    const name = normalizeStyle(style);
    const html = doc.documentElement;
    if (name === DEFAULT_STYLE) html.removeAttribute(STYLE_ATTR);
    else html.setAttribute(STYLE_ATTR, name);
  }

  root.TranslationDisplay = Object.freeze({
    STYLES, DEFAULT_STYLE, STYLE_ATTR, normalizeStyle, styleLabelKey, applyStyleAttribute,
  });
})(globalThis);
