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
import '../shared/site-rules.js';

// sync key: hosts that have been shown the comic hint once.
export const COMIC_HINT_HOSTS_KEY = 'comicHintHosts';
// Oldest dropped first, and a site seen that many sites ago can hear about it
// again. A count alone does not keep the item under sync's 8 KB per item (200
// hosts of 40+ characters do not fit), so the list is also cut by its encoded
// bytes against the budget every sync writer shares (StorageWriter.ITEM_BUDGET,
// which leaves room for the key).
const MAX_HOSTS = 200;

/** Newest last; oldest dropped until the count and the encoded bytes fit. */
function fitHosts(hosts) {
  const { ITEM_BUDGET, itemBytes } = StorageWriter;
  let next = hosts.slice(-MAX_HOSTS);
  while (next.length > 1 && itemBytes(next) > ITEM_BUDGET) next = next.slice(1);
  return next;
}

async function claim({ host }) {
  // One key per site, as the site rules count it: www.example.com and
  // example.com are the same site and are told once.
  const key = SiteRules.normalizeHost(host);
  if (!key) return false;
  const stored = await chrome.storage.sync.get({ [COMIC_HINT_HOSTS_KEY]: [] });
  const hosts = Array.isArray(stored[COMIC_HINT_HOSTS_KEY]) ? stored[COMIC_HINT_HOSTS_KEY] : [];
  if (hosts.includes(key)) return false;
  // Cut before every write: a list stored before this cut existed, already too
  // big for its item, heals on the next claim instead of failing it forever.
  await chrome.storage.sync.set({ [COMIC_HINT_HOSTS_KEY]: fitHosts([...hosts, key]) });
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
