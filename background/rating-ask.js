// Blab Translation background — the one request for a store rating.
//
// After this device's third finished PDF, a notification asks whether the
// user would rate the extension on the Chrome Web Store, once. Whatever they
// do with it — rate, decline, dismiss, ignore — it is never shown again.
//
// The count lives in chrome.storage.local and nowhere else: nothing about it
// leaves the device (the store listing says "No analytics"). The ask offers
// nothing for a rating and does not ask for a good one; the store page is
// where the user says what they think.

import '../shared/doc-jobs.js';
import '../shared/storage-writer.js';
import { logIfFailed, pdfMessage, pdfNotificationLang } from './pdf-notify.js';

const DocJobs = globalThis.DocJobs;
const StorageWriter = globalThis.StorageWriter;

const RATING_ASK_KEY = 'ratingAsk';
const RATING_ASK_NOTIFICATION_ID = 'rating-ask';
const PDF_JOBS_BEFORE_ASK = 3;
// The store's review tab for this extension. Not an account-site link, so not
// SiteLinks, and untagged.
const STORE_REVIEWS_URL = 'https://chromewebstore.google.com/detail/kbaebnmocaoogcjclbjmmhbbplbpcbpo/reviews';

// The poll and a page can settle jobs at the same moment; the single-writer
// queue runs one note after the other, so two read-modify-writes never
// interleave. Only applyWrite is used: nothing outside the worker sends it.
const ratingWriter = StorageWriter.create({
  type: 'RATING_ASK_WRITE',
  writes: { settled: ({ record }) => noteNow(record) },
  errors: 'throw',
});

/**
 * A job on this device just settled. A succeeded PDF counts (once per job,
 * however many paths report it); the third one raises the ask. The ask is
 * marked made before it is shown, so a failure to show it never shows it
 * twice.
 */
function noteJobSettled(record) {
  return ratingWriter.applyWrite({ kind: 'settled', record });
}

async function noteNow(record) {
  if (record.status !== 'succeeded' || DocJobs.jobFormat(record) !== 'pdf') return;
  const stored = await chrome.storage.local.get({ [RATING_ASK_KEY]: { pdfJobs: [], asked: false } });
  const state = stored[RATING_ASK_KEY];
  if (state.asked || state.pdfJobs.includes(record.jobId)) return;
  const pdfJobs = [...state.pdfJobs, record.jobId];
  const asked = pdfJobs.length >= PDF_JOBS_BEFORE_ASK;
  await chrome.storage.local.set({ [RATING_ASK_KEY]: { pdfJobs, asked } });
  if (asked) await showRatingAsk();
}

async function showRatingAsk() {
  const uiLang = await pdfNotificationLang();
  const t = key => pdfMessage(key, uiLang);
  chrome.notifications.create(RATING_ASK_NOTIFICATION_ID, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: t('ratingAskTitle'),
    message: t('ratingAskBody'),
    buttons: [{ title: t('ratingAskRate') }, { title: t('ratingAskNoThanks') }],
  }, logIfFailed);
}

/** Rate: the ask goes and the store's review tab opens. */
async function openStoreReviews() {
  chrome.notifications.clear(RATING_ASK_NOTIFICATION_ID, logIfFailed);
  await chrome.tabs.create({ url: STORE_REVIEWS_URL });
}

/** No thanks: the ask goes and nothing opens. */
function dismissRatingAsk() {
  chrome.notifications.clear(RATING_ASK_NOTIFICATION_ID, logIfFailed);
}

function rate() {
  openStoreReviews()
    .catch(error => console.warn('[rating] opening the store failed:', error?.message || error));
}

// Registered at the top level so a click that wakes a torn-down worker still
// finds its listeners. Each answers only the ask's own notification; the job
// notifications have their listener in pdf-jobs.js. Button 0 rates, button 1
// declines, and the body rates.
chrome.notifications.onButtonClicked.addListener((notificationId, buttonIndex) => {
  if (notificationId !== RATING_ASK_NOTIFICATION_ID) return;
  if (buttonIndex === 0) rate();
  else dismissRatingAsk();
});

chrome.notifications.onClicked.addListener((notificationId) => {
  if (notificationId === RATING_ASK_NOTIFICATION_ID) rate();
});

export {
  RATING_ASK_KEY,
  STORE_REVIEWS_URL,
  noteJobSettled,
};
