// Blab Translation — 整页翻译：进度条与提示
//
// 页面右下角那条进度条，连同它的拖动、提示、报错和语言包下载进度。
// 翻译流程只通过 ctx 上的这几个函数跟它说话，好让不需要露面的翻译轮次
// （自动翻译的增量轮）可以不带它跑。
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
      forceHideProgressBar();
    });
    placeBarNearBall(progressEl);
  }

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

  /**
   * 新的一轮总是新的一条。上一轮留下的错误条 / 提示条 / 成功条（可能正在淡出，
   * 也可能挂着「订阅」入口不自动收）不能接着用：进度写不进去，按钮也还是上一回的。
   * 忙分支（content-page-translation.js）只在没有条子时才进来，不会把正在跑的
   * 进度条换掉。
   */
  function showPageTranslationProgress() {
    const previous = document.getElementById('ai-translator-progress');
    if (previous) previous.remove();
    const progressEl = document.createElement('div');
    progressEl.id = 'ai-translator-progress';
    document.body.appendChild(progressEl);
    renderBar(progressEl, null, `
        <div class="ai-translator-progress-content">
          <div class="ai-translator-progress-header">
            <span class="ai-translator-progress-text">${t('translatingProgress')}</span>
            <span class="ai-translator-progress-percent">0%</span>
          </div>
          <div class="ai-translator-progress-track">
            <div class="ai-translator-progress-bar"></div>
          </div>
        </div>`, t('closeTranslation'));
    setupProgressBarDrag(progressEl);
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

  function showTranslatingHint(progressEl) {
    if (!progressEl) return;
    
    // 避免重复触发
    if (progressEl.classList.contains('ai-translator-progress-hint')) return;
    
    const textEl = progressEl.querySelector('.ai-translator-progress-text');
    if (!textEl) return;
    
    const originalText = textEl.textContent;
    
    // 添加闪烁动画类
    progressEl.classList.add('ai-translator-progress-hint');
    
    // 淡出当前文字
    textEl.classList.add('ai-translator-text-fade-out');
    
    setTimeout(() => {
      // 切换文字并淡入
      textEl.textContent = t('pleaseWait');
      textEl.classList.remove('ai-translator-text-fade-out');
      textEl.classList.add('ai-translator-text-fade-in');
      
      // 1.2秒后淡出提示文字
      setTimeout(() => {
        textEl.classList.remove('ai-translator-text-fade-in');
        textEl.classList.add('ai-translator-text-fade-out');
        
        setTimeout(() => {
          // 切换回原文字并淡入
          textEl.textContent = originalText;
          textEl.classList.remove('ai-translator-text-fade-out');
          textEl.classList.add('ai-translator-text-fade-in');
          progressEl.classList.remove('ai-translator-progress-hint');
          
          setTimeout(() => {
            textEl.classList.remove('ai-translator-text-fade-in');
          }, 200);
        }, 200);
      }, 1200);
    }, 200);
  }

  // 进度条位置上的一条提示。原来只用来说“页面已翻译”，现在还要说“正文翻不了”，
  // 所以文案由调用方给，函数名也不再替它下结论。
  function showPageNotice(message) {
    const progressEl = document.getElementById('ai-translator-progress');
    if (!progressEl) return;
    renderBar(progressEl, 'info', `
        <div class="ai-translator-progress-content ai-translator-progress-info">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/>
            <path d="M12 16v-4M12 8h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          </svg>
          <span>${escapeHtml(message)}</span>
        </div>`, t('close'));
    closeBarAfter(progressEl, 3000);
  }

  /**
   * 进度条换成错误条。`action` 是 Blab 账户错误带来的入口（'subscribe' |
   * 'signin'，background/api-errors.js），画成文字下面的一颗按钮
   * （ctx.accountActionButton）；带入口的不自动收起 —— 人还没来得及点它，条子
   * 就没了。登录成功收起这条：错误已经不成立了，再点一次翻译就行。
   */
  function showTranslationError(errorMessage, action = null) {
    const progressEl = document.getElementById('ai-translator-progress');
    if (!progressEl) return;
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

  function updatePageTranslationProgress(current, total) {
    const progressBar = document.querySelector('#ai-translator-progress .ai-translator-progress-bar');
    const progressPercent = document.querySelector('#ai-translator-progress .ai-translator-progress-percent');
    if (progressBar && progressPercent) {
      const percent = Math.round((current / total) * 100);
      progressBar.style.width = `${percent}%`;
      progressPercent.textContent = `${percent}%`;
    }
  }

  // 语言包首次下载是几十 MB 级别的，期间一条译文都出不来。不给反馈的话进度条会
  // 卡在 0% 好一阵子，看起来像卡死了，所以把下载进度借同一条进度条显示出来。
  ctx.onBuiltinDownloadProgress = function(loaded) {
    const textEl = document.querySelector('#ai-translator-progress .ai-translator-progress-text');
    const percentEl = document.querySelector('#ai-translator-progress .ai-translator-progress-percent');
    const barEl = document.querySelector('#ai-translator-progress .ai-translator-progress-bar');
    if (!textEl || !percentEl || !barEl) return;

    const pct = Math.max(0, Math.min(100, Math.round((loaded || 0) * 100)));
    if (pct >= 100) {
      ctx.onBuiltinDownloadEnded();
      return;
    }
    textEl.textContent = t('builtinDownloading');
    percentEl.textContent = `${pct}%`;
    barEl.style.width = `${pct}%`;
  };

  // 下载这一程结束了——下完了、失败了、或者卡住被放弃了。三种情况后面都轮到翻译
  // 继续走（内置或回落到 AI），所以进度条必须还回去，否则它会停在“正在下载语言包
  // 45%”上，而页面其实早就在用另一条路翻译了。
  ctx.onBuiltinDownloadEnded = function() {
    const textEl = document.querySelector('#ai-translator-progress .ai-translator-progress-text');
    if (!textEl) return;
    textEl.textContent = t('translatingProgress');
    updatePageTranslationProgress(state.translationProgress.current, state.translationProgress.total || 1);
  };

  function hidePageTranslationProgress() {
    const progressEl = document.getElementById('ai-translator-progress');
    if (!progressEl) return;
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

  ctx.showPageTranslationProgress = showPageTranslationProgress;
  ctx.updatePageTranslationProgress = updatePageTranslationProgress;
  ctx.hidePageTranslationProgress = hidePageTranslationProgress;
  ctx.showTranslatingHint = showTranslatingHint;
  ctx.showPageNotice = showPageNotice;
  ctx.showTranslationError = showTranslationError;
})();
