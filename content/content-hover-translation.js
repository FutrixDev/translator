// Blab Translation 悬停/划选翻译 —— 按住键指着一块正文
//
// 按住设定的修饰键，鼠标指到哪一段就译哪一段；右键菜单和划选按钮走的是同一套。这
// 一份是这条路的入口：认热键、认鼠标、把一块正文译出来，以及对外的那几个 ctx.*。
//
// 其余分在 content/hover/ 下：翻哪一块（blocks.js）、行内译文的台账（inline.js）、
// 公式先抠出来（latex.js）、划选那一路（selection.js）、译文长什么样（render.js）。
// 五份各自把要给别人用的名字 Object.assign 到同一张架子 `ctx.hover` 上，取值发生在
// 调用时——所以带 hov. 前缀的名字就是住在别处的，而装载顺序无关紧要。
(function() {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT;
  if (!ctx) return;

  const { settings } = ctx;
  const t = ctx.t;
  // 这一族共用的架子，说明见 content/content-hover-translation.js 顶上。
  const hov = (ctx.hover = ctx.hover || {});

  let hotkeyDown = false;
  let activeHotkey = null;
  // 这一下修饰键被和弦（Alt+A 之类）用掉了，按着的这段时间里不再触发悬停翻译。
  let chordKey = null;



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

    // 快捷键是单独一个修饰键，和 Alt+A 这类命令键位的第一下分不开：等确定用户
    // 只按了它再译（见 content-utils.js 的 armModifierTap）。是和弦的话，连
    // 「按住了」这个状态一起收回，否则接下来划过的段落都会被当成按住悬停。
    ctx.armModifierTap(event.key, runHoverHotkey, {
      // 悬停是按住用的手势，所以按住够久也算数（划词没有这一条）。
      hold: true,
      onChord: () => {
        hotkeyDown = false;
        activeHotkey = null;
        chordKey = event.key;
      }
    });
  }

  function runHoverHotkey() {
    const block = hov.resolveBlockFromInteractionTarget(getHoveredTarget());
    if (!block) return;

    if (hov.hasInlineTranslation(block)) {
      hov.clearInlineTranslationsForBlock(block);
      return;
    }

    translateHoverBlock(block);
  }

  function handleKeyUp(event) {
    if (event.key === chordKey) chordKey = null;
    if (event.key !== activeHotkey) return;
    hotkeyDown = false;
    activeHotkey = null;
  }

  function handleMouseOver(event) {
    const hotkeyActive = hotkeyDown || isHotkeyModifierActive(event);
    if (!hotkeyActive || !settings.enableHoverTranslation) return;
    // 按着键还划了鼠标：这一按是「按住划」，不是「单按一下」。把按下时挂起的
    // 那一下收回 —— 不然松手时它会把刚划出来的译文当成「再按一次」切掉。
    ctx.disarmModifierTap();
    if (!hotkeyDown) {
      // 这一下修饰键已经被 Alt+A 之类的和弦用掉了，松开之前不再当成「按住悬停」。
      if (chordKey) return;
      hotkeyDown = true;
      activeHotkey = getHoverHotkey();
    }

    const block = hov.resolveBlockFromInteractionTarget(event.target);
    if (!block || hov.hasInlineTranslation(block)) return;

    translateHoverBlock(block);
  }

  function handleContextMenu(event) {
    const translationEl = event.target.closest('.ai-translator-inline-block');
    if (translationEl && hov.inlineTranslationSources.has(translationEl)) {
      hov.setInlineTranslationContext(hov.inlineTranslationSources.get(translationEl));
      return;
    }

    const block = hov.resolveBlockFromTarget(event.target);
    if (block && hov.hasInlineTranslation(block)) {
      hov.setInlineTranslationContext(block);
      return;
    }

    hov.setInlineTranslationContext(null);
  }

  function clearHoverTranslation() {
    hov.clearInlineTranslations(hov.hoverTranslations, 'hover');
  }

  function clearSelectionTranslation() {
    hov.clearInlineTranslations(hov.selectionTranslations, 'selection');
  }


  async function translateHoverBlock(block) {
    if (!block || hov.hasInlineTranslation(block)) return;

    const { text, mathElements } = hov.getBlockText(block);
    if (!text || text.length < 2 || text.length > 2000) return;

    // 排除公式占位符后没有正文：整块只是一条公式（如 arXiv 行间公式所在的 <td>，
    // 它本身不在 MATH_CONTAINER_SELECTOR 内，isValidBlock 拦不住），翻译无意义，
    // 且译文还原占位符后会把同一条公式在原文下方再渲染一遍。
    // 注意长度判断挡不住：占位符 "{{1}}" 有 5 个字符。
    if (!text.replace(/\{\{\d+\}\}/g, '').trim()) return;

    const targetLang = ctx.getEffectiveTargetLang ? ctx.getEffectiveTargetLang() : settings.targetLang;
    const cacheKey = hov.buildCacheKey(text, targetLang);
    const cached = hov.getCachedTranslation(block, cacheKey);
    if (cached) {
      const render = () => hov.renderInlineTranslation(block, cached, mathElements, { kind: 'hover' });
      hov.trackInlineTranslation(block, render(), 'hover', render);
      return;
    }

    const requestId = hov.bumpRequestId(hov.hoverRequestIds, block);
    const renderLoading = () => hov.renderInlineLoading(block, { kind: 'hover' });
    hov.trackInlineTranslation(block, renderLoading(), 'hover', renderLoading);
    hov.recordLoadingStart(block, 'hover');
    if (!ctx.isExtensionContextAvailable || !ctx.isExtensionContextAvailable()) {
      hov.scheduleInlineReplacement(
        block,
        'hover',
        requestId,
        () => hov.renderInlineTranslation(block, t('extensionContextInvalidated'), [], { kind: 'hover', isError: true })
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

      if (hov.hoverRequestIds.get(block) !== requestId) return;

      if (response?.error) {
        hov.scheduleInlineReplacement(
          block,
          'hover',
          requestId,
          () => hov.renderInlineTranslation(block, response.error, [], { kind: 'hover', isError: true })
        );
        return;
      }

      const translation = response?.translation || '';
      hov.setCachedTranslation(block, cacheKey, translation);
      hov.scheduleInlineReplacement(
        block,
        'hover',
        requestId,
        () => hov.renderInlineTranslation(block, translation, mathElements, { kind: 'hover' })
      );
    } catch (error) {
      if (hov.hoverRequestIds.get(block) !== requestId) return;
      const message = ctx.isExtensionContextInvalidated && ctx.isExtensionContextInvalidated(error)
        ? t('extensionContextInvalidated')
        : t('translationFailed');
      hov.scheduleInlineReplacement(
        block,
        'hover',
        requestId,
        () => hov.renderInlineTranslation(block, message, [], { kind: 'hover', isError: true })
      );
    }
  }



  ctx.setupHoverTranslation = setupHoverTranslation;
  ctx.clearHoverTranslation = clearHoverTranslation;
  ctx.clearSelectionTranslation = clearSelectionTranslation;
  ctx.hasSelectionTranslation = function() {
    return hov.selectionTranslations.size > 0;
  };
  ctx.clearInlineTranslationContext = hov.clearInlineTranslationContext;
  ctx.translateSelectionInline = hov.translateSelectionInline;
  ctx.showInlineSelectionTranslation = hov.showInlineSelectionTranslation;

  // 别的文件要用的，都从这张架子上取。
  Object.assign(hov, {
    clearSelectionTranslation,
  });
})();
