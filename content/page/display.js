// Blab Translation — 整页翻译：译文的样式、双语/仅译文的应用，以及仅译文下看原文
//
// 三件事，都只动我们自己的东西，不碰译文节点的内容、不重译：
//   · 样式：<html data-ai-translator-style="…"> 一个属性，规则在
//     content/css/translation.css。集合只有一份，在 shared/translation-display.js。
//   · 双语 / 仅译文：藏不藏原文由 visibility.js 的 applyTranslationOnlyMode() 说了
//     算，这里只负责在设置变化时把它和样式一起重跑一遍。
//   · 看原文卡：一条整页译文的原文此刻藏着（仅译文，或 fit guard 因拥挤让位），
//     悬停或点按这条译文就弹一张小卡显示原文。
//
// 找译文一律走 event.composedPath() 而不是 event.target：译文将来可能在 shadow
// root 里，document 上收到的 target 会被重定向成宿主。
(function() {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT;
  if (!ctx) return;

  const Display = globalThis.TranslationDisplay;
  const REVEALED_CLASS = 'ai-translator-revealed';
  const PEEK_ID = 'ai-translator-source-peek';
  // 点在这些东西上是页面自己的操作（跳链接、按按钮、勾选框），不归我们揭开或开卡。
  const INTERACTIVE_SELECTOR = 'a[href], button, label, summary, [role="button"]';

  const PEEK_OPEN_DELAY_MS = 350;
  const PEEK_CLOSE_DELAY_MS = 200;
  const PEEK_GAP_PX = 6;
  const VIEWPORT_MARGIN_PX = 8;

  // ------------------------------------------------------------------ 样式

  function applyTranslationStyle() {
    Display.applyStyleAttribute(document, ctx.settings.translationStyle);
  }

  /**
   * 显示设置（样式、仅译文）的唯一应用点。bootstrap 的 storage 监听、ctx.init、
   * 悬浮球菜单都走这里；幂等，任何时候多跑一次都无害。
   */
  function applyTranslationDisplay() {
    applyTranslationStyle();
    if (ctx.applyTranslationOnlyMode) ctx.applyTranslationOnlyMode();
    hideSourcePeek();
  }

  /**
   * 本页立即生效，再写存储让其他标签页经 onChanged 跟上（本页也会再收到一次，
   * 幂等）。和 content-caption-controls.js 的 writeSettings 同一个写法。
   */
  function setTranslationDisplay(patch) {
    Object.assign(ctx.settings, patch);
    applyTranslationDisplay();
    const warn = (error) => console.warn('Blab Translation: display setting write failed', error);
    try {
      chrome.storage.sync.set(patch).catch(warn);
    } catch (error) {
      // 扩展上下文已失效（更新后旧页面里的脚本）。本页的值照样生效。
      warn(error);
    }
  }

  // ------------------------------------------------------------ 找译文

  function pathOf(event) {
    return typeof event.composedPath === 'function' ? event.composedPath() : [event.target];
  }

  // 事件路径上的整页译文（划词、悬停译文不算）。
  function pageTranslationIn(path) {
    const selector = ctx.PAGE_TRANSLATION_SELECTOR;
    if (!selector) return null;
    for (const node of path) {
      if (node && node.nodeType === Node.ELEMENT_NODE && node.matches(selector)) return node;
    }
    return null;
  }

  // 路径上除了译文自己之外，有没有交互元素：译文里克隆出来的链接、译文外面包着
  // 的按钮 / label。有就是页面的操作，不揭开也不开卡。
  function hasInteractiveOnPath(path, translation) {
    for (const node of path) {
      if (node === translation) continue;
      if (node && node.nodeType === Node.ELEMENT_NODE && node.matches(INTERACTIVE_SELECTOR)) return true;
    }
    return false;
  }

  function isPeekPath(path) {
    return !!peek && path.includes(peek.card);
  }

  // ------------------------------------------------------------- 看原文卡

  // 打开着的卡：{ card, translation }。关着就是 null —— 卡关掉时从 DOM 摘掉，
  // 不留一个藏着的节点在页面里（它装的是原文，留着会被当成页面内容再翻一遍）。
  let peek = null;
  let openTimer = null;
  let pendingTranslation = null;
  let closeTimer = null;
  let lastPointer = { x: 0, y: 0 };

  function sourceTextOf(translation) {
    const hidden = ctx.hiddenSourceOf ? ctx.hiddenSourceOf(translation) : null;
    if (!hidden || !ctx.readSourceText) return '';
    // readSourceText 按节点读，不看布局，所以 display:none 的原文照样读得到；它不
    // 规整空白，这里收成单个空格。
    return ctx.readSourceText(hidden).replace(/\s+/g, ' ').trim();
  }

  function cancelOpen() {
    clearTimeout(openTimer);
    openTimer = null;
    pendingTranslation = null;
  }

  function cancelClose() {
    clearTimeout(closeTimer);
    closeTimer = null;
  }

  function hideSourcePeek() {
    cancelOpen();
    cancelClose();
    if (!peek) return;
    peek.card.remove();
    peek = null;
  }

  function buildCard(text) {
    const card = document.createElement('div');
    card.id = PEEK_ID;
    card.setAttribute('role', 'tooltip');
    const label = document.createElement('div');
    label.className = 'ai-translator-source-peek-label';
    label.textContent = ctx.t('sourcePeekLabel');
    const body = document.createElement('div');
    body.className = 'ai-translator-source-peek-text';
    body.setAttribute('dir', 'auto');
    body.textContent = text;
    card.append(label, body);
    return card;
  }

  function showSourcePeek(translation) {
    cancelOpen();
    cancelClose();
    if (!translation.isConnected) return;
    const text = sourceTextOf(translation);
    if (!text) return;
    hideSourcePeek();
    const card = buildCard(text);
    (document.body || document.documentElement).appendChild(card);
    peek = { card, translation };
    placeCard(card, translation, lastPointer);
  }

  // 指针所在的那一行：译文比视口还高时，卡只能贴着这一行放。
  function lineRectAt(translation, pointer) {
    const range = document.createRange();
    range.selectNodeContents(translation);
    for (const rect of range.getClientRects()) {
      if (pointer.y >= rect.top && pointer.y <= rect.bottom) return rect;
    }
    return null;
  }

  /**
   * 放在译文下方 6px；放不下放上方；两边都放不下（译文比视口还高）就贴着指针所在
   * 的行。水平与译文的起始边对齐（RTL 对右边），夹在视口内、两侧各留 8px。算术在
   * ctx.placeBeside（content-utils.js），三个浮层共用一份。
   * 卡绝不能盖住指针：盖住了，指针就「离开」了译文，卡会立刻被收掉。
   */
  function placeCard(card, translation, pointer) {
    const width = card.offsetWidth;
    const height = card.offsetHeight;
    const placed = ctx.placeBeside({ width, height }, translation.getBoundingClientRect(), {
      viewport: { width: document.documentElement.clientWidth || window.innerWidth, height: window.innerHeight },
      gap: PEEK_GAP_PX,
      margin: VIEWPORT_MARGIN_PX,
      prefer: 'below',
      rtl: window.getComputedStyle(translation).direction === 'rtl',
      fallback: lineRectAt(translation, pointer) || { top: pointer.y - 1, bottom: pointer.y + 1 },
    });
    const { left } = placed;
    let { top } = placed;
    // 夹进视口之后仍可能罩住指针（行在视口最底下、卡又高）：翻到指针上方。
    if (pointer.y >= top && pointer.y <= top + height &&
        pointer.x >= left && pointer.x <= left + width) {
      top = Math.max(VIEWPORT_MARGIN_PX, pointer.y - PEEK_GAP_PX - height);
    }
    card.style.left = `${Math.round(left)}px`;
    card.style.top = `${Math.round(top)}px`;
  }

  function scheduleOpen(translation) {
    if (peek && peek.translation === translation) {
      cancelClose();
      return;
    }
    if (pendingTranslation === translation) return;
    cancelOpen();
    pendingTranslation = translation;
    openTimer = setTimeout(() => {
      openTimer = null;
      pendingTranslation = null;
      // 这 350 ms 里原文可能已经放回来了（切回双语、fit guard 撤了译文）。
      if (ctx.hiddenSourceOf && ctx.hiddenSourceOf(translation)) showSourcePeek(translation);
    }, PEEK_OPEN_DELAY_MS);
  }

  function scheduleClose() {
    if (!peek || closeTimer) return;
    closeTimer = setTimeout(() => {
      closeTimer = null;
      hideSourcePeek();
    }, PEEK_CLOSE_DELAY_MS);
  }

  function onPointerOver(event) {
    lastPointer = { x: event.clientX, y: event.clientY };
    const path = pathOf(event);
    if (isPeekPath(path)) {
      cancelClose();
      return;
    }
    if (event.pointerType !== 'mouse') return;
    const translation = pageTranslationIn(path);
    if (translation && ctx.hiddenSourceOf && ctx.hiddenSourceOf(translation)) {
      scheduleOpen(translation);
    }
  }

  // 离开的是译文或卡、而且没有进到它们里面去：开卡的计时作废，开着的卡 200 ms
  // 后收 —— 这段时间足够把指针从译文挪进卡里选字。
  function onPointerOut(event) {
    const path = pathOf(event);
    const translation = pageTranslationIn(path);
    const fromCard = isPeekPath(path);
    if (!translation && !fromCard) return;
    const next = event.relatedTarget;
    const stillInside = (el) => !!el && !!next && el.contains(next);
    if (translation && stillInside(translation)) return;
    if (fromCard && stillInside(peek.card)) return;
    if (translation && pendingTranslation === translation) cancelOpen();
    scheduleClose();
  }

  function onPointerMove(event) {
    lastPointer = { x: event.clientX, y: event.clientY };
  }

  /**
   * 一次点按，三件事：点卡外收卡；blur 样式下揭开 / 重新糊上这条译文；触屏或笔
   * 点按一条原文藏着的译文，开合看原文卡（没有悬停可言）。
   * 冒泡阶段、不 preventDefault：页面自己的点击照常发生。
   */
  function onClick(event) {
    const path = pathOf(event);
    if (isPeekPath(path)) return;
    lastPointer = { x: event.clientX, y: event.clientY };
    const translation = pageTranslationIn(path);
    const actionable = !!translation && !hasInteractiveOnPath(path, translation);

    if (peek && peek.translation !== translation) hideSourcePeek();
    if (!actionable) return;

    if (Display.normalizeStyle(ctx.settings.translationStyle) === 'blur') {
      translation.classList.toggle(REVEALED_CLASS);
    }

    const touchLike = event.pointerType && event.pointerType !== 'mouse';
    if (!touchLike) return;
    if (peek && peek.translation === translation) {
      hideSourcePeek();
    } else if (ctx.hiddenSourceOf && ctx.hiddenSourceOf(translation)) {
      showSourcePeek(translation);
    }
  }

  // 页面一滚卡就过期了（它量的是滚之前的位置）。卡里的长原文要在卡里滚着读，
  // 那一种不收。
  function onScroll(event) {
    if (!peek) return;
    const target = event.target;
    if (target && target.nodeType === Node.ELEMENT_NODE && peek.card.contains(target)) return;
    hideSourcePeek();
  }

  document.addEventListener('pointerover', onPointerOver, true);
  document.addEventListener('pointerout', onPointerOut, true);
  document.addEventListener('pointermove', onPointerMove, { capture: true, passive: true });
  document.addEventListener('click', onClick);
  window.addEventListener('scroll', onScroll, { capture: true, passive: true });

  ctx.applyTranslationDisplay = applyTranslationDisplay;
  ctx.setTranslationDisplay = setTranslationDisplay;
  // content-selection.js 的统一 Esc 收它
  ctx.hideSourcePeek = hideSourcePeek;
})();
