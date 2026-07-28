// AI Translator Content Script Messaging
(function() {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT;
  if (!ctx) return;

  const { settings, state } = ctx;
  const applyTheme = ctx.applyTheme;

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
          if (ctx.isSelectionInlineEnabled && ctx.isSelectionInlineEnabled() && ctx.showInlineSelectionTranslation) {
            ctx.showInlineSelectionTranslation(message.text, message.translation, state.lastSelectionElement, state.lastSelectionRange);
          } else if (ctx.showTranslationResult) {
            ctx.showTranslationResult(message.text, message.translation, message.phonetic, message.isWord);
          }
          break;
        case 'COMIC_TRANSLATE_IMAGE':
          // Paid, account-backed path — deliberately not gated on the text
          // translation toggles above, which only govern the BYO-key features.
          if (ctx.startComicTranslation) {
            ctx.startComicTranslation({
              srcUrl: message.srcUrl,
              pageUrl: message.pageUrl,
              targetLang: message.targetLang
            });
          }
          break;
        case 'COMIC_TRANSLATE_PAGE':
          // No srcUrl: the popup has no cursor to go on, so the content script
          // picks the page(s) on screen itself.
          if (ctx.startComicPageTranslation) {
            ctx.startComicPageTranslation({
              pageUrl: message.pageUrl,
              targetLang: message.targetLang
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
              if (ctx.setupYouTubeCaptionTranslation) ctx.setupYouTubeCaptionTranslation();
            } else if (ctx.stopYouTubeCaptionTranslation) {
              ctx.stopYouTubeCaptionTranslation();
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
