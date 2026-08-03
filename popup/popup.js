// DOM Elements
const elements = {
  translatePage: document.getElementById('translatePage'),
  toggleFloatBall: document.getElementById('toggleFloatBall'),
  toggleYoutubeCaptions: document.getElementById('toggleYoutubeCaptions'),
  openSettings: document.getElementById('openSettings'),
  comicAccount: document.getElementById('comicAccount'),
  comicTranslatePage: document.getElementById('comicTranslatePage'),
  comicColorizePage: document.getElementById('comicColorizePage'),
  comicAccountStatus: document.getElementById('comicAccountStatus'),
  pdfTranslateCurrent: document.getElementById('pdfTranslateCurrent'),
  pdfTranslateLocal: document.getElementById('pdfTranslateLocal'),
  pdfJobs: document.getElementById('pdfJobs'),
  floatBallStatus: document.getElementById('floatBallStatus'),
  youtubeCaptionsStatus: document.getElementById('youtubeCaptionsStatus'),
  statusText: document.getElementById('statusText')
};

// Default settings
const defaultSettings = {
  apiKey: '',
  showFloatBall: true,
  enableYoutubeCaptionTranslation: false,
  targetLang: 'zh-CN',
  theme: 'light'
};

// Apply theme
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
}

// Current UI language
let currentUILang = 'en';

// i18n helper
function t(key) {
  return getMessage(key, currentUILang);
}

// Apply i18n to page
function applyI18n(lang) {
  currentUILang = getUILanguage(lang);
  
  // Update all elements with data-i18n attribute
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    const text = t(key);
    if (text && text !== key) {
      el.textContent = text;
    }
  });
}

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
  await checkStatus();
  setupEventListeners();
  // Not awaited: a slow or unreachable comic service must not hold up the
  // BYO-key features above it.
  refreshComicAccount();
  refreshPdfSection();
});

// Comic translation state, which lives on the server rather than in
// chrome.storage — see background/comic-client.js.
let comicSignedIn = false;

async function refreshComicAccount() {
  // Off means gone, not greyed out: the row's only purpose is to reach a paid
  // service, and it would otherwise advertise a feature with no entry point.
  const { enableComicTranslation } = await chrome.storage.sync.get({ enableComicTranslation: false });
  if (!enableComicTranslation) {
    elements.comicAccount.hidden = true;
    elements.comicTranslatePage.hidden = true;
    elements.comicColorizePage.hidden = true;
    return;
  }
  elements.comicTranslatePage.hidden = false;
  elements.comicColorizePage.hidden = false;

  let account = null;
  try {
    const response = await chrome.runtime.sendMessage({ type: 'COMIC_ACCOUNT' });
    if (response && response.ok) account = response.data;
  } catch (error) {
    console.error('Failed to load comic account:', error);
  }
  comicSignedIn = !!(account && account.signedIn);

  // A signed-out account and an unreachable service look the same here on
  // purpose: either way the useful next step is to sign in, and the options
  // page is where the real error is spelled out.
  if (!comicSignedIn) {
    elements.comicAccountStatus.textContent = t('comicSignIn');
    elements.comicAccount.title = t('comicSignInRequired');
    return;
  }
  // Pages, not points: points are an internal unit.
  elements.comicAccountStatus.textContent = account.pagesRemaining ?? 0;
  elements.comicAccount.title = t('comicPagesRemainingLabel');
}

// The context menu is the natural home for this, but comic hosts disable it
// often enough that the popup has to be able to start a page on its own. No
// srcUrl to send — the content script picks the page(s) on screen.
async function onComicPageAction(mode) {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs[0]?.id) return;
    chrome.tabs.sendMessage(tabs[0].id, {
      type: 'COMIC_TRANSLATE_PAGE',
      mode,
      pageUrl: tabs[0].url || ''
    });
    window.close();
  } catch (error) {
    console.error('Failed to start comic job:', error);
  }
}

async function onComicAccountClick() {
  if (comicSignedIn) {
    chrome.runtime.sendMessage({ type: 'COMIC_OPEN_RECHARGE' });
    window.close();
    return;
  }
  // The consent page opens in its own window; this popup is dismissed the
  // moment that window takes focus, so the handshake is finished by the
  // service worker rather than here.
  chrome.runtime.sendMessage({ type: 'COMIC_SIGN_IN' });
  elements.comicAccountStatus.textContent = t('comicSigningIn');
}

// ---------------------------------------------------------------------------
// PDF translation — entry points and the compact task list
//
// The jobs live on the server and outlast this popup by minutes; the popup is
// only a viewport onto the records the service worker keeps in
// chrome.storage.local['pdfJobs']. While open it polls every 3 seconds so a
// running job visibly moves; the background alarm covers the rest of the time.
// ---------------------------------------------------------------------------

const PDF_UI = globalThis.AI_TRANSLATOR_PDF_UI;
const PDF_POPUP_POLL_MS = 3000;
const PDF_LIST_LIMIT = 3;
let pdfPollTimer = null;
// A create error shown inline above the list (sign-in, top-up, …). Cleared by
// the next successful action.
let pdfInlineError = null;

async function refreshPdfSection() {
  const { enablePdfTranslation } = await chrome.storage.sync.get({ enablePdfTranslation: false });
  if (!enablePdfTranslation) {
    elements.pdfTranslateCurrent.hidden = true;
    elements.pdfTranslateLocal.hidden = true;
    elements.pdfJobs.hidden = true;
    return;
  }
  elements.pdfTranslateLocal.hidden = false;

  // "Translate this PDF" only where it can mean something: the tab is a PDF.
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    elements.pdfTranslateCurrent.hidden = !(tabs[0] && PDF_UI.isLikelyPdfUrl(tabs[0].url));
  } catch (error) {
    elements.pdfTranslateCurrent.hidden = true;
  }

  await refreshPdfJobs({ refresh: false });
  schedulePdfPoll();
}

function schedulePdfPoll() {
  if (pdfPollTimer) clearTimeout(pdfPollTimer);
  pdfPollTimer = setTimeout(async () => {
    await refreshPdfJobs({ refresh: true });
    schedulePdfPoll();
  }, PDF_POPUP_POLL_MS);
}

async function refreshPdfJobs({ refresh }) {
  let records = [];
  try {
    const response = await chrome.runtime.sendMessage({ type: 'PDF_JOBS_LIST', refresh });
    if (response && response.ok) records = response.data || [];
  } catch (error) {
    console.error('Failed to list PDF jobs:', error);
  }
  renderPdfJobs(records);
}

function renderPdfJobs(records) {
  const list = elements.pdfJobs;
  list.textContent = '';

  if (pdfInlineError) list.appendChild(pdfInlineError);

  records.slice(0, PDF_LIST_LIMIT).forEach((record) => {
    const row = document.createElement('div');
    row.className = 'pdf-job';

    const head = document.createElement('div');
    head.className = 'pdf-job-head';
    const name = document.createElement('span');
    name.className = 'pdf-job-name';
    name.textContent = record.fileName || 'PDF';
    name.title = record.fileName || '';
    const status = document.createElement('span');
    status.className = 'pdf-job-status';
    status.textContent = t(PDF_UI.pdfStatusKey(record));
    head.appendChild(name);
    head.appendChild(status);
    row.appendChild(head);

    if (PDF_UI.isPdfJobActive(record)) {
      const track = document.createElement('div');
      track.className = 'pdf-job-track';
      const bar = document.createElement('div');
      bar.className = 'pdf-job-bar';
      bar.style.width = `${Math.max(2, Math.min(100, Math.round(record.progress || 0)))}%`;
      track.appendChild(bar);
      row.appendChild(track);
    } else if (record.status === 'succeeded') {
      const open = document.createElement('button');
      open.className = 'pdf-job-open';
      open.textContent = t('pdfOpen');
      open.addEventListener('click', () => {
        // dual first; the worker falls back to mono when there is none.
        chrome.runtime.sendMessage({ type: 'PDF_OPEN_RESULT', jobId: record.jobId, which: 'dual' });
        window.close();
      });
      head.appendChild(open);
    } else if (record.error) {
      status.classList.add('is-error');
      status.textContent = t(PDF_UI.pdfErrorMessageKey(record.error.code));
    }

    list.appendChild(row);
  });

  list.hidden = !list.childElementCount;
}

/**
 * Create errors the user can act on right here: a sign-in for 401, a top-up
 * for 402. Everything else becomes a plain error line.
 */
function showPdfCreateError(error) {
  const box = document.createElement('div');
  box.className = 'pdf-job pdf-job-error';
  const text = document.createElement('span');
  text.className = 'pdf-job-status is-error';
  text.textContent = t(PDF_UI.pdfErrorMessageKey(error && error.code));
  box.appendChild(text);

  if (error && (error.code === 'unauthorized' || error.loginRequired)) {
    const button = document.createElement('button');
    button.className = 'pdf-job-open';
    button.textContent = t('comicSignIn');
    button.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'COMIC_SIGN_IN' });
      window.close();
    });
    box.appendChild(button);
  } else if (error && error.code === 'insufficient_points') {
    const button = document.createElement('button');
    button.className = 'pdf-job-open';
    button.textContent = t('comicTopUp');
    button.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'COMIC_OPEN_RECHARGE' });
      window.close();
    });
    box.appendChild(button);
  }

  pdfInlineError = box;
  refreshPdfJobs({ refresh: false });
}

async function onPdfTranslateCurrent() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    if (!tab || !PDF_UI.isLikelyPdfUrl(tab.url)) return;

    pdfInlineError = null;
    elements.pdfTranslateCurrent.disabled = true;
    const response = await chrome.runtime.sendMessage({
      type: 'PDF_CREATE_JOB',
      source: { kind: 'url', url: tab.url },
      fileName: PDF_UI.pdfFileNameFromUrl(tab.url),
      pageUrl: tab.url
    });
    elements.pdfTranslateCurrent.disabled = false;

    if (!response || !response.ok) {
      showPdfCreateError(response && response.error);
      return;
    }
    await refreshPdfJobs({ refresh: false });
  } catch (error) {
    console.error('Failed to start PDF job:', error);
    elements.pdfTranslateCurrent.disabled = false;
  }
}

function onPdfTranslateLocal() {
  chrome.tabs.create({ url: chrome.runtime.getURL('pdf/upload.html') });
  window.close();
}

// Check API status and float ball state
async function checkStatus() {
  try {
    const settings = await chrome.storage.sync.get(defaultSettings);
    
    // Apply theme
    applyTheme(settings.theme || 'light');
    
    // Apply i18n based on target language
    applyI18n(settings.targetLang);
    
    // Update float ball status
    elements.floatBallStatus.textContent = settings.showFloatBall ? t('on') : t('off');
    elements.youtubeCaptionsStatus.textContent = settings.enableYoutubeCaptionTranslation ? t('on') : t('off');
    
    // Check if API is configured
    if (!settings.apiKey) {
      elements.statusText.textContent = t('apiNotConfigured');
      document.body.classList.add('status-error');
    } else {
      elements.statusText.textContent = t('ready');
    }
  } catch (error) {
    console.error('Failed to check status:', error);
  }
}

// Translate current page
async function translateCurrentPage() {
  try {
    const settings = await chrome.storage.sync.get(defaultSettings);
    
    if (!settings.apiKey) {
      elements.statusText.textContent = t('configureApiKeyFirst');
      document.body.classList.add('status-error');
      // Open settings
      chrome.runtime.openOptionsPage();
      return;
    }

    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs[0]?.id) {
      elements.statusText.textContent = t('translationFailed');
      return;
    }

    // Send message to content script
    chrome.tabs.sendMessage(tabs[0].id, { type: 'TRANSLATE_PAGE' });
    
    elements.statusText.textContent = t('translating');
    
    // Close popup after a short delay
    setTimeout(() => window.close(), 500);
  } catch (error) {
    console.error('Failed to translate page:', error);
    elements.statusText.textContent = t('translationFailed');
  }
}

// Toggle float ball
async function toggleFloatBall() {
  try {
    const settings = await chrome.storage.sync.get(defaultSettings);
    const newState = !settings.showFloatBall;
    
    await chrome.storage.sync.set({ showFloatBall: newState });
    elements.floatBallStatus.textContent = newState ? t('on') : t('off');
    
    // Notify all tabs
    const tabs = await chrome.tabs.query({});
    tabs.forEach(tab => {
      chrome.tabs.sendMessage(tab.id, {
        type: 'TOGGLE_FLOAT_BALL',
        show: newState
      }).catch(() => {});
    });
  } catch (error) {
    console.error('Failed to toggle float ball:', error);
  }
}

// Toggle YouTube captions translation
async function toggleYoutubeCaptions() {
  try {
    const settings = await chrome.storage.sync.get(defaultSettings);
    const newState = !settings.enableYoutubeCaptionTranslation;

    await chrome.storage.sync.set({ enableYoutubeCaptionTranslation: newState });
    elements.youtubeCaptionsStatus.textContent = newState ? t('on') : t('off');
  } catch (error) {
    console.error('Failed to toggle YouTube captions:', error);
  }
}

// Open settings page
function openSettings() {
  chrome.runtime.openOptionsPage();
  window.close();
}

// Setup event listeners
function setupEventListeners() {
  elements.translatePage.addEventListener('click', translateCurrentPage);
  elements.toggleFloatBall.addEventListener('click', toggleFloatBall);
  elements.toggleYoutubeCaptions.addEventListener('click', toggleYoutubeCaptions);
  elements.openSettings.addEventListener('click', openSettings);
  elements.comicAccount.addEventListener('click', onComicAccountClick);
  elements.comicTranslatePage.addEventListener('click', () => onComicPageAction('translate'));
  elements.comicColorizePage.addEventListener('click', () => onComicPageAction('colorize'));
  elements.pdfTranslateCurrent.addEventListener('click', onPdfTranslateCurrent);
  elements.pdfTranslateLocal.addEventListener('click', onPdfTranslateLocal);
}
