// Blab Translation — 整页翻译进 iframe：两种角色共用的那一半
//
// manifest 让内容脚本进了所有 frame（all_frames）。进门资格在更早的
// shared/frame-eligibility.js 里判过了（广告、验证码、支付、登录、播放器不建 ctx）；
// 走到这里的 frame 分两种角色（ctx.frameRole，content-bootstrap.js 定）：
//
//   content/frames/top.js    顶层：登记子 frame、算指令并广播、替子 frame 执行引擎
//   content/frames/child.js  子 frame：跟着指令翻、把引擎请求交给顶层、汇报结果
//
// 两者之间只通过服务工作者的无状态中继（background/frame-relay.js）说话：子 frame
// 与顶层常常跨源，直接 postMessage 要自己验来源，而扩展消息天生只在扩展自己的
// 上下文之间走。
//
// 这一族跨文件的名字挂在 ctx.frames 上（写作 frames.foo）。外面的文件只调下面
// 这组钩子，**默认全是空操作**，由角色文件覆盖 —— 所以没装角色文件的夹具（单测、
// e2e 的内容脚本拼装）里，那几个钩子照常可调、什么也不做。
(function() {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT;
  if (!ctx) return;

  const frames = (ctx.frames = ctx.frames || {});

  // 尺寸闸：隐藏的 iframe 量出来是 0×0，追踪像素、统计 frame 是 1×1。够这么大
  // 才可能是给人读的内容。只在「要翻的那一刻」判，不在进门时判 —— 懒加载的 frame
  // 先是 0×0 后撑开（见 child.js 的 resize 监听）。
  const FRAME_MIN_WIDTH = 120;
  const FRAME_MIN_HEIGHT = 40;

  function isFrameSized(win) {
    const w = win || window;
    return w.innerWidth >= FRAME_MIN_WIDTH && w.innerHeight >= FRAME_MIN_HEIGHT;
  }

  // 只归顶层答的消息。发送点都钉了 {frameId: 0}（background/、popup/），这张表是
  // 纵深防御：哪天有个发送点漏了钉，第一个回话的也只会是顶层 —— 子 frame 的
  // 「这一页的状态」会让 popup 画出 iframe 的主机名。TRANSLATE_WHOLE_PAGE 是
  // 并行批的消息（正文范围那一批），这里只登记名字。
  const TOP_ONLY_MESSAGES = new Set([
    'TRANSLATE_PAGE',
    'TOGGLE_PAGE_TRANSLATION',
    'SET_AUTO_PAUSED',
    'AUTO_PAGE_STATE',
    'PROBE_ENGINE',
    'COMIC_TRANSLATE_IMAGE',
    'COMIC_TRANSLATE_PAGE',
    'TRANSLATE_WHOLE_PAGE',
  ]);

  function ignoresTopOnly(type) {
    return ctx.frameRole === 'child' && TOP_ONLY_MESSAGES.has(type);
  }

  /**
   * 子 frame 的自动翻译判定，形状与 SiteRules.decide() 完全一致（它就是
   * content-auto-translate.js 里 resolve() 的替身）。
   *
   * 先拿**自己的主机**问一次 decide({explicit: true})：阶梯上 explicit 之前只剩
   * 黑名单 / 内置 never / 用户 never，所以 refused 就是「这个站点不许碰」，不管
   * 顶层说什么都照原样返回 —— 用户对 mail.example.com 说过 never，它被嵌在别人
   * 页面里也还是 never。没被拒的，跟着顶层的指令：follow 为真就翻，否则不动。
   *
   * FRAME_FOLLOW / FRAME_IDLE 两个理由只活在子 frame 里：子 frame 没有状态条和
   * popup 可画，它们不会被翻成文案，所以不进 SiteRules.REASONS。
   */
  function decideForFrame({ host, path, userRules, settings, follow }) {
    const own = globalThis.SiteRules.decide({ host, path, userRules, settings, explicit: true });
    if (own.refused) return own;
    return {
      verdict: follow ? 'auto' : 'off',
      reason: follow ? 'FRAME_FOLLOW' : 'FRAME_IDLE',
      rule: own.rule,
      refused: false,
    };
  }

  /**
   * 发给中继（background/frame-relay.js）。中继总在，顶层不在时它自己回 null，所以
   * 这里的失败只有两种：
   *   - 扩展上下文失效（扩展被重载、更新）：往上抛，这一页的扩展已经不在了；
   *   - 别的错：意料之外，记一条日志，回话当 null 继续。
   */
  function sendToRelay(message) {
    return chrome.runtime.sendMessage(message).catch((error) => {
      if (ctx.isExtensionContextInvalidated(error)) throw error;
      console.warn('Blab Translation: frame relay message failed', message.type, error);
      return null;
    });
  }

  function frameNoop() {}
  function frameNone() {
    return false;
  }

  Object.assign(frames, {
    FRAME_MIN_WIDTH,
    FRAME_MIN_HEIGHT,
    TOP_ONLY_MESSAGES,
    isFrameSized,
    decideForFrame,
    ignores: ignoresTopOnly,
    sendToRelay,
    // 下面是外面文件调的钩子，角色文件覆盖它们。
    setup: frameNoop,
    onManualTranslate: frameNoop,
    onManualTranslateEnd: frameNoop,
    onVisibilityChanged: frameNoop,
    hasSizedChildren: frameNone,
    childrenHaveTranslations: frameNone,
  });
})();
