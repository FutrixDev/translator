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

// Send a page-level message to the top frame of the target tab.
//
// frameId 0: content scripts run in every frame (manifest `all_frames`), but
// only the top frame owns "the page"; child frames do not answer top-only
// messages (content/frames/shelf.js). Whatever a child frame should do follows
// from the top frame's own round.
//
// A page with no content script (chrome://, the Web Store, a tab still loading)
// rejects sendMessage. A shortcut that does nothing there is expected, so the
// rejection is logged here, under the caller's label, and not rethrown into an
// unhandled rejection.
async function sendToTopFrame(tab, message, label) {
  const target = await targetTab(tab);
  if (!target) return;
  try {
    await chrome.tabs.sendMessage(target.id, message, { frameId: 0 });
  } catch (error) {
    console.log(`Blab Translation: ${label} shortcut had no receiver`, error && error.message);
  }
}

// Alt+A — translate or restore this page. The same message the context menu and
// the popup row send, because it is the same action.
async function togglePageTranslation(tab) {
  await sendToTopFrame(tab, { type: 'TOGGLE_PAGE_TRANSLATION' }, 'toggle');
}

// Alt+W — widen this page to whole-page scope for now, then translate. Sent to
// the top frame only: each child frame's scope override is carried down by the
// top frame's manual round (docs/plans/2026-09-24-p1-a-page-coverage.md
// §2.6), not decided here on its behalf.
async function translateWholePage(tab) {
  await sendToTopFrame(tab, { type: 'TRANSLATE_WHOLE_PAGE' }, 'whole-page');
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
  'translate-whole-page': translateWholePage,
};

export async function runCommand(command, tab) {
  const handler = COMMANDS[command];
  if (!handler) return;
  await handler(tab);
}
