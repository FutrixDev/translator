// Blab Translation background — 右键菜单与工具栏图标菜单。
//
// 这里有三件事，而且必须是三件：**建**（createContextMenus，只在安装和启动时跑
// 一次，条目的 title 是占位的英文）、**改标题**（refreshContextMenuTitles，界面
// 语言变了就重来一遍）、**改可见性**（refresh*Visibility，开关或登录状态变了就
// 重来一遍）。Chrome 不认「按当前语言重建一次」这种做法：removeAll 之后到 create
// 回来之间菜单是空的，用户正好右键就什么也没有。

import '../i18n/messages.js';
import '../shared/account-gate.js';
import { defaultSettings, uiLanguageOf, getEffectiveTargetLang } from './settings.js';
import { getGatedSettings } from './feature-gate.js';
import * as pdfClient from './pdf-client.js';
import { isLikelyPdfUrl, pdfFileNameFromUrl, runPdfUrlJob } from './pdf-jobs.js';
import { notifyPdfNotAPdf, notifyPdfRunning, notifyPdfStarted } from './pdf-notify.js';

const MENU_IDS = {
  translateSelection: 'translate-selection',
  translatePage: 'translate-page',
  translateComicImage: 'translate-comic-image',
  ocrTranslateImage: 'ocr-translate-image',
  ocrTranslateImageRegion: 'ocr-translate-image-region',
  colorizeComicImage: 'colorize-comic-image',
  translatePdfLink: 'translate-pdf-link',
  translatePdfPage: 'translate-pdf-page',
  translatePdfAction: 'translate-pdf-action',
  translatePdfLocalAction: 'translate-pdf-local-action',
  removeInlineTranslation: 'remove-inline-translation',
};

// The menu titles are UI chrome, so they follow the UI language — not the
// language the user is translating *into*, which is what this used to read.
function getContextMenuTitle(key, uiLang) {
  if (typeof globalThis.getMessage === 'function') {
    return globalThis.getMessage(key, uiLang);
  }
  return key;
}

async function refreshContextMenuTitles() {
  const settings = await chrome.storage.sync.get(defaultSettings);
  const uiLang = uiLanguageOf(settings);

  chrome.contextMenus.update(MENU_IDS.translateSelection, {
    title: getContextMenuTitle('contextTranslateSelection', uiLang),
  });
  chrome.contextMenus.update(MENU_IDS.translatePage, {
    title: getContextMenuTitle('contextTranslatePage', uiLang),
  });
  chrome.contextMenus.update(MENU_IDS.translateComicImage, {
    title: getContextMenuTitle('contextTranslateComic', uiLang),
  });
  chrome.contextMenus.update(MENU_IDS.ocrTranslateImage, {
    title: getContextMenuTitle('contextOcrImage', uiLang),
  });
  chrome.contextMenus.update(MENU_IDS.ocrTranslateImageRegion, {
    title: getContextMenuTitle('contextOcrImageRegion', uiLang),
  });
  chrome.contextMenus.update(MENU_IDS.colorizeComicImage, {
    title: getContextMenuTitle('contextColorizeComic', uiLang),
  });
  chrome.contextMenus.update(MENU_IDS.translatePdfLink, {
    title: getContextMenuTitle('contextTranslatePdfLink', uiLang),
  });
  chrome.contextMenus.update(MENU_IDS.translatePdfPage, {
    title: getContextMenuTitle('contextTranslatePdfPage', uiLang),
  });
  // The toolbar-icon entries deliberately read the same as the popup's two
  // buttons — they are the same two actions, reachable without opening it.
  chrome.contextMenus.update(MENU_IDS.translatePdfAction, {
    title: getContextMenuTitle('pdfTranslateThis', uiLang),
  });
  chrome.contextMenus.update(MENU_IDS.translatePdfLocalAction, {
    title: getContextMenuTitle('pdfTranslateLocal', uiLang),
  });
  chrome.contextMenus.update(MENU_IDS.removeInlineTranslation, {
    title: getContextMenuTitle('contextRemoveInlineTranslation', uiLang),
  });
}

function createContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_IDS.translateSelection,
      title: 'Translate Selection',
      contexts: ['selection']
    });

    chrome.contextMenus.create({
      id: MENU_IDS.translatePage,
      title: 'Translate Page',
      contexts: ['page']
    });

    // Only on images. This is the paid, account-backed path — see comic-client.js
    // — so it is deliberately a separate entry from the text menus above rather
    // than another mode of "Translate Page". Created hidden and revealed only
    // when the feature is switched on: someone who never wants to pay should
    // not have a paid action sitting in the menu of every image they right-click.
    chrome.contextMenus.create({
      id: MENU_IDS.translateComicImage,
      title: 'Translate This Comic',
      contexts: ['image'],
      visible: false
    });

    // OCR is the free sibling of the comic entry: it reads the text out of any
    // image, locally by default. Gated only by its settings switch (no
    // account), hidden when switched off so the image menu stays as small as
    // the user asked for. The entry says "recognize", not "translate" —
    // translating is a separate, optional step the popup offers afterwards.
    chrome.contextMenus.create({
      id: MENU_IDS.ocrTranslateImage,
      title: 'Recognize Image Text',
      contexts: ['image'],
      visible: false
    });

    // The same recognition aimed at part of the image: the content script puts
    // a picker over it and the crop rides along with the request. A separate
    // entry rather than a modifier on the one above, because a modifier is
    // undiscoverable — and the two answer different questions ("what does this
    // say" vs "what does *that bit* say").
    chrome.contextMenus.create({
      id: MENU_IDS.ocrTranslateImageRegion,
      title: 'OCR a Region You Draw',
      contexts: ['image'],
      visible: false
    });

    // Colorization rides the same account-backed pipeline, gated by the same
    // setting — a second product on the same image, not a second feature flag.
    chrome.contextMenus.create({
      id: MENU_IDS.colorizeComicImage,
      title: 'Colorize This Comic',
      contexts: ['image'],
      visible: false
    });

    // The PDF entries are the same account-backed, paid pattern as the comic
    // ones: created hidden, revealed only when the feature is switched on.
    // targetUrlPatterns cannot express ".pdf before the query string", so the
    // click handler re-checks with isLikelyPdfUrl before spending anything.
    chrome.contextMenus.create({
      id: MENU_IDS.translatePdfLink,
      title: 'Translate Linked PDF',
      contexts: ['link'],
      targetUrlPatterns: [
        '*://*/*.pdf', '*://*/*.pdf?*', '*://*/*.pdf#*',
        '*://*/*.PDF', '*://*/*.PDF?*',
        '*://arxiv.org/pdf/*', '*://*.arxiv.org/pdf/*'
      ],
      visible: false
    });

    chrome.contextMenus.create({
      id: MENU_IDS.translatePdfPage,
      title: 'Translate This PDF',
      contexts: ['page'],
      documentUrlPatterns: [
        '*://*/*.pdf', '*://*/*.pdf?*', '*://*/*.pdf#*',
        '*://*/*.PDF', '*://*/*.PDF?*',
        '*://arxiv.org/pdf/*', '*://*.arxiv.org/pdf/*',
        'file:///*.pdf'
      ],
      visible: false
    });

    // Chrome's built-in PDF viewer renders the document inside its own
    // extension frame, and a third-party extension's contexts:['page'] entry
    // can never match there — which is why right-clicking an open PDF offers
    // nothing, and why translatePdfPage above only ever fires on pages that
    // merely *link* like a PDF. The toolbar icon's own menu is not subject to
    // that: it is the entry point that actually works while reading a PDF.
    chrome.contextMenus.create({
      id: MENU_IDS.translatePdfAction,
      title: 'Translate This PDF',
      contexts: ['action'],
      visible: false
    });

    chrome.contextMenus.create({
      id: MENU_IDS.translatePdfLocalAction,
      title: 'Translate a Local PDF…',
      contexts: ['action'],
      visible: false
    });

    chrome.contextMenus.create({
      id: MENU_IDS.removeInlineTranslation,
      title: 'Remove Translation',
      contexts: ['all'],
      visible: false
    });

    refreshContextMenuTitles();
    refreshComicMenuVisibility();
    refreshPdfMenuVisibility();
    refreshOcrMenuVisibility();
  });
}

/**
 * Show or hide the comic entry. Called on every menu rebuild and whenever the
 * setting or the account changes, so the menu never outlives the preference —
 * or the sign-in — that justified it.
 *
 * Re-read rather than handed the new value: the answer depends on the switch
 * AND the token, so a changed switch is only half of it.
 */
async function refreshComicMenuVisibility() {
  const visible = (await getGatedSettings()).enableComicTranslation;
  chrome.contextMenus.update(MENU_IDS.translateComicImage, { visible: !!visible })
    // The menu is gone during a rebuild; the rebuild itself will re-apply this.
    .catch(() => {});
  chrome.contextMenus.update(MENU_IDS.colorizeComicImage, { visible: !!visible })
    .catch(() => {});
}

/**
 * Same rebuild-and-on-change contract as the comic/PDF entries, but judged on
 * the raw switch alone: OCR runs locally or on the user's own API key, not on
 * an account allowance, so the account gate has no say here.
 */
async function refreshOcrMenuVisibility() {
  const settings = await chrome.storage.sync.get(defaultSettings);
  const visible = !!settings.enableImageOcrTranslation;
  // The two entries are the same feature aimed at a whole image or at part of
  // one, so they appear and disappear together.
  for (const id of [MENU_IDS.ocrTranslateImage, MENU_IDS.ocrTranslateImageRegion]) {
    chrome.contextMenus.update(id, { visible }).catch(() => {});
  }
}

/** Same contract as refreshComicMenuVisibility, for the PDF entries. */
async function refreshPdfMenuVisibility() {
  const visible = (await getGatedSettings()).enablePdfTranslation;
  chrome.contextMenus.update(MENU_IDS.translatePdfLink, { visible: !!visible })
    .catch(() => {});
  chrome.contextMenus.update(MENU_IDS.translatePdfPage, { visible: !!visible })
    .catch(() => {});
  chrome.contextMenus.update(MENU_IDS.translatePdfAction, { visible: !!visible })
    .catch(() => {});
  chrome.contextMenus.update(MENU_IDS.translatePdfLocalAction, { visible: !!visible })
    .catch(() => {});
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === MENU_IDS.translateSelection && info.selectionText) {
    // 翻译动作交给 content script，而不是像以前那样在这里译完把结果推过去。
    // 内置引擎的 Translator 接口是 [Exposed=Window, SecureContext]，service worker
    // 里根本不存在；只有 content script 能按当前引擎设置正确分流（内置 / 自定义接口）。
    // 这里只负责把“用户点了右键翻译”这件事转达过去。
    const settings = await chrome.storage.sync.get(defaultSettings);
    chrome.tabs.sendMessage(tab.id, {
      type: 'TRANSLATE_SELECTION_TEXT',
      text: info.selectionText,
      targetLang: getEffectiveTargetLang(settings)
    });
  } else if (info.menuItemId === MENU_IDS.translatePage) {
    chrome.tabs.sendMessage(tab.id, { type: 'TRANSLATE_PAGE' });
  } else if (info.menuItemId === MENU_IDS.translateComicImage ||
             info.menuItemId === MENU_IDS.colorizeComicImage) {
    const settings = await chrome.storage.sync.get(defaultSettings);
    // Hiding the menu is what normally prevents this, but a click can race a
    // switch-off, and this one costs money — so the setting is checked here too.
    if (!settings.enableComicTranslation) return;
    // The content script owns the whole job from here: it finds the <img>,
    // shows progress, and drives the poll loop. Polling from the page rather
    // than the worker is not a style choice — a service worker is torn down
    // after ~30s idle, and a page redraw routinely runs longer than that.
    chrome.tabs.sendMessage(tab.id, {
      type: 'COMIC_TRANSLATE_IMAGE',
      mode: info.menuItemId === MENU_IDS.colorizeComicImage ? 'colorize' : 'translate',
      srcUrl: info.srcUrl,
      pageUrl: info.pageUrl || (tab && tab.url) || '',
      targetLang: settings.comicTargetLang || getEffectiveTargetLang(settings)
    });
  } else if (info.menuItemId === MENU_IDS.ocrTranslateImage ||
             info.menuItemId === MENU_IDS.ocrTranslateImageRegion) {
    const settings = await chrome.storage.sync.get(defaultSettings);
    if (!settings.enableImageOcrTranslation) return;
    // The content script owns the UI (the area picker, popup, progress, errors)
    // and step 2, the optional translation. It asks back via OCR_IMAGE for step
    // 1, which must run here: the page's CSP can block a content-script fetch,
    // the API endpoint is cross-origin to every page, and the local engine
    // lives in an offscreen document only this context can open.
    chrome.tabs.sendMessage(tab.id, {
      type: 'OCR_TRANSLATE_IMAGE',
      srcUrl: info.srcUrl,
      // Which rectangle to read is a question only the page can answer — the
      // worker never sees the image on screen — so it is asked there and comes
      // back on the OCR_IMAGE request.
      selectRegion: info.menuItemId === MENU_IDS.ocrTranslateImageRegion,
      targetLang: getEffectiveTargetLang(settings),
      // Always recognise-first: the popup stops at the recognised text and
      // offers a Translate button for step 2. Explicit false, because the
      // content script treats an absent flag as the old translate-too path.
      translate: false
    });
  } else if (info.menuItemId === MENU_IDS.translatePdfLocalAction) {
    chrome.tabs.create({ url: chrome.runtime.getURL('pdf/upload.html') });
  } else if (info.menuItemId === MENU_IDS.translatePdfLink ||
             info.menuItemId === MENU_IDS.translatePdfPage ||
             info.menuItemId === MENU_IDS.translatePdfAction) {
    const settings = await chrome.storage.sync.get(defaultSettings);
    // Same racing-click guard as the comic entries: this costs money.
    if (!settings.enablePdfTranslation) return;
    const url = info.menuItemId === MENU_IDS.translatePdfLink
      ? info.linkUrl
      : (info.pageUrl || (tab && tab.url) || '');
    if (!isLikelyPdfUrl(url)) {
      // The toolbar entry is always there, whatever the tab is showing, so it
      // is the one click that can legitimately land on a non-PDF — and it has
      // to say so rather than do nothing.
      if (info.menuItemId === MENU_IDS.translatePdfAction) notifyPdfNotAPdf();
      return;
    }
    // file:// can't be fetched from the worker — hand local PDFs to the
    // upload page's file picker instead (PR #26 review).
    if (url.startsWith('file:')) {
      chrome.tabs.create({ url: chrome.runtime.getURL('pdf/upload.html') });
      return;
    }
    // Unlike comics there is no content-script UI to hand off to — the Chrome
    // PDF viewer admits no content scripts — so the worker owns the job and
    // reports through notifications and the popup's task list.
    const fileName = pdfFileNameFromUrl(url);
    // Resolved here rather than inside the create so a second click on the same
    // PDF can be recognised as one: the id is per-URL and stable.
    const operationId = await pdfClient.getOrCreateUrlOperationId(url);
    const records = await pdfClient.listJobRecords();
    const running = records.find(r => r.operationId === operationId &&
      (r.status === 'queued' || r.status === 'running'));
    if (running) {
      notifyPdfRunning(running.fileName || fileName);
      return;
    }
    // Before the await, not after: the whole point is that the click stops
    // looking like it did nothing.
    notifyPdfStarted(fileName);
    await runPdfUrlJob({ url, operationId, fileName, pageUrl: info.pageUrl || '' });
  } else if (info.menuItemId === MENU_IDS.removeInlineTranslation) {
    chrome.tabs.sendMessage(tab.id, { type: 'CLEAR_INLINE_TRANSLATION_CONTEXT' });
  }
});


// 菜单跟着设置走：语言变了改标题，开关变了改可见性。图标主题那一路在 icon.js
// 自己听自己的 —— 两个监听器互不相干，MV3 允许注册多个。
chrome.storage.onChanged.addListener((changes, namespace) => {
  // 标题读两样东西，所以两样都要听：界面语言（uiLanguage，菜单这句话本身用哪门
  // 语言说）和目标语言（targetLang，说的是「译成 X」里的那个 X）。少听前者的后果
  // 不是没刷新那么轻——内容脚本和 popup 都当场跟着界面语言改了，只有右键菜单还是
  // 旧的那门语言，要等 service worker 下次醒来才对得上。
  if (namespace === 'sync'
      && (changes.uiLanguage || changes.targetLang || changes.targetLangSetByUser)) {
    refreshContextMenuTitles();
  }
  if (namespace === 'sync' && changes.enableComicTranslation) {
    refreshComicMenuVisibility();
  }
  if (namespace === 'sync' && changes.enablePdfTranslation) {
    refreshPdfMenuVisibility();
  }
  if (namespace === 'sync' && changes.enableImageOcrTranslation) {
    refreshOcrMenuVisibility();
  }
  // Both entries are gated on the account as well as the switch, so signing in
  // or out has to re-run the same check. Without this a sign-out leaves menu
  // entries for two features this device can no longer run.
  if (namespace === 'local' && changes[AccountGate.TOKEN_KEY]) {
    refreshComicMenuVisibility();
    refreshPdfMenuVisibility();
  }
});

export { MENU_IDS, createContextMenus, refreshContextMenuTitles };
