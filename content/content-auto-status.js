// Blab Translation — 自动翻译的两处露头：追问条与状态点。
//
// 这一层只管「看得见」。判不判、翻到哪一步，全是 content/content-auto-translate.js
// 的事；它把 state() 摆在那儿、变了喊一声，这里订阅之后把那几个字段翻成用户看得
// 懂的东西。反过来这里绝不碰队列、代次和判定 —— 调度层的 publish() 把每个监听者
// 都裹在 try 里，为的就是让一个画坏了的圆点停在这一层，而不是把页面的翻译带停。
//
// 为什么追问是一条窄条而不是弹窗：它出现在一个用户没有要求过任何东西的时刻。弹窗
// 要先被处理掉才能看页面，那是拿走注意力去换一次点击；窄条贴在右下角，看见就顺手
// 点，看不见就当没问过 —— 而「当没问过」三次之后，这个域名就永远不问了。
(function () {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT;
  if (!ctx) return;

  const t = ctx.t;
  const STATUS = ctx.STATUS_AUTO;
  const BAR_ID = 'ai-translator-auto-bar';

  // 同一个域名问到第三次还没换来一次「翻译」，就再也不问了。
  //
  // 上限存在的理由不是礼貌，是这条计数**跨设备、跨标签页累加**：一个用户每天
  // 打开同一个站点十次、每次都把条子关掉，没有上限的话我们就每天问他十次，而他
  // 早就用行动回答过了。三次是「可能没看见」和「看见了不想要」之间的分界。
  const MAX_ASKS = 3;

  // 七个调度状态 → 一句人话。状态是冻的（STATUS_AUTO），这张表得跟着它齐。
  const STATE_KEYS = {
    OFF: 'autoStateOff',
    ASK: 'autoStateAsk',
    PENDING: 'autoStatePending',
    IDLE: 'autoStateIdle',
    RUNNING: 'autoStateRunning',
    PAUSED: 'autoStatePaused',
    ERROR: 'autoStateError'
  };

  // 调度层给出的理由 → 一句人话。这是状态点展开那一行的后半句：状态说的是
  // 「现在怎么样」，理由说的是「为什么是这样」，少了后半句，一个安安静静什么都
  // 没翻的页面和一个被黑名单挡住的页面在用户眼里一模一样。
  //
  // 前十一条是 decide() 的阶梯（shared/site-rules.js 的 REASONS，
  // test/unit/pdf-offer.test.mjs 盯着这张表要把它们全收齐）；末尾两条是阶梯之外
  // 那道费用闸（content/content-auto-translate.js 的 COST_REASONS）。这张表比
  // decide() 宽一点是有意的：它答的是「调度层为什么这样」，而 decide() 只是其中
  // 一个出处。
  const REASON_KEYS = {
    GLOBAL_OFF: 'autoReasonGlobalOff',
    BLOCKLIST: 'autoReasonBlocklist',
    BUILTIN_NEVER: 'autoReasonBuiltinNever',
    USER_NEVER: 'autoReasonUserNever',
    USER_EXPLICIT: 'autoReasonUserExplicit',
    USER_ALWAYS: 'autoReasonUserAlways',
    BUILTIN_ALWAYS: 'autoReasonBuiltinAlways',
    SAME_LANGUAGE: 'autoReasonSameLanguage',
    LANG_NOT_LISTED: 'autoReasonLangNotListed',
    UNKNOWN_LANGUAGE: 'autoReasonUnknownLanguage',
    DEFAULT_ASK: 'autoReasonDefaultAsk',
    COST_ENGINE: 'autoReasonCostEngine',
    COST_BUDGET: 'autoReasonCostBudget'
  };

  let latest = null;
  let bar = null;
  // 用户把条子关掉了。**这一下管到这个文档结束为止，不是管到下一次状态变化。**
  // SPA 里点进一篇帖子只是换了个路由，调度层会把代次翻篇重新判一遍，而对用户来
  // 说那还是他刚刚说过「不用」的那个站点 —— 跟着代次重置，reddit 上每点一下都
  // 会再问一次。整页导航会换一个新的内容脚本，那才是重新问的边界。
  let dismissed = false;
  // 这一页在追问额度里的号：'none' 还没要，'pending' 要了还没回，'granted' 要到
  // 了（条子这才画得出来），'denied' 超额。渲染每次状态变化都会跑，这个闩同时
  // 管住「一次追问只记一笔」——不然一次「问了一遍」会被记成十几次。
  let askSlot = 'none';
  let explaining = false;
  // 一句要让用户看见的话，显示到他自己关掉为止。今天只有一个来源：他勾了「总是」
  // 而那条规则没能写进去。**不能只写一行控制台日志** —— 勾选框是个乐观控件，他
  // 看到的是「记住了」，而下一次打开这个站点还会再问一遍，中间没有任何地方提起过
  // 这件事。（popup 上同一件事说的是同一句话，见 popupSiteRuleFailed。）
  let notice = '';

  // 「这一页还有另一件事可以做」。今天只有一个来源：PDF 文档上的
  // content/content-pdf-prompt.js（那一页没有正文可翻，它是唯一能办事的入口）。
  //
  // 形状是 { text, accept, dismiss } 而不是一个 mode 名：这一层不认识 PDF，也
  // 不该认识。它认识的只是「有人要借这条窄条说一句话、再收一次点击」——右下角
  // 就这一条窄条，第二条会和第一条叠在一起（和 notice 同一个道理）。
  let offer = null;

  // ------------------------------------------------------------------ 计数

  function askKey() {
    const host = location.hostname || '';
    return (globalThis.SiteRules && globalThis.SiteRules.normalizeHost(host)) || host;
  }

  function askCount() {
    const counts = ctx.settings.siteAskCount;
    const n = counts && counts[askKey()];
    return typeof n === 'number' && n > 0 ? n : 0;
  }

  /**
   * 记一笔追问计数。`'clear'` = 把这条记录删掉（用户表态了，前面问过几次都不
   * 算数）。
   *
   * **加一这件事不在这里做。** 同一个域名可能同时开着三个标签页，三页同时读出
   * 0、同时写回 1，说好的「问三次就不再问」一次都攒不满。读—改—写只能有一个
   * 主人，那个主人是服务工作者（shared/site-rules.js 的 updateAskCount 把这件事
   * 发过去）。
   *
   * 写回来的数顺手记进本页的 ctx.settings：storage.onChanged 也会送一份过来，
   * 但下一次 render() 可能比它先到。
   */
  async function updateAskCount(op) {
    const key = askKey();
    if (!key || !globalThis.SiteRules) return null;
    try {
      const count = await globalThis.SiteRules.updateAskCount(key, op);
      if (typeof count !== 'number') return null;
      const counts = Object.assign({}, ctx.settings.siteAskCount);
      if (count > 0) counts[key] = count;
      else delete counts[key];
      ctx.settings.siteAskCount = counts;
      return count;
    } catch (error) {
      // 记不住就当没问过。这条计数只决定「还问不问」，写失败不该把条子也带走。
      console.warn('Blab Translation: siteAskCount write failed', error);
      return null;
    }
  }

  const clearAskCount = () => updateAskCount('clear');

  /**
   * 跟计数的主人要一个「问这一次」的号，要到了才画条子。
   *
   * 次序是反过来的：先加一，再看加完是第几次。同一个站点同时开着四个标签页，
   * 四页都读到本地那个 0、都把条子画出来、事后各自加一 —— 说好的「最多问三次」
   * 当场变成四次，而那第四张条子已经在屏幕上了，再撤只是闪一下。先要号就不会
   * 有第四张：加一这件事只有一个主人（服务工作者，见 updateAskCount 的注释），
   * 它发回来的数才是这一次真正的排名。
   *
   * 要不到就当这一页问过了，不再重试。写失败（count 为 null）算要到 —— 这条
   * 计数只决定「还问不问」，存不上不该把条子也带走。
   */
  function reserveAskSlot() {
    if (askSlot !== 'none') return;
    askSlot = 'pending';
    updateAskCount('bump').then((count) => {
      if (typeof count === 'number' && count > MAX_ASKS) {
        askSlot = 'denied';
        dismissed = true;
      } else {
        askSlot = 'granted';
      }
      render();
    });
  }

  // ------------------------------------------------------------------ 文案

  function stateLabel(snap) {
    const key = STATE_KEYS[snap.status];
    if (!key) return '';
    if (snap.status === STATUS.IDLE && snap.gaveUp > 0) {
      return t('autoStatePartial').replace('{count}', String(snap.gaveUp));
    }
    return t(key);
  }

  function explainLine(snap) {
    const parts = [stateLabel(snap)];
    const reasonKey = REASON_KEYS[snap.reason];
    if (reasonKey) parts.push(t(reasonKey));
    // 引擎那句原话留在最后：密钥没填、地址写错这类错误，只有它说得出是哪一条。
    if (snap.status === STATUS.ERROR && snap.error) parts.push(String(snap.error));
    return parts.filter(Boolean).join(' · ');
  }

  // ------------------------------------------------------------------ 状态点

  /**
   * 五态：不亮 / 呼吸（在翻）/ 黄（跑完了还有没翻成的）/ 灰（暂停）/ 红（出错）。
   *
   * 「跑完了还有几段是原文」在调度层没有自己的状态 —— 它就是 IDLE，只是 gaveUp
   * 不为零。颜色的映射留在这一层，STATUS 那七个值才不用为了一种颜色再加一个。
   */
  function dotState(snap) {
    if (!snap) return 'none';
    switch (snap.status) {
      case STATUS.RUNNING: return 'running';
      case STATUS.ERROR: return 'error';
      case STATUS.PAUSED: return 'paused';
      case STATUS.IDLE: return snap.gaveUp > 0 ? 'partial' : 'none';
      // OFF / ASK / PENDING 不亮：没开始翻的页面上点一个灯，用户只会去点它。
      default: return 'none';
    }
  }

  /**
   * 把状态点画到悬浮球上。悬浮球的看门狗随时会把球整个重建一遍（页面脚本删了它
   * 就重建），重建后的 innerHTML 是初始的空白，所以那边 append 完会回头调这里。
   */
  function paintDot() {
    const dot = document.querySelector('#ai-translator-float-ball .ai-translator-status-dot');
    if (!dot) return;
    const next = dotState(latest);
    dot.dataset.state = next;
    // 这颗点没有文字，它的名字就是它此刻在说的那句话 —— 鼠标看 title，读屏看
    // aria-label，两边说的必须是同一句。
    const line = latest ? explainLine(latest) : '';
    dot.title = line;
    dot.setAttribute('aria-label', line);
  }

  // ------------------------------------------------------------------ 条子

  function removeBar() {
    if (bar && bar.parentNode) bar.parentNode.removeChild(bar);
    bar = null;
  }

  function buildBar() {
    const el = document.createElement('div');
    el.id = BAR_ID;
    el.innerHTML = `
      <span class="ai-translator-auto-text"></span>
      <label class="ai-translator-auto-remember">
        <input type="checkbox">
        <span class="ai-translator-auto-remember-text"></span>
      </label>
      <button class="ai-translator-auto-btn" data-act="translate"></button>
      <button class="ai-translator-auto-btn" data-act="dismiss"></button>
      <button class="ai-translator-auto-btn" data-act="close" aria-label="${t('close')}" title="${t('close')}">×</button>
    `;
    el.addEventListener('click', onBarClick);
    document.body.appendChild(el);
    return el;
  }

  function onBarClick(event) {
    const button = event.target.closest && event.target.closest('[data-act]');
    if (!button || !bar) return;
    const act = button.dataset.act;

    if (act === 'translate') {
      // 借条子说话的那一位（offer）自己收这一下：它要办的事和追问不是一回事，
      // 也不该被当成「这一页开译」。
      if (bar.dataset.mode === 'offer') {
        button.disabled = true;
        if (offer) offer.accept();
        return;
      }
      const remember = bar.querySelector('.ai-translator-auto-remember input');
      // 这一下要落两笔存储再开译，而开译会把条子收走 —— 收走之前先把按钮钉住，
      // 免得用户连点两下、记两次数。
      button.disabled = true;
      acceptAsk(!!(remember && remember.checked));
      return;
    }

    // dismiss 和 close 是同一件事的两个说法：这一页不要再问了。计数**不清**——
    // 「不用」正是那三次里的一次，清掉它等于永远问不到上限。
    //
    // 一次关掉一层：条子此刻显示的是哪一样，这一下关掉的就是哪一样。
    if (act === 'dismiss' || act === 'close') {
      if (notice) notice = '';
      else if (explaining) explaining = false;
      // 条子此刻显示的是谁的话，这一下就收谁 —— offer 自己记自己的「不用」，
      // 记在这一层就等于让站点的追问额度替它背账。
      else if (bar.dataset.mode === 'offer') { if (offer && offer.dismiss) offer.dismiss(); }
      else dismissed = true;
      render();
    }
  }

  /**
   * 用户在追问条上点了「翻译」。
   *
   * **勾了「总是」就要等规则真落地再翻。** 写规则是异步的，不等它就开译的话，
   * 用户在中间切走这一页（或者这一次写失败了），这个站点就只翻了这一次 ——
   * 而他明明说的是「总是」，条子却已经收走了，没有任何地方会再提起这件事。
   *
   * 写失败不拦着这一页翻：他要的就是现在这一页。但要说一声 —— 见 notice。
   *
   * 走 setSiteAuto 而不是 writeUserRule：「这个站点自动翻」是一句话，popup 上
   * 那一行和播放器里字幕菜单的第一项说的都是它，三处各写一遍，迟早有一处忘了
   * 顺带打开总开关、或者写成「把规则删掉」。顺带它还替我们挡住了存不进规则表的
   * host（file:// 页面上 location.hostname 是空串）：从前那一路是
   * writeUserRule 一声不响什么都不写，勾选框照样打着勾。
   *
   * 黑名单站点不必在这里挡：走到 ASK 就说明 decide() 没把它判成 BLOCKLIST
   * （那一档排在前面），条子压根不会出现。
   */
  async function acceptAsk(always) {
    let failed = false;
    if (always && globalThis.SiteRules) {
      try {
        await globalThis.SiteRules.setSiteAuto(location.hostname, true);
      } catch (error) {
        console.warn('Blab Translation: site rule write failed', error);
        failed = true;
      }
    }
    // 表过态了，前面问过几次都不算数：下次再来这个站点，三次的额度是满的。
    await clearAskCount();
    dismissed = true;
    if (ctx.autoTranslate) ctx.autoTranslate.markPageExplicit();
    setNotice(failed ? t('popupSiteRuleFailed') : '');
  }

  /**
   * 「有一句话要让用户看见」。
   *
   * 今天两个来源，说的是同一件事：站点规则没能写进去。一处是追问条上勾了「总
   * 是」（上面 acceptAsk），一处是悬浮球菜单第一行「不再自动翻译这个站点」——
   * 两处都是乐观控件，按下去界面就收了，不说的话用户看到的是「记住了」，而下次
   * 打开这个站点还是老样子。
   *
   * 摆在这里是因为条子只有这一层画得出来。别的层要说话就叫这一句，而不是自己
   * 再造一条窄条 —— 两条窄条会在右下角叠在一起。
   */
  function setNotice(text) {
    notice = text || '';
    render();
  }

  /**
   * 「有别的层要借这条窄条」。传 null 收回。
   *
   * 和 setNotice 是同一个道理的两半：那一句是**说给用户听**的结果，这一条是
   * **等用户点**的入口。两者都摆在这一层，因为右下角只画得出一条窄条。
   */
  function setOffer(next) {
    offer = next && typeof next.accept === 'function' ? next : null;
    render();
  }

  function shouldAsk(snap) {
    if (!snap || snap.status !== STATUS.ASK) return false;
    if (dismissed) return false;
    // 号要到了就是要到了。这一次的计数在要号时已经加过，再拿它和上限比就会把
    // 第三次问掉——加完正好等于 3。还没要号时，本地计数是一道预检：这个站点早
    // 就问满了，连那一趟往返都省了。
    if (askSlot === 'granted') return true;
    return askCount() < MAX_ASKS;
  }

  function render() {
    paintDot();

    const snap = latest;
    const asking = shouldAsk(snap);
    // 压在最上面的是那句「没存上」：它是对用户刚按下的那一下的回答，而且他不关
    // 掉就没有第二个地方会再提起它。往下是展开说明（他点了那颗点，要的就是那一
    // 行字），再往下才是追问。
    // offer 压在 ask 上面：会走到这里两者都在的只有 PDF 文档——整页翻译那一问在
    // 那里答的是一句办不到的话（正文在一个外进程 <embed> 里，收集层看到的是空
    // body），而 offer 是那一页真办得成的那件事。顺带它还护住了追问额度：要号那
    // 一步压在 mode === 'ask' 下面，一份 PDF 不会去花掉这个域名三次里的一次。
    const mode = notice ? 'notice' :
      (explaining ? 'explain' : (offer ? 'offer' : (asking ? 'ask' : '')));
    if (!mode) {
      removeBar();
      return;
    }

    // 追问得先要到号。本页读到的计数可能和另外三个标签页读到的是同一个 0，
    // 所以这里不认它，认服务工作者加完之后发回来的那个数（见 reserveAskSlot）。
    if (mode === 'ask' && askSlot !== 'granted') {
      // 号只在**看得见**的标签页里要。后台标签页（中键点开的那一串）和预渲染的
      // 那一份都会走到这里，而那张条子谁也没看见 —— 三次机会就这么在用户面前一次
      // 没露过的情况下花光，这个域名从此永远安静。等这一页真的被看见了再要：
      // visibilitychange 会把 render() 重新叫一遍（预渲染转正也走这个事件）。
      if (document.visibilityState === 'visible') reserveAskSlot();
      removeBar();
      return;
    }

    if (!bar || !document.body.contains(bar)) bar = buildBar();
    bar.dataset.mode = mode;

    if (mode === 'offer') {
      bar.querySelector('.ai-translator-auto-text').textContent = offer.text || '';
      bar.querySelector('[data-act="translate"]').textContent = t('autoAskTranslate');
      bar.querySelector('[data-act="dismiss"]').textContent = t('autoAskDismiss');
      // 追问用过的按钮可能还钉着（同一份 DOM 不重建，见 buildBar 的注释）。
      bar.querySelector('[data-act="translate"]').disabled = false;
      return;
    }

    if (mode === 'ask') {
      const site = askKey();
      bar.querySelector('.ai-translator-auto-text').textContent = t('autoAskPrompt');
      bar.querySelector('.ai-translator-auto-remember-text').textContent =
        t('autoAskAlways').replace('{site}', site);
      bar.querySelector('[data-act="translate"]').textContent = t('autoAskTranslate');
      bar.querySelector('[data-act="dismiss"]').textContent = t('autoAskDismiss');
      return;
    }

    bar.querySelector('.ai-translator-auto-text').textContent =
      mode === 'notice' ? notice : explainLine(snap);
  }

  // ------------------------------------------------------------------ 装配

  ctx.paintAutoStatusDot = paintDot;
  ctx.showAutoStatusNotice = setNotice;
  ctx.showAutoStatusOffer = setOffer;

  /**
   * 点状态点 → 展开一行说明；再点一下收回去。
   *
   * 不做浮层：这一行说的是「为什么这一页没翻」，用户读完就走，一个会跟着鼠标跑、
   * 要瞄准才能关掉的浮层在这里只是负担。
   */
  ctx.toggleAutoStatusExplain = function () {
    explaining = !explaining;
    render();
  };

  ctx.setupAutoStatus = function () {
    if (!ctx.autoTranslate) return;
    // 这一页从后台转到前台（或者预渲染转正）的那一刻，才轮到它开口问 ——
    // 要号这件事压在 render() 里那道可见性闸后面，没人叫它就一直不问。
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') render();
    });
    // onStateChange 订阅的那一刻就会回调一次当前状态，所以这里不用自己先读一遍
    // state() —— 那会是同一份快照画两遍。
    ctx.autoTranslate.onStateChange((snap) => {
      latest = snap;
      render();
    });
  };
})();
