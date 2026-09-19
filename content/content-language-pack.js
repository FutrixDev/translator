// 语言包：什么时候提前把它下下来，以及它下好了之后要告诉谁。
//
// 和引擎分开，是因为这两件事都不回答「怎么翻」：一件是**要不要提前花用户的带宽**
// （一条产品策略），一件是**谁在等这个包**（页面上别的模块）。引擎只回答「这个
// 语言对能不能用」「给我一个 translator」，而那几个问题它在 ctx.builtinTranslator
// 上已经是公开的 —— 这个文件只用那一面，不碰它的内部。
(function () {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT;
  // 引擎模块在真实页面上一定在；只装几个模块的单测夹具里不一定。
  const builtin = () => ctx.builtinTranslator;

  // ==================== 预取 ====================

  // 首次翻译要等几十 MB 的语言包，这份等待是可以挪走的：create() 只要求 user
  // activation，不要求这次 activation 是「为了翻译」产生的。所以挂一个一次性监听，
  // 用户在页面上的第一次点击或按键就顺手把包拉下来。等他真的去点翻译时，包多半
  // 已经在本地了。
  //
  // 同一时刻只挂一个，而且它记着自己是**为哪个语言对**挂的。挂着的那一对会过期
  // （用户换了目标语言、换了引擎、单页应用换了一篇别的语言的文章），而一个带着
  // 过期语言对的监听比没有更糟：用户的下一次点击会把**别的**包下下来，真正缺的
  // 那个永远没人下，且页面上看不出任何异样。
  let armedPrefetch = null;

  function disarmLanguagePackPrefetch() {
    if (!armedPrefetch) return;
    window.removeEventListener('pointerdown', armedPrefetch.onGesture, true);
    window.removeEventListener('keydown', armedPrefetch.onGesture, true);
    armedPrefetch = null;
  }

  // 预取要下的是**这一页实际会译成的那门语言**，归一化成引擎的写法。
  //
  // 和 ctx.currentTargetLang() 不是一回事，别合并：那一个是记进译文身份的，「跟随
  // 浏览器语言」在它那里必须归一成空串 —— 登记端和比对端同读同写，空串是个自洽
  // 的哨兵。预取要的是真能下下来的那个包，空串下不出任何东西，得把
  // navigator.language 补上，那正是 getEffectiveTargetLang 做的事。
  function downloadTargetLang() {
    const engine = builtin();
    if (!engine || !ctx.getEffectiveTargetLang) return '';
    return engine.toApiLang(ctx.getEffectiveTargetLang());
  }

  /**
   * 为这个语言对挂上预取（同一对重复调是空操作）。
   *
   * 两类调用，提前量不同、代价也不同：
   *
   *   · 页面加载后探到「这个语言对还没下」时 —— 提前量最大，代价是一次语言探测
   *     加一次 availability 往返，而用户可能压根没打算在这一页上翻译。
   *   · 一次真实的翻译因为缺包而失败时（引擎那两处 needsDownload）—— 不用探、不用
   *     测语言，src/tgt 就是那次失败的请求用的那一对。**换目标语言、换引擎、单页
   *     应用换页**这三种「挂着的那一对过期了」的情形全由它自然接住，一次多余的
   *     往返都不花：这三件事都会让下一轮翻译重新发起，而那一轮一样会撞上缺包。
   */
  function armLanguagePackPrefetch(src, tgt) {
    const engine = builtin();
    if (!engine) return;
    if (!src || !tgt || src === tgt) return;
    if (!engine.supportsLang(src) || !engine.supportsLang(tgt)) return;
    // 只为「这一页会译成的那门语言」挂 —— 和手势触发时的那道门同问同答，两边
    // 都是 downloadTargetLang()。划词弹窗和输入框弹窗各有一个一次性的语言下拉，
    // 用它把一句话译成日文不等于这一页要译成日文：那一对挂上去必然被手势那道门
    // 拒掉，白挂一次，还顺手把真正该挂的那一对顶掉。挡在 disarm 之前，所以被拒
    // 的这一次不动已经挂好的那一对。
    if (tgt !== downloadTargetLang()) return;
    if (armedPrefetch && armedPrefetch.src === src && armedPrefetch.tgt === tgt) return;
    disarmLanguagePackPrefetch();

    const onGesture = () => {
      disarmLanguagePackPrefetch();
      // 挂上之后用户可能去设置里改了目标语言，而这一次点击恰好抢在下一轮翻译
      // 重新挂之前。下这个包等于替他做一个他刚刚撤销的决定，还白占一次 user
      // activation —— 放掉就是了，下一轮翻译撞上缺包时会把正确的那一对挂上来。
      if (downloadTargetLang() !== tgt) return;
      // 静默进行。这不是用户点出来的翻译，不该去占用进度条；失败也不弹提示，
      // 等他真的发起翻译时，那条路自己会重试并给出说明。
      engine.ensureDownloaded(src, tgt).then(() => {
        // 包刚落地。自动翻译那一轮很可能已经因为 builtinNeedsDownload 停在
        // ERROR 上了 —— 它不会自己再试，而这一刻正是这一页唯一变好的时刻。
        notifyLanguagePackReady({ sourceLang: src, targetLang: tgt });
      }).catch((error) => {
        console.info('Blab Translation: language pack prefetch failed', error);
      });
    };

    armedPrefetch = { src, tgt, onGesture };
    window.addEventListener('pointerdown', onGesture, true);
    window.addEventListener('keydown', onGesture, true);
  }

  // 加载后那一次：代价是用户可能从没打算在这个页面上翻译，包却下了。只在「这个
  // 页面的语言对确实还没下载」时才做，一个语言对一辈子只有一次，权衡下来是值的。
  async function setupLanguagePackPrefetch() {
    // iframe 里的语言对和主文档一样，跟着做纯属重复。
    if (window.top !== window) return;
    const engine = builtin();
    if (!engine || !engine.isActive()) return;

    try {
      const tgt = downloadTargetLang();
      if (!tgt || !engine.supportsLang(tgt)) return;
      const src = engine.toApiLang(await engine.pageSourceLang());
      if (!src || !engine.supportsLang(src) || src === tgt) return;
      // downloadable 才需要预取；available 已就绪，downloading 说明别处已经在下了。
      // 探测放在挂监听之前，是为了让手势回调里只剩一次 create()：activation 是有
      // 时效的（几秒），中间夹着 IPC 会把它耗掉。
      if (await engine.availability(src, tgt) !== 'downloadable') return;
      armLanguagePackPrefetch(src, tgt);
    } catch (error) {
      // 探不出来就不挂。缺包这件事下一轮真实翻译会再说一次。
    }
  }

  // ==================== 「装好了」 ====================

  // 「一个原本要下载的语言包，刚刚装好了」。
  //
  // 新装机走默认设置（translationEngine: 'builtin'、engineFallback: 'local-only'）
  // 打开一个英文页面时，自动翻译那一轮没有 user activation，明确传
  // allowDownload: false，于是每一批都拿回 builtinNeedsDownload；攒够三次，调度
  // 层判定这一页整体失败，停在 ERROR 并关掉发现层。它不会自己重试 —— 那条规矩
  // 是对的（在一个明显坏掉的接口上重试就是烧钱），可这一次「坏」的原因偏偏是会
  // 自己好的：用户在页面上的第一次点击或按键就把包拉下来了。没有这条通知，那一页
  // 要一直空着，直到刷新、跳转或者改一次设置。
  //
  // 只有预取这一条路会发：它是这个内容脚本里唯一**先确认过「这个语言对还没下」**
  // 、然后真的把它下下来的地方。（设置页那颗下载按钮走的是同一个 ensureDownloaded，
  // 但跑在 options 页自己的上下文里，通知不到已经开着的标签页 —— 那是 PR-10 的事。）
  const languagePackListeners = new Set();

  function onLanguagePackReady(fn) {
    if (typeof fn === 'function') languagePackListeners.add(fn);
  }

  function notifyLanguagePackReady(pair) {
    for (const fn of languagePackListeners) {
      try {
        fn(pair);
      } catch (error) {
        console.warn('Blab Translation: language pack listener failed', error);
      }
    }
  }

  ctx.setupLanguagePackPrefetch = setupLanguagePackPrefetch;
  ctx.armLanguagePackPrefetch = armLanguagePackPrefetch;
  ctx.onLanguagePackReady = onLanguagePackReady;
})();
