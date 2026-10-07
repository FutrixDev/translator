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
 * Three states rather than two because the line under each switch reads from
 * it. Collapsing "not answered yet" into "signed out" would flash "takes effect
 * once you sign in" on every load for the signed-in majority; unknown draws as
 * signed in and corrects itself, which for a signed-out device is a message
 * round-trip — getAccount() answers `{signedIn: false}` off the local token
 * without touching the network.
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
 * The stored preference behind each account-backed switch.
 *
 * The switch shows this preference whether or not the device is signed in, and
 * says so when it is on with no account behind it ("takes effect once you sign
 * in"). A signed-out user must be able to see the setting in order to turn it
 * off: the preference is what decides whether the PDF and comic hints appear
 * on pages (shared/account-gate.js), and both features ship switched on.
 *
 * Only turning a switch ON asks for an account (requireAccountFor). Turning it
 * off writes false straight away, signed in or not.
 */
let storedComicEnabled = false;
let storedPdfEnabled = false;

/**
 * Draw the two switches from the stored preference, and the account state
 * under them. Called on load and on every account transition.
 */
function renderAccountFeatures() {
  renderBlabEngine();
  renderAccountFeature('enableComicTranslation', storedComicEnabled, {
    toggle: elements.enableComicTranslation,
    lang: elements.comicTargetLang,
    pending: elements.comicSignInPending,
  });
  const pdf = renderAccountFeature('enablePdfTranslation', storedPdfEnabled, {
    toggle: elements.enablePdfTranslation,
    lang: elements.pdfTargetLang,
    pending: elements.pdfSignInPending,
  });
  // The task list belongs to the account: it is shown only when the feature can
  // actually run here.
  syncPdfTasksVisibility(pdf === AccountGate.FEATURE_STATES.READY);
}

/**
 * One switch, in the three states every surface takes from
 * AccountGate.featureState(). An outstanding account check
 * (`comicSignedIn === null`) is drawn as signed in, so the signed-in majority
 * never sees the "sign in" line flash on load.
 */
function renderAccountFeature(key, stored, { toggle, lang, pending }) {
  const state = AccountGate.featureState({ [key]: stored }, key, comicSignedIn !== false);
  const on = state !== AccountGate.FEATURE_STATES.OFF;
  toggle.checked = on;
  lang.disabled = !on;
  pending.hidden = state !== AccountGate.FEATURE_STATES.SIGNED_OUT;
  return state;
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
  rememberBlabAccount(account);
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
 * The account card's Sign in, and the two switches' gate: sign in, or join the
 * sign-in already running. It takes no argument because it is wired straight
 * to a click (options.js), and a listener's first argument is the event.
 */
function comicSignIn() {
  return signInWith({ type: 'COMIC_SIGN_IN' });
}

/**
 * The one sign-in flow every entry on this page shares. `message` is what the
 * entry sends: COMIC_SIGN_IN here, or the Blab Translation note's account entry
 * (blabSignIn in options-blab.js). Never wire this to an event directly.
 *
 * Both switches are live while signed out, so turning them on in quick
 * succession sends two gates here, and the card and the note can be clicked
 * together. Two independent flows would open two authentication tabs, and the
 * second to finish would overwrite the first: a cancelled one landing after a
 * successful one renders the signed-out panel with a valid token in storage.
 * One flow, one answer, every caller; a caller that joins sends nothing of its
 * own (D-501: the card's sign-in does not record the Blab click either).
 */
function signInWith(message) {
  if (!comicSignInInFlight) {
    comicSignInInFlight = runComicSignIn(message).finally(() => { comicSignInInFlight = null; });
  }
  return comicSignInInFlight;
}

/** Both messages answer with the account sign-in got. */
async function runComicSignIn(message) {
  // This decides the account outright, so any read already on the wire is stale
  // from here on — including the one this replaces.
  comicAccountGeneration += 1;
  showComicState('loading');
  elements.comicAccountLoading.textContent = t('comicSigningIn');
  const response = await chrome.runtime.sendMessage(message);
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
  // The switches keep their position and say they wait for a sign-in. The
  // stored preference is deliberately NOT written off: it lives in sync storage
  // while the token lives in local, so clobbering it here would reach across to
  // every other device the account is still signed in on and disable the
  // feature there — a sign-out is about this device's credential, nothing more.
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
    // Back to the stored preference, which the click has not changed. The
    // failed sign-in itself has already rendered that; this covers the checkbox
    // the user just clicked in the same pass.
    renderAccountFeatures();
    showStatus(t('accountRequired'), 'error');
  }
  return signedIn;
}
