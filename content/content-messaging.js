// Blab Translation Content Script Messaging
(function() {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT;
  if (!ctx) return;

  const { settings, state } = ctx;
  const applyTheme = ctx.applyTheme;

  // 把一条译文送到划词翻译的展示层。SHOW_TRANSLATION（旧的 background 直推结果）
  // 和 TRANSLATE_SELECTION_TEXT（content script 自己译）共用这一处，避免两边跑偏。
  function displaySelectionTranslation({ text, translation, phonetic, isWord }) {
    if (ctx.isSelectionInlineEnabled && ctx.isSelectionInlineEnabled() && ctx.showInlineSelectionTranslation) {
      ctx.showInlineSelectionTranslation(text, translation, state.lastSelectionElement, state.lastSelectionRange);
    } else if (ctx.showTranslationResult) {
      ctx.showTranslationResult(text, translation, phonetic);
    }
  }

  function setupMessageListener() {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      console.log('Blab Translation: Received message', message.type, message);
      switch (message.type) {
        case 'TRANSLATE_PAGE':
          if (ctx.translatePage) {
            ctx.translatePage();
          }
          break;
        case 'TOGGLE_PAGE_TRANSLATION':
          // popup 那一行和悬浮球那一下点的是同一个动作，所以走同一个函数：
          // 「有译文就收起来，没有就译」这条规则只能有一个地方说了算。
          sendResponse(ctx.togglePageTranslation ? { action: ctx.togglePageTranslation() } : null);
          break;
        case 'SET_AUTO_PAUSED':
          if (ctx.autoTranslate) {
            if (message.paused) ctx.autoTranslate.pauseCurrentPage();
            else ctx.autoTranslate.resumeCurrentPage();
          }
          sendResponse(ctx.autoTranslate ? ctx.autoTranslate.state() : null);
          break;
        case 'AUTO_PAGE_STATE': {
          // popup 的三行动作全从这一次往返里画。分三条消息问的话，用户在中间那
          // 一刻点了悬浮球，popup 就会拿着三个互相矛盾的答案画出一张脸。
          //
          // host 也从这里回：popup 自己的 location 是 chrome-extension://，
          // 站点规则该写在哪个键上只有页面知道。
          const auto = ctx.autoTranslate ? ctx.autoTranslate.state() : null;
          sendResponse({
            host: location.hostname,
            // 「这一页永远不自己翻」也只有页面答得了，而且得单独答一句：总开关
            // 关着的时候 auto.reason 是 GLOBAL_OFF，把黑名单整个遮住了，popup
            // 照着那个 reason 判就会把一个点不动的开关画成能点的。
            blocked: globalThis.SiteRules.isBlocklisted(location.hostname, location.pathname),
            hasTranslations: ctx.hasPageTranslations ? ctx.hasPageTranslations() : false,
            translationsVisible: state.translationsVisible !== false,
            auto
          });
          break;
        }
        case 'PROBE_ENGINE':
          // popup 不能自己探内置引擎：它自己的 isSecureContext 恒为 true，
          // 而目标页可能是 http://，两个 realm 给出的答案根本不是一回事。
          // 唯一能如实回答的只有已经注入这一页的 content script。
          //
          // 这是整个监听器里唯一一条要异步回话的消息，所以只有它 return true
          // ——其余分支返回 undefined，通道立即关闭，保持原样。
          if (!ctx.builtinTranslator) {
            sendResponse(null);
            return;
          }
          ctx.builtinTranslator.probeStatus()
            .then(sendResponse)
            .catch(() => sendResponse(null));
          return true;
        case 'SHOW_TRANSLATION':
          // 右键菜单翻译选中文本的结果显示
          if (!settings.enableSelection) break;
          displaySelectionTranslation({
            text: message.text,
            translation: message.translation,
            phonetic: message.phonetic,
            isWord: message.isWord
          });
          break;
        case 'TRANSLATE_SELECTION_TEXT': {
          // 右键菜单翻译：background 只转达意图，翻译在这里做，
          // 这样才能走到内置引擎（Translator 在 service worker 里不存在）。
          if (!settings.enableSelection) break;
          const selectionText = message.text || '';
          if (!selectionText.trim()) break;
          ctx.requestTranslation({
            type: 'TRANSLATE',
            text: selectionText,
            targetLang: message.targetLang,
            mode: 'text'
          }).then((response) => {
            // 出错时把错误文案顶到同一个展示位。以前这条路失败是只往控制台打一行、
            // 页面上毫无反应，用户只会以为右键翻译坏了。
            displaySelectionTranslation({
              text: selectionText,
              translation: response?.error || response?.translation || '',
              phonetic: response?.phonetic || '',
              isWord: response?.isWord === true
            });
          }).catch((error) => {
            console.error('Blab Translation: Context menu translation failed', error);
          });
          break;
        }
        case 'OCR_TRANSLATE_IMAGE':
          // Image OCR. Guarded by its own switch — a click can race a
          // switch-off, same as the comic entries.
          if (!settings.enableImageOcrTranslation) break;
          if (ctx.startImageOcrTranslation) {
            ctx.startImageOcrTranslation({
              srcUrl: message.srcUrl,
              targetLang: message.targetLang,
              translate: message.translate,
              // Whole image, or the area the user is about to draw.
              selectRegion: message.selectRegion === true
            });
          }
          break;
        // Local-OCR progress, relayed by the service worker on behalf of the
        // offscreen document, which cannot address a tab itself.
        case 'OCR_PROGRESS':
          if (ctx.handleOcrProgress) ctx.handleOcrProgress(message);
          break;
        case 'COMIC_TRANSLATE_IMAGE':
          // Paid, account-backed path — deliberately not gated on the text
          // translation toggles above, which only govern the BYO-key features.
          if (ctx.startComicTranslation) {
            ctx.startComicTranslation({
              srcUrl: message.srcUrl,
              pageUrl: message.pageUrl,
              targetLang: message.targetLang,
              mode: message.mode
            });
          }
          break;
        case 'COMIC_TRANSLATE_PAGE':
          // No srcUrl: the popup has no cursor to go on, so the content script
          // picks the page(s) on screen itself.
          if (ctx.startComicPageTranslation) {
            ctx.startComicPageTranslation({
              pageUrl: message.pageUrl,
              targetLang: message.targetLang,
              mode: message.mode
            });
          }
          break;
        case 'CLEAR_INLINE_TRANSLATION_CONTEXT':
          if (ctx.clearInlineTranslationContext) {
            ctx.clearInlineTranslationContext();
          }
          break;
        case 'SETTINGS_UPDATED':
          // Only update showFloatBall if explicitly provided in the message
          const prevShowFloatBall = settings.showFloatBall;
          Object.assign(settings, message.settings);
          // If showFloatBall was not in the message, preserve the previous value
          if (!('showFloatBall' in message.settings)) {
            settings.showFloatBall = prevShowFloatBall;
          }
          console.log('Blab Translation: Settings updated, showFloatBall changed from', prevShowFloatBall, 'to', settings.showFloatBall);
          if (ctx.updateFloatBallVisibility) {
            ctx.updateFloatBallVisibility();
          }
          if (message.settings.theme) {
            applyTheme(message.settings.theme);
          }
          if ('enableHoverTranslation' in message.settings && !message.settings.enableHoverTranslation) {
            if (ctx.clearHoverTranslation) ctx.clearHoverTranslation();
          }
          if ('enableSelection' in message.settings && !message.settings.enableSelection) {
            if (ctx.clearSelectionTranslation) ctx.clearSelectionTranslation();
            if (ctx.hideSelectionButton) ctx.hideSelectionButton();
          }
          if ('selectionTranslationMode' in message.settings && message.settings.selectionTranslationMode !== 'inline') {
            if (ctx.clearSelectionTranslation) ctx.clearSelectionTranslation();
          }
          if ((ctx.captionSettingKeys || []).some((key) => key in message.settings)) {
            if (ctx.applyCaptionSettings) ctx.applyCaptionSettings();
          }
          break;
      }
    });
  }

  ctx.setupMessageListener = setupMessageListener;
})();
