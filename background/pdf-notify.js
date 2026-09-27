// Blab Translation background — 文档任务的系统通知。
//
// PDF 是唯一一个没有自己界面的入口：Chrome 的 PDF 阅读器不收内容脚本，右键菜单
// 和工具栏菜单点下去之后，用户看得见的只有通知。所以「开始了」「它不是 PDF」
// 「这份已经在跑了」这几条不是锦上添花 —— 没有它们，一次点击和什么都没发生长
// 得一模一样，而那正是人会再点一次的原因。

import '../i18n/messages.js';
import { defaultSettings, uiLanguageOf } from './settings.js';
import * as pdfClient from './pdf-client.js';

async function pdfNotificationLang() {
  const settings = await chrome.storage.sync.get(defaultSettings);
  return uiLanguageOf(settings);
}

function pdfMessage(key, uiLang) {
  if (typeof globalThis.getMessage === 'function') {
    return globalThis.getMessage(key, uiLang);
  }
  return key;
}

// Notification ids this module owns. A job's own notifications carry its id
// after one of these prefixes, which is what a click is routed by; every other
// prefix (the URL path's `pdf-charge-`) is somebody else's.
const PDF_JOB_NOTIFICATION_PREFIX = 'pdf-job-';
const PDF_CONFIRM_NOTIFICATION_PREFIX = 'pdf-confirm-';
// A failure that only a sign-in fixes. Its one button is the sign-in; the
// click is routed in pdf-jobs.js, which owns the account entry points.
const PDF_SIGNIN_NOTIFICATION_PREFIX = 'pdf-signin-';

/** The job a notification is about, or null when it is not a job notification. */
function jobIdFromNotificationId(notificationId) {
  const id = String(notificationId || '');
  for (const prefix of [PDF_JOB_NOTIFICATION_PREFIX, PDF_CONFIRM_NOTIFICATION_PREFIX]) {
    if (id.startsWith(prefix) && id.length > prefix.length) return id.slice(prefix.length);
  }
  return null;
}

function logIfFailed() {
  if (chrome.runtime.lastError) {
    console.warn('PDF notification failed:', chrome.runtime.lastError.message);
  }
}

const TERMINAL_TITLE_KEYS = {
  succeeded: 'pdfNotifyDoneTitle',
  abandoned: 'docNotifyCancelledTitle',
  failed: 'pdfNotifyFailTitle'
};

/**
 * A job just ended. The title says how: finished, cancelled (the user's own
 * decision or the server handing the pages back — not a failure), or failed.
 */
async function notifyPdfTerminal(record) {
  const uiLang = await pdfNotificationLang();
  const t = key => pdfMessage(key, uiLang);
  let body;
  if (record.status === 'succeeded') body = t('pdfNotifyDoneBody');
  else if (record.status === 'abandoned') body = t(pdfClient.pdfAbandonedKey(record.error || {}));
  else body = pdfClient.pdfErrorMessage(record.error, t);
  const fileName = record.fileName ? `${record.fileName}\n` : '';
  chrome.notifications.create(`${PDF_JOB_NOTIFICATION_PREFIX}${record.jobId}`, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: t(TERMINAL_TITLE_KEYS[record.status] || 'pdfNotifyFailTitle'),
    message: `${fileName}${body}`
  }, logIfFailed);
}

/**
 * A job stopped to ask: the document measured longer than the pages reserved
 * for it, and nothing moves until the user says continue or cancel. It stays
 * until it is answered — a question that scrolls away is a job that silently
 * sits for 72 h and is then cancelled.
 */
async function notifyPdfConfirm(record) {
  const uiLang = await pdfNotificationLang();
  const t = key => pdfMessage(key, uiLang);
  const confirm = record.confirm;
  const body = confirm && Number.isFinite(confirm.extraUnits)
    ? t('docNotifyConfirmBody').split('{extra}').join(String(confirm.extraUnits))
    : t('docStatusAwaitingConfirm');
  const fileName = record.fileName ? `${record.fileName}\n` : '';
  chrome.notifications.create(`${PDF_CONFIRM_NOTIFICATION_PREFIX}${record.jobId}`, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: t('docNotifyConfirmTitle'),
    message: `${fileName}${body}`,
    requireInteraction: true
  }, logIfFailed);
}

/** The question is gone — answered here, on the website, or by the 72 h sweep. */
function clearPdfConfirmNotification(jobId) {
  chrome.notifications.clear(`${PDF_CONFIRM_NOTIFICATION_PREFIX}${jobId}`);
}

/**
 * "It started." Only the context-menu entries need this — they have no UI of
 * their own, and without it a click on a menu item is indistinguishable from a
 * click that did nothing, which is exactly what makes people click again.
 */
async function notifyPdfStarted(fileName) {
  const uiLang = await pdfNotificationLang();
  chrome.notifications.create({
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: pdfMessage('pdfNotifyStartTitle', uiLang),
    message: `${fileName ? `${fileName}\n` : ''}${pdfMessage('pdfNotifyStartBody', uiLang)}`
  }, logIfFailed);
}

/** The toolbar entry clicked while the tab is not showing a PDF. */
async function notifyPdfNotAPdf() {
  const uiLang = await pdfNotificationLang();
  chrome.notifications.create({
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: pdfMessage('pdfNotifyNotPdfTitle', uiLang),
    message: pdfMessage('pdfNotifyNotPdfBody', uiLang)
  }, logIfFailed);
}

/** A repeat click on a PDF that is already in flight. */
async function notifyPdfRunning(fileName) {
  const uiLang = await pdfNotificationLang();
  chrome.notifications.create({
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: pdfMessage('pdfNotifyRunningTitle', uiLang),
    message: `${fileName ? `${fileName}\n` : ''}${pdfMessage('pdfNotifyStartBody', uiLang)}`
  }, logIfFailed);
}

/**
 * A document could not be started or finished. When the reason is "not signed
 * in", the notification carries the way out: a Sign In button, the same
 * sign-in the popup and the page hint open (D-353). "Sign in to translate" with
 * nothing to click leaves the user hunting for the toolbar icon.
 */
async function notifyPdfError(error) {
  const uiLang = await pdfNotificationLang();
  // Either the error itself or the {error: {...}} messaging envelope.
  const inner = error && error.error && error.error.code ? error.error : error;
  const signIn = !!inner && inner.code === 'unauthorized';
  const options = {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: pdfMessage('pdfNotifyFailTitle', uiLang),
    message: pdfClient.pdfErrorMessage(inner, key => pdfMessage(key, uiLang))
  };
  if (!signIn) {
    chrome.notifications.create(options, logIfFailed);
    return;
  }
  // An id of its own, so the button click can be told apart from every other
  // PDF notification's.
  chrome.notifications.create(`${PDF_SIGNIN_NOTIFICATION_PREFIX}${crypto.randomUUID()}`, {
    ...options,
    buttons: [{ title: pdfMessage('comicSignIn', uiLang) }]
  }, logIfFailed);
}

export {
  PDF_JOB_NOTIFICATION_PREFIX,
  PDF_CONFIRM_NOTIFICATION_PREFIX,
  PDF_SIGNIN_NOTIFICATION_PREFIX,
  jobIdFromNotificationId,
  logIfFailed,
  pdfNotificationLang,
  pdfMessage,
  notifyPdfTerminal,
  notifyPdfConfirm,
  clearPdfConfirmNotification,
  notifyPdfStarted,
  notifyPdfNotAPdf,
  notifyPdfRunning,
  notifyPdfError,
};
