// Blab Translation — the service-worker half of the PDF / comic hint
// (content/content-media-hints.js draws it).
//
// Two things a content script cannot do on its own:
//
// - Remember "this site has already been told about the comic shortcut" without
//   a lost update. The list is one sync key, read-modify-written; two tabs on
//   two comic sites would both read the same old list and the later write would
//   drop the other host, so that site gets the hint twice. The write goes
//   through the same single-writer queue as the site rules
//   (shared/storage-writer.js). It is a claim, not a plain append: the answer
//   says whether this call is the one that added the host, so two tabs of the
//   same site cannot both show the hint.
// - Open chrome://extensions/shortcuts. Pages cannot navigate to chrome://
//   URLs; chrome.tabs.create can.
import '../shared/storage-writer.js';

// sync key: hosts that have been shown the comic hint once.
export const COMIC_HINT_HOSTS_KEY = 'comicHintHosts';
// Oldest dropped first. Sync is 8 KB per item; 200 host names stay well under
// the writer's budget, and a site seen 200 sites ago can hear about it again.
const MAX_HOSTS = 200;

async function claim({ host }) {
  if (!host) return false;
  const stored = await chrome.storage.sync.get({ [COMIC_HINT_HOSTS_KEY]: [] });
  const hosts = Array.isArray(stored[COMIC_HINT_HOSTS_KEY]) ? stored[COMIC_HINT_HOSTS_KEY] : [];
  if (hosts.includes(host)) return false;
  const next = [...hosts, host].slice(-MAX_HOSTS);
  await chrome.storage.sync.set({ [COMIC_HINT_HOSTS_KEY]: next });
  return true;
}

export const comicHintWriter = StorageWriter.create({
  type: 'COMIC_HINT_WRITE',
  writes: { claim },
  errors: 'throw',
});

export function openShortcutSettings() {
  return chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
}
