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

  // decide() 的十个理由 → 一句人话。这是状态点展开那一行的后半句：状态说的是
  // 「现在怎么样」，理由说的是「为什么是这样」，少了后半句，一个安安静静什么都
  // 没翻的页面和一个被黑名单挡住的页面在用户眼里一模一样。
  const REASON_KEYS = {
    GLOBAL_OFF: 'autoReasonGlobalOff',
    BLOCKLIST: 'autoReasonBlocklist',
    USER_NEVER: 'autoReasonUserNever',
    USER_EXPLICIT: 'autoReasonUserExplicit',
    USER_ALWAYS: 'autoReasonUserAlways',
    BUILTIN_ALWAYS: 'autoReasonBuiltinAlways',
    SAME_LANGUAGE: 'autoReasonSameLanguage',
    LANG_NOT_LISTED: 'autoReasonLangNotListed',
    UNKNOWN_LANGUAGE: 'autoReasonUnknownLanguage',
    DEFAULT_ASK: 'autoReasonDefaultAsk'
  };

  let latest = null;
  let bar = null;
  // 用户把条子关掉了。**这一下管到这个文档结束为止，不是管到下一次状态变化。**
  // SPA 里点进一篇帖子只是换了个路由，调度层会把代次翻篇重新判一遍，而对用户来
  // 说那还是他刚刚说过「不用」的那个站点 —— 跟着代次重置，reddit 上每点一下都
  // 会再问一次。整页导航会换一个新的内容脚本，那才是重新问的边界。
  let dismissed = false;
  // 这一页已经把追问记过一笔了。渲染每次状态变化都会跑，不闩住的话一次「问了一
  // 遍」会被记成十几次，三次的额度当场就用完了。
  let counted = false;
  let explaining = false;

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
    if (!key || !globalThis.SiteRules) return;
    try {
      const count = await globalThis.SiteRules.updateAskCount(key, op);
      if (typeof count !== 'number') return;
      const counts = Object.assign({}, ctx.settings.siteAskCount);
      if (count > 0) counts[key] = count;
      else delete counts[key];
      ctx.settings.siteAskCount = counts;
    } catch (error) {
      // 记不住就当没问过。这条计数只决定「还问不问」，写失败不该把条子也带走。
      console.warn('Blab Translation: siteAskCount write failed', error);
    }
  }

  const bumpAskCount = () => updateAskCount('bump');
  const clearAskCount = () => updateAskCount('clear');

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
    dot.title = latest ? explainLine(latest) : '';
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
      const remember = bar.querySelector('.ai-translator-auto-remember input');
      // 这一下要落两笔存储再开译，而开译会把条子收走 —— 收走之前先把按钮钉住，
      // 免得用户连点两下、记两次数。
      button.disabled = true;
      acceptAsk(!!(remember && remember.checked));
      return;
    }

    // dismiss 和 close 是同一件事的两个说法：这一页不要再问了。计数**不清**——
    // 「不用」正是那三次里的一次，清掉它等于永远问不到上限。
    if (act === 'dismiss' || act === 'close') {
      if (explaining) explaining = false;
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
   * 写失败不拦着这一页翻：他要的就是现在这一页。规则没落地的后果是下次再来时
   * 照样会问，这本来就是实情。
   */
  async function acceptAsk(always) {
    if (always && globalThis.SiteRules) {
      try {
        await globalThis.SiteRules.writeUserRule(location.hostname, 'always');
      } catch (error) {
        console.warn('Blab Translation: site rule write failed', error);
      }
    }
    // 表过态了，前面问过几次都不算数：下次再来这个站点，三次的额度是满的。
    await clearAskCount();
    dismissed = true;
    if (ctx.autoTranslate) ctx.autoTranslate.markPageExplicit();
    render();
  }

  function shouldAsk(snap) {
    if (!snap || snap.status !== STATUS.ASK) return false;
    if (dismissed) return false;
    return askCount() < MAX_ASKS;
  }

  function render() {
    paintDot();

    const snap = latest;
    const asking = shouldAsk(snap);
    // 展开说明压在追问之上：用户点了那颗点，要的就是那一行字。
    const mode = explaining ? 'explain' : (asking ? 'ask' : '');
    if (!mode) {
      removeBar();
      return;
    }

    if (!bar || !document.body.contains(bar)) bar = buildBar();
    bar.dataset.mode = mode;

    if (mode === 'ask') {
      const site = askKey();
      bar.querySelector('.ai-translator-auto-text').textContent = t('autoAskPrompt');
      bar.querySelector('.ai-translator-auto-remember-text').textContent =
        t('autoAskAlways').replace('{site}', site);
      bar.querySelector('[data-act="translate"]').textContent = t('autoAskTranslate');
      bar.querySelector('[data-act="dismiss"]').textContent = t('autoAskDismiss');
      if (!counted) {
        counted = true;
        bumpAskCount();
      }
      return;
    }

    bar.querySelector('.ai-translator-auto-text').textContent = explainLine(snap);
  }

  // ------------------------------------------------------------------ 装配

  ctx.paintAutoStatusDot = paintDot;

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
    // onStateChange 订阅的那一刻就会回调一次当前状态，所以这里不用自己先读一遍
    // state() —— 那会是同一份快照画两遍。
    ctx.autoTranslate.onStateChange((snap) => {
      latest = snap;
      render();
    });
  };
})();
