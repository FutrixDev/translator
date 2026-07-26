// AI Translator — Comic translation API client (service worker side)
//
// Comic page translation is the one feature that does NOT use the user's own
// API key: the redraw runs on our servers, costs credits, and therefore needs a
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

/** The stored token, or null when absent or expired. */
export async function getToken() {
  const stored = await chrome.storage.local.get({
    [STORAGE_KEYS.token]: '',
    [STORAGE_KEYS.tokenExpiresAt]: 0
  });
  const token = stored[STORAGE_KEYS.token];
  const expiresAt = Number(stored[STORAGE_KEYS.tokenExpiresAt]) || 0;
  if (!token) return null;
  // The server slides the expiry on every use, so a token in active use never
  // reaches this branch; one that does is genuinely stale.
  if (expiresAt && expiresAt <= Date.now()) {
    await clearToken();
    return null;
  }
  return { token, expiresAt };
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
 * Opens the hosted consent page and exchanges it for a bearer token.
 *
 * launchWebAuthFlow gives us a redirect target that only this extension can
 * receive (`https://<extension-id>.chromiumapp.org/`), and the server issues the
 * token into that URL's FRAGMENT — so the credential is never sent to any
 * server on the way back. The provider choice (Google or GitHub) happens on the
 * web page; the extension never handles the OAuth itself.
 */
export async function signIn() {
  const base = await getApiBase();
  const redirectUri = chrome.identity.getRedirectURL();
  const state = crypto.randomUUID();
  const authUrl = `${base}/ext/connect?state=${encodeURIComponent(state)}&redirect_uri=${encodeURIComponent(redirectUri)}`;

  let finalUrl;
  try {
    finalUrl = await chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true });
  } catch (error) {
    const message = error?.message || String(error);
    // Chrome reports a closed window and a real failure the same way; treat the
    // user closing the tab as a cancel rather than an error to shout about.
    if (/user|cancel|closed/i.test(message)) {
      throw new ComicApiError('sign_in_cancelled', message);
    }
    throw new ComicApiError('sign_in_failed', message);
  }

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

async function apiFetch(path, { method = 'GET', body = null } = {}) {
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
    throw new ComicApiError(error || `http_${response.status}`, message || '', response.status, details);
  }

  return data;
}

/** Balance, free-trial state and the pack catalog in one call. */
export async function getAccount({ force = false } = {}) {
  if (!(await getToken())) return { signedIn: false };
  const cached = await chrome.storage.local.get({ [STORAGE_KEYS.account]: null });
  const entry = cached[STORAGE_KEYS.account];
  // A 30s cache keeps the popup and the options page from re-querying on every
  // open; anything that spends or adds credits passes force.
  if (!force && entry && Date.now() - entry.fetchedAt < 30_000) {
    return { signedIn: true, ...entry.account };
  }

  const account = await apiFetch('/api/billing/me');
  await chrome.storage.local.set({
    [STORAGE_KEYS.account]: { fetchedAt: Date.now(), account }
  });
  return { signedIn: true, ...account };
}

export async function getRechargeUrl() {
  return `${await getApiBase()}/billing`;
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
 * existing job instead of reserving credits twice, which is what makes a retry
 * after a dropped connection safe.
 */
export async function createJob({ operationId, imageUrl, pageUrl, imageBase64, sourceLang, targetLang }) {
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
      targetLang: targetLang || 'zh-CN'
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
    return arrayBufferToBase64(buffer);
  } catch {
    return null;
  }
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
