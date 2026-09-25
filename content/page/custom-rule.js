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
//     调度器重启）。前三步是这里自己的，一定赶在订阅者之前做完。
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
  const subscribers = new Set();

  function request() {
    return chrome.runtime.sendMessage({ type: 'CUSTOM_RULES_FOR_HOST' }).then((reply) => {
      if (!reply) throw new Error('CUSTOM_RULES_FOR_HOST got no reply');
      if (reply.error) throw new Error(reply.error);
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

  function cssText() {
    const rule = current();
    if (!rule || !rule.css) return '';
    try {
      return CustomRules.sanitizeCss(rule.css);
    } catch (error) {
      // 错误是 i18n 键（customRuleCssUnsafe），不含规则内容。
      console.warn('Blab Translation: custom rule CSS not applied:', error.message);
      return '';
    }
  }

  /**
   * 把本页规则的 CSS 挂成我们那一张 adopted sheet，并排在页面自己的 sheet 之后。
   * 每轮翻译开始、每次规则变化各挂一次：有的页面会整体重写 adoptedStyleSheets。
   */
  function mountCss() {
    const text = cssText();
    if (!text && !sheet) return;
    try {
      if (!sheet) sheet = new CSSStyleSheet();
      sheet.replaceSync(text);
      const others = document.adoptedStyleSheets.filter((each) => each !== sheet);
      document.adoptedStyleSheets = text ? [...others, sheet] : others;
    } catch (error) {
      console.error('Blab Translation: mounting custom rule CSS failed', error);
    }
  }

  // ------------------------------------------------------------ 流水线（§3.6）

  // 第 2 步：规则现在禁止的块，把已有的译文收回去。
  function sweep() {
    const scope = ctx.resolvePageScope();
    for (const el of ctx.queryAllDeep('.ai-translator-translated')) {
      if (ctx.ruleForbids(el, scope)) ctx.releaseTranslation(el);
    }
  }

  // 第 3 步：整页翻过、调度器又没在跟这一页时，补一轮把新放开的块翻上。调度器在
  // 跟时由第 5 步的重启接手，两条路不收同一批块。必须在回调订阅者（重启）之前读
  // isOn()：重启之后它一定答「在跟」。
  async function catchUpRound() {
    state.isTranslatingPage = true;
    try {
      ctx.beginScopeRound();
      const blocks = await ctx.filterBlocksByLanguage(ctx.collectPageBlocks());
      if (!blocks.length) return;
      const error = await ctx.runTranslationPass(blocks);
      if (error) console.error('Blab Translation: custom rule catch-up round failed:', error);
    } catch (error) {
      console.error('Blab Translation: custom rule catch-up round failed', error);
    } finally {
      state.isTranslatingPage = false;
    }
  }

  function wantsCatchUp() {
    if (!state.pageHasBeenTranslated || state.isTranslatingPage) return false;
    return !(ctx.autoTranslate && ctx.autoTranslate.isOn());
  }

  function recompute() {
    const next = signatureOf();
    if (next === signature) return;
    signature = next;
    mountCss();
    sweep();
    if (wantsCatchUp()) catchUpRound();
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
  };
})();
