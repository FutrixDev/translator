// Blab Translation background — which store this copy came from, and which
// browser it runs in.
//
// One package ships to the Chrome Web Store and to Microsoft Edge Add-ons.
// Edge runs the same Chromium extension APIs (the built-in Translator API is
// feature-detected like anywhere else), so only two addresses differ: the
// store page a rating goes to, and the browser's own keyboard-shortcuts page.
// They are decided by different things: Edge can install from the Chrome Web
// Store, so the store is read from the copy's update URL, not from the brand.
//
// Read at call time, never cached at load: a test can change either answer.

// The Chrome Web Store listing. Kept as a literal, not chrome.runtime.id, so an
// unpacked copy still links to the real listing.
const CHROME_WEB_STORE_ID = 'kbaebnmocaoogcjclbjmmhbbplbpcbpo';

// The update URL Edge Add-ons writes into every copy it installs.
const EDGE_ADDONS_UPDATE_HOST = 'edge.microsoft.com';

/** Microsoft Edge, by its brand; the UA token only where brands are absent. */
function isEdge() {
  const brands = navigator.userAgentData?.brands;
  if (Array.isArray(brands)) return brands.some(({ brand }) => brand === 'Microsoft Edge');
  return /\bEdg\//.test(navigator.userAgent || '');
}

/** Installed from Edge Add-ons: its store stamps the copy's update URL. */
function fromEdgeAddons() {
  const updateUrl = chrome.runtime.getManifest().update_url;
  if (!updateUrl) return false;
  return new URL(updateUrl).hostname === EDGE_ADDONS_UPDATE_HOST;
}

/**
 * The store page where this copy can be rated. Edge Add-ons keys a listing by
 * the extension's own id, which is what an Edge-store install runs under. A
 * Chrome Web Store copy, in Edge or anywhere, and an unpacked one go to the
 * Chrome Web Store listing.
 */
function storeReviewsUrl() {
  return fromEdgeAddons()
    ? `https://microsoftedge.microsoft.com/addons/detail/${chrome.runtime.id}`
    : `https://chromewebstore.google.com/detail/${CHROME_WEB_STORE_ID}/reviews`;
}

/** The browser's keyboard-shortcuts page for extensions. */
function shortcutSettingsUrl() {
  return isEdge() ? 'edge://extensions/shortcuts' : 'chrome://extensions/shortcuts';
}

export { storeReviewsUrl, shortcutSettingsUrl };
