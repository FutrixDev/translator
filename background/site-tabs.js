/**
 * The one way the worker opens a page of the account site: the reader, the
 * document library, the pricing page, the feedback form.
 *
 * The extension's token outlives the site's own session cookie, so a reader who
 * works through the extension would otherwise land on a sign-in page for the
 * document they just translated. Before the tab opens, the site is asked to
 * sign this browser in as the extension's account (POST /api/ext/web-session):
 * a credentialed fetch from the extension to a host it has permission for
 * stores the reply's Set-Cookie in the browser's own cookie jar. A browser
 * already signed in to the site keeps its session, whichever account it is.
 */
import '../shared/site-links.js';
import * as comicClient from './comic-client.js';

const SiteLinks = globalThis.SiteLinks;

/** Each page's link, from the site base, the entry `via` and its options. */
const PAGES = Object.freeze({
  reader: (base, via, { id, pageIndex } = {}) => SiteLinks.reader(base, id, via, { pageIndex }),
  library: (base, via) => SiteLinks.library(base, via),
  pricing: (base, via) => SiteLinks.pricing(base, via),
  feedback: (base, via) => SiteLinks.feedback(base, via),
});

/**
 * Open site page `page` (a key of PAGES) tagged with the entry `via` it was
 * opened from (SiteLinks.MEDIUMS). The reader takes `{ id, pageIndex }`: a
 * document job, or a comic chapter's document at that page. A base that yields
 * no link (a stored override that is not http(s), or no id) is an error, not a
 * quiet detour.
 */
export async function openSitePage(page, via, options) {
  const build = PAGES[page];
  if (!build) throw new Error(`openSitePage: unknown page ${JSON.stringify(page)}`);
  const url = build(await comicClient.getApiBase(), via, options);
  if (!url) {
    throw new comicClient.ComicApiError('invalid_site_base', 'The account site base is not an http(s) URL, or the document has no id', 0);
  }
  await signInSite();
  await chrome.tabs.create({ url });
  return { opened: url };
}

// The reader clicked and is waiting for a tab; a site that does not answer
// must not hold it back for longer than this.
const SIGN_IN_TIMEOUT_MS = 5000;

/**
 * The tab opens whether or not this works: failing leaves the page at its own
 * sign-in, which is where it would have been without this step. The failure
 * stops here, so it is logged here. Signed out, there is nothing to sign in as.
 *
 * `other_account` is not a failure but is worth a line: the browser is signed
 * in to the site as someone else, so the page will show that account's
 * documents rather than the extension's.
 */
async function signInSite() {
  if (!(await comicClient.getToken())) return;
  try {
    const reply = await comicClient.apiFetch('/api/ext/web-session', {
      method: 'POST',
      credentials: 'include',
      signal: AbortSignal.timeout(SIGN_IN_TIMEOUT_MS),
    });
    if (reply?.outcome === 'other_account') {
      console.warn('Blab Translation: the site is signed in to another account; leaving it as it is');
    }
  } catch (error) {
    console.warn('Blab Translation: signing the site in failed:', error?.code || error?.message || error);
  }
}
