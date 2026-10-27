// Blab Translation — every link from the extension to the account site.
//
// The site's origin is whatever the service worker is configured with
// (comicClient.getApiBase, answered to pages as ACCOUNT_SITE_BASE). It comes
// out of chrome.storage, so each link is built here and nowhere else: only an
// http(s) base makes one, a path on the base is dropped, and anything else is
// '' rather than a broken link — never `javascript:`, never the relative
// `/app/pricing` of the extension page.
//
// Every link names the entry it was opened from in its query —
// utm_source=extension&utm_medium=<entry> — so the site's own traffic report
// can tell the popup from the settings page. That is the whole of it: a URL
// parameter on a link the user clicked. The extension counts nothing and
// sends nothing (the store listing says "No analytics").
//
// The sign-in handshake (`/ext/connect`, opened by comic-client.js signIn())
// is built here too, tagged `signin` whichever surface started it: the site
// counts where a new account came from by the utm on the page it lands on.
//
// Loaded as a classic script by the pages and imported for its side effect by
// the service worker, so it publishes onto the global object.
(function (root) {
  'use strict';

  // The entries a link can be opened from. A typo'd entry would quietly file
  // its visits under a medium nobody looks for, so an unknown one throws.
  const MEDIUMS = Object.freeze([
    'popup',         // the popup's document rows
    'options',       // the settings page: PDF library, Subscribe, document rows
    'upload',        // the document page's View
    'notification',  // a document notification clicked
    'page',          // a web page's error bar or selection card (Subscribe)
    'pdf_page',      // the PDF tab's own bar: View translation once it is done
    'signin',        // the sign-in tab (/ext/connect), from any surface
    'pdf_quota',     // a document refused for the used-up free pages: the upload
                     // page, the popup's row, the notification (View plans)
    'comic_quota',   // a comic page refused for the same reason, on its overlay
    'comic_summary', // a comic page's chapter pill: Open chapter in reader
  ]);

  /** Throws on an entry the list does not name. Callers that act before they
   *  build a link check first, so a bad entry fails before anything happens. */
  function assertMedium(medium) {
    if (!MEDIUMS.includes(medium)) {
      throw new Error(`SiteLinks: unknown entry ${JSON.stringify(medium)}`);
    }
  }

  /** The base's http(s) origin, or '' for a base that is not a web origin. */
  function origin(base) {
    let url;
    try {
      url = new URL(String(base || ''));
    } catch {
      return '';
    }
    return /^https?:$/.test(url.protocol) ? url.origin : '';
  }

  function siteLink(base, path, medium) {
    assertMedium(medium);
    const site = origin(base);
    if (!site) return '';
    const url = new URL(path, site);
    url.searchParams.set('utm_source', 'extension');
    url.searchParams.set('utm_medium', medium);
    return url.href;
  }

  /** Where subscribing to Blab Translation happens. */
  function pricing(base, medium) {
    return siteLink(base, '/app/pricing', medium);
  }

  /** The account's document list. One job is viewed in the reader instead. */
  function library(base, medium) {
    return siteLink(base, '/app/settings/pdf', medium);
  }

  /**
   * The web reader for one job: `<origin>/app/reader/<id>`. The reader takes a
   * job id as well as an asset id, shows the document, and offers every
   * download, so a finished job of any format is viewed there and nowhere else.
   * '' as well for no id, or a pending record's `local:<operationId>` id, which
   * names no server job. `pageIndex` (a comic chapter's page, 0-based) is the
   * page to open at; anything but a non-negative integer leaves it out.
   */
  function reader(base, jobId, medium, { pageIndex } = {}) {
    if (jobId === undefined || jobId === null || jobId === '') return '';
    const id = String(jobId);
    if (id.startsWith('local:')) return '';
    const link = siteLink(base, '/app/reader/' + encodeURIComponent(id), medium);
    if (!link || !Number.isInteger(pageIndex) || pageIndex < 0) return link;
    const url = new URL(link);
    url.searchParams.set('pageIndex', String(pageIndex));
    return url.href;
  }

  /**
   * The sign-in tab: the site's consent page, which hands a token back to
   * `redirectUri` with `state` echoed. '' for a base that is not a web origin.
   */
  function connect(base, state, redirectUri) {
    const link = siteLink(base, '/ext/connect', 'signin');
    if (!link) return '';
    const url = new URL(link);
    url.searchParams.set('state', state);
    url.searchParams.set('redirect_uri', redirectUri);
    return url.href;
  }

  root.SiteLinks = Object.freeze({ MEDIUMS, assertMedium, origin, pricing, library, reader, connect });
})(globalThis);
