// Blab Translation Content Script Float Ball
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
  // Stepping aside for a video that fills the screen — standard or web
  // fullscreen — is content/content-video-stage.js's call, not ours. The stage
  // is watched only while the ball is wanted at all: switched off in settings,
  // nothing measures the page.
  const shownOverVideo = ctx.videoStage.stepAside(() => updateFloatBallVisibility());

  // Ensure float ball exists in DOM (recreate if removed by page's JS)
  function ensureFloatBallExists() {
    // Check if float ball was removed from DOM
    if (state.floatBall && !document.body.contains(state.floatBall)) {
      console.log('Blab Translation: Float ball was removed from DOM, recreating...');
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
      console.error('Blab Translation: document.body not available');
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
      <svg viewBox="0 -1 100 100" aria-hidden="true" focusable="false">
        <path class="ait-mark-coral" d="M12.66 32.46L28.92 24.73A9 9 0 0 1 40.91 28.99L53.8 56.08A9 9 0 0 1 49.54 68.07L33.28 75.81A9 9 0 0 1 21.29 71.54L8.4 44.45A9 9 0 0 1 12.66 32.46Z"/>
        <path class="ait-mark-sky" d="M71.08 24.73L87.34 32.46A9 9 0 0 1 91.6 44.45L78.71 71.54A9 9 0 0 1 66.72 75.81L50.46 68.07A9 9 0 0 1 46.2 56.08L59.09 28.99A9 9 0 0 1 71.08 24.73Z"/>
        <path class="ait-mark-amber" d="M26.25 25.65L43.81 21.69A9 9 0 0 1 54.57 28.48L61.17 57.75A9 9 0 0 1 54.38 68.51L36.82 72.47A9 9 0 0 1 26.06 65.68L19.45 36.41A9 9 0 0 1 26.25 25.65Z"/>
        <path class="ait-mark-mint" d="M56.19 21.69L73.75 25.65A9 9 0 0 1 80.55 36.41L73.94 65.68A9 9 0 0 1 63.18 72.47L45.62 68.51A9 9 0 0 1 38.83 57.75L45.43 28.48A9 9 0 0 1 56.19 21.69Z"/>
        <path class="ait-mark-bubble" d="M41 22H59A9 9 0 0 1 68 31V63C68 69 68.8 75 71.9 78.4Q72.8 79.6 71.2 79.7C66.5 79.6 62 76.8 59.7 72.4Q58.6 70 56.4 70H41A9 9 0 0 1 32 61V31A9 9 0 0 1 41 22Z"/>
        <path class="ait-mark-play" d="M48.68 37.61A3.36 3.36 0 0 0 43.6 40.5L43.6 51.5A3.36 3.36 0 0 0 48.68 54.39L57.94 48.89A3.36 3.36 0 0 0 57.94 43.11Z"/>
      </svg>
      <button type="button" class="ai-translator-status-dot" data-state="none"></button>
      <button type="button" class="ai-translator-ball-more" aria-expanded="false" title="${t('floatBallMore')}" aria-label="${t('floatBallMore')}">···</button>
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
      console.warn('Blab Translation: Failed to load saved position, using default', error);
      localStorage.removeItem('ai-translator-float-position');
    }

    document.body.appendChild(state.floatBall);
    // 看门狗随时会把球整个重建一遍，innerHTML 一换，状态点就回到了初始的空白。
    // 重建之后补一笔，否则一次页面脚本的误删会让那颗点永久消失。
    if (ctx.paintAutoStatusDot) ctx.paintAutoStatusDot();
    // 同理：··· 上的 aria-expanded 也是 innerHTML 里的初始值，重建时菜单可能正开着。
    setMoreExpanded(!!state.floatMenu);
    console.log('Blab Translation: Float ball created');

    // Setup drag and click handling
    setupFloatBallInteraction();
    startFloatBallWatchdog();

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

  // 触屏没有 hover，··· 不会出现，长按顶替它。
  const LONG_PRESS_MS = 500;

  /**
   * 单击落在球的哪一块上 —— 这一下的含义就由它决定。
   *
   * **必须在 mousedown 时判**。mouseup 的 e.target 可能已经换了元素：状态点在
   * 这一拍里刚好被隐藏，指针就落回球身上，那时候再问等于问错对象。
   */
  function pressZone(target) {
    if (!target || !target.closest) return 'ball';
    if (target.closest('.ai-translator-ball-more')) return 'menu';
    if (target.closest('.ai-translator-status-dot')) return 'status';
    return 'ball';
  }

  function setupFloatBallInteraction() {
    let isDragging = false;
    let dragStartX, dragStartY;
    let ballStartX, ballStartY;
    let dragDistance = 0;
    let zone = 'ball';
    // 这一次触摸已经被长按用掉了 —— 记的是「哪一次手势」，不是「什么时候」。
    // 计时的版本在手指按满一秒以上时会自己过期：菜单 500ms 就开出来了，手指还
    // 按着，松手时合成的那一下 click 已经出了窗口，于是它一路落到最后一档，把
    // 整页翻译也点了 —— 一次长按，开菜单外加一次花钱的整页翻译。手势的结束由
    // 那一下合成事件自己宣布，不由秒表宣布。
    let longPressFired = false;
    let longPressTimer = null;

    // Mouse down - start drag
    state.floatBall.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return; // Only left click

      isDragging = true;
      dragDistance = 0;
      state.floatBallDragged = false;
      zone = pressZone(e.target);

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

    // 键盘走的是另一条路。球上这两颗按钮的鼠标语义摊在 mousedown/mouseup 一对
    // 事件里 —— 要先分辨出这一下到底是点击还是拖拽的起手，而键盘既没有拖拽也
    // 没有 mousedown，那条路上一个字都不会执行。
    //
    // <button> 自己会在 Enter/Space 上合成一次 click；preventDefault 把那一次挡
    // 掉再自己派活，而不是反过来依赖它：合成的那一下将来要是撞上球身上新挂的
    // click，就成了一次按键点两回。
    state.floatBall.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
      const hit = pressZone(e.target);
      if (hit === 'ball') return;
      e.preventDefault();
      e.stopPropagation();
      if (hit === 'menu') toggleFloatMenu();
      else if (ctx.toggleAutoStatusExplain) ctx.toggleAutoStatusExplain();
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
      } else if (longPressFired) {
        // 长按已经把菜单开出来了，随后合成的这一下不该再做第二件事。
        longPressFired = false;
      } else if (zone === 'menu') {
        toggleFloatMenu();
      } else if (zone === 'status') {
        if (ctx.toggleAutoStatusExplain) ctx.toggleAutoStatusExplain();
      } else {
        // 单击 = 翻译 / 还原（D1）。菜单挪到了球上那个 ···（触屏长按）——
        // 最常做的那件事不该藏在一层菜单后面。
        if (ctx.togglePageTranslation) ctx.togglePageTranslation();
      }
    });

    // 触屏：长按开菜单。没有 hover 就没有 ···，这是它在触屏上唯一的入口。
    const cancelLongPress = () => {
      if (!longPressTimer) return;
      clearTimeout(longPressTimer);
      longPressTimer = null;
    };
    state.floatBall.addEventListener('touchstart', () => {
      cancelLongPress();
      // 新的一次触摸开始，上一次留下的那面旗到此为止 —— 合成事件万一没来（长按
      // 被系统手势截走），旗也烂不过这一次手势，下一次点击照常。
      longPressFired = false;
      longPressTimer = setTimeout(() => {
        longPressTimer = null;
        longPressFired = true;
        toggleFloatMenu();
      }, LONG_PRESS_MS);
    }, { passive: true });
    for (const type of ['touchmove', 'touchend', 'touchcancel']) {
      state.floatBall.addEventListener(type, cancelLongPress, { passive: true });
    }

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

    // 这一页有没有译文，问的是 content-page-translation.js 那一处 —— 它还算上
    // PDF、漫画这类不在正文 DOM 里的管控译文，自己数一遍 inline-block 会漏掉。
    const hasTranslations = ctx.hasPageTranslations();
    // The comic entry only appears where it can do something: the feature is on
    // and there is actually a page-sized image on screen to redraw.
    // Both are set up by scripts later in the manifest; a menu opens only on a
    // click, long after every content script has run.
    const showComic = ctx.comic.comicEnabled() && ctx.hasComicPageOnScreen();
    // 「不再自动翻译这个站点」。**只在这个站点此刻正自动翻的时候出现**，而且排
    // 在第一行：它是自动化里唯一高频的「后悔」操作，而在此之前撤销它的唯一办法
    // 是进设置页翻那张列表。
    //
    // 画的是 siteAuto（这个站点自己会不会翻这一页），不是状态、也不是闸门 ——
    // 和 popup 上那一行、播放器字幕菜单第一项是同一句话，理由写在
    // content-auto-translate.js 的 siteAuto() 上：拿状态画的话，用户在一个没设过
    // 规则的站点上点一次「翻译整页」，这一行就会冒出来，而他点下去写进去的是一条
    // 永久的 never。
    //
    // 写不进去就干脆不画。siteAuto 为真的站点按阶梯本来就不可能是黑名单
    // （BLOCKLIST 排在 USER_ALWAYS 前面），所以这一问平时总是真；留着它是因为一
    // 行点下去没反应、或者只剩「顺带打开总开关」那半边副作用，比少一行糟得多。
    const showStopSite = !!(ctx.autoTranslate && ctx.autoTranslate.state().siteAuto) &&
      !!(globalThis.SiteRules &&
        globalThis.SiteRules.siteRuleWritable(location.hostname, location.pathname));
    // 「翻译整个页面」在范围不是整页时都有意义：默认只翻正文，或站点规则只翻某些区域
    // （include）。每次打开都重问（content/page/scope.js）。
    const showWholePage = ctx.pageScopeMode() !== 'page';
    // 「调整本站翻译区域」：打开页内拾取器（content/picker/）。
    const showPicker = ctx.picker.canOpen();

    state.floatMenu = document.createElement('div');
    state.floatMenu.id = 'ai-translator-float-menu';
    state.floatMenu.innerHTML = `
      ${showStopSite ? `
      <button class="ai-translator-menu-item" data-action="stop-site-auto">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10"/>
          <line x1="4.9" y1="4.9" x2="19.1" y2="19.1"/>
        </svg>
        <span>${t('autoStopSite').replace('{site}', SiteRules.siteLabel(location.hostname))}</span>
      </button>
      <div class="ai-translator-menu-divider"></div>
      ` : ''}
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
      ${showWholePage ? `
      <button class="ai-translator-menu-item" data-action="translate-whole-page">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="3" y="3" width="18" height="18" rx="2"/>
          <path d="M3 9h18M3 15h18"/>
        </svg>
        <span>${t('floatMenuTranslateWholePage')}</span>
      </button>
      ` : ''}
      ${showPicker ? `
      <button class="ai-translator-menu-item" data-action="edit-site-rule">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M3 3l7 17 2.5-7.5L20 10z"/>
        </svg>
        <span>${t('pickSiteRegion')}</span>
      </button>
      ` : ''}
      ${showComic ? `
      <button class="ai-translator-menu-item" data-action="translate-comic">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="3" y="3" width="18" height="18" rx="2"/>
          <path d="M12 3v18"/>
        </svg>
        <span>${t('comicTranslateThisPage')}</span>
      </button>
      <button class="ai-translator-menu-item" data-action="colorize-comic">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M12 22a10 10 0 110-20c5.5 0 10 4 10 9a5 5 0 01-5 5h-2a2 2 0 00-1.5 3.3c.3.4.5.8.5 1.2a1.5 1.5 0 01-2 1.5z"/>
          <circle cx="7.5" cy="10.5" r="1"/>
          <circle cx="12" cy="7.5" r="1"/>
          <circle cx="16.5" cy="10.5" r="1"/>
        </svg>
        <span>${t('comicColorizeThisPage')}</span>
      </button>
      ` : ''}
      <button class="ai-translator-menu-item" data-action="toggle-translation-only">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M4 6h16M4 12h10M4 18h16"/>
        </svg>
        <span>${settings.showTranslationOnly ? t('showBilingual') : t('showTranslationOnly')}</span>
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

    // Position menu above the ball. Mounted first and measured, in the same
    // frame (no paint in between, so no flash): an estimate would restate every
    // row, and one row it forgot would put the menu over the ball.
    document.body.appendChild(state.floatMenu);
    const ballRect = state.floatBall.getBoundingClientRect();
    const menuWidth = state.floatMenu.offsetWidth;
    const menuHeight = state.floatMenu.offsetHeight;

    let left = ballRect.left + (ballRect.width / 2) - (menuWidth / 2);
    let top = ballRect.top - menuHeight - 10;

    // Adjust if off screen
    if (left < 10) left = 10;
    if (left + menuWidth > window.innerWidth - 10) left = window.innerWidth - menuWidth - 10;
    if (top < 10) top = ballRect.bottom + 10;

    state.floatMenu.style.left = `${left}px`;
    state.floatMenu.style.top = `${top}px`;
    setMoreExpanded(true);

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
      // 焦点还在菜单里的时候把菜单撤掉，焦点就掉回 <body> —— 键盘用户得从头再
      // Tab 一遍才回得到球上。所以那一种要把焦点送回 ··· 去。
      //
      // 只有那一种。鼠标点别处关的、程序自己关的，焦点本来就不在这儿，抢回来
      // 就成了打断。「Esc 关掉浮层」本身不在这一层 —— content-selection.js 那
      // 一处统管所有浮层的 Esc，这里再挂一个就是同一个问题有了两个主人。
      const returnFocus = state.floatMenu.contains(document.activeElement);
      state.floatMenu.remove();
      state.floatMenu = null;
      document.removeEventListener('mousedown', handleOutsideClick);
      if (returnFocus) {
        const more = state.floatBall && state.floatBall.querySelector('.ai-translator-ball-more');
        if (more) more.focus();
      }
    }
    setMoreExpanded(false);
  }

  /** ··· 是一颗开合菜单的按钮，读屏得知道它此刻是开是合。 */
  function setMoreExpanded(open) {
    const more = state.floatBall && state.floatBall.querySelector('.ai-translator-ball-more');
    if (more) more.setAttribute('aria-expanded', open ? 'true' : 'false');
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
          ctx.translateSelection(selectedText, { range: state.lastSelectionRange, element: state.lastSelectionElement });
        }
        break;
      }
      case 'stop-site-auto':
        stopSiteAuto();
        break;
      case 'toggle-translation-only':
        ctx.setTranslationDisplay({ showTranslationOnly: !settings.showTranslationOnly });
        break;
      case 'translate-page':
        if (ctx.translatePage) ctx.translatePage();
        break;
      case 'translate-whole-page':
        ctx.translateWholePage();
        break;
      case 'edit-site-rule':
        ctx.picker.open();
        break;
      case 'translate-comic':
        if (ctx.startComicPageTranslation) ctx.startComicPageTranslation({ pageUrl: location.href });
        break;
      case 'colorize-comic':
        if (ctx.startComicPageTranslation) ctx.startComicPageTranslation({ pageUrl: location.href, mode: 'colorize' });
        break;
      case 'toggle-translations':
        toggleTranslationsVisibility();
        break;
      case 'settings':
        chrome.runtime.sendMessage({ type: 'OPEN_OPTIONS' });
        break;
    }
  }

  /**
   * 「不再自动翻译这个站点」—— 置 never，并且立刻把这一页还原。
   *
   * 两件事的顺序不能反。先还原再写规则的话，还原已经跑完而规则还在路上，调度层
   * 此刻判的仍然是 auto —— 它会把刚还原的这一页重新翻一遍，用户看到的是自己点完
   * 之后译文又长了回来。
   *
   * 走 SiteRules.setSiteAuto 而不是 writeUserRule：这一行和 popup 那一行、字幕
   * 菜单第一项说的是同一句话，只该有一份实现（顺带它替我们挡住了存不进规则表的
   * host）。还原走 ctx.setTranslationsVisible(false)：显隐只有一个主人
   * （content/page/visibility.js），它顺手把受管容器、「仅显示译文」和调度层的
   * 暂停一起处理了 —— 自己去摘节点就是第二份实现，而且摘不干净。
   *
   * 写失败要说出来。菜单是按下去就收的，用户看到的是「关掉了」，而下一次打开这
   * 个站点照样自动翻，中间没有任何地方提起过这件事；那句话和 popup 上说的是同
   * 一句（popupSiteRuleFailed）。这一路也不还原 —— 规则没落地，还原只会被调度层
   * 立刻推翻。
   */
  async function stopSiteAuto() {
    if (!globalThis.SiteRules) return;
    try {
      await globalThis.SiteRules.setSiteAuto(location.hostname, false);
    } catch (error) {
      console.warn('Blab Translation: site rule write failed', error);
      if (ctx.showAutoStatusNotice) ctx.showAutoStatusNotice(t('popupSiteRuleFailed'));
      return;
    }
    if (ctx.setTranslationsVisible) ctx.setTranslationsVisible(false);
  }

  // 译文显隐的实现在 content/page/visibility.js —— 悬浮球、popup、Alt+A、
  // 「翻译整页」四个入口共用那一份。
  function toggleTranslationsVisibility() {
    if (ctx.setTranslationsVisible) ctx.setTranslationsVisible(state.translationsVisible === false);
  }

  function stopFloatBallWatchdog() {
    if (floatBallWatchdog) {
      clearInterval(floatBallWatchdog);
      floatBallWatchdog = null;
    }
  }

  function updateFloatBallVisibility() {
    const shouldShow = shownOverVideo(settings.showFloatBall !== false);

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

      console.log('Blab Translation: Float ball visibility updated, display =', state.floatBall.style.display,
                  ', element in DOM =', document.body.contains(state.floatBall));
    } else if (shouldShow) {
      console.warn('Blab Translation: Float ball not in DOM, cannot update visibility');
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
      console.log('Blab Translation: Float ball position adjusted to', newLeft, newTop);

      // Clear any invalid saved position
      localStorage.removeItem('ai-translator-float-position');
    }
  }

  ctx.ensureFloatBallExists = ensureFloatBallExists;
  ctx.createFloatBall = createFloatBall;
  ctx.updateFloatBallVisibility = updateFloatBallVisibility;
  ctx.hideFloatMenu = hideFloatMenu;
})();
