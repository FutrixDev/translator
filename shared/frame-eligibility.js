// 子 frame 的进门资格 —— 纯数据加一个判定函数，内容脚本的第一道闸。
//
// manifest 让内容脚本进了所有 frame（all_frames），但有几类 frame 我们一个节点
// 都不该放进去：广告（翻了也白翻，还替人家量了曝光）、验证码 / 支付 / 登录
// （隐私政策写明「不读取」，这张表就是那句话的实现）、嵌入播放器（它们的正文
// 是视频，字幕翻译只在顶层）。命中的 frame 连 ctx 都不建：content-bootstrap.js
// 建 ctx 之前问一句 shouldActivate()，false 就返回，后面每个模块在
// `if (!ctx) return;` 处退出 —— 这叫 dormant。
//
// 这里只判「身份」（这是谁家的 frame），不判尺寸：懒加载的 frame 先是 0×0 后撑
// 开，尺寸只能在要翻的那一刻判（content/frames/shelf.js 的尺寸闸）。
//
// 表和 shared/site-rules-builtin.js 一样是纯数据：条目是「主机后缀 + 可选路径
// 前缀」，主机按后缀匹配（'doubleclick.net' 命中 ad.doubleclick.net），路径按
// 段前缀匹配（'/embed' 命中 /embed/xyz，不命中 /embedded）。它不是一份完整的
// 广告域名清单，也不打算是：漏网的广告 frame 大多是过小或隐藏的，尺寸闸会拦住。
(function (root) {
  'use strict';

  const DENY = [
    // 广告与广告测量。*.safeframe.googlesyndication.com 由 googlesyndication.com
    // 的后缀匹配带上。
    ...[
      'googlesyndication.com', 'doubleclick.net', 'googleadservices.com',
      'adnxs.com', 'amazon-adsystem.com', 'taboola.com', 'outbrain.com',
      'criteo.com', 'criteo.net', 'adsrvr.org', 'pubmatic.com',
      'rubiconproject.com', 'openx.net', 'moatads.com', 'adform.net',
      'smartadserver.com', 'media.net', '2mdn.net', 'adsafeprotected.com',
      'doubleverify.com', 'serving-sys.com', 'flashtalking.com', 'teads.tv',
    ].map((host) => ({ category: 'ads', host })),
    // 验证码
    { category: 'captcha', host: 'google.com', path: '/recaptcha' },
    { category: 'captcha', host: 'recaptcha.net' },
    { category: 'captcha', host: 'hcaptcha.com' },
    { category: 'captcha', host: 'challenges.cloudflare.com' },
    { category: 'captcha', host: 'arkoselabs.com' },
    { category: 'captcha', host: 'funcaptcha.com' },
    { category: 'captcha', host: 'geetest.com' },
    // 支付
    { category: 'payment', host: 'js.stripe.com' },
    { category: 'payment', host: 'm.stripe.network' },
    { category: 'payment', host: 'paypal.com' },
    { category: 'payment', host: 'braintreegateway.com' },
    { category: 'payment', host: 'braintree-api.com' },
    { category: 'payment', host: 'adyen.com' },
    { category: 'payment', host: 'pay.google.com' },
    { category: 'payment', host: 'klarna.com' },
    { category: 'payment', host: 'squareup.com' },
    // 登录
    { category: 'login', host: 'accounts.google.com' },
    { category: 'login', host: 'appleid.apple.com' },
    { category: 'login', host: 'login.microsoftonline.com' },
    // 嵌入播放器
    { category: 'player', host: 'youtube.com', path: '/embed' },
    { category: 'player', host: 'youtube-nocookie.com' },
    { category: 'player', host: 'player.vimeo.com' },
    { category: 'player', host: 'player.bilibili.com' },
    { category: 'player', host: 'open.spotify.com', path: '/embed' },
    { category: 'player', host: 'w.soundcloud.com', path: '/player' },
    { category: 'player', host: 'dailymotion.com', path: '/embed' },
    { category: 'player', host: 'geo.dailymotion.com' },
    { category: 'player', host: 'player.twitch.tv' },
    { category: 'player', host: 'wistia.com' },
    { category: 'player', host: 'wistia.net' },
  ];

  // frame 自己的名字（以及同源时宿主 <iframe> 的 id / name）。Google 的广告位
  // 用 google_ads_iframe_* / aswift_*；其余按「词」认：前后不是字母数字才算，
  // 所以 ad-slot、top_ads 命中，header、loading、adsorption 不命中。
  const AD_NAME = /google_ads_iframe|aswift_|(?:^|[^a-z0-9])(?:ad|ads|advert|banner|sponsor)(?:[^a-z0-9]|$)/i;

  function cleanHost(host) {
    return String(host || '').trim().toLowerCase().replace(/\.$/, '');
  }

  function hostMatches(host, suffix) {
    const h = cleanHost(host);
    return !!h && (h === suffix || h.endsWith(`.${suffix}`));
  }

  function pathMatches(path, prefix) {
    if (!prefix) return true;
    const p = String(path || '/');
    return p === prefix || p.startsWith(`${prefix}/`);
  }

  function denyEntry(host, path) {
    return DENY.find((entry) => hostMatches(host, entry.host) && pathMatches(path, entry.path)) || null;
  }

  function parse(url) {
    try {
      return new URL(url);
    } catch (_) {
      return null;
    }
  }

  function hostOf(url) {
    const parsed = parse(url);
    return parsed ? parsed.hostname : '';
  }

  function pathOf(url) {
    const parsed = parse(url);
    return parsed ? parsed.pathname : '/';
  }

  /**
   * 纯判定：进门吗，为什么。env 是从 window 上读下来的一份快照，单测直接造它。
   *
   * about:blank / about:srcdoc 的 URL 里没有主机，它们继承创建者的 origin——
   * 所以拿 origin 的主机去对表（只有路径的条目对不上，因为没有路径可对）。广告
   * 位最常见的写法正是「doubleclick 的 frame 里再开一个 about:blank」。
   *
   * 祖先链上有一层命中表（location.ancestorOrigins），这一层也不进：支付 frame
   * 里嵌的子 frame 仍然是支付流程的一部分。
   */
  function evaluate(env) {
    if (env.isTop) return { activate: true, reason: 'top' };
    if (String(env.designMode || '').toLowerCase() === 'on') return { activate: false, reason: 'designMode' };

    const href = String(env.href || '');
    const own = /^about:/i.test(href)
      ? denyEntry(hostOf(env.origin), '')
      : denyEntry(hostOf(href), pathOf(href));
    if (own) return { activate: false, reason: own.category };

    for (const ancestor of env.ancestorOrigins || []) {
      const entry = DENY.find((item) => !item.path && hostMatches(hostOf(ancestor), item.host));
      if (entry) return { activate: false, reason: entry.category };
    }

    const names = [env.windowName, env.frameElementId, env.frameElementName];
    if (names.some((name) => name && AD_NAME.test(String(name)))) return { activate: false, reason: 'frameName' };

    return { activate: true, reason: 'eligible' };
  }

  function readEnv() {
    const win = root;
    // 跨源读 top（比较引用）和 frameElement（跨源时是 null）都不会抛。
    const isTop = win.top === win;
    const frameElement = win.frameElement || null;
    const loc = win.location || {};
    return {
      isTop,
      designMode: win.document && win.document.designMode,
      href: loc.href,
      origin: win.origin || loc.origin,
      ancestorOrigins: loc.ancestorOrigins ? Array.from(loc.ancestorOrigins) : [],
      windowName: win.name,
      frameElementId: frameElement && frameElement.id,
      frameElementName: frameElement && frameElement.getAttribute && frameElement.getAttribute('name'),
    };
  }

  let memo = null;
  function shouldActivate() {
    if (memo === null) memo = evaluate(readEnv()).activate;
    return memo;
  }

  root.FrameEligibility = {
    DENY,
    AD_NAME,
    evaluate,
    shouldActivate,
  };
})(globalThis);
