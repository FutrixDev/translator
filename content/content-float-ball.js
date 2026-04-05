// AI Translator Content Script Float Ball
(function() {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT;
  if (!ctx) return;

  const { constants, settings, state } = ctx;
  const {
    FLOAT_BALL_SIZE,
    EDGE_SNAP_THRESHOLD,
    DOCK_PADDING_FRONT,
    DOCK_PADDING_BACK,
    DOCK_PADDING_VERTICAL
  } = constants;

  const t = ctx.t;
  const applyTheme = ctx.applyTheme;
  let floatBallWatchdog = null;
  let isFullscreenActive = false;
  let fullscreenListenerAttached = false;

  function handleFullscreenChange() {
    isFullscreenActive = !!document.fullscreenElement;
    updateFloatBallVisibility();
  }

  function ensureFullscreenListener() {
    if (fullscreenListenerAttached) return;
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    fullscreenListenerAttached = true;
    handleFullscreenChange();
  }

  // Ensure float ball exists in DOM (recreate if removed by page's JS)
  function ensureFloatBallExists() {
    // Check if float ball was removed from DOM
    if (state.floatBall && !document.body.contains(state.floatBall)) {
      console.log('AI Translator: Float ball was removed from DOM, recreating...');
      state.floatBall = null;
      state.floatBallContainer = null;
    }

    // Create if doesn't exist
    if (!state.floatBall) {
      createFloatBall();
      // Reapply theme after recreation (React hydration may have removed attributes)
      applyTheme(settings.theme);
      return true; // Was recreated
    }
    return false; // Already existed
  }

  function startFloatBallWatchdog() {
    if (floatBallWatchdog) return;
    floatBallWatchdog = setInterval(() => {
      if (settings.showFloatBall === false) return;
      if (!document.body) return;

      if (!state.floatBall || !document.body.contains(state.floatBall)) {
        ensureFloatBallExists();
      }

      if (document.documentElement.getAttribute('data-ai-translator-theme') !== settings.theme) {
        applyTheme(settings.theme);
      }
    }, 1000);
  }

  function createFloatBall() {
    // Remove existing references if elements don't exist in DOM
    if (state.floatBall && !document.body.contains(state.floatBall)) {
      state.floatBall = null;
    }
    if (state.floatBallContainer && !document.body.contains(state.floatBallContainer)) {
      state.floatBallContainer = null;
    }

    if (state.floatBall) return;

    // Ensure document.body exists
    if (!document.body) {
      console.error('AI Translator: document.body not available');
      return;
    }

    // Create container for docked state background
    state.floatBallContainer = document.createElement('div');
    state.floatBallContainer.id = 'ai-translator-float-ball-container';
    document.body.appendChild(state.floatBallContainer);

    // Create float ball
    state.floatBall = document.createElement('div');
    state.floatBall.id = 'ai-translator-float-ball';
    state.floatBall.innerHTML = `
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M12.87 15.07l-2.54-2.51.03-.03A17.52 17.52 0 0014.07 6H17V4h-7V2H8v2H1v2h11.17C11.5 7.92 10.44 9.75 9 11.35 8.07 10.32 7.3 9.19 6.69 8h-2c.73 1.63 1.73 3.17 2.98 4.56l-5.09 5.02L4 19l5-5 3.11 3.11.76-2.04z" fill="url(#iconGradient)"/>
        <path d="M18.5 10l-4.5 12h2l1.12-3h4.75L23 22h2l-4.5-12h-2zm-2.62 7l1.62-4.33L19.12 17h-3.24z" fill="url(#iconGradient)"/>
        <defs>
          <linearGradient id="iconGradient" x1="0" y1="0" x2="24" y2="24">
            <stop offset="0%" stop-color="#a78bfa"/>
            <stop offset="100%" stop-color="#818cf8"/>
          </linearGradient>
        </defs>
      </svg>
    `;

    // Load saved position or use default
    try {
      const savedPosition = localStorage.getItem('ai-translator-float-position');
      if (savedPosition) {
        const { x, y, docked } = JSON.parse(savedPosition);
        if (typeof x === 'number' && typeof y === 'number') {
          const viewportWidth = window.innerWidth;
          const viewportHeight = window.innerHeight;

          let validX = x;
          let validY = y;
          let validDocked = docked;

          // Recalculate docked position for current viewport
          if (docked === 'right') {
            validX = viewportWidth - FLOAT_BALL_SIZE - DOCK_PADDING_BACK;
          } else if (docked === 'left') {
            validX = DOCK_PADDING_FRONT;
          } else {
            validX = Math.max(8, Math.min(x, viewportWidth - FLOAT_BALL_SIZE - 8));
            validDocked = null;
          }

          validY = Math.max(8, Math.min(y, viewportHeight - FLOAT_BALL_SIZE - 8));

          state.floatBall.style.right = 'auto';
          state.floatBall.style.bottom = 'auto';
          state.floatBall.style.left = `${validX}px`;
          state.floatBall.style.top = `${validY}px`;

          // Apply docked state
          if (validDocked) {
            setDockedState(validDocked, validX, validY);
          }

          // Update saved position if adjusted
          if (x !== validX || y !== validY || docked !== validDocked) {
            localStorage.setItem('ai-translator-float-position', JSON.stringify({
              x: validX,
              y: validY,
              docked: validDocked
            }));
          }
        }
      }
    } catch (error) {
      console.warn('AI Translator: Failed to load saved position, using default', error);
      localStorage.removeItem('ai-translator-float-position');
    }

    document.body.appendChild(state.floatBall);
    console.log('AI Translator: Float ball created');

    // Setup drag and click handling
    setupFloatBallInteraction();
    startFloatBallWatchdog();
    ensureFullscreenListener();

    // Update visibility based on settings
    // Re-read from storage to ensure we have the latest value
    chrome.storage.sync.get({ showFloatBall: true }).then(result => {
      settings.showFloatBall = result.showFloatBall;
      updateFloatBallVisibility();
    }).catch(() => {
      // On error, use current settings value
      updateFloatBallVisibility();
    });
  }

  // Set docked state with container background
  function setDockedState(side, ballX, ballY) {
    state.floatBall.classList.add('docked');
    state.floatBallContainer.classList.remove('docked-left', 'docked-right');
    state.floatBallContainer.classList.add('docked-' + side);

    // Container dimensions - minimal capsule wrapping the ball
    const containerWidth = FLOAT_BALL_SIZE + DOCK_PADDING_FRONT + DOCK_PADDING_BACK;
    const containerHeight = FLOAT_BALL_SIZE + DOCK_PADDING_VERTICAL * 2;

    if (side === 'right') {
      state.floatBallContainer.style.right = '0';
      state.floatBallContainer.style.left = 'auto';
    } else {
      state.floatBallContainer.style.left = '0';
      state.floatBallContainer.style.right = 'auto';
    }
    state.floatBallContainer.style.top = (ballY - DOCK_PADDING_VERTICAL) + 'px';
    state.floatBallContainer.style.width = containerWidth + 'px';
    state.floatBallContainer.style.height = containerHeight + 'px';
  }

  // Clear docked state
  function clearDockedState() {
    state.floatBall.classList.remove('docked');
    state.floatBallContainer.classList.remove('docked-left', 'docked-right');
  }

  function setupFloatBallInteraction() {
    let isDragging = false;
    let dragStartX, dragStartY;
    let ballStartX, ballStartY;
    let dragDistance = 0;

    // Mouse down - start drag
    state.floatBall.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return; // Only left click

      isDragging = true;
      dragDistance = 0;
      state.floatBallDragged = false;

      dragStartX = e.clientX;
      dragStartY = e.clientY;

      const rect = state.floatBall.getBoundingClientRect();
      ballStartX = rect.left;
      ballStartY = rect.top;

      // Remove any transition during drag
      state.floatBall.style.transition = 'none';
      state.floatBall.classList.add('dragging');

      e.preventDefault();
    });

    // Mouse move - update position
    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;

      const deltaX = e.clientX - dragStartX;
      const deltaY = e.clientY - dragStartY;
      dragDistance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);

      // Mark as dragged if moved more than 3 pixels
      if (dragDistance > 3) {
        state.floatBallDragged = true;
        // Remove docked state while dragging
        clearDockedState();
      }

      // Calculate new position
      let newX = ballStartX + deltaX;
      let newY = ballStartY + deltaY;

      // Clamp to viewport
      const maxX = window.innerWidth - FLOAT_BALL_SIZE;
      const maxY = window.innerHeight - FLOAT_BALL_SIZE;
      newX = Math.max(0, Math.min(newX, maxX));
      newY = Math.max(0, Math.min(newY, maxY));

      // Apply position immediately (no transition)
      state.floatBall.style.right = 'auto';
      state.floatBall.style.bottom = 'auto';
      state.floatBall.style.left = newX + 'px';
      state.floatBall.style.top = newY + 'px';
    });

    // Mouse up - end drag, apply snap
    document.addEventListener('mouseup', (e) => {
      if (!isDragging) return;
      isDragging = false;
      state.floatBall.classList.remove('dragging');

      if (state.floatBallDragged) {
        // Get current position
        const rect = state.floatBall.getBoundingClientRect();
        let finalX = rect.left;
        let finalY = rect.top;

        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;

        // Check distance to edges
        const distLeft = finalX;
        const distRight = viewportWidth - finalX - FLOAT_BALL_SIZE;

        let dockedSide = null;

        // Snap to left or right edge (dock to edge)
        // Ball nearly flush with container front edge
        if (distLeft <= EDGE_SNAP_THRESHOLD && distLeft < distRight) {
          finalX = DOCK_PADDING_FRONT;
          dockedSide = 'left';
        } else if (distRight <= EDGE_SNAP_THRESHOLD) {
          finalX = viewportWidth - FLOAT_BALL_SIZE - DOCK_PADDING_BACK;
          dockedSide = 'right';
        }

        // Clamp vertical position
        const maxY = viewportHeight - FLOAT_BALL_SIZE - 8;
        finalY = Math.max(8, Math.min(finalY, maxY));

        // Apply animation
        state.floatBall.style.transition = 'left 0.2s ease-out, top 0.2s ease-out';
        state.floatBall.style.left = finalX + 'px';
        state.floatBall.style.top = finalY + 'px';

        // Apply docked state with container
        if (dockedSide) {
          setTimeout(() => {
            setDockedState(dockedSide, finalX, finalY);
          }, 50);
        }

        setTimeout(() => {
          if (state.floatBall) state.floatBall.style.transition = 'none';
        }, 200);

        // Save position and docked state
        localStorage.setItem('ai-translator-float-position', JSON.stringify({
          x: finalX,
          y: finalY,
          docked: dockedSide
        }));
      } else {
        // It was a click, not a drag
        toggleFloatMenu();
      }
    });

    // Handle window resize
    window.addEventListener('resize', () => {
      if (!state.floatBall || isDragging) return;

      const rect = state.floatBall.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;

      // Recalculate position for docked state
      const isDockedRight = state.floatBallContainer.classList.contains('docked-right');
      const isDockedLeft = state.floatBallContainer.classList.contains('docked-left');

      let newX = rect.left;
      if (isDockedRight) {
        newX = viewportWidth - FLOAT_BALL_SIZE - DOCK_PADDING_BACK;
        state.floatBall.style.left = newX + 'px';
        state.floatBallContainer.style.right = '0';
      } else if (isDockedLeft) {
        newX = DOCK_PADDING_FRONT;
        state.floatBall.style.left = newX + 'px';
      }

      // Clamp vertical position
      const maxY = viewportHeight - FLOAT_BALL_SIZE - 8;
      const newY = Math.max(8, Math.min(rect.top, maxY));

      if (newY !== rect.top) {
        state.floatBall.style.top = newY + 'px';
      }

      // Update container position if docked
      if (isDockedRight || isDockedLeft) {
        state.floatBallContainer.style.top = (newY - DOCK_PADDING_VERTICAL) + 'px';
      }
    });
  }

  function toggleFloatMenu() {
    if (state.floatMenu) {
      hideFloatMenu();
      return;
    }

    // Check if there are translations on the page
    const hasTranslations = document.querySelectorAll('.ai-translator-inline-block').length > 0;

    state.floatMenu = document.createElement('div');
    state.floatMenu.id = 'ai-translator-float-menu';
    state.floatMenu.innerHTML = `
      <button class="ai-translator-menu-item" data-action="translate-input">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
          <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
        </svg>
        <span>${t('inputTranslate')}</span>
      </button>
      <button class="ai-translator-menu-item" data-action="translate-selection">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M12.87 15.07l-2.54-2.51.03-.03A17.52 17.52 0 0014.07 6H17V4h-7V2H8v2H1v2h11.17C11.5 7.92 10.44 9.75 9 11.35"/>
          <path d="M18.5 10l-4.5 12h2l1.12-3h4.75L23 22h2l-4.5-12h-2z"/>
        </svg>
        <span>${t('translateSelection')}</span>
      </button>
      <button class="ai-translator-menu-item" data-action="translate-page">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="3" y="3" width="18" height="18" rx="2"/>
          <path d="M3 9h18M9 21V9"/>
        </svg>
        <span>${t('translatePage')}</span>
      </button>
      ${hasTranslations ? `
      <button class="ai-translator-menu-item" data-action="toggle-translations">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          ${state.translationsVisible ?
            '<path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>' :
            '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>'
          }
        </svg>
        <span>${state.translationsVisible ? t('hideTranslations') : t('showTranslations')}</span>
      </button>
      ` : ''}
      <div class="ai-translator-menu-divider"></div>
      <button class="ai-translator-menu-item" data-action="settings">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="3"/>
          <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09"/>
        </svg>
        <span>${t('openSettings')}</span>
      </button>
    `;

    // Position menu above the ball
    const ballRect = state.floatBall.getBoundingClientRect();
    const menuWidth = 180;
    const menuHeight = hasTranslations ? 220 : 180;

    let left = ballRect.left + (ballRect.width / 2) - (menuWidth / 2);
    let top = ballRect.top - menuHeight - 10;

    // Adjust if off screen
    if (left < 10) left = 10;
    if (left + menuWidth > window.innerWidth - 10) left = window.innerWidth - menuWidth - 10;
    if (top < 10) top = ballRect.bottom + 10;

    state.floatMenu.style.left = `${left}px`;
    state.floatMenu.style.top = `${top}px`;

    document.body.appendChild(state.floatMenu);

    // Menu item click handlers
    state.floatMenu.querySelectorAll('.ai-translator-menu-item').forEach(item => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        const action = item.dataset.action;
        handleMenuAction(action);
        hideFloatMenu();
      });
    });

    // Close menu on outside click (delayed to prevent immediate close)
    setTimeout(() => {
      document.addEventListener('mousedown', handleOutsideClick);
    }, 100);
  }

  function handleOutsideClick(e) {
    if (state.floatMenu && !state.floatMenu.contains(e.target) && !state.floatBall.contains(e.target)) {
      hideFloatMenu();
    }
  }

  function hideFloatMenu() {
    if (state.floatMenu) {
      state.floatMenu.remove();
      state.floatMenu = null;
      document.removeEventListener('mousedown', handleOutsideClick);
    }
  }

  function handleMenuAction(action) {
    switch (action) {
      case 'translate-input':
        if (ctx.showInputTranslateDialog) ctx.showInputTranslateDialog();
        break;
      case 'translate-selection': {
        const selectedText = (ctx.getSelectedText ? ctx.getSelectedText() : '') || state.lastSelectedText;
        if (selectedText) {
          if (!settings.enableSelection) break;
          if (ctx.isSelectionInlineEnabled && ctx.isSelectionInlineEnabled() && ctx.translateSelectionInline) {
            ctx.translateSelectionInline(selectedText, state.lastSelectionElement, state.lastSelectionRange);
          } else {
            const pos = state.lastSelectionPos.x ? state.lastSelectionPos : { x: window.innerWidth / 2, y: window.innerHeight / 2 };
            if (ctx.showTranslationPopup) ctx.showTranslationPopup(selectedText, pos.x, pos.y);
          }
          if (ctx.hideSelectionButton) ctx.hideSelectionButton();
        }
        break;
      }
      case 'translate-page':
        if (ctx.translatePage) ctx.translatePage();
        break;
      case 'toggle-translations':
        toggleTranslationsVisibility();
        break;
      case 'settings':
        chrome.runtime.sendMessage({ type: 'OPEN_OPTIONS' });
        break;
    }
  }

  // Toggle visibility of all page translations
  function toggleTranslationsVisibility() {
    state.translationsVisible = !state.translationsVisible;

    const translations = document.querySelectorAll('.ai-translator-inline-block');
    translations.forEach(el => {
      if (state.translationsVisible) {
        el.classList.remove('ai-translator-hidden');
      } else {
        el.classList.add('ai-translator-hidden');
      }
    });
  }

  function stopFloatBallWatchdog() {
    if (floatBallWatchdog) {
      clearInterval(floatBallWatchdog);
      floatBallWatchdog = null;
    }
  }

  function updateFloatBallVisibility() {
    // Ensure showFloatBall has a valid boolean value
    const shouldShow = settings.showFloatBall !== false && !isFullscreenActive;

    // Start or stop the watchdog based on visibility
    if (shouldShow) {
      startFloatBallWatchdog();
    } else {
      stopFloatBallWatchdog();
    }

    // If should show, ensure float ball exists (recreate if removed by page)
    if (shouldShow) {
      ensureFloatBallExists();
    }

    if (state.floatBall && document.body.contains(state.floatBall)) {
      // Use setProperty with !important to override any page CSS
      state.floatBall.style.setProperty('display', shouldShow ? 'flex' : 'none', 'important');
      state.floatBall.style.setProperty('visibility', shouldShow ? 'visible' : 'hidden', 'important');
      state.floatBall.style.setProperty('opacity', shouldShow ? '1' : '0', 'important');

      // Also update container visibility
      if (state.floatBallContainer && document.body.contains(state.floatBallContainer)) {
        state.floatBallContainer.style.setProperty('display', shouldShow ? 'block' : 'none', 'important');
      }

      // Ensure float ball is in viewport when showing
      if (shouldShow) {
        ensureFloatBallInViewport();
      }

      console.log('AI Translator: Float ball visibility updated, display =', state.floatBall.style.display,
                  ', element in DOM =', document.body.contains(state.floatBall));
    } else if (shouldShow) {
      console.warn('AI Translator: Float ball not in DOM, cannot update visibility');
    }
  }

  // Ensure float ball is within the visible viewport
  function ensureFloatBallInViewport() {
    if (!state.floatBall || !document.body.contains(state.floatBall)) return;

    const rect = state.floatBall.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    // Validate viewport dimensions
    if (viewportWidth <= 0 || viewportHeight <= 0) return;

    let needsAdjustment = false;

    // Default position (bottom right corner)
    const defaultLeft = Math.max(8, viewportWidth - FLOAT_BALL_SIZE - 24);
    const defaultTop = Math.max(8, viewportHeight - FLOAT_BALL_SIZE - 80);

    let newLeft = rect.left;
    let newTop = rect.top;

    // Check if ball has invalid dimensions (not rendered yet or hidden)
    if (rect.width === 0 || rect.height === 0) {
      needsAdjustment = true;
      newLeft = defaultLeft;
      newTop = defaultTop;
    }
    // Check if ball is outside viewport
    else if (rect.left < 0 || rect.right > viewportWidth ||
             rect.top < 0 || rect.bottom > viewportHeight) {
      needsAdjustment = true;
      // Clamp to viewport
      newLeft = Math.max(8, Math.min(rect.left, viewportWidth - FLOAT_BALL_SIZE - 8));
      newTop = Math.max(8, Math.min(rect.top, viewportHeight - FLOAT_BALL_SIZE - 8));

      // If still invalid, use default
      if (newLeft < 0 || newLeft > viewportWidth - FLOAT_BALL_SIZE ||
          newTop < 0 || newTop > viewportHeight - FLOAT_BALL_SIZE) {
        newLeft = defaultLeft;
        newTop = defaultTop;
      }
    }

    if (needsAdjustment) {
      state.floatBall.style.setProperty('left', `${newLeft}px`, 'important');
      state.floatBall.style.setProperty('top', `${newTop}px`, 'important');
      state.floatBall.style.setProperty('right', 'auto', 'important');
      state.floatBall.style.setProperty('bottom', 'auto', 'important');
      console.log('AI Translator: Float ball position adjusted to', newLeft, newTop);

      // Clear any invalid saved position
      localStorage.removeItem('ai-translator-float-position');
    }
  }

  ctx.ensureFloatBallExists = ensureFloatBallExists;
  ctx.createFloatBall = createFloatBall;
  ctx.updateFloatBallVisibility = updateFloatBallVisibility;
  ctx.hideFloatMenu = hideFloatMenu;
})();
