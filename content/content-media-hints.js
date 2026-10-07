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
  // 做过了（任务交出去了）：条子收走，不再出来。
  let done = false;
  // 正在登录 / 正在交任务：按钮钉住，快捷键再按也不派第二份。
  let busy = false;

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
   */
  function dispatch(kind) {
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
    return Promise.resolve(ctx.startComicPageTranslation({ pageUrl: location.href, consent: true }));
  }

  async function run(kind) {
    if (busy) return;
    busy = true;
    paint();
    try {
      if (!(await ensureSignedIn())) return;
      // 条子当场收走，接力的是任务自己的界面（PDF 的通知、漫画卡片）；没送到
      // 才放回来，让他还有一个能再点一次的东西。
      const own = kind === hint;
      if (own) done = true;
      paint();
      if (!(await dispatch(kind)) && own) done = false;
    } finally {
      busy = false;
      paint();
    }
  }

  /**
   * MEDIA_SHORTCUT 的三个发送方：Alt+M、条子上那个按钮、popup 未登录时的
   * 「翻译此 PDF」。
   *
   * 不带 only（Alt+M 和条子）：这一页是什么就做什么；都不是就说一句（按了没
   * 反应看起来像坏了）—— 条子不算用掉，滚到漫画页再点还是它。「屏幕上有没有
   * 漫画页」只问 ctx.hasComicPageOnScreen() 这一处，快捷键和按钮是同一个答案。
   *
   * only === 'pdf'（popup 那一行）：只做 PDF。网址像 PDF 而文档不是的时候回
   * null、什么都不做也不说 —— 一个写着「翻译此 PDF」的按钮不能起漫画任务，
   * 也不该在页面上冒出漫画那句提示；接下来怎么办由 popup 决定（popup-pdf.js
   * handPdfToPage）。
   *
   * 回的是做了哪一种，给消息那一头看。
   */
  function runMediaShortcut(only) {
    if (only !== undefined && only !== 'pdf') throw new Error(`MEDIA_SHORTCUT: unknown kind ${only}`);
    if (only === 'pdf') {
      if (!isPdfPage()) return null;
      run('pdf');
      return 'pdf';
    }
    const kind = isPdfPage() ? 'pdf' : (ctx.hasComicPageOnScreen() ? 'comic' : null);
    if (!kind) {
      ctx.showAutoStatusNotice(t('mediaShortcutNothing'));
      return null;
    }
    run(kind);
    return kind;
  }

  // ------------------------------------------------------------------ 说

  function hintText(kind, shortcut) {
    if (!shortcut) return t(kind === 'pdf' ? 'mediaHintPdfNoShortcut' : 'mediaHintComicNoShortcut');
    return t(kind === 'pdf' ? 'mediaHintPdf' : 'mediaHintComic').replace('{shortcut}', shortcut);
  }

  function paint() {
    if (!ctx.showAutoStatusOffer) return;
    if (!hint || dismissed || done || switchedOff(hint)) {
      ctx.showAutoStatusOffer(null);
      return;
    }
    // null：还没问到；''：用户解绑了 —— 只有后者才值得领他去设置页。
    const shortcut = ctx.commandShortcut(COMMAND);
    ctx.showAutoStatusOffer({
      text: hintText(hint, shortcut),
      link: shortcut === '' ? { text: t('mediaHintSetShortcut'), onClick: openShortcutSettings } : null,
      busy,
      accept: runMediaShortcut,
      dismiss,
    });
  }

  // 服务工作者不回话（它只管开标签页），所以用 promise 形式：没人回是 resolve，
  // 送不到（扩展刚重载、上下文失效）才 reject —— 就在这一层说一声。
  function openShortcutSettings() {
    chrome.runtime.sendMessage({ type: 'OPEN_SHORTCUT_SETTINGS' })
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
      if (switchedOff('pdf')) return;
      hint = 'pdf';
      paint();
      return;
    }
    // 认领只在看得见的标签页里做：一个域名只认领一次，后台标签页（中键点开的
    // 那一串）和预渲染的那一份把它领走了，用户就永远见不到这句话。转到前台（预
    // 渲染转正也算）时 visibilitychange 会再叫一遍 detect()。
    if (document.visibilityState !== 'visible') return;
    if (location.hostname && !switchedOff('comic') && ctx.comic.hasComicStack()) claimComicHint();
  }

  ctx.runMediaShortcut = runMediaShortcut;

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
