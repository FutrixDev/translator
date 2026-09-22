// Blab Translation — the content script's default settings, in one place.
//
// These are the values a content script runs with before storage answers, the
// defaults it asks `chrome.storage.sync.get()` for, and the values it falls
// back to when that read throws. Those three lists have to agree: a key present
// in one and missing from another is a setting whose default depends on which
// code path ran, which is not a thing anyone can reason about. They used to be
// three literals in content-bootstrap.js and had already drifted —
// `showTranslationOnly` was in two of them.
//
// The service worker and the options page keep their own lists on purpose.
// background.js needs the API credentials; options.js needs every form
// control's initial value. Those are different sets, not copies of this one,
// and folding them in would mean one object whose entries are right for one
// reader and wrong for another.
//
// **But where two of the lists name the same key, they must give it the same
// value**, and that is now asserted rather than assumed
// (`test/unit/default-settings-agree.test.mjs`). It is not a hypothetical: this
// table said `targetLang: 'zh-CN'` while the worker's said `''`, so on a fresh
// install a French user got a context menu offering Français and a page
// translated into Chinese. Empty means "follow the browser" everywhere now —
// see shared/target-lang.js.
//
// Loaded as a classic script by the content scripts, so it publishes onto the
// global object rather than using `export`.
(function (root) {
  'use strict';

  function isMacPlatform() {
    const nav = root.navigator;
    if (!nav) return false;
    const platform = (nav.userAgentData && nav.userAgentData.platform) || nav.platform || '';
    return /mac/i.test(platform);
  }

  // ⌘ on a Mac, Ctrl everywhere else — the modifier that does not already mean
  // something else while dragging out a selection.
  const DEFAULT_SELECTION_HOTKEY = isMacPlatform() ? 'Meta' : 'Control';

  const CONTENT_DEFAULTS = Object.freeze({
    // 默认走浏览器内置翻译；只有用户在设置里显式切到 'ai' 才用自己的接口。
    translationEngine: 'builtin',
    // 内置引擎顶不住时要不要改走用户自己的接口。默认不：那是在花他的钱，
    // 而选内置引擎本来就是在选“零费用”。'allow-ai' 才回退。
    engineFallback: 'local-only',
    enableSelection: true,
    enableHoverTranslation: true,
    hoverTranslationHotkey: 'Shift',
    selectionTranslationHotkey: DEFAULT_SELECTION_HOTKEY,
    selectionTranslationMode: 'inline',
    showFloatBall: true,
    // 名字说的是“检测语言”，做的事是“已经是目标语言的段落就别译了”。
    skipTargetLanguageText: true,
    showTranslationOnly: false,
    // 「没开原字幕的视频，替我把原字幕点开」。默认关，而且是本轮唯一保留的独立
    // 开关：它**改动播放器自己的状态**（YouTube 的 CC 按钮、一条 <track> 的
    // mode），而其余的自动化只是往页面里插我们自己的节点。有副作用的那一件事要
    // 单独同意 —— 关着的时候，字幕这一面的行为和从前一模一样。
    autoEnableCaptions: false,
    enableImageOcrTranslation: true,
    // The hover shortcut button defaults on, matching background.js
    // defaultSettings. (There is no auto-translate setting: OCR is always
    // recognise-first, with a Translate button in the popup.)
    enableImageOcrHoverButton: true,
    enableComicTranslation: false,
    comicTargetLang: '',
    enablePdfTranslation: true,
    pdfTargetLang: '',
    // Superseded by captionDisplayMode; still read so a profile that only
    // has the old boolean migrates instead of resetting to bilingual.
    //
    // captionDisplayMode's default is '' — unset — and has to stay that way:
    // CaptionCore.resolveCaptionDisplay() only consults the boolean when the
    // mode is not one of the three, so pre-filling a mode here would satisfy
    // the resolver before it ever looked, and the migration would be dead on
    // every real path. The resolver's own default is bilingual.
    showYoutubeOriginalCaption: true,
    captionDisplayMode: '',
    captionTranslationPosition: 'below',
    captionPlayerButton: true,
    youtubeCaptionFontColor: '#ffffff',
    youtubeCaptionBgColor: '#080808',
    youtubeCaptionBgOpacity: 82,
    youtubeCaptionPosXPct: null,
    youtubeCaptionPosYPct: null,
    youtubeCaptionWidthPct: null,
    youtubeCaptionScale: 1,
    // 空 = 跟随浏览器语言，解析在 shared/target-lang.js。这里曾经写死 'zh-CN'，
    // 而 worker 那张表写的是空 —— 同一次全新安装，两边译成两门语言。
    targetLang: '',
    // 界面语言，与翻译目标语言彻底分开。'' = 跟随浏览器。
    uiLanguage: '',
    theme: 'light',

    // —— 自动翻译 ——
    // 一个总开关，一份站点名单，一份语言名单。三者的判定顺序全在
    // shared/site-rules.js 的 decide() 里，这里只放数据。
    //
    // 默认开：这个功能的价值是「打开外文页面就已经是中文的」，默认关等于
    // 让每个用户先发现它、再打开它，绝大多数人两件事都不会做。关掉它的成本
    // 是一次点击，而且总开关一关，整条链路（发现层、调度层、询问条）全停。
    autoTranslate: true,
    // 站点级覆盖：{ 'example.com': 'always' | 'never' }。域名是归一化后的主机名，
    // 查找时会向上逐级找父域（见 SiteRules.decide）。
    siteRules: Object.freeze({}),
    // 只自动翻这些源语言；空数组 = 不限制。装的是语言基码（'en'、'ja'）。
    autoTranslateLangs: Object.freeze([]),
    // 每个域名追问过几次：{ 'example.com': 2 }。问到 3 次还没换来一次「翻译」
    // 就永远不再问（content/content-auto-status.js 的 MAX_ASKS）。
    //
    // 跟着 sync 走是有意的：用户在笔记本上把某个站点的追问条关掉三次，换台机器
    // 不该从头再问三次 —— 他已经回答过了，只是用的是关掉它这个动作。
    siteAskCount: Object.freeze({})
  });

  /**
   * A fresh, writable copy. `chrome.storage.sync.get()` is given this object and
   * `Object.assign` writes over it, so handing out the frozen original would
   * either throw or leak one caller's values into the next.
   */
  function contentDefaults() {
    const defaults = Object.assign({}, CONTENT_DEFAULTS);
    // 容器型默认值必须各给一份新的。Object.assign 复制的是引用：共用同一个 {}
    // 时，一处往 siteRules 里记一条站点规则，同一页面里其他拿到「默认值」的地方
    // 就跟着有了这条规则 —— 而且 CONTENT_DEFAULTS 是冻的，严格模式下直接抛。
    defaults.siteRules = {};
    defaults.autoTranslateLangs = [];
    defaults.siteAskCount = {};
    return defaults;
  }

  root.DefaultSettings = { DEFAULT_SELECTION_HOTKEY, CONTENT_DEFAULTS, contentDefaults };
})(globalThis);
