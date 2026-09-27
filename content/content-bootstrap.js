// Blab Translation Content Script Bootstrap
(function() {
  'use strict';

  // 广告 / 验证码 / 支付 / 登录 / 播放器 frame 不建 ctx（dormant）：后面每个模块都
  // 在 `if (!ctx) return;` 处退出，一个监听都不挂。判定表在 shared/frame-eligibility.js。
  if (!globalThis.FrameEligibility.shouldActivate()) return;

  const ctx = window.AI_TRANSLATOR_CONTENT || {};
  window.AI_TRANSLATOR_CONTENT = ctx;
  // 'top' 画悬浮球、答 popup、执行引擎；'child' 跟着顶层翻（content/frames/）。
  ctx.frameRole = window.top === window ? 'top' : 'child';

  if (!ctx.constants) {
    // 我们自己画的界面根：收集不把它们当正文（page/collect.js），发现层不把它们
    // 的变动当页面变了（content-auto-discover.js）。与 content/css/popup.css
    // 宿主隔离重置里的 :is() 根清单是同一份，由
    // test/unit/host-css-containment.test.mjs 守着不分叉；加一个界面根，两处都要加。
    const ownUi = [
      '.ai-translator-popup',
      '#ai-translator-input-dialog',
      '#ai-translator-float-menu',
      '#ai-translator-float-ball',
      '#ai-translator-float-ball-container',
      '#ai-translator-progress',
      '#ai-translator-selection-btn',
      '#ai-translator-caption-overlay',
      '#ai-translator-caption-controls',
      '#ai-translator-caption-btn',
      '#ai-translator-caption-menu',
      '#ai-translator-ocr-region',
      '#ai-translator-ocr-hover-btn',
      '#ai-translator-input-chip',
      '#ai-translator-auto-bar',
      '#ai-translator-source-peek',
      '#ai-translator-rule-picker'
    ].join(', ');
    ctx.constants = {
      FLOAT_BALL_SIZE: 36,
      EDGE_SNAP_THRESHOLD: 100,
      DOCK_PADDING_FRONT: -6,
      DOCK_PADDING_BACK: 8,
      DOCK_PADDING_VERTICAL: 4,
      MATH_CONTAINER_SELECTOR: 'math, mjx-container, mjx-math, .MathJax, .MathJax_Display, .MathJax_CHTML, .mjx-chtml, .mjx-math, .MJXc-display, .katex, .katex-display, .ltx_Math',
      OWN_UI_SELECTOR: ownUi,
      // 界面根再加上我们插进页面的译文：划词（content-selection.js）不在这些字上
      // 弹「划词翻译」按钮，悬停（hover/blocks.js）不把它们当一块正文去翻。
      OWN_NODES_SELECTOR: `${ownUi}, .ai-translator-inline-block, .ai-translator-hover-translation, .ai-translator-selection-translation`
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

  // 界面语言，不是翻译目标语言：把一页译成日文不该把悬浮球菜单也变成日文。
  // 文案（ctx.t）、语言名（ctx.languageName）和加载态的 lang 标记都问这一处。
  ctx.uiLanguage = function() {
    return getUILanguage(ctx.settings.uiLanguage);
  };

  ctx.t = function(key) {
    return getMessage(key, ctx.uiLanguage());
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

  // Fails closed until loadSettings() has asked.
  ctx.signedIn = false;

  /** 'ready' | 'signed_out' | 'off' for comic or PDF translation — the one way
   *  content code asks, so "turned off" and "not signed in" stay apart. */
  ctx.featureState = function(key) {
    return AccountGate.featureState(ctx.settings, key, ctx.signedIn);
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
    // ctx.settings keeps the raw switches; whether this device has the account
    // comic and PDF translation need is tracked beside them, and the two are
    // only ever combined by ctx.featureState(). See shared/account-gate.js.
    ctx.signedIn = await AccountGate.hasAccount();
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

  // 「一条一个 sync 键」的集合的登记表：{ prefix, onStorageChange }，由各集合的
  // 模块（content/page/custom-rule.js）在 init() 时登记。
  ctx.syncMirrors = [];

  // 把 sync 增量按 ctx.syncMirrors 的前缀分出去，交给各自的 onStorageChange；
  // 返回剩下的（设置键）。一个集合的增量整包交一次，保持它在事件里的顺序。
  function routeSyncMirrors(changes) {
    const mirrors = ctx.syncMirrors;
    if (!mirrors.length) return changes;
    const rest = {};
    const routed = mirrors.map(() => null);
    for (const key of Object.keys(changes)) {
      const at = mirrors.findIndex((mirror) => key.startsWith(mirror.prefix));
      if (at < 0) {
        rest[key] = changes[key];
        continue;
      }
      (routed[at] || (routed[at] = {}))[key] = changes[key];
    }
    routed.forEach((part, at) => {
      if (part) mirrors[at].onStorageChange(part);
    });
    return rest;
  }

  ctx.setupStorageListener = function() {
    chrome.storage.onChanged.addListener((changes, namespace) => {
      // The account token is per device and lives in local storage, and it is
      // half of ctx.featureState(). Signing in or out changes that answer
      // without any sync key moving.
      if (namespace === 'local' && changes[AccountGate.TOKEN_KEY]) {
        ctx.signedIn = !!changes[AccountGate.TOKEN_KEY].newValue;
        return;
      }
      if (namespace !== 'sync') return;

      // 「一条一个 sync 键」的集合（用户站点规则等）不是设置：命中登记表
      // ctx.syncMirrors 里某个前缀的键交给那一项自己的镜像，不进 ctx.settings。
      // 表在事件到达时才读 —— 登记方比这个文件晚加载，这里也不点名任何一个集合。
      changes = routeSyncMirrors(changes);

      Object.keys(changes).forEach((key) => {
        ctx.settings[key] = changes[key].newValue;
      });
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
      }

      if (changes.enableSelection || changes.selectionTrigger) {
        ctx.syncSelectionIcon();
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
      // 本页的用户站点规则：先把请求发出去，和读设置并行（content/page/custom-rule.js）。
      ctx.customRules.init();
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
      // 页面级功能（悬浮球、字幕、状态条、PDF 提示、语言包预取、漫画续跑）只在
      // 顶层；子 frame 只留划词 / 悬停 / 输入框这些作用于 frame 内的，外加跟随
      // 顶层的自动翻译。
      const top = ctx.frameRole === 'top';
      if (top && ctx.createFloatBall) ctx.createFloatBall();
      // 调度器的第一个判断就要用到本站规则钉住的引擎。最多等 1.5 s（SW 冷启动），
      // 放在悬浮球之后，好让悬浮球不跟着等。
      await ctx.customRules.whenReady();
      // 设置读回来之后才有意义：自动翻译的第一个判断就是总开关。不 await ——
      // 它内部该异步的地方自己会安排，卡住初始化只会让悬浮球晚出来。
      if (ctx.setupAutoTranslate) ctx.setupAutoTranslate();
      // 字幕排在调度层后面，因为字幕翻不翻由它说了算：字幕这一面一装起来就去订
      // 阅（subscribeToGate），顺序反了就得等下一次状态变化才上闸 —— 而一个判完
      // 就定下来不再动的页面（黑名单、语言相同、要追问）永远等不到那一次。
      if (top && ctx.setupVideoCaptionTranslation) ctx.setupVideoCaptionTranslation();
      // 调度层先建起来，画面层才有东西可订阅：setupAutoStatus() 订阅时会立刻收到
      // 一次当前状态，顺序反了就得等下一次状态变化才画得出来。
      if (top && ctx.setupAutoStatus) ctx.setupAutoStatus();
      // 条子由 setupAutoStatus() 那一层画，所以排在它后面。PDF 文档上没有正文
      // 可翻，这条是那一页唯一能办事的入口；漫画阅读页上它告诉人快捷键。
      if (top && ctx.setupMediaHints) ctx.setupMediaHints();
      // 不 await：探语言对要跑几次 IPC，没必要卡住后面的初始化。
      if (top && ctx.setupLanguagePackPrefetch) ctx.setupLanguagePackPrefetch();
      // After loadSettings, because it checks whether the comic feature is on.
      // A redraw outlives the page that ordered it, so this is where a reader
      // who paged ahead and came back gets their translation put back.
      if (top && ctx.resumeComicJobs) ctx.resumeComicJobs();
      // 最后一步：顶层此时才答得出指令（自动翻译已订阅好），子 frame 此时才有
      // 设置可判。
      ctx.frames.setup();
      console.log('Blab Translation: Initialization complete, showFloatBall =', ctx.settings.showFloatBall);
    } catch (error) {
      console.error('Blab Translation: Initialization failed', error);
    }
  };
})();
