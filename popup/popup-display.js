// Popup — the "Display" row: bilingual / translation only, and the translation
// style.
//
// The row only writes chrome.storage.sync. Every tab's content script applies
// the change from its storage listener (content/content-bootstrap.js), which is
// the same path the options page, the float ball and Alt+T take, so the popup
// sends no message to the tab. The row is also drawn only from storage — the
// first read and then onChanged — so what it shows is what was stored, including
// a change made elsewhere (Alt+T) while the popup is open, and a write that fails
// leaves the old value on screen instead of a lie.
//
// Loaded before popup.js and sharing its global scope: `t` comes from there and
// setupDisplayRow is called from its checkStatus, after the UI language is known.
const displayRow = {
  row: document.getElementById('displayRow'),
  bilingual: document.getElementById('displayBilingual'),
  translationOnly: document.getElementById('displayTranslationOnly'),
  style: document.getElementById('translationStyleSelect'),
};

function renderDisplayRow({ showTranslationOnly, translationStyle }) {
  const only = !!showTranslationOnly;
  displayRow.bilingual.setAttribute('aria-pressed', String(!only));
  displayRow.translationOnly.setAttribute('aria-pressed', String(only));
  displayRow.style.value = TranslationDisplay.normalizeStyle(translationStyle);
}

function writeDisplaySetting(patch) {
  chrome.storage.sync.set(patch).catch((error) => {
    console.error('Blab Translation: display setting write failed', error);
  });
}

/**
 * @param {{showTranslationOnly: boolean, translationStyle: string}} settings
 *   the values checkStatus already read, so the row is drawn in the same pass.
 */
function setupDisplayRow(settings) {
  displayRow.row.setAttribute('aria-label', t('displayModeLabel'));
  displayRow.style.setAttribute('aria-label', t('translationStyleLabel'));
  displayRow.style.replaceChildren(...TranslationDisplay.STYLES.map((style) => {
    const option = document.createElement('option');
    option.value = style;
    option.textContent = t(TranslationDisplay.styleLabelKey(style));
    return option;
  }));
  renderDisplayRow(settings);

  displayRow.bilingual.addEventListener('click', () => writeDisplaySetting({ showTranslationOnly: false }));
  displayRow.translationOnly.addEventListener('click', () => writeDisplaySetting({ showTranslationOnly: true }));
  displayRow.style.addEventListener('change', () => writeDisplaySetting({ translationStyle: displayRow.style.value }));

  const current = { ...settings };
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    if (!('showTranslationOnly' in changes) && !('translationStyle' in changes)) return;
    for (const key of ['showTranslationOnly', 'translationStyle']) {
      if (key in changes) current[key] = changes[key].newValue;
    }
    renderDisplayRow(current);
  });
}
