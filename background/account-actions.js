// Blab Translation background — the way out of an account refusal.
//
// Every account-backed surface (a page's error bar, the selection card, the
// comic overlay, the document page, the popup, a notification) draws the same
// button for the same refusal: "Sign in" when no one is signed in, "View plans"
// when the account has run out of what it pays with. Which refusal gets which
// button is written once, in ACCOUNT_ACTIONS; the surfaces only draw
// `error.action` and send it back as BLAB_ACCOUNT_ACTION.

import '../shared/quota-copy.js';
import '../shared/site-links.js';
import * as comicClient from './comic-client.js';
import { noteAccountAction } from './blab-client.js';

/**
 * Refusal code -> the entry that fixes it. Blab Translation's own codes
 * (`plan_required`, `unauthorized`) and the page allowance's refusals
 * (`QuotaCopy.REFUSALS`, shared/quota-copy.js) share one table. Today's Blab
 * allowance (`daily_limit`) has nothing to press — it comes back by itself.
 */
const ACCOUNT_ACTIONS = Object.freeze({
  plan_required: 'subscribe',
  unauthorized: 'signin',
  ...Object.fromEntries(globalThis.QuotaCopy.REFUSALS.map(code => [code, 'subscribe'])),
});

/** The entry for a refusal code, or undefined when there is none. */
function accountActionFor(code) {
  return Object.prototype.hasOwnProperty.call(ACCOUNT_ACTIONS, code) ? ACCOUNT_ACTIONS[code] : undefined;
}

/**
 * Run an entry a surface sent back. "Subscribe" opens the pricing page tagged
 * with the surface it came from; "Sign in" runs the popup's sign-in. A page
 * cannot build the pricing link itself: the account site's origin lives here.
 */
async function runAccountAction(action, via) {
  if (action !== 'signin' && action !== 'subscribe') {
    throw new Error(`BLAB_ACCOUNT_ACTION: unknown action ${JSON.stringify(action)}`);
  }
  if (action === 'subscribe') globalThis.SiteLinks.assertMedium(via);
  // The user went to fix the account: the next request asks billing/me again
  // before the latch refuses it (blab-client.js). Written to session storage
  // before the entry opens, so the worker being recycled while the user is on
  // the site does not lose it.
  await noteAccountAction();
  if (action === 'signin') return comicClient.signIn();
  const base = await comicClient.getApiBase();
  const url = globalThis.SiteLinks.pricing(base, via);
  if (!url) throw new Error(`BLAB_ACCOUNT_ACTION: no pricing page for the account site ${JSON.stringify(base)}`);
  await chrome.tabs.create({ url });
  return { opened: url };
}

/**
 * What a used-up allowance can say beyond the refusal itself: when the free
 * pages come back (`resetsAt`, from billing/me) and the smallest plan allowance
 * above the free one (`planPages`, from the public rates). Neither number is
 * written in the extension, so a price change reaches the copy without a
 * release.
 *
 * Each half is an addition to a refusal that is already complete, so a lookup
 * that fails is logged once and its half left out; the refusal and its button
 * still reach the user.
 */
async function quotaOffer(operation) {
  const [account, rates] = await Promise.allSettled([
    comicClient.getAccount({ force: true }),
    comicClient.apiFetch('/api/billing/rates'),
  ]);
  const offer = {};
  let freeLimit = null;
  if (account.status === 'fulfilled') {
    const quota = account.value.freeQuotas?.[operation];
    if (quota?.resetsAt) offer.resetsAt = quota.resetsAt;
    if (Number.isFinite(quota?.limit)) freeLimit = quota.limit;
  } else {
    console.warn(`[quota] billing/me for ${operation} failed; the refusal goes out without a reset date:`, account.reason);
  }
  if (rates.status === 'fulfilled') {
    const above = Object.values(rates.value.planQuotas || {})
      .map(plan => plan?.[operation])
      .filter(pages => Number.isFinite(pages) && (freeLimit === null || pages > freeLimit));
    if (above.length) offer.planPages = Math.min(...above);
  } else {
    console.warn(`[quota] billing/rates for ${operation} failed; the refusal goes out without a plan allowance:`, rates.reason);
  }
  return offer;
}

/**
 * Any error from the account client, as the plain object a message reply or a
 * notification carries: the code and the server's fields, the entry that fixes
 * it (`action`), and for a used-up allowance the reset date and plan allowance.
 * An Error does not survive chrome.runtime messaging, and the surfaces decide
 * purely from `code`.
 */
async function accountErrorMessage(error) {
  if (!(error instanceof comicClient.ComicApiError)) {
    return { code: 'internal_error', message: error?.message || String(error) };
  }
  const message = error.toMessage().error;
  const action = accountActionFor(message.code);
  if (action) message.action = action;
  if (globalThis.QuotaCopy.isRefusal(message.code) && message.quote?.operation) {
    Object.assign(message, await quotaOffer(message.quote.operation));
  }
  return message;
}

export { ACCOUNT_ACTIONS, accountActionFor, runAccountAction, accountErrorMessage };
