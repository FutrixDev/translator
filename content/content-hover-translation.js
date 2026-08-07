// AI Translator Content Script Hover Translation
(function() {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT;
  if (!ctx) return;

  const { settings, constants, state } = ctx;
  const { MATH_CONTAINER_SELECTOR } = constants;
  const t = ctx.t;

  const BLOCK_TAGS = new Set([
    'P', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'BLOCKQUOTE', 'FIGCAPTION', 'DT', 'DD'
  ]);
  const SKIP_SELECTOR = '.ai-translator-popup, .ai-translator-inline-block, .ai-translator-hover-translation, .ai-translator-selection-translation, #ai-translator-float-ball, #ai-translator-float-menu, #ai-translator-progress, #ai-translator-selection-btn';
  const SKIP_TAG_SELECTOR = 'script, style, noscript, iframe, textarea, input, select, code, pre, svg, canvas, kbd, samp, var';
  const POSITION_CLASSES = /\b(absolute|fixed|sticky|relative|inset-\S*|top-\S*|bottom-\S*|left-\S*|right-\S*|z-\S*)\b/g;

  let hotkeyDown = false;
  let activeHotkey = null;

  const INLINE_SOURCE_CLASS = 'ai-translator-inline-source';
  const INLINE_LOADING_CLASS = 'ai-translator-inline-loading';
  const hoverTranslations = new Map();
  const selectionTranslations = new Map();
  const inlineTranslationSources = new WeakMap();
  const hoverRequestIds = new Map();
  const selectionRequestIds = new Map();
  const hoverLoadingStarts = new Map();
  const selectionLoadingStarts = new Map();
  const MIN_LOADING_MS = 120;
  let lastContextBlock = null;

  const translationCache = new WeakMap();

  function markInlineSource(block, kind) {
    if (!block) return;
    block.classList.add(INLINE_SOURCE_CLASS);
    if (kind === 'hover') {
      block.dataset.aiTranslatorInlineHover = '1';
    } else if (kind === 'selection') {
      block.dataset.aiTranslatorInlineSelection = '1';
    }
  }

  function unmarkInlineSource(block, kind) {
    if (!block) return;
    if (kind === 'hover') {
      delete block.dataset.aiTranslatorInlineHover;
    } else if (kind === 'selection') {
      delete block.dataset.aiTranslatorInlineSelection;
    }
    if (!block.dataset.aiTranslatorInlineHover && !block.dataset.aiTranslatorInlineSelection) {
      block.classList.remove(INLINE_SOURCE_CLASS);
    }
  }

  // ==================== 受管容器：浮层渲染 ====================
  //
  // Lexical / ProseMirror 这类编辑器会撤销子树里的外来节点（见 content-utils.js
  // 里 MANAGED_DOM_ROOT_SELECTOR 的说明）。往这种块下面 after() 一个译文，下一帧
  // 就没了，用户什么都看不到。
  //
  // 这类块改用文档级浮层：节点挂在 body 上，按原文块的位置贴着它显示。编辑器的
  // MutationObserver 只盯自己的根节点，看不见 body 上的东西，也就不会删。
  //
  // 已实测过的插入位置（Higgsfield 的 div.rde-content，只读 Lexical）：
  //   block.after(el)            -> 1 秒内被删
  //   block.appendChild(el)      -> 被删
  //   块内挂 shadow host         -> 被删
  //   插到编辑器根节点外面        -> 存活
  //   position:absolute 挂 body  -> 存活
  // 子树内没有任何可行位置，所以只能走浮层。
  const ANCHOR_LAYER_ID = 'ai-translator-anchor-layer';
  const anchoredBlocks = new Map();   // 浮层节点 -> 原文块
  const hostileNodes = new WeakSet(); // 运行时发现的“插进去会被删”的位置
  let anchorFrame = 0;
  let anchorListenersBound = false;

  function shouldAnchor(block) {
    if (!block) return false;
    if (ctx.isInsideManagedDomRoot && ctx.isInsideManagedDomRoot(block)) return true;
    // 名单之外的框架靠 verifyInlineSurvival 现场发现，记在 hostileNodes 里。
    // 两个位置都要问：译文可能是 after() 到块的兄弟位（父级是 block.parentElement），
    // 也可能是 appendChild / range.insertNode 到块里面（父级是块或块的后代）。
    return hostileNodes.has(block) || !!(block.parentElement && hostileNodes.has(block.parentElement));
  }

  function getAnchorLayer() {
    let layer = document.getElementById(ANCHOR_LAYER_ID);
    if (!layer) {
      layer = document.createElement('div');
      layer.id = ANCHOR_LAYER_ID;
      // 定位上下文用 fixed 的零尺寸容器：子节点按视口坐标定位，不必去算 body
      // 到底是不是定位元素、有没有 border/margin。
      layer.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;margin:0;padding:0;border:0;z-index:2147483646;';
      (document.body || document.documentElement).appendChild(layer);
    }
    return layer;
  }

  function positionAnchored(el, block) {
    if (!block || !block.isConnected) {
      el.style.visibility = 'hidden';
      return;
    }
    const rect = block.getBoundingClientRect();
    // 原文块滚出视口（或它自己的滚动容器）时把浮层收起来，否则它会飘在别的内容上。
    if ((!rect.width && !rect.height) || rect.bottom < 0 || rect.top > window.innerHeight) {
      el.style.visibility = 'hidden';
      return;
    }
    el.style.visibility = '';
    el.style.left = `${rect.left}px`;
    el.style.top = `${rect.bottom}px`;
    el.style.width = `${rect.width}px`;
  }

  function repositionAnchored() {
    anchorFrame = 0;
    anchoredBlocks.forEach((block, el) => {
      if (!el.isConnected) {
        anchoredBlocks.delete(el);
        return;
      }
      positionAnchored(el, block);
    });
    if (anchoredBlocks.size === 0) unbindAnchorListeners();
  }

  function scheduleReposition() {
    if (anchorFrame) return;
    anchorFrame = requestAnimationFrame(repositionAnchored);
  }

  // scroll 用捕获阶段：浮层要跟着任意祖先滚动容器走，不只是文档滚动。
  function bindAnchorListeners() {
    if (anchorListenersBound) return;
    anchorListenersBound = true;
    window.addEventListener('scroll', scheduleReposition, { capture: true, passive: true });
    window.addEventListener('resize', scheduleReposition, { passive: true });
  }

  function unbindAnchorListeners() {
    if (!anchorListenersBound) return;
    anchorListenersBound = false;
    window.removeEventListener('scroll', scheduleReposition, { capture: true });
    window.removeEventListener('resize', scheduleReposition);
  }

  // 浮层是绝对定位的，顶不动后面的内容，只能盖在上面 —— 没有底色就是两层字叠在
  // 一起，谁也读不了。译文的字色是从原文块抄来的，底色就得抄原文块背后的那层实色，
  // 对比度才对得上：往上找第一个完全不透明的背景色，找不到就交给系统色 Canvas
  // （它跟随明暗主题，比写死白色稳妥）。
  function resolveBackdrop(block) {
    let node = block;
    while (node && node.nodeType === Node.ELEMENT_NODE) {
      const bg = window.getComputedStyle(node).backgroundColor;
      // 半透明的背景挡不住下面的字，得继续往上找。第四个数就是 alpha，rgba(r,g,b,a)
      // 和 rgb(r g b / a) 两种写法都是这样；只有三个数就是不透明的。
      const parts = bg ? bg.match(/[\d.]+/g) : null;
      if (parts && (parts.length < 4 || parseFloat(parts[3]) === 1)) return bg;
      node = node.parentElement;
    }
    return 'Canvas';
  }

  function mountAnchored(el, block, computedStyle) {
    el.classList.add('ai-translator-anchored');
    // 挂到 body 之后继承链就断了。行内渲染时字号/字体/行高有一半是从原文块继承来的
    // （公式那条分支干脆只设了 opacity），这里按原文块的计算值补齐。
    //
    // 字号必须带 important：加载态的样式是 font-size: 1.1em !important，而 em 是相对
    // 父级算的 —— 浮层的父级是 body，不是原文块。正文字号和 body 不一样的站点上，
    // “正在翻译”会莫名比正文大一圈或小一圈。
    if (computedStyle) {
      el.style.setProperty('font-size', computedStyle.fontSize, 'important');
      el.style.setProperty('font-family', computedStyle.fontFamily, 'important');
      el.style.setProperty('line-height', computedStyle.lineHeight, 'important');
      // 颜色不带 important：加载态的紫色和错误态的红色都该压过原文颜色。
      if (!el.style.color && !el.classList.contains('ai-translator-error')) {
        el.style.color = computedStyle.color;
      }
    }
    el.style.setProperty('background', resolveBackdrop(block), 'important');
    el.style.setProperty('position', 'absolute', 'important');
    el.style.setProperty('margin', '0', 'important');
    el.style.setProperty('box-sizing', 'border-box', 'important');
    el.style.setProperty('max-width', '100vw', 'important');
    getAnchorLayer().appendChild(el);
    anchoredBlocks.set(el, block);
    positionAnchored(el, block);
    bindAnchorListeners();
    return el;
  }

  function releaseAnchored(el) {
    if (!el) return;
    anchoredBlocks.delete(el);
    if (anchoredBlocks.size === 0) unbindAnchorListeners();
  }

  // 名单覆盖不到的框架同样会吃节点。插完之后隔两帧回看一眼：节点没了而原文块还在，
  // 就把这个插入父级记为 hostile，并用浮层重画一次。少了这一步，未知框架上的表现
  // 依旧是“第一次悬停什么都没有，之后再悬停也不再重试”。
  function verifyInlineSurvival(block, translationEl, kind, redraw) {
    if (!redraw || !translationEl || anchoredBlocks.has(translationEl)) return;
    const map = kind === 'hover' ? hoverTranslations : selectionTranslations;
    const parent = translationEl.parentElement;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (translationEl.isConnected) return;
      if (!block.isConnected || map.get(block) !== translationEl) return;
      // 记块本身：这一块下次直接走浮层。也记插入父级：同一个容器里的其它块可以
      // 不用再各自撞一次墙。
      hostileNodes.add(block);
      if (parent) hostileNodes.add(parent);
      map.delete(block);
      inlineTranslationSources.delete(translationEl);
      const replacement = redraw();
      if (replacement) trackInlineTranslation(block, replacement, kind);
    }));
  }

  function trackInlineTranslation(block, translationEl, kind, redraw) {
    if (!block || !translationEl) return;
    const map = kind === 'hover' ? hoverTranslations : selectionTranslations;
    const existing = map.get(block);
    if (existing && existing !== translationEl) {
      inlineTranslationSources.delete(existing);
      releaseAnchored(existing);
      existing.remove();
    }
    map.set(block, translationEl);
    inlineTranslationSources.set(translationEl, block);
    markInlineSource(block, kind);
    verifyInlineSurvival(block, translationEl, kind, redraw);
  }

  function bumpRequestId(map, block) {
    const next = (map.get(block) || 0) + 1;
    map.set(block, next);
    return next;
  }

  function getLoadingMap(kind) {
    return kind === 'hover' ? hoverLoadingStarts : selectionLoadingStarts;
  }

  function recordLoadingStart(block, kind) {
    if (!block) return;
    const map = getLoadingMap(kind);
    map.set(block, Date.now());
  }

  function clearLoadingStart(block, kind) {
    if (!block) return;
    const map = getLoadingMap(kind);
    map.delete(block);
  }

  function scheduleInlineReplacement(block, kind, requestId, renderFn, onComplete) {
    const requestMap = kind === 'hover' ? hoverRequestIds : selectionRequestIds;
    const loadingMap = getLoadingMap(kind);
    const startedAt = loadingMap.get(block);
    const elapsed = startedAt ? Date.now() - startedAt : 0;
    const delay = startedAt ? Math.max(0, MIN_LOADING_MS - elapsed) : 0;

    const applyReplacement = () => {
      if (requestMap.get(block) !== requestId) return;
      loadingMap.delete(block);
      const translationEl = renderFn();
      // renderFn 本身就是这条译文的重画函数：被受管容器删掉时用它原样再画一次，
      // 那时 shouldAnchor 已经认得这个父级，会自动走浮层。
      trackInlineTranslation(block, translationEl, kind, renderFn);
      if (onComplete) onComplete();
    };

    if (delay > 0) {
      setTimeout(applyReplacement, delay);
    } else {
      applyReplacement();
    }
  }

  function removeInlineTranslation(block, kind) {
    const map = kind === 'hover' ? hoverTranslations : selectionTranslations;
    if (!block || !map.has(block)) return;
    bumpRequestId(kind === 'hover' ? hoverRequestIds : selectionRequestIds, block);
    clearLoadingStart(block, kind);
    const translationEl = map.get(block);
    if (translationEl) {
      inlineTranslationSources.delete(translationEl);
      releaseAnchored(translationEl);
      translationEl.remove();
    }
    map.delete(block);
    unmarkInlineSource(block, kind);
  }

  function clearInlineTranslations(map, kind) {
    const blocks = Array.from(map.keys());
    blocks.forEach((block) => removeInlineTranslation(block, kind));
  }

  function clearInlineTranslationsForBlock(block) {
    removeInlineTranslation(block, 'hover');
    removeInlineTranslation(block, 'selection');
  }

  function hasInlineTranslation(block) {
    return hoverTranslations.has(block) || selectionTranslations.has(block);
  }

  function updateInlineContextMenu(visible) {
    if (!ctx.isExtensionContextAvailable || !ctx.isExtensionContextAvailable()) return;
    try {
      chrome.runtime.sendMessage({
        type: 'INLINE_CONTEXT_MENU_STATE',
        visible: !!visible
      });
    } catch (error) {
      // Ignore context menu sync errors
    }
  }

  function setInlineTranslationContext(block) {
    lastContextBlock = block || null;
    updateInlineContextMenu(!!lastContextBlock);
  }

  function clearInlineTranslationContext() {
    if (!lastContextBlock) return;
    clearInlineTranslationsForBlock(lastContextBlock);
    lastContextBlock = null;
    updateInlineContextMenu(false);
  }

  function setupHoverTranslation() {
    document.addEventListener('keydown', handleKeyDown, true);
    document.addEventListener('keyup', handleKeyUp, true);
    document.addEventListener('mouseover', handleMouseOver, true);
    document.addEventListener('contextmenu', handleContextMenu, true);
  }

  function getHoverHotkey() {
    const hotkey = settings.hoverTranslationHotkey || 'Shift';
    if (hotkey === 'Shift' || hotkey === 'Alt' || hotkey === 'Control' || hotkey === 'Meta') {
      return hotkey;
    }
    return 'Shift';
  }

  function isHotkeyEvent(event) {
    return event.key === getHoverHotkey();
  }

  function isHotkeyModifierActive(event) {
    const hotkey = getHoverHotkey();
    if (hotkey === 'Shift') return event.shiftKey;
    if (hotkey === 'Alt') return event.altKey;
    if (hotkey === 'Control') return event.ctrlKey;
    if (hotkey === 'Meta') return event.metaKey;
    return false;
  }

  function getHoveredTarget() {
    const hovered = document.querySelectorAll(':hover');
    return hovered.length ? hovered[hovered.length - 1] : null;
  }

  function handleKeyDown(event) {
    if (!settings.enableHoverTranslation) return;
    if (!isHotkeyEvent(event)) return;
    if (event.repeat) return;

    hotkeyDown = true;
    activeHotkey = event.key;

    const block = resolveBlockFromInteractionTarget(getHoveredTarget());
    if (!block) return;

    if (hasInlineTranslation(block)) {
      clearInlineTranslationsForBlock(block);
      return;
    }

    translateHoverBlock(block);
  }

  function handleKeyUp(event) {
    if (event.key !== activeHotkey) return;
    hotkeyDown = false;
    activeHotkey = null;
  }

  function handleMouseOver(event) {
    const hotkeyActive = hotkeyDown || isHotkeyModifierActive(event);
    if (!hotkeyActive || !settings.enableHoverTranslation) return;
    if (!hotkeyDown) {
      hotkeyDown = true;
      activeHotkey = getHoverHotkey();
    }

    const block = resolveBlockFromInteractionTarget(event.target);
    if (!block || hasInlineTranslation(block)) return;

    translateHoverBlock(block);
  }

  function handleContextMenu(event) {
    const translationEl = event.target.closest('.ai-translator-inline-block');
    if (translationEl && inlineTranslationSources.has(translationEl)) {
      setInlineTranslationContext(inlineTranslationSources.get(translationEl));
      return;
    }

    const block = resolveBlockFromTarget(event.target);
    if (block && hasInlineTranslation(block)) {
      setInlineTranslationContext(block);
      return;
    }

    setInlineTranslationContext(null);
  }

  function clearHoverTranslation() {
    clearInlineTranslations(hoverTranslations, 'hover');
  }

  function clearSelectionTranslation() {
    clearInlineTranslations(selectionTranslations, 'selection');
  }

  function resolveBlockFromTarget(target) {
    if (!target) return null;
    let el = target.nodeType === Node.ELEMENT_NODE ? target : target.parentElement;
    if (!el) return null;

    if (el.closest(SKIP_SELECTOR)) return null;
    if (el.closest(SKIP_TAG_SELECTOR)) return null;
    if (MATH_CONTAINER_SELECTOR && el.closest(MATH_CONTAINER_SELECTOR)) return null;

    while (el && el !== document.body && el !== document.documentElement) {
      if (BLOCK_TAGS.has(el.tagName)) {
        if (!isValidBlock(el)) return null;
        return el;
      }
      el = el.parentElement;
    }

    return null;
  }

  function resolveBlockFromInteractionTarget(target) {
    if (!target) return null;
    const translationEl = target.closest?.('.ai-translator-inline-block');
    if (translationEl && inlineTranslationSources.has(translationEl)) {
      return inlineTranslationSources.get(translationEl) || null;
    }
    return resolveBlockFromTarget(target);
  }

  function isValidBlock(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return false;
    if (element.isContentEditable) return false;
    if (element.closest(SKIP_SELECTOR)) return false;
    if (element.closest(SKIP_TAG_SELECTOR)) return false;
    if (MATH_CONTAINER_SELECTOR && element.closest(MATH_CONTAINER_SELECTOR)) return false;
    if (element.classList.contains('ai-translator-translated')) return false;
    if (ctx.isMathElement && ctx.isMathElement(element)) return false;
    return true;
  }

  function getBlockText(element) {
    if (ctx.getTextWithMathPlaceholders) {
      return ctx.getTextWithMathPlaceholders(element);
    }
    return { text: element.textContent?.trim() || '', mathElements: [] };
  }

  function buildCacheKey(text, targetLang) {
    return `${targetLang || ''}::${text}`;
  }

  function getCachedTranslation(block, cacheKey) {
    const entry = translationCache.get(block);
    if (!entry) return '';
    return entry.get(cacheKey) || '';
  }

  function setCachedTranslation(block, cacheKey, translation) {
    let entry = translationCache.get(block);
    if (!entry) {
      entry = new Map();
      translationCache.set(block, entry);
    }
    entry.set(cacheKey, translation);
  }

  async function translateHoverBlock(block) {
    if (!block || hasInlineTranslation(block)) return;

    const { text, mathElements } = getBlockText(block);
    if (!text || text.length < 2 || text.length > 2000) return;

    // 排除公式占位符后没有正文：整块只是一条公式（如 arXiv 行间公式所在的 <td>，
    // 它本身不在 MATH_CONTAINER_SELECTOR 内，isValidBlock 拦不住），翻译无意义，
    // 且译文还原占位符后会把同一条公式在原文下方再渲染一遍。
    // 注意长度判断挡不住：占位符 "{{1}}" 有 5 个字符。
    if (!text.replace(/\{\{\d+\}\}/g, '').trim()) return;

    const targetLang = ctx.getEffectiveTargetLang ? ctx.getEffectiveTargetLang() : settings.targetLang;
    const cacheKey = buildCacheKey(text, targetLang);
    const cached = getCachedTranslation(block, cacheKey);
    if (cached) {
      const render = () => renderInlineTranslation(block, cached, mathElements, { kind: 'hover' });
      trackInlineTranslation(block, render(), 'hover', render);
      return;
    }

    const requestId = bumpRequestId(hoverRequestIds, block);
    const renderLoading = () => renderInlineLoading(block, { kind: 'hover' });
    trackInlineTranslation(block, renderLoading(), 'hover', renderLoading);
    recordLoadingStart(block, 'hover');
    if (!ctx.isExtensionContextAvailable || !ctx.isExtensionContextAvailable()) {
      scheduleInlineReplacement(
        block,
        'hover',
        requestId,
        () => renderInlineTranslation(block, t('extensionContextInvalidated'), [], { kind: 'hover', isError: true })
      );
      return;
    }

    try {
      const response = await ctx.requestTranslation({
        type: 'TRANSLATE',
        text,
        targetLang,
        mode: 'text',
        // 悬停是“鼠标扫过就翻”，不能卡在几十 MB 的语言包下载上。
        // 首次下载交给设置页那个带进度条的按钮。
        allowDownload: false
      });

      if (hoverRequestIds.get(block) !== requestId) return;

      if (response?.error) {
        scheduleInlineReplacement(
          block,
          'hover',
          requestId,
          () => renderInlineTranslation(block, response.error, [], { kind: 'hover', isError: true })
        );
        return;
      }

      const translation = response?.translation || '';
      setCachedTranslation(block, cacheKey, translation);
      scheduleInlineReplacement(
        block,
        'hover',
        requestId,
        () => renderInlineTranslation(block, translation, mathElements, { kind: 'hover' })
      );
    } catch (error) {
      if (hoverRequestIds.get(block) !== requestId) return;
      const message = ctx.isExtensionContextInvalidated && ctx.isExtensionContextInvalidated(error)
        ? t('extensionContextInvalidated')
        : t('translationFailed');
      scheduleInlineReplacement(
        block,
        'hover',
        requestId,
        () => renderInlineTranslation(block, message, [], { kind: 'hover', isError: true })
      );
    }
  }

  function shouldTreatAsInlineLatex(content) {
    const trimmed = content.trim();
    if (!trimmed) return false;
    if (/^\d[\d,.\s]*$/.test(trimmed)) return false;
    if (/\\/.test(trimmed)) return true;
    if (/[\^_={}|<>]/.test(trimmed)) return true;
    if (/[\p{Sm}]/u.test(trimmed)) return true;
    if (/[\p{L}]/u.test(trimmed)) return true;
    return false;
  }

  function findInlineLatexRanges(text) {
    if (!text) return [];
    const ranges = [];

    const addRange = (start, end) => {
      if (start >= 0 && end > start) {
        ranges.push({ start, end });
      }
    };

    const addMatches = (regex) => {
      regex.lastIndex = 0;
      let match;
      while ((match = regex.exec(text)) !== null) {
        addRange(match.index, match.index + match[0].length);
        if (match[0].length === 0) {
          regex.lastIndex += 1;
        }
      }
    };

    addMatches(/\\\(([\s\S]+?)\\\)/g);
    addMatches(/\\\[([\s\S]+?)\\\]/g);
    addMatches(/\$\$([\s\S]+?)\$\$/g);

    const inlineRegex = /(^|[^\\])\$([^\n$]+?)\$/g;
    inlineRegex.lastIndex = 0;
    let match;
    while ((match = inlineRegex.exec(text)) !== null) {
      const prefix = match[1] || '';
      const inner = match[2] || '';
      if (!shouldTreatAsInlineLatex(inner)) {
        if (match[0].length === 0) {
          inlineRegex.lastIndex += 1;
        }
        continue;
      }
      const start = match.index + prefix.length;
      const end = start + inner.length + 2;
      addRange(start, end);
      if (match[0].length === 0) {
        inlineRegex.lastIndex += 1;
      }
    }

    return ranges;
  }

  function resolveLatexSafeOffset(text, offset) {
    const ranges = findInlineLatexRanges(text);
    for (const range of ranges) {
      if (offset > range.start && offset < range.end) {
        return Math.min(range.end, text.length);
      }
    }
    return offset;
  }

  function extractLatexPlaceholders(text, startIndex = 0) {
    if (!text) return { text: '', mathElements: [] };

    const mathElements = [];
    let mathIndex = startIndex;

    function addPlaceholder(raw) {
      mathIndex += 1;
      const placeholder = `{{${mathIndex}}}`;
      mathElements.push({ placeholder, type: 'text', text: raw });
      return placeholder;
    }

    let result = text;
    result = result.replace(/\\\(([\s\S]+?)\\\)/g, (match) => addPlaceholder(match));
    result = result.replace(/\\\[([\s\S]+?)\\\]/g, (match) => addPlaceholder(match));
    result = result.replace(/\$\$([\s\S]+?)\$\$/g, (match) => addPlaceholder(match));
    result = result.replace(/(^|[^\\])\$([^\n$]+?)\$/g, (match, prefix, inner) => {
      if (!shouldTreatAsInlineLatex(inner)) {
        return match;
      }
      const placeholder = addPlaceholder(`$${inner}$`);
      return prefix + placeholder;
    });

    return { text: result, mathElements };
  }

  function extractSelectionPlaceholders(selectionText, selectionRange) {
    const range = resolveSelectionRange(selectionRange);
    let baseText = selectionText || '';
    let mathElements = [];

    if (range && ctx.getTextWithMathPlaceholders) {
      const fragment = range.cloneContents();
      const container = document.createElement('span');
      container.appendChild(fragment);

      if (MATH_CONTAINER_SELECTOR) {
        container.querySelectorAll(MATH_CONTAINER_SELECTOR).forEach((node) => {
          const id = node.getAttribute?.('id');
          if (!id) return;
          const original = document.getElementById(id);
          if (original && original !== node && original.matches?.(MATH_CONTAINER_SELECTOR)) {
            node.replaceWith(original.cloneNode(true));
          }
        });
      }

      const extracted = ctx.getTextWithMathPlaceholders(container);
      if (extracted?.text) {
        baseText = extracted.text;
        mathElements = Array.isArray(extracted.mathElements) ? extracted.mathElements : [];
      }
    }

    const extractedLatex = extractLatexPlaceholders(baseText, mathElements.length);
    return {
      text: extractedLatex.text,
      mathElements: mathElements.concat(extractedLatex.mathElements)
    };
  }

  function resolveSelectionAnchor(anchorEl) {
    if (anchorEl && anchorEl.nodeType === Node.ELEMENT_NODE) return anchorEl;

    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return null;

    const anchorNode = selection.anchorNode || selection.focusNode || selection.getRangeAt(0).commonAncestorContainer;
    if (!anchorNode) return null;

    return anchorNode.nodeType === Node.ELEMENT_NODE ? anchorNode : anchorNode.parentElement;
  }

  function resolveSelectionRange(selectionRange) {
    if (selectionRange && selectionRange.startContainer) return selectionRange;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return null;
    return selection.getRangeAt(0);
  }

  function normalizeComparableText(text) {
    if (!text) return '';
    return text
      .replace(/\{\{\d+\}\}/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function isSelectionRangeInsideBlock(range, block) {
    if (!range || range.collapsed || !block) return false;
    return block.contains(range.startContainer) && block.contains(range.endContainer);
  }

  function isFullBlockSelection(selectionText, blockText) {
    const normalizedSelection = normalizeComparableText(selectionText);
    const normalizedBlock = normalizeComparableText(blockText);
    return normalizedSelection && normalizedSelection === normalizedBlock;
  }

  function resolveMathContainer(element) {
    if (!element) return null;
    const el = element.nodeType === Node.ELEMENT_NODE ? element : element.parentElement;
    if (!el) return null;

    let mathContainer = null;
    if (MATH_CONTAINER_SELECTOR) {
      mathContainer = el.closest(MATH_CONTAINER_SELECTOR);
      if (mathContainer) {
        let parent = mathContainer.parentElement;
        while (parent && parent.matches?.(MATH_CONTAINER_SELECTOR)) {
          mathContainer = parent;
          parent = parent.parentElement;
        }
      }
    }

    if (!mathContainer && ctx.isMathElement) {
      let current = el;
      while (current && current !== document.body && current !== document.documentElement) {
        if (ctx.isMathElement(current)) {
          mathContainer = current;
          break;
        }
        current = current.parentElement;
      }
    }

    return mathContainer;
  }

  function resolveSafeInsertionRange(range, block) {
    if (!range) return null;
    const insertionRange = range.cloneRange();
    insertionRange.collapse(false);

    const endContainer = insertionRange.endContainer;
    const endElement = endContainer.nodeType === Node.ELEMENT_NODE ? endContainer : endContainer.parentElement;
    if (!endElement) return insertionRange;

    const mathContainer = resolveMathContainer(endElement);
    if (mathContainer) {
      if (block && !block.contains(mathContainer)) return insertionRange;
      const safeRange = document.createRange();
      safeRange.setStartAfter(mathContainer);
      safeRange.collapse(true);
      return safeRange;
    }

    if (endContainer.nodeType === Node.TEXT_NODE) {
      const safeOffset = resolveLatexSafeOffset(endContainer.textContent || '', insertionRange.endOffset);
      if (safeOffset !== insertionRange.endOffset) {
        insertionRange.setStart(endContainer, safeOffset);
        insertionRange.collapse(true);
      }
    }

    return insertionRange;
  }

  function renderSelectionTranslation(block, translation, mathElements, selectionRange, options = {}) {
    const { isError, selectionText } = options;
    const blockText = getBlockText(block).text;
    const range = resolveSelectionRange(selectionRange);
    const shouldInline = selectionText && !isFullBlockSelection(selectionText, blockText);

    // 受管容器里 insertNode 插进去的节点同样会被撤销，回到 renderInlineLoading /
    // renderInlineTranslation 那条路，由它们挂浮层。
    if (shouldAnchor(block) || !shouldInline || !isSelectionRangeInsideBlock(range, block)) {
      return renderInlineTranslation(block, translation, mathElements, { kind: 'selection', isError });
    }

    const translationEl = document.createElement('span');
    translationEl.className = 'ai-translator-inline-block ai-translator-selection-translation';

    const computedStyle = window.getComputedStyle(block);
    translationEl.style.cssText = buildBaseStyle(computedStyle, isError) + `
      display: inline;
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    `;
    translationEl.style.setProperty('display', 'inline', 'important');
    translationEl.style.setProperty('margin-top', '0', 'important');
    translationEl.style.setProperty('margin-bottom', '0', 'important');
    translationEl.style.setProperty('padding', '0', 'important');

    if (isError) {
      translationEl.classList.add('ai-translator-error');
    }

    translationEl.appendChild(document.createTextNode(' ('));
    if (mathElements.length && ctx.buildTranslationContentWithMath) {
      ctx.buildTranslationContentWithMath(translationEl, translation, mathElements);
    } else {
      translationEl.appendChild(document.createTextNode(translation));
    }
    translationEl.appendChild(document.createTextNode(')'));

    try {
      const insertionRange = resolveSafeInsertionRange(range, block);
      if (!insertionRange || !block.contains(insertionRange.startContainer)) {
        return renderInlineTranslation(block, translation, mathElements, { kind: 'selection', isError });
      }
      insertionRange.insertNode(translationEl);
      return translationEl;
    } catch (error) {
      return renderInlineTranslation(block, translation, mathElements, { kind: 'selection', isError });
    }
  }

  function renderSelectionLoading(block, selectionRange, options = {}) {
    const { selectionText } = options;
    const blockText = getBlockText(block).text;
    const range = resolveSelectionRange(selectionRange);
    const shouldInline = selectionText && !isFullBlockSelection(selectionText, blockText);

    // 受管容器里 insertNode 插进去的节点同样会被撤销，回到 renderInlineLoading /
    // renderInlineTranslation 那条路，由它们挂浮层。
    if (shouldAnchor(block) || !shouldInline || !isSelectionRangeInsideBlock(range, block)) {
      return renderInlineLoading(block, { kind: 'selection' });
    }

    const loadingEl = document.createElement('span');
    loadingEl.className = 'ai-translator-inline-block ai-translator-selection-translation';

    const computedStyle = window.getComputedStyle(block);
    loadingEl.style.cssText = buildBaseStyle(computedStyle) + `
      display: inline;
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    `;
    loadingEl.style.setProperty('display', 'inline', 'important');
    loadingEl.style.setProperty('margin-top', '0', 'important');
    loadingEl.style.setProperty('margin-bottom', '0', 'important');
    loadingEl.style.setProperty('padding', '0', 'important');

    loadingEl.appendChild(document.createTextNode(' ('));
    const dots = createLoadingDots();
    loadingEl.appendChild(dots);
    loadingEl.appendChild(document.createTextNode(')'));

    try {
      const insertionRange = resolveSafeInsertionRange(range, block);
      if (!insertionRange || !block.contains(insertionRange.startContainer)) {
        return renderInlineLoading(block, { kind: 'selection' });
      }
      insertionRange.insertNode(loadingEl);
      return loadingEl;
    } catch (error) {
      return renderInlineLoading(block, { kind: 'selection' });
    }
  }

  async function translateSelectionInline(text, anchorEl, selectionRange) {
    if (!text || !ctx.isSelectionInlineEnabled || !ctx.isSelectionInlineEnabled()) return;

    const anchor = resolveSelectionAnchor(anchorEl);
    const block = resolveBlockFromTarget(anchor);
    if (!block) return;

    state.selectionTranslationPending = true;
    clearSelectionTranslation();

    const extracted = extractSelectionPlaceholders(text, selectionRange);
    const safeText = extracted.text;
    const mathElements = extracted.mathElements;

    const targetLang = ctx.getEffectiveTargetLang ? ctx.getEffectiveTargetLang() : settings.targetLang;
    const cacheKey = buildCacheKey(safeText, targetLang);
    const cached = getCachedTranslation(block, cacheKey);
    if (cached) {
      const render = () => renderSelectionTranslation(block, cached, mathElements, selectionRange, {
        selectionText: safeText
      });
      trackInlineTranslation(block, render(), 'selection', render);
      state.selectionTranslationPending = false;
      return;
    }

    const requestId = bumpRequestId(selectionRequestIds, block);
    const renderLoading = () => renderSelectionLoading(block, selectionRange, { selectionText: safeText });
    trackInlineTranslation(block, renderLoading(), 'selection', renderLoading);
    recordLoadingStart(block, 'selection');
    if (!ctx.isExtensionContextAvailable || !ctx.isExtensionContextAvailable()) {
      scheduleInlineReplacement(
        block,
        'selection',
        requestId,
        () => renderSelectionTranslation(block, t('extensionContextInvalidated'), [], selectionRange, {
          isError: true,
          selectionText: safeText
        }),
        () => {
          state.selectionTranslationPending = false;
        }
      );
      return;
    }

    try {
      const response = await ctx.requestTranslation({
        type: 'TRANSLATE',
        text: safeText,
        targetLang,
        mode: 'text'
      });

      if (selectionRequestIds.get(block) !== requestId) {
        state.selectionTranslationPending = false;
        return;
      }

      if (response?.error) {
        scheduleInlineReplacement(
          block,
          'selection',
          requestId,
          () => renderSelectionTranslation(block, response.error, [], selectionRange, {
            isError: true,
            selectionText: safeText
          }),
          () => {
            state.selectionTranslationPending = false;
          }
        );
        return;
      }

      const translation = response?.translation || '';
      setCachedTranslation(block, cacheKey, translation);
      scheduleInlineReplacement(
        block,
        'selection',
        requestId,
        () => renderSelectionTranslation(block, translation, mathElements, selectionRange, {
          selectionText: safeText
        }),
        () => {
          state.selectionTranslationPending = false;
        }
      );
    } catch (error) {
      if (selectionRequestIds.get(block) !== requestId) {
        state.selectionTranslationPending = false;
        return;
      }
      const message = ctx.isExtensionContextInvalidated && ctx.isExtensionContextInvalidated(error)
        ? t('extensionContextInvalidated')
        : t('translationFailed');
      scheduleInlineReplacement(
        block,
        'selection',
        requestId,
        () => renderSelectionTranslation(block, message, [], selectionRange, {
          isError: true,
          selectionText: safeText
        }),
        () => {
          state.selectionTranslationPending = false;
        }
      );
    }
  }

  function showInlineSelectionTranslation(text, translation, anchorEl, selectionRange) {
    if (!text || !ctx.isSelectionInlineEnabled || !ctx.isSelectionInlineEnabled()) return;

    const anchor = resolveSelectionAnchor(anchorEl);
    const block = resolveBlockFromTarget(anchor);
    if (!block) return;

    const extracted = extractSelectionPlaceholders(text, selectionRange);
    clearSelectionTranslation();
    const render = () => renderSelectionTranslation(block, translation || '', extracted.mathElements, selectionRange, {
      selectionText: extracted.text || text
    });
    trackInlineTranslation(block, render(), 'selection', render);
  }

  function buildBaseStyle(computedStyle, omitColor = false) {
    return `
      font-size: ${computedStyle.fontSize};
      font-family: ${computedStyle.fontFamily};
      font-weight: ${computedStyle.fontWeight};
      line-height: ${computedStyle.lineHeight};
      text-align: ${computedStyle.textAlign};
      ${omitColor ? '' : `color: ${computedStyle.color};`}
      letter-spacing: ${computedStyle.letterSpacing};
      opacity: 0.85;
    `;
  }

  function createLoadingDots() {
    const dots = document.createElement('span');
    dots.className = INLINE_LOADING_CLASS;
    return dots;
  }

  function renderInlineLoading(block, options = {}) {
    const { kind } = options;
    const isHorizontalFlex = ctx.isHorizontalFlexParent ? ctx.isHorizontalFlexParent(block) : false;
    const inlineTarget = isHorizontalFlex && ctx.getInlineTranslationTarget
      ? ctx.getInlineTranslationTarget(block)
      : block;
    const computedStyle = window.getComputedStyle(inlineTarget);
    const className = kind === 'hover' ? 'ai-translator-hover-translation' : 'ai-translator-selection-translation';

    // 浮层是块级的，贴在原文块下方，用不上“同一行右侧”那套内联变体。
    if (isHorizontalFlex && !shouldAnchor(block)) {
      const loadingEl = document.createElement('span');
      loadingEl.className = `ai-translator-inline-block ai-translator-inline-right ${className} ${INLINE_LOADING_CLASS}`;
      loadingEl.style.cssText = `
        font-size: 0.85em;
        font-family: ${computedStyle.fontFamily};
        font-weight: ${computedStyle.fontWeight};
        line-height: ${computedStyle.lineHeight};
        color: ${computedStyle.color};
        letter-spacing: ${computedStyle.letterSpacing};
        opacity: 0.7;
        display: inline;
        margin: 0;
        padding: 0;
      `;
      inlineTarget.appendChild(loadingEl);
      return loadingEl;
    }

    const loadingEl = document.createElement(block.tagName);
    if (block.className) {
      loadingEl.className = block.className
        .replace('ai-translator-translated', '')
        .replace(POSITION_CLASSES, '')
        .trim();
    }
    loadingEl.classList.add('ai-translator-inline-block', className, INLINE_LOADING_CLASS);
    loadingEl.style.cssText = buildBaseStyle(computedStyle) + `
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    `;

    if (ctx.getTextOffsetLeft) {
      const textOffset = ctx.getTextOffsetLeft(block);
      if (textOffset > 0) {
        loadingEl.style.setProperty('padding-left', `${textOffset}px`, 'important');
      }
    }

    if (shouldAnchor(block)) {
      return mountAnchored(loadingEl, block, computedStyle);
    }

    if (block.hasAttribute('slot')) {
      const internalLoading = document.createElement('span');
      internalLoading.className = `ai-translator-inline-block ${className} ${INLINE_LOADING_CLASS}`;
      internalLoading.style.cssText = buildBaseStyle(computedStyle) + `
        display: block;
        margin: 0;
        padding: 0;
        box-sizing: border-box;
      `;
      block.appendChild(internalLoading);
      return internalLoading;
    }

    block.after(loadingEl);
    return loadingEl;
  }

  function renderInlineTranslation(block, translation, mathElements = [], options = {}) {
    const { kind, isError } = options;
    const isHorizontalFlex = ctx.isHorizontalFlexParent ? ctx.isHorizontalFlexParent(block) : false;
    const inlineTarget = isHorizontalFlex && ctx.getInlineTranslationTarget
      ? ctx.getInlineTranslationTarget(block)
      : block;
    const computedStyle = window.getComputedStyle(inlineTarget);
    const className = kind === 'hover' ? 'ai-translator-hover-translation' : 'ai-translator-selection-translation';

    if (isHorizontalFlex && !shouldAnchor(block)) {
      const translationEl = document.createElement('span');
      translationEl.className = `ai-translator-inline-block ai-translator-inline-right ${className}`;

      if (mathElements.length && ctx.buildTranslationContentWithMath) {
        ctx.buildTranslationContentWithMath(translationEl, translation, mathElements, ' ');
      } else {
        translationEl.textContent = ` ${translation}`;
      }

      translationEl.style.cssText = `
        font-size: 0.85em;
        font-family: ${computedStyle.fontFamily};
        font-weight: ${computedStyle.fontWeight};
        line-height: ${computedStyle.lineHeight};
        ${isError ? '' : `color: ${computedStyle.color};`}
        letter-spacing: ${computedStyle.letterSpacing};
        opacity: 0.7;
        display: inline;
        margin: 0;
        padding: 0;
      `;

      if (isError) {
        translationEl.classList.add('ai-translator-error');
      }

      inlineTarget.appendChild(translationEl);
      return translationEl;
    }

    const translationEl = document.createElement(block.tagName);
    if (block.className) {
      translationEl.className = block.className
        .replace('ai-translator-translated', '')
        .replace(POSITION_CLASSES, '')
        .trim();
    }
    translationEl.classList.add('ai-translator-inline-block', className);

    if (mathElements.length && ctx.buildTranslationContentWithMath) {
      ctx.buildTranslationContentWithMath(translationEl, translation, mathElements);
      translationEl.style.opacity = '0.85';
    } else {
      translationEl.textContent = translation;
      translationEl.style.cssText = buildBaseStyle(computedStyle, isError) + `
        margin: 0;
        padding: 0;
        box-sizing: border-box;
      `;
    }

    if (isError) {
      translationEl.classList.add('ai-translator-error');
    }

    if (ctx.getTextOffsetLeft) {
      const textOffset = ctx.getTextOffsetLeft(block);
      if (textOffset > 0) {
        translationEl.style.setProperty('padding-left', `${textOffset}px`, 'important');
      }
    }

    if (shouldAnchor(block)) {
      return mountAnchored(translationEl, block, computedStyle);
    }

    if (block.hasAttribute('slot')) {
      const internalTranslation = document.createElement('span');
      internalTranslation.className = `ai-translator-inline-block ${className}`;

      if (mathElements.length && ctx.buildTranslationContentWithMath) {
        ctx.buildTranslationContentWithMath(internalTranslation, translation, mathElements);
        internalTranslation.style.opacity = '0.85';
      } else {
        internalTranslation.textContent = translation;
        internalTranslation.style.cssText = buildBaseStyle(computedStyle, isError) + `
          display: block;
          margin: 0;
          padding: 0;
          box-sizing: border-box;
        `;
      }

      if (isError) {
        internalTranslation.classList.add('ai-translator-error');
      }
      block.appendChild(internalTranslation);
      return internalTranslation;
    }

    block.after(translationEl);
    return translationEl;
  }

  ctx.setupHoverTranslation = setupHoverTranslation;
  ctx.clearHoverTranslation = clearHoverTranslation;
  ctx.clearSelectionTranslation = clearSelectionTranslation;
  ctx.hasSelectionTranslation = function() {
    return selectionTranslations.size > 0;
  };
  ctx.clearInlineTranslationContext = clearInlineTranslationContext;
  ctx.translateSelectionInline = translateSelectionInline;
  ctx.showInlineSelectionTranslation = showInlineSelectionTranslation;
})();
