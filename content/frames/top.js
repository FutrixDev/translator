// Blab Translation — 整页翻译进 iframe：顶层这一边
//
// 三件事：
//   1. 登记子 frame（谁在、够不够大、最近一次翻出了几块）；
//   2. 算「指令」并在它变了的时候广播给所有子 frame；
//   3. 替子 frame 执行引擎请求（FRAME_ENGINE_RELAY）—— 引擎选择、回落、每日 AI
//      额度闸都只在顶层有一份，子 frame 与顶层一视同仁。
//
// 指令是子 frame 唯一要知道的东西：
//
//   { epoch, translate, manualEpoch, visible, scopeOverride, engineOverride, generation }
//
//   epoch          每变一次 +1。子 frame 只认更大的，所以 HELLO 的回话和广播谁先
//                  到都一样。
//   translate      顶层此刻在翻：自动翻译 idle / running，或者手动整页正在跑。
//   manualEpoch    顶层每点一次「翻译整页」+1。子 frame 看到它变大就静默跑一轮。
//   visible        「此刻想不想看译文」（Alt+A、悬浮球的隐藏）。
//   scopeOverride  整页覆盖（state.pageScopeOverride，并行批的正文范围）。
//   engineOverride 顶层这一页的用户站点规则指定的引擎（'builtin' | 'ai' | null）。
//                  子 frame 的引擎谓词跟顶层走，不看自己 URL 上的规则（P1-B §3.8）。
//   generation     顶层的 ctx.translationProfile.generation()（缓存层那个文件）。子 frame
//                  的悬停和字幕缓存键带着它：顶层换了模型、提示词或词表，子 frame 的
//                  旧译文也一起失效。
//
// 登记表在这里，不在服务工作者里：服务工作者随时会被回收，而顶层文档活多久，
// 这张表就该活多久。
(function() {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT;
  if (!ctx || ctx.frameRole !== 'top') return;

  const frames = (ctx.frames = ctx.frames || {});
  const { state } = ctx;

  // 键是 sender.documentId（同一个 frame 导航到新文档就是新的一格），拿不到时退到
  // frameId。值：{ sized, translated }。
  const registry = new Map();
  let directive = null;
  let manualEpoch = 0;
  let ready = false;

  function currentTranslate() {
    return ctx.autoTranslate.isOn() || !!state.isTranslatingPage;
  }

  function computeDirective() {
    return {
      translate: currentTranslate(),
      manualEpoch,
      visible: state.translationsVisible !== false,
      scopeOverride: state.pageScopeOverride || null,
      engineOverride: ctx.customRules.engineOverride() || null,
      generation: ctx.translationProfile.generation(),
    };
  }

  function sameDirective(a, b) {
    return !!a && !!b
      && a.translate === b.translate
      && a.manualEpoch === b.manualEpoch
      && a.visible === b.visible
      && a.scopeOverride === b.scopeOverride
      && a.engineOverride === b.engineOverride
      && a.generation === b.generation;
  }

  function broadcastDirective() {
    frames.sendToRelay({ type: 'FRAME_DIRECTIVE_BROADCAST', directive });
  }

  /**
   * 重算指令，变了才 +1 并广播。
   *
   * 没有登记过的子 frame 就不广播：比顶层晚起的子 frame 在 HELLO 的回话里就拿
   * 到了当前指令；比顶层早起的那些 HELLO 落空，靠 setup 那一次广播补上，补上的
   * 同时它们会重新 HELLO 登记（child.js）。所以一个没有 iframe 的页面，自动翻译的
   * 状态怎么变都不会叫醒服务工作者。
   */
  function refreshDirective() {
    if (!ready) return;
    const next = computeDirective();
    if (sameDirective(directive, next)) return;
    directive = { epoch: (directive ? directive.epoch : 0) + 1, ...next };
    if (registry.size > 0) broadcastDirective();
  }

  // ------------------------------------------------------------ 外面的钩子

  function onManualTranslate() {
    manualEpoch += 1;
    refreshDirective();
  }

  function onManualTranslateEnd() {
    refreshDirective();
  }

  function onVisibilityChanged() {
    refreshDirective();
  }

  function hasSizedChildren() {
    for (const entry of registry.values()) if (entry.sized) return true;
    return false;
  }

  function childrenHaveTranslations() {
    for (const entry of registry.values()) if (entry.translated > 0) return true;
    return false;
  }

  // ------------------------------------------------------------ 子 frame 的来信

  function childKey(message) {
    return message.documentId || `frame:${message.frameId}`;
  }

  function onChildReport(message) {
    const entry = registry.get(childKey(message));
    if (!entry) return;
    if (typeof message.sized === 'boolean') entry.sized = message.sized;
    if (typeof message.translated === 'number') entry.translated = message.translated;
    // 自动轮次出的错不弹：自动翻译自己的错也只画在状态点上，不弹提示；手动那一轮
    // 是用户点出来的，子 frame 静默跑，出了错只能由顶层替它说。
    if (message.manual && message.error) {
      if (!document.getElementById('ai-translator-progress')) ctx.showPageTranslationProgress();
      ctx.showTranslationError(message.error);
    }
  }

  /**
   * 子 frame 的请求在这里执行（child.js 的 requestViaTop）。via 说它在子 frame 里
   * 调的是哪一个：'cached' 先查缓存（缓存和词表都在顶层，戳要用顶层的那份），
   * 'direct' 直接发。别的值是写错了，抛出来按失败回话。
   *
   * 两种请求都已经在子 frame 那里盖过语域（它那一页没有语域就是 `{}`），这里只走
   * 「送出」那一步：走 ctx.requestTranslation / ctx.requestTranslationCached 会撞上
   * 「已经盖过」的守卫而抛。
   */
  function engineFor(via) {
    if (via === 'cached') return ctx.sendTranslationCached;
    if (via === 'direct') return ctx.sendTranslation;
    throw new TypeError(`frame engine request has unknown via ${JSON.stringify(via)}`);
  }

  // 抛出的错误过不了消息通道，只能折成 {error}。整轮致命的标记（passFatal，
  // content/engine/addenda.js 的不认得的领域）跟着带回去：子 frame 的整页一轮
  // （content/page/batch.js）靠它第一次见到就停，而不是等累计阈值。
  async function relayEngineRequest(via, message, sendResponse) {
    try {
      sendResponse(await engineFor(via)(message));
    } catch (error) {
      console.error('Blab Translation: frame engine relay failed', error);
      sendResponse({
        error: (error && error.message) || ctx.t('translationFailed'),
        ...(error && error.passFatal === true ? { passFatal: true } : {}),
      });
    }
  }

  function listenToChildren() {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      const type = message && message.type;
      switch (type) {
        case 'FRAME_CHILD_HELLO':
          registry.set(childKey(message), { sized: !!message.sized, translated: 0 });
          sendResponse(directive);
          return false;
        case 'FRAME_CHILD_REPORT':
          onChildReport(message);
          return false;
        case 'FRAME_CHILD_BYE':
          registry.delete(childKey(message));
          return false;
        case 'FRAME_ENGINE_RELAY':
          relayEngineRequest(message.via, message.message, sendResponse);
          return true;
        default:
          // 别的消息归 content-messaging.js，这里不回话、不占着通道。
          return undefined;
      }
    });
  }

  function setupTopFrame() {
    if (ready) return;
    ready = true;
    listenToChildren();
    // 自动翻译的状态一变（开始翻、翻完、被关掉），translate 可能跟着变。
    // onStateChange 订阅时会立刻回调一次，那一次正好算出第一版指令。
    ctx.autoTranslate.onStateChange(refreshDirective);
    // 本页生效的用户站点规则变了（含换路由换到另一条规则），引擎覆盖可能跟着变。
    ctx.customRules.onChange(refreshDirective);
    // 模型、提示词或词表换了一代，子 frame 的悬停和字幕缓存跟着失效。
    ctx.translationProfile.subscribe(refreshDirective);
    // 比顶层早起的子 frame 的 HELLO 落了空，这一次广播是它们唯一的补课。
    // window.length 数的是这个文档的子浏览上下文（Shadow DOM 里的 iframe 也算），
    // 为零就没有谁要补。
    if (window.length > 0) broadcastDirective();
  }

  Object.assign(frames, {
    setup: setupTopFrame,
    onManualTranslate,
    onManualTranslateEnd,
    onVisibilityChanged,
    hasSizedChildren,
    childrenHaveTranslations,
  });
})();
