// Blab Translation 视频字幕 —— 共用状态
//
// 这一族的状态只有一份，住在这里：开关、当前 provider、这条轨道译到哪儿、字幕框的
// 位置。还有几个所有人都要问的小问题——现在该显示成什么样、目标语是哪门、这一句和
// 原文是不是同一种语言。
//
// **这一份必须排在其余几份前面**：别的文件开头那句 `const state = caps.state;` 是
// 装载时取值的，这是这一族里唯一一处认 manifest 顺序的地方。函数之间没有这个问题，
// 它们都走架子、调用时才取。
(function() {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT;
  if (!ctx) return;
  const core = globalThis.CaptionCore;
  if (!core) return;
  // 这一族共用的架子，说明见 content/content-video-captions.js 顶上。
  const caps = (ctx.captions = ctx.captions || {});
  const langTags = globalThis.LangTags;

  const DELIMITER = '⟪⟫⟪⟫⟪⟫';
  const RETRY_COOLDOWN_MS = 8000;

  // 一次往前译多远。从前是「整条轨道，一次译完」——一小时的讲座在观众看到第二句
  // 之前就把全片发去了云端，而其中绝大多数他不会看到（他会跳、会关、会只听开头
  // 三分钟）。按播放头往前开一扇窗，窗随播放头走：看到哪里，译到哪里往前五分钟。
  const WINDOW_MS = 5 * 60 * 1000;
  // 「只看原文」那一档：屏幕上此刻一个译文字都没在用。仍然预译，但窗小得多——
  // 押的是「他可能马上切回双语」，而不是「他会把整片看完」。
  const NATIVE_WINDOW_MS = 30 * 1000;

  const state = {
    // `enabled` is the user's switch; `active` is whether a translating
    // provider is attached. They used to be the same thing, and that is why the
    // in-player button could not exist: with the feature off nothing watched
    // the page, so there was nowhere to draw the way to turn it on. Now the
    // watcher runs regardless and only the translating half is gated.
    enabled: false,
    // 「这个站点开着自动翻」。**不是** enabled：闸门问的是「没被明令拒绝」，中
    // 间隔着一大片 ask。菜单第一行画的是这一句（和 popup 上那一行同一句话），
    // 闸门是另一句，见下面的 siteRefused() / siteAuto()。
    siteAuto: false,
    active: false,
    provider: null,
    overlay: null,
    block: null,
    rawCues: [],
    cues: [],
    batches: [],
    cueCache: new Map(),
    pendingKeys: new Set(),
    failedUntil: new Map(),
    trackId: '',
    trackLang: '',
    trackLabel: '',
    dismissed: false,
    translating: false,
    // 上一批是不是因为今日 AI 额度用完被拒的（引擎的预算闸回的 budgetSpent）。
    // 菜单的状态行靠它说「今日 AI 额度已用完」，而不是让观众对着一行没译的字幕
    // 猜。下一批译成了就清掉 —— 额度调高了、过了零点、或者引擎换回了内置，都是
    // 在下一次重试（RETRY_COOLDOWN_MS 之后）自己好的，不需要谁来通知这里。
    budgetSpent: false,
    lastTriggerMs: 0,
    // 「原字幕此刻是开着的吗」的上一次观察，和「别再替他开了」那道闩。
    // 两者的生命周期不同，见 syncNativeCaptions() / resetForVideo()。
    sawNativeOn: false,
    autoEnableBlocked: false,
    video: null,
    lastNowMs: 0,
    controlsTimer: null,
  };

  // Storage keys still say "youtube" because they are user data: this used to
  // be a YouTube-only feature, and renaming them would silently discard every
  // existing user's caption position, size and colours.
  function getSetting(key) {
    return (ctx.settings || {})[key];
  }

  /**
   * What is on screen, from the settings alone — which line shows, in which
   * order, and whether we draw at all. shared/caption-core.js owns the rule so
   * the options preview and the in-player menu resolve it the same way.
   */
  function currentDisplay() {
    return core.resolveCaptionDisplay(ctx.settings || {});
  }

  /**
   * 我们此刻往哪门语言译，**整码**。
   *
   * 整码而不是基码，字幕这一面两处都靠它：缓存键（getCueKey）和「本来就是目标语
   * 言」（sameLanguage）。zh-CN 和 zh-TW 的基码都是 zh，可它们是两套字——按基码
   * 做键，观众从简体切到繁体，已经译过的那些句子的键一个不变，整段视频继续放着
   * 简体，而且因为键「对」上了，它们永远不会被重译掉；按基码判同语言，一条繁体
   * 轨道配简体目标会被当成「已经是你要的语言」，一个字也不译。
   */
  function getTargetLang() {
    const target = ctx.getEffectiveTargetLang ? ctx.getEffectiveTargetLang() : '';
    return String(target || '').trim().toLowerCase();
  }

  /**
   * 这条轨道本来就是目标语言，不必译。
   *
   * 现算，不记。记下来的那一版是在 ingestTrack() 里写的，而它一个视频只跑一次：
   * 观众看到一半把目标语言从英文换成中文，那条英文轨道的「不必译」就冻在那里，
   * 之后每一次 handleTimeUpdate() 都在这道早退上返回，整段视频再不会开译——除非
   * 播放器恰好重新交一次轨道进来。会变的答案不留副本，和 canEnableNativeCaptions
   * 是同一条。
   *
   * 比的是**整码**，不是基码：zh-CN 和 zh-TW 的基码都是 zh，可它们是两套字，而
   * 「繁转简」正是观众要的那一件事。判定在 shared/lang-tags.js（isSameLanguage），
   * 和整页翻译、和自动翻译的决策层问的是同一个函数——和 getCueKey 的理由一模一样，
   * 缓存键当初就是为这件事从基码改成整码的。
   */
  function sameLanguage() {
    return langTags.isSameLanguage(state.trackLang || '', getTargetLang());
  }

  function getVideoElement() {
    if (state.provider && state.provider.getVideo) return state.provider.getVideo();
    return document.querySelector('video');
  }

  // 「拿不准」在这里读作「没开」：读不出播放器的状态就不往它身上画。
  // 三种答案的由来见 provider 的 nativeCaptionsState()。
  function isCaptionsEnabled() {
    return !!state.provider && state.provider.nativeCaptionsState() === true;
  }

  function setNativeCaptionsHidden(hidden) {
    if (state.provider && state.provider.setNativeCaptionsHidden) {
      state.provider.setNativeCaptionsHidden(hidden);
    }
  }

  // ---------------------------------------------------------------- overlay

  // 别的文件要用的，都从这张架子上取。
  Object.assign(caps, {
    DELIMITER, NATIVE_WINDOW_MS, RETRY_COOLDOWN_MS, WINDOW_MS, currentDisplay, getSetting,
    getTargetLang, getVideoElement, isCaptionsEnabled, sameLanguage, setNativeCaptionsHidden,
    state,
  });
})();
