// Blab Translation — 整页翻译：本页的用户站点规则（ctx.customRules）
//
// 规则存在 sync 里，一条一个 `customRule:<id>` 键（shared/custom-rules.js）。这个
// 文件只做三件事：
//   - 建本 frame 的镜像：向 SW 要一次本主机的规则（CUSTOM_RULES_FOR_HOST），此后
//     跟着 bootstrap 转来的增量走（ctx.syncMirrors 登记表）；
//   - 答「本页生效的是哪条规则」（current / engineOverride / profileOverride /
//     domain），给范围、收块、site-adapter、引擎谓词、AI 选档
//     （content/content-ai-profiles.js）、附加说明（content/engine/addenda.js）读；
//   - 本页生效的规则变了，按设计 §3.6 走流水线：CSS 重新挂载 → 清扫被规则禁止的
//     译文 → 必要时补一轮增量收块 → 回调外部订阅者（frames/top.js 广播指令，
//     调度器重启）。前三步是这里自己的，一定赶在订阅者之前做完。手动轮或补翻轮
//     进行中的变化，第 2、3 步在那一轮结束时（afterRound）补做。
//     include 区域晚到（scope.js）是同一类事——范围在轮次中途变了——走同一个
//     rescope()，不另开一条路。
//   - 本页规则钉住的引擎或领域变了，回调 onProfileChange 的订阅者（缓存层的
//     ctx.translationProfile 靠它加代，设计 §3.8）。这一问不过 signatureOf 那道门：
//     领域不改范围、不改 CSS，只改「这段怎么译」。
//
// 调 init() 之前（DOM 夹具里只装整页翻译那几个模块时也一样）：current() 与
// engineOverride() 答 null，whenReady() 立即 resolve —— 等于「没有规则」。
(function() {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT;
  if (!ctx) return;

  const { state } = ctx;
  const CustomRules = globalThis.CustomRules;

  let mirror = null;
  // 子 frame 的引擎与 AI 配置档来自顶层指令，自己的规则里写的不算（§3.8；P1-D §3.3）。
  let inherited = null;
  let inheritedProfile = null;
  let memo = null;
  let signature = null;
  let sheet = null;
  let sheetText = null;
  const subscribers = new Set();
  const profileSubscribers = new Set();
  // 引擎覆盖、领域与配置档的签名；init 之前没有规则，三者都是 null。
  let profileSigned = JSON.stringify([null, null, null]);

  function request() {
    return chrome.runtime.sendMessage({ type: 'CUSTOM_RULES_FOR_HOST' }).then((reply) => {
      if (!reply) throw new Error('CUSTOM_RULES_FOR_HOST got no reply');
      if (reply.error) throw new Error(reply.error);
      if (!Array.isArray(reply.rules)) throw new Error('CUSTOM_RULES_FOR_HOST reply has no rules list');
      return reply.rules;
    });
  }

  function version() {
    return mirror ? mirror.version : 0;
  }

  const EMPTY = Object.freeze([]);

  /**
   * 本 URL 的胜出规则，字段补齐成固定形状；没有规则就是 null。
   * 以 href + version 记忆：SPA 换了路径、规则集变了，都自然换键。
   */
  function current() {
    if (!mirror) return null;
    const key = `${location.href}\n${mirror.version}`;
    if (memo && memo.key === key) return memo.rule;
    const winner = CustomRules.pick(mirror.entries(), location.hostname, location.pathname);
    const rule = winner && Object.freeze({
      id: winner.id,
      include: winner.include || EMPTY,
      exclude: winner.exclude || EMPTY,
      keepOriginal: winner.keepOriginal || EMPTY,
      css: winner.css || '',
      engine: winner.engine || null,
      domain: winner.domain || null,
      profile: winner.profile || null,
    });
    memo = { key, rule };
    return rule;
  }

  function engineOverride() {
    if (ctx.frameRole !== 'top') return inherited;
    const rule = current();
    return rule ? rule.engine : null;
  }

  // 本页规则指定的 AI 配置档 id（规则 v3）；没有就是 null（按功能选档）。子 frame
  // 答顶层指令带下来的那一个。
  function profileOverride() {
    if (ctx.frameRole !== 'top') return inheritedProfile;
    const rule = current();
    return rule ? rule.profile : null;
  }

  // 本页规则设的领域；没有规则、规则没设领域都是 null（跟随全局设置）。规则设了
  // general 也算设了，返回 'general'。
  function domain() {
    const rule = current();
    return rule ? rule.domain : null;
  }

  // 范围与 CSS 的签名（第 1–3 步和订阅者看它）。不含领域：领域变了不必清扫、不必
  // 补翻，那一问归 profileSignature。
  function signatureOf() {
    const rule = current();
    return JSON.stringify(rule
      ? [rule.id, rule.include, rule.exclude, rule.keepOriginal, rule.css, engineOverride(), profileOverride()]
      : [null, engineOverride(), profileOverride()]);
  }

  // ------------------------------------------------------------ CSS（§3.5）

  // 清洗结果按「规则 id + CSS 原文」记：同一段不安全 CSS 在一个页面里只清洗、只告警
  // 一次（§3.5）。不按规则对象记：镜像重建时对象会换，内容没变。
  const cleaned = new Map();

  function cssText() {
    const rule = current();
    if (!rule || !rule.css) return '';
    const key = `${rule.id}\n${rule.css}`;
    if (cleaned.has(key)) return cleaned.get(key);
    let text = '';
    try {
      text = CustomRules.sanitizeCss(rule.css);
    } catch (error) {
      // 错误是 i18n 键（customRuleCssUnsafe），不含规则内容。
      console.warn('Blab Translation: custom rule CSS not applied:', error.message);
    }
    cleaned.set(key, text);
    return text;
  }

  /**
   * 把本页规则的 CSS 挂成我们那一张 adopted sheet，并排在页面自己的 sheet 之后。
   * 每轮翻译开始、每次规则变化各调一次：有的页面会整体重写 adoptedStyleSheets，
   * 被冲掉的下一轮挂回去。文本没变不重填；我们那张已经排在最后就不赋值（每次赋值
   * 都让页面样式重算）；文本清空时摘掉一次。
   */
  function mountCss() {
    const text = cssText();
    if (!text && !sheet) return;
    try {
      const list = document.adoptedStyleSheets;
      if (!text) {
        if (list.includes(sheet)) document.adoptedStyleSheets = list.filter((each) => each !== sheet);
        return;
      }
      if (!sheet) sheet = new CSSStyleSheet();
      if (sheetText !== text) {
        sheet.replaceSync(text);
        sheetText = text;
      }
      if (list[list.length - 1] !== sheet) {
        document.adoptedStyleSheets = [...list.filter((each) => each !== sheet), sheet];
      }
    } catch (error) {
      console.error('Blab Translation: mounting custom rule CSS failed', error);
    }
  }

  // ------------------------------------------------------------ 流水线（§3.6）

  // 第 2 步：规则现在禁止的块，把已有的译文收回去。清扫只有这一份。include 晚到
  // 时 scope.js 先把新范围写进缓存再调 rescope()，这里解析到的就是那个 include。
  // 失败标记（content/page/failed-blocks.js）站在译文的位置上，同一次一起收：
  // 规则不许翻的块，不该留着一个「重试」去翻它。
  function sweep() {
    const scope = ctx.resolvePageScope();
    for (const el of ctx.queryAllDeep('.ai-translator-translated')) {
      if (ctx.ruleForbids(el, scope)) ctx.releaseTranslation(el);
    }
    ctx.failedBlocks.clearWhere((el) => ctx.ruleForbids(el, scope));
  }

  // 第 3 步：整页翻过、调度器又没在跟这一页时，补一轮把新放开的块翻上。调度器在
  // 跟时由第 5 步的重启接手，两条路不收同一批块。必须在回调订阅者（重启）之前读
  // isOn()：重启之后它一定答「在跟」。
  //
  // 补翻轮用自己的旗标（catching），不碰 state.isTranslatingPage：那个旗标是手动整页
  // 翻译的，顶层指令（frames/top.js）和「翻译整页」的忙分支都读它，补翻不是用户表态。
  // 手动整页翻译与子 frame 的手动轮等补翻结束（whenCaughtUp）再收块，两轮不同时收。
  let catching = null;

  function isCatchingUp() {
    return catching !== null;
  }

  function whenCaughtUp() {
    return catching ? catching.done : Promise.resolve();
  }

  async function catchUpRound() {
    // 在任何 await、任何可能抛错的调用之前同步置上。
    let release = null;
    catching = { done: new Promise((resolve) => { release = resolve; }) };
    try {
      ctx.beginScopeRound();
      const blocks = await ctx.filterBlocksByLanguage(ctx.collectPageBlocks());
      if (!blocks.length) return;
      const failure = await ctx.runTranslationPass(blocks);
      if (failure) console.error('Blab Translation: custom rule catch-up round failed:', failure.message);
    } catch (error) {
      console.error('Blab Translation: custom rule catch-up round failed', error);
    } finally {
      catching = null;
      release();
      afterRound();
    }
  }

  function roundRunning() {
    return !!state.isTranslatingPage || isCatchingUp();
  }

  // 四个条件都成立才补（§3.6 第 3 步）：整页翻过；调度器没在跟；没有手动整页翻译
  // 在跑；没有补翻轮在跑。
  function wantsCatchUp() {
    if (!state.pageHasBeenTranslated || roundRunning()) return false;
    return !(ctx.autoTranslate && ctx.autoTranslate.isOn());
  }

  // 手动轮或补翻轮进行中规则变了：CSS 与清扫当场做，补翻留给那一轮的收尾
  // （afterRound）。这两种轮次挂译文时没有 accept 守卫，变化前送出去的块，译文回来
  // 照样挂进新禁止的区域，所以收尾时再清扫一次。自动轮不走这条：它有 accept 守卫，
  // 规则变化后由第 5 步的调度器重启接手。
  let pending = false;

  /**
   * 一轮手动整页翻译、子 frame 手动轮或补翻轮结束时调（旗标已经清掉之后）。这一轮
   * 进行中规则变过：先清扫，收回晚到、挂进新禁止区域的译文；再按第 3 步的条件补一轮。
   * 没变过就什么都不做。
   */
  function afterRound() {
    if (!pending) return;
    pending = false;
    sweep();
    if (wantsCatchUp()) catchUpRound();
  }

  // 第 3 步与订阅者（第 4、5 步）排进一个微任务，同一个同步段里多次 rescope() 只
  // 排一次。两个原因：
  //   - include 晚到时 rescope() 是在收块途中（resolvePageScope 里）被同步调到的，
  //     在这里补翻会嵌套收块，重启调度器会在发现层自己的回调里拆掉它；
  //   - 规则变化的清扫本身会解析范围，恰好碰上 include 晚到时 rescope() 被嵌套调到，
  //     两次合成一次回调。
  // 用微任务而不是下一轮事件循环：调度器的 pump 由定时器起，排队的块要在它之前随
  // 重启（会话号 +1、队列清空）作废；微任务一定先于任何定时器和消息回话。
  //
  // 回调的是排进去那一刻的订阅者快照：订阅者只听到它订阅之后发生的变化。加载时
  // 首个回话触发的那一次，调度器还没订阅（它等 whenReady 之后才装），推迟之后也
  // 不会把这一次补给它。
  let due = null;

  function settle() {
    const subscribed = due;
    due = null;
    // 第 3 步必须赶在订阅者（调度器重启）之前读 isOn()。
    if (wantsCatchUp()) catchUpRound();
    for (const fn of subscribed) {
      if (!subscribers.has(fn)) continue;
      try {
        fn();
      } catch (error) {
        console.error('Blab Translation: custom rule subscriber failed', error);
      }
    }
  }

  /**
   * 范围在轮次中途变了：规则变化（recompute）与 include 区域晚到（scope.js）都只走
   * 这里。当场清扫；有轮次在跑就记下，由那一轮收尾时 afterRound() 再扫、再判补翻；
   * 补翻与回调订阅者推迟到当前同步段之后。
   */
  function rescope() {
    sweep();
    if (roundRunning()) pending = true;
    if (due) return;
    due = Array.from(subscribers);
    queueMicrotask(settle);
  }

  function profileSignature() {
    return JSON.stringify([engineOverride(), domain(), profileOverride()]);
  }

  // 引擎或领域真变了才回调；回调抛错只记一条，不挡别的订阅者。
  function noteProfile() {
    const next = profileSignature();
    if (next === profileSigned) return;
    profileSigned = next;
    for (const fn of Array.from(profileSubscribers)) {
      try {
        fn();
      } catch (error) {
        console.error('Blab Translation: custom rule profile subscriber failed', error);
      }
    }
  }

  function recompute() {
    noteProfile();
    const next = signatureOf();
    if (next === signature) return;
    signature = next;
    mountCss();
    rescope();
  }

  // ------------------------------------------------------------ 导出

  function init() {
    if (mirror) return;
    mirror = CustomRules.mirror({ request, host: location.hostname });
    signature = signatureOf();
    profileSigned = profileSignature();
    mirror.subscribe(recompute);
    ctx.syncMirrors.push({
      prefix: CustomRules.KEY_PREFIX,
      onStorageChange: ctx.customRules.onStorageChange,
    });
    globalThis.SpaNavigation.onRouteChange(recompute);
  }

  ctx.customRules = {
    init,
    whenReady: () => (mirror ? mirror.whenReady() : Promise.resolve()),
    current,
    get version() {
      return version();
    },
    onStorageChange: (changes) => {
      if (mirror) mirror.onStorageChange(changes);
    },
    engineOverride,
    profileOverride,
    domain,
    inherit(engine, profile) {
      inherited = engine || null;
      inheritedProfile = profile || null;
      recompute();
    },
    onChange(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    // 本页生效的引擎覆盖（engineOverride）、领域（domain）或配置档
    // （profileOverride）变了才回调，别的字段
    // （范围、CSS）变了不回调。
    onProfileChange(fn) {
      profileSubscribers.add(fn);
      return () => profileSubscribers.delete(fn);
    },
    // 每轮收块开始时由 scope.js 的 beginScopeRound() 调（§3.5 第一个挂载时机）。
    beginRound: mountCss,
    isCatchingUp,
    whenCaughtUp,
    afterRound,
    rescope,
  };
})();
