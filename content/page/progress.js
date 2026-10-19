// Blab Translation — 整页翻译：提示条与悬浮球上的进度环
//
// 页面上那条小条子：提示、成功、报错三种样子，连同它的拖动、摆位和语言包下载
// 的文字。条子只在有话要说时才出现，翻译流程通过 ctx 上这几个函数跟它说话。
//
// 翻了多少不写在条子上，画在悬浮球的环上（文件后半「进度环」一节）：环只读
// ctx.progressFeed，手动整页和自动调度层报的是同一份数。环的 svg 在球的
// innerHTML 里（content-float-ball.js），怎么画在这里。
(function() {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT;
  if (!ctx) return;

  const { state } = ctx;
  const t = ctx.t;
  const escapeHtml = ctx.escapeHtml;
  const CLOSE_BUTTON = (title) => `
        <button class="ai-translator-progress-close" title="${title}">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round">
            <path d="M18 6L6 18M6 6l12 12"/>
          </svg>
        </button>`;

  // 条子的几种样子。换样子先把别的全摘掉：成功条上挂着上一回的 error-state，
  // 红边框就跟着绿勾一起出来了。
  const BAR_STATES = ['info', 'error', 'success'];

  function setBarState(progressEl, name) {
    for (const each of BAR_STATES) progressEl.classList.remove(`ai-translator-progress-${each}-state`);
    if (name) progressEl.classList.add(`ai-translator-progress-${name}-state`);
  }

  /**
   * 换一次内容：正文、关闭键、样子、位置一起换。关闭键随 innerHTML 重建，事件
   * 也要重绑 —— 用 mousedown 截住，好走在拖动逻辑前面。`fill` 往新内容里装
   * 别的节点（错误条的入口按钮），装在摆位之前：摆位量的是装好之后的尺寸。
   */
  function renderBar(progressEl, stateName, contentHtml, closeTitle, fill = null) {
    clearTimeout(closeTimers.get(progressEl));
    delete progressEl.dataset.kind;
    progressEl.innerHTML = contentHtml + CLOSE_BUTTON(closeTitle);
    if (fill) fill(progressEl);
    setBarState(progressEl, stateName);
    const closeBtn = progressEl.querySelector('.ai-translator-progress-close');
    closeBtn.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      e.preventDefault();
    });
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      // 用户亲手关掉的语言包下载条，这一轮手动整页里不再建回来（下一下点击清掉）。
      if (progressEl.dataset.kind === 'download') downloadBarDismissed = true;
      forceHideProgressBar();
    });
    placeBarNearBall(progressEl);
  }

  // 这一轮手动整页里，用户关掉过语言包下载条（armProgressRing 在下一轮清掉）。
  let downloadBarDismissed = false;

  // 每条条子至多一个待收的计时器。换内容时作废上一个：成功条 5 s 后要收，
  // 子 frame 随后报来带入口的错误条（frames/top.js）不该被它顺手收掉。
  const closeTimers = new WeakMap();

  function closeBarAfter(progressEl, ms) {
    closeTimers.set(progressEl, setTimeout(() => {
      if (!progressEl.parentNode) return;
      progressEl.classList.add('ai-translator-progress-done');
      setTimeout(() => {
        if (progressEl.parentNode) progressEl.remove();
      }, 300);
    }, ms));
  }

  /** 立刻收掉，不走淡出：下一样东西马上要占这个位置。 */
  function closeBar(progressEl) {
    clearTimeout(closeTimers.get(progressEl));
    progressEl.remove();
  }

  /**
   * 拿到那条条子，没有就现建一条。条子平时不在页面上：一轮翻译开始时什么也不
   * 建（进度看球上的环），有话要说的时候才建。
   */
  function ensureBar() {
    const existing = document.getElementById('ai-translator-progress');
    // 正在淡出的那条（关闭键、到点自收）300 ms 后会被它自己的计时器摘掉，不能接着用。
    if (existing && !existing.classList.contains('ai-translator-progress-done')) return existing;
    if (existing) closeBar(existing);
    const progressEl = document.createElement('div');
    progressEl.id = 'ai-translator-progress';
    document.body.appendChild(progressEl);
    setupProgressBarDrag(progressEl);
    return progressEl;
  }

  function setupProgressBarDrag(progressEl) {
    let isDragging = false;
    let startX, startY, initialX, initialY;

    progressEl.addEventListener('mousedown', (e) => {
      // 忽略关闭按钮点击
      if (e.target.classList.contains('ai-translator-progress-close')) return;
      
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      
      const rect = progressEl.getBoundingClientRect();
      initialX = rect.left;
      initialY = rect.top;
      
      progressEl.classList.add('dragging');
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;

      const deltaX = e.clientX - startX;
      const deltaY = e.clientY - startY;

      let newX = initialX + deltaX;
      let newY = initialY + deltaY;

      // 保持在视口内：按条子此刻的真实尺寸（错误条比进度条宽、也高）。
      newX = Math.max(0, Math.min(window.innerWidth - progressEl.offsetWidth, newX));
      newY = Math.max(0, Math.min(window.innerHeight - progressEl.offsetHeight, newY));

      progressEl.style.left = `${newX}px`;
      progressEl.style.top = `${newY}px`;
    });

    document.addEventListener('mouseup', () => {
      if (isDragging) {
        isDragging = false;
        progressEl.classList.remove('dragging');
      }
    });
  }

  const BAR_MARGIN = 10;
  const BAR_GAP = 12;

  // 球此刻占的地方：贴边时还有一截胶囊底。都没露面（设置里关了球、视频全屏时
  // 让开）就是 null。
  function ballBounds() {
    const rects = [state.floatBall, state.floatBallContainer]
      .filter((el) => el && el.isConnected)
      .map((el) => el.getBoundingClientRect())
      .filter((r) => r.width > 0 && r.height > 0);
    if (!rects.length) return null;
    return {
      left: Math.min(...rects.map((r) => r.left)),
      top: Math.min(...rects.map((r) => r.top)),
      right: Math.max(...rects.map((r) => r.right)),
      bottom: Math.max(...rects.map((r) => r.bottom))
    };
  }

  /**
   * 按条子自己的实测尺寸摆到球旁边：先试球下方，放不下试上方、左侧、右侧，
   * 都不行再试视口四角；每个候选都得整条在视口里、且不碰球。进度条、错误条、
   * 提示条、成功条宽高都不一样（错误条 280–400 宽、两三行高），换一次内容就
   * 重摆一次 —— 包括用户这一轮里拖过的条子。
   *
   * 量的是布局尺寸（offsetWidth），不是 getBoundingClientRect：入场动画的
   * scale 还在跑时后者是缩小过的。先挪到左上角再量：fixed 的条子宽度是收缩
   * 适配的，在原位（球下面，右边只剩 230px）量出来的是被挤窄的宽度。
   */
  function placeBarNearBall(progressEl) {
    progressEl.style.left = `${BAR_MARGIN}px`;
    progressEl.style.top = `${BAR_MARGIN}px`;
    const width = progressEl.offsetWidth;
    const height = progressEl.offsetHeight;
    const viewW = document.documentElement.clientWidth || window.innerWidth;
    const viewH = window.innerHeight;
    const maxLeft = viewW - width - BAR_MARGIN;
    const maxTop = viewH - height - BAR_MARGIN;
    const clampX = (x) => Math.max(BAR_MARGIN, Math.min(x, maxLeft));
    const clampY = (y) => Math.max(BAR_MARGIN, Math.min(y, maxTop));
    const ball = ballBounds();

    const corners = [
      { left: maxLeft, top: maxTop },
      { left: maxLeft, top: BAR_MARGIN },
      { left: BAR_MARGIN, top: maxTop },
      { left: BAR_MARGIN, top: BAR_MARGIN }
    ];
    let spot = corners[0];
    if (ball) {
      const centerX = clampX((ball.left + ball.right - width) / 2);
      const centerY = clampY((ball.top + ball.bottom - height) / 2);
      const candidates = [
        { left: centerX, top: ball.bottom + BAR_GAP },
        { left: centerX, top: ball.top - BAR_GAP - height },
        { left: ball.left - BAR_GAP - width, top: centerY },
        { left: ball.right + BAR_GAP, top: centerY },
        ...corners
      ];
      const fits = (c) => c.left >= BAR_MARGIN && c.left <= maxLeft
        && c.top >= BAR_MARGIN && c.top <= maxTop
        && (c.left + width <= ball.left || c.left >= ball.right
          || c.top + height <= ball.top || c.top >= ball.bottom);
      // 视口小到哪儿都放不下：夹在视口里，碰到球也比伸出屏幕强。
      spot = candidates.find(fits) || { left: clampX(centerX), top: clampY(ball.bottom + BAR_GAP) };
    }
    progressEl.style.left = `${spot.left}px`;
    progressEl.style.top = `${spot.top}px`;
  }

  function forceHideProgressBar() {
    const progressEl = document.getElementById('ai-translator-progress');
    if (progressEl) {
      progressEl.classList.add('ai-translator-progress-done');
      setTimeout(() => progressEl.remove(), 300);
    }
    // 注意：不重置 state.isTranslatingPage，翻译任务可能还在后台运行
    // state.isTranslatingPage 只在翻译真正完成时才重置（在 finally 块中）
  }

  // 条子上的一条提示。原来只用来说“页面已翻译”，现在还要说“正文翻不了”，
  // 所以文案由调用方给，函数名也不再替它下结论。
  function showPageNotice(message) {
    const progressEl = ensureBar();
    renderInfo(progressEl, message);
    closeBarAfter(progressEl, 3000);
  }

  function renderInfo(progressEl, message) {
    renderBar(progressEl, 'info', `
        <div class="ai-translator-progress-content ai-translator-progress-info">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/>
            <path d="M12 16v-4M12 8h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          </svg>
          <span>${escapeHtml(message)}</span>
        </div>`, t('close'));
  }

  /**
   * 报错条。`action` 是 Blab 账户错误带来的入口（'subscribe' |
   * 'signin'，background/api-errors.js），画成文字下面的一颗按钮
   * （ctx.accountActionButton）；带入口的不自动收起 —— 人还没来得及点它，条子
   * 就没了。登录成功收起这条：错误已经不成立了，再点一次翻译就行。
   */
  function showTranslationError(errorMessage, action = null) {
    const progressEl = ensureBar();
    const entry = ctx.accountActionButton(action, {
      className: 'ai-translator-progress-action',
      onSignedIn: forceHideProgressBar
    });
    renderBar(progressEl, 'error', `
        <div class="ai-translator-progress-content ai-translator-progress-error">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/>
            <path d="M12 8v5M12 16h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          </svg>
          <div class="ai-translator-progress-error-body">
            <div class="ai-translator-progress-error-text">${escapeHtml(errorMessage)}</div>
          </div>
        </div>`, t('close'), (bar) => {
      if (entry) bar.querySelector('.ai-translator-progress-error-body').appendChild(entry);
    });
    if (!entry) closeBarAfter(progressEl, 8000);
  }

  // 语言包首次下载是几十 MB 级别的，期间一条译文都出不来，环停在 arming 上转。
  // 只转不说的话看起来像卡死了，所以下载的百分比用一条提示条说出来；这条不自动
  // 收，下载这一程结束时（onBuiltinDownloadEnded）收。用户关掉了它，这一轮就不再
  // 建；台上是别的条子（子框架报来的错误条之类），也不拿下载的百分比盖掉它。
  ctx.onBuiltinDownloadProgress = function(loaded) {
    if (!state.isTranslatingPage || downloadBarDismissed) return;
    const pct = Math.max(0, Math.min(100, Math.round((loaded || 0) * 100)));
    if (pct >= 100) {
      ctx.onBuiltinDownloadEnded();
      return;
    }
    const text = `${t('builtinDownloading')} ${pct}%`;
    const existing = document.getElementById('ai-translator-progress');
    if (existing && existing.dataset.kind === 'download') {
      existing.querySelector('.ai-translator-progress-info span').textContent = text;
      return;
    }
    if (existing && !existing.classList.contains('ai-translator-progress-done')) return;
    const progressEl = ensureBar();
    renderInfo(progressEl, text);
    progressEl.dataset.kind = 'download';
  };

  // 下载这一程结束了——下完了、失败了、或者卡住被放弃了。三种情况后面都轮到翻译
  // 继续走（内置或回落到 AI），所以那条下载提示必须收掉，否则它会停在“正在下载
  // 语言包 45%”上，而页面其实早就在用另一条路翻译了。别的条子（报错）不动。
  ctx.onBuiltinDownloadEnded = function() {
    const progressEl = document.getElementById('ai-translator-progress');
    if (progressEl && progressEl.dataset.kind === 'download') closeBar(progressEl);
  };

  /** 这一轮翻完了：一条成功条，5 s 后收。 */
  function showTranslationComplete() {
    const progressEl = ensureBar();
    renderBar(progressEl, 'success', `
        <div class="ai-translator-progress-content ai-translator-progress-success">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
            <path d="M7.5 12.5L10.5 15.5L16.5 9.5" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
            <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/>
          </svg>
          <span>${t('translationComplete')}</span>
        </div>`, t('close'));
    closeBarAfter(progressEl, 5000);
  }

  /**
   * 新的一轮开始：上一轮留下的条子（成功条、提示条、挂着「订阅」入口的错误条）
   * 立刻收掉。它们说的是上一轮的事，这一轮的进度在环上。
   */
  function closePageBar() {
    const progressEl = document.getElementById('ai-translator-progress');
    if (progressEl) closeBar(progressEl);
  }

  // ------------------------------------------------------------------ 进度环
  //
  // 环只读 ctx.progressFeed（content/page/progress-feed.js）：phase 落成 svg 上的
  // data-phase，比例落成弧的 stroke-dashoffset。颜色、旋转、脉冲、淡出全在
  // float-ball.css 里按 data-phase 画；这里只决定「此刻是哪一态、弧多长、什么时候
  // 露面、什么时候退场」。环不收事件（pointer-events:none），点击和拖动照旧落在球上。
  // 弧的 circle 带 pathLength="1"：周长记作 1，offset 就是 1 − 比例。

  // 环此刻在干什么（mode），只有这一处说了算：
  //   idle     不在屏幕上
  //   gating   不在屏幕上，自动轮在门里等：到点还在跑才露面（gateTimer 在走）
  //   live     露着一态：arming、running，或过了门的自动轮
  //   playing  在放完成 / 预算序列（sequence 是哪一段）；carriedOver 说这段序列
  //            是上一代留下的，只对 playing 有意义
  //   held     停着一个常驻态：partial、paused、error，直到翻篇或下一轮真露了面
  // 门的计时器和 mode 互不相干：常驻态底下也可以有一轮自动在门里等。
  // view 是画在环上的样子，snap 是悬停那句「已翻 n/m」说的那份账（随 view 一起
  // 定格，序列放到一半进度源再变也不改口）。ledger 是最近一份有数的账（known > 0），
  // 每次画都记、门开没开都记：暂停那一下进度源上只剩空账，环拿它定格。armedFrom 是
  // 手动整页点下那一刻进度源上的快照，routeLeft 是换路由那一刻的快照。
  const ring = {
    mode: 'idle',
    carriedOver: false,
    sequence: null,
    gateTimer: null,
    view: { phase: 'idle', fade: false, offset: 1, snap: null },
    ledger: null,
    session: null,
    timers: [],
    budgetKey: '',
    armedFrom: null,
    routeLeft: null
  };
  const RING_ARMING_FRACTION = 0.25; // arming：一段 90° 的弧在转，还不代表进度
  // 自动的增量轮常常只有几块、几百毫秒：600 ms 内收场的那一轮整个不露面，只有
  // 状态点在呼吸。CSS 的 animation-delay 做不了「到点还没完才显示」，只能用计时器。
  const RING_GATE_MS = 600;
  // 手动整页刚点下、进度源上还没有这一轮：悬停只说「正在翻译」，不报上一轮或自动的数。
  const RING_BLANK_MANUAL = Object.freeze({
    source: 'manual', phase: 'arming', known: 0, settled: 0, failed: 0, pending: 0, inflight: 0
  });
  // 常驻的三态：放完就停在环上，直到翻篇或下一轮真露了面。
  const RING_HELD_PHASES = Object.freeze(['partial', 'paused', 'error']);
  // 两段定时退场：[距开始的毫秒, 视觉态]。'fade' 是在当前态上淡出 300 ms。
  // 完成：先在天蓝上补满（240 ms），再转薄荷（160 ms），停 900 ms，淡出 300 ms。
  // reduced-motion 省掉补满与变色，只留停留与淡出。
  const RING_SEQUENCES = Object.freeze({
    done: [[0, 'running'], [240, 'done'], [1300, 'fade'], [1600, 'idle']],
    doneReduced: [[0, 'done'], [900, 'fade'], [1200, 'idle']],
    budget: [[0, 'budget'], [4000, 'fade'], [4300, 'idle']]
  });

  function prefersReducedMotion() {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  /** 这一态的弧该空出多少（stroke-dashoffset，周长为 1）。比例只问进度源的 fraction。 */
  function ringOffset(snap, phase) {
    let fraction;
    switch (phase) {
      case 'idle': fraction = 0; break;
      case 'arming': fraction = RING_ARMING_FRACTION; break;
      // 暂停定格在喊停前那份账上，弧长和在跑时画的一样（还有块没回来就不画满）。
      case 'running':
      case 'paused': fraction = ctx.progressFeed.fraction(snap); break;
      // 缺口画的是放弃的那几块：琥珀色说「有没翻成的」，缺口说「是多少」。
      case 'partial': fraction = snap.known ? (snap.settled - snap.failed) / snap.known : 0; break;
      case 'budget': fraction = snap.known ? snap.settled / snap.known : 0; break;
      default: fraction = 1; // done、error：满圈
    }
    return 1 - fraction;
  }

  /** 此刻环在屏幕上，而且说的是这一代的事（上一代留下、还没放完的序列不算）。 */
  function ringShown() {
    return ring.mode === 'live' || (ring.mode === 'playing' && !ring.carriedOver);
  }

  /** 环上停着的东西不让给同一页上的翻代次：常驻态，或上一代没放完的序列。 */
  function ringStale() {
    return ring.mode === 'held' || (ring.mode === 'playing' && ring.carriedOver);
  }

  function clearRingTimers() {
    for (const timer of ring.timers) clearTimeout(timer);
    ring.timers = [];
    ring.sequence = null;
    ring.carriedOver = false;
  }

  function clearRingGate() {
    clearTimeout(ring.gateTimer);
    ring.gateTimer = null;
    if (ring.mode === 'gating') ring.mode = 'idle';
  }

  function setRingView(phase, offset, snap) {
    ring.view = { phase, fade: false, offset, snap };
  }

  /** 常驻地显示一态：arming、running 是 live，partial、paused、error 是 held。 */
  function showRing(phase, offset, snap) {
    clearRingTimers();
    clearRingGate();
    ring.mode = RING_HELD_PHASES.includes(phase) ? 'held' : 'live';
    setRingView(phase, offset, snap);
  }

  function hideRing(offset, snap) {
    clearRingTimers();
    clearRingGate();
    ring.mode = 'idle';
    setRingView('idle', offset, snap);
  }

  /** 自动轮进门：看不见，到点还在跑就露面。常驻态底下的门不改 mode。 */
  function startRingGate() {
    if (ring.mode === 'idle') ring.mode = 'gating';
    if (ring.gateTimer) return;
    ring.gateTimer = setTimeout(() => {
      ring.gateTimer = null;
      // 计时器可能赶在把收场那一笔画上去的那一帧之前：到点时真的还在跑才算门开了。
      const phase = ctx.progressFeed.state().phase;
      if (phase === 'arming' || phase === 'running') ring.mode = 'live';
      paintProgressRing();
    }, RING_GATE_MS);
  }

  function runRingSequence(name, offset, snap) {
    clearRingTimers();
    clearRingGate();
    ring.mode = 'playing';
    ring.sequence = name;
    for (const [at, step] of RING_SEQUENCES[name]) {
      const apply = () => {
        if (step === 'fade') {
          ring.view = { ...ring.view, fade: true };
        } else {
          setRingView(step, offset, snap);
          if (step === 'idle') {
            // 放的时候底下若有一轮自动进了门，退场后接着在门里等。
            ring.mode = ring.gateTimer ? 'gating' : 'idle';
            ring.sequence = null;
            ring.carriedOver = false;
          }
        }
        applyRing();
      };
      if (at === 0) apply();
      else ring.timers.push(setTimeout(apply, at));
    }
  }

  /**
   * 把进度源此刻的快照画到环上。订阅回调、门到点、看门狗重建球、手动整页收尾
   * 都走这里；同一份快照画几遍都一样（序列和门不会因为重画而重启）。
   */
  function paintProgressRing() {
    const snap = ctx.progressFeed.state();
    // 暂停那一下调度层先翻代次再报暂停，同一帧画：先记下翻代次之前环在不在屏幕上。
    let wasOnScreen = ring.mode === 'live' || ring.mode === 'playing' || ring.mode === 'held';
    if (ring.session !== snap.session) startRingSession(snap.session);
    if (snap !== ring.routeLeft) ring.routeLeft = null;

    let phase = snap.phase;
    let shot = snap;
    if (state.isTranslatingPage && (snap.source !== 'manual' || snap === ring.armedFrom)) {
      // 手动整页已经点下，块还在收（规则要先到、要过滤）：进度源上还没有这一轮，
      // 台上的是自动的数或上一轮手动的终态。环先转起来，用户点了要立刻有回应。
      phase = 'arming';
      shot = RING_BLANK_MANUAL;
    } else {
      if (ring.armedFrom) {
        // 那一轮没走到 manual.begin 就收场了（只有 iframe、一块也没有、begin 之前就
        // 抛了）：台上是点下之前那份快照，或者其间自动报来的一份。环上转着的 arming
        // 是那一下点击的，不是这份快照的 —— 先收起，这份快照按自己的规矩来（自动的
        // 照样过门，没露过面的完成不放序列）。点下之前那份的完成 / 预算序列早已放完。
        if (snap.source !== 'manual' || snap === ring.armedFrom) {
          hideRing(ring.view.offset, ring.view.snap);
          wasOnScreen = false;
        }
        if (snap === ring.armedFrom && (phase === 'done' || phase === 'budget')) phase = 'idle';
        ring.armedFrom = null;
      }
      // 换路由时台上那份快照说的是已经离开的那一页：重画多少遍也不再露面。
      if (snap === ring.routeLeft) phase = 'idle';
    }
    if (phase !== 'budget') ring.budgetKey = '';
    if (phase !== 'idle' && shot.known > 0) ring.ledger = shot;
    if (phase === 'paused' && snap.known === 0) {
      // 暂停那一下调度层先翻了代次，台上只剩一份空账。环在屏幕上的话停在喊停那
      // 一刻：弧长和「已翻 n/m」都取最近那份账，只是变灰。环本来就不在屏幕上（已经
      // 放完退场、或者还在门里），暂停什么也不画。
      if (wasOnScreen && ring.ledger) shot = { ...ring.ledger, source: snap.source, phase: 'paused' };
      else phase = 'idle';
    }

    const offset = ringOffset(shot, phase);
    // 环上停着一个常驻态（手动那一轮的 partial / error），或者上一代没放完的完成
    // 序列（carriedOver）。自动开着的页面上，手动一收尾调度层就会再报数：把放弃的块
    // 重新排队、报一个 idle，或者门内就收场的一小轮；语言包装好、暂停也会翻代次。
    // 那都不是「下一轮」—— 它们只让给换路由、手动的新一轮、和过了门真露面的
    // 自动轮，否则那圈珊瑚闪一帧就没了，完成序列也放不完。
    const stale = ringStale();
    const shown = ringShown();
    switch (phase) {
      case 'idle':
        if (stale) clearRingGate();
        else if (ring.mode !== 'playing') hideRing(offset, shot);
        break;
      case 'arming':
      case 'running':
        if (snap.source === 'manual' || state.isTranslatingPage || shown) {
          showRing(phase, offset, shot);
        } else {
          // 门还没开：弧长和账照写（看不见），到点还在跑就露面。看得见的不动它。
          if (!stale) ring.view = { ...ring.view, offset, snap: shot };
          startRingGate();
        }
        break;
      case 'done':
        if (ring.sequence === 'done' || ring.sequence === 'doneReduced') break;
        // 没露过面的一轮（门内收场，或序列已经放完）就不露面；常驻态留着。
        if (stale) clearRingGate();
        else if (!shown) hideRing(offset, shot);
        else runRingSequence(prefersReducedMotion() ? 'doneReduced' : 'done', offset, shot);
        break;
      case 'budget': {
        // 同一份预算账只放一次「停 4 s 再淡出」，之后的重画不再把它叫回来。上一代
        // 留下的序列也放完再说：翻代次后的空账不该把它截成一圈空弧。
        const key = `${snap.session}:${snap.known}:${snap.settled}`;
        if (ring.budgetKey === key || (ring.mode === 'playing' && ring.carriedOver)) break;
        ring.budgetKey = key;
        runRingSequence('budget', offset, shot);
        break;
      }
      default: // partial、paused、error：常驻，直到换路由或下一轮
        showRing(phase, offset, shot);
    }
    applyRing();
  }

  /**
   * 进度源在同一路由上翻了代次（换路由由下面的 onRouteChange 直接收）：语言包装好
   * 重判、暂停、继续、整轮失败。正在放的完成 / 预算序列放完，手动那一轮停下的
   * partial / error 留着。自动自己的态（在转的弧、自动的 partial / paused / error）
   * 说的是上一代调度层的状态，新一代会自己报，收掉 —— 账留着。
   */
  function startRingSession(session) {
    ring.session = session;
    ring.budgetKey = '';
    if (ring.mode === 'playing') ring.carriedOver = true;
    else if (!(ring.mode === 'held' && ring.view.snap && ring.view.snap.source === 'manual')) {
      hideRing(1, ring.view.snap);
    }
  }

  // 换了路由就是翻篇：环立刻回 idle，账一并清掉，新一页的轮次按门的规则重新出现。
  // 不等进度源翻代次 —— 自动翻译关着的页面上，手动留下的环换页后进度源一动不动。
  if (globalThis.SpaNavigation) {
    globalThis.SpaNavigation.onRouteChange(() => {
      ring.routeLeft = ctx.progressFeed.state();
      ring.ledger = null;
      ring.budgetKey = '';
      hideRing(1, null);
      applyRing();
    });
  }

  function applyRing() {
    const ball = state.floatBall;
    const svg = ball && ball.querySelector('svg.ai-translator-ring');
    if (!svg) return;
    const { phase, fade, offset, snap } = ring.view;
    svg.dataset.phase = phase;
    svg.classList.toggle('ai-translator-ring-fade', fade);
    svg.querySelector('.ai-translator-ring-arc').style.strokeDashoffset = offset.toFixed(4);
    // 数字不画在球上：悬停看球的 title，读屏读环的 aria-label，说的是同一句。
    if (phase === 'idle') {
      ball.removeAttribute('title');
      svg.removeAttribute('role');
      svg.removeAttribute('aria-label');
      svg.setAttribute('aria-hidden', 'true');
      return;
    }
    const line = ctx.describeProgress(snap);
    ball.title = line;
    svg.removeAttribute('aria-hidden');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', line);
  }

  /** 手动整页刚点下：环立刻进 arming，不等块收齐。 */
  function armProgressRing() {
    downloadBarDismissed = false;
    ring.armedFrom = ctx.progressFeed.state();
    paintProgressRing();
  }

  // 环画在球上，球归 content-float-ball.js：它重建球之后回头调 paintProgressRing。
  // 订阅挂在这里一次，每次画都重新找 state.floatBall，被删掉的旧球没人再惦记。
  ctx.progressFeed.subscribe(paintProgressRing);

  ctx.armProgressRing = armProgressRing;
  ctx.paintProgressRing = paintProgressRing;
  ctx.showTranslationComplete = showTranslationComplete;
  ctx.closePageBar = closePageBar;
  ctx.showPageNotice = showPageNotice;
  ctx.showTranslationError = showTranslationError;
})();
