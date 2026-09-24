// Blab Translation 视频字幕 —— 什么时候接管这段视频
//
// 页面上出现了 <video>、它长出了字幕轨、站点闸门开着、provider 认得这个播放器——
// 这些条件凑齐才轮到翻译。这一份盯着这些条件变化，并把结论同步给播放器里那个按钮。
//
// 看视频这件事本身是无条件盯着的：闸门关着的时候引擎照样跟着页面走，否则那个「开」
// 的按钮就没有地方画。被闸门挡住的只有「接上 provider 去读字幕」这一半。
(function() {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT;
  if (!ctx) return;
  const core = globalThis.CaptionCore;
  if (!core) return;
  // 这一族共用的架子，说明见 content/content-video-captions.js 顶上。
  const caps = (ctx.captions = ctx.captions || {});
  const state = caps.state;

  const MEDIA_EVENTS = ['loadedmetadata', 'loadeddata', 'canplay', 'play'];
  let watching = false;

  function onMediaEvent(event) {
    const el = event.target;
    if (!el || el.tagName !== 'VIDEO') return;
    watchTrackList(el);
    if (!state.provider) {
      tryActivate();
      syncControls();
      return;
    }
    if (state.provider.onMediaChanged) state.provider.onMediaChanged(el);
    caps.ensureVideoListener();
    syncControls();
  }

  function onTrackListEvent() {
    if (!state.provider) {
      tryActivate();
      syncControls();
      return;
    }
    if (state.provider.onMediaChanged) state.provider.onMediaChanged();
    syncControls();
  }

  // A <track> added after load, or an in-band track the player just created,
  // shows up here — video.textTracks is the only place that change is announced.
  function watchTrackList(video) {
    if (video.__aiCaptionTrackWatch) return;
    let list;
    try { list = video.textTracks; } catch (e) { return; }
    if (!list || !list.addEventListener) return;
    video.__aiCaptionTrackWatch = true;
    list.addEventListener('addtrack', onTrackListEvent);
    list.addEventListener('removetrack', onTrackListEvent);
    // Fires when a track's mode changes — i.e. the viewer picked a subtitle
    // language in the player's own control.
    list.addEventListener('change', onTrackListEvent);
  }

  function startWatching() {
    if (watching) return;
    watching = true;
    for (const type of MEDIA_EVENTS) {
      document.addEventListener(type, onMediaEvent, true);
    }
    for (const video of document.querySelectorAll('video')) watchTrackList(video);
    syncControls();
  }

  function stopWatching() {
    if (!watching) return;
    watching = false;
    stopControlsHeartbeat();
    for (const type of MEDIA_EVENTS) {
      document.removeEventListener(type, onMediaEvent, true);
    }
    // The per-video track-list listeners stay: they are keyed off
    // __aiCaptionTrackWatch, so removing them would only mean re-adding them if
    // the feature is switched back on, and while it is off they reach
    // tryActivate() and stop at the inactive state.
  }

  function tryActivate() {
    if (!state.active || state.provider) return false;
    const provider = core.selectProvider(ctx.captionProviders || []);
    if (!provider) return false;
    state.provider = provider;
    provider.attach(caps.engineApi);
    return true;
  }

  // ------------------------------------------------------ in-player controls
  // The button is not part of translating: it has to be there when the feature
  // is off, because turning it on is what it is for. So it is driven from the
  // page's *candidate* provider — the one that says it could supply cues here —
  // rather than from an attached one.
  const CONTROLS_HEARTBEAT_MS = 1500;

  // ------------------------------------------------------------- 闸门
  // 字幕翻译没有自己的开关：它和正文一样由主开关加站点规则说了算
  // （docs/plans/2026-09-19-auto-translation-prd.md §5.4.1、同名 ux-design §2.5）。
  // 一个默认关着、藏在设置页第二张卡里的独立开关，做得再好也等于不存在；而两个
  // 开关意味着用户在一个视频站上点了「不再翻译」，字幕却照翻不误。
  //
  // 问的是 siteRefused 而不是「这个站点开着自动翻」。视频站没上过内置 always 名
  // 单，整页那一面在那里的结论多半是 ask，siteAuto 永远是 false —— 拿它当闸门，
  // 字幕在它最该工作的地方一次也不会工作。要问的是「这个站点是不是被明令拒绝
  // 的」，那句话由 shared/site-rules.js 的 REFUSALS 定义。

  /**
   * 调度层那份快照，取不到就是 null。下面两句话都从这一份里读，省得各问各的 ——
   * 「调度层还没起来」和「state() 抛了（页面正在拆）」在这里合成同一个答案：
   * 什么都不知道。谁把「不知道」当成什么，由问的那一方各自决定。
   */
  function autoSnapshot() {
    const auto = ctx.autoTranslate;
    if (!auto || typeof auto.state !== 'function') return null;
    try {
      return auto.state() || null;
    } catch (e) {
      return null;
    }
  }

  /**
   * 「这个站点开着自动翻」。**闸门不问这一句**（见上），菜单第一行问它：那一行
   * 写的是站点规则，和 popup 上那一行是同一句话、同一份实现。拿闸门去画它，会
   * 在一个 ask 站点上画成「开」，而用户按下去写进去的是一条永久的 never。
   */
  function siteAuto() {
    const snap = autoSnapshot();
    return !!(snap && snap.siteAuto);
  }

  /** 「这个站点不许我们自己动手」。问不到就当是拒绝。 */
  function siteRefused() {
    const snap = autoSnapshot();
    // 说不准的时候宁可不翻：这一步会把页面上的文字发给第三方，而「还没判出来」
    // 和「判出来是不许」在用户那里没有区别 —— 后者错一次是把不该发的发出去了。
    // 所以是 `!== false` 而不是 `=== true`：字段缺了也算说不准。
    return !snap || snap.siteRefused !== false;
  }

  let gateSubscribed = false;

  /**
   * 闸门变了就重来一遍。
   *
   * 订阅而不是轮询：调度层每次重判都会广播，而总开关和站点规则都在它的
   * RESTART_KEYS 里 —— 用户在 popup 上把这个站点关掉，字幕当场就停。订阅的那一
   * 刻它还会先回调一次当前状态，所以这里不必自己补第一下。
   *
   * ctx.init 里字幕排在调度层后面（content-bootstrap.js），这里才拿得到它。
   */
  function subscribeToGate() {
    if (gateSubscribed) return;
    const auto = ctx.autoTranslate;
    if (!auto || typeof auto.onStateChange !== 'function') return;
    // 先立旗再订阅：onStateChange 会当场回调一次，而回调会走回
    // applyCaptionSettings()，旗子晚一行就是一次无限递归。
    gateSubscribed = true;
    auto.onStateChange(() => {
      // 一秒里能广播好几次（IDLE→RUNNING→IDLE），真正翻篇了才动。两句话各管各
      // 的：闸门变了要重来一遍，站点规则变了要把菜单那一行重画。
      if (siteRefused() === state.enabled || siteAuto() !== state.siteAuto) {
        ctx.applyCaptionSettings();
      }
    });
  }

  /** The provider whose player this is, attached or not. */
  function candidateProvider() {
    return state.provider || core.selectProvider(ctx.captionProviders || []);
  }

  /**
   * 「不再自动翻译 {site}」那一行露不露 —— 播放器菜单和 popup 画的是同一句话，
   * 只有这一份。
   *
   * 它补的是闸门和站点规则之间那一整片 ask：一个没设过规则的视频站上，闸门开
   * 着（没被明令拒绝），字幕照翻；而第一行画的是 siteAuto，印着「关」。想让字
   * 幕停下，从前得先把那一行点开（写 always）再点关（写 never）。这一行一下写
   * never，走的仍是 SiteRules.setSiteAuto —— 和悬浮球那一行同一句话、同一次写入。
   *
   * 第一行不改画法：拿闸门去画它，它在这里会印成「开」，而按下去写的是一条永久
   * 的 never，popup 上同一行按下去写的却是 always（见 siteAuto()）。
   *
   * 三个条件缺一不露：
   *   - 有 provider：这一页有字幕可翻（YouTube 上是整个站点，别处是一段带轨道的
   *     视频）。没有字幕的 ask 站点上，这一行说的是一件没在发生的事；
   *   - 闸门开着而站点规则没说「自动」：已经 always 的，第一行本身就是关的路；
   *     已经被拒绝的，字幕本来就不翻；
   *   - 规则写得进去：file:// 上存不下键，setSiteAuto 会抛。
   *
   * 闸门和站点规则由调用方递进来，不在这里再问一遍：菜单那一路拿的是和第一行同
   * 一拍的 state，popup 那一路拿的是和同一次回话里 auto 快照同一拍的答案 ——
   * 各自那一次画面里只有一个答案。
   */
  function stopSiteOffered(provider, gateOpen, siteAutoOn) {
    if (!provider || !gateOpen || siteAutoOn) return false;
    const rules = globalThis.SiteRules;
    return !!rules && rules.siteRuleWritable(location.hostname, location.pathname);
  }

  /** popup 那一路（AUTO_PAGE_STATE）问的就是这一句，见 stopSiteOffered()。 */
  ctx.captionStopSiteOffered = function() {
    return stopSiteOffered(candidateProvider(), !siteRefused(), siteAuto());
  };

  // --------------------------------------------- turning the page's own on
  // 「没开原字幕的视频，替我把原字幕点开」。整轮自动化里只有这一件事**改动播放器
  // 自己的状态**，所以它有自己的开关（autoEnableCaptions，默认关），而且有一道只
  // 合不开的闩：见 syncNativeCaptions()。
  //
  // 闸门用的是 siteRefused 而不是「这个站点开着自动翻」。视频站点没上过内置
  // always 名单，整页那一面在那里的结论多半是 ask，siteAuto 永远是 false——拿它
  // 当闸门，这件事在它最该发生的地方一次也不会发生。要问的是「这个站点是不是被
  // 明令拒绝的」，那句话由 shared/site-rules.js 的 REFUSALS 定义。
  function autoEnableAllowed() {
    if (!state.active || state.dismissed) return false;
    if (!caps.getSetting('autoEnableCaptions')) return false;
    if (state.autoEnableBlocked) return false;
    return !siteRefused();
  }

  /**
   * 每个心跳看一眼原字幕开着没有，该开就开，该收手就永远收手。
   *
   * 那道闩是这件事的全部风险所在：观众自己去播放器里把字幕关掉了，我们下一个心跳
   * 又把它点回来——1.5 秒一次，他关不掉。所以**「看见开着」之后再「看见关了」，
   * 就再不自动开第二次**，而且不问是谁开的：他本来就开着、自己关掉，和我们开的、
   * 他关掉，在他眼里是同一件事。
   *
   * sawNativeOn 按视频清（resetForVideo），autoEnableBlocked 按会话留——换一个视频
   * 不算他改了主意，YouTube 自己也是这么记 CC 偏好的。要越过这道闩只有一条路：
   * 菜单里那一项「开启原字幕」，那是他自己按的（ctx.enableNativeCaptions）。
   */
  function syncNativeCaptions() {
    const provider = state.provider;
    if (!provider || !provider.nativeCaptionsState || !provider.enableNativeCaptions) return;
    let on = null;
    try {
      on = provider.nativeCaptionsState();
    } catch (e) {
      return; // 播放器还没搭起来，这一拍什么都不知道，就什么都不做
    }
    if (on === true) {
      state.sawNativeOn = true;
      return;
    }
    // 「说不准」这一拍什么都不做。读成「关着」的代价是下面那道闩：它只要合上就是
    // 一整个会话，而那时观众什么都没做过——控制条晚一拍上来而已。读成「关着」去按
    // 也没有意义：按钮本来就还不在，按了也是按空。
    if (on !== false) return;
    if (state.sawNativeOn) {
      state.sawNativeOn = false;
      state.autoEnableBlocked = true;
      return;
    }
    if (!autoEnableAllowed()) return;
    try {
      // 按成了就**当场**记下「看见开着」。留给下一拍去记，中间这 1.5 秒里观众
      // 把它关掉，下一拍看见的是「关着，而且没落闩」—— 于是又替他开一次，这正
      // 是那道闩要防的事，只不过发生在它合上之前。
      //
      // 按了个空则什么都不记：控制条还没上来、或者这段视频根本没有字幕，都是每
      // 拍一次 querySelector 就能重新问出来的事（canEnableNativeCaptions），记
      // 下来只会让一个会变的答案冻在那里。
      if (provider.enableNativeCaptions()) state.sawNativeOn = true;
    } catch (e) { /* 播放器换了 DOM，下一拍再说 */ }
  }

  /**
   * 「开启原字幕」——菜单里那一项，观众自己按的。
   *
   * 和 syncNativeCaptions 的自动路径共用同一个 provider 方法，但越过闩、也越过
   * autoEnableCaptions 那个开关：他按了，就是他要。
   *
   * @returns {boolean} 有没有按到东西。false = 这段视频没有可开的字幕。
   */
  ctx.enableNativeCaptions = function() {
    const provider = state.provider || candidateProvider();
    if (!provider || !provider.enableNativeCaptions) return false;
    state.autoEnableBlocked = false;
    let answer = false;
    try {
      answer = provider.enableNativeCaptions();
    } catch (e) { /* 播放器换了 DOM，下一拍再说 */ }
    // 按成了就**当场**记下「看见开着」，和自动那一路一个道理，只是这里更不能省：
    // 下面紧接着就是 syncControls()，它会去问 nativeCaptionsState()，而 YouTube 的
    // enableNativeCaptions() 在 button.click() 之后直接答 true，不等 aria-pressed
    // 翻面。那一问要是恰好还读到 false，就落进自动那一路——闩刚被上一行解开、
    // autoEnableCaptions 又开着的话，它会再点一次，把观众刚要的字幕点回去。
    // 就算 aria-pressed 当场就翻了，这一行也还得在：不记的话闩永远合不上，观众在
    // 这 1.5 秒里把字幕关掉，下一拍看见的是「关着，而且没落闩」，照样替他开回来。
    //
    // 按空了则什么都不记。菜单那一行露不露，是 captionStatus() 每一拍现问
    // canEnableNativeCaptions() 问出来的：按钮 disabled 就不摆（那是 YouTube 在
    // 说这段视频没有字幕轨），按钮一旦活过来，那一行自己就回来了。
    if (answer) state.sawNativeOn = true;
    syncControls();
    return !!answer;
  };

  /** The menu's status line: which track we are on, or why there is none. */
  function captionStatus(provider) {
    // 原字幕开着没有。问的是**传进来的这个** provider，不是 isCaptionsEnabled()
    // （那读的是已接上的那个）：功能关着的时候按钮照样在（那正是它的用处），而那
    // 时 state.provider 是 null，拿它去问，一个原字幕开得好好的播放器也会被说成
    // 「还没点开」。默认当它开着——拿不准就不摆那个按钮，宁可少给一条路，不要给一
    // 条按了没反应的。
    let nativeOn = true;
    try {
      nativeOn = !provider || !provider.nativeCaptionsState
        || provider.nativeCaptionsState() !== false;
    } catch (e) { /* 播放器还没搭起来，下一拍再说 */ }

    // 原字幕是关着的。这不是「这段视频没有字幕」——那句话我们说不准——而是「原字幕
    // 还没点开」，菜单据此给的是一个按钮而不是一句死话。
    //
    // 这一问要排在轨道名前面，因为关掉它的那一下不会把上一轮留下的东西抹掉：
    // state.cues 还是满的，provider 手里可能还攥着那条轨道。屏幕上此刻一个字也没
    // 有（handleTimeUpdate 照同一个判断把浮层收了起来），这时报一句「字幕轨：
    // English」是在描述一件屏幕上不存在的事，而那个能把字幕找回来的按钮反倒被它
    // 挡住了——自动开启那一面还记着「是观众自己关的」，不会再替他点，这一行就是
    // 唯一的回头路。
    if (!nativeOn) {
      // 能不能点开，每一拍现问，从不记。按钮 disabled 是 YouTube 在说这段视频没
      // 有字幕轨，那就别摆一个按下去没反应的按钮；可它在播放器加载中也会 disabled
      // 一阵子，记下来就会把这一行藏到换视频为止，而观众再没有别的路回来。
      let canEnable = null;
      try {
        if (provider && provider.canEnableNativeCaptions) {
          canEnable = provider.canEnableNativeCaptions();
        }
      } catch (e) { /* 播放器换了 DOM，下一拍再说 */ }
      if (provider && provider.enableNativeCaptions && canEnable !== false) {
        return { kind: 'needs-native' };
      }
      return { kind: 'none' };
    }

    // 「本来就是目标语言」排在原字幕那一问**后面**。它描述的是这条轨道，而观众关
    // 掉字幕之后屏幕上没有轨道可言——报一句「已经是你要的语言」既没用，又正好把
    // 唯一那条回头路挡住了：自动开启那一面还记着「是他自己关的」，不会再替他点。
    // 和第 9 条（轨道名排在原字幕后面）是同一句话，只是往上又挪了一格。
    if (caps.sameLanguage()) return { kind: 'same-language' };

    // 今日 AI 额度用完了：轨道还在，句子也还在，只是这几句不会再被译出来。报轨道
    // 名等于说「一切正常」，观众只会看见字幕停在原文上而不知道为什么。这一行排在
    // 轨道名前面、原字幕那一问后面 —— 原字幕关着的时候屏幕上本来就没有要译的东西。
    if (state.active && state.budgetSpent) return { kind: 'budget-spent' };

    if (state.cues.length) return { kind: 'track', label: state.trackLabel || state.trackLang };
    let label = '';
    try {
      if (provider && provider.getTrackLabel) label = provider.getTrackLabel() || '';
    } catch (e) { /* a provider probing for DOM that is not there */ }
    if (label) return { kind: 'track', label };
    return { kind: 'none' };
  }

  /**
   * Put the button where this page's provider says it goes, or take it away.
   *
   * Cheap enough to call on a heartbeat, which is what keeps it attached to a
   * player that rebuilds its own control bar between videos.
   */
  function syncControls() {
    const controls = ctx.captionControls;
    if (!controls) return;
    // The heartbeat is what re-docks the button when the player rebuilds its
    // control bar, and a page can reach a video long after settings were
    // applied — YouTube home, then a click through to a watch page. Starting it
    // from here means every route that syncs the controls also keeps them
    // synced; stopWatching() is still the only thing that stops it.
    if (document.querySelector('video')) startControlsHeartbeat();
    // 心跳是替观众开原字幕唯一的驱动：原字幕关着的时候一条 cue 都不会来，
    // handleTimeUpdate 在 !state.cues.length 那一行就返回了，谁也不会问「要不要
    // 替他点开」。
    //
    // 它排在下面那道闸门**前面**，因为它和那个按钮是两件事：观众把播放器里的按
    // 钮藏了，说的是「别在控制条上摆你的图标」，不是「别替我开字幕」——他为后者
    // 专门开过另一个开关。搁在闸门后面，两个设置就被捆成了一个。
    syncNativeCaptions();
    if (caps.getSetting('captionPlayerButton') === false) {
      controls.unmount();
      return;
    }
    // No provider means no subtitle track and no site we know — a bare <video>
    // in an ad or a page background, where an icon of ours would be litter.
    const provider = candidateProvider();
    if (!provider) {
      controls.unmount();
      return;
    }
    let host = null;
    let video = null;
    try {
      if (provider.getControlsHost) host = provider.getControlsHost();
    } catch (e) { /* the player's control bar is not up yet */ }
    try {
      video = provider.getVideo ? provider.getVideo() : document.querySelector('video');
    } catch (e) { /* keep null */ }
    // enabled（闸门）、siteAuto（站点规则）和由这两句推出来的 stopSite 都从这里
    // 过去，而不是让控件自己去读设置或者再问一遍调度层：两边各算一遍就是两个答案。
    controls.sync({
      host,
      video,
      enabled: state.enabled,
      siteAuto: state.siteAuto,
      stopSite: stopSiteOffered(provider, state.enabled, state.siteAuto),
      status: captionStatus(provider),
    });
  }

  function startControlsHeartbeat() {
    if (state.controlsTimer) return;
    state.controlsTimer = setInterval(syncControls, CONTROLS_HEARTBEAT_MS);
  }

  function stopControlsHeartbeat() {
    if (!state.controlsTimer) return;
    clearInterval(state.controlsTimer);
    state.controlsTimer = null;
  }

  // ------------------------------------------------- what providers call in

  // 别的文件要用的，都从这张架子上取。
  Object.assign(caps, {
    siteAuto, siteRefused, startWatching, subscribeToGate, syncControls, tryActivate,
  });
})();
