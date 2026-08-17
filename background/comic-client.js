// AI Translator — Comic translation API client (service worker side)
//
// Comic page translation is the one feature that does NOT use the user's own
// API key: the redraw runs on our servers, draws on a monthly free page
// allowance, and therefore needs a
// signed-in account. Everything account- or job-related lives here so the
// existing BYO-key text translation in background.js stays untouched.
//
// All network calls happen in the service worker on purpose. A content script's
// fetch is subject to the page's CORS policy; the worker's is not, because
// host_permissions covers it. That is also why the extension can retry an image
// the server was not allowed to fetch — see fetchImageAsBase64().

// The apex, not an `app.` subdomain: the marketing site and the account/API
// half are one Cloudflare Worker on one origin, so /login and /api/* live here
// too. Keep in sync with PRODUCTION_ORIGIN in translator-saas/server.
const DEFAULT_API_BASE = 'https://translators-ai.com';

const STORAGE_KEYS = {
  apiBase: 'comicApiBase',
  token: 'comicToken',
  tokenExpiresAt: 'comicTokenExpiresAt',
  account: 'comicAccountCache'
};

// The server refuses anything larger before it charges anything, so there is no
// point uploading it. Kept in sync with MAX_SOURCE_BYTES on the server.
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export class ComicApiError extends Error {
  constructor(code, message, status = 0, details = {}) {
    super(message || code);
    this.name = 'ComicApiError';
    this.code = code;
    this.status = status;
    this.details = details || {};
  }

  /** Shape sent back over chrome.runtime messaging (Error does not survive it). */
  toMessage() {
    return { error: { code: this.code, message: this.message, status: this.status, ...this.details } };
  }
}

function asComicApiError(error) {
  if (error instanceof ComicApiError) return error;
  return new ComicApiError('network_error', error?.message || String(error));
}

// ---------------------------------------------------------------------------
// Configuration and token storage
// ---------------------------------------------------------------------------

// chrome.storage.local, not sync: the bearer token is a device credential and
// does not belong on other devices.
//
// The service address is deliberately NOT a setting. The extension's job in
// this feature is to hand an image to the service and put the result back —
// where that service lives is not information the user has any reason to see or
// change, and a settable endpoint would turn "translate this comic" into an
// arbitrary upload target. The storage key exists only so the e2e suite and
// local development can point at a dev server; nothing in the UI writes it.
export async function getApiBase() {
  const stored = await chrome.storage.local.get({ [STORAGE_KEYS.apiBase]: '' });
  const base = (stored[STORAGE_KEYS.apiBase] || '').trim() || DEFAULT_API_BASE;
  return base.replace(/\/+$/, '');
}

/**
 * The stored token, or null when there is none.
 *
 * Deliberately does NOT enforce `expiresAt` locally. The server slides the
 * expiry on every authenticated call (userIdForExtToken in the service), but it
 * never tells the extension the new value — the stored one is frozen at whatever
 * sign-in returned. Enforcing it here therefore threw away tokens the server was
 * still perfectly happy with, roughly one TTL after sign-in no matter how
 * actively the token was being used, and the user got a sign-in prompt for no
 * reason. A wrong local clock had the same effect.
 *
 * Expiry is the server's call, and it already makes it: apiFetch drops the token
 * on the 401. `expiresAt` is kept in storage as a diagnostic only.
 */
export async function getToken() {
  const stored = await chrome.storage.local.get({
    [STORAGE_KEYS.token]: '',
    [STORAGE_KEYS.tokenExpiresAt]: 0
  });
  const token = stored[STORAGE_KEYS.token];
  if (!token) return null;
  return { token, expiresAt: Number(stored[STORAGE_KEYS.tokenExpiresAt]) || 0 };
}

async function saveToken(token, expiresAt) {
  await chrome.storage.local.set({
    [STORAGE_KEYS.token]: token,
    [STORAGE_KEYS.tokenExpiresAt]: Number(expiresAt) || 0
  });
}

export async function clearToken() {
  await chrome.storage.local.remove([
    STORAGE_KEYS.token,
    STORAGE_KEYS.tokenExpiresAt,
    STORAGE_KEYS.account
  ]);
}

export async function isSignedIn() {
  return (await getToken()) !== null;
}

// ---------------------------------------------------------------------------
// Sign-in
// ---------------------------------------------------------------------------

/**
 * Runs the hosted consent page in an ordinary tab and resolves with the URL the
 * server finally redirects to.
 *
 * chrome.identity.launchWebAuthFlow does the same job in one call, but it always
 * opens its own detached browser window, which reads as "the extension launched
 * a browser" rather than "a page opened". A tab in the window the user is
 * already looking at is the same flow without that surprise, and it lets them
 * see the address bar they are about to type a password into.
 *
 * The redirect target is still the identity API's
 * `https://<extension-id>.chromiumapp.org/` — a host that serves nothing, so the
 * tab never loads a page from it. The token rides back in that URL's FRAGMENT,
 * which is never sent over the wire, and we read it off the navigation Chrome
 * reports before closing the tab. Watching for it needs the URL to be visible in
 * tabs.onUpdated, which host_permissions (`<all_urls>`) already covers.
 */
function runAuthTab(authUrl, redirectUri) {
  return new Promise((resolve, reject) => {
    let authTabId = null;
    let settled = false;
    // Events the tab fired before we knew its id.
    //
    // The listeners have to be registered before chrome.tabs.create, or a fast
    // redirect is missed outright — but Chrome starts reporting the tab the
    // moment it exists, which is before the create promise hands back its id.
    // Anything arriving in that window (measured at ~200ms) cannot be matched
    // against authTabId yet, so it is queued and replayed once it can be.
    // Discarding it instead was benign for onUpdated, where more events follow,
    // and a hang for onRemoved, where none do: a tab closed inside the window
    // left this promise pending forever, so signIn() never returned and both
    // listeners stayed attached for the life of the worker.
    const pending = [];

    function stopListening() {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
    }

    function onUpdated(tabId, changeInfo, tab) {
      if (settled) return;
      const url = changeInfo.url || tab?.url || tab?.pendingUrl || '';
      // Filtered before queueing, not after: every tab in the browser reports
      // its navigations here, and only this one URL is ever of interest.
      if (!url.startsWith(redirectUri)) return;
      if (authTabId === null) {
        pending.push(() => onUpdated(tabId, changeInfo, tab));
        return;
      }
      if (tabId !== authTabId) return;
      settled = true;
      stopListening();
      // Closing it ourselves keeps the dead chromiumapp.org error page from
      // ever being what the user is left looking at.
      chrome.tabs.remove(tabId).catch(() => {});
      resolve(url);
    }

    function onRemoved(tabId) {
      if (settled) return;
      if (authTabId === null) {
        pending.push(() => onRemoved(tabId));
        return;
      }
      if (tabId !== authTabId) return;
      settled = true;
      stopListening();
      // The user closed the tab before finishing: a cancel, not a failure.
      reject(new ComicApiError('sign_in_cancelled', 'Sign-in was cancelled'));
    }

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);

    chrome.tabs.create({ url: authUrl, active: true }).then(tab => {
      const id = tab?.id;
      if (typeof id !== 'number' || id < 0) {
        // No id means nothing can ever be matched, so the queue would never
        // drain and the promise would never settle — the same hang by another
        // route. Chrome only does this when the tab could not really be opened.
        settled = true;
        stopListening();
        reject(new ComicApiError('sign_in_failed', 'The sign-in tab could not be opened'));
        return;
      }
      authTabId = id;
      // Replayed in arrival order, so a redirect that landed before the id was
      // known still wins over the removal our own tabs.remove() will cause.
      const queued = pending.splice(0, pending.length);
      for (const replay of queued) {
        if (settled) break;
        replay();
      }
    }).catch(error => {
      if (settled) return;
      settled = true;
      stopListening();
      reject(new ComicApiError('sign_in_failed', error?.message || String(error)));
    });
  });
}

/**
 * Opens the hosted consent page and exchanges it for a bearer token.
 *
 * The provider choice (Google or GitHub) happens on the web page; the extension
 * never handles the OAuth itself. See runAuthTab() for how the token gets back.
 */
export async function signIn() {
  const base = await getApiBase();
  const redirectUri = chrome.identity.getRedirectURL();
  const state = crypto.randomUUID();
  const authUrl = `${base}/ext/connect?state=${encodeURIComponent(state)}&redirect_uri=${encodeURIComponent(redirectUri)}`;

  const finalUrl = await runAuthTab(authUrl, redirectUri);
  if (!finalUrl) throw new ComicApiError('sign_in_cancelled', 'Sign-in was cancelled');

  const fragment = finalUrl.includes('#') ? finalUrl.slice(finalUrl.indexOf('#') + 1) : '';
  const params = new URLSearchParams(fragment);
  const token = params.get('token');
  if (!token) throw new ComicApiError('sign_in_failed', 'The connect page returned no token');

  await saveToken(token, Number(params.get('expires_at')) || 0);
  return getAccount({ force: true });
}

export async function signOut() {
  await clearToken();
}

// ---------------------------------------------------------------------------
// Authenticated requests
// ---------------------------------------------------------------------------

// Exported for pdf-client.js, which rides the same account, token and error
// model rather than duplicating them.
export async function apiFetch(path, { method = 'GET', body = null } = {}) {
  const stored = await getToken();
  if (!stored) throw new ComicApiError('unauthorized', 'Sign in to translate comic pages', 401, { loginRequired: true });

  const base = await getApiBase();
  let response;
  try {
    response = await fetch(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${stored.token}`,
        ...(body ? { 'content-type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
  } catch (error) {
    throw new ComicApiError('network_error', error?.message || 'Could not reach the translation service');
  }

  const data = await response.json().catch(() => ({}));

  if (response.status === 401) {
    // The token is gone or revoked server-side. Dropping it locally is what
    // makes the next attempt offer a sign-in instead of failing again.
    await clearToken();
    throw new ComicApiError('unauthorized', data.message || 'Sign in again', 401, { loginRequired: true });
  }

  if (!response.ok) {
    const { error, message, ...details } = data;
    // The one place every API failure passes through, so the one log line that
    // makes a field report diagnosable from the SW console. Status + code +
    // a bounded message snippet; never the token, never the whole body.
    console.warn(
      `[api] ${method} ${path} -> HTTP ${response.status}` +
        ` code=${error || 'none'} ${String(message || '').slice(0, 200)}`
    );
    throw new ComicApiError(error || `http_${response.status}`, message || '', response.status, details);
  }

  return data;
}

/** Sign-in state and the monthly free page allowance in one call. */
export async function getAccount({ force = false } = {}) {
  if (!(await getToken())) return { signedIn: false };
  const cached = await chrome.storage.local.get({ [STORAGE_KEYS.account]: null });
  const entry = cached[STORAGE_KEYS.account];
  // A 30s cache keeps the popup and the options page from re-querying on every
  // open; anything that consumes the allowance passes force.
  if (!force && entry && Date.now() - entry.fetchedAt < 30_000) {
    return { signedIn: true, ...entry.account };
  }

  const account = await apiFetch('/api/billing/me');
  await chrome.storage.local.set({
    [STORAGE_KEYS.account]: { fetchedAt: Date.now(), account }
  });
  return { signedIn: true, ...account };
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

/**
 * Start a redraw. Returns the 202 body: `{ jobId, status, quote }`.
 *
 * The image is always uploaded as bytes — the service is never handed a URL to
 * go fetch. Acquiring those bytes is the extension's job and has two rungs:
 *
 *  1. here in the worker, which carries the user's cookies for the site and is
 *     exempt from CORS by host_permissions, so it reaches login-gated CDNs;
 *  2. failing that, the content script re-encodes the pixels the page already
 *     decoded (`needsPageBytes` below), which is the only way to read a
 *     `blob:`/`data:` src.
 *
 * `operationId` is the idempotency key — re-posting the same one returns the
 * existing job instead of counting the page twice, which is what makes a retry
 * after a dropped connection safe.
 */
export async function createJob({ operationId, imageUrl, pageUrl, imageBase64, sourceLang, targetLang, mode }) {
  // Ask for the token before downloading anything. Acquisition now happens
  // before the POST rather than after a rejection, so without this a signed-out
  // click — the common first one — pulls a multi-megabyte page for nothing.
  if (!(await getToken())) {
    throw new ComicApiError('unauthorized', 'Sign in to translate comic pages', 401, { loginRequired: true });
  }

  let bytes = imageBase64;
  if (!bytes && imageUrl) bytes = await fetchImageAsBase64(imageUrl);
  if (!bytes) {
    // Nothing was posted, so nothing was reserved — the content script can still
    // try the canvas and call this again with the same operationId.
    throw new ComicApiError('needs_page_bytes', 'The worker could not read the image', 0, {
      needsPageBytes: true
    });
  }

  return apiFetch('/api/comic/jobs', {
    method: 'POST',
    body: {
      operationId: operationId || crypto.randomUUID(),
      pageUrl: pageUrl || null,
      imageBase64: bytes,
      sourceLang: sourceLang || 'auto',
      targetLang: targetLang || 'zh-CN',
      // What the redraw does to the page: translate (default), colorize, or
      // translate_colorize. Validated server-side; absent means translate so
      // this client stays compatible with a server that predates modes.
      mode: mode || 'translate'
    }
  });
}

export function getJob(jobId) {
  return apiFetch(`/api/comic/jobs/${encodeURIComponent(jobId)}`);
}

export function abandonJob(jobId) {
  return apiFetch(`/api/comic/jobs/${encodeURIComponent(jobId)}/abandon`, { method: 'POST' });
}

// ---------------------------------------------------------------------------
// Image acquisition
// ---------------------------------------------------------------------------

/**
 * Fetch the image from the worker and return it base64-encoded, or null when
 * the worker cannot get it.
 *
 * `credentials: 'include'` is the point of this path: a page behind a login
 * serves its images only to a cookie-bearing request. `force-cache` normally
 * makes this free — the page just displayed this image, so the bytes are in the
 * HTTP cache. Referer is a forbidden header for fetch, so a strict hotlink
 * check is not something this path can beat; that case falls through to the
 * content script, which re-posts the pixels the page already decoded.
 */
export async function fetchImageAsBase64(imageUrl) {
  // Only http(s) is fetchable from here. A blob:/data: src belongs to the page's
  // own context and is the content script's to read.
  if (!/^https?:/i.test(imageUrl)) return null;
  try {
    const response = await fetch(imageUrl, {
      credentials: 'include',
      cache: 'force-cache',
      headers: { Accept: 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8' }
    });
    if (!response.ok) return null;
    const buffer = await response.arrayBuffer();
    if (!buffer.byteLength || buffer.byteLength > MAX_UPLOAD_BYTES) return null;
    // A 200 is not proof we got a picture: hotlink guards and CDN error pages
    // routinely answer 200 with HTML, and AVIF/SVG/GIF are things the service
    // refuses. Uploading any of those costs a multi-megabyte POST and hands the
    // user a confusing rejection, when returning null instead falls through to
    // the canvas path — which re-encodes what the page already decoded and
    // succeeds. Checking the bytes is the only reliable test; content-type is
    // whatever the server felt like claiming.
    if (!isSupportedImage(buffer)) return null;
    return arrayBufferToBase64(buffer);
  } catch {
    return null;
  }
}

/**
 * Magic-byte sniff for the formats the service accepts (png/jpeg/webp).
 *
 * GIF is excluded on purpose even though it is a real image — an animation has
 * no single page to redraw, so the service rejects it and the canvas fallback
 * flattens it to a PNG frame instead.
 */
function isSupportedImage(buffer) {
  const b = new Uint8Array(buffer);
  if (b.length < 12) return false;
  // PNG: \x89PNG\r\n\x1a\n
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
      b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return true;
  // JPEG: SOI + marker
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return true;
  // WebP: "RIFF" .... "WEBP"
  const ascii = (start, end) => String.fromCharCode(...b.subarray(start, end));
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return true;
  return false;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  // btoa takes a binary string; chunked so a multi-megabyte page does not blow
  // the argument limit of String.fromCharCode.
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export { MAX_UPLOAD_BYTES };
