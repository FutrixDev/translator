// Blab Translation background — PDF 任务的系统通知。
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

async function notifyPdfTerminal(record) {
  const uiLang = await pdfNotificationLang();
  const succeeded = record.status === 'succeeded';
  const titleKey = succeeded ? 'pdfNotifyDoneTitle' : 'pdfNotifyFailTitle';
  const body = succeeded
    ? pdfMessage('pdfNotifyDoneBody', uiLang)
    : pdfClient.pdfErrorMessage(record.error, key => pdfMessage(key, uiLang));
  const fileName = record.fileName ? `${record.fileName}\n` : '';
  chrome.notifications.create(`pdf-job-${record.jobId}`, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: pdfMessage(titleKey, uiLang),
    message: `${fileName}${body}`
  }, () => {
    if (chrome.runtime.lastError) {
      console.warn('PDF notification failed:', chrome.runtime.lastError.message);
    }
  });
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
  }, () => {
    if (chrome.runtime.lastError) {
      console.warn('PDF notification failed:', chrome.runtime.lastError.message);
    }
  });
}

/** The toolbar entry clicked while the tab is not showing a PDF. */
async function notifyPdfNotAPdf() {
  const uiLang = await pdfNotificationLang();
  chrome.notifications.create({
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: pdfMessage('pdfNotifyNotPdfTitle', uiLang),
    message: pdfMessage('pdfNotifyNotPdfBody', uiLang)
  }, () => {
    if (chrome.runtime.lastError) {
      console.warn('PDF notification failed:', chrome.runtime.lastError.message);
    }
  });
}

/** A repeat click on a PDF that is already in flight. */
async function notifyPdfRunning(fileName) {
  const uiLang = await pdfNotificationLang();
  chrome.notifications.create({
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: pdfMessage('pdfNotifyRunningTitle', uiLang),
    message: `${fileName ? `${fileName}\n` : ''}${pdfMessage('pdfNotifyStartBody', uiLang)}`
  }, () => {
    if (chrome.runtime.lastError) {
      console.warn('PDF notification failed:', chrome.runtime.lastError.message);
    }
  });
}

async function notifyPdfError(error) {
  const uiLang = await pdfNotificationLang();
  // Either the error itself or the {error: {...}} messaging envelope.
  const inner = error && error.error && error.error.code ? error.error : error;
  chrome.notifications.create({
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: pdfMessage('pdfNotifyFailTitle', uiLang),
    message: pdfClient.pdfErrorMessage(inner, key => pdfMessage(key, uiLang))
  }, () => {
    if (chrome.runtime.lastError) {
      console.warn('PDF notification failed:', chrome.runtime.lastError.message);
    }
  });
}

export {
  pdfNotificationLang,
  pdfMessage,
  notifyPdfTerminal,
  notifyPdfStarted,
  notifyPdfNotAPdf,
  notifyPdfRunning,
  notifyPdfError,
};
