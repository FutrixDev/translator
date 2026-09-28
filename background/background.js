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
// 同步存储的单写者队列：站点规则、统计、自定义规则三家共用，它们在加载时就取走它。
import '../shared/storage-writer.js';
import '../shared/site-rules.js';
// Side-effect module: publishes globalThis.AutoStats. 统计的写入点全在这里 ——
// 每个标签页都在记，读—改—写必须收进单实例（见 shared/auto-stats.js 开头）。
import '../shared/auto-stats.js';
// Side-effect module: publishes globalThis.PromptAddenda — the shape and limits
// of the register/glossary/domain/context addenda the three TRANSLATE handlers validate.
// custom-rules.js 在加载时取走它（规则的 domain 按 PromptAddenda.DOMAINS 校验），
// 所以排在规则之前。
import '../shared/prompt-addenda.js';
// 「一条一个 sync 键」的集合（sync-collection）和建在它上面的用户站点规则。两者
// 在加载时就取走 StorageWriter 与 SiteRules，所以排在它们之后。
import '../shared/sync-collection.js';
import '../shared/custom-rules.js';
// 用户术语表，同样建在 SyncCollection 上；它在加载时还取走 TargetLang（词条的
// 目标语言按 SUPPORTED 校验），所以 target-lang.js 在这里先装（ESM 会去重）。
import '../shared/target-lang.js';
// Side-effect module: publishes globalThis.TextMarkers, the one grammar of {{n}}
// placeholders and <a1> markers. glossary.js takes it at load: a term may not
// contain either (D-387).
import '../shared/text-markers.js';
import '../shared/glossary.js';
// 术语表的 CSV：GLOSSARY_WRITE 的 import 在这里重新解析，不信设置页算的结果。
// 它加载时取走 Glossary，所以排在 glossary.js 之后。
import '../shared/glossary-csv.js';
// Side-effect module (no exports): publishes globalThis.ChargeConfirm, the one
// copy of D9's charge-confirmation logic, which the content scripts and the
// extension's own pages load as a classic script.
import '../shared/comic-charge.js';
import '../shared/ocr.js';
// Side-effect module: publishes globalThis.TranslationCache. Background 只用它的
// sweep()——写入发生在内容脚本里，过期清理和字节预算只能由常驻侧按闹钟来做。
import '../shared/translation-cache.js';
// 界面文案：十门语言一门一个文件，加上取文案的那几个函数。彼此没有先后（注册表
// 谁先到谁建），但少一门的表现是那门语言的界面整个退回英文，所以这里列全。
import '../i18n/lang/en.js';
import '../i18n/lang/zh-CN.js';
import '../i18n/lang/zh-TW.js';
import '../i18n/lang/ja.js';
import '../i18n/lang/ko.js';
import '../i18n/lang/fr.js';
import '../i18n/lang/de.js';
import '../i18n/lang/es.js';
import '../i18n/lang/pt.js';
import '../i18n/lang/ru.js';
import '../i18n/messages.js';
import * as comicClient from './comic-client.js';
import * as pdfClient from './pdf-client.js';
import { runCommand } from './commands.js';
import { comicHintWriter, openShortcutSettings } from './media-hints.js';
import { openOnboardingOnInstall } from './install.js';

// 这个文件是 worker 的接线板：消息路由、生命周期、闹钟，加上路由直接分派的那几个
// handler。每一样具体的活都在隔壁模块里 —— 菜单、PDF、OCR、AI 翻译。
import './page-coverage.js';
import './custom-rules-host.js';
import './glossary-host.js';
import { MENU_IDS, createContextMenus } from './context-menus.js';
import { assertFeatureEnabled } from './feature-gate.js';
import { defaultSettings, getEffectiveTargetLang } from './settings.js';
import { apiErrorMessage, missingApiKeyMessage } from './api-errors.js';
import {
  translateBatchFastWithAI,
  translateBatchWithAI,
  translateTextWithMode,
} from './ai-translate.js';
import { handleOcrImage, relayOcrProgress } from './ocr-recognize.js';
import './frame-relay.js';
import {
  ensurePdfPollAlarm,
  handlePdfCreateJob,
  handlePdfJobAbandon,
  handlePdfJobConfirm,
  handlePdfJobGet,
  handlePdfJobsHistory,
  handlePdfUploadTicket,
  openPdfJob,
  refreshPdfJobs,
  startPdfUrlTranslation,
} from './pdf-jobs.js';

// 写消息 → 持有那份数据的模块。取的是 globalThis 上的名字：这些共用模块是双模
// 经典脚本，只挂全局、不导出。
const STORAGE_WRITERS = {
  SITE_RULES_WRITE: () => globalThis.SiteRules,
  AUTO_STATS_WRITE: () => globalThis.AutoStats,
  CUSTOM_RULES_WRITE: () => globalThis.CustomRules,
  COMIC_HINT_WRITE: () => comicHintWriter,
  GLOSSARY_WRITE: () => globalThis.Glossary,
};

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
        // 按名字答：修饰键名单只要键位，提示条还要知道哪一条是它的命令、解没解绑。
        sendResponse({ commands: (commands || []).map((c) => ({ name: c.name, shortcut: c.shortcut || '' })) });
      });
      return true;

    case 'TRANSLATE':
      handleTranslate(message.text, message.targetLang, message.mode, message.addenda)
        .then(sendResponse)
        .catch(error => sendResponse({ error: error.message }));
      return true; // Keep channel open for async response

    case 'TRANSLATE_BATCH':
      handleBatchTranslate(message.texts, message.targetLang, message.addenda)
        .then(sendResponse)
        .catch(error => sendResponse({ error: error.message }));
      return true;

    case 'TRANSLATE_BATCH_FAST':
      handleBatchTranslateFast(message.texts, message.targetLang, message.delimiter, message.addenda)
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

    // 媒体提示条上的「设置快捷键」：页面打不开 chrome:// 网址。
    case 'OPEN_SHORTCUT_SETTINGS':
      openShortcutSettings().catch(error => console.warn('Blab Translation: opening shortcut settings failed', error));
      break;

    // 同步存储的五个写消息：站点规则、本机统计、用户站点规则、漫画提示、术语表。内容
    // 脚本、popup 和设置页都不自己读—改—写这些键：整份读出来、改一处、整份写回，
    // 两个标签页同时来就会互相盖掉 —— 用户的选择没了，而且哪里都不报错。规则各在
    // 自己的模块里（STORAGE_WRITERS），这里只管转接。
    case 'SITE_RULES_WRITE':
    case 'AUTO_STATS_WRITE':
    case 'CUSTOM_RULES_WRITE':
    case 'COMIC_HINT_WRITE':
    case 'GLOSSARY_WRITE':
      STORAGE_WRITERS[message.type]().applyWrite(message, sender)
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

    // `consent`: the media shortcut or the comic hint asked for this page
    // (content/content-media-hints.js), which runs it even with the switch off.
    case 'COMIC_JOB_CREATE':
      replyComic(
        assertFeatureEnabled('enableComicTranslation', { consent: message.consent === true })
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

    // --- Document translation (account-backed, see pdf-client.js) ------------
    // The upload page asks where to PUT the file, PUTs it itself, then creates.
    case 'PDF_UPLOAD_TICKET':
      replyComic(handlePdfUploadTicket(message), sendResponse);
      return true;

    case 'PDF_CREATE_JOB':
      replyComic(handlePdfCreateJob(message), sendResponse);
      return true;

    case 'PDF_JOB_GET':
      replyComic(handlePdfJobGet(message.jobId), sendResponse);
      return true;

    case 'PDF_JOB_CONFIRM':
      replyComic(handlePdfJobConfirm(message.jobId), sendResponse);
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

    case 'PDF_OPEN_JOB':
      replyComic(openPdfJob(message.jobId, message.which), sendResponse);
      return true;

    // PDF 文档上那条提示条按下的「翻译」或媒体快捷键（content/content-media-hints.js）。
    // 走的是右键菜单那三个条目同一个函数，检查一条不少；consent 见
    // startPdfUrlTranslation。
    //
    // 网址以发信那个标签页的为准，message.url 只在没有标签页时兜底：内容脚本报
    // 的是它自己那一页，而 sender.tab.url 是浏览器说的那一页——要花钱的那一步
    // 上，宁可信浏览器。notifyNotAPdf 不开：这条提示条只在一份 PDF 上出现过，
    // 真走到「这不是 PDF」只能是页面在这中间换掉了，那时弹通知只是噪音。
    case 'PDF_TRANSLATE_URL':
      replyComic(startPdfUrlTranslation({
        url: (sender.tab && sender.tab.url) || message.url || '',
        pageUrl: (sender.tab && sender.tab.url) || message.url || '',
        consent: message.consent === true,
      }), sendResponse);
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
chrome.runtime.onInstalled.addListener((details) => {
  createContextMenus();
  // Jobs survive a browser restart; the alarm that watches them must too.
  ensurePdfPollAlarm().catch(() => {});
  ensureCacheSweepAlarm();
  // First install only: the welcome page (./install.js decides which reasons).
  Promise.resolve(openOnboardingOnInstall(details))
    .catch(error => console.error('Opening the onboarding page failed:', error));
});

chrome.runtime.onStartup.addListener(() => {
  createContextMenus();
  ensurePdfPollAlarm().catch(() => {});
  ensureCacheSweepAlarm();
});

// 快捷键（Alt+A 翻译整页、Alt+T 双语 / 仅译文、Alt+W 翻译整个页面）。分派表和
// 每一项的实现在 ./commands.js；监听必须在 worker 入口顶层同步注册，所以只有这一行
// 留在这里。
chrome.commands.onCommand.addListener((command, tab) => {
  runCommand(command, tab).catch(error => console.error('Shortcut failed:', command, error));
});

// 三个翻译处理函数的次序一样：缺 Key 就回话；然后先把关附加说明
// （PromptAddenda.validate —— 内容脚本造不出不合法的附加说明，走到这里只能是
// 缺陷，所以抛、不截断），再计字数、调模型（计数在 ai-translate.js 里）。

// Handle single text translation
async function handleTranslate(text, targetLang, mode, addenda) {
  const settings = await chrome.storage.sync.get(defaultSettings);

  const missingKey = missingApiKeyMessage(settings);
  if (missingKey) {
    return { error: missingKey };
  }

  try {
    globalThis.PromptAddenda.validate(addenda);
    const effectiveLang = targetLang || getEffectiveTargetLang(settings);
    const result = await translateTextWithMode(text, effectiveLang, settings, mode === 'word', addenda);
    return result;
  } catch (error) {
    console.error('Translation error:', error);
    return { error: apiErrorMessage(error, settings) };
  }
}

// Handle batch translation
async function handleBatchTranslate(texts, targetLang, addenda) {
  const settings = await chrome.storage.sync.get(defaultSettings);

  const missingKey = missingApiKeyMessage(settings);
  if (missingKey) {
    return { error: missingKey };
  }

  try {
    globalThis.PromptAddenda.validate(addenda);
    const effectiveLang = targetLang || getEffectiveTargetLang(settings);
    const translations = await translateBatchWithAI(texts, effectiveLang, settings, addenda);
    return { translations };
  } catch (error) {
    console.error('Batch translation error:', error);
    return { error: apiErrorMessage(error, settings) };
  }
}

// Handle fast batch translation with delimiter
async function handleBatchTranslateFast(texts, targetLang, delimiter = '|||', addenda) {
  const settings = await chrome.storage.sync.get(defaultSettings);

  const missingKey = missingApiKeyMessage(settings);
  if (missingKey) {
    return { error: missingKey };
  }

  try {
    globalThis.PromptAddenda.validate(addenda);
    const effectiveLang = targetLang || getEffectiveTargetLang(settings);
    const translations = await translateBatchFastWithAI(texts, effectiveLang, settings, delimiter, addenda);
    return { translations };
  } catch (error) {
    console.error('Fast batch translation error:', error);
    return { error: apiErrorMessage(error, settings) };
  }
}
