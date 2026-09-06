// Blab Translation — the in-player caption control.
//
// One small brand button, and the menu behind it. It is the only place a
// viewer can reach subtitle translation without leaving the video: the popup
// and the options page are both a tab away, and a player is exactly where the
// decision ("翻译一下这个字幕") gets made.
//
// Two ways it mounts, and the engine picks between them from what the active
// provider offers — this file knows no site:
//
//   docked    the provider handed back a slot in the player's own control bar
//             (provider.getControlsHost() → { parent, before, menuRoot });
//             a player's own right-hand control cluster is the case that
//             exists today; the selector for it lives with its provider.
//             The player owns the button's visibility, we only own the icon.
//   floating  no slot: we pin our own box on the video's rect and put the
//             button in its bottom-right corner, showing it while the pointer
//             is over the video and fading it out 2.5s later — the same
//             rhythm a player's own control bar keeps.
//
// Everything the menu writes goes to chrome.storage.sync, which is what the
// options page and the popup write too; the engine re-reads through
// ctx.applyCaptionSettings(). There is no second source of truth here.
(function() {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT;
  if (!ctx) return;

  const BTN_ID = 'ai-translator-caption-btn';
  const MENU_ID = 'ai-translator-caption-menu';
  const ROOT_ID = 'ai-translator-caption-controls';
  const IDLE_HIDE_MS = 2500;
  const ACTIVITY_THROTTLE_MS = 100;

  // The float ball's mark, at control-bar size. A gradient is referenced by id
  // inside the document, so this one carries its own name — sharing the ball's
  // would make whichever element parsed first define the paint for both.
  const BRAND_SVG = `
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">
      <path d="M12.87 15.07l-2.54-2.51.03-.03A17.52 17.52 0 0014.07 6H17V4h-7V2H8v2H1v2h11.17C11.5 7.92 10.44 9.75 9 11.35 8.07 10.32 7.3 9.19 6.69 8h-2c.73 1.63 1.73 3.17 2.98 4.56l-5.09 5.02L4 19l5-5 3.11 3.11.76-2.04z" fill="url(#aiCaptionIconGradient)"/>
      <path d="M18.5 10l-4.5 12h2l1.12-3h4.75L23 22h2l-4.5-12h-2zm-2.62 7l1.62-4.33L19.12 17h-3.24z" fill="url(#aiCaptionIconGradient)"/>
      <defs>
        <linearGradient id="aiCaptionIconGradient" x1="0" y1="0" x2="24" y2="24">
          <stop offset="0%" stop-color="#a78bfa"/>
          <stop offset="100%" stop-color="#818cf8"/>
        </linearGradient>
      </defs>
    </svg>`;

  const ui = {
    button: null,
    menu: null,
    root: null,        // floating mode only: our own box over the video
    docked: false,
    open: false,
    video: null,
    info: null,
    hideTimer: null,
    lastActivityMs: 0,
    onDocumentPointer: null,
    onKeyDown: null,
    onActivity: null,
    onViewport: null,
    onFullscreen: null,
    parts: {},
  };

  function t(key, fallback) {
    const value = ctx.t ? ctx.t(key) : '';
    return value && value !== key ? value : fallback;
  }

  function stopEvents(el) {
    // A player treats a click on itself as play/pause and a key as a shortcut.
    // Ours are neither, and the player must never see them.
    for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click', 'dblclick', 'keydown', 'keyup']) {
      el.addEventListener(type, (e) => { e.stopPropagation(); }, false);
    }
  }

  // ----------------------------------------------------------------- writing
  /**
   * Persist one or more settings. ctx.settings is updated first so the change
   * shows on this page even before chrome.storage answers; the storage listener
   * in content-bootstrap.js applies the same values again on every other tab.
   */
  function writeSettings(patch) {
    Object.assign(ctx.settings, patch);
    if (ctx.applyCaptionSettings) ctx.applyCaptionSettings();
    try {
      chrome.storage.sync.set(patch);
    } catch (e) { /* extension context gone; the in-page value still applies */ }
  }

  // ------------------------------------------------------------------ button
  function buildButton() {
    const button = document.createElement('button');
    button.id = BTN_ID;
    button.className = 'ai-translator-caption-btn';
    button.type = 'button';
    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-expanded', 'false');
    const label = t('captionControlsLabel', 'Subtitle translation');
    button.setAttribute('aria-label', label);
    button.setAttribute('title', label);
    // Static markup of ours, no page or caption text anywhere in it.
    button.innerHTML = BRAND_SVG;
    stopEvents(button);
    button.addEventListener('click', (e) => {
      e.preventDefault();
      toggleMenu();
    });
    return button;
  }

  // -------------------------------------------------------------------- menu
  function menuItem(action, labelKey, labelFallback) {
    const item = document.createElement('div');
    item.className = 'ai-translator-caption-menu-item';
    item.setAttribute('role', 'menuitem');
    item.dataset.action = action;
    const label = document.createElement('span');
    label.className = 'ai-translator-caption-menu-label';
    label.textContent = t(labelKey, labelFallback);
    item.appendChild(label);
    return item;
  }

  function buildSelect(options) {
    const select = document.createElement('select');
    select.className = 'ai-translator-caption-select';
    for (const opt of options) {
      const option = document.createElement('option');
      option.value = opt.value;
      option.textContent = t(opt.key, opt.fallback);
      select.appendChild(option);
    }
    return select;
  }

  function buildMenu() {
    const menu = document.createElement('div');
    menu.id = MENU_ID;
    menu.className = 'ai-translator-caption-menu';
    menu.setAttribute('role', 'menu');
    menu.hidden = true;
    stopEvents(menu);

    // 1 — the feature switch itself.
    const enableItem = menuItem('enable', 'captionMenuEnable', 'Translate subtitles');
    const enableSwitch = document.createElement('span');
    enableSwitch.className = 'ai-translator-caption-switch';
    enableSwitch.setAttribute('role', 'switch');
    enableSwitch.setAttribute('aria-checked', 'false');
    const knob = document.createElement('span');
    knob.className = 'ai-translator-caption-knob';
    enableSwitch.appendChild(knob);
    enableItem.appendChild(enableSwitch);
    enableItem.addEventListener('click', () => {
      writeSettings({ enableYoutubeCaptionTranslation: !ctx.settings.enableYoutubeCaptionTranslation });
    });

    // 2 — display type.
    const modeItem = menuItem('mode', 'captionDisplayMode', 'Subtitle display');
    const modeSelect = buildSelect([
      { value: 'bilingual', key: 'captionModeBilingual', fallback: 'Bilingual' },
      { value: 'translation', key: 'captionModeTranslation', fallback: 'Translation only' },
      { value: 'original', key: 'captionModeOriginal', fallback: 'Original only' },
    ]);
    modeSelect.addEventListener('change', () => {
      writeSettings({ captionDisplayMode: modeSelect.value });
    });
    modeItem.appendChild(modeSelect);

    // 3 — where the translated line goes. Only meaningful in bilingual mode.
    const posItem = menuItem('position', 'captionTranslationPosition', 'Translation position');
    const posSelect = buildSelect([
      { value: 'below', key: 'captionPositionBelow', fallback: 'Below the original' },
      { value: 'above', key: 'captionPositionAbove', fallback: 'Above the original' },
    ]);
    posSelect.addEventListener('change', () => {
      writeSettings({ captionTranslationPosition: posSelect.value });
    });
    posItem.appendChild(posSelect);

    // 4 — colours, size and the rest live in the options page.
    const styleItem = menuItem('style', 'captionMenuStyle', 'Subtitle style');
    const chevron = document.createElement('span');
    chevron.className = 'ai-translator-caption-menu-chevron';
    chevron.textContent = '›';
    styleItem.appendChild(chevron);
    styleItem.addEventListener('click', () => {
      closeMenu();
      try {
        chrome.runtime.sendMessage({ type: 'OPEN_OPTIONS' });
      } catch (e) { /* extension context gone */ }
    });

    // 5 — put the button away. The options page brings it back.
    const hideItem = menuItem('hide', 'captionMenuHide', 'Hide this shortcut');
    hideItem.addEventListener('click', () => {
      closeMenu();
      writeSettings({ captionPlayerButton: false });
    });

    const status = document.createElement('div');
    status.className = 'ai-translator-caption-menu-status';

    menu.appendChild(enableItem);
    menu.appendChild(modeItem);
    menu.appendChild(posItem);
    menu.appendChild(styleItem);
    menu.appendChild(hideItem);
    menu.appendChild(status);

    ui.parts = { enableItem, enableSwitch, modeItem, modeSelect, posItem, posSelect, status };
    return menu;
  }

  /** Push the current settings and track state into the open (or closed) menu. */
  function refreshMenu() {
    const parts = ui.parts;
    if (!parts.enableSwitch) return;
    const settings = ctx.settings || {};
    const display = globalThis.CaptionCore
      ? globalThis.CaptionCore.resolveCaptionDisplay(settings)
      : { mode: 'bilingual' };
    const enabled = !!settings.enableYoutubeCaptionTranslation;

    parts.enableSwitch.setAttribute('aria-checked', enabled ? 'true' : 'false');
    parts.enableSwitch.classList.toggle('ai-cap-on', enabled);
    parts.modeSelect.value = display.mode;
    parts.posSelect.value = settings.captionTranslationPosition === 'above' ? 'above' : 'below';

    // Position only means something with two lines on screen.
    const positionUsable = display.mode === 'bilingual';
    parts.posSelect.disabled = !positionUsable;
    parts.posItem.classList.toggle('ai-cap-disabled', !positionUsable);
    parts.modeSelect.disabled = !enabled;
    parts.modeItem.classList.toggle('ai-cap-disabled', !enabled);

    const info = ui.info || {};
    const status = info.status || {};
    if (status.kind === 'same-language') {
      parts.status.textContent = t('captionStatusSameLang', 'Already in your language');
    } else if (status.kind === 'track') {
      parts.status.textContent = `${t('captionStatusTrack', 'Subtitle track')}: ${status.label || ''}`;
    } else {
      parts.status.textContent = t('captionStatusNoTrack', 'No subtitle track detected');
    }
  }

  // --------------------------------------------------------- open / close
  function positionMenu() {
    const menu = ui.menu;
    const button = ui.button;
    if (!menu || !button || !menu.parentElement) return;
    const anchor = menu.parentElement.getBoundingClientRect();
    const rect = button.getBoundingClientRect();
    // Anchored above the button and right-aligned with it, in the anchor's own
    // coordinates — the anchor is the player (docked) or our box (floating).
    menu.style.right = `${Math.max(4, Math.round(anchor.right - rect.right))}px`;
    menu.style.bottom = `${Math.max(4, Math.round(anchor.bottom - rect.top + 8))}px`;
  }

  function openMenu() {
    if (!ui.menu || ui.open) return;
    ui.open = true;
    ui.menu.hidden = false;
    if (ui.button) ui.button.setAttribute('aria-expanded', 'true');
    refreshMenu();
    positionMenu();
    showFloating();
    if (!ui.onDocumentPointer) {
      ui.onDocumentPointer = (e) => {
        const target = e.target;
        if (ui.menu && ui.menu.contains(target)) return;
        if (ui.button && ui.button.contains(target)) return;
        closeMenu();
      };
      document.addEventListener('pointerdown', ui.onDocumentPointer, true);
    }
    if (!ui.onKeyDown) {
      ui.onKeyDown = (e) => { if (e.key === 'Escape') closeMenu(); };
      document.addEventListener('keydown', ui.onKeyDown, true);
    }
  }

  function closeMenu() {
    if (!ui.open) return;
    ui.open = false;
    if (ui.menu) ui.menu.hidden = true;
    if (ui.button) ui.button.setAttribute('aria-expanded', 'false');
    if (ui.onDocumentPointer) {
      document.removeEventListener('pointerdown', ui.onDocumentPointer, true);
      ui.onDocumentPointer = null;
    }
    if (ui.onKeyDown) {
      document.removeEventListener('keydown', ui.onKeyDown, true);
      ui.onKeyDown = null;
    }
    scheduleHide();
  }

  function toggleMenu() {
    if (ui.open) closeMenu();
    else openMenu();
  }

  // ------------------------------------------------------- floating box
  function ensureFloatingRoot() {
    if (ui.root) return ui.root;
    const root = document.createElement('div');
    root.id = ROOT_ID;
    ui.root = root;
    if (!ui.onViewport) {
      ui.onViewport = () => syncFloatingRect();
      window.addEventListener('scroll', ui.onViewport, true);
      window.addEventListener('resize', ui.onViewport);
    }
    if (!ui.onFullscreen) {
      ui.onFullscreen = () => syncFloatingRect();
      document.addEventListener('fullscreenchange', ui.onFullscreen);
    }
    if (!ui.onActivity) {
      // The pointer being over the video is the whole show/hide rule. A
      // document-level listener is the only one that survives a player
      // rebuilding its own DOM under us; it is throttled to a tenth of a
      // second and does nothing but a rect test.
      ui.onActivity = (e) => {
        const now = Date.now();
        if (now - ui.lastActivityMs < ACTIVITY_THROTTLE_MS) return;
        ui.lastActivityMs = now;
        if (!ui.video || ui.docked) return;
        const rect = ui.video.getBoundingClientRect();
        if (e.clientX < rect.left || e.clientX > rect.right) return;
        if (e.clientY < rect.top || e.clientY > rect.bottom) return;
        showFloating();
      };
      document.addEventListener('mousemove', ui.onActivity, true);
    }
    return root;
  }

  /**
   * Nothing outside a fullscreen element is rendered, so the box has to move
   * inside it — except when the fullscreen element is the <video> itself,
   * which draws no children; the top layer is the only way over that.
   */
  function floatingParent() {
    const fullscreen = document.fullscreenElement;
    if (!fullscreen || fullscreen.tagName === 'VIDEO') return document.body;
    return fullscreen;
  }

  function setTopLayer(on) {
    const root = ui.root;
    if (!root) return;
    try {
      if (on) {
        if (!root.hasAttribute('popover')) root.setAttribute('popover', 'manual');
        if (!root.matches(':popover-open')) root.showPopover();
      } else if (root.hasAttribute('popover')) {
        if (root.matches(':popover-open')) root.hidePopover();
        root.removeAttribute('popover');
      }
    } catch (e) { /* no popover API: the button is simply not available there */ }
  }

  function syncFloatingRect() {
    const root = ui.root;
    const video = ui.video;
    if (!root || !video || ui.docked || !document.body) return;
    const parent = floatingParent();
    if (root.parentElement !== parent) parent.appendChild(root);
    setTopLayer(!!document.fullscreenElement && parent === document.body);
    const rect = video.getBoundingClientRect();
    const onScreen = rect.width > 1 && rect.height > 1
      && rect.bottom > 0 && rect.right > 0
      && rect.top < window.innerHeight && rect.left < window.innerWidth;
    root.style.display = onScreen ? 'block' : 'none';
    if (!onScreen) return;
    root.style.left = `${rect.left}px`;
    root.style.top = `${rect.top}px`;
    root.style.width = `${rect.width}px`;
    root.style.height = `${rect.height}px`;
    if (ui.open) positionMenu();
  }

  function showFloating() {
    if (ui.docked || !ui.root) return;
    ui.root.classList.add('ai-cap-visible');
    scheduleHide();
  }

  function scheduleHide() {
    if (ui.hideTimer) {
      clearTimeout(ui.hideTimer);
      ui.hideTimer = null;
    }
    if (ui.docked || !ui.root || ui.open) return;
    ui.hideTimer = setTimeout(() => {
      ui.hideTimer = null;
      if (ui.root && !ui.open) ui.root.classList.remove('ai-cap-visible');
    }, IDLE_HIDE_MS);
  }

  // ------------------------------------------------------------- mounting
  function detachButton() {
    if (ui.button && ui.button.parentElement) ui.button.remove();
    if (ui.menu && ui.menu.parentElement) ui.menu.remove();
  }

  /**
   * Wear the player's own button class while docked in its control bar, so the
   * button inherits that bar's size, spacing and hover treatment instead of
   * sitting in it at the wrong scale. Site-specific, so the class name comes
   * from the provider and never from here.
   */
  function applyHostClass(cls) {
    if (!ui.button) return;
    if (ui.hostClass && ui.hostClass !== cls) ui.button.classList.remove(ui.hostClass);
    ui.hostClass = cls || '';
    if (ui.hostClass) ui.button.classList.add(ui.hostClass);
  }

  function mountDocked(host) {
    ui.docked = true;
    applyHostClass(host.buttonClass);
    if (ui.root) {
      ui.root.remove();
      setTopLayer(false);
    }
    const parent = host.parent;
    if (ui.button.parentElement !== parent) {
      // `before` is the slot the provider asked for — the leftmost position in
      // YouTube's right-hand cluster. A player that rebuilt its control bar
      // lands here again and gets the button put back.
      const before = host.before && host.before.parentElement === parent ? host.before : null;
      parent.insertBefore(ui.button, before);
    }
    const menuRoot = host.menuRoot || parent;
    if (ui.menu.parentElement !== menuRoot) menuRoot.appendChild(ui.menu);
  }

  function mountFloating(video) {
    ui.docked = false;
    applyHostClass('');
    const root = ensureFloatingRoot();
    if (ui.button.parentElement !== root) root.appendChild(ui.button);
    if (ui.menu.parentElement !== root) root.appendChild(ui.menu);
    ui.video = video;
    syncFloatingRect();
    if (!ui.hideTimer && !ui.root.classList.contains('ai-cap-visible')) showFloating();
  }

  ctx.captionControls = {
    /**
     * Put the button where this page's provider says it goes, and refresh what
     * the menu shows. Called by the engine whenever anything it knows changes:
     * a media event, a settings change, a track arriving, the playhead moving.
     *
     * `info` is `{ host, video, status }` — `host` is the provider's docked
     * slot or null, `status` is `{ kind, label }` for the menu's status line.
     */
    sync(info) {
      ui.info = info || {};
      const host = ui.info.host;
      const video = ui.info.video || null;
      if (!host && !video) {
        this.unmount();
        return;
      }
      if (!ui.button) ui.button = buildButton();
      if (!ui.menu) ui.menu = buildMenu();
      ui.video = video;

      if (host && host.parent && host.parent.isConnected) {
        mountDocked(host);
      } else if (video) {
        mountFloating(video);
      } else {
        this.unmount();
        return;
      }

      const enabled = !!(ctx.settings || {}).enableYoutubeCaptionTranslation;
      const active = enabled && (ui.info.status || {}).kind === 'track';
      ui.button.classList.toggle('ai-cap-active', active);
      refreshMenu();
      if (ui.open) positionMenu();
      if (!ui.docked) syncFloatingRect();
    },

    /** Take the button off this page, leaving the listeners for a later mount. */
    unmount() {
      closeMenu();
      detachButton();
      if (ui.hideTimer) {
        clearTimeout(ui.hideTimer);
        ui.hideTimer = null;
      }
      if (ui.root) {
        setTopLayer(false);
        ui.root.remove();
      }
    },

    /** Everything above, plus the document-level listeners. */
    destroy() {
      this.unmount();
      if (ui.onViewport) {
        window.removeEventListener('scroll', ui.onViewport, true);
        window.removeEventListener('resize', ui.onViewport);
        ui.onViewport = null;
      }
      if (ui.onFullscreen) {
        document.removeEventListener('fullscreenchange', ui.onFullscreen);
        ui.onFullscreen = null;
      }
      if (ui.onActivity) {
        document.removeEventListener('mousemove', ui.onActivity, true);
        ui.onActivity = null;
      }
      ui.root = null;
      ui.button = null;
      ui.menu = null;
      ui.parts = {};
      ui.video = null;
      ui.info = null;
    },
  };
})();
