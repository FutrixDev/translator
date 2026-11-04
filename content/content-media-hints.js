// Blab Translation — PDF / 漫画上的那条提示，和 Alt+M 那一下（D-353）。
//
// 一条铁律，整个文件都是它的实现：**入口可以自己出现，任务永远不自己开始。**
// PDF 走的是服务端排版任务，按页扣额度；漫画重绘也扣。一次没人同意过的扣费会
// 直接丢掉一个用户，所以这里只负责露出一个可以点的东西、告诉他快捷键是哪个；
// 点下去（或按下快捷键）之前，往任务接口的请求一个都不发（见
// test/e2e/pdf-prompt.spec.js 的断言）。
//
// 什么时候出现：
// - PDF：这个网址是一份 PDF 文档（和右键菜单同一问，shared/pdf-url.js）。每次都出。
// - 漫画：页面里至少三张够宽的漫画页上下紧挨着、合起来比窗口还高，而且其中
//   一页此刻就在屏幕上（comic.hasComicStack()；整栏都在折叠线下面时先不出，
//   滚到它再问）。**每个域名只出一次**：一栏大图的文章也会长这样，第二次再跳出来就是打扰了。记在 sync 的
//   comicHintHosts 里，由服务工作者排队写（background/media-hints.js）。
// - 两者都只在用户**没亲手关掉**这项功能时出现（AccountGate 的 'off'）。没登录
//   照样出：这条提示就是为没登录的人准备的，他点下去时先去登录。
//
// 用的时候（按钮或快捷键）：没登录 → 先走登录（COMIC_SIGN_IN，和 popup、漫画卡片
// 同一个入口），登上了就接着做刚才那件事；他把登录页关了 → 什么都不说，条子回到
// 原样。已登录但功能被他关掉了 → 这一下就是对这一页的同意（consent），照做，
// 不改设置。
//
// 为什么 PDF 这一页只能有这条，不能有整页翻译那条追问条：Chrome 的 PDF 查看器是
// 一个外进程 <embed>，文档正文根本不在这个 DOM 里。那条追问条在这里问出的是一句
// 办不到的话。条子本身不在这里画，画它的是 content-auto-status.js（offer 模式）；
// 自己再造一条的结果是两条窄条叠在同一个角上。
//
// 价格为什么不写成「约消耗 N 页额度」：客户端没有页数，先问一次价本身就是一次
// 往任务接口发的自动请求。确切的数字由点击之后那一问回答（background/pdf-jobs.js
// 的 askPdfCharge 通知）。
//
// 点下去之后，PDF 这一页的条子改说这份文档的任务（content-pdf-page-job.js，
// ctx.pdfPageJob）：它说的排在这句提示前面。
//
// 「翻译此页」那一下（悬浮球单击、Alt+A、popup 那一行，都是 TOGGLE_PAGE_TRANSLATION）
// 也先在这里问这一页是什么（pageToggle）：PDF 就交 PDF 任务，长条漫画就翻漫画，
// 其余照旧翻文字。那一下是用户亲手点的，和 Alt+M 一样算同意。
(function () {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT;
  if (!ctx) return;

  const t = ctx.t;
  const { FEATURE_STATES } = AccountGate;
  const COMMAND = 'translate-media';
  const FEATURE_KEYS = { pdf: 'enablePdfTranslation', comic: 'enableComicTranslation' };

  // 这一页的提示是哪一种：'pdf' | 'comic' | null（没有，或还没轮到）。
  let hint = null;
  let dismissed = false;
  // 做过了（任务交出去了）：条子收走，不再出来。PDF 一有任务记录就改听任务的。
  let done = false;
  // 交出去那一下条子上是哪一档旧记录（content-pdf-page-job.js 的 key()）：回话之后
  // 读到的还是它，就是这一下没写新记录（问价、没交成），由 done 说话。真交出去了
  // 收据总是新的一档（createdAt 每交一次都换），重试沿用同一个 operationId 也一样。
  let staleJob = '';
  // 正在登录 / 正在交任务：按钮钉住，快捷键再按也不派第二份。
  let busy = false;

  // 认出这是一份 PDF 之后才去跟它的任务，只跟一次（detect 会被叫很多遍）。
  let pdfPage = false;

  /**
   * 这个文档是一份 PDF 吗。
   *
   * 两问是因为它们坏在不同的地方：contentType 是正路，但插件文档在某些导航路径
   * 上把自己报成 text/html；那时候 body 里孤零零的那个 <embed type="application/
   * pdf"> 还在，它是 Chrome 查看器自己搭的壳。两问都不认就当不是。
   */
  function isPdfDocument() {
    if (document.contentType === 'application/pdf') return true;
    const body = document.body;
    if (!body || body.childElementCount !== 1) return false;
    const embed = body.firstElementChild;
    return !!(embed && embed.tagName === 'EMBED' &&
      /^application\/pdf\b/i.test(embed.getAttribute('type') || ''));
  }

  function isPdfPage() {
    return !!globalThis.PdfUrl && globalThis.PdfUrl.isLikelyPdfUrl(location.href) && isPdfDocument();
  }

  function switchedOff(kind) {
    return ctx.featureState(FEATURE_KEYS[kind]) === FEATURE_STATES.OFF;
  }

  // 发给服务工作者的消息都走 ctx.comic.sendMessage（content-comic-translation.js
  // 那一份，同一个 manifest 条目、装在这个文件之后，所以调用时再取）：送不到、
  // 没人回、上下文失效时同步抛，它都折成 { ok: false, error } 回来。

  // ------------------------------------------------------------------ 做

  /**
   * 没登录就先登录。true：可以接着做；false：停（取消不说话，失败说一声）。
   */
  async function ensureSignedIn() {
    if (ctx.signedIn) return true;
    const result = await ctx.comic.sendMessage({ type: 'COMIC_SIGN_IN' });
    if (result.ok) return true;
    if (result.error && result.error.code === 'sign_in_cancelled') return false;
    console.warn('Blab Translation: sign-in before media translation failed', result.error);
    ctx.showAutoStatusNotice(t('comicSignInFailed'));
    return false;
  }

  /**
   * 真正派活的那一处：PDF 发一条 PDF_TRANSLATE_URL，漫画交给漫画任务流。
   * 两者都带 consent —— 这一下就是用户的明确同意（见文件头）。
   *
   * resume：悬浮球「再翻一次」这一章（togglePage），走漫画那一头的
   * resumeComicChapter —— 已经翻好的页放回来、只买还没翻的页。
   */
  function dispatch(kind, { resume = false } = {}) {
    if (kind === 'pdf') {
      return ctx.comic.sendMessage({ type: 'PDF_TRANSLATE_URL', url: location.href, consent: true }).then((result) => {
        // 工作者被回收、扩展刚重载过：消息没送到。说一声，不然这一下看起来就是
        // 什么都没发生。其余的失败由服务工作者的通知来说（和右键菜单同一路）。
        if (result.ok || !result.error || result.error.code !== 'extension_context') return true;
        ctx.showAutoStatusNotice(t('pdfErrNetwork'));
        return false;
      });
    }
    // false：屏幕上没有漫画页，什么都没交出去（它自己已经说过了）。
    const start = resume ? ctx.resumeComicChapter : ctx.startComicPageTranslation;
    return Promise.resolve(start({ pageUrl: location.href, consent: true }));
  }

  async function run(kind, options) {
    if (busy) return;
    busy = true;
    paint();
    try {
      if (!(await ensureSignedIn())) return;
      // 交出去了，提示就收走，接力的是任务自己的界面：漫画是卡片，PDF 是这条条子
      // 说的任务（服务工作者回话时记录已经写好，读一遍 ctx.pdfPageJob 就接过条子）。
      // 没送到就留着，让他还有一个能再点一次的东西。
      const before = pdfPage ? ctx.pdfPageJob.key() : '';
      const sent = await dispatch(kind, options);
      if (sent && kind === 'pdf' && pdfPage) await ctx.pdfPageJob.resync();
      if (sent && kind === hint) {
        done = true;
        staleJob = before;
      }
    } finally {
      busy = false;
      paint();
    }
  }

  /**
   * MEDIA_SHORTCUT 的两个发送方：Alt+M 和条子上那个按钮。这一页是什么就做什么；
   * 都不是就说一句（按了没反应看起来像坏了）—— 条子不算用掉，滚到漫画页再点还是
   * 它。「屏幕上有没有漫画页」只问 ctx.hasComicPageOnScreen() 这一处，快捷键和
   * 按钮是同一个答案。和「翻译此页」（comicStripHere）不同，这里一张大图也算：
   * Alt+M 和条子本来就只翻 PDF 和漫画，按下去就是要翻这张图。
   *
   * 回的是做了哪一种，给消息那一头看。
   */
  function runMediaShortcut() {
    const kind = isPdfPage() ? 'pdf' : (ctx.hasComicPageOnScreen() ? 'comic' : null);
    if (!kind) {
      ctx.showAutoStatusNotice(t('mediaShortcutNothing'));
      return null;
    }
    run(kind);
    return kind;
  }

  // ------------------------------------------------------------------ 翻译此页

  /**
   * 「翻译此页」那一下在这一页上是什么：{ kind, restores, label }。
   *
   * kind 按这个顺序认：
   * - 'pdf'：这个文档就是一份 PDF（isPdfPage）。查看器里没有能翻的文字，只能交
   *   PDF 任务；功能被关掉也一样，这一下就是对这一页的同意（和 Alt+M 同一条）。
   * - 'comic'：长条漫画在屏上（comicStripHere，和漫画提示同一问）。功能被关掉
   *   就当文字页。
   * - 'text'：其余一切。
   *
   * restores：这一下是不是「放回原样」—— 文字页有译文且没藏着；漫画页有哪一页
   * 正显示着译图。漫画页上顺手翻过的文字不归这一下管：这一页是什么，这一下就管什么。
   *
   * label：这一下的名字（i18n 键），悬浮球的 title 和 popup 那一行的字。
   *
   * 悬浮球的提示、popup 那一行的字、点下去做什么，问的都是它（togglePage、
   * AUTO_PAGE_STATE），所以三处说的永远是同一件事。
   */
  function pageToggle() {
    if (isPdfPage()) return { kind: 'pdf', restores: false, label: 'pdfTranslateThis' };
    if (comicStripHere()) {
      const restores = ctx.comic.showingResults();
      return { kind: 'comic', restores, label: restores ? 'comicShowOriginal' : 'comicTranslateThisPage' };
    }
    const restores = ctx.translationsShown();
    return { kind: 'text', restores, label: restores ? 'hideTranslations' : 'translateCurrentPage' };
  }

  /**
   * 长条漫画在屏上，而且漫画功能没被关掉：漫画提示和「翻译此页」问的都是这一句。
   * 故意不是 hasComicPageOnScreen —— 一篇配了一张大图的文章也认得出一页「漫画」，
   * 不该因此去扣漫画额度（Alt+M 那一问见 runMediaShortcut）。
   */
  function comicStripHere() {
    return !switchedOff('comic') && ctx.comic.hasComicStack();
  }

  /**
   * TOGGLE_PAGE_TRANSLATION 和悬浮球单击。回 { action }：'restored'，或
   * 'translating' —— 后者是「已经请求了」，不是「已经开始了」：正在登录时的第二下
   * （busy）、屏上已经没有漫画页，都由各自那一路去说。
   *
   * 漫画这一章的两半归漫画那一头（content-comic-translation.js）：还原只换回原图、
   * 停掉整章自动续翻，不撤销任何已经买下的东西；再点一下是 resume，先把它们放回来
   * （免费），再接着翻屏幕上还没翻的页。
   */
  function togglePage() {
    const { kind, restores } = pageToggle();
    if (kind === 'text') return { action: ctx.togglePageTranslation() };
    if (kind === 'comic' && restores) {
      ctx.restoreComicChapter();
      return { action: 'restored' };
    }
    run(kind, { resume: kind === 'comic' });
    return { action: 'translating' };
  }

  // ------------------------------------------------------------------ 说

  function hintText(kind, shortcut) {
    if (!shortcut) return t(kind === 'pdf' ? 'mediaHintPdfNoShortcut' : 'mediaHintComicNoShortcut');
    return t(kind === 'pdf' ? 'mediaHintPdf' : 'mediaHintComic').replace('{shortcut}', shortcut);
  }

  function paint() {
    if (!ctx.showAutoStatusOffer) return;
    const shown = pdfPage ? ctx.pdfPageJob.offer({ busy }) : null;
    if (shown) {
      ctx.showAutoStatusOffer(shown);
      return;
    }
    // 有新记录时由任务说提示回不回来（取消了、还能重来的失败关掉之后要回来）；
    // 没有记录、或者还是点之前那一档，由 done 说（问价、没交成）。
    const current = pdfPage ? ctx.pdfPageJob.key() : '';
    const handedOff = current && !(done && current === staleJob) ? ctx.pdfPageJob.ownsBar() : done;
    if (!hint || dismissed || handedOff || switchedOff(hint)) {
      ctx.showAutoStatusOffer(null);
      return;
    }
    // null：还没问到；''：用户解绑了 —— 只有后者才值得领他去设置页。
    const shortcut = ctx.commandShortcut(COMMAND);
    ctx.showAutoStatusOffer({
      text: hintText(hint, shortcut),
      link: shortcut === '' ? { text: t('setShortcut'), onClick: openShortcutSettings } : null,
      busy,
      accept: { text: t('autoOfferAccept'), run: () => runMediaShortcut() },
      decline: t('autoOfferDismiss'),
      dismiss,
    });
  }

  // 服务工作者开好标签页回 {ok}，开不了回 {error}；送不到（扩展刚重载、上下文
  // 失效）是 reject —— 都在这一层说一声。
  function openShortcutSettings() {
    chrome.runtime.sendMessage({ type: 'OPEN_SHORTCUT_SETTINGS' })
      .then((reply) => {
        if (!reply || !reply.ok) console.warn('Blab Translation: open shortcut settings failed', reply && reply.error);
      })
      .catch(error => console.warn('Blab Translation: open shortcut settings failed', error));
  }

  function dismiss() {
    dismissed = true;
    paint();
  }

  // 漫画提示先向服务工作者认领这个域名；认领到了才出（见 background/media-hints.js）。
  let comicClaimed = false;
  async function claimComicHint() {
    if (comicClaimed) return;
    comicClaimed = true;
    const reply = await ctx.comic.sendMessage({ type: 'COMIC_HINT_WRITE', kind: 'claim', host: location.hostname });
    if (reply.error) {
      // 没认领到：闩放开，下一次 detect()（滚动、visibilitychange）再问一次。
      comicClaimed = false;
      console.warn('Blab Translation: comic hint claim failed', reply.error);
      return;
    }
    if (reply.value !== true) return;
    hint = 'comic';
    paint();
  }

  function detect() {
    if (hint) return;
    if (isPdfPage()) {
      if (!pdfPage) {
        pdfPage = true;
        ctx.pdfPageJob.attach({ repaint: paint, retry: () => run('pdf') });
      }
      if (switchedOff('pdf')) return;
      hint = 'pdf';
      paint();
      return;
    }
    // 认领只在看得见的标签页里做：一个域名只认领一次，后台标签页（中键点开的
    // 那一串）和预渲染的那一份把它领走了，用户就永远见不到这句话。转到前台（预
    // 渲染转正也算）时 visibilitychange 会再叫一遍 detect()。
    if (document.visibilityState !== 'visible') return;
    if (location.hostname && comicStripHere()) claimComicHint();
  }

  ctx.runMediaShortcut = runMediaShortcut;
  ctx.pageToggle = pageToggle;
  ctx.togglePage = togglePage;

  ctx.setupMediaHints = function () {
    // 内容脚本在 document_end 就跑了：Chrome 的查看器在那之后才把 <embed> 搭起
    // 来，漫画页的图也还没解码完（自然尺寸是 0）。所以除了当场一问，再在下一帧、
    // load 和滚动时各问一次，直到有了答案。
    detect();
    requestAnimationFrame(detect);
    window.addEventListener('load', detect, { once: true });
    document.addEventListener('visibilitychange', detect);
    let scrollTimer = null;
    window.addEventListener('scroll', () => {
      if (hint || comicClaimed || scrollTimer) return;
      scrollTimer = setTimeout(() => { scrollTimer = null; detect(); }, 500);
    }, { passive: true });
    // 用户去 chrome://extensions/shortcuts 改了键位再回来：条子上的字跟着换。
    ctx.onCommandShortcuts(paint);
  };
})();
