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
// background.js needs the API credentials and resolves an empty `targetLang`
// against the browser language; options.js needs every form control's initial
// value. Those are different sets, not copies of this one, and folding them in
// would mean one object whose entries are right for one reader and wrong for
// another.
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
    enableYoutubeCaptionTranslation: false,
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
    targetLang: 'zh-CN',
    // 界面语言，与翻译目标语言彻底分开。'' = 跟随浏览器。
    uiLanguage: '',
    theme: 'light'
  });

  /**
   * A fresh, writable copy. `chrome.storage.sync.get()` is given this object and
   * `Object.assign` writes over it, so handing out the frozen original would
   * either throw or leak one caller's values into the next.
   */
  function contentDefaults() {
    return Object.assign({}, CONTENT_DEFAULTS);
  }

  root.DefaultSettings = { DEFAULT_SELECTION_HOTKEY, CONTENT_DEFAULTS, contentDefaults };
})(globalThis);
