// Blab Translation Content Script Local Preferences
//
// A preference this device keeps in chrome.storage.local and every frame of
// every tab follows: the dialog's own target language (content-input-dialog.js)
// and the recently picked target languages (content-language.js). Both used to
// carry their own copy of the same machine — the initial read, the settled flag,
// the onChanged filter, the extension-context check — and the two copies had
// already drifted (one warned on a failed write, the other swallowed it).
//
// ctx.localPref(key, { parse }) answers { get, set }:
//
// - The initial read is async, and anything that decides the value for real
//   first — a set() here, or a write from another tab — settles it; a read that
//   lands afterwards must not put the old value back.
// - set(value) changes this frame at once and writes only when the value is a
//   different one (=== ). Every frame runs the same listeners, so a change all
//   frames make at once is written by the frames that held something else.
// - A write from any frame or tab arrives through onChanged and replaces the
//   value here, through parse.
// - A failed read or write is logged, never thrown: the memory is not worth
//   failing a translation, and this frame keeps its in-memory value.
//
// Loaded before every content script that calls it (manifest.json), and read at
// call time through ctx all the same.
(function() {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT;
  if (!ctx) return;

  /**
   * @template T
   * @param {string} key the chrome.storage.local key
   * @param {{parse: (stored: unknown) => T}} options parse turns whatever is
   *   stored (undefined when nothing is) into the value; it is also the initial
   *   value before the read lands
   * @returns {{get: () => T, set: (value: T) => void}}
   */
  ctx.localPref = function(key, { parse }) {
    let value = parse(undefined);
    let settled = false;

    if (ctx.isExtensionContextAvailable()) {
      try {
        chrome.storage.local.get(key, (result) => {
          if (chrome.runtime.lastError || settled) return;
          settled = true;
          value = parse(result?.[key]);
        });
      } catch (error) {
        console.warn(`[Blab Translation] reading ${key} failed`, error);
      }
    }

    chrome.storage.onChanged.addListener((changes, namespace) => {
      if (namespace !== 'local' || !changes[key]) return;
      settled = true;
      value = parse(changes[key].newValue);
    });

    return {
      get: () => value,
      set(next) {
        settled = true;
        if (next === value) return;
        value = next;
        if (!ctx.isExtensionContextAvailable()) return;
        const failed = (error) => console.warn(`[Blab Translation] saving ${key} failed`, error);
        // The extension context can go away between the check and the call, and
        // then set() throws instead of rejecting.
        try {
          chrome.storage.local.set({ [key]: next }).catch(failed);
        } catch (error) {
          failed(error);
        }
      },
    };
  };
})();
