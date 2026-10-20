// Blab Translation Content Script Page Translation
//
// 整页翻译的入口，也只剩入口了：一次点击要经过的那几个决定——能不能开始、
// 已经在翻的时候点第二次怎么办、一块都没收到算什么、翻完了页面处于什么状态。
// 干活的四步各自成文件：
//
//   content/page/collect.js     从 DOM 里挑出该翻的块，读成可送翻的文本
//   content/page/batch.js       分批、并发、一轮翻译（runTranslationPass）
//   content/page/insert.js      把译文变成页面上的块
//   content/page/failed-blocks.js  没译成的那一段：失败标记与点它单段重试
//   content/page/visibility.js  译文旁边的原文显不显示
//   content/page/progress.js    提示 / 成功 / 报错那条小条子，和悬浮球上的进度环
//
// 拆开是因为这个文件到过 2282 行，四件互不相干的事写在一个闭包里，
// 谁也没法单独改。它们之间只通过 ctx 上导出的函数说话。
(function() {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT;
  if (!ctx) return;

  const { state } = ctx;
  const t = ctx.t;
  const isExtensionContextAvailable = ctx.isExtensionContextAvailable;

  async function translatePage() {
    if (!isExtensionContextAvailable()) {
      ctx.showTranslationError(t('extensionContextInvalidated'));
      return;
    }
    // 如果之前的译文被“隐藏译文”开关隐藏了，再次点击“翻译整页”应先把它们重新显示出来。
    // 否则整页已翻译、没有新块可译时会走 length === 0 分支直接返回，
    // 译文仍处于隐藏状态，用户会觉得“再次翻译没有任何反应”。
    ctx.revealHiddenTranslations();
    if (state.isTranslatingPage) {
      console.log('Blab Translation: Already translating page');
      // 已经在翻：球点一下头，告诉他「收到了，正在翻」。进度一直在环上。
      ctx.nudgeFloatBall();
      return;
    }

    state.isTranslatingPage = true;
    // 上一轮留下的条子说的是上一轮的事；这一轮点下去，环立刻转起来（arming），
    // 不等块收齐 —— 用户点了，要立刻有回应。
    ctx.closePageBar();
    ctx.armProgressRing();
    // 用户在这一页表过态了。此后长出来的新内容跟着翻，不必再点一次。
    if (ctx.autoTranslate) ctx.autoTranslate.markPageExplicit();
    // 子 frame 跟着翻：各自静默跑一轮（content/frames/）。
    ctx.frames.onManualTranslate();

    const feed = ctx.progressFeed.manual;
    // manual.begin 之后、end 之前：这一轮在进度源上还开着，出什么事都得收一次尾。
    let feedOpen = false;
    try {
      // 本页的站点规则（范围、排除、引擎）要先到：SW 冷启动时最多等 1.5 s。
      await ctx.customRules.whenReady();
      // 规则变化补的那一轮（custom-rule.js）还在跑：等它收完再收，两轮不同时收块。
      // 它不置 isTranslatingPage，所以这一下点击走的是上面的正常分支，不是忙分支。
      await ctx.customRules.whenCaughtUp();
      // 收集需要翻译的元素（以块级元素为单位）
      ctx.beginScopeRound();
      let translatableBlocks = ctx.collectPageBlocks();
      // 紧挨着上一行读，中间不能有 await。这个计数是收集器的模块级变量，每次
      // collectTranslatableBlocks 进门就清零 —— 自动翻译的发现层也在调它。隔着
      // 一次 await 去读，读到的可能是发现层那一次收集的结果。
      const managedSkipped = ctx.getManagedSkipCount();
      translatableBlocks = await ctx.filterBlocksByLanguage(translatableBlocks);

      if (translatableBlocks.length === 0 && ctx.frames.hasSizedChildren()) {
        // 这一层没东西可翻，内容在 iframe 里：它们各自静默翻，这里报「已翻译」或
        // 「无可译内容」都是错话。环由 finally 那一笔从 arming 退回来。
        return;
      }
      if (translatableBlocks.length === 0) {
        // 一块也收不到有两种完全不同的原因，不能都报“页面已翻译”：真的翻完了，
        // 还是正文整个落在受管容器里、且那里的块连生成内容都承不住。后者报
        // “已翻译”是彻头彻尾的误导。
        if (!managedSkipped) state.pageHasBeenTranslated = true;
        ctx.showPageNotice(managedSkipped ? t('pageContentNotTranslatable') : t('pageAlreadyTranslated'));
        return;
      }

      if (managedSkipped) {
        // 收到了大部分块，但受管容器里有几块画不出来（有公式、站点自己用了
        // ::after、块是 flex/grid 容器）。译文会照常出现，只是缺那几块，所以
        // 不打断流程，只留一条线索。
        console.info(`Blab Translation: ${managedSkipped} block(s) inside a managed editor root cannot carry generated content`);
      }

      // 分母是过滤之后真要送的块数。进度只报给进度源，环自己去读：翻译轮次只
      // 报数，不拖着任何界面 —— 自动翻译的增量轮用的是同一个 runTranslationPass。
      feed.begin(translatableBlocks.length);
      feedOpen = true;
      const failure = await ctx.runTranslationPass(translatableBlocks, {
        onProgress: (done, total, outcome) => {
          if (outcome === 'failed') feed.fail();
          else feed.settle();
        }
      });

      // 整轮失败：那句话连同它的入口（订阅 / 登录，Blab 账户的错误才有）一起上错误条。
      feedOpen = false;
      if (failure) {
        feed.end('error');
        ctx.showTranslationError(failure.message, failure.action);
      } else {
        // 有几块重试后仍没译成：环停在琥珀上、收尾条子照实说剩几块（点标记可单段重试）。
        const failed = ctx.progressFeed.state().failed;
        feed.end(failed > 0 ? 'partial' : 'done');
        state.pageHasBeenTranslated = true;
        if (failed > 0) ctx.showPageNotice(t('autoStatePartial').replace('{count}', String(failed)));
        else ctx.showTranslationComplete();
      }
    } catch (error) {
      console.error('Blab Translation: Page translation failed', error);
      if (feedOpen) {
        feedOpen = false;
        feed.end('error');
      }
      ctx.showTranslationError(error.message || t('translationFailed'));
    } finally {
      state.isTranslatingPage = false;
      // 环要在 isTranslatingPage 落下之后再看一眼：没走到 begin 的那几条路（只有
      // iframe、一块也没有、begin 之前就抛了）进度源没动过，环得自己从 arming 退回来。
      ctx.paintProgressRing();
      ctx.frames.onManualTranslateEnd();
      // 这一轮进行中规则变过的，补做清扫与补翻。放在最后：它和手动轮的成对收尾
      // （onManualTranslateEnd）无关，也不该因为它出错而漏掉那一步。
      ctx.customRules.afterRound();
    }
  }

  /**
   * 这一页现在有没有**整页翻译**的译文 —— 藏起来的也算。
   *
   * 两个调用方：悬浮球那一下点击（翻译还是还原），以及 popup 画按钮文案时问的
   * 那一次。两处各写一遍的话，迟早一处把判据写歪。
   *
   * 判据本身归显隐层（content/page/visibility.js）所有：划词和悬停译出来的块用
   * 的是同一个 .ai-translator-inline-block 类名，只是多带一个自己的类名。用户
   * 划词译了一句，这一页并不因此就「翻过了」—— 再点一下悬浮球该翻整页，不是把
   * 那一句藏起来。
   *
   * 受管译文（PDF、漫画，以及 Lexical 这类容器里画成 ::after 的那些）不必另问
   * 一句：它们的句柄也是 .ai-translator-inline-block，就挂在文档里的离屏
   * holder 上，同一条选择器一并数到，而悬停/划词的句柄同样带着自己的类名被排除。
   */
  function hasPageTranslations() {
    const selector = ctx.PAGE_TRANSLATION_SELECTOR;
    if (!selector) return false;
    for (const el of ctx.queryAllDeep(selector)) {
      // 受管译文没有自己的节点：句柄只是个挂在离屏 holder 上的替身，译文是原文
      // 块的那条 ::after。原文块离开文档之后（单页应用换页把那段子树整个换掉，
      // Lexical 这类编辑器自己重建子树也一样），::after 跟着没了，替身却还在
      // —— holder 挂在 body 上，换路由不动它。
      //
      // 数进去的样子：新的一页上 popup 写着「隐藏译文」，而悬浮球 / Alt+A 的第
      // 一下不是翻译这一页，是把一条不存在的译文「藏」一次；他得再按一次才开始
      // 翻。普通容器里没有这一出，那些译文节点就长在被换掉的子树里，一起走了。
      //
      // 这里只是**不数**，不顺手清理：一个还没重新挂回去的块不该在一次读里被
      // 判死刑。真正收掉孤儿的是换路由那一下，见 content-managed-translation.js。
      const block = ctx.getManagedTranslationBlock && ctx.getManagedTranslationBlock(el);
      if (block && !block.isConnected) continue;
      return true;
    }
    // 只有 iframe 里翻过的页面，Alt+A / 悬浮球 / popup 的「隐藏译文」照样要对。
    return ctx.frames.childrenHaveTranslations();
  }

  /**
   * 一次点击的语义：**要么翻译，要么还原**。
   *
   * 悬浮球单击、Alt+A、popup 的第二行走的都是这一个函数。三个入口各写一遍
   * 「有没有译文 → 藏还是翻」，迟早有一处把判断写歪：最容易歪的那一处是
   * 「藏起来的译文算不算有译文」——算成没有，点一下就会重新翻一遍整页。
   *
   * 还原这条路只藏译文、放回原文，**不撤销已经翻好的东西**：再点一下立刻就
   * 回来了，不必再花一次钱。
   *
   * @returns {'translating'|'restored'} 这一下做了哪件事（消息回话用）
   */
  function togglePageTranslation() {
    if (hasPageTranslations() && state.translationsVisible !== false) {
      ctx.setTranslationsVisible(false);
      return 'restored';
    }
    // 译文藏着的情况也走这里：translatePage() 开头就会把它们放出来，顺带把这一
    // 页里新长出来、还没翻的块补上。
    translatePage();
    return 'translating';
  }

  ctx.translatePage = translatePage;
  ctx.togglePageTranslation = togglePageTranslation;
  ctx.hasPageTranslations = hasPageTranslations;
})();
