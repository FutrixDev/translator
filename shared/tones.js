// Blab Translation — the tones the input menu offers, and nothing else.
//
// A tone is an id, a group and a label key. How a tone is written is the Blab
// server's business: the extension sends the id with the text and never
// carries a prompt for it, so a better wording reaches every user without a
// release (docs/design/input-tone-rewrite.md §3, §6).
//
// PRIMARY is the six the menu shows at once, MORE the three behind "More", in
// the order they are drawn.
//
// Dual-mode like shared/quota-copy.js: content scripts load it with a plain
// <script>, the service worker imports it for its globalThis side effect, and
// node tests require it.
(function () {
  'use strict';

  var PRIMARY = Object.freeze(['friendly', 'formal', 'polite', 'serious', 'concise', 'casual']);
  var MORE = Object.freeze(['confident', 'empathetic', 'natural']);
  var IDS = Object.freeze(PRIMARY.concat(MORE));

  function isTone(id) {
    return IDS.indexOf(id) !== -1;
  }

  /** The i18n key of a tone's label: 'formal' -> 'toneFormal'. Throws on an unknown id. */
  function labelKey(id) {
    if (!isTone(id)) throw new Error('Tones.labelKey: unknown tone ' + JSON.stringify(id));
    return 'tone' + id.charAt(0).toUpperCase() + id.slice(1);
  }

  var Tones = Object.freeze({ PRIMARY: PRIMARY, MORE: MORE, IDS: IDS, isTone: isTone, labelKey: labelKey });

  if (typeof module !== 'undefined' && module.exports) module.exports = Tones;
  globalThis.Tones = Tones;
})();
