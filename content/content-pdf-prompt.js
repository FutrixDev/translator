// Blab Translation — PDF 文档上那条「翻译这篇文档」提示条。
//
// 一条铁律，整个文件都是它的实现：**入口可以自己出现，任务永远不自己开始。**
// PDF 走的是服务端排版任务，按页扣额度，而额度是钱。一次没人同意过的扣费会直接
// 丢掉一个用户，所以这里只负责露出一个可以点的东西；点下去之前，往任务接口的
// 请求一个都不发（见 test/e2e/pdf-prompt.spec.js 的断言）。
//
// 为什么这一页只能有这条，不能有整页翻译那条追问条：Chrome 的 PDF 查看器是一个
// 外进程 <embed>，文档正文根本不在这个 DOM 里 —— 收集层看到的是一个空 body。
// 那条追问条在这里问出的是一句办不到的话。arxiv 的 /pdf/ 已经在内置表里写成
// never 把它按住了，其余域名的 .pdf 则靠模式阶梯压住（content-auto-status.js）。
//
// 条子本身不在这里画。右下角只有一条窄条，画它的是 content-auto-status.js；这一
// 层把「说什么、点了怎么办」递过去（ctx.showAutoStatusOffer）。自己再造一条的
// 结果是两条窄条叠在同一个角上。
//
// 价格为什么不写成「约消耗 N 页额度」：客户端没有页数。服务端的报价只在创建任务
// 被 409 挡下时才回来（background/pdf-jobs.js 的 askPdfCharge 把它变成带两个按钮
// 的通知），而**先问一次价**本身就是一次往任务接口发的自动请求，正是上面那条铁
// 律不许的事。所以条子说的是计价方式（按页数），确切的数字由点击之后那一问回答
// —— 那时它是真的，而不是我们猜的。
(function () {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT;
  if (!ctx) return;

  const t = ctx.t;

  let dismissed = false;
  let sent = false;

  /**
   * 这个文档是一份 PDF 吗。
   *
   * 两问是因为它们坏在不同的地方：contentType 是正路，但插件文档在某些导航路径
   * 上把自己报成 text/html；那时候 body 里孤零零的那个 <embed type="application/
   * pdf"> 还在，它是 Chrome 查看器自己搭的壳。两问都不认就当不是 —— 认错的代价
   * 是在一个普通网页上挂一条没有意义的条子。
   */
  function isPdfDocument() {
    if (document.contentType === 'application/pdf') return true;
    const body = document.body;
    if (!body || body.childElementCount !== 1) return false;
    const embed = body.firstElementChild;
    return !!(embed && embed.tagName === 'EMBED' &&
      /^application\/pdf\b/i.test(embed.getAttribute('type') || ''));
  }

  /**
   * 该不该露这条。
   *
   * 三问，缺一不可：功能开着（enablePdfTranslation 在 content-bootstrap.js 里
   * 已经过了账号闸，没登录的设备上它是 false），这个网址确实是一份 PDF（和右键
   * 菜单同一问，shared/pdf-url.js），以及用户还没把这条关掉。
   */
  function shouldOffer() {
    if (dismissed || sent) return false;
    if (!ctx.settings || !ctx.settings.enablePdfTranslation) return false;
    if (!globalThis.PdfUrl || !globalThis.PdfUrl.isLikelyPdfUrl(location.href)) return false;
    return isPdfDocument();
  }

  /**
   * 用户点了「翻译」。
   *
   * 这一下**只发一条消息**，之后的一切都归服务工作者：它判功能开关、判网址、
   * 认出正在跑的同一份文档、该问价时弹那条带两个按钮的通知。右键菜单点下去走的
   * 是同一个函数（startPdfUrlTranslation），所以两个入口不会有两套说法。
   *
   * 条子当场收走，接力的是通知 —— 和右键菜单那一路一模一样。收走之前先把状态
   * 置上，免得连点两下派出两份任务。
   */
  function accept() {
    if (sent) return;
    sent = true;
    refresh();
    chrome.runtime.sendMessage({ type: 'PDF_TRANSLATE_URL', url: location.href }, () => {
      // 工作者被回收、扩展刚重载过：消息没送到，而条子已经收了。说一声，不然
      // 这一下看起来就是什么都没发生。
      if (chrome.runtime.lastError) {
        sent = false;
        // 先把条子放回来再说话：那句话压在条子上面（模式阶梯），用户关掉它之后
        // 底下得还有一个能再点一次的东西。
        refresh();
        if (ctx.showAutoStatusNotice) ctx.showAutoStatusNotice(t('pdfErrNetwork'));
      }
    });
  }

  function dismiss() {
    dismissed = true;
    refresh();
  }

  function refresh() {
    if (!ctx.showAutoStatusOffer) return;
    ctx.showAutoStatusOffer(shouldOffer() ? { text: t('pdfAskPrompt'), accept, dismiss } : null);
  }

  ctx.setupPdfPrompt = function () {
    // 内容脚本在 document_end 就跑了，而 Chrome 的查看器是在那之后才把 <embed>
    // 搭起来的 —— isPdfDocument() 的第二问这时候还答不出。contentType 那一问
    // 通常已经够了，这里补一次延后的重判，代价是一个 requestAnimationFrame。
    refresh();
    if (!shouldOffer()) requestAnimationFrame(refresh);
  };
})();
