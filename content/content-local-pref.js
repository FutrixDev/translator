// Blab Translation Content Script Local Preferences
//
// A preference this device keeps in chrome.storage.local and every frame of
// every tab follows: the dialog's own target language (content-input-dialog.js)
// and the recently used target languages (content-language.js). Both used to
// carry their own copy of the same machine — the initial read, the settled flag,
// the onChanged filter, the extension-context check — and the two copies had
// already drifted (one warned on a failed write, the other swallowed it).
//
// ctx.localPref(key, { parse }) answers { get, set, update }:
//
// - The initial read is async, and anything that decides the value for real
//   first — a set() here, or a write from another tab — settles it; a read that
//   lands afterwards must not put the old value back.
// - set(value) changes this frame at once and writes only when the value is a
//   different one (sameValue: === , or an array with the same items in order).
//   Every frame runs the same listeners, so a change all frames make at once is
//   written by the frames that held something else.
// - update(fn) is set(fn(value)) for a value built from the stored one. Until
//   the value is settled the stored one is not known yet, so the update waits
//   and is applied, in order, to the value that settles it: the read, or a
//   write from another tab. Building on the initial empty value instead would
//   write a list of one over the whole stored list. When the read fails the
//   waiting updates and any later ones are dropped, not written, until another
//   tab's write settles the value.
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

  // The values kept here are strings and arrays of strings. set() is handed a
  // freshly built array each time, so arrays compare by their items.
  function sameValue(a, b) {
    if (a === b) return true;
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length
      && a.every((item, i) => item === b[i]);
  }

  /**
   * @template T
   * @param {string} key the chrome.storage.local key
   * @param {{parse: (stored: unknown) => T}} options parse turns whatever is
   *   stored (undefined when nothing is) into the value; it is also the initial
   *   value before the read lands
   * @returns {{get: () => T, set: (value: T) => void,
   *   update: (fn: (value: T) => T) => void}}
   */
  ctx.localPref = function(key, { parse }) {
    let value = parse(undefined);
    // With no extension context there is no read to wait for, and nothing
    // will be written either: the value is whatever this frame makes it.
    let settled = !ctx.isExtensionContextAvailable();
    let readFailed = false;
    let waiting = [];

    function write(next) {
      if (sameValue(next, value)) return;
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
    }

    function settle(stored) {
      settled = true;
      value = parse(stored);
      const updates = waiting;
      waiting = [];
      for (const fn of updates) write(fn(value));
    }

    // The waiting updates were meant for a stored value this frame will not
    // learn now; written over nothing they would replace it. This log speaks
    // for them and for every update dropped after it.
    function readFailedWith(error) {
      readFailed = true;
      waiting = [];
      console.warn(`[Blab Translation] reading ${key} failed`, error);
    }

    if (!settled) {
      try {
        chrome.storage.local.get(key, (result) => {
          const failure = chrome.runtime.lastError;
          if (failure) {
            readFailedWith(failure.message);
            return;
          }
          if (!settled) settle(result?.[key]);
        });
      } catch (error) {
        readFailedWith(error);
      }
    }

    chrome.storage.onChanged.addListener((changes, namespace) => {
      if (namespace !== 'local' || !changes[key]) return;
      settle(changes[key].newValue);
    });

    return {
      get: () => value,
      set(next) {
        // A value set outright replaces whatever the waiting updates would
        // have built.
        settled = true;
        waiting = [];
        write(next);
      },
      update(fn) {
        if (settled) write(fn(value));
        else if (!readFailed) waiting.push(fn);
      },
    };
  };
})();
