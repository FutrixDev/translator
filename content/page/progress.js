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
  function showPageTranslationProgress() {
    let progressEl = document.getElementById('ai-translator-progress');
    if (!progressEl) {
      progressEl = document.createElement('div');
      progressEl.id = 'ai-translator-progress';
      progressEl.innerHTML = `
        <div class="ai-translator-progress-content">
          <div class="ai-translator-progress-header">
            <span class="ai-translator-progress-text">${t('translatingProgress')}</span>
            <span class="ai-translator-progress-percent">0%</span>
          </div>
          <div class="ai-translator-progress-track">
            <div class="ai-translator-progress-bar"></div>
          </div>
        </div>
        <button class="ai-translator-progress-close" title="${t('closeTranslation')}">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round">
            <path d="M18 6L6 18M6 6l12 12"/>
          </svg>
        </button>
      `;
      document.body.appendChild(progressEl);
      
      // 定位到翻译球下方
      positionProgressBar();
      
      // 添加关闭按钮事件 - 使用 mousedown 确保在拖动逻辑之前触发
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
      
      // 添加拖动功能
      setupProgressBarDrag(progressEl);
    }
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

      // 保持在视口内
      const progressWidth = 220;
      const progressHeight = 60;
      newX = Math.max(0, Math.min(window.innerWidth - progressWidth, newX));
      newY = Math.max(0, Math.min(window.innerHeight - progressHeight, newY));

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

  function positionProgressBar() {
    const progressEl = document.getElementById('ai-translator-progress');
    if (!progressEl || !state.floatBall) return;
    
    const ballRect = state.floatBall.getBoundingClientRect();
    const progressWidth = 220;
    
    let left = ballRect.left + (ballRect.width / 2) - (progressWidth / 2);
    let top = ballRect.bottom + 12;
    
    // 确保不超出屏幕
    if (left < 10) left = 10;
    if (left + progressWidth > window.innerWidth - 10) {
      left = window.innerWidth - progressWidth - 10;
    }
    if (top + 60 > window.innerHeight) {
      top = ballRect.top - 70;
    }
    
    progressEl.style.left = `${left}px`;
    progressEl.style.top = `${top}px`;
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
    const text = escapeHtml(message);
    const progressEl = document.getElementById('ai-translator-progress');
    if (progressEl) {
      progressEl.innerHTML = `
        <div class="ai-translator-progress-content ai-translator-progress-info">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/>
            <path d="M12 16v-4M12 8h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          </svg>
          <span>${text}</span>
        </div>
        <button class="ai-translator-progress-close" title="${t('close')}">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round">
            <path d="M18 6L6 18M6 6l12 12"/>
          </svg>
        </button>
      `;
      progressEl.classList.add('ai-translator-progress-info-state');
      
      // 重新绑定关闭按钮事件
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
      
      // 3秒后自动关闭
      setTimeout(() => {
        if (progressEl.parentNode) {
          progressEl.classList.add('ai-translator-progress-done');
          setTimeout(() => {
            if (progressEl.parentNode) progressEl.remove();
          }, 300);
        }
      }, 3000);
    }
  }

  function showTranslationError(errorMessage) {
    const progressEl = document.getElementById('ai-translator-progress');
    if (progressEl) {
      // Escape HTML in error message
      const escapedMessage = escapeHtml(errorMessage);

      progressEl.innerHTML = `
        <div class="ai-translator-progress-content ai-translator-progress-error">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/>
            <path d="M12 8v5M12 16h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          </svg>
          <div class="ai-translator-progress-error-text">${escapedMessage}</div>
        </div>
        <button class="ai-translator-progress-close" title="${t('close')}">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round">
            <path d="M18 6L6 18M6 6l12 12"/>
          </svg>
        </button>
      `;
      progressEl.classList.remove('ai-translator-progress-info-state');
      progressEl.classList.add('ai-translator-progress-error-state');

      // Rebind close button event
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

      // Auto close after 8 seconds (longer for errors so user can read)
      setTimeout(() => {
        if (progressEl.parentNode) {
          progressEl.classList.add('ai-translator-progress-done');
          setTimeout(() => {
            if (progressEl.parentNode) progressEl.remove();
          }, 300);
        }
      }, 8000);
    }
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
    if (progressEl) {
      // 显示成功状态，保留关闭按钮
      progressEl.innerHTML = `
        <div class="ai-translator-progress-content ai-translator-progress-success">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
            <path d="M7.5 12.5L10.5 15.5L16.5 9.5" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
            <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/>
          </svg>
          <span>${t('translationComplete')}</span>
        </div>
        <button class="ai-translator-progress-close" title="${t('close')}">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round">
            <path d="M18 6L6 18M6 6l12 12"/>
          </svg>
        </button>
      `;
      progressEl.classList.add('ai-translator-progress-success-state');
      
      // 重新绑定关闭按钮事件
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
      
      // 5秒后自动关闭
      setTimeout(() => {
        if (progressEl.parentNode) {
          progressEl.classList.add('ai-translator-progress-done');
          setTimeout(() => {
            if (progressEl.parentNode) progressEl.remove();
          }, 300);
        }
      }, 5000);
    }
  }


  ctx.showPageTranslationProgress = showPageTranslationProgress;
  ctx.updatePageTranslationProgress = updatePageTranslationProgress;
  ctx.hidePageTranslationProgress = hidePageTranslationProgress;
  ctx.showTranslatingHint = showTranslatingHint;
  ctx.showPageNotice = showPageNotice;
  ctx.showTranslationError = showTranslationError;
})();
