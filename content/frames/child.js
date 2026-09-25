// Blab Translation — 整页翻译进 iframe：子 frame 这一边
//
// 子 frame 没有悬浮球、没有状态条、不答 popup（content-bootstrap.js 的 init 按
// ctx.frameRole 裁掉了），它只做三件事：
//
//   1. 跟着顶层的指令翻（指令的说明见 content/frames/top.js 顶上）：
//      - 自动：content-auto-translate.js 的 resolve() 改问 ctx.frameDecision；
//      - 手动：顶层每点一次「翻译整页」，这里静默跑一轮（不画进度条）；
//      - 显隐：顶层藏译文，这里一起藏。
//   2. 引擎请求交给顶层执行（ctx.requestTranslation 在这里被覆写）；
//   3. 每轮结束汇报一次，顶层据此回答「这一页翻过没有」、替手动轮报错。
//
// 所有来往都经服务工作者的中继（background/frame-relay.js），消息名都以 FRAME_
// 开头。
(function() {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT;
  if (!ctx || ctx.frameRole !== 'child') return;

  const frames = (ctx.frames = ctx.frames || {});
  const { state } = ctx;

  // 顶层最近一次的指令。null = 还没联系上顶层：此时一律不翻。
  let directive = null;
  // 这个文档看到过的最大 manualEpoch。第一次拿到指令时只记下、不补跑 —— 晚到的
  // frame（顶层早就翻完了）靠跟随模式翻，不补一轮手动。
  let manualSeen = null;
  // 手动轮等尺寸：顶层点了翻译，而这个 frame 还是 0×0（懒加载、折叠面板）。
  let manualPending = false;
  // 这个文档在顶层的登记表里了（HELLO 拿到过回话）。
  let registered = false;
  let sizeWatch = null;
  let lastAutoStatus = null;

  function countTranslations() {
    if (!ctx.hasPageTranslations()) return 0;
    return document.querySelectorAll(ctx.PAGE_TRANSLATION_SELECTOR).length;
  }

  function reportToTop(extra) {
    frames.sendToRelay({
      type: 'FRAME_REPORT',
      translated: countTranslations(),
      sized: frames.isFrameSized(window),
      ...extra,
    });
  }

  async function sayHello() {
    const reply = await frames.sendToRelay({ type: 'FRAME_HELLO', sized: frames.isFrameSized(window) });
    // 顶层还没起来（回话是 null）：它起来时会广播一次，那时再来登记。
    if (reply) {
      registered = true;
      applyDirective(reply);
    }
  }

  // ------------------------------------------------------------ 引擎中继

  /**
   * 子 frame 的每一次翻译请求都交给顶层执行：引擎选择、回落、每日 AI 额度闸只有
   * 顶层那一份。缓存层（ctx.requestTranslationCached）在调用时才读
   * ctx.requestTranslation，所以它照常留在这里先查，只有没命中的走中继。
   *
   * 凡是要读「本文档」才答得出的量，都在这里算好写进消息，不能让顶层拿自己的
   * 文档去答：
   *   - allowDownload：请求到了顶层已经没有用户手势，create() 触发下载只会换回
   *     NotAllowedError、白等一次超时，所以恒为 false —— 缺语言包时拿回的就是
   *     顶层原有的「需要下载」错误；
   *   - pageSourceLang：这个 frame 的页面语言，给短文本自测不可靠时兜底
   *     （content/engine/languages.js 的 resolveSourceLang）。
   */
  async function requestTranslationViaTop(message) {
    const builtin = ctx.builtinTranslator;
    const pageSourceLang = (builtin && (await builtin.pageSourceLang())) || '';
    const reply = await frames.sendToRelay({
      type: 'FRAME_ENGINE_REQUEST',
      message: { ...message, allowDownload: false, pageSourceLang },
    });
    return reply || { error: ctx.t('translationFailed') };
  }

  // ------------------------------------------------------------ 自动：跟随

  /**
   * content-auto-translate.js 的 resolve() 问的就是这个（形状与 SiteRules.decide()
   * 一致，判法见 shelf.js 的 decideForFrame）。options.explicit 在这里不起作用：
   * 子 frame 上没有人点过什么，它的「表过态」就是顶层的指令。
   */
  function frameDecision() {
    return frames.decideForFrame({
      host: location.hostname,
      path: location.pathname,
      userRules: ctx.settings.siteRules,
      settings: ctx.settings,
      follow: !!(directive && directive.translate) && frames.isFrameSized(window),
    });
  }

  function restartAuto() {
    ctx.autoTranslate.restart('frame');
  }

  // 自动轮每跑完一轮汇报一次（RUNNING → 别的状态）。自动轮的错不弹提示，见
  // top.js 的 onChildReport。
  function onAutoState(snap) {
    const STATUS = ctx.STATUS_AUTO;
    const was = lastAutoStatus;
    lastAutoStatus = snap.status;
    if (was === STATUS.RUNNING && snap.status !== STATUS.RUNNING) {
      reportToTop({ manual: false, error: snap.error || null });
    }
  }

  // ------------------------------------------------------------ 手动：静默一轮

  async function runManualRound() {
    if (!frames.isFrameSized(window)) {
      manualPending = true;
      watchSize();
      return;
    }
    manualPending = false;
    if (state.isTranslatingPage) return;
    state.isTranslatingPage = true;
    let total = 0;
    let error = null;
    try {
      ctx.beginScopeRound();
      let blocks = ctx.collectPageBlocks();
      blocks = await ctx.filterBlocksByLanguage(blocks);
      total = blocks.length;
      if (total > 0) error = (await ctx.runTranslationPass(blocks)) || null;
      if (!error) state.pageHasBeenTranslated = true;
    } catch (caught) {
      console.error('Blab Translation: frame translation failed', caught);
      error = (caught && caught.message) || ctx.t('translationFailed');
    } finally {
      state.isTranslatingPage = false;
    }
    reportToTop({ manual: true, total, error });
  }

  // ------------------------------------------------------------ 尺寸闸

  function onResize() {
    if (!frames.isFrameSized(window)) return;
    window.removeEventListener('resize', onResize);
    sizeWatch = null;
    reportToTop({ manual: false, error: null });
    if (manualPending) runManualRound();
    if (directive && directive.translate) restartAuto();
  }

  function watchSize() {
    if (sizeWatch) return;
    sizeWatch = onResize;
    window.addEventListener('resize', onResize);
  }

  // ------------------------------------------------------------ 指令

  function applyDirective(next) {
    if (!next || (directive && next.epoch <= directive.epoch)) return;
    const prev = directive;
    directive = next;

    // 整页覆盖跟着顶层走，设和清都跟：顶层是这个值唯一的主人。
    const want = next.scopeOverride || null;
    if (want !== (state.pageScopeOverride || null)) {
      state.pageScopeOverride = want;
      ctx.invalidatePageScope();
    }
    // 先定显隐再重开自动轮：start() 看的是 state.translationsVisible。
    if ((state.translationsVisible !== false) !== next.visible) ctx.setTranslationsVisible(next.visible);

    if (manualSeen === null) {
      manualSeen = next.manualEpoch;
    } else if (next.manualEpoch > manualSeen) {
      manualSeen = next.manualEpoch;
      // 手动轮先起：它同步置上 isTranslatingPage，下面重开的自动轮见了就等着，
      // 同一批块不会两边各送一次。
      runManualRound();
    }
    if (!prev || prev.translate !== next.translate) restartAuto();
  }

  function listenToTop() {
    chrome.runtime.onMessage.addListener((message) => {
      if (!message || message.type !== 'FRAME_DIRECTIVE') return undefined;
      applyDirective(message.directive);
      // HELLO 落了空（比顶层先起），这一次广播就是顶层起来了：去登记。
      if (!registered) sayHello();
      return undefined;
    });
  }

  function setupChildFrame() {
    listenToTop();
    ctx.autoTranslate.onStateChange(onAutoState);
    if (!frames.isFrameSized(window)) watchSize();
    // 进 / 出往返缓存（bfcache）：出去时顶层把它从登记表里划掉，回来再报到。
    window.addEventListener('pagehide', () => {
      registered = false;
      frames.sendToRelay({ type: 'FRAME_BYE' });
    });
    window.addEventListener('pageshow', (event) => {
      if (event.persisted) sayHello();
    });
    sayHello();
  }

  // 这两个在加载时就要挂上：init 里 start('load') 先于 frames.setup() 跑，那一次
  // 判定就得问 frameDecision（没有指令 → 不翻）；页面上第一个翻译请求也可能先于
  // setup 发出（划词）。
  ctx.frameDecision = frameDecision;
  ctx.requestTranslation = requestTranslationViaTop;

  Object.assign(frames, {
    setup: setupChildFrame,
  });
})();
