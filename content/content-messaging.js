// AI Translator Content Script Messaging
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
      console.log('AI Translator: Received message', message.type, message);
      switch (message.type) {
        case 'TRANSLATE_PAGE':
          if (ctx.translatePage) {
            ctx.translatePage();
          }
          break;
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
            console.error('AI Translator: Context menu translation failed', error);
          });
          break;
        }
        case 'OCR_TRANSLATE_IMAGE':
          // BYO-key vision OCR. Guarded by its own switch — a click can race a
          // switch-off, same as the comic entries.
          if (!settings.enableImageOcrTranslation) break;
          if (ctx.startImageOcrTranslation) {
            ctx.startImageOcrTranslation({
              srcUrl: message.srcUrl,
              targetLang: message.targetLang
            });
          }
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
          console.log('AI Translator: Settings updated, showFloatBall changed from', prevShowFloatBall, 'to', settings.showFloatBall);
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
          if ('enableYoutubeCaptionTranslation' in message.settings) {
            if (message.settings.enableYoutubeCaptionTranslation) {
              if (ctx.setupVideoCaptionTranslation) ctx.setupVideoCaptionTranslation();
            } else if (ctx.stopVideoCaptionTranslation) {
              ctx.stopVideoCaptionTranslation();
            }
          }
          break;
        case 'TOGGLE_FLOAT_BALL':
          console.log('AI Translator: TOGGLE_FLOAT_BALL received, show =', message.show);
          // 只有当值确实改变时才更新，避免无效的切换
          if (settings.showFloatBall !== message.show) {
            settings.showFloatBall = message.show;
            if (ctx.updateFloatBallVisibility) {
              ctx.updateFloatBallVisibility();
            }
          }
          break;
      }
    });
  }

  ctx.setupMessageListener = setupMessageListener;
})();
