// Blab Translation 设置页 —— 账号
//
// options.html 按顺序加载的普通脚本，和 options.js 共用同一个全局词法作用域：
// 这里声明的函数在 options.js 里直接叫名字就能用，反过来也一样（调用发生在
// DOMContentLoaded 之后，声明早就求值完了）。

// ---------------------------------------------------------------------------
// Account
//
// Separate from every other setting on this page: it is a server-side account,
// not something stored in chrome.storage.sync, so it loads over the network and
// its buttons act immediately instead of on Save. Comic and PDF translation
// share it — one sign-in, one monthly free allowance per feature.
// ---------------------------------------------------------------------------

function showComicState(name) {
  elements.comicAccountLoading.classList.toggle('hidden', name !== 'loading');
  elements.comicSignedOut.classList.toggle('hidden', name !== 'signedOut');
  elements.comicSignedIn.classList.toggle('hidden', name !== 'signedIn');
}

/**
 * Whether this device has an account: true, false, or null while the answer is
 * outstanding or the service could not be reached.
 *
 * Three states rather than two because the two feature switches render from it.
 * Collapsing "not answered yet" into "signed out" would flash both switches off
 * on every load for the signed-in majority; collapsing it into "signed in"
 * would show a signed-out user a switch that is about to retract. Unknown
 * renders the stored preference and corrects itself, which for a signed-out
 * device is a message round-trip — getAccount() answers `{signedIn: false}` off
 * the local token without touching the network.
 */
let comicSignedIn = null;

/** The initial account fetch, so the sign-in gate can wait on it instead of
 *  reading a `comicSignedIn` that has not been answered yet. Never rejects. */
let comicAccountReady = Promise.resolve();

/** Bumped by sign-in and sign-out, which decide this device's state outright.
 *  A read that was already on the wire when one of them happened is answering
 *  a question about the account that was; it is dropped rather than allowed to
 *  paint a signed-in panel over a sign-out the user just asked for. */
let comicAccountGeneration = 0;

/** The sign-in flow currently running, shared by both switches' gates. */
let comicSignInInFlight = null;

/**
 * The stored preference behind each account-backed switch, kept apart from what
 * the checkbox shows.
 *
 * These two are the only settings on the page whose displayed state is not
 * simply what storage says: both features run on our servers against a monthly
 * allowance, so a device with no account cannot have them on however the
 * preference arrived — and it arrives on every new install, because the
 * switches sync and the token does not.
 *
 * The preference itself is left alone rather than corrected. Writing false from
 * a signed-out device would sync back and turn the feature off on the device
 * that is still signed in, which is not what "sign out here" asked for. See
 * shared/account-gate.js, which derives the same answer for every other
 * surface.
 */
let storedComicEnabled = false;
let storedPdfEnabled = false;

/**
 * Draw the two switches from preference AND account.
 *
 * Called on load and on every account transition, so the switches can never sit
 * on for a feature this device cannot run. `comicSignedIn === null` means the
 * answer is still outstanding — see the declaration.
 */
function renderAccountFeatures() {
  const comicOn = storedComicEnabled && comicSignedIn !== false;
  const pdfOn = storedPdfEnabled && comicSignedIn !== false;
  elements.enableComicTranslation.checked = comicOn;
  elements.comicTargetLang.disabled = !comicOn;
  elements.enablePdfTranslation.checked = pdfOn;
  elements.pdfTargetLang.disabled = !pdfOn;
  syncPdfTasksVisibility(pdfOn);
}

/** Pages left this month for one operation. Older servers report only the comic
 *  allowance, at the top level and under its pre-PDF name. */
function freePagesLeft(account, operation) {
  const quota = account.freeQuotas?.[operation] ?? (operation === 'comic_page' ? account.freeQuota : null);
  return quota?.remaining ?? 0;
}

function formatResetDate(account) {
  const iso = account.freeQuotas?.comic_page?.resetsAt ?? account.freeQuota?.resetsAt;
  if (!iso) return '—';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '—';
  return at.toLocaleDateString(currentUILang, { month: 'short', day: 'numeric' });
}

/**
 * `quiet` is for refreshes the user did not ask for (see the visibilitychange
 * handler in setupEventListeners): no loading flash on the way in, and a
 * failure leaves the numbers that are already on screen rather than replacing
 * a readable panel with an error the user never provoked.
 */
async function refreshComicAccount({ force = false, quiet = false } = {}) {
  // Asked for unconditionally, unlike before: both features now require an
  // account, so the panel is the only way to get one and has to be readable
  // even with both switches off.
  const generation = comicAccountGeneration;
  if (!quiet) showComicState('loading');
  const response = await chrome.runtime.sendMessage({ type: 'COMIC_ACCOUNT', force });
  // Signed in or out while this was on the wire: the answer is about an account
  // the user has already moved on from, and every branch below would paint it.
  if (generation !== comicAccountGeneration) return;

  if (!response || !response.ok) {
    // A token that the server has since revoked comes back as unauthorized;
    // the honest answer to that is "signed out", not an error. Worth showing
    // even on a quiet pass — the panel would otherwise keep offering an
    // account that is gone.
    if (response && response.error && response.error.code === 'unauthorized') {
      comicSignedIn = false;
      renderAccountFeatures();
      showComicState('signedOut');
      return;
    }
    if (quiet) return;
    // Unreachable, not signed out. The switches keep showing the preference
    // rather than retracting on a service outage the user did not cause; the
    // gate still asks for a sign-in before either can be turned on.
    comicSignedIn = null;
    elements.comicAccountLoading.textContent = t('comicAccountError');
    showComicState('loading');
    return;
  }

  showAccount(response.data);
}

/** Put a fetched account on screen. Returns whether it is a signed-in one. */
function showAccount(account) {
  if (!account.signedIn) {
    comicSignedIn = false;
    renderAccountFeatures();
    showComicState('signedOut');
    return false;
  }

  comicSignedIn = true;
  renderAccountFeatures();
  elements.comicEmail.textContent = account.user?.email || account.user?.name || '';
  // Pages left this month, per feature: the product is free, so a balance would
  // be answering a question nobody is asking.
  elements.comicPagesRemaining.textContent = freePagesLeft(account, 'comic_page');
  elements.pdfPagesRemaining.textContent = freePagesLeft(account, 'pdf_page');
  elements.freeQuotaReset.textContent = formatResetDate(account);
  showComicState('signedIn');
  return true;
}

/**
 * Sign in, or join the sign-in already running.
 *
 * Both switches are live while signed out, so turning them on in quick
 * succession sends two gates here. Two independent flows would open two
 * authentication tabs, and the second to finish would overwrite the first: a
 * cancelled one landing after a successful one renders the signed-out panel
 * with a valid token in storage. One flow, one answer, both callers.
 */
function comicSignIn() {
  if (!comicSignInInFlight) {
    comicSignInInFlight = runComicSignIn().finally(() => { comicSignInInFlight = null; });
  }
  return comicSignInInFlight;
}

async function runComicSignIn() {
  // This decides the account outright, so any read already on the wire is stale
  // from here on — including the one this replaces.
  comicAccountGeneration += 1;
  showComicState('loading');
  elements.comicAccountLoading.textContent = t('comicSigningIn');
  const response = await chrome.runtime.sendMessage({ type: 'COMIC_SIGN_IN' });
  elements.comicAccountLoading.textContent = t('comicAccountLoading');

  if (!response || !response.ok) {
    comicSignedIn = false;
    renderAccountFeatures();
    if (response?.error?.code !== 'sign_in_cancelled') {
      showStatus(response?.error?.message || t('comicSignInFailed'), 'error');
    }
    showComicState('signedOut');
    return false;
  }
  // Rendered from what sign-in already fetched: the worker saved the token and
  // returned the account in the same call. Asking again would be a second
  // round-trip whose transient failure would read as "not signed in" — clearing
  // the checkbox and demanding an account the user just successfully created.
  return showAccount(response.data);
}

async function comicSignOut() {
  comicAccountGeneration += 1;
  await chrome.runtime.sendMessage({ type: 'COMIC_SIGN_OUT' });
  comicSignedIn = false;
  // Both switches go off with the token: neither feature can run on a device
  // with no account, so leaving one on would be a switch that promises a
  // sign-in prompt rather than a translation.
  //
  // The stored preference behind them is deliberately NOT written off. It lives
  // in sync storage while the token lives in local, so clobbering it here would
  // reach across to every other device the account is still signed in on and
  // disable the feature there — a sign-out is about this device's credential,
  // nothing more. Signing back in restores what the user had.
  renderAccountFeatures();
  showComicState('signedOut');
}

/**
 * Gate for the two Advanced Settings switches: turning one ON requires an
 * account, so an unauthenticated user gets the sign-in flow instead, and the
 * switch snaps back if they cancel or it fails.
 *
 * Turning one OFF is never gated — a user who cannot sign in must still be able
 * to put the setting back the way it was.
 */
async function requireAccountFor(checkbox) {
  if (!checkbox.checked) return true;
  // The switches are live from the first paint, while the account request is
  // still on the wire and `comicSignedIn` is merely at its initial null. A
  // click landing in that window would open an authentication tab at someone
  // who is already signed in, so wait for the answer before believing it.
  await comicAccountReady;
  if (comicSignedIn) return true;
  const signedIn = await comicSignIn();
  if (!signedIn) {
    // Back to preference-AND-account, which with no account is off. The failed
    // sign-in itself has already rendered that; this covers the checkbox the
    // user just clicked in the same pass.
    renderAccountFeatures();
    showStatus(t('accountRequired'), 'error');
  }
  return signedIn;
}
