// AI Translator Content Script Bootstrap
(function() {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT || {};
  window.AI_TRANSLATOR_CONTENT = ctx;

  if (!ctx.constants) {
    ctx.constants = {
      FLOAT_BALL_SIZE: 36,
      EDGE_SNAP_THRESHOLD: 100,
      DOCK_PADDING_FRONT: -6,
      DOCK_PADDING_BACK: 8,
      DOCK_PADDING_VERTICAL: 4,
      MATH_CONTAINER_SELECTOR: 'math, mjx-container, mjx-math, .MathJax, .MathJax_Display, .MathJax_CHTML, .mjx-chtml, .mjx-math, .MJXc-display, .katex, .katex-display, .ltx_Math',
      TARGET_LANGUAGE_OPTIONS: [
        { value: 'zh-CN', label: '简体中文' },
        { value: 'zh-TW', label: '繁体中文' },
        { value: 'en', label: 'English' },
        { value: 'ja', label: '日本語' },
        { value: 'ko', label: '한국어' },
        { value: 'fr', label: 'Français' },
        { value: 'de', label: 'Deutsch' },
        { value: 'es', label: 'Español' },
        { value: 'pt', label: 'Português' },
        { value: 'ru', label: 'Русский' }
      ]
    };
  }

  function isMacPlatform() {
    const platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
    return /mac/i.test(platform);
  }

  const DEFAULT_SELECTION_HOTKEY = isMacPlatform() ? 'Meta' : 'Control';

  if (!ctx.settings) {
    ctx.settings = {
      enableSelection: true,
      enableHoverTranslation: true,
      hoverTranslationHotkey: 'Shift',
      selectionTranslationHotkey: DEFAULT_SELECTION_HOTKEY,
      selectionTranslationMode: 'inline',
      showFloatBall: true,
      autoDetect: true,
      enableYoutubeCaptionTranslation: false,
      targetLang: 'zh-CN',
      theme: 'light'
    };
  }

  if (!ctx.state) {
    ctx.state = {
      translationPopup: null,
      floatBall: null,
      floatBallContainer: null,
      floatMenu: null,
      inputDialog: null,
      selectionButton: null,
      lastSelectedText: '',
      lastSelectionPos: { x: 0, y: 0 },
      lastSelectionElement: null,
      lastSelectionRange: null,
      isTranslatingPage: false,
      floatBallDragged: false,
      translationsVisible: true,
      translationProgress: { current: 0, total: 0 },
      pageHasBeenTranslated: false,
      translationRequestId: 0,
      selectionTranslationPending: false
    };
  }

  ctx.t = function(key) {
    const uiLang = getUILanguage(ctx.settings.targetLang);
    return getMessage(key, uiLang);
  };

  ctx.isSelectionInlineEnabled = function() {
    return !!(ctx.settings.enableSelection && ctx.settings.selectionTranslationMode === 'inline');
  };

  ctx.applyTheme = function(theme) {
    document.documentElement.setAttribute('data-ai-translator-theme', theme);
  };

  ctx.isExtensionContextAvailable = function() {
    return typeof chrome !== 'undefined' && chrome?.runtime?.sendMessage;
  };

  ctx.isExtensionContextInvalidated = function(error) {
    if (!ctx.isExtensionContextAvailable()) return true;
    if (!error) return false;
    const message = String(error?.message || error);
    return message.includes('Extension context invalidated');
  };

  ctx.loadSettings = async function() {
    try {
      const result = await chrome.storage.sync.get({
        enableSelection: true,
        enableHoverTranslation: true,
        hoverTranslationHotkey: 'Shift',
        selectionTranslationHotkey: DEFAULT_SELECTION_HOTKEY,
        selectionTranslationMode: 'inline',
        showFloatBall: true,
        autoDetect: true,
        enableYoutubeCaptionTranslation: false,
        targetLang: 'zh-CN',
        theme: 'light'
      });
      Object.assign(ctx.settings, result);
      ctx.applyTheme(ctx.settings.theme);
    } catch (error) {
      console.error('AI Translator: Failed to load settings', error);
      Object.assign(ctx.settings, {
        enableSelection: true,
        enableHoverTranslation: true,
        hoverTranslationHotkey: 'Shift',
        selectionTranslationHotkey: DEFAULT_SELECTION_HOTKEY,
        selectionTranslationMode: 'inline',
        showFloatBall: true,
        autoDetect: true,
        enableYoutubeCaptionTranslation: false,
        targetLang: 'zh-CN',
        theme: 'light'
      });
    }
    console.log('AI Translator: Settings loaded', {
      showFloatBall: ctx.settings.showFloatBall,
      theme: ctx.settings.theme
    });
  };

  ctx.setupStorageListener = function() {
    chrome.storage.onChanged.addListener((changes, namespace) => {
      if (namespace !== 'sync') return;

      Object.keys(changes).forEach((key) => {
        ctx.settings[key] = changes[key].newValue;
      });

      if (changes.showFloatBall) {
        console.log('AI Translator: Storage changed, showFloatBall:', changes.showFloatBall.oldValue, '->', changes.showFloatBall.newValue);
        if (ctx.updateFloatBallVisibility) {
          ctx.updateFloatBallVisibility();
        }
      }

      if (changes.theme) {
        ctx.applyTheme(ctx.settings.theme);
      }

      if (changes.enableHoverTranslation && !ctx.settings.enableHoverTranslation) {
        if (ctx.clearHoverTranslation) ctx.clearHoverTranslation();
      }

      if (changes.enableSelection && !ctx.settings.enableSelection) {
        if (ctx.clearSelectionTranslation) ctx.clearSelectionTranslation();
        if (ctx.hideSelectionButton) ctx.hideSelectionButton();
      }

      if (changes.selectionTranslationMode && ctx.settings.selectionTranslationMode !== 'inline') {
        if (ctx.clearSelectionTranslation) ctx.clearSelectionTranslation();
      }

      if (changes.enableYoutubeCaptionTranslation) {
        if (ctx.settings.enableYoutubeCaptionTranslation) {
          if (ctx.setupYouTubeCaptionTranslation) ctx.setupYouTubeCaptionTranslation();
        } else if (ctx.stopYouTubeCaptionTranslation) {
          ctx.stopYouTubeCaptionTranslation();
        }
      }
    });
  };

  ctx.init = async function() {
    console.log('AI Translator: Initializing...');
    try {
      await ctx.loadSettings();
      if (ctx.setupSelectionListener) ctx.setupSelectionListener();
      if (ctx.setupHoverTranslation) ctx.setupHoverTranslation();
      if (ctx.setupMessageListener) ctx.setupMessageListener();
      ctx.setupStorageListener();
      if (ctx.createFloatBall) ctx.createFloatBall();
      if (ctx.setupYouTubeCaptionTranslation) ctx.setupYouTubeCaptionTranslation();
      console.log('AI Translator: Initialization complete, showFloatBall =', ctx.settings.showFloatBall);
    } catch (error) {
      console.error('AI Translator: Initialization failed', error);
    }
  };
})();
