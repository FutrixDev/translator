// Popup — the "Target language" row: the same dropdown as the selection card and
// the settings page (shared/lang-picker.js).
//
// Like the Display row (popup-display.js) it only writes chrome.storage.sync;
// every tab's content script applies the new target from its storage listener,
// so the popup sends no message to the tab. The row is drawn from storage — the
// first read and then onChanged — so a change made on the settings page or a
// card while the popup is open shows here too. An empty stored value means
// "follow the browser" and is shown as the language it resolves to; picking a
// language here stores it explicitly, which is what picking it anywhere does.
//
// The "Recent" group is the one the content scripts record when a translation is
// dispatched (chrome.storage.local recentTargetLangs); the popup only reads it.
// No "AI only" tag: whether the built-in engine knows a language is answered by
// the engine family, which lives in the page, and the popup does not load it.
//
// Loaded before popup.js and sharing its global scope: `t` and `currentUILang`
// come from there, and setupTargetLangRow is called from its checkStatus after
// the UI language is known.
function writeTargetLang(targetLang) {
  chrome.storage.sync.set({ targetLang }).catch((error) => {
    console.error('Blab Translation: target language write failed', error);
  });
}

// checkStatus runs again after "Reload page", so the dropdown is attached once and
// a later call only shows the value it read: a second attach would add a second
// toggle listener to the trigger, and one click would open and close the menu.
let targetLangPicker = null;

/** @param {{targetLang: string}} settings the values checkStatus already read. */
function setupTargetLangRow(settings) {
  if (targetLangPicker) {
    targetLangPicker.value = TargetLang.effective(settings);
    targetLangPicker.relabel();
    return;
  }
  const recent = LangPicker.watchRecent(chrome.storage);
  const picker = LangPicker.attachDropdown(document.getElementById('popupTargetLang'), {
    value: TargetLang.effective(settings),
    labelOf: (code) => TargetLang.nameOf(code, currentUILang),
    buildMenu: (menu, selected) => LangPicker.renderMenu(menu, {
      selected,
      uiLang: currentUILang,
      recent: recent.get(),
      t,
    }),
    onChange: writeTargetLang,
  });
  targetLangPicker = picker;

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.targetLang) {
      picker.value = TargetLang.effective({ targetLang: changes.targetLang.newValue || '' });
    }
  });
}
