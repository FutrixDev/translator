// Blab Translation Background Script
import '../shared/api-compat.js';
import '../shared/account-gate.js';
// 语言标签的判定（基码、简繁、同语言）只有这一份，site-rules.js 在加载时就取走
// 它，所以它要排在前面。
import '../shared/lang-tags.js';
// 内置名单排在 site-rules.js 之前：它是那个模块 table() 的数据源。没有它
// table() 会静静地退回一张空表，而空表的 isBlocked() 对每一个域名都答「不在
// 黑名单里」—— 银行、网页邮箱、政务表单那份禁翻清单就这么没了，不报错。
import '../shared/site-rules-builtin.js';
import '../shared/site-rules.js';
// Side-effect module: publishes globalThis.AutoStats. 统计的写入点全在这里 ——
// 每个标签页都在记，读—改—写必须收进单实例（见 shared/auto-stats.js 开头）。
import '../shared/auto-stats.js';
// Side-effect module (no exports): publishes globalThis.ChargeConfirm, the one
// copy of D9's charge-confirmation logic, which the content scripts and the
// extension's own pages load as a classic script.
import '../shared/comic-charge.js';
import '../shared/ocr.js';
// Side-effect module: publishes globalThis.TranslationCache. Background 只用它的
// sweep()——写入发生在内容脚本里，过期清理和字节预算只能由常驻侧按闹钟来做。
import '../shared/translation-cache.js';
import '../i18n/messages.js';
import * as comicClient from './comic-client.js';
import * as pdfClient from './pdf-client.js';

// 这个文件是 worker 的接线板：消息路由、生命周期、闹钟，加上路由直接分派的那几个
// handler。每一样具体的活都在隔壁模块里 —— 图标、菜单、PDF、OCR、AI 翻译。
import './icon.js';
import { MENU_IDS, createContextMenus } from './context-menus.js';
import { assertFeatureEnabled } from './feature-gate.js';
import { defaultSettings, getEffectiveTargetLang } from './settings.js';
import {
  translateBatchFastWithAI,
  translateBatchWithAI,
  translateTextWithMode,
} from './ai-translate.js';
import { handleOcrImage, relayOcrProgress } from './ocr-recognize.js';
import {
  ensurePdfPollAlarm,
  handlePdfCreateJob,
  handlePdfJobAbandon,
  handlePdfJobGet,
  handlePdfJobsHistory,
  handlePdfOpenResult,
  refreshPdfJobs,
} from './pdf-jobs.js';

// Message listener
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'INLINE_CONTEXT_MENU_STATE':
      if (typeof message.visible === 'boolean') {
        chrome.contextMenus.update(MENU_IDS.removeInlineTranslation, {
          visible: message.visible
        }, () => {
          if (chrome.runtime.lastError) return;
          if (chrome.contextMenus.refresh) {
            chrome.contextMenus.refresh();
          }
        });
      }
      break;
    case 'COMMAND_SHORTCUTS':
      // 内容脚本够不着 chrome.commands，而它得知道哪些修饰键被我们自己的命令
      // 占着：单修饰键的悬停快捷键不能抢在和弦的第二下之前动手（见
      // content/content-utils.js 的 commandModifiers）。键位用户改得掉，所以
      // 答的是**现在真的绑着**的那一份，不是 manifest 里那份建议值。
      chrome.commands.getAll((commands) => {
        sendResponse({ shortcuts: (commands || []).map((c) => c.shortcut).filter(Boolean) });
      });
      return true;

    case 'TRANSLATE':
      handleTranslate(message.text, message.targetLang, message.mode)
        .then(sendResponse)
        .catch(error => sendResponse({ error: error.message }));
      return true; // Keep channel open for async response

    case 'TRANSLATE_BATCH':
      handleBatchTranslate(message.texts, message.targetLang)
        .then(sendResponse)
        .catch(error => sendResponse({ error: error.message }));
      return true;

    case 'TRANSLATE_BATCH_FAST':
      handleBatchTranslateFast(message.texts, message.targetLang, message.delimiter)
        .then(sendResponse)
        .catch(error => sendResponse({ error: error.message }));
      return true;

    case 'OCR_IMAGE':
      handleOcrImage(message, sender)
        .then(sendResponse)
        .catch(error => sendResponse({ error: error.message }));
      return true;

    // From the offscreen document, which cannot address a tab itself.
    case 'OCR_PROGRESS':
      relayOcrProgress(message);
      break;

    // The OCR engine has been idle long enough to be worth its memory no
    // longer. Closing the document also lets this service worker go to sleep —
    // an open offscreen document keeps it alive indefinitely.
    case 'OCR_OFFSCREEN_IDLE':
      chrome.offscreen.closeDocument().catch(() => {});
      break;

    case 'OPEN_OPTIONS':
      chrome.runtime.openOptionsPage();
      break;

    // 站点规则和追问计数的读—改—写。内容脚本和 popup 不自己动这两张表：它们是
    // 整份对象读出来、改一个键、整份写回，两个标签页同时来就会互相盖掉 ——
    // 用户点下的选择没了，而且哪里都不报错。规则本身在 shared/site-rules.js，
    // 这里只管转接。
    case 'SITE_RULES_WRITE':
      globalThis.SiteRules.applyWrite(message)
        .then(value => sendResponse({ value }))
        .catch(error => sendResponse({ error: error.message }));
      return true;

    // 本机统计的读—改—写。内容脚本和设置页不自己动这份记录：每个标签页都在往
    // 里记，两边先读到同一份旧数字、后写的整份盖掉，丢的就是那几笔。规则在
    // shared/auto-stats.js，这里只管转接。
    case 'AUTO_STATS_WRITE':
      globalThis.AutoStats.applyWrite(message)
        .then(value => sendResponse({ value }))
        .catch(error => sendResponse({ error: error.message }));
      return true;

    // --- Comic translation (account-backed, see comic-client.js) -------------
    case 'COMIC_ACCOUNT':
      replyComic(comicClient.getAccount({ force: message.force === true }), sendResponse);
      return true;

    case 'COMIC_SIGN_IN':
      replyComic(comicClient.signIn(), sendResponse);
      return true;

    case 'COMIC_SIGN_OUT':
      replyComic(comicClient.signOut().then(() => ({ signedIn: false })), sendResponse);
      return true;

    case 'COMIC_JOB_CREATE':
      replyComic(
        assertFeatureEnabled('enableComicTranslation')
          .then(() => comicClient.createJob(message.job || {})),
        sendResponse,
      );
      return true;

    case 'COMIC_JOB_POLL':
      replyComic(comicClient.getJob(message.jobId), sendResponse);
      return true;

    case 'COMIC_JOB_ABANDON':
      replyComic(comicClient.abandonJob(message.jobId), sendResponse);
      return true;

    // --- PDF translation (account-backed, see pdf-client.js) -----------------
    case 'PDF_CREATE_JOB':
      replyComic(handlePdfCreateJob(message), sendResponse);
      return true;

    case 'PDF_JOB_GET':
      replyComic(handlePdfJobGet(message.jobId), sendResponse);
      return true;

    case 'PDF_JOB_ABANDON':
      replyComic(handlePdfJobAbandon(message.jobId), sendResponse);
      return true;

    case 'PDF_JOBS_LIST':
      // refresh:false is the popup's cheap first paint from storage; the
      // 3-second cadence passes refresh:true to actually ask the server.
      replyComic(
        message.refresh === false ? pdfClient.listJobRecords() : refreshPdfJobs(),
        sendResponse
      );
      return true;

    case 'PDF_JOBS_HISTORY':
      replyComic(handlePdfJobsHistory(), sendResponse);
      return true;

    case 'PDF_JOB_DISMISS':
      replyComic(pdfClient.dismissJobRecord(message.jobId), sendResponse);
      return true;

    case 'PDF_OPEN_RESULT':
      replyComic(handlePdfOpenResult(message.jobId, message.which), sendResponse);
      return true;

    // Where the account lives on the web, so the settings page can link a job
    // to the library that renders it. Asked for rather than duplicated: the
    // origin has a default and a storage override in comic-client.js, and a
    // second copy in the options page would be the one that goes stale.
    // Deliberately not gated on being signed in — the link is worth showing to
    // someone who is not, because following it is how they sign in.
    case 'ACCOUNT_SITE_BASE':
      replyComic(comicClient.getApiBase().then(base => ({ base })), sendResponse);
      return true;
  }
});

/**
 * Settle a comic-client promise into a plain message.
 *
 * An Error does not survive chrome.runtime messaging, and the codes matter: the
 * page decides between "sign in", "out of free pages" and "this image cannot be
 * translated" purely from `error.code`.
 */
function replyComic(promise, sendResponse) {
  promise
    .then(data => sendResponse({ ok: true, data }))
    .catch(error => {
      if (error instanceof comicClient.ComicApiError) {
        sendResponse({ ok: false, ...error.toMessage() });
      } else {
        sendResponse({ ok: false, error: { code: 'internal_error', message: error?.message || String(error) } });
      }
    });
}

// 译文缓存的清理闹钟。
//
// 写缓存的是内容脚本，但没有一个内容脚本能负责清理：页面随时会走，而清理要在
// 「没人翻译的时候」发生。所以过期与字节预算由常驻侧按天来收，和 PDF 轮询同一套
// chrome.alarms 机制、各自一个名字。周期取一天：条目活 30 天，预算是 4 MB 的软上限，
// 都不是需要分钟级响应的东西。
const CACHE_SWEEP_ALARM = 'translation-cache-sweep';

function ensureCacheSweepAlarm() {
  chrome.alarms.create(CACHE_SWEEP_ALARM, { periodInMinutes: 24 * 60 });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== CACHE_SWEEP_ALARM) return;
  globalThis.TranslationCache.sweep()
    .catch(error => console.error('Translation cache sweep failed:', error));
});

// Context menu for right-click translation
chrome.runtime.onInstalled.addListener(() => {
  createContextMenus();
  // Jobs survive a browser restart; the alarm that watches them must too.
  ensurePdfPollAlarm().catch(() => {});
  ensureCacheSweepAlarm();
});

chrome.runtime.onStartup.addListener(() => {
  createContextMenus();
  ensurePdfPollAlarm().catch(() => {});
  ensureCacheSweepAlarm();
});

// Alt+A —— 翻译 / 还原当前页面。
//
// 和右键菜单、popup 那一行走的是同一条消息，因为它们是同一个动作；键位在
// manifest 的 commands 里声明，用户可以在 chrome://extensions/shortcuts 改掉。
//
// content script 不在的页面（chrome:// 、Web Store、一个还没跑完的标签页）
// sendMessage 会 reject，这里咽掉 —— 一个快捷键按不动是本来就该安静的事，
// 抛出去只会在 service worker 的控制台里堆未处理的 rejection。
chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'toggle-translate-page') return;
  const target = tab || (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (!target || typeof target.id !== 'number') return;
  try {
    await chrome.tabs.sendMessage(target.id, { type: 'TOGGLE_PAGE_TRANSLATION' });
  } catch (error) {
    console.log('Blab Translation: toggle shortcut had no receiver', error && error.message);
  }
});

// Handle single text translation
async function handleTranslate(text, targetLang, mode) {
  const settings = await chrome.storage.sync.get(defaultSettings);

  if (!settings.apiKey) {
    return { error: '请先在设置中配置 API Key' };
  }

  try {
    const effectiveLang = targetLang || getEffectiveTargetLang(settings);
    const result = await translateTextWithMode(text, effectiveLang, settings, mode === 'word');
    return result;
  } catch (error) {
    console.error('Translation error:', error);
    return { error: error.message || '翻译失败，请重试' };
  }
}

// Handle batch translation
async function handleBatchTranslate(texts, targetLang) {
  const settings = await chrome.storage.sync.get(defaultSettings);

  if (!settings.apiKey) {
    return { error: '请先在设置中配置 API Key' };
  }

  try {
    const effectiveLang = targetLang || getEffectiveTargetLang(settings);
    const translations = await translateBatchWithAI(texts, effectiveLang, settings);
    return { translations };
  } catch (error) {
    console.error('Batch translation error:', error);
    return { error: error.message || '翻译失败，请重试' };
  }
}

// Handle fast batch translation with delimiter
async function handleBatchTranslateFast(texts, targetLang, delimiter = '|||') {
  const settings = await chrome.storage.sync.get(defaultSettings);

  if (!settings.apiKey) {
    return { error: '请先在设置中配置 API Key' };
  }

  try {
    const effectiveLang = targetLang || getEffectiveTargetLang(settings);
    const translations = await translateBatchFastWithAI(texts, effectiveLang, settings, delimiter);
    return { translations };
  } catch (error) {
    console.error('Fast batch translation error:', error);
    return { error: error.message || '翻译失败，请重试' };
  }
}
