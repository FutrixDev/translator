// Blab Translation Content Script Bootstrap
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

  if (!ctx.settings) {
    ctx.settings = DefaultSettings.contentDefaults();
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
    // 界面语言，不是翻译目标语言：把一页译成日文不该把悬浮球菜单也变成日文。
    const uiLang = getUILanguage(ctx.settings.uiLanguage);
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
      const result = await chrome.storage.sync.get(DefaultSettings.contentDefaults());
      Object.assign(ctx.settings, result);
      ctx.applyTheme(ctx.settings.theme);
    } catch (error) {
      console.error('Blab Translation: Failed to load settings', error);
      Object.assign(ctx.settings, DefaultSettings.contentDefaults());
    }
    // After both branches, so the fallback above cannot leave PDF translation
    // on either. Comic and PDF translation need an account this device may not
    // have; applied once here so every consumer of ctx.settings — the float
    // ball menu, the comic overlay — reads a switch that is true only when the
    // feature can actually run. See shared/account-gate.js.
    await AccountGate.applyAccountGate(ctx.settings);
    console.log('Blab Translation: Settings loaded', {
      showFloatBall: ctx.settings.showFloatBall,
      theme: ctx.settings.theme
    });
  };

  // The settings the video-caption engine reacts to, in one place so the
  // storage listener and the popup's message cannot drift apart.
  // 字幕翻不翻已经不在这张表里：它跟着主开关和站点规则走，而那两个键的变化由
  // 调度层广播给字幕这一面（content-video-captions.js 的 subscribeToGate）。
  // 搁在这里再应一次，等于同一件事有两条路进来。
  const CAPTION_SETTING_KEYS = [
    'autoEnableCaptions',
    'captionDisplayMode',
    'captionTranslationPosition',
    'captionPlayerButton',
    // 目标语言不是字幕自己的设置，可它换了之后字幕这一面必须重算：译文表按目标语
    // 言做键（换语言＝换一套键），而「这条轨道本来就是目标语言」也跟着翻篇。少了
    // 这一行，观众在视频页换目标语言，字幕要等到播放器下一次重交轨道才反应过来。
    'targetLang',
  ];
  ctx.captionSettingKeys = CAPTION_SETTING_KEYS;

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
        console.log('Blab Translation: Storage changed, showFloatBall:', changes.showFloatBall.oldValue, '->', changes.showFloatBall.newValue);
        if (ctx.updateFloatBallVisibility) {
          ctx.updateFloatBallVisibility();
        }
      }

      if (changes.showInputTranslateChip && changes.showInputTranslateChip.newValue === false) {
        // 关掉开关的人多半正看着那颗芯片。等下一次敲键才消失，看着像没生效。
        if (ctx.hideInputTranslateChip) ctx.hideInputTranslateChip();
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

      if (changes.showTranslationOnly || changes.translationStyle) {
        // 已翻译的页面上实时生效：样式换一个属性，仅译文开 → 藏原文、关 → 放回来。
        // 四个入口（设置页、popup、悬浮球、Alt+T）都只写存储，都从这里落到页面。
        if (ctx.applyTranslationDisplay) ctx.applyTranslationDisplay();
      }

      // One entry point for the caption keys: they only change what is drawn
      // (whether we translate at all is the gate, and that comes from the
      // scheduler). Options and the in-player menu both land here, so a change
      // on one surface shows up live on the other.
      if (CAPTION_SETTING_KEYS.some((key) => key in changes)) {
        if (ctx.applyCaptionSettings) ctx.applyCaptionSettings();
      }

      // 自动翻译关心哪些键、每个键该怎么反应，只有调度层知道（那份名单在
      // content-auto-translate.js 的 RESTART_KEYS，会随功能增减）。整包递过去，
      // 在这里摊成一串 if 等于把那份判断抄一遍 —— 抄本迟早和正本对不上。
      if (ctx.autoTranslate) ctx.autoTranslate.onSettingsChanged(changes);
    });
  };

  ctx.init = async function() {
    console.log('Blab Translation: Initializing...');
    try {
      await ctx.loadSettings();
      // 还没有译文，这一遍只为把 <html> 上的样式 / 仅译文两个属性写对。每个 frame
      // 都要跑：子 frame 里的译文同样要有样式、同样受仅译文控制。
      if (ctx.applyTranslationDisplay) ctx.applyTranslationDisplay();
      if (ctx.setupSelectionListener) ctx.setupSelectionListener();
      if (ctx.setupHoverTranslation) ctx.setupHoverTranslation();
      if (ctx.setupImageOcrHoverButton) ctx.setupImageOcrHoverButton();
      if (ctx.setupInputTranslateChip) ctx.setupInputTranslateChip();
      if (ctx.setupMessageListener) ctx.setupMessageListener();
      ctx.setupStorageListener();
      if (ctx.createFloatBall) ctx.createFloatBall();
      // 设置读回来之后才有意义：自动翻译的第一个判断就是总开关。不 await ——
      // 它内部该异步的地方自己会安排，卡住初始化只会让悬浮球晚出来。
      if (ctx.setupAutoTranslate) ctx.setupAutoTranslate();
      // 字幕排在调度层后面，因为字幕翻不翻由它说了算：字幕这一面一装起来就去订
      // 阅（subscribeToGate），顺序反了就得等下一次状态变化才上闸 —— 而一个判完
      // 就定下来不再动的页面（黑名单、语言相同、要追问）永远等不到那一次。
      if (ctx.setupVideoCaptionTranslation) ctx.setupVideoCaptionTranslation();
      // 调度层先建起来，画面层才有东西可订阅：setupAutoStatus() 订阅时会立刻收到
      // 一次当前状态，顺序反了就得等下一次状态变化才画得出来。
      if (ctx.setupAutoStatus) ctx.setupAutoStatus();
      // 条子由 setupAutoStatus() 那一层画，所以排在它后面。PDF 文档上没有正文
      // 可翻，这条是那一页唯一能办事的入口。
      if (ctx.setupPdfPrompt) ctx.setupPdfPrompt();
      // 不 await：探语言对要跑几次 IPC，没必要卡住后面的初始化。
      if (ctx.setupLanguagePackPrefetch) ctx.setupLanguagePackPrefetch();
      // After loadSettings, because it checks whether the comic feature is on.
      // A redraw outlives the page that ordered it, so this is where a reader
      // who paged ahead and came back gets their translation put back.
      if (ctx.resumeComicJobs) ctx.resumeComicJobs();
      console.log('Blab Translation: Initialization complete, showFloatBall =', ctx.settings.showFloatBall);
    } catch (error) {
      console.error('Blab Translation: Initialization failed', error);
    }
  };
})();
