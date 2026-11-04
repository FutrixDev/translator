// Blab Translation background — which store this copy came from.
//
// One package ships to the Chrome Web Store and to Microsoft Edge Add-ons.
// Edge runs the same Chromium extension APIs, the built-in Translator API
// included, so only two addresses differ between the two: the store page a
// rating goes to, and the browser's own keyboard-shortcuts page.
//
// Read at call time, never cached at load: the answer is the browser's, and a
// test can change it.

// The Chrome Web Store listing. Kept as a literal, not chrome.runtime.id, so an
// unpacked copy still links to the real listing.
const CHROME_WEB_STORE_ID = 'kbaebnmocaoogcjclbjmmhbbplbpcbpo';

/** Microsoft Edge, by its brand; the UA token only where brands are absent. */
function isEdge() {
  const brands = navigator.userAgentData?.brands;
  if (Array.isArray(brands)) return brands.some(({ brand }) => brand === 'Microsoft Edge');
  return /\bEdg\//.test(navigator.userAgent || '');
}

/**
 * The store page where this copy can be rated. Edge Add-ons keys a listing by
 * the extension's own id, which is what an Edge-store install runs under.
 */
function storeReviewsUrl() {
  return isEdge()
    ? `https://microsoftedge.microsoft.com/addons/detail/${chrome.runtime.id}`
    : `https://chromewebstore.google.com/detail/${CHROME_WEB_STORE_ID}/reviews`;
}

/** The browser's keyboard-shortcuts page for extensions. */
function shortcutSettingsUrl() {
  return isEdge() ? 'edge://extensions/shortcuts' : 'chrome://extensions/shortcuts';
}

export { storeReviewsUrl, shortcutSettingsUrl };
