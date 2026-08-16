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
      // 默认走浏览器内置翻译；只有用户在设置里显式切到 'ai' 才用自己的接口。
      translationEngine: 'builtin',
      enableSelection: true,
      enableHoverTranslation: true,
      hoverTranslationHotkey: 'Shift',
      selectionTranslationHotkey: DEFAULT_SELECTION_HOTKEY,
      selectionTranslationMode: 'inline',
      showFloatBall: true,
      autoDetect: true,
      enableYoutubeCaptionTranslation: false,
      enableImageOcrTranslation: true,
      // Auto-translate after recognition and the hover shortcut button: both
      // off by default, matching background.js defaultSettings.
      ocrTranslate: false,
      enableImageOcrHoverButton: false,
      enableComicTranslation: false,
      comicTargetLang: '',
      enablePdfTranslation: true,
      pdfTargetLang: '',
      showYoutubeOriginalCaption: true,
      youtubeCaptionFontColor: '#ffffff',
      youtubeCaptionBgColor: '#080808',
      youtubeCaptionBgOpacity: 82,
      youtubeCaptionPosXPct: null,
      youtubeCaptionPosYPct: null,
      youtubeCaptionWidthPct: null,
      youtubeCaptionScale: 1,
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
        translationEngine: 'builtin',
        enableSelection: true,
        enableHoverTranslation: true,
        hoverTranslationHotkey: 'Shift',
        selectionTranslationHotkey: DEFAULT_SELECTION_HOTKEY,
        selectionTranslationMode: 'inline',
        showFloatBall: true,
        autoDetect: true,
        showTranslationOnly: false,
        enableYoutubeCaptionTranslation: false,
        enableImageOcrTranslation: true,
        ocrTranslate: false,
        enableImageOcrHoverButton: false,
        enableComicTranslation: false,
        comicTargetLang: '',
        enablePdfTranslation: true,
        pdfTargetLang: '',
        showYoutubeOriginalCaption: true,
        youtubeCaptionFontColor: '#ffffff',
        youtubeCaptionBgColor: '#080808',
        youtubeCaptionBgOpacity: 82,
        youtubeCaptionPosXPct: null,
        youtubeCaptionPosYPct: null,
        youtubeCaptionWidthPct: null,
        youtubeCaptionScale: 1,
        targetLang: 'zh-CN',
        theme: 'light'
      });
      Object.assign(ctx.settings, result);
      ctx.applyTheme(ctx.settings.theme);
    } catch (error) {
      console.error('AI Translator: Failed to load settings', error);
      Object.assign(ctx.settings, {
        translationEngine: 'builtin',
        enableSelection: true,
        enableHoverTranslation: true,
        hoverTranslationHotkey: 'Shift',
        selectionTranslationHotkey: DEFAULT_SELECTION_HOTKEY,
        selectionTranslationMode: 'inline',
        showFloatBall: true,
        autoDetect: true,
        showTranslationOnly: false,
        enableYoutubeCaptionTranslation: false,
        enableImageOcrTranslation: true,
        ocrTranslate: false,
        enableImageOcrHoverButton: false,
        enableComicTranslation: false,
        comicTargetLang: '',
        enablePdfTranslation: true,
        pdfTargetLang: '',
        showYoutubeOriginalCaption: true,
        youtubeCaptionFontColor: '#ffffff',
        youtubeCaptionBgColor: '#080808',
        youtubeCaptionBgOpacity: 82,
        youtubeCaptionPosXPct: null,
        youtubeCaptionPosYPct: null,
        youtubeCaptionWidthPct: null,
        youtubeCaptionScale: 1,
        targetLang: 'zh-CN',
        theme: 'light'
      });
    }
    // After both branches, so the fallback above cannot leave PDF translation
    // on either. Comic and PDF translation need an account this device may not
    // have; applied once here so every consumer of ctx.settings — the float
    // ball menu, the comic overlay — reads a switch that is true only when the
    // feature can actually run. See shared/account-gate.js.
    await AccountGate.applyAccountGate(ctx.settings);
    console.log('AI Translator: Settings loaded', {
      showFloatBall: ctx.settings.showFloatBall,
      theme: ctx.settings.theme
    });
  };

  ctx.setupStorageListener = function() {
    chrome.storage.onChanged.addListener((changes, namespace) => {
      // The account token is per device and lives in local storage, and it is
      // half of whether comic and PDF translation are on. Signing in or out
      // therefore changes the answer without any sync key moving — re-derive it
      // from what sync already holds rather than mirror the token here.
      if (namespace === 'local' && changes[AccountGate.TOKEN_KEY]) {
        ctx.loadSettings();
        return;
      }
      if (namespace !== 'sync') return;

      Object.keys(changes).forEach((key) => {
        ctx.settings[key] = changes[key].newValue;
      });
      // A switch synced down from a device that IS signed in must not turn the
      // feature on here. Not awaited — the listener is synchronous and the only
      // readers are menus built on a later user gesture.
      if (AccountGate.ACCOUNT_FEATURE_KEYS.some((key) => key in changes)) {
        AccountGate.applyAccountGate(ctx.settings);
      }

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

      if (changes.showTranslationOnly) {
        // 已翻译的页面上实时生效：开 → 藏原文；关 → 原文放回来
        if (ctx.applyTranslationOnlyMode) ctx.applyTranslationOnlyMode();
      }

      if (changes.enableYoutubeCaptionTranslation) {
        if (ctx.settings.enableYoutubeCaptionTranslation) {
          if (ctx.setupVideoCaptionTranslation) ctx.setupVideoCaptionTranslation();
        } else if (ctx.stopVideoCaptionTranslation) {
          ctx.stopVideoCaptionTranslation();
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
      if (ctx.setupImageOcrHoverButton) ctx.setupImageOcrHoverButton();
      if (ctx.setupMessageListener) ctx.setupMessageListener();
      ctx.setupStorageListener();
      if (ctx.createFloatBall) ctx.createFloatBall();
      if (ctx.setupVideoCaptionTranslation) ctx.setupVideoCaptionTranslation();
      // 不 await：探语言对要跑几次 IPC，没必要卡住后面的初始化。
      if (ctx.setupLanguagePackPrefetch) ctx.setupLanguagePackPrefetch();
      // After loadSettings, because it checks whether the comic feature is on.
      // A redraw outlives the page that ordered it, so this is where a reader
      // who paged ahead and came back gets their translation put back.
      if (ctx.resumeComicJobs) ctx.resumeComicJobs();
      console.log('AI Translator: Initialization complete, showFloatBall =', ctx.settings.showFloatBall);
    } catch (error) {
      console.error('AI Translator: Initialization failed', error);
    }
  };
})();
