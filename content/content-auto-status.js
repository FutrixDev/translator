// Blab Translation — 自动翻译的两处露头：右下角窄条与状态点。
//
// 这一层只管「看得见」。判不判、翻到哪一步，全是 content/content-auto-translate.js
// 的事；它把 state() 摆在那儿、变了喊一声，这里订阅之后把那几个字段翻成用户看得
// 懂的东西。反过来这里绝不碰队列、代次和判定 —— 调度层的 publish() 把每个监听者
// 都裹在 try 里，为的就是让一个画坏了的圆点停在这一层，而不是把页面的翻译带停。
//
// 没有追问（D-351）：不在内置名单、用户也没写过规则的站点，判定就是安静的「不
// 翻」，这里什么都不画。要翻就从 popup、悬浮球或快捷键开 —— 窄条只剩三个用处：
// 一句「没存上」（notice）、状态点展开的那一行（explain）、别的层借它收一次点击
// （offer，今天是 PDF）。
(function () {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT;
  if (!ctx) return;

  const t = ctx.t;
  const STATUS = ctx.STATUS_AUTO;
  const BAR_ID = 'ai-translator-auto-bar';

  // 五个调度状态 → 一句人话。状态是冻的（STATUS_AUTO），这张表得跟着它齐。
  const STATE_KEYS = {
    OFF: 'autoStateOff',
    IDLE: 'autoStateIdle',
    RUNNING: 'autoStateRunning',
    PAUSED: 'autoStatePaused',
    ERROR: 'autoStateError'
  };

  // 理由 → 一句人话：shared/auto-reason-keys.js，popup 的站点行读的是同一张。
  const REASON_KEYS = globalThis.AutoReasonKeys;

  let latest = null;
  let bar = null;
  let explaining = false;
  // 一句要让用户看见的话，显示到他自己关掉为止。今天的来源是悬浮球菜单那一行
  // 「不再自动翻译这个站点」没能把规则写进去。**不能只写一行控制台日志** —— 那是
  // 个乐观控件，他看到的是「记住了」，而下一次打开这个站点还是老样子，中间没有
  // 任何地方提起过这件事。（popup 上同一件事说的是同一句话，见 popupSiteRuleFailed。）
  let notice = '';

  // 「这一页还有另一件事可以做」。今天只有一个来源：PDF 文档上的
  // content/content-pdf-prompt.js（那一页没有正文可翻，它是唯一能办事的入口）。
  //
  // 形状是 { text, accept, dismiss } 而不是一个 mode 名：这一层不认识 PDF，也
  // 不该认识。它认识的只是「有人要借这条窄条说一句话、再收一次点击」——右下角
  // 就这一条窄条，第二条会和第一条叠在一起（和 notice 同一个道理）。
  let offer = null;

  // 拾取器开着（content/picker/picker.js）：右下角这条窄条整条让位，不论它正在
  // 说什么。375 宽时它横在底边那一带，正好压在用户要点的那一块上；notice 也不
  // 例外 —— 拾取器存好了那一句还挂着时他再开一次拾取器去排下一块，它照样挡着，
  // 而拾取器在捕获阶段吃掉点击，那个 × 也点不动。关掉后按原状态画回来（notice
  // 他没关就照样回来）。
  let yielding = false;

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
      // OFF 不亮：没开始翻的页面上点一个灯，用户只会去点它。
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

    // 「翻译」按钮只在 offer 那一档露出来（见 render），这一下归借条子说话的
    // 那一位：它要办的事它自己知道。先把按钮钉住，免得连点两下办两次。
    if (act === 'translate') {
      if (bar.dataset.mode !== 'offer' || !offer) return;
      button.disabled = true;
      offer.accept();
      return;
    }

    // dismiss 和 close 是同一件事的两个说法。一次关掉一层：条子此刻显示的是哪一
    // 样，这一下关掉的就是哪一样。
    if (act === 'dismiss' || act === 'close') {
      if (notice) notice = '';
      else if (explaining) explaining = false;
      // offer 自己记自己的「不用」。
      else if (bar.dataset.mode === 'offer') { if (offer && offer.dismiss) offer.dismiss(); }
      render();
    }
  }

  /**
   * 「有一句话要让用户看见」。
   *
   * 今天的来源：悬浮球菜单第一行「不再自动翻译这个站点」没能把规则写进去。那是
   * 乐观控件，按下去界面就收了，不说的话用户看到的是「记住了」，而下次打开这个
   * 站点还是老样子。
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

  function render() {
    paintDot();

    const snap = latest;
    // 拾取器开着时什么都不画（见 yielding），notice 留着，关掉后照样回来。其余
    // 时候压在最上面的是那句「没存上」：它是对用户刚按下的那一下的回答，而且他
    // 不关掉就没有第二个地方会再提起它。往下是展开说明（他点了那颗点，要的就是
    // 那一行字），再往下是 offer。
    const mode = yielding ? '' : (notice ? 'notice' : (explaining ? 'explain' : (offer ? 'offer' : '')));
    if (!mode) {
      removeBar();
      return;
    }

    if (!bar) bar = buildBar();
    else if (!document.body.contains(bar)) document.body.appendChild(bar);
    bar.dataset.mode = mode;

    if (mode === 'offer') {
      bar.querySelector('.ai-translator-auto-text').textContent = offer.text || '';
      bar.querySelector('[data-act="translate"]').textContent = t('autoOfferAccept');
      bar.querySelector('[data-act="dismiss"]').textContent = t('autoOfferDismiss');
      // 上一次 offer 按下去钉住的按钮可能还钉着（同一份 DOM 不重建）。
      bar.querySelector('[data-act="translate"]').disabled = false;
      return;
    }

    bar.querySelector('.ai-translator-auto-text').textContent =
      mode === 'notice' ? notice : explainLine(snap);
  }

  // ------------------------------------------------------------------ 装配

  ctx.paintAutoStatusDot = paintDot;
  ctx.showAutoStatusNotice = setNotice;
  ctx.showAutoStatusOffer = setOffer;

  /** 拾取器开着时让位（true），关掉后按原来的状态画回来（false）。 */
  ctx.yieldAutoStatus = function (on) {
    yielding = !!on;
    render();
  };

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
