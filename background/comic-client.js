// Blab Translation — Comic translation API client (service worker side)
//
// Comic page translation is the one feature that does NOT use the user's own
// API key: the redraw runs on our servers, draws on a monthly free page
// allowance, and therefore needs a
// signed-in account. Everything account- or job-related lives here so the
// existing BYO-key text translation in background.js stays untouched.
//
// All network calls happen in the service worker on purpose. A content script's
// fetch is subject to the page's CORS policy; the worker's is not, because
// host_permissions covers it. That is also why the worker can read an image
// the server was not allowed to fetch — see uploadPage().

import '../shared/site-links.js';
import { acquire as holdKeepalive, release as dropKeepalive } from './keepalive.js';

const SiteLinks = globalThis.SiteLinks;

// The apex, not an `app.` subdomain: the marketing site and the account/API
// half are one Cloudflare Worker on one origin, so /login and /api/* live here
// too. Keep in sync with PRODUCTION_ORIGIN in translator-saas/server.
//
// blab-translation.com replaced translators-ai.com in the G1 brand migration.
// The old origin keeps serving /api/* untouched (no 301 — a preflight does not
// follow one) for as long as older installs are still out there, so a version
// skew in either direction keeps working.
const DEFAULT_API_BASE = 'https://blab-translation.com';

const STORAGE_KEYS = {
  apiBase: 'comicApiBase',
  token: 'comicToken',
  tokenExpiresAt: 'comicTokenExpiresAt',
  account: 'comicAccountCache'
};

// The server refuses anything larger before it charges anything, so there is no
// point uploading it. Kept in sync with MAX_SOURCE_BYTES on the server.
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

// A page is at most MAX_UPLOAD_BYTES; one that has not reached storage in 30 s
// is not going to, and a service worker held open longer risks being killed
// mid-request, which would leave the user watching a job that never started.
const UPLOAD_TIMEOUT_MS = 30_000;

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
  const authUrl = SiteLinks.connect(base, state, redirectUri);
  if (!authUrl) throw new ComicApiError('sign_in_failed', `The account site address is not a web origin: ${base}`);

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

// Exported for pdf-client.js and blab-client.js, which ride the same account,
// token and error model rather than duplicating them. `signal` aborts the fetch
// (blab-client passes callModel's per-attempt one); an abort surfaces as
// network_error here, and the caller that owns the signal tells the two apart.
export async function apiFetch(path, { method = 'GET', body = null, signal } = {}) {
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
      body: body ? JSON.stringify(body) : undefined,
      signal
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

/**
 * The last /api/billing/me answer stored on this device, `{ fetchedAt, account }`,
 * or null. No request: blab-client.js reads it to learn that the account was
 * judged again since it last refused (a subscription bought in between).
 */
export async function getCachedAccount() {
  const cached = await chrome.storage.local.get({ [STORAGE_KEYS.account]: null });
  return cached[STORAGE_KEYS.account];
}

/** Sign-in state and the monthly free page allowance in one call. */
export async function getAccount({ force = false } = {}) {
  if (!(await getToken())) return { signedIn: false };
  const entry = await getCachedAccount();
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
 * Put one page where the service can read it. Returns `{ sourceKey }`.
 *
 * The service is never handed a page's address to go fetch, and the bytes
 * never pass through its API: the worker asks for a single-page ticket
 * (`POST /api/comic/uploads`) and PUTs the image straight to the presigned URL
 * in it. Acquiring the bytes is the extension's job and has two rungs:
 *
 *  1. `imageUrl`: here in the worker, which carries the user's cookies for the
 *     site and is exempt from CORS by host_permissions, so it reaches
 *     login-gated CDNs;
 *  2. failing that, `needs_page_bytes` sends the content script for the pixels
 *     the page already decoded, and it comes back with `pageBytes` (a data
 *     URL) — the only way to read a `blob:`/`data:` src.
 *
 * Nothing is requested before rung 1 has the bytes, so a page the worker
 * cannot read costs no ticket. The token is checked before anything is
 * downloaded: a signed-out click — the common first one — must not pull a
 * multi-megabyte page for nothing.
 */
export async function uploadPage({ operationId, imageUrl, pageBytes }) {
  if (!(await getToken())) {
    throw new ComicApiError('unauthorized', 'Sign in to translate comic pages', 401, { loginRequired: true });
  }

  let page;
  if (pageBytes) {
    page = decodePageBytes(pageBytes);
    if (!page) throw new ComicApiError('image_unreadable', 'The page could not be read as an image');
  } else {
    page = imageUrl ? await fetchPageBytes(imageUrl) : null;
    if (!page) {
      // The cap travels with the request, so the page re-encodes against the
      // same number this worker enforces rather than a copy of it.
      throw new ComicApiError('needs_page_bytes', 'The worker could not read the image', 0, {
        needsPageBytes: true,
        maxBytes: MAX_UPLOAD_BYTES
      });
    }
  }

  const issued = await apiFetch('/api/comic/uploads', {
    method: 'POST',
    body: { operationId, pages: [{ index: 0, format: page.format, byteSize: page.bytes.byteLength }] }
  });
  const ticket = Array.isArray(issued?.tickets) ? issued.tickets.find((t) => t?.index === 0) : null;
  if (!ticket || !nonEmptyString(ticket.sourceKey) || !nonEmptyString(ticket.uploadUrl) ||
      !nonEmptyString(ticket.contentType)) {
    throw new ComicApiError('upload_failed', 'The service returned no usable upload ticket');
  }
  await putPresigned(ticket.uploadUrl, page.bytes, {
    contentType: ticket.contentType,
    operationId,
    label: 'comic',
    timeoutMs: UPLOAD_TIMEOUT_MS
  });
  return { sourceKey: ticket.sourceKey };
}

/**
 * Start a redraw of a page uploadPage() put in storage. Returns the 202 body:
 * `{ jobId, status, quote }`.
 *
 * `pageUrl` is the chapter: every page translated off one address lands in one
 * document, ordered by `pageIndex` (the page's place among the comic pages in
 * the DOM, not the order they were clicked), and `pageId` names the page, so
 * translating it again replaces that page rather than adding one.
 *
 * `operationId` is the idempotency key — re-posting the same one returns the
 * existing job instead of counting the page twice, which is what makes a retry
 * after a dropped connection safe.
 *
 * `confirmCharge` is D9's answer to "this will spend credits, is that alright".
 * The server refuses an unconfirmed job that costs credits with a 409 carrying
 * its quote, which apiFetch surfaces as a ComicApiError with
 * code `QUOTE_CONFIRM_REQUIRED` and the quote in its details; the caller shows
 * the quote and comes back through here with the SAME operationId, the same
 * `sourceKey` and `confirmCharge: true`. That 409 reserves nothing and the
 * retry is the same operation, so the round trip cannot charge twice. Deciding
 * to ask is not this layer's job — the confirmation UI is, and has to be, on
 * the surface the user is looking at. See shared/comic-charge.js.
 */
export function createJob({ operationId, sourceKey, pageUrl, pageTitle, pageIndex, pageId, targetLang, mode, confirmCharge }) {
  if (!nonEmptyString(sourceKey)) throw new Error('createJob needs the sourceKey uploadPage() returned');
  return apiFetch('/api/comic/jobs', {
    method: 'POST',
    body: {
      operationId: operationId || crypto.randomUUID(),
      sourceKey,
      pageUrl: pageUrl || null,
      // What the library row is called. The page's own title, because an <img>
      // off a live page has no file name, and the address's last segment (what
      // the server fell back to) is a chapter id or, in the web reader, an
      // asset id. The server trims and caps it.
      pageTitle: pageTitle || null,
      pageIndex,
      pageId,
      targetLang: targetLang || 'zh-CN',
      // What the redraw does to the page: translate (default), colorize, or
      // translate_colorize. Validated server-side.
      mode: mode || 'translate',
      // Sent only to say yes. Absent is the server's default and already means
      // "not confirmed", so an unconfirmed create carries no claim at all.
      ...(confirmCharge === true ? { confirmCharge: true } : {})
    }
  });
}

export function getJob(jobId) {
  return apiFetch(`/api/comic/jobs/${encodeURIComponent(jobId)}`);
}

/**
 * Open document `id` in the site's reader, tagged with the entry `via` it was
 * opened from (SiteLinks.MEDIUMS); `options` go to SiteLinks.reader. Both
 * readers go through here: a finished document job, and the comic page's
 * chapter pill (`id` is the chapter document every page job of the chapter
 * reports, at `{ pageIndex }`). A base that yields no reader URL (a stored
 * override that is not http(s), or no id) is an error, not a quiet detour.
 */
export async function openReaderTab(id, via, options) {
  const url = SiteLinks.reader(await getApiBase(), id, via, options);
  if (!url) {
    throw new ComicApiError('invalid_site_base', 'The account site base is not an http(s) URL, or the document has no id', 0);
  }
  await chrome.tabs.create({ url });
}

export function abandonJob(jobId) {
  return apiFetch(`/api/comic/jobs/${encodeURIComponent(jobId)}/abandon`, { method: 'POST' });
}

// ---------------------------------------------------------------------------
// Image acquisition and the presigned PUT
// ---------------------------------------------------------------------------

/**
 * PUT bytes to a presigned storage URL. No bearer token: the signature in the
 * URL is the entire authorization. The one implementation behind both the
 * comic page upload and the document upload (pdf-client.js).
 *
 * `timeoutMs` (0 = none) aborts the PUT and throws `upload_timeout` — an
 * explicit failure, never a quiet retry down some other path. The log line
 * carries the status and the operation id and nothing else — the URL is a
 * credential for as long as it lives, and a storage error body can echo it
 * back.
 */
export async function putPresigned(uploadUrl, body, { contentType, operationId, label, timeoutMs = 0 }) {
  // A fetch in flight is not activity to Chrome: without a hold, a PUT that
  // runs past the worker's idle limit dies with the worker, and the page waits
  // on a job that will never be created.
  holdKeepalive();
  try {
    const controller = timeoutMs > 0 ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : 0;
    let response;
    try {
      response = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'content-type': contentType },
        body,
        signal: controller?.signal
      });
    } catch (error) {
      if (controller?.signal.aborted) {
        console.warn(`[${label}] presigned PUT timed out after ${timeoutMs} ms op=${operationId}`);
        throw new ComicApiError('upload_timeout', `The upload did not finish within ${timeoutMs / 1000} s`);
      }
      console.warn(`[${label}] presigned PUT failed: network op=${operationId}`);
      throw new ComicApiError('upload_failed', error?.message || 'The upload failed');
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      console.warn(`[${label}] presigned PUT failed: HTTP ${response.status} op=${operationId}`);
      throw new ComicApiError('upload_failed', `The upload failed (HTTP ${response.status})`, response.status);
    }
  } finally {
    dropKeepalive();
  }
}

/**
 * Fetch the image from the worker: `{ bytes, format }`, or null when the
 * worker cannot get a picture the service accepts.
 *
 * `credentials: 'include'` is the point of this path: a page behind a login
 * serves its images only to a cookie-bearing request. `force-cache` normally
 * makes this free — the page just displayed this image, so the bytes are in the
 * HTTP cache. Referer is a forbidden header for fetch, so a strict hotlink
 * check is not something this path can beat; that case falls through to the
 * content script, which sends the pixels the page already decoded.
 */
async function fetchPageBytes(imageUrl) {
  // Only http(s) is fetchable from here. A blob:/data: src belongs to the page's
  // own context and is the content script's to read.
  if (!/^https?:/i.test(imageUrl)) return null;
  let buffer;
  try {
    const response = await fetch(imageUrl, {
      credentials: 'include',
      cache: 'force-cache',
      headers: { Accept: 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8' }
    });
    if (!response.ok) return null;
    buffer = await response.arrayBuffer();
  } catch (error) {
    // Not swallowed: null is the answer that sends the content script for the
    // decoded pixels, the second rung.
    console.warn(`[comic] worker fetch of the page failed (${error?.message || error}); asking the page`);
    return null;
  }
  // A 200 is not proof we got a picture: hotlink guards and CDN error pages
  // routinely answer 200 with HTML, and AVIF/SVG/GIF are things the service
  // refuses. Uploading any of those costs a multi-megabyte PUT and hands the
  // user a confusing rejection, when returning null instead falls through to
  // the canvas path — which re-encodes what the page already decoded and
  // succeeds. Checking the bytes is the only reliable test; content-type is
  // whatever the server felt like claiming.
  return acceptedPage(new Uint8Array(buffer));
}

/** The content script's canvas capture, a `data:image/...;base64,` URL. */
function decodePageBytes(dataUrl) {
  const match = /^data:image\/[a-z]+;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl));
  if (!match) return null;
  const binary = atob(match[1]);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return acceptedPage(bytes);
}

/**
 * `{ bytes, format }` for a picture the service accepts, null for bytes that
 * are not one (the next rung may still get one). Too large is an answer of its
 * own and throws: the canvas would only re-encode the same page, and the
 * service refuses it before charging anything.
 */
function acceptedPage(bytes) {
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    throw new ComicApiError('image_too_large', `The page is ${bytes.byteLength} bytes; the limit is ${MAX_UPLOAD_BYTES}`, 0, {
      maxBytes: MAX_UPLOAD_BYTES
    });
  }
  if (!bytes.byteLength) return null;
  const format = imageFormat(bytes);
  return format ? { bytes, format } : null;
}

/**
 * Magic-byte sniff for the formats the service accepts: 'png' | 'jpeg' |
 * 'webp', or null.
 *
 * GIF is excluded on purpose even though it is a real image — an animation has
 * no single page to redraw, so the service rejects it and the canvas fallback
 * flattens it to a PNG frame instead.
 */
function imageFormat(b) {
  if (b.length < 12) return null;
  // PNG: \x89PNG\r\n\x1a\n
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
      b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'png';
  // JPEG: SOI + marker
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  // WebP: "RIFF" .... "WEBP"
  const ascii = (start, end) => String.fromCharCode(...b.subarray(start, end));
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp';
  return null;
}

export function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

export { MAX_UPLOAD_BYTES };
