// Blab Translation — 整页翻译：本页的用户站点规则（ctx.customRules）
//
// 规则存在 sync 里，一条一个 `customRule:<id>` 键（shared/custom-rules.js）。这个
// 文件只做三件事：
//   - 建本 frame 的镜像：向 SW 要一次本主机的规则（CUSTOM_RULES_FOR_HOST），此后
//     跟着 bootstrap 转来的增量走（ctx.syncMirrors 登记表）；
//   - 答「本页生效的是哪条规则」（current / engineOverride），给范围、收块、
//     site-adapter、引擎谓词读；
//   - 本页生效的规则变了，按设计 §3.6 走流水线：CSS 重新挂载 → 清扫被规则禁止的
//     译文 → 必要时补一轮增量收块 → 回调外部订阅者（frames/top.js 广播指令，
//     调度器重启）。前三步是这里自己的，一定赶在订阅者之前做完。手动轮或补翻轮
//     进行中的变化，第 2、3 步在那一轮结束时（afterRound）补做。
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
  // 子 frame 的引擎来自顶层指令，自己的规则里写的不算（§3.8）。
  let inherited = null;
  let memo = null;
  let signature = null;
  let sheet = null;
  let sheetText = null;
  const subscribers = new Set();

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
    });
    memo = { key, rule };
    return rule;
  }

  function engineOverride() {
    if (ctx.frameRole !== 'top') return inherited;
    const rule = current();
    return rule ? rule.engine : null;
  }

  function signatureOf() {
    const rule = current();
    return JSON.stringify(rule
      ? [rule.id, rule.include, rule.exclude, rule.keepOriginal, rule.css, engineOverride()]
      : [null, engineOverride()]);
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

  // 第 2 步：规则现在禁止的块，把已有的译文收回去。清扫只有 sweepWith 这一份：
  // scope.js 在 include 区域晚到命中时拿刚算出的范围直接调它（不再解析一次）。
  function sweepWith(scope) {
    for (const el of ctx.queryAllDeep('.ai-translator-translated')) {
      if (ctx.ruleForbids(el, scope)) ctx.releaseTranslation(el);
    }
  }

  function sweep() {
    sweepWith(ctx.resolvePageScope());
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
      const error = await ctx.runTranslationPass(blocks);
      if (error) console.error('Blab Translation: custom rule catch-up round failed:', error);
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

  function recompute() {
    const next = signatureOf();
    if (next === signature) return;
    signature = next;
    mountCss();
    sweep();
    if (roundRunning()) pending = true;
    else if (wantsCatchUp()) catchUpRound();
    for (const fn of Array.from(subscribers)) {
      try {
        fn();
      } catch (error) {
        console.error('Blab Translation: custom rule subscriber failed', error);
      }
    }
  }

  // ------------------------------------------------------------ 导出

  function init() {
    if (mirror) return;
    mirror = CustomRules.mirror({ request, host: location.hostname });
    signature = signatureOf();
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
    inherit(engine) {
      inherited = engine || null;
      recompute();
    },
    onChange(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    // 每轮收块开始时由 scope.js 的 beginScopeRound() 调（§3.5 第一个挂载时机）。
    beginRound: mountCss,
    isCatchingUp,
    whenCaughtUp,
    afterRound,
    sweepWith,
  };
})();
