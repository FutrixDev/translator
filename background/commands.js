// Blab Translation — keyboard shortcuts: one table, command name → handler.
//
// The keys are declared in manifest.json `commands` (users can rebind them at
// chrome://extensions/shortcuts). The listener itself stays in background.js:
// a service worker has to register its listeners synchronously at the top level
// of its entry module, or a wake-up by the shortcut finds nobody listening.
// Everything it does lives here, so a new shortcut is a row in this table, not
// a second onCommand listener.
import { defaultSettings } from './settings.js';

async function targetTab(tab) {
  const target = tab || (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  return target && typeof target.id === 'number' ? target : null;
}

// Alt+A — translate or restore this page. The same message the context menu and
// the popup row send, because it is the same action.
//
// frameId 0: only the top frame owns "the page". Content scripts run in the top
// frame alone today, so this is what already happens; it stays true once child
// frames get content scripts of their own.
//
// A page with no content script (chrome://, the Web Store, a tab still loading)
// rejects sendMessage. A shortcut that does nothing there is expected, so the
// rejection is logged here and not rethrown into an unhandled rejection.
async function togglePageTranslation(tab) {
  const target = await targetTab(tab);
  if (!target) return;
  try {
    await chrome.tabs.sendMessage(target.id, { type: 'TOGGLE_PAGE_TRANSLATION' }, { frameId: 0 });
  } catch (error) {
    console.log('Blab Translation: toggle shortcut had no receiver', error && error.message);
  }
}

// Alt+T — bilingual ↔ translation only. It only writes the setting: every tab's
// content script applies it from its storage listener, the same path the options
// page, the popup and the float ball take. So it works on every page, with or
// without a content script in the active tab.
async function toggleTranslationOnly() {
  const { showTranslationOnly } = await chrome.storage.sync.get({
    showTranslationOnly: defaultSettings.showTranslationOnly,
  });
  await chrome.storage.sync.set({ showTranslationOnly: !showTranslationOnly });
}

const COMMANDS = {
  'toggle-translate-page': togglePageTranslation,
  'toggle-translation-only': toggleTranslationOnly,
};

export async function runCommand(command, tab) {
  const handler = COMMANDS[command];
  if (!handler) return;
  await handler(tab);
}
